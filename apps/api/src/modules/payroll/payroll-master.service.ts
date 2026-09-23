import {
  AUDIT_ACTIONS, SYSTEM_PAY_COMPONENTS, compareBusinessDate,
  type CompensationDto, type CompensationListQuery, type CreateCompensationInput, type CreatePayComponentInput,
  type CreatePayItemInput, type CreatePayrollPolicyInput, type PayComponentDto, type PayComponentListQuery,
  type PayItemDto, type PayItemListQuery, type PayrollPolicyDto, type UpdateCompensationInput,
  type UpdatePayComponentInput, type UpdatePayItemInput, type UpdatePayrollPolicyInput,
} from '@hr/shared';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { AppError } from '../../lib/errors';
import { auditService } from '../../services/audit/audit.service';
import { workflowDefinitionsService } from '../../services/workflow';
import { dec, toMoneyString, toQuantityString } from './money';
import { employeeRef, payrollAudit, type Actor, type Db } from './payroll.types';

/**
 * Payroll master data: salary history, the components a payslip can contain, recurring items, and the policy that
 * turns a monthly salary into daily and minute rates.
 *
 * The rule that runs through all of it: **nothing that a payroll run has already used may be edited in place.** A
 * salary change closes the old record and opens a new one; a component's meaning is fixed once it exists; a policy's
 * numbers are configuration, never assumptions baked into code.
 */
const rangesOverlap = (aFrom: string, aTo: string | null, bFrom: string, bTo: string | null) =>
  compareBusinessDate(aFrom, bTo ?? '9999-12-31') <= 0 && compareBusinessDate(bFrom, aTo ?? '9999-12-31') <= 0;

// ---------------------------------------------------------------------------
// compensation
// ---------------------------------------------------------------------------
const compensationInclude = {
  employee: employeeRef,
  createdBy: { select: { id: true, email: true } },
} satisfies Prisma.EmployeeCompensationInclude;
type CompensationRow = Prisma.EmployeeCompensationGetPayload<{ include: typeof compensationInclude }>;

const toCompensationDto = (row: CompensationRow, inUse: boolean): CompensationDto => ({
  id: row.id,
  employee: row.employee,
  effectiveFrom: row.effectiveFrom,
  effectiveTo: row.effectiveTo,
  salaryType: row.salaryType,
  baseSalary: toMoneyString(row.baseSalary),
  currencyCode: row.currencyCode,
  note: row.note,
  inUse,
  createdAt: row.createdAt.toISOString(),
  createdBy: row.createdBy,
});

export const compensationService = {
  async list(q: CompensationListQuery): Promise<{ data: CompensationDto[]; meta: { page: number; pageSize: number; total: number } }> {
    const where: Prisma.EmployeeCompensationWhereInput = {
      employeeId: q.employeeId,
      ...(q.asOfDate ? { effectiveFrom: { lte: q.asOfDate }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: q.asOfDate } }] } : {}),
      ...(q.search
        ? { employee: { OR: [
            { employeeCode: { contains: q.search, mode: 'insensitive' } },
            { firstName: { contains: q.search, mode: 'insensitive' } },
            { lastName: { contains: q.search, mode: 'insensitive' } },
          ] } }
        : {}),
    };
    const [total, rows] = await prisma.$transaction([
      prisma.employeeCompensation.count({ where }),
      prisma.employeeCompensation.findMany({ where, include: compensationInclude, orderBy: [{ employeeId: 'asc' }, { effectiveFrom: 'desc' }], skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
    ]);
    const used = await prisma.payrollResult.groupBy({ by: ['compensationId'], where: { compensationId: { in: rows.map((r) => r.id) } }, _count: { _all: true } });
    const inUse = new Set(used.map((u) => u.compensationId));
    return { data: rows.map((r) => toCompensationDto(r, inUse.has(r.id))), meta: { page: q.page, pageSize: q.pageSize, total } };
  },

  /**
   * A new salary record. Periods may not overlap for one employee, so resolving a payroll period can never find two
   * salaries — and a salary change is recorded as history rather than an overwrite.
   */
  async create(input: CreateCompensationInput, actor: Actor): Promise<CompensationDto> {
    const employee = await prisma.employee.findUnique({ where: { id: input.employeeId }, select: { id: true } });
    if (!employee) throw new AppError(404, 'EMPLOYEE_NOT_FOUND', 'Employee not found');

    const row = await prisma.$transaction(async (tx) => {
      const others = await tx.employeeCompensation.findMany({ where: { employeeId: input.employeeId }, select: { id: true, effectiveFrom: true, effectiveTo: true } });
      const clash = others.find((o) => rangesOverlap(input.effectiveFrom, input.effectiveTo ?? null, o.effectiveFrom, o.effectiveTo));
      if (clash) {
        throw new AppError(409, 'COMPENSATION_OVERLAP', `Overlaps an existing salary record (${clash.effectiveFrom} → ${clash.effectiveTo ?? 'open'}). Close that record first.`);
      }
      const created = await tx.employeeCompensation.create({
        data: {
          employeeId: input.employeeId,
          effectiveFrom: input.effectiveFrom,
          effectiveTo: input.effectiveTo ?? null,
          salaryType: input.salaryType,
          baseSalary: dec(input.baseSalary),
          currencyCode: input.currencyCode,
          note: input.note ?? null,
          createdByUserId: actor.auth.userId,
        },
        include: compensationInclude,
      });
      await auditService.log(payrollAudit(actor, AUDIT_ACTIONS.CREATE_COMPENSATION, 'EmployeeCompensation', created.id, {
        employeeId: created.employeeId, effectiveFrom: created.effectiveFrom, effectiveTo: created.effectiveTo,
        baseSalary: toMoneyString(created.baseSalary), currencyCode: created.currencyCode,
      }), tx);
      return created;
    });
    return toCompensationDto(row, false);
  },

  /** Only the end date and the note can change: the amount is history. */
  async update(id: string, input: UpdateCompensationInput, actor: Actor): Promise<CompensationDto> {
    const row = await prisma.$transaction(async (tx) => {
      const before = await tx.employeeCompensation.findUnique({ where: { id }, include: compensationInclude });
      if (!before) throw new AppError(404, 'COMPENSATION_NOT_FOUND', 'Salary record not found');
      const effectiveTo = input.effectiveTo === undefined ? before.effectiveTo : input.effectiveTo;
      if (effectiveTo && compareBusinessDate(effectiveTo, before.effectiveFrom) < 0) {
        throw new AppError(400, 'VALIDATION_ERROR', 'effectiveTo must be on or after effectiveFrom');
      }
      if (effectiveTo) {
        // Closing it before a period it has already paid would leave that payroll run unexplainable.
        const used = await tx.payrollResult.findFirst({
          where: { compensationId: id },
          select: { run: { select: { period: { select: { periodEnd: true, id: true } } } } },
          orderBy: { createdAt: 'desc' },
        });
        const periodEnd = used?.run.period.periodEnd;
        if (periodEnd && compareBusinessDate(effectiveTo, periodEnd) < 0) {
          throw new AppError(409, 'COMPENSATION_IN_USE', `A payroll run has already paid this salary up to ${periodEnd}; it cannot end before that`);
        }
      }
      const after = await tx.employeeCompensation.update({ where: { id }, data: { effectiveTo, note: input.note === undefined ? undefined : input.note }, include: compensationInclude });
      await auditService.log(payrollAudit(actor, AUDIT_ACTIONS.UPDATE_COMPENSATION, 'EmployeeCompensation', id,
        { effectiveTo: after.effectiveTo }, { effectiveTo: before.effectiveTo }), tx);
      return after;
    });
    return toCompensationDto(row, false);
  },

  /** Internal: the salary records covering a date range for one employee (used by the calculation). */
  async forPeriod(db: Db, employeeId: string, from: string, to: string) {
    return db.employeeCompensation.findMany({
      where: { employeeId, effectiveFrom: { lte: to }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: from } }] },
      orderBy: { effectiveFrom: 'asc' },
    });
  },
};

// ---------------------------------------------------------------------------
// pay components
// ---------------------------------------------------------------------------
const toComponentDto = (row: Prisma.PayComponentGetPayload<object>): PayComponentDto => ({
  id: row.id,
  code: row.code,
  name: row.name,
  type: row.type as PayComponentDto['type'],
  calculationType: row.calculationType as PayComponentDto['calculationType'],
  taxable: row.taxable,
  recurringAllowed: row.recurringAllowed,
  description: row.description,
  isSystem: row.isSystem,
  isActive: row.isActive,
});

/** The components the engine writes. Created on demand so a fresh install needs no seed step for payroll to work. */
const SYSTEM_COMPONENT_DEFINITIONS = [
  { code: SYSTEM_PAY_COMPONENTS.BASE_SALARY, name: 'Base salary', type: 'EARNING', description: 'Monthly salary for the period' },
  { code: SYSTEM_PAY_COMPONENTS.OT_PAY, name: 'Overtime', type: 'EARNING', description: 'Approved overtime minutes at the snapshotted multiplier' },
  { code: SYSTEM_PAY_COMPONENTS.UNPAID_LEAVE_DEDUCTION, name: 'Unpaid leave', type: 'DEDUCTION', description: 'Approved leave under an unpaid policy' },
  { code: SYSTEM_PAY_COMPONENTS.ABSENCE_DEDUCTION, name: 'Absence', type: 'DEDUCTION', description: 'Scheduled days with no attendance and no approved leave' },
  { code: SYSTEM_PAY_COMPONENTS.LATE_DEDUCTION, name: 'Late', type: 'DEDUCTION', description: 'Late minutes, when the payroll policy deducts them' },
  { code: SYSTEM_PAY_COMPONENTS.MANUAL_EARNING, name: 'Manual earning', type: 'EARNING', description: 'Added by a payroll administrator during review' },
  { code: SYSTEM_PAY_COMPONENTS.MANUAL_DEDUCTION, name: 'Manual deduction', type: 'DEDUCTION', description: 'Added by a payroll administrator during review' },
] as const;

export const payComponentService = {
  /** Ensures the system components exist. Idempotent, and never rewrites one that is already there. */
  async ensureSystemComponents(db: Db = prisma) {
    for (const definition of SYSTEM_COMPONENT_DEFINITIONS) {
      await db.payComponent.upsert({
        where: { code: definition.code },
        create: { ...definition, calculationType: definition.code.startsWith('MANUAL') ? 'MANUAL' : 'SYSTEM', isSystem: true, recurringAllowed: false, taxable: definition.type === 'EARNING' },
        update: {},
      });
    }
  },

  async list(q: PayComponentListQuery): Promise<{ data: PayComponentDto[]; meta: { page: number; pageSize: number; total: number } }> {
    await payComponentService.ensureSystemComponents();
    const where: Prisma.PayComponentWhereInput = {
      type: q.type,
      ...(q.status ? { isActive: q.status === 'active' } : {}),
      ...(q.search ? { OR: [{ code: { contains: q.search, mode: 'insensitive' } }, { name: { contains: q.search, mode: 'insensitive' } }] } : {}),
    };
    const [total, rows] = await prisma.$transaction([
      prisma.payComponent.count({ where }),
      prisma.payComponent.findMany({ where, orderBy: [{ isSystem: 'desc' }, { type: 'asc' }, { code: 'asc' }], skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
    ]);
    return { data: rows.map(toComponentDto), meta: { page: q.page, pageSize: q.pageSize, total } };
  },

  async create(input: CreatePayComponentInput, actor: Actor): Promise<PayComponentDto> {
    const duplicate = await prisma.payComponent.findUnique({ where: { code: input.code }, select: { id: true } });
    if (duplicate) throw new AppError(409, 'PAY_COMPONENT_EXISTS', 'A pay component with that code already exists');
    const row = await prisma.$transaction(async (tx) => {
      const created = await tx.payComponent.create({ data: { ...input, description: input.description ?? null, isSystem: false } });
      await auditService.log(payrollAudit(actor, AUDIT_ACTIONS.CREATE_PAY_COMPONENT, 'PayComponent', created.id, {
        code: created.code, name: created.name, type: created.type, calculationType: created.calculationType,
      }), tx);
      return created;
    });
    return toComponentDto(row);
  },

  /**
   * A component's **meaning** never changes: its code, type and calculation type are fixed once it exists, because
   * payslips already refer to them. The label and flags can be corrected.
   */
  async update(id: string, input: UpdatePayComponentInput, actor: Actor): Promise<PayComponentDto> {
    const row = await prisma.$transaction(async (tx) => {
      const before = await tx.payComponent.findUnique({ where: { id } });
      if (!before) throw new AppError(404, 'PAY_COMPONENT_NOT_FOUND', 'Pay component not found');
      if (before.isSystem && input.isActive === false) {
        throw new AppError(409, 'PAY_COMPONENT_IS_SYSTEM', 'A system component cannot be deactivated: the payroll engine writes it');
      }
      const after = await tx.payComponent.update({ where: { id }, data: input });
      await auditService.log(payrollAudit(actor, AUDIT_ACTIONS.UPDATE_PAY_COMPONENT, 'PayComponent', id,
        { name: after.name, taxable: after.taxable, recurringAllowed: after.recurringAllowed, isActive: after.isActive },
        { name: before.name, taxable: before.taxable, recurringAllowed: before.recurringAllowed, isActive: before.isActive }), tx);
      return after;
    });
    return toComponentDto(row);
  },
};

// ---------------------------------------------------------------------------
// recurring pay items
// ---------------------------------------------------------------------------
const payItemInclude = {
  employee: { select: { id: true, employeeCode: true, firstName: true, lastName: true } },
  component: { select: { id: true, code: true, name: true, type: true } },
} satisfies Prisma.EmployeePayItemInclude;
type PayItemRow = Prisma.EmployeePayItemGetPayload<{ include: typeof payItemInclude }>;

const toPayItemDto = (row: PayItemRow): PayItemDto => ({
  id: row.id,
  employee: row.employee,
  component: row.component,
  amount: toMoneyString(row.amount),
  effectiveFrom: row.effectiveFrom,
  effectiveTo: row.effectiveTo,
  note: row.note,
});

export const payItemService = {
  async list(q: PayItemListQuery): Promise<{ data: PayItemDto[]; meta: { page: number; pageSize: number; total: number } }> {
    const where: Prisma.EmployeePayItemWhereInput = {
      employeeId: q.employeeId,
      componentId: q.componentId,
      ...(q.asOfDate ? { effectiveFrom: { lte: q.asOfDate }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: q.asOfDate } }] } : {}),
    };
    const [total, rows] = await prisma.$transaction([
      prisma.employeePayItem.count({ where }),
      prisma.employeePayItem.findMany({ where, include: payItemInclude, orderBy: [{ employeeId: 'asc' }, { effectiveFrom: 'desc' }], skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
    ]);
    return { data: rows.map(toPayItemDto), meta: { page: q.page, pageSize: q.pageSize, total } };
  },

  /** One active assignment per employee and component at a time — two would be two answers to the same question. */
  async create(input: CreatePayItemInput, actor: Actor): Promise<PayItemDto> {
    const [employee, component] = await Promise.all([
      prisma.employee.findUnique({ where: { id: input.employeeId }, select: { id: true } }),
      prisma.payComponent.findUnique({ where: { id: input.componentId }, select: { id: true, code: true, isActive: true, recurringAllowed: true } }),
    ]);
    if (!employee) throw new AppError(404, 'EMPLOYEE_NOT_FOUND', 'Employee not found');
    if (!component) throw new AppError(404, 'PAY_COMPONENT_NOT_FOUND', 'Pay component not found');
    if (!component.isActive) throw new AppError(409, 'PAY_COMPONENT_INACTIVE', 'That pay component is inactive');
    if (!component.recurringAllowed) throw new AppError(409, 'PAY_COMPONENT_NOT_RECURRING', `${component.code} cannot be assigned as a recurring item`);

    const row = await prisma.$transaction(async (tx) => {
      const others = await tx.employeePayItem.findMany({
        where: { employeeId: input.employeeId, componentId: input.componentId },
        select: { id: true, effectiveFrom: true, effectiveTo: true },
      });
      const clash = others.find((o) => rangesOverlap(input.effectiveFrom, input.effectiveTo ?? null, o.effectiveFrom, o.effectiveTo));
      if (clash) throw new AppError(409, 'PAY_ITEM_OVERLAP', `This employee already has that component from ${clash.effectiveFrom} to ${clash.effectiveTo ?? 'open'}`);

      const created = await tx.employeePayItem.create({
        data: {
          employeeId: input.employeeId, componentId: input.componentId, amount: dec(input.amount),
          effectiveFrom: input.effectiveFrom, effectiveTo: input.effectiveTo ?? null, note: input.note ?? null,
          createdByUserId: actor.auth.userId,
        },
        include: payItemInclude,
      });
      await auditService.log(payrollAudit(actor, AUDIT_ACTIONS.ASSIGN_PAY_ITEM, 'EmployeePayItem', created.id, {
        employeeId: created.employeeId, component: created.component.code, amount: toMoneyString(created.amount),
        effectiveFrom: created.effectiveFrom, effectiveTo: created.effectiveTo,
      }), tx);
      return created;
    });
    return toPayItemDto(row);
  },

  async update(id: string, input: UpdatePayItemInput, actor: Actor): Promise<PayItemDto> {
    const row = await prisma.$transaction(async (tx) => {
      const before = await tx.employeePayItem.findUnique({ where: { id }, include: payItemInclude });
      if (!before) throw new AppError(404, 'PAY_ITEM_NOT_FOUND', 'Recurring item not found');
      const after = await tx.employeePayItem.update({
        where: { id },
        data: {
          amount: input.amount === undefined ? undefined : dec(input.amount),
          effectiveTo: input.effectiveTo === undefined ? undefined : input.effectiveTo,
          note: input.note === undefined ? undefined : input.note,
        },
        include: payItemInclude,
      });
      await auditService.log(payrollAudit(actor, AUDIT_ACTIONS.UPDATE_PAY_ITEM, 'EmployeePayItem', id,
        { amount: toMoneyString(after.amount), effectiveTo: after.effectiveTo },
        { amount: toMoneyString(before.amount), effectiveTo: before.effectiveTo }), tx);
      return after;
    });
    return toPayItemDto(row);
  },

  /** Internal: recurring items in force across a period (used by the calculation). */
  async forPeriod(db: Db, employeeIds: string[], from: string, to: string) {
    return db.employeePayItem.findMany({
      where: { employeeId: { in: employeeIds }, effectiveFrom: { lte: to }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: from } }] },
      include: { component: { select: { id: true, code: true, name: true, type: true } } },
    });
  },
};

// ---------------------------------------------------------------------------
// payroll policy
// ---------------------------------------------------------------------------
const policyInclude = { organization: { select: { id: true, code: true, name: true } } } as const;
type PolicyRow = Prisma.PayrollPolicyGetPayload<{ include: typeof policyInclude }>;

const toPolicyDto = (row: PolicyRow): PayrollPolicyDto => ({
  id: row.id,
  organization: row.organization,
  name: row.name,
  monthlyDivisorDays: toQuantityString(row.monthlyDivisorDays),
  dailyWorkHours: toQuantityString(row.dailyWorkHours),
  newHireProration: row.newHireProration as PayrollPolicyDto['newHireProration'],
  terminationProration: row.terminationProration as PayrollPolicyDto['terminationProration'],
  absenceDeductionEnabled: row.absenceDeductionEnabled,
  lateDeductionEnabled: row.lateDeductionEnabled,
  workflowDefinitionCode: row.workflowDefinitionCode,
  effectiveFrom: row.effectiveFrom,
  effectiveTo: row.effectiveTo,
  currencyCode: row.currencyCode,
  isActive: row.isActive,
});

export const payrollPolicyService = {
  async list(organizationId?: string): Promise<PayrollPolicyDto[]> {
    const rows = await prisma.payrollPolicy.findMany({ where: { organizationId }, include: policyInclude, orderBy: [{ organizationId: 'asc' }, { effectiveFrom: 'desc' }], take: 200 });
    return rows.map(toPolicyDto);
  },

  async create(input: CreatePayrollPolicyInput, actor: Actor): Promise<PayrollPolicyDto> {
    const organization = await prisma.organization.findUnique({ where: { id: input.organizationId }, select: { id: true } });
    if (!organization) throw new AppError(404, 'ORGANIZATION_NOT_FOUND', 'Organization not found');
    await workflowDefinitionsService.getActive(prisma, input.workflowDefinitionCode);

    const row = await prisma.$transaction(async (tx) => {
      const others = await tx.payrollPolicy.findMany({ where: { organizationId: input.organizationId, isActive: true }, select: { id: true, name: true, effectiveFrom: true, effectiveTo: true } });
      const clash = others.find((o) => rangesOverlap(input.effectiveFrom, input.effectiveTo ?? null, o.effectiveFrom, o.effectiveTo));
      if (clash) throw new AppError(409, 'PAYROLL_POLICY_OVERLAP', `Overlaps the active policy "${clash.name}" (${clash.effectiveFrom} → ${clash.effectiveTo ?? 'open'})`);

      const created = await tx.payrollPolicy.create({
        data: {
          organizationId: input.organizationId, name: input.name,
          monthlyDivisorDays: dec(input.monthlyDivisorDays), dailyWorkHours: dec(input.dailyWorkHours),
          newHireProration: input.newHireProration, terminationProration: input.terminationProration,
          absenceDeductionEnabled: input.absenceDeductionEnabled, lateDeductionEnabled: input.lateDeductionEnabled,
          workflowDefinitionCode: input.workflowDefinitionCode,
          effectiveFrom: input.effectiveFrom, effectiveTo: input.effectiveTo ?? null, currencyCode: input.currencyCode,
        },
        include: policyInclude,
      });
      await auditService.log(payrollAudit(actor, AUDIT_ACTIONS.CREATE_PAYROLL_POLICY, 'PayrollPolicy', created.id, {
        name: created.name, monthlyDivisorDays: toQuantityString(created.monthlyDivisorDays), dailyWorkHours: toQuantityString(created.dailyWorkHours),
        absenceDeductionEnabled: created.absenceDeductionEnabled, lateDeductionEnabled: created.lateDeductionEnabled,
        workflowDefinitionCode: created.workflowDefinitionCode, effectiveFrom: created.effectiveFrom,
      }), tx);
      return created;
    });
    return toPolicyDto(row);
  },

  async update(id: string, input: UpdatePayrollPolicyInput, actor: Actor): Promise<PayrollPolicyDto> {
    if (input.workflowDefinitionCode) await workflowDefinitionsService.getActive(prisma, input.workflowDefinitionCode);
    const row = await prisma.$transaction(async (tx) => {
      const before = await tx.payrollPolicy.findUnique({ where: { id }, include: policyInclude });
      if (!before) throw new AppError(404, 'PAYROLL_POLICY_NOT_FOUND', 'Payroll policy not found');
      const used = await tx.payrollPeriod.count({ where: { policyId: id, status: { in: ['REVIEW', 'APPROVED', 'CLOSED'] } } });
      const changesRates = ['monthlyDivisorDays', 'dailyWorkHours', 'newHireProration', 'terminationProration', 'absenceDeductionEnabled', 'lateDeductionEnabled'].some(
        (f) => input[f as keyof UpdatePayrollPolicyInput] !== undefined,
      );
      if (used > 0 && changesRates) {
        throw new AppError(409, 'PAYROLL_POLICY_IN_USE', `${used} payroll period(s) have already been calculated with this policy; close it and create a new one instead of changing how it calculates`);
      }
      const after = await tx.payrollPolicy.update({
        where: { id },
        data: {
          ...input,
          monthlyDivisorDays: input.monthlyDivisorDays === undefined ? undefined : dec(input.monthlyDivisorDays),
          dailyWorkHours: input.dailyWorkHours === undefined ? undefined : dec(input.dailyWorkHours),
        },
        include: policyInclude,
      });
      await auditService.log(payrollAudit(actor, AUDIT_ACTIONS.UPDATE_PAYROLL_POLICY, 'PayrollPolicy', id,
        { name: after.name, isActive: after.isActive, effectiveTo: after.effectiveTo, workflowDefinitionCode: after.workflowDefinitionCode },
        { name: before.name, isActive: before.isActive, effectiveTo: before.effectiveTo, workflowDefinitionCode: before.workflowDefinitionCode }), tx);
      return after;
    });
    return toPolicyDto(row);
  },

  /** The policy in force for an organization on a date. Exactly one, or none. */
  async resolve(db: Db, organizationId: string, onDate: string) {
    const rows = await db.payrollPolicy.findMany({
      where: { organizationId, isActive: true, effectiveFrom: { lte: onDate }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: onDate } }] },
      orderBy: [{ effectiveFrom: 'desc' }, { id: 'asc' }],
      take: 1,
    });
    const policy = rows[0];
    if (!policy) throw new AppError(409, 'PAYROLL_POLICY_NOT_FOUND', 'No payroll policy is in force for this organization on that date');
    return policy;
  },
};

/**
 * Active employees for a payroll picker. It lives here, behind `payroll.manage`, rather than being borrowed from
 * leave: a payroll administrator need not hold any leave permission, and leave's endpoint would refuse them.
 */
export async function payrollEmployeeOptions(q: { search?: string; organizationId?: string; limit: number }) {
  const terms = (q.search ?? '').split(/\s+/).filter(Boolean);
  return prisma.employee.findMany({
    where: {
      employmentStatus: 'ACTIVE',
      organizationId: q.organizationId,
      AND: terms.map((t) => ({
        OR: [
          { employeeCode: { contains: t, mode: 'insensitive' as const } },
          { firstName: { contains: t, mode: 'insensitive' as const } },
          { lastName: { contains: t, mode: 'insensitive' as const } },
        ],
      })),
    },
    select: { id: true, employeeCode: true, firstName: true, lastName: true, organization: { select: { id: true, code: true, name: true } }, department: { select: { id: true, code: true, name: true } } },
    orderBy: { employeeCode: 'asc' },
    take: q.limit,
  });
}
