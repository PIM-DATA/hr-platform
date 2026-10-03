import {
  AUDIT_ACTIONS, MIN_AGGREGATE_GROUP_SIZE, PAYROLL_PERIOD_FROZEN, PAYROLL_WORKFLOW, SYSTEM_PAY_COMPONENTS, payrollPeriodLabel, type PayrollAggregateDto,
  type AddPayrollAdjustmentInput, type CreatePayrollPeriodInput, type PayrollPeriodDto, type PayrollPeriodListQuery,
  type PayrollPeriodStatus, type PayrollReconciliationDto, type PayrollResultDto, type PayrollResultItemDto,
  type PayrollResultListQuery, type PayrollRunSummaryDto, type PayrollSummaryDto, type UpdatePayrollPeriodInput,
} from '@hr/shared';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { AppError } from '../../lib/errors';
import { auditService } from '../../services/audit/audit.service';
import { workflowEngine } from '../../services/workflow';
import type { AuthContext } from '../auth/auth.types';
import { dec, equals, money, sumMoney, toMoneyString, toQuantityString, toRateString, ZERO } from './money';
import { assertNotSelfFinancial } from '../../services/authorization/self-dealing';
import { isSourceLinkedLine, payrollAudit, type Actor, type Db, type SourceLinkedReference, type Tx } from './payroll.types';
import { payrollPolicyService } from './payroll-master.service';
import { payrollCalculationService, systemComponent, type CalculationInputs, type EmployeeForPayroll } from './payroll-calculation.service';

/**
 * Payroll periods and runs: the state machine that turns configuration and attendance into money somebody can be paid.
 *
 *   OPEN → (calculate) → REVIEW → (approve) → APPROVED → (close) → CLOSED
 *
 * Every transition takes the **period row lock** first. Payroll is the one place where two administrators pressing
 * buttons at the same time must not produce two answers, and a lock on the row they are both arguing about is the
 * only thing that actually prevents it. Different organizations and different months never contend: the lock is per
 * period, not global.
 *
 * A run is rebuilt in place while it is in review — that is not a violation of append-only history, because nothing
 * has been decided yet. After approval nothing is rebuilt, and after closing nothing changes at all.
 */
const periodInclude = {
  organization: { select: { id: true, code: true, name: true } },
  runs: { orderBy: { version: 'desc' as const }, take: 1 },
} satisfies Prisma.PayrollPeriodInclude;
type PeriodRow = Prisma.PayrollPeriodGetPayload<{ include: typeof periodInclude }>;

const resultInclude = {
  employee: { select: { id: true, employeeCode: true, firstName: true, lastName: true, department: { select: { id: true, name: true } } } },
  items: { orderBy: [{ type: 'asc' as const }, { source: 'asc' as const }, { createdAt: 'asc' as const }] },
} satisfies Prisma.PayrollResultInclude;
type ResultRow = Prisma.PayrollResultGetPayload<{ include: typeof resultInclude }>;

const toItemDto = (row: Prisma.PayrollResultItemGetPayload<object>): PayrollResultItemDto => ({
  id: row.id,
  componentCode: row.componentCodeSnapshot,
  componentName: row.componentNameSnapshot,
  type: row.type as PayrollResultItemDto['type'],
  source: row.source as PayrollResultItemDto['source'],
  quantity: row.quantity === null ? null : toQuantityString(row.quantity),
  rate: row.rate === null ? null : toRateString(row.rate),
  multiplier: row.multiplier === null ? null : row.multiplier.toString(),
  amount: toMoneyString(row.amount),
  description: row.description,
  referenceType: row.referenceType,
  referenceId: row.referenceId,
  isManual: row.isManual,
  sourceLinked: isSourceLinkedLine(row),
});

const toResultDto = (row: ResultRow): PayrollResultDto => ({
  id: row.id,
  employee: row.employee,
  baseSalary: toMoneyString(row.baseSalary),
  grossPay: toMoneyString(row.grossPay),
  totalDeductions: toMoneyString(row.totalDeductions),
  netPay: toMoneyString(row.netPay),
  currencyCode: row.currencyCode,
  inputs: {
    absentDays: toQuantityString(row.absentDays),
    lateMinutes: row.lateMinutes,
    unpaidLeaveUnits: toQuantityString(row.unpaidLeaveUnits),
    approvedOtMinutes: row.approvedOtMinutes,
    proratedDays: row.proratedDays === null ? null : toQuantityString(row.proratedDays),
  },
  items: row.items.map(toItemDto),
});

const toRunSummary = (run: Prisma.PayrollRunGetPayload<object>, inputsCurrent: boolean): PayrollRunSummaryDto => ({
  id: run.id,
  periodId: run.periodId,
  version: run.version,
  status: run.status as PayrollRunSummaryDto['status'],
  employeeCount: run.employeeCount,
  grossTotal: toMoneyString(run.grossTotal),
  deductionTotal: toMoneyString(run.deductionTotal),
  netTotal: toMoneyString(run.netTotal),
  currencyCode: run.currencyCode,
  calculatedAt: run.calculatedAt?.toISOString() ?? null,
  approvedAt: run.approvedAt?.toISOString() ?? null,
  closedAt: run.closedAt?.toISOString() ?? null,
  workflowInstanceId: run.workflowInstanceId,
  inputsCurrent,
});

const toPeriodDto = (row: PeriodRow, inputsCurrent = true): PayrollPeriodDto => ({
  id: row.id,
  organization: row.organization,
  year: row.year,
  month: row.month,
  label: payrollPeriodLabel(row.year, row.month),
  periodStart: row.periodStart,
  periodEnd: row.periodEnd,
  attendanceFrom: row.attendanceFrom,
  attendanceTo: row.attendanceTo,
  paymentDate: row.paymentDate,
  status: row.status as PayrollPeriodStatus,
  currencyCode: row.currencyCode,
  run: row.runs[0] ? toRunSummary(row.runs[0], inputsCurrent) : null,
});

/** Locks the period row: every state decision about a period happens behind it. */
async function lockPeriod(tx: Tx, periodId: string) {
  await tx.$executeRaw`SELECT "id" FROM "payroll_periods" WHERE "id" = ${periodId} FOR UPDATE`;
}

/**
 * A run may only be changed while it is genuinely under review.
 *
 * "In review" is not enough on its own: once it has been sent for approval it keeps that status but belongs to the
 * approver, and the amounts they are looking at must be the amounts they approve. Changing your mind means cancelling
 * the approval first, which hands the run back.
 */
function assertRunMutable(run: { status: string; workflowInstanceId: string | null }) {
  if (run.status !== 'REVIEW') throw new AppError(409, 'PAYROLL_RUN_NOT_IN_REVIEW', `This run is ${run.status.toLowerCase()}: it can only be changed during review`);
  if (run.workflowInstanceId) throw new AppError(409, 'PAYROLL_RUN_PENDING_APPROVAL', 'This run is waiting for approval; cancel the approval before changing it');
}

async function loadPeriod(db: Db, id: string) {
  const row = await db.payrollPeriod.findUnique({ where: { id }, include: periodInclude });
  if (!row) throw new AppError(404, 'PAYROLL_PERIOD_NOT_FOUND', 'Payroll period not found');
  return row;
}

/** The employees a period pays: everyone in the organization who was employed for part of it. */
async function populationFor(db: Db, organizationId: string, periodStart: string, periodEnd: string): Promise<EmployeeForPayroll[]> {
  const rows = await db.employee.findMany({
    where: {
      organizationId,
      // Somebody hired after the period ended is not paid for it; somebody who left before it started is not either.
      hireDate: { lte: new Date(`${periodEnd}T23:59:59.999Z`) },
      OR: [{ terminationDate: null }, { terminationDate: { gte: new Date(`${periodStart}T00:00:00.000Z`) } }],
      employmentStatus: { in: ['ACTIVE', 'TERMINATED'] },
    },
    select: {
      id: true, employeeCode: true, firstName: true, lastName: true, organizationId: true, departmentId: true, positionId: true,
      hireDate: true, terminationDate: true, department: { select: { name: true } }, position: { select: { title: true } },
    },
    orderBy: { employeeCode: 'asc' },
  });
  return rows;
}

const inputsFor = (period: PeriodRow, policy: Awaited<ReturnType<typeof payrollPolicyService.resolve>>): CalculationInputs => ({
  periodStart: period.periodStart,
  periodEnd: period.periodEnd,
  attendanceFrom: period.attendanceFrom,
  attendanceTo: period.attendanceTo,
  currencyCode: period.currencyCode,
  policy: {
    id: policy.id,
    monthlyDivisorDays: policy.monthlyDivisorDays,
    dailyWorkHours: policy.dailyWorkHours,
    newHireProration: policy.newHireProration,
    terminationProration: policy.terminationProration,
    absenceDeductionEnabled: policy.absenceDeductionEnabled,
    lateDeductionEnabled: policy.lateDeductionEnabled,
  },
});

export const payrollRunService = {
  // ---------- periods ----------
  async listPeriods(q: PayrollPeriodListQuery): Promise<{ data: PayrollPeriodDto[]; meta: { page: number; pageSize: number; total: number } }> {
    const where: Prisma.PayrollPeriodWhereInput = { organizationId: q.organizationId, year: q.year, status: q.status };
    const [total, rows] = await prisma.$transaction([
      prisma.payrollPeriod.count({ where }),
      prisma.payrollPeriod.findMany({ where, include: periodInclude, orderBy: [{ year: 'desc' }, { month: 'desc' }], skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
    ]);
    return { data: rows.map((r) => toPeriodDto(r)), meta: { page: q.page, pageSize: q.pageSize, total } };
  },

  async getPeriod(id: string): Promise<PayrollPeriodDto> {
    const row = await loadPeriod(prisma, id);
    const run = row.runs[0];
    const inputsCurrent = run ? await payrollRunService.inputsAreCurrent(prisma, row, run) : true;
    return toPeriodDto(row, inputsCurrent);
  },

  async createPeriod(input: CreatePayrollPeriodInput, actor: Actor): Promise<PayrollPeriodDto> {
    const organization = await prisma.organization.findUnique({ where: { id: input.organizationId }, select: { id: true } });
    if (!organization) throw new AppError(404, 'ORGANIZATION_NOT_FOUND', 'Organization not found');
    const existing = await prisma.payrollPeriod.findUnique({ where: { organizationId_year_month: { organizationId: input.organizationId, year: input.year, month: input.month } }, select: { id: true } });
    if (existing) throw new AppError(409, 'PAYROLL_PERIOD_EXISTS', `A payroll period already exists for ${payrollPeriodLabel(input.year, input.month)}`);
    // The policy must exist now, so a period is never created that cannot be calculated.
    const policy = await payrollPolicyService.resolve(prisma, input.organizationId, input.periodEnd);

    const row = await prisma.$transaction(async (tx) => {
      const created = await tx.payrollPeriod.create({
        data: { ...input, paymentDate: input.paymentDate ?? null, policyId: policy.id, currencyCode: policy.currencyCode, status: 'OPEN' },
        include: periodInclude,
      });
      await auditService.log(payrollAudit(actor, AUDIT_ACTIONS.CREATE_PAYROLL_PERIOD, 'PayrollPeriod', created.id, {
        label: payrollPeriodLabel(created.year, created.month), periodStart: created.periodStart, periodEnd: created.periodEnd,
        attendanceFrom: created.attendanceFrom, attendanceTo: created.attendanceTo, policyId: policy.id,
      }), tx);
      return created;
    });
    return toPeriodDto(row);
  },

  /** Dates can only be corrected while the period is still open; from review onwards they are frozen. */
  async updatePeriod(id: string, input: UpdatePayrollPeriodInput, actor: Actor): Promise<PayrollPeriodDto> {
    const row = await prisma.$transaction(async (tx) => {
      await lockPeriod(tx, id);
      const before = await loadPeriod(tx, id);
      if (PAYROLL_PERIOD_FROZEN.includes(before.status as PayrollPeriodStatus)) {
        throw new AppError(409, 'PAYROLL_PERIOD_FROZEN', `This period is ${before.status.toLowerCase()}: its dates are frozen. Recalculate from an open period instead.`);
      }
      const after = await tx.payrollPeriod.update({ where: { id }, data: input, include: periodInclude });
      if (after.periodStart > after.periodEnd || after.attendanceFrom > after.attendanceTo) {
        throw new AppError(400, 'VALIDATION_ERROR', 'A period cannot end before it starts');
      }
      await auditService.log(payrollAudit(actor, AUDIT_ACTIONS.UPDATE_PAYROLL_PERIOD, 'PayrollPeriod', id,
        { periodStart: after.periodStart, periodEnd: after.periodEnd, attendanceFrom: after.attendanceFrom, attendanceTo: after.attendanceTo, paymentDate: after.paymentDate },
        { periodStart: before.periodStart, periodEnd: before.periodEnd, attendanceFrom: before.attendanceFrom, attendanceTo: before.attendanceTo, paymentDate: before.paymentDate }), tx);
      return after;
    });
    return toPeriodDto(row);
  },

  // ---------- calculation ----------
  /**
   * Calculates (or recalculates) the period. Everything happens in one transaction behind the period lock: the old
   * generated lines are removed, the new ones written, and the totals recomputed. **Manual adjustments survive** —
   * they were a human decision about this run, not an input that can be re-derived.
   */
  async calculate(periodId: string, actor: Actor): Promise<PayrollRunSummaryDto> {
    return prisma.$transaction(async (tx) => {
      await lockPeriod(tx, periodId);
      const period = await loadPeriod(tx, periodId);
      if (['APPROVED', 'CLOSED'].includes(period.status)) {
        throw new AppError(409, 'PAYROLL_PERIOD_NOT_OPEN', `This period is ${period.status.toLowerCase()} and can no longer be calculated`);
      }

      // A run sitting with an approver is not recalculated behind their back.
      const pending = period.runs[0];
      if (pending && pending.status === 'REVIEW' && pending.workflowInstanceId) {
        throw new AppError(409, 'PAYROLL_RUN_PENDING_APPROVAL', 'This run is waiting for approval; cancel the approval before recalculating it');
      }

      const policy = await payrollPolicyService.resolve(tx, period.organizationId, period.periodEnd);
      const inputs = inputsFor(period, policy);
      const employees = await populationFor(tx, period.organizationId, period.periodStart, period.periodEnd);
      if (employees.length === 0) throw new AppError(409, 'PAYROLL_NO_EMPLOYEES', 'No employees belong to this organization for that period');

      const calculations = await payrollCalculationService.calculate(tx, employees, inputs);
      const fingerprint = await payrollCalculationService.fingerprint(tx, employees.map((e) => e.id), inputs);

      const existingRun = period.runs[0] ?? null;
      const run = existingRun
        ? await tx.payrollRun.update({ where: { id: existingRun.id }, data: { version: existingRun.version + 1, status: 'REVIEW', calculatedAt: new Date(), inputFingerprint: fingerprint, currencyCode: period.currencyCode } })
        : await tx.payrollRun.create({ data: { periodId, status: 'REVIEW', startedByUserId: actor.auth.userId, calculatedAt: new Date(), inputFingerprint: fingerprint, currencyCode: period.currencyCode } });

      // Rebuilt in place (Task 48, T44-P1-15): a result row and its manual lines keep their ids across recalculations —
      // a benefit claim or expense report points at its payroll line by id, and that link must never dangle. Only the
      // engine-generated lines are replaced. Before, every result was deleted and re-created with new ids.
      const prior = await tx.payrollResult.findMany({
        where: { runId: run.id },
        select: { id: true, employeeId: true, employeeCode: true, items: { where: { isManual: true }, select: { type: true, amount: true, referenceType: true } } },
      });
      const calculated = new Set(calculations.map((c) => c.employeeId));
      const dropped = prior.filter((r) => !calculated.has(r.employeeId));
      // Somebody who left the population cannot silently take an approved reimbursement with them.
      const orphaned = dropped.find((r) => r.items.some((i) => isSourceLinkedLine(i)));
      if (orphaned) {
        throw new AppError(409, 'PAYROLL_HANDOFF_LINE_ORPHANED', `${orphaned.employeeCode} is no longer paid by this period but carries a reimbursement handed over from benefits or expense; resolve that employee's population change first`);
      }
      if (dropped.length) await tx.payrollResult.deleteMany({ where: { id: { in: dropped.map((r) => r.id) } } }); // ordinary manual lines go with them, as before
      await tx.payrollResultItem.deleteMany({ where: { isManual: false, payrollResult: { runId: run.id } } });
      const priorByEmployee = new Map(prior.map((r) => [r.employeeId, r]));

      let grossTotal = ZERO;
      let deductionTotal = ZERO;
      let netTotal = ZERO;
      for (const calculation of calculations) {
        const existing = priorByEmployee.get(calculation.employeeId);
        const keptManual = existing?.items ?? [];
        const manualEarnings = sumMoney(keptManual.filter((i) => i.type === 'EARNING').map((i) => i.amount));
        const manualDeductions = sumMoney(keptManual.filter((i) => i.type === 'DEDUCTION').map((i) => i.amount));
        const gross = money(calculation.grossPay.plus(manualEarnings));
        const deductions = money(calculation.totalDeductions.plus(manualDeductions));
        const net = money(gross.minus(deductions));

        const data = {
          employeeCode: calculation.employeeCode,
          employeeName: calculation.employeeName,
          organizationId: calculation.organizationId,
          departmentId: calculation.departmentId,
          departmentName: calculation.departmentName,
          positionId: calculation.positionId,
          positionTitle: calculation.positionTitle,
          compensationId: calculation.compensationId,
          baseSalary: calculation.baseSalary,
          dailyRate: calculation.dailyRate,
          minuteRate: calculation.minuteRate,
          grossPay: gross,
          totalDeductions: deductions,
          netPay: net,
          currencyCode: period.currencyCode,
          absentDays: calculation.absentDays,
          lateMinutes: calculation.lateMinutes,
          unpaidLeaveUnits: calculation.unpaidLeaveUnits,
          approvedOtMinutes: calculation.approvedOtMinutes,
          proratedDays: calculation.proratedDays,
        };
        const result = existing
          ? await tx.payrollResult.update({ where: { id: existing.id }, data })
          : await tx.payrollResult.create({ data: { ...data, runId: run.id, employeeId: calculation.employeeId } });
        await tx.payrollResultItem.createMany({
          data: calculation.lines.map((line) => ({
            payrollResultId: result.id,
            componentId: line.componentId,
            componentCodeSnapshot: line.componentCode,
            componentNameSnapshot: line.componentName,
            type: line.type,
            source: line.source,
            quantity: line.quantity ?? null,
            rate: line.rate ?? null,
            multiplier: line.multiplier ?? null,
            amount: line.amount,
            description: line.description ?? null,
            referenceType: line.referenceType ?? null,
            referenceId: line.referenceId ?? null,
            isManual: false,
          })),
        });

        grossTotal = grossTotal.plus(gross);
        deductionTotal = deductionTotal.plus(deductions);
        netTotal = netTotal.plus(net);
      }

      const updated = await tx.payrollRun.update({
        where: { id: run.id },
        data: { employeeCount: calculations.length, grossTotal: money(grossTotal), deductionTotal: money(deductionTotal), netTotal: money(netTotal) },
      });
      await tx.payrollPeriod.update({ where: { id: periodId }, data: { status: 'REVIEW' } });
      await auditService.log(payrollAudit(actor, AUDIT_ACTIONS.CALCULATE_PAYROLL, 'PayrollRun', run.id, {
        period: payrollPeriodLabel(period.year, period.month), version: updated.version, employees: updated.employeeCount,
        grossTotal: toMoneyString(updated.grossTotal), deductionTotal: toMoneyString(updated.deductionTotal), netTotal: toMoneyString(updated.netTotal),
      }), tx);
      return toRunSummary(updated, true);
    }, { timeout: 120_000 });
  },

  /** Have any of the sources moved since the run was calculated? */
  async inputsAreCurrent(db: Db, period: PeriodRow, run: Prisma.PayrollRunGetPayload<object>): Promise<boolean> {
    if (!run.inputFingerprint) return false;
    const policy = await payrollPolicyService.resolve(db, period.organizationId, period.periodEnd).catch(() => null);
    if (!policy) return false;
    const employees = await populationFor(db, period.organizationId, period.periodStart, period.periodEnd);
    return payrollCalculationService.fingerprintMatches(db, run.inputFingerprint, employees.map((e) => e.id), inputsFor(period, policy));
  },

  // ---------- results and adjustments ----------
  async listResults(runId: string, q: PayrollResultListQuery): Promise<{ data: PayrollResultDto[]; meta: { page: number; pageSize: number; total: number } }> {
    const where: Prisma.PayrollResultWhereInput = {
      runId,
      departmentId: q.departmentId,
      ...(q.search ? { OR: [{ employeeCode: { contains: q.search, mode: 'insensitive' } }, { employeeName: { contains: q.search, mode: 'insensitive' } }] } : {}),
    };
    const [total, rows] = await prisma.$transaction([
      prisma.payrollResult.count({ where }),
      prisma.payrollResult.findMany({ where, include: resultInclude, orderBy: { employeeCode: 'asc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
    ]);
    return { data: rows.map(toResultDto), meta: { page: q.page, pageSize: q.pageSize, total } };
  },

  async getResult(id: string): Promise<PayrollResultDto> {
    const row = await prisma.payrollResult.findUnique({ where: { id }, include: resultInclude });
    if (!row) throw new AppError(404, 'PAYROLL_RESULT_NOT_FOUND', 'Payroll result not found');
    return toResultDto(row);
  },

  /** A manual earning or deduction, added during review. Generated lines are read-only; these are not. */
  async addAdjustment(resultId: string, input: AddPayrollAdjustmentInput, actor: Actor): Promise<PayrollResultDto> {
    const row = await prisma.$transaction(async (tx) => {
      // Task 51 (T44-P1-19): an ordinary manual adjustment is never entered on one's own payslip. (A benefit / expense
      // handoff is not ordinary: it carries an amount approved by someone else in its source domain.)
      const target = await tx.payrollResult.findUnique({ where: { id: resultId }, select: { employeeId: true } });
      assertNotSelfFinancial(actor.auth, target?.employeeId, 'add a payroll adjustment');
      await addManualAdjustmentWithTx(tx, resultId, { componentId: input.componentId, amount: input.amount, note: input.note }, actor);
      return tx.payrollResult.findUniqueOrThrow({ where: { id: resultId }, include: resultInclude });
    });
    return toResultDto(row);
  },

  async removeAdjustment(itemId: string, actor: Actor): Promise<PayrollResultDto> {
    const row = await prisma.$transaction(async (tx) => {
      const item = await tx.payrollResultItem.findUnique({
        where: { id: itemId },
        include: { payrollResult: { select: { id: true, run: { select: { id: true, status: true, periodId: true, workflowInstanceId: true } } } } },
      });
      if (!item) throw new AppError(404, 'PAYROLL_ITEM_NOT_FOUND', 'Payroll line not found');
      await lockPeriod(tx, item.payrollResult.run.periodId);
      if (!item.isManual) throw new AppError(409, 'PAYROLL_ITEM_GENERATED', 'Generated lines cannot be removed; recalculate the run instead');
      // Task 51: removing a deduction from one's own payslip is a benefit too
      assertNotSelfFinancial(actor.auth, (await tx.payrollResult.findUnique({ where: { id: item.payrollResult.id }, select: { employeeId: true } }))?.employeeId, 'remove a payroll adjustment');
      // Task 48 (T44-P1-15): a line handed over by benefits or expense is an approved reimbursement; deleting it here
      // would leave the claim "sent to payroll" and never paid. It is not removable from payroll.
      if (isSourceLinkedLine(item)) {
        throw new AppError(409, 'PAYROLL_ITEM_SOURCE_LINKED', `This line is ${item.referenceType === 'BENEFIT_CLAIM' ? 'a benefit claim' : 'an expense report'} reimbursement handed over to payroll; it cannot be removed here`);
      }
      assertRunMutable(item.payrollResult.run);

      await tx.payrollResultItem.delete({ where: { id: itemId } });
      await recomputeResultTotals(tx, item.payrollResult.id);
      await recomputeRunTotals(tx, item.payrollResult.run.id);
      await auditService.log(payrollAudit(actor, AUDIT_ACTIONS.REMOVE_PAYROLL_ADJUSTMENT, 'PayrollResult', item.payrollResult.id, {
        component: item.componentCodeSnapshot, amount: toMoneyString(item.amount),
      }), tx);
      return tx.payrollResult.findUniqueOrThrow({ where: { id: item.payrollResult.id }, include: resultInclude });
    });
    return toResultDto(row);
  },

  // ---------- reconciliation ----------
  /**
   * The arithmetic must close before anybody approves anything: every line adds up to its result, every result adds up
   * to the run, and nobody is being paid a negative amount.
   */
  async reconcile(db: Db, runId: string): Promise<PayrollReconciliationDto> {
    const run = await db.payrollRun.findUnique({ where: { id: runId }, include: { period: { include: periodInclude } } });
    if (!run) throw new AppError(404, 'PAYROLL_RUN_NOT_FOUND', 'Payroll run not found');
    const results = await db.payrollResult.findMany({ where: { runId }, include: { items: true } });

    const problems: string[] = [];
    const negativeNetEmployees: { employeeCode: string; netPay: string }[] = [];
    let gross = ZERO;
    let deductions = ZERO;
    let net = ZERO;

    for (const result of results) {
      const lineEarnings = sumMoney(result.items.filter((i) => i.type === 'EARNING').map((i) => i.amount));
      const lineDeductions = sumMoney(result.items.filter((i) => i.type === 'DEDUCTION').map((i) => i.amount));
      if (!equals(lineEarnings, result.grossPay)) problems.push(`${result.employeeCode}: earnings lines total ${toMoneyString(lineEarnings)} but gross pay is ${toMoneyString(result.grossPay)}`);
      if (!equals(lineDeductions, result.totalDeductions)) problems.push(`${result.employeeCode}: deduction lines total ${toMoneyString(lineDeductions)} but total deductions are ${toMoneyString(result.totalDeductions)}`);
      if (!equals(money(dec(result.grossPay).minus(result.totalDeductions)), result.netPay)) problems.push(`${result.employeeCode}: gross minus deductions does not equal net pay`);
      if (dec(result.netPay).isNegative()) negativeNetEmployees.push({ employeeCode: result.employeeCode, netPay: toMoneyString(result.netPay) });
      gross = gross.plus(result.grossPay);
      deductions = deductions.plus(result.totalDeductions);
      net = net.plus(result.netPay);
    }

    if (!equals(money(gross), run.grossTotal)) problems.push(`Run gross total is ${toMoneyString(run.grossTotal)} but the results add up to ${toMoneyString(gross)}`);
    if (!equals(money(deductions), run.deductionTotal)) problems.push(`Run deduction total is ${toMoneyString(run.deductionTotal)} but the results add up to ${toMoneyString(deductions)}`);
    if (!equals(money(net), run.netTotal)) problems.push(`Run net total is ${toMoneyString(run.netTotal)} but the results add up to ${toMoneyString(net)}`);
    if (results.length !== run.employeeCount) problems.push(`The run says ${run.employeeCount} employees but has ${results.length} results`);

    const inputsCurrent = await payrollRunService.inputsAreCurrent(db, run.period, run);
    return {
      ok: problems.length === 0 && negativeNetEmployees.length === 0,
      runId,
      employeeCount: results.length,
      grossTotal: toMoneyString(gross),
      deductionTotal: toMoneyString(deductions),
      netTotal: toMoneyString(net),
      problems,
      negativeNetEmployees,
      inputsCurrent,
    };
  },

  // ---------- approval and close ----------
  /** Sends the run for approval through the shared workflow engine. */
  async submitForApproval(runId: string, actor: Actor): Promise<PayrollRunSummaryDto> {
    return prisma.$transaction(async (tx) => {
      const run = await tx.payrollRun.findUnique({ where: { id: runId }, include: { period: { include: periodInclude } } });
      if (!run) throw new AppError(404, 'PAYROLL_RUN_NOT_FOUND', 'Payroll run not found');
      await lockPeriod(tx, run.periodId);
      if (run.status !== 'REVIEW') throw new AppError(409, 'PAYROLL_RUN_NOT_IN_REVIEW', `This run is ${run.status.toLowerCase()}`);
      if (run.workflowInstanceId) throw new AppError(409, 'PAYROLL_RUN_ALREADY_SUBMITTED', 'This run is already waiting for approval');

      await assertApprovable(tx, runId, run.period);

      const policy = await payrollPolicyService.resolve(tx, run.period.organizationId, run.period.periodEnd);
      const requester = await tx.employee.findFirst({ where: { user: { id: actor.auth.userId } }, select: { id: true } });
      if (!requester) throw new AppError(409, 'EMPLOYEE_PROFILE_REQUIRED', 'Submitting payroll for approval needs an account linked to an employee record');

      const instance = await workflowEngine.submit(
        { definitionCode: policy.workflowDefinitionCode, module: PAYROLL_WORKFLOW.module, entityType: PAYROLL_WORKFLOW.entityType, entityId: runId, requesterEmployeeId: requester.id },
        actor,
        tx,
      );
      const updated = await tx.payrollRun.update({ where: { id: runId }, data: { workflowInstanceId: instance.id } });
      await auditService.log(payrollAudit(actor, AUDIT_ACTIONS.SUBMIT_PAYROLL_RUN, 'PayrollRun', runId, {
        period: payrollPeriodLabel(run.period.year, run.period.month), workflowInstanceId: instance.id, netTotal: toMoneyString(run.netTotal),
      }), tx);
      const fresh = await tx.payrollRun.findUniqueOrThrow({ where: { id: runId } });
      return toRunSummary(fresh, true);
    });
  },

  /**
   * Close the run. Only an approved run can be closed, and a closed run is final: no recalculation, no adjustment, no
   * reopening. This release has no reopen procedure, deliberately — a correction would be a new period's problem.
   */
  async close(runId: string, actor: Actor): Promise<PayrollRunSummaryDto> {
    return prisma.$transaction(async (tx) => {
      const run = await tx.payrollRun.findUnique({ where: { id: runId }, include: { period: true } });
      if (!run) throw new AppError(404, 'PAYROLL_RUN_NOT_FOUND', 'Payroll run not found');
      await lockPeriod(tx, run.periodId);
      const current = await tx.payrollRun.findUniqueOrThrow({ where: { id: runId } });
      if (current.status === 'CLOSED') throw new AppError(409, 'PAYROLL_RUN_CLOSED', 'This run is already closed');
      if (current.status !== 'APPROVED') throw new AppError(409, 'PAYROLL_RUN_NOT_APPROVED', 'Only an approved run can be closed');
      // Task 48 (T44-P1-16): the sources are compared once more. Source changes inside an approved period are refused
      // where they happen (payroll-freeze.ts); anything that got past that is caught here instead of being closed.
      const period = await loadPeriod(tx, run.periodId);
      if (!(await payrollRunService.inputsAreCurrent(tx, period, current))) {
        throw new AppError(409, 'PAYROLL_INPUT_CHANGED', 'A salary, attendance, leave, overtime or calendar source has changed since this run was approved. Restore the source (approved payroll is not recalculated) before closing.');
      }

      const updated = await tx.payrollRun.update({ where: { id: runId }, data: { status: 'CLOSED', closedAt: new Date(), closedByUserId: actor.auth.userId } });
      await tx.payrollPeriod.update({ where: { id: run.periodId }, data: { status: 'CLOSED' } });
      await auditService.log(payrollAudit(actor, AUDIT_ACTIONS.CLOSE_PAYROLL_RUN, 'PayrollRun', runId, {
        period: payrollPeriodLabel(run.period.year, run.period.month), employees: updated.employeeCount,
        grossTotal: toMoneyString(updated.grossTotal), netTotal: toMoneyString(updated.netTotal),
      }), tx);
      return toRunSummary(updated, true);
    });
  },

  /** Run-level summary for the reports screen: totals, a component breakdown and a department breakdown. */
  async summary(runId: string): Promise<PayrollSummaryDto> {
    const run = await prisma.payrollRun.findUnique({ where: { id: runId }, include: { period: true } });
    if (!run) throw new AppError(404, 'PAYROLL_RUN_NOT_FOUND', 'Payroll run not found');
    const [byComponent, results] = await Promise.all([
      prisma.payrollResultItem.groupBy({
        by: ['componentCodeSnapshot', 'componentNameSnapshot', 'type'],
        where: { payrollResult: { runId } },
        _sum: { amount: true },
        _count: { _all: true },
      }),
      prisma.payrollResult.findMany({ where: { runId }, select: { departmentId: true, departmentName: true, grossPay: true, netPay: true } }),
    ]);

    const departments = new Map<string, { departmentId: string | null; departmentName: string; employees: number; gross: Prisma.Decimal; net: Prisma.Decimal }>();
    for (const result of results) {
      const key = result.departmentId ?? 'none';
      const current = departments.get(key) ?? { departmentId: result.departmentId, departmentName: result.departmentName ?? 'Unassigned', employees: 0, gross: ZERO, net: ZERO };
      departments.set(key, { ...current, employees: current.employees + 1, gross: current.gross.plus(result.grossPay), net: current.net.plus(result.netPay) });
    }

    return {
      runId,
      periodLabel: payrollPeriodLabel(run.period.year, run.period.month),
      currencyCode: run.currencyCode,
      employeeCount: run.employeeCount,
      grossTotal: toMoneyString(run.grossTotal),
      deductionTotal: toMoneyString(run.deductionTotal),
      netTotal: toMoneyString(run.netTotal),
      byComponent: byComponent
        .map((c) => ({
          componentCode: c.componentCodeSnapshot,
          componentName: c.componentNameSnapshot,
          type: c.type as 'EARNING' | 'DEDUCTION',
          amount: toMoneyString(c._sum.amount ?? 0),
          employees: c._count._all,
        }))
        .sort((a, b) => a.type.localeCompare(b.type) || a.componentCode.localeCompare(b.componentCode)),
      byDepartment: [...departments.values()]
        .map((d) => ({ departmentId: d.departmentId, departmentName: d.departmentName, employees: d.employees, grossTotal: toMoneyString(d.gross), netTotal: toMoneyString(d.net) }))
        .sort((a, b) => a.departmentName.localeCompare(b.departmentName)),
    };
  },

  /**
   * Closed-run totals for a month range — the one source of organization-level payroll money for other modules
   * (executive overview, its CSV, the copilot). Task 48 (T44-P2-15): one entry per currency, summed as Decimal in SQL,
   * never across currencies. Runs below the minimum group size are withheld and counted.
   */
  async closedTotals(f: { organizationId?: string; from: { year: number; month: number }; to: { year: number; month: number } }): Promise<PayrollAggregateDto> {
    const min = MIN_AGGREGATE_GROUP_SIZE;
    const where: Prisma.PayrollRunWhereInput = {
      status: 'CLOSED',
      period: {
        organizationId: f.organizationId,
        OR: [{ year: { gt: f.from.year } }, { year: f.from.year, month: { gte: f.from.month } }],
        AND: [{ OR: [{ year: { lt: f.to.year } }, { year: f.to.year, month: { lte: f.to.month } }] }],
      },
    };
    const released: Prisma.PayrollRunWhereInput = { ...where, employeeCount: { gte: min } };
    const [byCurrency, runs, withheldRuns] = await Promise.all([
      prisma.payrollRun.groupBy({ by: ['currencyCode'], where: released, _count: { _all: true }, _sum: { employeeCount: true, grossTotal: true, deductionTotal: true, netTotal: true }, orderBy: { currencyCode: 'asc' } }),
      prisma.payrollRun.findMany({ where: released, select: { currencyCode: true, employeeCount: true, grossTotal: true, netTotal: true, period: { select: { year: true, month: true, organization: { select: { name: true } } } } }, orderBy: [{ period: { year: 'asc' } }, { period: { month: 'asc' } }, { currencyCode: 'asc' }] }),
      prisma.payrollRun.count({ where: { ...where, employeeCount: { lt: min } } }),
    ]);
    return {
      runs: runs.length,
      employeesPaid: runs.reduce((n, r) => n + r.employeeCount, 0),
      byCurrency: byCurrency.map((c) => ({
        currencyCode: c.currencyCode, runs: c._count._all, employeesPaid: c._sum.employeeCount ?? 0,
        grossTotal: toMoneyString(c._sum.grossTotal ?? 0), deductionTotal: toMoneyString(c._sum.deductionTotal ?? 0), netTotal: toMoneyString(c._sum.netTotal ?? 0),
      })),
      byPeriod: runs.map((r) => ({ periodLabel: payrollPeriodLabel(r.period.year, r.period.month), organizationName: r.period.organization.name, currencyCode: r.currencyCode, employees: r.employeeCount, grossTotal: toMoneyString(r.grossTotal), netTotal: toMoneyString(r.netTotal) })),
      withheldRuns,
      minimumGroupSize: min,
      note: 'Organization-level totals of closed runs, one line per currency — amounts in different currencies are never added. Runs of fewer than ' + min + ' employees are withheld. No department split: in a small department a total would reveal an individual salary.',
    };
  },

  loadPeriod,
  lockPeriod,
  populationFor,
  assertApprovable,
  assertApproverIndependent,
  toRunSummary,
  toResultDto,
};

/**
 * A manual line on a payroll result, composable inside another module's transaction (benefits reimbursement handoff).
 * Rules are payroll's own: the period is locked, the run must be in review and not awaiting approval, the component
 * active. `reference` identifies the source record and makes the call idempotent: a second call with the same
 * reference returns the existing line and writes nothing.
 */
export async function addManualAdjustmentWithTx(tx: Tx, resultId: string, input: { componentId: string; amount: string; note: string; reference?: { type: SourceLinkedReference; id: string; currency: string } }, actor: Actor): Promise<{ itemId: string; created: boolean }> {
  const result = await tx.payrollResult.findUnique({ where: { id: resultId }, include: { run: { select: { id: true, status: true, periodId: true, workflowInstanceId: true, currencyCode: true } } } });
  if (!result) throw new AppError(404, 'PAYROLL_RESULT_NOT_FOUND', 'Payroll result not found');
  await lockPeriod(tx, result.run.periodId);
  assertRunMutable(result.run);
  // Task 48 (T44-P1-14): a handed-over amount is money in the source's currency; payroll pays only its own currency and
  // converts nothing. An ordinary manual adjustment is entered in the run currency by definition.
  if (input.reference && input.reference.currency !== result.run.currencyCode) {
    throw new AppError(409, 'PAYROLL_CURRENCY_MISMATCH', `The ${input.reference.type === 'BENEFIT_CLAIM' ? 'claim' : 'report'} is in ${input.reference.currency}; this payroll run pays in ${result.run.currencyCode}. Pay it outside payroll (no currency conversion is done).`);
  }
  if (input.reference) {
    const existing = await tx.payrollResultItem.findFirst({ where: { referenceType: input.reference.type, referenceId: input.reference.id, isManual: true }, select: { id: true } });
    if (existing) return { itemId: existing.id, created: false };
  }
  const component = await tx.payComponent.findUnique({ where: { id: input.componentId }, select: { id: true, code: true, name: true, type: true, isActive: true } });
  if (!component) throw new AppError(404, 'PAY_COMPONENT_NOT_FOUND', 'Pay component not found');
  if (!component.isActive) throw new AppError(409, 'PAY_COMPONENT_INACTIVE', 'That pay component is inactive');
  const item = await tx.payrollResultItem.create({
    data: {
      payrollResultId: resultId, componentId: component.id, componentCodeSnapshot: component.code, componentNameSnapshot: component.name, type: component.type, source: 'MANUAL',
      amount: money(input.amount), description: input.note, isManual: true, referenceType: input.reference?.type ?? null, referenceId: input.reference?.id ?? null, createdByUserId: actor.auth.userId,
    },
  });
  await recomputeResultTotals(tx, resultId);
  await recomputeRunTotals(tx, result.run.id);
  await auditService.log(payrollAudit(actor, AUDIT_ACTIONS.ADD_PAYROLL_ADJUSTMENT, 'PayrollResult', resultId, {
    component: component.code, type: component.type, amount: toMoneyString(input.amount), noteLength: input.note?.length ?? 0, referenceType: input.reference?.type ?? null, referenceId: input.reference?.id ?? null,
  }), tx);
  return { itemId: item.id, created: true };
}

/** The payroll result of one employee in a period's current run, for a module that must hand money to payroll. */
export async function findPayrollResultForEmployee(db: Db, periodId: string, employeeId: string) {
  const run = await db.payrollRun.findFirst({ where: { periodId }, orderBy: { version: 'desc' }, select: { id: true, status: true, workflowInstanceId: true } });
  if (!run) return null;
  const result = await db.payrollResult.findFirst({ where: { runId: run.id, employeeId }, select: { id: true } });
  return result ? { runId: run.id, runStatus: run.status, resultId: result.id, pendingApproval: !!run.workflowInstanceId } : null;
}

async function recomputeResultTotals(tx: Tx, resultId: string) {
  const items = await tx.payrollResultItem.findMany({ where: { payrollResultId: resultId }, select: { type: true, amount: true } });
  const gross = sumMoney(items.filter((i) => i.type === 'EARNING').map((i) => i.amount));
  const deductions = sumMoney(items.filter((i) => i.type === 'DEDUCTION').map((i) => i.amount));
  await tx.payrollResult.update({ where: { id: resultId }, data: { grossPay: gross, totalDeductions: deductions, netPay: money(gross.minus(deductions)) } });
}

/** Recomputes a run's totals from its results. */
async function recomputeRunTotals(tx: Tx, runId: string) {
  const results = await tx.payrollResult.findMany({ where: { runId }, select: { grossPay: true, totalDeductions: true, netPay: true } });
  await tx.payrollRun.update({
    where: { id: runId },
    data: {
      employeeCount: results.length,
      grossTotal: sumMoney(results.map((r) => r.grossPay)),
      deductionTotal: sumMoney(results.map((r) => r.totalDeductions)),
      netTotal: sumMoney(results.map((r) => r.netPay)),
    },
  });
}

/**
 * Task 51 (T44-P1-19) — maker ≠ checker at payroll approval. The approver may be paid by the run (Case C: an unchanged
 * salary among everybody else's is not a conflict); what they may not do is approve a run in which an input that pays
 * THEM was authored by THEM: a manual line on their own result, or a salary / recurring record of theirs covering the
 * period. Source checks already refuse such inputs; this catches anything older or written by another path.
 * Source-linked lines (benefit / expense handoffs) carry an amount approved in their own domain and are not counted.
 */
export async function assertApproverIndependent(tx: Tx, runId: string, approver: { userId: string; employeeId: string | null }, period: { periodStart: string; periodEnd: string }) {
  if (!approver.employeeId) return;
  const own = await tx.payrollResult.findFirst({ where: { runId, employeeId: approver.employeeId }, select: { id: true } });
  if (!own) return;
  const [lines, compensations, payItems] = await Promise.all([
    tx.payrollResultItem.findMany({ where: { payrollResultId: own.id, isManual: true, createdByUserId: approver.userId }, select: { referenceType: true } }),
    tx.employeeCompensation.count({ where: { employeeId: approver.employeeId, createdByUserId: approver.userId, effectiveFrom: { lte: period.periodEnd }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: period.periodStart } }] } }),
    tx.employeePayItem.count({ where: { employeeId: approver.employeeId, createdByUserId: approver.userId, effectiveFrom: { lte: period.periodEnd }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: period.periodStart } }] } }),
  ]);
  if (lines.some((l) => !isSourceLinkedLine(l)) || compensations > 0 || payItems > 0) {
    throw new AppError(409, 'PAYROLL_APPROVER_SELF_BENEFIT', 'This run pays you an amount you entered yourself; another authorized approver must decide it.');
  }
}

/**
 * The three questions asked before a run may be approved, in the order that matters:
 * are the inputs still the ones it was calculated from, does the arithmetic close, and is anybody being paid a
 * negative amount?
 */
async function assertApprovable(tx: Tx, runId: string, period: PeriodRow) {
  const run = await tx.payrollRun.findUniqueOrThrow({ where: { id: runId } });
  const current = await payrollRunService.inputsAreCurrent(tx, period, run);
  if (!current) {
    throw new AppError(409, 'PAYROLL_INPUT_CHANGED', 'A salary, attendance, leave or overtime source has changed since this run was calculated. Recalculate before approving.');
  }
  const reconciliation = await payrollRunService.reconcile(tx, runId);
  if (reconciliation.negativeNetEmployees.length > 0) {
    throw new AppError(409, 'PAYROLL_NEGATIVE_NET', `${reconciliation.negativeNetEmployees.length} employee(s) would be paid a negative amount (${reconciliation.negativeNetEmployees.map((e) => e.employeeCode).join(', ')}). Adjust before approving.`);
  }
  if (!reconciliation.ok) {
    throw new AppError(409, 'PAYROLL_RECONCILIATION_FAILED', `The run does not reconcile: ${reconciliation.problems[0]}`);
  }
}

export { recomputeResultTotals, recomputeRunTotals, toResultDto, toRunSummary, resultInclude, periodInclude, toPeriodDto };
export type { PeriodRow, ResultRow };
