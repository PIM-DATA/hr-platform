import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import {
  AUDIT_ACTIONS, availableUnits, compareBusinessDate, operationKeys,
  type AdjustEntitlementInput, type CarryForwardInput, type CreateEntitlementInput, type EntitlementDto, type EntitlementListQuery, type EntitlementPreviewDto, type LeaveEmployeeOptionDto, type LeaveTypeOptionDto, type LedgerEntryDto,
} from '@hr/shared';
import { prisma } from '../../lib/prisma';
import { AppError } from '../../lib/errors';
import { auditService } from '../../services/audit/audit.service';
import type { Actor } from './leave-types.service';
import { leavePoliciesService } from './leave-policies.service';
import { balanceService, type Tx } from './balance.service';

type Db = Tx | typeof prisma;
const include = {
  employee: { select: { id: true, employeeCode: true, firstName: true, lastName: true, organization: { select: { id: true, code: true, name: true } } } },
  leaveType: { select: { id: true, code: true, name: true } },
  policy: { select: { id: true, name: true, allowNegativeBalance: true, carryForwardMaxUnits: true, isActive: true } },
} satisfies Prisma.LeaveEntitlementInclude;
type Row = Prisma.LeaveEntitlementGetPayload<{ include: typeof include }>;

const toDto = (e: Row): EntitlementDto => ({
  id: e.id, employee: e.employee, leaveType: e.leaveType, policy: e.policy, policyResolvedDate: e.policyResolvedDate, periodStart: e.periodStart, periodEnd: e.periodEnd,
  granted: e.granted, carriedForward: e.carriedForward, adjustment: e.adjustment, reserved: e.reserved, used: e.used, available: availableUnits(e),
  createdAt: e.createdAt.toISOString(), updatedAt: e.updatedAt.toISOString(),
});
const audit = (a: Actor, action: keyof typeof AUDIT_ACTIONS, recordId: string, oldValue?: unknown, newValue?: unknown) => ({ userId: a.auth.userId, ipAddress: a.ipAddress, userAgent: a.userAgent, action: AUDIT_ACTIONS[action], module: 'leave', recordType: 'LeaveEntitlement', recordId, oldValue, newValue });

async function findOrThrow(db: Db, id: string) {
  const row = await db.leaveEntitlement.findUnique({ where: { id }, include });
  if (!row) throw new AppError(404, 'LEAVE_ENTITLEMENT_NOT_FOUND', 'Leave entitlement not found');
  return row;
}

/** Employee + leave type checks shared by preview and generate. */
async function loadEmployeeAndType(db: Db, input: { employeeId: string; leaveTypeId: string }) {
  const employee = await db.employee.findUnique({ where: { id: input.employeeId }, select: { id: true, employeeCode: true, firstName: true, lastName: true, employmentStatus: true, employmentType: true, organizationId: true, organization: { select: { id: true, name: true } } } });
  if (!employee) throw new AppError(404, 'EMPLOYEE_NOT_FOUND', 'Employee not found');
  if (employee.employmentStatus !== 'ACTIVE') throw new AppError(409, 'EMPLOYEE_INACTIVE', `${employee.employeeCode} is not an active employee`);
  const leaveType = await db.leaveType.findUnique({ where: { id: input.leaveTypeId } });
  if (!leaveType) throw new AppError(404, 'LEAVE_TYPE_NOT_FOUND', 'Leave type not found');
  if (!leaveType.isActive) throw new AppError(409, 'LEAVE_TYPE_INACTIVE', `Leave type ${leaveType.code} is inactive`);
  return { employee, leaveType };
}
/** Resolves the policy for a period start (client never picks a policy). */
async function resolveForPeriod(db: Db, input: { employeeId: string; leaveTypeId: string; periodStart: string }) {
  const { employee, leaveType } = await loadEmployeeAndType(db, input);
  const policy = await leavePoliciesService.resolve(db, { leaveTypeId: leaveType.id, organizationId: employee.organizationId, employmentType: employee.employmentType, asOfDate: input.periodStart });
  return { employee, leaveType, policy };
}

export const entitlementsService = {
  async list(q: EntitlementListQuery) {
    const where: Prisma.LeaveEntitlementWhereInput = { employeeId: q.employeeId, leaveTypeId: q.leaveTypeId, periodStart: q.periodStart ?? (q.year ? { startsWith: `${q.year}-` } : undefined), employee: q.organizationId ? { organizationId: q.organizationId } : undefined };
    if (q.search) where.employee = { ...(where.employee as object), OR: [{ employeeCode: { contains: q.search, mode: 'insensitive' } }, { firstName: { contains: q.search, mode: 'insensitive' } }, { lastName: { contains: q.search, mode: 'insensitive' } }] };
    const [total, rows] = await prisma.$transaction([prisma.leaveEntitlement.count({ where }), prisma.leaveEntitlement.findMany({ where, include, orderBy: [{ periodStart: 'desc' }, { employeeId: 'asc' }], skip: (q.page - 1) * q.pageSize, take: q.pageSize })]);
    return { data: rows.map(toDto), meta: { page: q.page, pageSize: q.pageSize, total } };
  },
  async getById(id: string) {
    return toDto(await findOrThrow(prisma, id));
  },
  async ledger(id: string, q: { page: number; pageSize: number }) {
    await findOrThrow(prisma, id);
    const where = { entitlementId: id };
    const [total, rows] = await prisma.$transaction([prisma.leaveLedger.count({ where }), prisma.leaveLedger.findMany({ where, include: { createdBy: { select: { id: true, email: true } } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (q.page - 1) * q.pageSize, take: q.pageSize })]);
    const data: LedgerEntryDto[] = rows.map((r) => ({ id: r.id, entryType: r.entryType, units: r.units, referenceType: r.referenceType, referenceId: r.referenceId, note: r.note, actor: r.createdBy, createdAt: r.createdAt.toISOString() }));
    return { data, meta: { page: q.page, pageSize: q.pageSize, total } };
  },
  async preview(input: { employeeId: string; leaveTypeId: string; periodStart: string }): Promise<EntitlementPreviewDto> {
    const r = await resolveForPeriod(prisma, input);
    return { policy: { id: r.policy.id, name: r.policy.name, annualUnits: r.policy.annualUnits, allowNegativeBalance: r.policy.allowNegativeBalance, carryForwardMaxUnits: r.policy.carryForwardMaxUnits, effectiveFrom: r.policy.effectiveFrom, effectiveTo: r.policy.effectiveTo }, employee: { id: r.employee.id, employeeCode: r.employee.employeeCode, firstName: r.employee.firstName, lastName: r.employee.lastName, employmentType: r.employee.employmentType, organization: r.employee.organization }, periodStart: input.periodStart };
  },

  /**
   * Generate: validate → overlap check → resolve policy AT periodStart → create entitlement → GRANT (annualUnits > 0)
   * → summary from ledger → audit. One transaction; the client sends no policy/units.
   */
  async generate(input: CreateEntitlementInput, actor: Actor): Promise<EntitlementDto> {
    const row = await prisma.$transaction(async (tx) => {
      const { employee, leaveType } = await loadEmployeeAndType(tx, input);
      const existing = await tx.leaveEntitlement.findMany({ where: { employeeId: employee.id, leaveTypeId: leaveType.id }, select: { id: true, periodStart: true, periodEnd: true } });
      const identical = existing.find((e) => e.periodStart === input.periodStart && e.periodEnd === input.periodEnd);
      if (identical) throw new AppError(409, 'ENTITLEMENT_ALREADY_EXISTS', `An entitlement for ${leaveType.code} ${input.periodStart} → ${input.periodEnd} already exists for ${employee.employeeCode}`);
      const overlap = existing.find((e) => compareBusinessDate(input.periodStart, e.periodEnd) <= 0 && compareBusinessDate(e.periodStart, input.periodEnd) <= 0);
      if (overlap) throw new AppError(409, 'ENTITLEMENT_PERIOD_OVERLAP', `Overlaps existing entitlement ${overlap.periodStart} → ${overlap.periodEnd} for ${leaveType.code}`);
      const policy = await leavePoliciesService.resolve(tx, { leaveTypeId: leaveType.id, organizationId: employee.organizationId, employmentType: employee.employmentType, asOfDate: input.periodStart });
      const created = await tx.leaveEntitlement.create({ data: { employeeId: employee.id, leaveTypeId: leaveType.id, policyId: policy.id, policyResolvedDate: input.periodStart, periodStart: input.periodStart, periodEnd: input.periodEnd, createdByUserId: actor.auth.userId } });
      // annualUnits = 0 → entitlement exists with an all-zero summary and no GRANT row (zero ledger rows are never written)
      if (policy.annualUnits > 0) await balanceService.grant(tx, created.id, policy.annualUnits, { operationKey: operationKeys.grant(created.id), actorUserId: actor.auth.userId, note: `Initial grant from policy ${policy.name}` });
      const after = await findOrThrow(tx, created.id);
      await auditService.log(audit(actor, 'GENERATE_LEAVE_ENTITLEMENT', created.id, undefined, { employeeId: employee.id, leaveTypeId: leaveType.id, policyId: policy.id, policyResolvedDate: input.periodStart, periodStart: input.periodStart, periodEnd: input.periodEnd, granted: after.granted }), tx);
      return after;
    });
    return toDto(row);
  },

  async adjust(id: string, input: AdjustEntitlementInput, actor: Actor): Promise<EntitlementDto> {
    const row = await prisma.$transaction(async (tx) => {
      const before = await findOrThrow(tx, id);
      const result = await balanceService.adjust(tx, id, input.units, { operationKey: `adj:${randomUUID()}`, actorUserId: actor.auth.userId, note: input.note });
      await auditService.log(audit(actor, 'ADJUST_LEAVE_ENTITLEMENT', id, { adjustment: before.adjustment, available: availableUnits(before) }, { units: input.units, noteLength: input.note?.length ?? 0, adjustment: result.summary.adjustment, available: result.available }), tx);
      return findOrThrow(tx, id);
    });
    return toDto(row);
  },

  /** Manual carry-forward into this entitlement (source period is not modelled yet — see README). Capped by the policy. */
  async carryForward(id: string, input: CarryForwardInput, actor: Actor): Promise<EntitlementDto> {
    const row = await prisma.$transaction(async (tx) => {
      const before = await findOrThrow(tx, id);
      const result = await balanceService.carryForward(tx, id, input.units, { operationKey: `cf:${randomUUID()}`, actorUserId: actor.auth.userId, note: input.note ?? null });
      await auditService.log(audit(actor, 'CARRY_FORWARD_LEAVE_ENTITLEMENT', id, { carriedForward: before.carriedForward }, { units: input.units, noteLength: input.note?.length ?? 0, carriedForward: result.summary.carriedForward, available: result.available }), tx);
      return findOrThrow(tx, id);
    });
    return toDto(row);
  },

  /** Purpose-built pickers (leave.manage_entitlements — no employees.view / leave.manage_types needed). */
  async employeeOptions(q: { search?: string; organizationId?: string; limit: number }): Promise<LeaveEmployeeOptionDto[]> {
    const terms = (q.search ?? '').split(/\s+/).filter(Boolean);
    return prisma.employee.findMany({
      where: { employmentStatus: 'ACTIVE', organizationId: q.organizationId, AND: terms.map((t) => ({ OR: [{ employeeCode: { contains: t, mode: 'insensitive' } }, { firstName: { contains: t, mode: 'insensitive' } }, { lastName: { contains: t, mode: 'insensitive' } }] })) },
      select: { id: true, employeeCode: true, firstName: true, lastName: true, employmentType: true, organization: { select: { id: true, code: true, name: true } }, department: { select: { id: true, code: true, name: true } } },
      orderBy: { employeeCode: 'asc' }, take: q.limit,
    });
  },
  async typeOptions(): Promise<LeaveTypeOptionDto[]> {
    return prisma.leaveType.findMany({ where: { isActive: true }, select: { id: true, code: true, name: true }, orderBy: { code: 'asc' } });
  },
};
