import type { Prisma } from '@prisma/client';
import { AUDIT_ACTIONS, NOTIFICATION_TYPES, benefitOperationKeys, type AdjustBenefitEntitlementInput, type BenefitEnrollmentDto, type BenefitEntitlementDetailDto, type BenefitEntitlementDto, type BenefitLedgerEntryDto, type EnrollBenefitInput, type GenerateEntitlementsInput } from '@hr/shared';
import { AppError } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { auditService } from '../../services/audit/audit.service';
import { notificationService } from '../../services/notification';
import type { AuthContext } from '../auth/auth.types';
import { dec, toMoneyString } from '../payroll/money';
import { appendLedger, balanceDto, loadEntitlementForMutation, sumsOf } from './benefit-ledger';
import { type Actor, type Db, adminScope, benefitsAudit, canSeeEmployee, employeeInclude, employeeSnapshot, lockRow, notFound, snapshotData, snapshotDto, textAudit, userNames, visibleEmployeeWhere } from './benefits.types';
import { organizationTodays, todayForEmployee } from '../../services/business-time/business-time';
import { activeOverride, evaluateRules } from './eligibility.service';

// ---------- enrollments ----------
const enrInclude = { plan: { select: { name: true, code: true, planType: true, category: { select: { name: true } } } } } as const;
type EnrRow = Prisma.BenefitEnrollmentGetPayload<{ include: typeof enrInclude }>;
export const enrollmentDto = (r: EnrRow): BenefitEnrollmentDto => ({ id: r.id, employeeId: r.employeeId, planId: r.planId, planName: r.plan.name, planCode: r.plan.code, planType: r.plan.planType as BenefitEnrollmentDto['planType'], categoryName: r.plan.category.name, snapshot: snapshotDto(r), status: r.status as BenefitEnrollmentDto['status'], source: r.source as BenefitEnrollmentDto['source'], enrolledAt: r.enrolledAt?.toISOString() ?? null, waivedAt: r.waivedAt?.toISOString() ?? null, endedAt: r.endedAt?.toISOString() ?? null, coverageStart: r.coverageStart, coverageEnd: r.coverageEnd, createdAt: r.createdAt.toISOString() });

async function enrollWithTx(tx: Prisma.TransactionClient, planId: string, employeeId: string, source: 'SELF' | 'HR', coverage: { coverageStart?: string | null; coverageEnd?: string | null }, actor: Actor) {
  const plan = await tx.benefitPlan.findUnique({ where: { id: planId }, include: { rules: true } }); if (!plan) throw notFound('benefit plan');
  if (plan.status !== 'ACTIVE') throw new AppError(409, 'BENEFIT_PLAN_NOT_ACTIVE', 'Enrolment needs an active plan');
  if (source === 'SELF' && !plan.employeeSelectable) throw new AppError(409, 'BENEFIT_PLAN_NOT_SELECTABLE', 'This plan is enrolled by HR');
  const { employee, data } = await employeeSnapshot(tx, employeeId);
  if (employee.employmentStatus !== 'ACTIVE') throw new AppError(409, 'EMPLOYEE_NOT_ACTIVE', 'Only an active employee can be enrolled');
  const today = await todayForEmployee(tx, employeeId); // Task 53: the employee's own business today (was Bangkok's)
  const elig = evaluateRules(employee, plan.rules, await activeOverride(tx, plan.id, employeeId), today);
  if (!elig.eligible) throw new AppError(422, 'BENEFIT_NOT_ELIGIBLE', 'Not eligible for this plan', elig.reasons.map((r) => ({ field: 'employeeId', message: r.message })));
  const existing = await tx.benefitEnrollment.findUnique({ where: { employeeId_planId: { employeeId, planId } } });
  if (existing?.status === 'ENROLLED') throw new AppError(409, 'BENEFIT_ALREADY_ENROLLED', 'Already enrolled');
  const now = new Date();
  const row = existing
    ? await tx.benefitEnrollment.update({ where: { id: existing.id }, data: { status: 'ENROLLED', source, enrolledAt: now, endedAt: null, coverageStart: coverage.coverageStart ?? existing.coverageStart ?? today, coverageEnd: coverage.coverageEnd ?? null, ...data }, include: enrInclude })
    : await tx.benefitEnrollment.create({ data: { employeeId, planId, ...data, status: 'ENROLLED', source, enrolledAt: now, coverageStart: coverage.coverageStart ?? today, coverageEnd: coverage.coverageEnd ?? null }, include: enrInclude });
  await auditService.log(benefitsAudit(actor, AUDIT_ACTIONS.ENROLL_BENEFIT, 'BenefitEnrollment', row.id, { planId, employeeId, source, coverageStart: row.coverageStart, coverageEnd: row.coverageEnd, reenrolled: !!existing }), tx);
  if (employee.user) await notificationService.publish({ userId: employee.user.id, type: NOTIFICATION_TYPES.BENEFIT_ENROLLMENT_CONFIRMED, source: { module: 'benefits', entityType: 'BENEFIT_ENROLLMENT', entityId: row.id }, data: { enrollmentId: row.id, planId }, dedupeKey: `benefits:enrollment:${row.id}:${now.getTime()}` }, { planName: plan.name }, tx);
  return row;
}

export const enrollmentService = {
  async list(auth: AuthContext, q: { page: number; pageSize: number; planId?: string; status?: string; employeeId?: string }) {
    const scope = visibleEmployeeWhere(auth);
    const where: Prisma.BenefitEnrollmentWhereInput = { ...scope, planId: q.planId, status: q.status, ...(q.employeeId ? { employeeId: scope.employeeId ?? q.employeeId } : {}) };
    const [total, rows] = await prisma.$transaction([prisma.benefitEnrollment.count({ where }), prisma.benefitEnrollment.findMany({ where, include: enrInclude, orderBy: [{ employeeNameSnapshot: 'asc' }], skip: (q.page - 1) * q.pageSize, take: q.pageSize })]);
    return { data: rows.map(enrollmentDto), meta: { page: q.page, pageSize: q.pageSize, total } };
  },
  async forEmployee(employeeId: string): Promise<BenefitEnrollmentDto[]> { return (await prisma.benefitEnrollment.findMany({ where: { employeeId }, include: enrInclude, orderBy: { createdAt: 'asc' } })).map(enrollmentDto); },
  async enroll(planId: string, input: EnrollBenefitInput, actor: Actor): Promise<BenefitEnrollmentDto> {
    return enrollmentDto(await prisma.$transaction((tx) => enrollWithTx(tx, planId, input.employeeId, 'HR', input, actor)));
  },
  async selfEnroll(planId: string, input: { coverageStart?: string | null }, actor: Actor): Promise<BenefitEnrollmentDto> {
    if (!actor.auth.employeeId) throw new AppError(409, 'NO_EMPLOYEE_RECORD', 'Your account is not linked to an employee record');
    return enrollmentDto(await prisma.$transaction((tx) => enrollWithTx(tx, planId, actor.auth.employeeId!, 'SELF', input, actor)));
  },
  /** The employee declines an employee-selectable plan. The row stays as WAIVED history. */
  async waive(planId: string, actor: Actor): Promise<BenefitEnrollmentDto> {
    if (!actor.auth.employeeId) throw new AppError(409, 'NO_EMPLOYEE_RECORD', 'Your account is not linked to an employee record');
    const employeeId = actor.auth.employeeId;
    const row = await prisma.$transaction(async (tx) => {
      const plan = await tx.benefitPlan.findUnique({ where: { id: planId } }); if (!plan) throw notFound('benefit plan');
      if (!plan.employeeSelectable) throw new AppError(409, 'BENEFIT_PLAN_NOT_SELECTABLE', 'This plan is managed by HR');
      const existing = await tx.benefitEnrollment.findUnique({ where: { employeeId_planId: { employeeId, planId } } });
      if (existing) await lockRow(tx, 'benefit_enrollments', existing.id);
      if (existing?.status === 'WAIVED') throw new AppError(409, 'BENEFIT_ALREADY_WAIVED', 'Already waived');
      const { data } = await employeeSnapshot(tx, employeeId);
      const now = new Date();
      const r = existing ? await tx.benefitEnrollment.update({ where: { id: existing.id }, data: { status: 'WAIVED', waivedAt: now, source: 'SELF' }, include: enrInclude }) : await tx.benefitEnrollment.create({ data: { employeeId, planId, ...data, status: 'WAIVED', source: 'SELF', waivedAt: now }, include: enrInclude });
      await auditService.log(benefitsAudit(actor, AUDIT_ACTIONS.WAIVE_BENEFIT, 'BenefitEnrollment', r.id, { planId, employeeId, from: existing?.status ?? null }), tx);
      return r;
    });
    return enrollmentDto(row);
  },
  async end(id: string, input: { coverageEnd?: string | null }, actor: Actor): Promise<BenefitEnrollmentDto> {
    const row = await prisma.$transaction(async (tx) => {
      await lockRow(tx, 'benefit_enrollments', id);
      const e = await tx.benefitEnrollment.findUnique({ where: { id } }); if (!e) throw notFound('benefit enrollment');
      if (e.status !== 'ENROLLED') throw new AppError(409, 'BENEFIT_NOT_ENROLLED', `This enrolment is ${e.status.toLowerCase()}`);
      const r = await tx.benefitEnrollment.update({ where: { id }, data: { status: 'ENDED', endedAt: new Date(), coverageEnd: input.coverageEnd ?? await todayForEmployee(tx, e.employeeId) }, include: enrInclude });
      await auditService.log(benefitsAudit(actor, AUDIT_ACTIONS.ENROLL_BENEFIT, 'BenefitEnrollment', id, { status: 'ENDED', coverageEnd: r.coverageEnd }, { status: 'ENROLLED' }), tx);
      return r;
    });
    return enrollmentDto(row);
  },
};

// ---------- entitlements ----------
const entInclude = { plan: { select: { name: true, code: true } }, period: { select: { name: true, periodStart: true, periodEnd: true, status: true, perClaimMaximumSnapshot: true, requiresDocumentSnapshot: true } } } as const;
type EntRow = Prisma.BenefitEntitlementGetPayload<{ include: typeof entInclude }>;
export const entitlementDto = (r: EntRow): BenefitEntitlementDto => ({ id: r.id, employeeId: r.employeeId, planId: r.planId, planName: r.plan.name, planCode: r.plan.code, periodId: r.periodId, periodName: r.period.name, periodStart: r.period.periodStart, periodEnd: r.period.periodEnd, periodStatus: r.period.status as BenefitEntitlementDto['periodStatus'], snapshot: snapshotDto(r), balance: balanceDto(r.currency, sumsOf(r)), perClaimMaximum: r.period.perClaimMaximumSnapshot ? toMoneyString(r.period.perClaimMaximumSnapshot) : null, requiresDocument: r.period.requiresDocumentSnapshot, createdAt: r.createdAt.toISOString() });

export const entitlementService = {
  async list(auth: AuthContext, q: { page: number; pageSize: number; planId?: string; periodId?: string; employeeId?: string }) {
    const scope = visibleEmployeeWhere(auth);
    const where: Prisma.BenefitEntitlementWhereInput = { ...scope, planId: q.planId, periodId: q.periodId, ...(q.employeeId ? { employeeId: scope.employeeId ?? q.employeeId } : {}) };
    const [total, rows] = await prisma.$transaction([prisma.benefitEntitlement.count({ where }), prisma.benefitEntitlement.findMany({ where, include: entInclude, orderBy: [{ employeeNameSnapshot: 'asc' }], skip: (q.page - 1) * q.pageSize, take: q.pageSize })]);
    return { data: rows.map(entitlementDto), meta: { page: q.page, pageSize: q.pageSize, total } };
  },
  async forEmployee(employeeId: string): Promise<BenefitEntitlementDto[]> { return (await prisma.benefitEntitlement.findMany({ where: { employeeId }, include: entInclude, orderBy: [{ period: { periodStart: 'desc' } }] })).map(entitlementDto); },
  async get(auth: AuthContext, id: string): Promise<BenefitEntitlementDetailDto> {
    const r = await prisma.benefitEntitlement.findUnique({ where: { id }, include: entInclude }); if (!r || !canSeeEmployee(auth, r.employeeId)) throw notFound('benefit entitlement');
    const rows = await prisma.benefitEntitlementLedger.findMany({ where: { entitlementId: id }, orderBy: { createdAt: 'asc' } });
    const [names, claims] = await Promise.all([userNames(prisma, rows.map((x) => x.createdByUserId)), prisma.benefitClaim.findMany({ where: { id: { in: rows.map((x) => x.claimId).filter((x): x is string => !!x) } }, select: { id: true, claimNumber: true } })]);
    const cn = new Map(claims.map((c) => [c.id, c.claimNumber]));
    // Adjustment notes are HR's words; the subject sees the reason code and the amount.
    const ledger: BenefitLedgerEntryDto[] = rows.map((x) => ({ id: x.id, entryType: x.entryType as BenefitLedgerEntryDto['entryType'], amount: toMoneyString(x.amount), claimId: x.claimId, claimNumber: x.claimId ? (cn.get(x.claimId) ?? null) : null, reasonCode: x.reasonCode, note: adminScope(auth) ? x.note : null, createdByName: names.get(x.createdByUserId ?? '') ?? null, createdAt: x.createdAt.toISOString() }));
    return { ...entitlementDto(r), ledger };
  },
  /**
   * HR action: one entitlement + GRANT per ENROLLED and currently eligible employee of an OPEN period. Idempotent:
   * an existing employee/plan/period account is left alone (its ledger is never re-granted).
   */
  async generate(input: GenerateEntitlementsInput, actor: Actor): Promise<{ created: number; skippedExisting: number; skippedIneligible: number; skippedNotEnrolled: number }> {
    return prisma.$transaction(async (tx) => {
      await lockRow(tx, 'benefit_periods', input.periodId);
      const period = await tx.benefitPeriod.findUnique({ where: { id: input.periodId }, include: { plan: { include: { rules: true, overrides: { where: { supersededAt: null } } } } } }); if (!period) throw notFound('benefit period');
      if (period.status !== 'OPEN') throw new AppError(409, 'BENEFIT_PERIOD_NOT_OPEN', 'Entitlements are generated for an open period');
      if (!period.currencySnapshot || !period.entitlementAmountSnapshot) throw new AppError(409, 'BENEFIT_PERIOD_NO_AMOUNT', 'This period has no entitlement amount');
      const enrolled = await tx.benefitEnrollment.findMany({ where: { planId: period.planId, status: 'ENROLLED', ...(input.employeeIds ? { employeeId: { in: input.employeeIds } } : {}) }, select: { employeeId: true } });
      const candidates = input.employeeIds ?? enrolled.map((e) => e.employeeId);
      const enrolledSet = new Set(enrolled.map((e) => e.employeeId));
      const existing = new Set((await tx.benefitEntitlement.findMany({ where: { periodId: period.id }, select: { employeeId: true } })).map((e) => e.employeeId));
      const overrides = new Map(period.plan.overrides.map((o) => [o.employeeId, { mode: o.mode, reasonCode: o.reasonCode }]));
      const employees = await tx.employee.findMany({ where: { id: { in: candidates } }, include: employeeInclude });
      const todays = await organizationTodays(tx); // Task 53: each employee's own organization's today
      const asOfFor = (e: { organizationId: string }) => { const t = todays.get(e.organizationId)!; return period.periodStart > t ? period.periodStart : t; };
      let created = 0, skippedExisting = 0, skippedIneligible = 0, skippedNotEnrolled = 0;
      for (const e of employees) {
        if (existing.has(e.id)) { skippedExisting += 1; continue; }
        if (!enrolledSet.has(e.id)) { skippedNotEnrolled += 1; continue; }
        if (!evaluateRules(e, period.plan.rules, overrides.get(e.id) ?? null, asOfFor(e)).eligible) { skippedIneligible += 1; continue; }
        const ent = await tx.benefitEntitlement.create({ data: { employeeId: e.id, planId: period.planId, periodId: period.id, currency: period.currencySnapshot, ...snapshotData(e), createdByUserId: actor.auth.userId } });
        await appendLedger(tx, { entitlementId: ent.id, entryType: 'GRANT', amount: dec(period.entitlementAmountSnapshot), operationKey: benefitOperationKeys.grant(ent.id), actorUserId: actor.auth.userId, reasonCode: 'PERIOD_GRANT' });
        created += 1;
      }
      await auditService.log(benefitsAudit(actor, AUDIT_ACTIONS.GENERATE_BENEFIT_ENTITLEMENTS, 'BenefitPeriod', period.id, { created, skippedExisting, skippedIneligible, skippedNotEnrolled, amountEach: toMoneyString(period.entitlementAmountSnapshot), currency: period.currencySnapshot }), tx);
      return { created, skippedExisting, skippedIneligible, skippedNotEnrolled };
    });
  },
  /** An explicit correction: a new ADJUSTMENT row with a reason. The grant row is never touched. */
  async adjust(id: string, input: AdjustBenefitEntitlementInput, actor: Actor): Promise<BenefitEntitlementDetailDto> {
    await prisma.$transaction(async (tx) => {
      const ent = await loadEntitlementForMutation(tx, id);
      if (ent.period.status === 'CLOSED') throw new AppError(409, 'BENEFIT_PERIOD_CLOSED', 'This period is closed');
      const r = await appendLedger(tx, { entitlementId: id, entryType: 'ADJUSTMENT', amount: dec(input.amount), reasonCode: input.reasonCode, note: input.note ?? null, actorUserId: actor.auth.userId }, { guardAvailable: true });
      await auditService.log(benefitsAudit(actor, AUDIT_ACTIONS.ADJUST_BENEFIT_ENTITLEMENT, 'BenefitEntitlement', id, { amount: toMoneyString(dec(input.amount)), reasonCode: input.reasonCode, available: toMoneyString(r.available), ...textAudit('note', null, input.note ?? null) }), tx);
    });
    return this.get(actor.auth, id);
  },
};
export type { Db };
