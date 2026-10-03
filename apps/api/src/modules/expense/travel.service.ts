import type { Prisma } from '@prisma/client';
import { AUDIT_ACTIONS, EXPENSE_WORKFLOW, NOTIFICATION_TYPES, type CreateTravelRequestInput, type TravelRequestDetailDto, type TravelRequestDto, type UpdateTravelRequestInput } from '@hr/shared';
import { AppError } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { auditService } from '../../services/audit/audit.service';
import { notificationService } from '../../services/notification';
import { workflowEngine, type WorkflowCallbackContext } from '../../services/workflow';
import type { AuthContext } from '../auth/auth.types';
import { dec, toMoneyString } from '../payroll/money';
import { todayForEmployee } from '../../services/business-time/business-time';
import { type Actor, type Db, type Tx, adminScope, canSeeEmployee, employeeSnapshot, expenseAudit, has, history, historyDto, lockRow, nextNumber, notFound, P, snapshotDto, textAudit, visibleEmployeeWhere } from './expense.types';

/**
 * Travel requests: a plan with an estimate, approved through the generic workflow. Approval books nothing, pays
 * nothing and creates no expense report; the employee creates one explicitly afterwards.
 */
const include = { travelPolicy: { select: { name: true, workflowCode: true, status: true, currency: true, maximumEstimatedAmount: true, effectiveFrom: true, effectiveTo: true } }, reports: { select: { id: true, reportNumber: true, status: true, totalAmount: true } } } as const;
type Row = Prisma.TravelRequestGetPayload<{ include: typeof include }>;
export async function loadTravelForMutation(tx: Tx, id: string): Promise<Row> {
  await lockRow(tx, 'travel_requests', id);
  const r = await tx.travelRequest.findUnique({ where: { id }, include }); if (!r) throw notFound('travel request');
  return r;
}
function dto(auth: AuthContext, r: Row, { purposeVisible }: { purposeVisible: boolean }): TravelRequestDto {
  const own = !!auth.employeeId && r.employeeId === auth.employeeId;
  const manage = has(auth, P.EXPENSE_MANAGE);
  return {
    id: r.id, requestNumber: r.requestNumber, employeeId: r.employeeId, travelPolicyId: r.travelPolicyId, travelPolicyName: r.travelPolicyNameSnapshot, snapshot: snapshotDto(r), purpose: purposeVisible ? r.purpose : null, destination: r.destination, startDate: r.startDate, endDate: r.endDate, estimatedAmount: toMoneyString(r.estimatedAmount), currency: r.currency,
    status: r.status as TravelRequestDto['status'], workflowInstanceId: r.workflowInstanceId, submittedAt: r.submittedAt?.toISOString() ?? null, approvedAt: r.approvedAt?.toISOString() ?? null, rejectedAt: r.rejectedAt?.toISOString() ?? null, cancelledAt: r.cancelledAt?.toISOString() ?? null, completedAt: r.completedAt?.toISOString() ?? null,
    expenseReports: r.reports.map((x) => ({ id: x.id, reportNumber: x.reportNumber, status: x.status, total: toMoneyString(x.totalAmount) })), createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(),
    can: { edit: r.status === 'DRAFT' && (own && has(auth, P.EXPENSE_SUBMIT) || manage), submit: r.status === 'DRAFT' && (own && has(auth, P.EXPENSE_SUBMIT) || manage), cancel: (r.status === 'DRAFT' || r.status === 'PENDING_APPROVAL') && (own && has(auth, P.EXPENSE_SUBMIT) || manage), complete: r.status === 'APPROVED' && (own && has(auth, P.EXPENSE_SUBMIT) || manage), createExpenseReport: (r.status === 'APPROVED' || r.status === 'COMPLETED') && own && has(auth, P.EXPENSE_SUBMIT) },
  };
}
export async function travelDto(db: Db, auth: AuthContext, r: Row): Promise<TravelRequestDetailDto> {
  const own = !!auth.employeeId && r.employeeId === auth.employeeId;
  return { ...dto(auth, r, { purposeVisible: own || adminScope(auth) }), history: await historyDto(db, 'TRAVEL_REQUEST', r.id) };
}
/** The purpose is business-sensitive text: it is shown to the traveller, the approvers and organization-wide administrators, and never copied elsewhere. */
export async function travelForReviewer(db: Db, auth: AuthContext, r: Row): Promise<TravelRequestDetailDto> { return { ...dto(auth, r, { purposeVisible: true }), history: await historyDto(db, 'TRAVEL_REQUEST', r.id) }; }
async function notifyTraveller(tx: Tx, r: { id: string; employeeId: string; requestNumber: string; status: string }, type: (typeof NOTIFICATION_TYPES)[keyof typeof NOTIFICATION_TYPES]) {
  const emp = await tx.employee.findUnique({ where: { id: r.employeeId }, select: { user: { select: { id: true } } } });
  if (!emp?.user) return;
  await notificationService.publish({ userId: emp.user.id, type, source: { module: 'expense', entityType: 'TRAVEL_REQUEST', entityId: r.id }, data: { travelRequestId: r.id, status: r.status }, dedupeKey: `expense:travel:${r.id}:${type}` }, { referenceNumber: r.requestNumber }, tx);
}
function validate(r: Row): string[] {
  const b: string[] = [];
  if (r.travelPolicy.status !== 'ACTIVE') b.push('The travel policy is not active');
  if (r.startDate > r.endDate) b.push('The end date is before the start date');
  if (dec(r.estimatedAmount).isNegative()) b.push('The estimate cannot be negative');
  if (r.currency !== r.travelPolicy.currency) b.push('The currency does not match the travel policy');
  if (r.travelPolicy.maximumEstimatedAmount && dec(r.estimatedAmount).gt(r.travelPolicy.maximumEstimatedAmount)) b.push(`The estimate exceeds the policy maximum of ${toMoneyString(r.travelPolicy.maximumEstimatedAmount)}`);
  return b;
}

export const travelService = {
  async list(auth: AuthContext, q: { page: number; pageSize: number; status?: string; employeeId?: string; search?: string }) {
    const scope = visibleEmployeeWhere(auth);
    const where: Prisma.TravelRequestWhereInput = { ...scope, status: q.status, ...(q.employeeId ? { employeeId: scope.employeeId ?? q.employeeId } : {}), ...(q.search ? { OR: [{ requestNumber: { contains: q.search, mode: 'insensitive' } }, { destination: { contains: q.search, mode: 'insensitive' } }, { employeeNameSnapshot: { contains: q.search, mode: 'insensitive' } }] } : {}) };
    const [total, rows] = await prisma.$transaction([prisma.travelRequest.count({ where }), prisma.travelRequest.findMany({ where, include, orderBy: [{ createdAt: 'desc' }], skip: (q.page - 1) * q.pageSize, take: q.pageSize })]);
    const admin = adminScope(auth);
    return { data: rows.map((r) => dto(auth, r, { purposeVisible: admin || r.employeeId === auth.employeeId })), meta: { page: q.page, pageSize: q.pageSize, total } };
  },
  async get(auth: AuthContext, id: string): Promise<TravelRequestDetailDto> {
    const r = await prisma.travelRequest.findUnique({ where: { id }, include }); if (!r || !canSeeEmployee(auth, r.employeeId)) throw notFound('travel request');
    return travelDto(prisma, auth, r);
  },
  async create(input: CreateTravelRequestInput, actor: Actor): Promise<TravelRequestDetailDto> {
    const { auth } = actor;
    if (!auth.employeeId) throw new AppError(409, 'NO_EMPLOYEE_RECORD', 'Your account is not linked to an employee record');
    const employeeId = auth.employeeId;
    const id = await prisma.$transaction(async (tx) => {
      const policy = await tx.travelPolicy.findUnique({ where: { id: input.travelPolicyId } }); if (!policy) throw notFound('travel policy');
      if (policy.status !== 'ACTIVE') throw new AppError(409, 'TRAVEL_POLICY_NOT_ACTIVE', 'This travel policy is not active');
      const { employee, data } = await employeeSnapshot(tx, employeeId);
      if (employee.employmentStatus !== 'ACTIVE') throw new AppError(409, 'EMPLOYEE_NOT_ACTIVE', 'Travel requests need an active employee');
      if (policy.organizationId && policy.organizationId !== employee.organizationId) throw new AppError(422, 'VALIDATION_ERROR', 'This travel policy belongs to another organization', [{ field: 'travelPolicyId', message: 'Not applicable' }]);
      const r = await tx.travelRequest.create({ data: { requestNumber: await nextNumber(tx, 'travel', employeeId), employeeId, travelPolicyId: policy.id, travelPolicyNameSnapshot: policy.name, ...data, purpose: input.purpose, destination: input.destination, startDate: input.startDate, endDate: input.endDate, estimatedAmount: dec(input.estimatedAmount), currency: policy.currency, createdByUserId: auth.userId } });
      await history(tx, 'TRAVEL_REQUEST', r.id, null, 'DRAFT', auth.userId);
      await auditService.log(expenseAudit(actor, AUDIT_ACTIONS.CREATE_TRAVEL_REQUEST, 'TravelRequest', r.id, { requestNumber: r.requestNumber, travelPolicyId: policy.id, startDate: r.startDate, endDate: r.endDate, estimatedAmount: toMoneyString(r.estimatedAmount), currency: r.currency, destinationLength: r.destination.length, purposeLength: r.purpose.length }), tx);
      return r.id;
    });
    return this.get(auth, id);
  },
  async update(id: string, input: UpdateTravelRequestInput, actor: Actor): Promise<TravelRequestDetailDto> {
    await prisma.$transaction(async (tx) => {
      const r = await loadTravelForMutation(tx, id);
      const own = !!actor.auth.employeeId && r.employeeId === actor.auth.employeeId && has(actor.auth, P.EXPENSE_SUBMIT);
      if (!own && !has(actor.auth, P.EXPENSE_MANAGE)) throw notFound('travel request');
      if (r.status !== 'DRAFT') throw new AppError(409, 'TRAVEL_REQUEST_NOT_DRAFT', 'A submitted request cannot be edited; cancel it and make a new one');
      const after = await tx.travelRequest.update({ where: { id }, data: { purpose: input.purpose, destination: input.destination, startDate: input.startDate, endDate: input.endDate, estimatedAmount: input.estimatedAmount === undefined ? undefined : dec(input.estimatedAmount) } });
      if (after.startDate > after.endDate) throw new AppError(422, 'VALIDATION_ERROR', 'End date must not be before start date', [{ field: 'endDate', message: 'Before start' }]);
      await auditService.log(expenseAudit(actor, AUDIT_ACTIONS.UPDATE_TRAVEL_REQUEST, 'TravelRequest', id, { fields: Object.keys(input), estimatedAmount: toMoneyString(after.estimatedAmount), ...textAudit('purpose', r.purpose, after.purpose) }), tx);
    });
    return this.get(actor.auth, id);
  },
  /** One transaction: lock → DRAFT → validate → PENDING_APPROVAL → workflow → audit → notify. */
  async submit(id: string, actor: Actor): Promise<TravelRequestDetailDto> {
    const { auth } = actor;
    await prisma.$transaction(async (tx) => {
      const r = await loadTravelForMutation(tx, id);
      const own = !!auth.employeeId && r.employeeId === auth.employeeId && has(auth, P.EXPENSE_SUBMIT);
      if (!own && !has(auth, P.EXPENSE_MANAGE)) throw notFound('travel request');
      if (r.status !== 'DRAFT') throw new AppError(409, 'TRAVEL_REQUEST_NOT_DRAFT', `This request is ${r.status.toLowerCase().replace(/_/g, ' ')}`);
      const blockers = validate(r);
      const employee = await tx.employee.findUnique({ where: { id: r.employeeId }, select: { employmentStatus: true } });
      if (employee?.employmentStatus !== 'ACTIVE') blockers.push('Travel requests need an active employee');
      if (blockers.length) throw new AppError(422, 'TRAVEL_REQUEST_INVALID', blockers.join('; '), blockers.map((b) => ({ field: 'request', message: b })));
      await tx.travelRequest.update({ where: { id }, data: { status: 'PENDING_APPROVAL', submittedAt: new Date() } });
      await history(tx, 'TRAVEL_REQUEST', id, 'DRAFT', 'PENDING_APPROVAL', auth.userId);
      const instance = await workflowEngine.submit({ definitionCode: r.travelPolicy.workflowCode, module: EXPENSE_WORKFLOW.module, entityType: EXPENSE_WORKFLOW.travel, entityId: id, requesterEmployeeId: r.employeeId }, actor, tx);
      const after = await tx.travelRequest.update({ where: { id }, data: { workflowInstanceId: instance.id } });
      await auditService.log(expenseAudit(actor, AUDIT_ACTIONS.SUBMIT_TRAVEL_REQUEST, 'TravelRequest', id, { requestNumber: r.requestNumber, estimatedAmount: toMoneyString(r.estimatedAmount), currency: r.currency, workflowInstanceId: instance.id, workflowStatus: instance.status }), tx);
      if (after.status === 'PENDING_APPROVAL') await notifyTraveller(tx, after, NOTIFICATION_TYPES.TRAVEL_REQUEST_SUBMITTED);
    });
    return this.get(auth, id);
  },
  async cancel(id: string, actor: Actor): Promise<TravelRequestDetailDto> {
    const { auth } = actor;
    await prisma.$transaction(async (tx) => {
      const r = await loadTravelForMutation(tx, id);
      const own = !!auth.employeeId && r.employeeId === auth.employeeId && has(auth, P.EXPENSE_SUBMIT);
      if (!own && !has(auth, P.EXPENSE_MANAGE)) throw notFound('travel request');
      if (r.status === 'DRAFT') {
        await tx.travelRequest.update({ where: { id }, data: { status: 'CANCELLED', cancelledAt: new Date() } });
        await history(tx, 'TRAVEL_REQUEST', id, 'DRAFT', 'CANCELLED', auth.userId);
        await auditService.log(expenseAudit(actor, AUDIT_ACTIONS.CANCEL_TRAVEL_REQUEST, 'TravelRequest', id, { from: 'DRAFT' }), tx);
        return;
      }
      if (r.status !== 'PENDING_APPROVAL' || !r.workflowInstanceId) throw new AppError(409, 'TRAVEL_REQUEST_NOT_CANCELLABLE', `A ${r.status.toLowerCase().replace(/_/g, ' ')} request cannot be cancelled`);
      await workflowEngine.cancel(r.workflowInstanceId, actor, tx);
    });
    return this.get(auth, id);
  },
  /** A manual record that the trip happened. Nothing derives it, nothing follows from it. */
  async complete(id: string, actor: Actor): Promise<TravelRequestDetailDto> {
    const { auth } = actor;
    await prisma.$transaction(async (tx) => {
      const r = await loadTravelForMutation(tx, id);
      const own = !!auth.employeeId && r.employeeId === auth.employeeId && has(auth, P.EXPENSE_SUBMIT);
      if (!own && !has(auth, P.EXPENSE_MANAGE)) throw notFound('travel request');
      if (r.status !== 'APPROVED') throw new AppError(409, 'TRAVEL_REQUEST_NOT_APPROVED', 'Only an approved trip can be marked completed');
      await tx.travelRequest.update({ where: { id }, data: { status: 'COMPLETED', completedAt: new Date() } });
      await history(tx, 'TRAVEL_REQUEST', id, 'APPROVED', 'COMPLETED', auth.userId);
      await auditService.log(expenseAudit(actor, AUDIT_ACTIONS.COMPLETE_TRAVEL_REQUEST, 'TravelRequest', id, { completedOn: await todayForEmployee(tx, r.employeeId) }), tx);
    });
    return this.get(auth, id);
  },
};

// ---------- workflow callbacks (engine holds the instance lock; we lock the request) ----------
async function pending(tx: Tx, ctx: WorkflowCallbackContext) {
  const r = await loadTravelForMutation(tx, ctx.entityId);
  if (r.status !== 'PENDING_APPROVAL') throw new AppError(409, 'TRAVEL_REQUEST_NOT_PENDING', `Request is ${r.status}`);
  return r;
}
export const travelWorkflowHandlers = {
  async onApproved(ctx: WorkflowCallbackContext, tx: Tx) {
    const r = await pending(tx, ctx);
    const after = await tx.travelRequest.update({ where: { id: r.id }, data: { status: 'APPROVED', approvedAt: new Date() } });
    await history(tx, 'TRAVEL_REQUEST', r.id, 'PENDING_APPROVAL', 'APPROVED', ctx.actor.auth.userId, 'APPROVED');
    await auditService.log(expenseAudit(ctx.actor, AUDIT_ACTIONS.APPROVE_TRAVEL_REQUEST, 'TravelRequest', r.id, { requestNumber: r.requestNumber, estimatedAmount: toMoneyString(r.estimatedAmount), workflowInstanceId: ctx.instanceId, ...textAudit('comment', null, ctx.comment) }, { status: 'PENDING_APPROVAL' }), tx);
    await notifyTraveller(tx, after, NOTIFICATION_TYPES.TRAVEL_REQUEST_APPROVED);
  },
  async onRejected(ctx: WorkflowCallbackContext, tx: Tx) {
    const r = await pending(tx, ctx);
    const after = await tx.travelRequest.update({ where: { id: r.id }, data: { status: 'REJECTED', rejectedAt: new Date() } });
    await history(tx, 'TRAVEL_REQUEST', r.id, 'PENDING_APPROVAL', 'REJECTED', ctx.actor.auth.userId, 'REJECTED');
    await auditService.log(expenseAudit(ctx.actor, AUDIT_ACTIONS.REJECT_TRAVEL_REQUEST, 'TravelRequest', r.id, { requestNumber: r.requestNumber, workflowInstanceId: ctx.instanceId, ...textAudit('comment', null, ctx.comment) }, { status: 'PENDING_APPROVAL' }), tx);
    await notifyTraveller(tx, after, NOTIFICATION_TYPES.TRAVEL_REQUEST_REJECTED);
  },
  async onCancelled(ctx: WorkflowCallbackContext, tx: Tx) {
    const r = await pending(tx, ctx);
    await tx.travelRequest.update({ where: { id: r.id }, data: { status: 'CANCELLED', cancelledAt: new Date() } });
    await history(tx, 'TRAVEL_REQUEST', r.id, 'PENDING_APPROVAL', 'CANCELLED', ctx.actor.auth.userId);
    await auditService.log(expenseAudit(ctx.actor, AUDIT_ACTIONS.CANCEL_TRAVEL_REQUEST, 'TravelRequest', r.id, { from: 'PENDING_APPROVAL', workflowInstanceId: ctx.instanceId }), tx);
  },
  async notifyApprover(ctx: { instanceId: string; entityId: string; step: { id: string; approverUserId: string | null } }, tx: Tx) {
    if (!ctx.step.approverUserId) return;
    const r = await tx.travelRequest.findUnique({ where: { id: ctx.entityId }, select: { id: true, requestNumber: true, employeeNameSnapshot: true } }); if (!r) return;
    await notificationService.publish({ userId: ctx.step.approverUserId, type: NOTIFICATION_TYPES.TRAVEL_APPROVAL_REQUIRED, source: { module: EXPENSE_WORKFLOW.module, entityType: EXPENSE_WORKFLOW.travel, entityId: r.id }, data: { travelRequestId: r.id, workflowInstanceId: ctx.instanceId }, dedupeKey: `workflow:${ctx.instanceId}:step:${ctx.step.id}:travel-approval-required` }, { referenceNumber: r.requestNumber, employeeName: r.employeeNameSnapshot }, tx);
  },
};
