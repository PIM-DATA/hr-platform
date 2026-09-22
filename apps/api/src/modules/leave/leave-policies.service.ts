import type { Prisma } from '@prisma/client';
import {
  AUDIT_ACTIONS, EMPLOYMENT_TYPES, LEAVE_WORKFLOW, businessToday, compareBusinessDate,
  type CreateLeavePolicyInput, type LeavePolicyDto, type LeavePolicyListQuery, type LeaveWorkflowOptionDto, type UpdateLeavePolicyInput,
} from '@hr/shared';
import { prisma } from '../../lib/prisma';
import { AppError } from '../../lib/errors';
import { auditService, diffFields } from '../../services/audit/audit.service';
import type { Actor } from './leave-types.service';

type Db = Prisma.TransactionClient | typeof prisma;
const include = { leaveType: { select: { id: true, code: true, name: true, isActive: true } }, organization: { select: { id: true, code: true, name: true, isActive: true, timezone: true } } } satisfies Prisma.LeavePolicyInclude;
type Row = Prisma.LeavePolicyGetPayload<{ include: typeof include }>;

const toDto = (p: Row): LeavePolicyDto => ({
  id: p.id, name: p.name, leaveType: { id: p.leaveType.id, code: p.leaveType.code, name: p.leaveType.name },
  organization: p.organization ? { id: p.organization.id, code: p.organization.code, name: p.organization.name } : null, employmentType: p.employmentType,
  annualUnits: p.annualUnits, isPaid: p.isPaid, requiresReason: p.requiresReason, requiresAttachment: p.requiresAttachment, allowHalfDay: p.allowHalfDay, allowNegativeBalance: p.allowNegativeBalance,
  maxConsecutiveDays: p.maxConsecutiveDays, minNoticeDays: p.minNoticeDays, allowBackdate: p.allowBackdate, carryForwardMaxUnits: p.carryForwardMaxUnits, carryForwardExpiryMonths: p.carryForwardExpiryMonths,
  workflowDefinitionCode: p.workflowDefinitionCode, effectiveFrom: p.effectiveFrom, effectiveTo: p.effectiveTo, isActive: p.isActive, createdAt: p.createdAt.toISOString(), updatedAt: p.updatedAt.toISOString(),
});
const RULE_FIELDS = (p: Row) => ({
  name: p.name, leaveTypeId: p.leaveTypeId, organizationId: p.organizationId, employmentType: p.employmentType, annualUnits: p.annualUnits, isPaid: p.isPaid, requiresReason: p.requiresReason,
  requiresAttachment: p.requiresAttachment, allowHalfDay: p.allowHalfDay, allowNegativeBalance: p.allowNegativeBalance, maxConsecutiveDays: p.maxConsecutiveDays, minNoticeDays: p.minNoticeDays,
  allowBackdate: p.allowBackdate, carryForwardMaxUnits: p.carryForwardMaxUnits, carryForwardExpiryMonths: p.carryForwardExpiryMonths, workflowDefinitionCode: p.workflowDefinitionCode, effectiveFrom: p.effectiveFrom, effectiveTo: p.effectiveTo,
});
const audit = (a: Actor, action: keyof typeof AUDIT_ACTIONS, recordId: string, oldValue?: unknown, newValue?: unknown) => ({ userId: a.auth.userId, ipAddress: a.ipAddress, userAgent: a.userAgent, action: AUDIT_ACTIONS[action], module: 'leave', recordType: 'LeavePolicy', recordId, oldValue, newValue });

async function findOrThrow(db: Db, id: string) {
  const row = await db.leavePolicy.findUnique({ where: { id }, include });
  if (!row) throw new AppError(404, 'LEAVE_POLICY_NOT_FOUND', 'Leave policy not found');
  return row;
}

/** Inclusive ranges; null effectiveTo = open-ended. */
function rangesOverlap(aFrom: string, aTo: string | null, bFrom: string, bTo: string | null) {
  const aBeforeBEnds = bTo === null || compareBusinessDate(aFrom, bTo) <= 0;
  const bBeforeAEnds = aTo === null || compareBusinessDate(bFrom, aTo) <= 0;
  return aBeforeBEnds && bBeforeAEnds;
}

/**
 * Validation for an ACTIVE policy (run on activate and on update of an active policy):
 * dates, leave type active, organization active, employment type valid, no overlap with same-selector active
 * policies, and a workflow definition code that is active and compatible with leave/LEAVE_REQUEST.
 */
async function validateForActivation(db: Db, p: Row, exceptId: string) {
  if (p.effectiveTo && compareBusinessDate(p.effectiveTo, p.effectiveFrom) < 0) throw new AppError(400, 'POLICY_EFFECTIVE_DATE_INVALID', 'effectiveTo must be on or after effectiveFrom');
  if (!p.leaveType.isActive) throw new AppError(409, 'LEAVE_TYPE_INACTIVE', `Leave type ${p.leaveType.code} is inactive`);
  if (p.organization && !p.organization.isActive) throw new AppError(409, 'ORGANIZATION_INACTIVE', `Organization ${p.organization.code} is inactive`);
  if (p.employmentType && !(EMPLOYMENT_TYPES as readonly string[]).includes(p.employmentType)) throw new AppError(400, 'VALIDATION_ERROR', 'Invalid employment type');
  const sameSelector = await db.leavePolicy.findMany({ where: { id: { not: exceptId }, isActive: true, leaveTypeId: p.leaveTypeId, organizationId: p.organizationId, employmentType: p.employmentType }, select: { id: true, name: true, effectiveFrom: true, effectiveTo: true } });
  const clash = sameSelector.find((o) => rangesOverlap(p.effectiveFrom, p.effectiveTo, o.effectiveFrom, o.effectiveTo));
  if (clash) throw new AppError(409, 'LEAVE_POLICY_OVERLAP', `Overlaps active policy "${clash.name}" (${clash.effectiveFrom} → ${clash.effectiveTo ?? 'open'}) with the same leave type / organization / employment type selector`);
  if (!p.workflowDefinitionCode) throw new AppError(409, 'WORKFLOW_DEFINITION_NOT_FOUND', 'An active policy needs a workflow definition code');
  const def = await db.workflowDefinition.findFirst({ where: { code: p.workflowDefinitionCode, isActive: true } });
  if (!def) throw new AppError(409, 'WORKFLOW_DEFINITION_NOT_FOUND', `No active workflow definition ${p.workflowDefinitionCode}`);
  if (def.module !== LEAVE_WORKFLOW.module || def.entityType !== LEAVE_WORKFLOW.entityType) throw new AppError(409, 'WORKFLOW_DEFINITION_INCOMPATIBLE', `${def.code} is for ${def.module}/${def.entityType}, expected ${LEAVE_WORKFLOW.module}/${LEAVE_WORKFLOW.entityType}`);
}

export const leavePoliciesService = {
  async list(q: LeavePolicyListQuery) {
    const where: Prisma.LeavePolicyWhereInput = { leaveTypeId: q.leaveTypeId, organizationId: q.organizationId, isActive: q.status ? q.status === 'active' : undefined };
    if (q.search) where.name = { contains: q.search };
    const [total, rows] = await prisma.$transaction([prisma.leavePolicy.count({ where }), prisma.leavePolicy.findMany({ where, include, orderBy: [{ leaveTypeId: 'asc' }, { effectiveFrom: 'desc' }], skip: (q.page - 1) * q.pageSize, take: q.pageSize })]);
    return { data: rows.map(toDto), meta: { page: q.page, pageSize: q.pageSize, total } };
  },
  async getById(id: string) {
    return toDto(await findOrThrow(prisma, id));
  },

  /** Creates an INACTIVE policy (activation runs the full validation). Basic referential checks only. */
  async create(input: CreateLeavePolicyInput, actor: Actor) {
    const row = await prisma.$transaction(async (tx) => {
      if (!(await tx.leaveType.findUnique({ where: { id: input.leaveTypeId } }))) throw new AppError(404, 'LEAVE_TYPE_NOT_FOUND', 'Leave type not found');
      if (input.organizationId && !(await tx.organization.findUnique({ where: { id: input.organizationId } }))) throw new AppError(404, 'ORGANIZATION_NOT_FOUND', 'Organization not found');
      if (input.effectiveTo && compareBusinessDate(input.effectiveTo, input.effectiveFrom) < 0) throw new AppError(400, 'POLICY_EFFECTIVE_DATE_INVALID', 'effectiveTo must be on or after effectiveFrom');
      const created = await tx.leavePolicy.create({
        data: { ...input, organizationId: input.organizationId ?? null, employmentType: input.employmentType ?? null, maxConsecutiveDays: input.maxConsecutiveDays ?? null, minNoticeDays: input.minNoticeDays ?? null, carryForwardExpiryMonths: input.carryForwardExpiryMonths ?? null, workflowDefinitionCode: input.workflowDefinitionCode ?? null, effectiveTo: input.effectiveTo ?? null, createdBy: actor.auth.userId, updatedBy: actor.auth.userId },
        include,
      });
      await auditService.log(audit(actor, 'CREATE_LEAVE_POLICY', created.id, undefined, RULE_FIELDS(created)), tx);
      return created;
    });
    return toDto(row);
  },

  /**
   * Rule edits on an ACTIVE policy are re-validated (overlap/workflow/type/org). Field diff is audited.
   * Once entitlements reference the policy, rule/selector fields are frozen (LEAVE_POLICY_IN_USE); `name`/`description`
   * stay editable and `effectiveTo` may only be set on/after the latest policyResolvedDate (to close an open-ended policy).
   */
  async update(id: string, input: UpdateLeavePolicyInput, actor: Actor) {
    const row = await prisma.$transaction(async (tx) => {
      const before = await findOrThrow(tx, id);
      const refs = await tx.leaveEntitlement.aggregate({ where: { policyId: id }, _count: { _all: true }, _max: { policyResolvedDate: true } });
      if (refs._count._all > 0) {
        const changed = (Object.keys(input) as (keyof UpdateLeavePolicyInput)[]).filter((k) => input[k] !== undefined && JSON.stringify(input[k] ?? null) !== JSON.stringify((before as Record<string, unknown>)[k] ?? null));
        const frozen = changed.filter((k) => !['name', 'effectiveTo'].includes(k));
        if (frozen.length) throw new AppError(409, 'LEAVE_POLICY_IN_USE', `Policy is referenced by ${refs._count._all} entitlement(s); ${frozen.join(', ')} cannot change. Close this policy (effectiveTo) and create a new one instead.`);
        if (changed.includes('effectiveTo') && input.effectiveTo && refs._max.policyResolvedDate && compareBusinessDate(input.effectiveTo, refs._max.policyResolvedDate) < 0) {
          throw new AppError(409, 'LEAVE_POLICY_IN_USE', `effectiveTo cannot be before ${refs._max.policyResolvedDate}, the latest date an entitlement resolved this policy`);
        }
      }
      if (input.leaveTypeId && !(await tx.leaveType.findUnique({ where: { id: input.leaveTypeId } }))) throw new AppError(404, 'LEAVE_TYPE_NOT_FOUND', 'Leave type not found');
      if (input.organizationId && !(await tx.organization.findUnique({ where: { id: input.organizationId } }))) throw new AppError(404, 'ORGANIZATION_NOT_FOUND', 'Organization not found');
      const data: Prisma.LeavePolicyUpdateInput = { ...input, updatedBy: actor.auth.userId } as Prisma.LeavePolicyUpdateInput;
      const after = await tx.leavePolicy.update({ where: { id }, data, include });
      if (after.effectiveTo && compareBusinessDate(after.effectiveTo, after.effectiveFrom) < 0) throw new AppError(400, 'POLICY_EFFECTIVE_DATE_INVALID', 'effectiveTo must be on or after effectiveFrom');
      if (after.isActive) await validateForActivation(tx, after, id);
      const diff = diffFields(RULE_FIELDS(before), RULE_FIELDS(after));
      if (Object.keys(diff.new).length) await auditService.log(audit(actor, 'UPDATE_LEAVE_POLICY', id, diff.old, diff.new), tx);
      return after;
    });
    return toDto(row);
  },

  async activate(id: string, actor: Actor) {
    const row = await prisma.$transaction(async (tx) => {
      const before = await findOrThrow(tx, id);
      if (before.isActive) return before;
      await validateForActivation(tx, before, id);
      const after = await tx.leavePolicy.update({ where: { id }, data: { isActive: true, updatedBy: actor.auth.userId }, include });
      await auditService.log(audit(actor, 'ACTIVATE_LEAVE_POLICY', id, { isActive: false }, { isActive: true }), tx);
      return after;
    });
    return toDto(row);
  },
  async deactivate(id: string, actor: Actor) {
    const row = await prisma.$transaction(async (tx) => {
      const before = await findOrThrow(tx, id);
      if (!before.isActive) return before;
      const after = await tx.leavePolicy.update({ where: { id }, data: { isActive: false, updatedBy: actor.auth.userId }, include });
      await auditService.log(audit(actor, 'DEACTIVATE_LEAVE_POLICY', id, { isActive: true }, { isActive: false }), tx);
      return after;
    });
    return toDto(row);
  },

  /**
   * Deterministic resolver. Loads only ACTIVE candidates of the leave type that are effective on `asOfDate`
   * and whose selectors are either the employee's values or ANY (null), then ranks:
   *   1 org+type · 2 org+any · 3 any+type · 4 global. Ties inside a rank are impossible for valid data
   * (overlap guard) but are broken by newest effectiveFrom then id for determinism.
   */
  async resolve(db: Db, input: { leaveTypeId: string; organizationId: string; employmentType: string; asOfDate: string }): Promise<Row> {
    const candidates = await db.leavePolicy.findMany({
      where: {
        leaveTypeId: input.leaveTypeId, isActive: true,
        effectiveFrom: { lte: input.asOfDate }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: input.asOfDate } }],
        AND: [{ OR: [{ organizationId: input.organizationId }, { organizationId: null }] }, { OR: [{ employmentType: input.employmentType }, { employmentType: null }] }],
      },
      include,
    });
    const rank = (p: Row) => (p.organizationId ? 0 : 2) + (p.employmentType ? 0 : 1);
    candidates.sort((a, b) => rank(a) - rank(b) || compareBusinessDate(b.effectiveFrom, a.effectiveFrom) || a.id.localeCompare(b.id));
    if (!candidates[0]) throw new AppError(404, 'LEAVE_POLICY_NOT_FOUND', 'No leave policy applies to this employee, leave type and date');
    return candidates[0];
  },

  /** Admin preview: resolves for an employee (backend derives org/employment type; asOfDate defaults to the org's business today). */
  async resolveForEmployee(input: { employeeId: string; leaveTypeId: string; asOfDate?: string }) {
    const emp = await prisma.employee.findUnique({ where: { id: input.employeeId }, select: { organizationId: true, employmentType: true, organization: { select: { timezone: true } } } });
    if (!emp) throw new AppError(404, 'EMPLOYEE_NOT_FOUND', 'Employee not found');
    const asOfDate = input.asOfDate ?? businessToday(emp.organization.timezone);
    return { asOfDate, policy: toDto(await leavePoliciesService.resolve(prisma, { leaveTypeId: input.leaveTypeId, organizationId: emp.organizationId, employmentType: emp.employmentType, asOfDate })) };
  },

  /** Active, compatible workflow definitions for the policy picker (leave.manage_policies — no workflow admin needed). */
  async workflowOptions(search?: string): Promise<LeaveWorkflowOptionDto[]> {
    const rows = await prisma.workflowDefinition.findMany({
      where: { isActive: true, module: LEAVE_WORKFLOW.module, entityType: LEAVE_WORKFLOW.entityType, ...(search ? { OR: [{ code: { contains: search.toUpperCase() } }, { name: { contains: search } }] } : {}) },
      select: { code: true, name: true, version: true, steps: { orderBy: { stepOrder: 'asc' }, select: { stepOrder: true, name: true, approverType: true } } },
      orderBy: { code: 'asc' },
    });
    return rows;
  },
};
