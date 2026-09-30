import { AUDIT_ACTIONS, LEAVE_REQUEST_STATUS as ST, LEAVE_WORKFLOW, NOTIFICATION_TYPES, operationKeys } from '@hr/shared';
import { AppError } from '../../lib/errors';
import { auditService } from '../../services/audit/audit.service';
import { workflowEngine, type WorkflowCallbackContext, type WorkflowStepPendingContext } from '../../services/workflow';
import { notificationService } from '../../services/notification';
import { leaveNotificationVars, notifyLeaveEvent } from './leave-notifications';
import type { Tx } from './balance.service';
import { balanceService } from './balance.service';
import { loadLeaveRequestForMutation } from './leave-requests.service';
import { assertPayrollInputsOpen } from '../payroll/payroll-freeze';

/**
 * Leave-side terminal handlers, run INSIDE the workflow engine's transaction (approve/reject via the generic action
 * endpoint; cancel via the leave cancel endpoint → workflowEngine.cancel). The engine already holds the instance row lock;
 * here we lock the request row, then the entitlement (through BalanceService) — always in that order.
 * Ledger keys are deterministic per request (leave:<id>:release / :use), so a retried transition can never double-settle.
 */
const audit = (ctx: WorkflowCallbackContext, action: keyof typeof AUDIT_ACTIONS, recordId: string, oldValue: unknown, newValue: unknown) =>
  ({ userId: ctx.actor.auth.userId, ipAddress: ctx.actor.ipAddress, userAgent: ctx.actor.userAgent, action: AUDIT_ACTIONS[action], module: 'leave', recordType: 'LeaveRequest', recordId, oldValue, newValue });

async function pendingRequest(tx: Tx, ctx: WorkflowCallbackContext) {
  const req = await loadLeaveRequestForMutation(tx, ctx.entityId);
  if (req.status !== ST.PENDING || !req.entitlementId) throw new AppError(409, 'LEAVE_REQUEST_NOT_PENDING', `Leave request is ${req.status}`);
  return req as typeof req & { entitlementId: string };
}
const meta = (ctx: WorkflowCallbackContext, req: { id: string }, op: 'release' | 'use') => ({ operationKey: operationKeys.leave(req.id, op), actorUserId: ctx.actor.auth.userId, referenceType: 'LeaveRequest', referenceId: req.id });

export const leaveWorkflowHandlers = {
  /** Final approval: reservation → usage, status APPROVED. */
  async onApproved(ctx: WorkflowCallbackContext, tx: Tx) {
    const req = await pendingRequest(tx, ctx);
    // Task 48 (T44-P1-16): an approved leave is payroll input (paid/unpaid days); not inside an approved/closed payroll.
    await assertPayrollInputsOpen(tx, req.employeeId, { from: req.startDate, to: req.endDate }, 'ATTENDANCE', `Leave ${req.startDate} → ${req.endDate}`);
    await balanceService.release(tx, req.entitlementId, req.units, meta(ctx, req, 'release'));
    const r = await balanceService.use(tx, req.entitlementId, req.units, meta(ctx, req, 'use'));
    const now = new Date();
    await tx.leaveRequest.update({ where: { id: req.id }, data: { status: ST.APPROVED, approvedAt: now } });
    await auditService.log(audit(ctx, 'APPROVE_LEAVE_REQUEST', req.id, { status: ST.PENDING }, { status: ST.APPROVED, units: req.units, workflowInstanceId: ctx.instanceId, commentLength: ctx.comment?.length ?? 0, balance: r.summary }), tx);
    await notifyLeaveEvent(tx, req, NOTIFICATION_TYPES.LEAVE_APPROVED, 'approved');
  },
  /** Rejection: reservation released, status REJECTED. */
  async onRejected(ctx: WorkflowCallbackContext, tx: Tx) {
    const req = await pendingRequest(tx, ctx);
    const r = await balanceService.release(tx, req.entitlementId, req.units, meta(ctx, req, 'release'));
    await tx.leaveRequest.update({ where: { id: req.id }, data: { status: ST.REJECTED, rejectedAt: new Date() } });
    await auditService.log(audit(ctx, 'REJECT_LEAVE_REQUEST', req.id, { status: ST.PENDING }, { status: ST.REJECTED, units: req.units, workflowInstanceId: ctx.instanceId, commentLength: ctx.comment?.length ?? 0, balance: r.summary }), tx);
    // the rejection comment stays in the workflow timeline — it is never copied into a notification body
    await notifyLeaveEvent(tx, req, NOTIFICATION_TYPES.LEAVE_REJECTED, 'rejected');
  },
  /**
   * A step just became the current pending step (at submit, or after an approval advanced the instance): notify that
   * snapshot approver only. Future WAITING approvers are never notified, and the approver who just acted is not
   * notified again because the engine only reports the step that is pending NOW.
   */
  async onStepPending(ctx: WorkflowStepPendingContext, tx: Tx) {
    if (!ctx.step.approverUserId) return;
    const req = await tx.leaveRequest.findUnique({ where: { id: ctx.entityId }, include: { leaveType: { select: { name: true } }, employee: { select: { firstName: true, lastName: true } } } });
    if (!req) return;
    await notificationService.publish(
      {
        userId: ctx.step.approverUserId,
        type: NOTIFICATION_TYPES.APPROVAL_REQUIRED,
        source: { module: LEAVE_WORKFLOW.module, entityType: LEAVE_WORKFLOW.entityType, entityId: req.id },
        data: { leaveRequestId: req.id, workflowInstanceId: ctx.instanceId },
        dedupeKey: `workflow:${ctx.instanceId}:step:${ctx.step.id}:approval-required`,
      },
      { ...leaveNotificationVars(req), employeeName: `${req.employee.firstName} ${req.employee.lastName}` },
      tx,
    );
  },

  /** Requester withdrawal of a pending request: reservation released, status CANCELLED. */
  async onCancelled(ctx: WorkflowCallbackContext, tx: Tx) {
    const req = await pendingRequest(tx, ctx);
    const r = await balanceService.release(tx, req.entitlementId, req.units, meta(ctx, req, 'release'));
    await tx.leaveRequest.update({ where: { id: req.id }, data: { status: ST.CANCELLED, cancelledAt: new Date() } });
    await auditService.log(audit(ctx, 'CANCEL_LEAVE_REQUEST', req.id, { status: ST.PENDING }, { status: ST.CANCELLED, units: req.units, workflowInstanceId: ctx.instanceId, commentLength: ctx.comment?.length ?? 0, balance: r.summary }), tx);
  },
};

/** Called once at app start (routes.ts). Idempotent. */
export function registerLeaveWorkflowHandlers() {
  workflowEngine.registerHandler(LEAVE_WORKFLOW.module, leaveWorkflowHandlers);
}
