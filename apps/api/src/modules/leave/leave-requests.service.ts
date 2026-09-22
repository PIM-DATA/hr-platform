import type { Prisma } from '@prisma/client';
import {
  AUDIT_ACTIONS, LEAVE_BLOCKING_STATUSES, LEAVE_REQUEST_STATUS as ST, LEAVE_WORKFLOW, PERMISSIONS, addDays, availableUnits, businessToday, calculateLeaveUnits, compareBusinessDate, leaveSpansOverlap, operationKeys,
  type LeaveRequestBody, type LeaveRequestDetailDto, type LeaveRequestDto, type LeaveRequestListQuery, type LeaveRequestPreviewDto, type LeaveWorkflowTimelineDto, type MyBalanceDto, type UpdateLeaveRequestInput,
} from '@hr/shared';
import { prisma } from '../../lib/prisma';
import { AppError } from '../../lib/errors';
import { auditService } from '../../services/audit/audit.service';
import { hasPermission } from '../../services/authorization/authorization.service';
import { workflowEngine } from '../../services/workflow';
import type { AuthContext } from '../auth/auth.types';
import { employeeScopeWhere } from '../employees/employees.scope';
import { calendarsService } from '../calendar/calendars.service';
import type { Actor } from './leave-types.service';
import { leavePoliciesService } from './leave-policies.service';
import { balanceService, type Tx } from './balance.service';

/**
 * Leave request lifecycle: DRAFT → PENDING → APPROVED | REJECTED | CANCELLED.
 *
 * Authorization contexts (kept apart on purpose):
 *   A. browse   = leave.view + employeeScopeWhere (SELF / TEAM / ALL)
 *   B. self-service mutation = leave.request, only for auth.employeeId — even an ALL-scope user cannot act for others
 *   C. approval = workflow.approve + snapshot approver identity (generic /workflow/instances/:id/actions), no data scope
 *
 * Snapshots at SUBMIT (never recalculated afterwards): entitlement, REQUEST policy (resolved from the employee's current
 * org/employment type at startDate — may differ from the entitlement's grant policy), calendar + units, org/dept/position.
 *
 * Lock order (submit): leave_request row → employee row → entitlement row (BalanceService) → workflow submit.
 * Lock order (approve / reject / cancel-pending): workflow_instance row → leave_request row → entitlement row.
 * A path must never lock these in a different order.
 */
type Db = Tx | typeof prisma;
type Parts = { startPart: 'FULL' | 'PM'; endPart: 'FULL' | 'AM' };
type Dates = { startDate: string; endDate: string } & Parts;

const include = { employee: { select: { id: true, employeeCode: true, firstName: true, lastName: true } }, leaveType: { select: { id: true, code: true, name: true } }, policy: { select: { id: true, name: true } } } satisfies Prisma.LeaveRequestInclude;
type Row = Prisma.LeaveRequestGetPayload<{ include: typeof include }>;

export function toDto(r: Row): LeaveRequestDto {
  return {
    id: r.id, employee: r.employee, leaveType: r.leaveType, startDate: r.startDate, endDate: r.endDate, startPart: r.startPart as 'FULL' | 'PM', endPart: r.endPart as 'FULL' | 'AM', units: r.units,
    reason: r.reason, attachmentRef: r.attachmentRef, status: r.status, entitlementId: r.entitlementId, policy: r.policy, calendarId: r.calendarId,
    organizationId: r.organizationId, departmentId: r.departmentId, positionId: r.positionId, workflowInstanceId: r.workflowInstanceId,
    submittedAt: r.submittedAt?.toISOString() ?? null, approvedAt: r.approvedAt?.toISOString() ?? null, rejectedAt: r.rejectedAt?.toISOString() ?? null, cancelledAt: r.cancelledAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(),
  };
}

const audit = (a: Actor, action: keyof typeof AUDIT_ACTIONS, recordId: string, oldValue?: unknown, newValue?: unknown) =>
  ({ userId: a.auth.userId, ipAddress: a.ipAddress, userAgent: a.userAgent, action: AUDIT_ACTIONS[action], module: 'leave', recordType: 'LeaveRequest', recordId, oldValue, newValue });
const snapshotOf = (r: Row) => ({ status: r.status, units: r.units, entitlementId: r.entitlementId, policyId: r.policyId, calendarId: r.calendarId, workflowInstanceId: r.workflowInstanceId });
const notFound = () => new AppError(404, 'LEAVE_REQUEST_NOT_FOUND', 'Leave request not found');

/** The requester's employee profile (self-service context B). */
async function requireEmployee(db: Db, auth: AuthContext) {
  if (!auth.employeeId) throw new AppError(403, 'EMPLOYEE_PROFILE_REQUIRED', 'Your account is not linked to an employee profile');
  const emp = await db.employee.findUnique({ where: { id: auth.employeeId }, select: { id: true, employmentStatus: true, employmentType: true, organizationId: true, departmentId: true, positionId: true, organization: { select: { timezone: true } } } });
  if (!emp) throw new AppError(403, 'EMPLOYEE_PROFILE_REQUIRED', 'Your account is not linked to an employee profile');
  if (emp.employmentStatus !== 'ACTIVE') throw new AppError(409, 'EMPLOYEE_INACTIVE', 'Only active employees can request leave');
  if (!emp.organizationId || !emp.departmentId || !emp.positionId) throw new AppError(409, 'LEAVE_ASSIGNMENT_REQUIRED', 'Employee has no current organization assignment');
  return emp;
}
type Emp = Awaited<ReturnType<typeof requireEmployee>>;

/** The single place a request is loaded for mutation: PostgreSQL row lock first, then the fresh row. */
export async function loadLeaveRequestForMutation(tx: Tx, id: string) {
  await tx.$queryRaw`SELECT "id" FROM "leave_requests" WHERE "id" = ${id} FOR UPDATE`;
  const row = await tx.leaveRequest.findUnique({ where: { id }, include });
  if (!row) throw notFound();
  return row;
}
/** Serialises every leave submission of ONE employee (overlap across leave types uses different entitlement rows). */
async function lockEmployee(tx: Tx, employeeId: string) {
  await tx.$queryRaw`SELECT "id" FROM "employees" WHERE "id" = ${employeeId} FOR UPDATE`;
}

// ---------- draft-level context: leave type, calendar, units ----------
async function draftContext(db: Db, emp: Emp, d: Dates & { leaveTypeId: string }) {
  const leaveType = await db.leaveType.findUnique({ where: { id: d.leaveTypeId }, select: { id: true, code: true, name: true, isActive: true } });
  if (!leaveType) throw new AppError(404, 'LEAVE_TYPE_NOT_FOUND', 'Leave type not found');
  if (!leaveType.isActive) throw new AppError(409, 'LEAVE_TYPE_INACTIVE', 'Leave type is inactive');
  const cal = await calendarsService.effectiveForOrganization(db, emp.organizationId);
  if (!cal) throw new AppError(409, 'WORK_CALENDAR_NOT_CONFIGURED', 'The employee organization has no active default work calendar');
  const calc = calculateLeaveUnits({ calendar: cal, startDate: d.startDate, endDate: d.endDate, startPart: d.startPart, endPart: d.endPart });
  if (!calc.ok) {
    if (calc.code === 'INVALID_DATE_RANGE') throw new AppError(400, 'INVALID_DATE_RANGE', 'startDate must be on or before endDate');
    throw new AppError(400, 'LEAVE_HALF_DAY_INVALID', calc.code === 'INVALID_HALF_DAY_BOUNDARY' ? 'A same-day PM start and AM end is not a valid half-day' : 'A half-day boundary must fall on a working day');
  }
  return { leaveType, calendar: cal, units: calc.units, workingDays: calc.workingDays };
}

// ---------- submit-level context: entitlement, request policy, workflow, rules ----------
async function findEntitlement(db: Db, employeeId: string, leaveTypeId: string, d: Dates) {
  const containing = await db.leaveEntitlement.findFirst({ where: { employeeId, leaveTypeId, periodStart: { lte: d.startDate }, periodEnd: { gte: d.endDate } } });
  if (containing) return containing;
  const touching = await db.leaveEntitlement.count({ where: { employeeId, leaveTypeId, OR: [{ periodStart: { lte: d.startDate }, periodEnd: { gte: d.startDate } }, { periodStart: { lte: d.endDate }, periodEnd: { gte: d.endDate } }] } });
  if (touching > 0) throw new AppError(409, 'LEAVE_CROSSES_ENTITLEMENT_PERIOD', 'The request must fall within one entitlement period');
  throw new AppError(409, 'LEAVE_ENTITLEMENT_NOT_FOUND', 'No leave entitlement covers these dates');
}

async function requestPolicy(db: Db, emp: Emp, leaveTypeId: string, d: Dates) {
  const base = { leaveTypeId, organizationId: emp.organizationId, employmentType: emp.employmentType };
  const [atStart, atEnd] = await Promise.all([leavePoliciesService.resolve(db, { ...base, asOfDate: d.startDate }), leavePoliciesService.resolve(db, { ...base, asOfDate: d.endDate })]);
  if (atStart.id !== atEnd.id) throw new AppError(409, 'LEAVE_CROSSES_POLICY_PERIOD', 'Start and end dates resolve to different leave policies');
  return atStart;
}

type Policy = Awaited<ReturnType<typeof requestPolicy>>;
function enforceRules(policy: Policy, d: Dates & { reason?: string | null; attachmentRef?: string | null }, units: number, today: string) {
  if (units <= 0) throw new AppError(409, 'LEAVE_UNITS_ZERO', 'The selected dates contain no working days');
  if (policy.requiresReason && !d.reason?.trim()) throw new AppError(409, 'LEAVE_REASON_REQUIRED', 'This leave type requires a reason');
  if (policy.requiresAttachment && !d.attachmentRef?.trim()) throw new AppError(409, 'LEAVE_ATTACHMENT_REQUIRED', 'This leave type requires an attachment');
  if (!policy.allowHalfDay && (d.startPart !== 'FULL' || d.endPart !== 'FULL')) throw new AppError(409, 'LEAVE_HALF_DAY_NOT_ALLOWED', 'Half-day leave is not allowed by the policy');
  if (!policy.allowBackdate && compareBusinessDate(d.startDate, today) < 0) throw new AppError(409, 'LEAVE_BACKDATE_NOT_ALLOWED', `Leave cannot start before today (${today})`);
  if (policy.minNoticeDays && compareBusinessDate(d.startDate, addDays(today, policy.minNoticeDays)) < 0) throw new AppError(409, 'LEAVE_NOTICE_NOT_MET', `This leave type needs at least ${policy.minNoticeDays} day(s) notice`);
  if (policy.maxConsecutiveDays && units > policy.maxConsecutiveDays) throw new AppError(409, 'LEAVE_MAX_CONSECUTIVE_EXCEEDED', `At most ${policy.maxConsecutiveDays} consecutive day(s) allowed`);
}

/** Overlap re-check: DB narrows by date range and blocking status, the shared half-day helper decides. */
async function assertNoOverlap(db: Db, employeeId: string, d: Dates, excludeId?: string) {
  const candidates = await db.leaveRequest.findMany({
    where: { employeeId, status: { in: [...LEAVE_BLOCKING_STATUSES] }, startDate: { lte: d.endDate }, endDate: { gte: d.startDate }, ...(excludeId ? { id: { not: excludeId } } : {}) },
    select: { id: true, startDate: true, endDate: true, startPart: true, endPart: true, leaveType: { select: { code: true } } },
  });
  const hit = candidates.find((c) => leaveSpansOverlap(d, { startDate: c.startDate, endDate: c.endDate, startPart: c.startPart as 'FULL' | 'PM', endPart: c.endPart as 'FULL' | 'AM' }));
  if (hit) throw new AppError(409, 'LEAVE_REQUEST_OVERLAP', `Overlaps an existing ${hit.leaveType.code} request (${hit.startDate} → ${hit.endDate})`, [{ field: 'startDate', message: hit.id }]);
}

async function fullContext(db: Db, emp: Emp, body: LeaveRequestBody, excludeId?: string) {
  const draft = await draftContext(db, emp, body);
  const entitlement = await findEntitlement(db, emp.id, body.leaveTypeId, body);
  const policy = await requestPolicy(db, emp, body.leaveTypeId, body);
  if (!policy.workflowDefinitionCode) throw new AppError(409, 'WORKFLOW_DEFINITION_NOT_ACTIVE', 'The leave policy has no workflow definition');
  const workflow = await db.workflowDefinition.findFirst({ where: { code: policy.workflowDefinitionCode, isActive: true, module: LEAVE_WORKFLOW.module, entityType: LEAVE_WORKFLOW.entityType }, select: { code: true, name: true } });
  if (!workflow) throw new AppError(409, 'WORKFLOW_DEFINITION_NOT_ACTIVE', `No active leave workflow for ${policy.workflowDefinitionCode}`);
  enforceRules(policy, body, draft.units, businessToday(emp.organization.timezone));
  await assertNoOverlap(db, emp.id, body, excludeId);
  return { ...draft, entitlement, policy, workflow };
}

const ownedDraft = (row: Row, auth: AuthContext) => {
  if (row.employeeId !== auth.employeeId) throw notFound(); // never confirm existence of another employee's request
  if (row.status !== ST.DRAFT) throw new AppError(409, 'LEAVE_REQUEST_NOT_DRAFT', `Request is ${row.status}; only drafts can be edited`);
};

export const leaveRequestsService = {
  /** Read-only: identical validation to submit (entitlement, policy, rules, overlap) — no ledger, workflow or audit writes. */
  async preview(auth: AuthContext, body: LeaveRequestBody): Promise<LeaveRequestPreviewDto> {
    const emp = await requireEmployee(prisma, auth);
    const c = await fullContext(prisma, emp, body);
    const cal = await prisma.workCalendar.findUniqueOrThrow({ where: { id: c.calendar.calendarId }, select: { id: true, name: true } });
    const available = availableUnits(c.entitlement);
    return {
      leaveType: c.leaveType, units: c.units, workingDays: c.workingDays,
      entitlement: { id: c.entitlement.id, periodStart: c.entitlement.periodStart, periodEnd: c.entitlement.periodEnd, available },
      policy: { id: c.policy.id, name: c.policy.name, allowHalfDay: c.policy.allowHalfDay, allowNegativeBalance: c.policy.allowNegativeBalance, requiresReason: c.policy.requiresReason, requiresAttachment: c.policy.requiresAttachment, minNoticeDays: c.policy.minNoticeDays, maxConsecutiveDays: c.policy.maxConsecutiveDays, allowBackdate: c.policy.allowBackdate },
      calendar: cal, remainingAfter: available - c.units, workflow: c.workflow,
    };
  },

  /** Draft: leave type / dates / calendar / units validated; entitlement, policy rules and overlap are enforced at submit. */
  async create(auth: AuthContext, body: LeaveRequestBody, actor: Actor): Promise<LeaveRequestDto> {
    const emp = await requireEmployee(prisma, auth);
    const row = await prisma.$transaction(async (tx) => {
      const c = await draftContext(tx, emp, body);
      const created = await tx.leaveRequest.create({ data: { employeeId: emp.id, leaveTypeId: body.leaveTypeId, startDate: body.startDate, endDate: body.endDate, startPart: body.startPart, endPart: body.endPart, units: c.units, reason: body.reason ?? null, attachmentRef: body.attachmentRef ?? null, status: ST.DRAFT, createdByUserId: auth.userId }, include });
      await auditService.log(audit(actor, 'CREATE_LEAVE_REQUEST', created.id, undefined, { leaveTypeId: body.leaveTypeId, startDate: body.startDate, endDate: body.endDate, startPart: body.startPart, endPart: body.endPart, units: c.units }), tx);
      return created;
    });
    return toDto(row);
  },

  async update(auth: AuthContext, id: string, input: UpdateLeaveRequestInput, actor: Actor): Promise<LeaveRequestDto> {
    const emp = await requireEmployee(prisma, auth);
    const row = await prisma.$transaction(async (tx) => {
      const before = await loadLeaveRequestForMutation(tx, id);
      ownedDraft(before, auth);
      const merged = { leaveTypeId: input.leaveTypeId ?? before.leaveTypeId, startDate: input.startDate ?? before.startDate, endDate: input.endDate ?? before.endDate, startPart: input.startPart ?? (before.startPart as 'FULL' | 'PM'), endPart: input.endPart ?? (before.endPart as 'FULL' | 'AM') };
      if (compareBusinessDate(merged.startDate, merged.endDate) > 0) throw new AppError(400, 'INVALID_DATE_RANGE', 'startDate must be on or before endDate');
      const c = await draftContext(tx, emp, merged);
      const after = await tx.leaveRequest.update({ where: { id }, data: { ...merged, units: c.units, reason: input.reason === undefined ? before.reason : input.reason, attachmentRef: input.attachmentRef === undefined ? before.attachmentRef : input.attachmentRef }, include });
      await auditService.log(audit(actor, 'UPDATE_LEAVE_REQUEST', id, { ...pick(before), units: before.units }, { ...pick(after), units: after.units }), tx);
      return after;
    });
    return toDto(row);
  },

  /**
   * DRAFT → PENDING in ONE transaction: lock request → lock employee → revalidate everything → reserve (locks entitlement)
   * → snapshot + PENDING → workflow submit (may auto-approve through the leave handler) → store instance id → audit.
   * Idempotent: a request that is already PENDING/APPROVED with an instance returns its current state (no second reserve/workflow).
   */
  async submit(auth: AuthContext, id: string, actor: Actor): Promise<LeaveRequestDto> {
    const emp = await requireEmployee(prisma, auth);
    const row = await prisma.$transaction(async (tx) => {
      const req = await loadLeaveRequestForMutation(tx, id);
      if (req.employeeId !== emp.id) throw notFound();
      if ((req.status === ST.PENDING || req.status === ST.APPROVED) && req.workflowInstanceId) return req; // retry / concurrent submit
      if (req.status !== ST.DRAFT) throw new AppError(409, 'LEAVE_REQUEST_NOT_DRAFT', `Request is ${req.status} and cannot be submitted`);
      await lockEmployee(tx, emp.id);
      const body: LeaveRequestBody = { leaveTypeId: req.leaveTypeId, startDate: req.startDate, endDate: req.endDate, startPart: req.startPart as 'FULL' | 'PM', endPart: req.endPart as 'FULL' | 'AM', reason: req.reason, attachmentRef: req.attachmentRef };
      const c = await fullContext(tx, emp, body, req.id);
      await balanceService.reserve(tx, c.entitlement.id, c.units, { operationKey: operationKeys.leave(req.id, 'reserve'), actorUserId: auth.userId, referenceType: 'LeaveRequest', referenceId: req.id, balancePolicyId: c.policy.id });
      const now = new Date();
      // snapshots + PENDING must be committed-in-tx BEFORE the workflow runs: an auto-approved workflow calls onApproved immediately
      await tx.leaveRequest.update({ where: { id }, data: { status: ST.PENDING, submittedAt: now, units: c.units, entitlementId: c.entitlement.id, policyId: c.policy.id, calendarId: c.calendar.calendarId, organizationId: emp.organizationId, departmentId: emp.departmentId, positionId: emp.positionId } });
      const instance = await workflowEngine.submit({ definitionCode: c.workflow.code, module: LEAVE_WORKFLOW.module, entityType: LEAVE_WORKFLOW.entityType, entityId: req.id, requesterEmployeeId: emp.id }, actor, tx);
      // only the instance id — never touch status here (the handler may already have set APPROVED)
      const after = await tx.leaveRequest.update({ where: { id }, data: { workflowInstanceId: instance.id }, include });
      await auditService.log(audit(actor, 'SUBMIT_LEAVE_REQUEST', id, snapshotOf(req), { ...snapshotOf(after), workflowStatus: instance.status }), tx);
      return after;
    });
    return toDto(row);
  },

  /**
   * Requester cancel. DRAFT → CANCELLED directly. PENDING → internal workflowEngine.cancel (lock order instance → request →
   * entitlement; the leave onCancelled handler releases the reservation and sets the status). APPROVED is not cancellable
   * in Phase 2 (approved-leave cancellation workflow = backlog); REJECTED/CANCELLED → LEAVE_REQUEST_NOT_CANCELLABLE.
   */
  async cancel(auth: AuthContext, id: string, actor: Actor): Promise<LeaveRequestDto> {
    const emp = await requireEmployee(prisma, auth);
    const peek = await prisma.leaveRequest.findUnique({ where: { id }, select: { employeeId: true, status: true, workflowInstanceId: true } });
    if (!peek || peek.employeeId !== emp.id) throw notFound();
    const row = await prisma.$transaction(async (tx) => {
      if (peek.status === ST.PENDING && peek.workflowInstanceId) {
        // → onCancelled → release + CANCELLED + audit. Losing the race to a final approval surfaces as NOT_CANCELLABLE.
        await workflowEngine.cancel(peek.workflowInstanceId, actor, tx, 'Cancelled by requester').catch((e: unknown) => {
          if (e instanceof AppError && e.code === 'WORKFLOW_NOT_PENDING') throw new AppError(409, 'LEAVE_REQUEST_NOT_CANCELLABLE', 'Request is no longer pending');
          throw e;
        });
        const after = await tx.leaveRequest.findUniqueOrThrow({ where: { id }, include });
        if (after.status !== ST.CANCELLED) throw new AppError(409, 'LEAVE_REQUEST_NOT_CANCELLABLE', `Request is ${after.status}`);
        return after;
      }
      const req = await loadLeaveRequestForMutation(tx, id);
      if (req.status !== ST.DRAFT) throw new AppError(409, 'LEAVE_REQUEST_NOT_CANCELLABLE', req.status === ST.APPROVED ? 'Approved leave cannot be cancelled here (not supported in this phase)' : `Request is ${req.status}`);
      const after = await tx.leaveRequest.update({ where: { id }, data: { status: ST.CANCELLED, cancelledAt: new Date() }, include });
      await auditService.log(audit(actor, 'CANCEL_LEAVE_REQUEST', id, { status: req.status }, { status: after.status, fromDraft: true }), tx);
      return after;
    });
    return toDto(row);
  },

  // ---------- reads ----------
  async list(auth: AuthContext, q: LeaveRequestListQuery): Promise<{ data: LeaveRequestDto[]; meta: { page: number; pageSize: number; total: number } }> {
    // every filter is AND-ed: a spread would let a filter's `OR`/`id` key silently replace the data-scope clause
    const and: Prisma.LeaveRequestWhereInput[] = [{ employee: employeeScopeWhere(auth) }];
    if (q.employeeId) and.push({ employeeId: q.employeeId });
    if (q.status) and.push({ status: q.status });
    if (q.leaveTypeId) and.push({ leaveTypeId: q.leaveTypeId });
    if (q.organizationId) and.push({ OR: [{ organizationId: q.organizationId }, { organizationId: null, employee: { organizationId: q.organizationId } }] });
    if (q.departmentId) and.push({ OR: [{ departmentId: q.departmentId }, { departmentId: null, employee: { departmentId: q.departmentId } }] });
    if (q.from) and.push({ endDate: { gte: q.from } });
    if (q.to) and.push({ startDate: { lte: q.to } });
    if (q.search) and.push({ employee: { OR: [{ employeeCode: { contains: q.search, mode: 'insensitive' } }, { firstName: { contains: q.search, mode: 'insensitive' } }, { lastName: { contains: q.search, mode: 'insensitive' } }] } });
    const where: Prisma.LeaveRequestWhereInput = { AND: and };
    const [total, rows] = await prisma.$transaction([prisma.leaveRequest.count({ where }), prisma.leaveRequest.findMany({ where, include, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (q.page - 1) * q.pageSize, take: q.pageSize })]);
    return { data: rows.map(toDto), meta: { page: q.page, pageSize: q.pageSize, total } };
  },

  /** A: leave.view + scope, or C: workflow.approve + snapshot approver of this request's workflow. Otherwise 404 (no existence leak). */
  async getById(auth: AuthContext, id: string): Promise<LeaveRequestDetailDto> {
    const row = await prisma.leaveRequest.findUnique({ where: { id }, include });
    if (!row) throw notFound();
    const wf = row.workflowInstanceId ? await prisma.workflowInstance.findUnique({ where: { id: row.workflowInstanceId }, include: { steps: { orderBy: { stepOrder: 'asc' }, include: { approverUser: { select: { id: true, email: true } }, approverEmployee: { select: { id: true, employeeCode: true, firstName: true, lastName: true } } } }, actions: { orderBy: { createdAt: 'asc' }, include: { actor: { select: { id: true, email: true } } } } } }) : null;
    const inScope = hasPermission(auth, PERMISSIONS.LEAVE_VIEW) && (await prisma.employee.count({ where: { AND: [{ id: row.employeeId }, employeeScopeWhere(auth)] } })) > 0;
    const isApprover = hasPermission(auth, PERMISSIONS.WORKFLOW_APPROVE) && !!wf && wf.steps.some((s) => s.approverUserId === auth.userId);
    if (!inScope && !isApprover) throw notFound();
    const ent = row.entitlementId ? await prisma.leaveEntitlement.findUnique({ where: { id: row.entitlementId } }) : null;
    const timeline: LeaveWorkflowTimelineDto | null = wf ? {
      id: wf.id, status: wf.status, currentStepOrder: wf.currentStepOrder,
      steps: wf.steps.map((s) => ({ stepOrder: s.stepOrder, name: s.name, approverType: s.approverType, approver: s.approverUser, approverEmployee: s.approverEmployee, status: s.status, skipReason: s.skipReason, actedAt: s.actedAt?.toISOString() ?? null, comment: s.comment })),
      actions: wf.actions.map((a) => ({ stepOrder: a.stepOrder, action: a.action, actor: a.actor, comment: a.comment, createdAt: a.createdAt.toISOString() })),
    } : null;
    return { ...toDto(row), balance: ent ? { granted: ent.granted, carriedForward: ent.carriedForward, adjustment: ent.adjustment, reserved: ent.reserved, used: ent.used, available: availableUnits(ent), periodStart: ent.periodStart, periodEnd: ent.periodEnd } : null, workflow: timeline };
  },

  /** My entitlements whose period covers asOfDate (default: business today in my organization's timezone). */
  async balancesMe(auth: AuthContext, asOfDate?: string): Promise<{ asOfDate: string; data: MyBalanceDto[] }> {
    if (!auth.employeeId) throw new AppError(403, 'EMPLOYEE_PROFILE_REQUIRED', 'Your account is not linked to an employee profile');
    const emp = await prisma.employee.findUnique({ where: { id: auth.employeeId }, select: { organization: { select: { timezone: true } } } });
    if (!emp) throw new AppError(403, 'EMPLOYEE_PROFILE_REQUIRED', 'Your account is not linked to an employee profile');
    const asOf = asOfDate ?? businessToday(emp.organization.timezone);
    const rows = await prisma.leaveEntitlement.findMany({ where: { employeeId: auth.employeeId, periodStart: { lte: asOf }, periodEnd: { gte: asOf } }, include: { leaveType: { select: { id: true, code: true, name: true } } }, orderBy: { leaveType: { code: 'asc' } } });
    return { asOfDate: asOf, data: rows.map((e) => ({ entitlementId: e.id, leaveType: e.leaveType, periodStart: e.periodStart, periodEnd: e.periodEnd, granted: e.granted, carriedForward: e.carriedForward, adjustment: e.adjustment, reserved: e.reserved, used: e.used, available: availableUnits(e) })) };
  },
};

const pick = (r: Row) => ({ leaveTypeId: r.leaveTypeId, startDate: r.startDate, endDate: r.endDate, startPart: r.startPart, endPart: r.endPart, reason: r.reason, attachmentRef: r.attachmentRef });
