import { AUDIT_ACTIONS, LEAVE_REQUEST_STATUS as ST, LEAVE_WORKFLOW, operationKeys } from '@hr/shared';
import { AppError } from '../../lib/errors';
import { auditService } from '../../services/audit/audit.service';
import { workflowEngine, type WorkflowCallbackContext } from '../../services/workflow';
import type { Tx } from './balance.service';
import { balanceService } from './balance.service';
import { loadLeaveRequestForMutation } from './leave-requests.service';

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
    await balanceService.release(tx, req.entitlementId, req.units, meta(ctx, req, 'release'));
    const r = await balanceService.use(tx, req.entitlementId, req.units, meta(ctx, req, 'use'));
    const now = new Date();
    await tx.leaveRequest.update({ where: { id: req.id }, data: { status: ST.APPROVED, approvedAt: now } });
    await auditService.log(audit(ctx, 'APPROVE_LEAVE_REQUEST', req.id, { status: ST.PENDING }, { status: ST.APPROVED, units: req.units, workflowInstanceId: ctx.instanceId, comment: ctx.comment, balance: r.summary }), tx);
  },
  /** Rejection: reservation released, status REJECTED. */
  async onRejected(ctx: WorkflowCallbackContext, tx: Tx) {
    const req = await pendingRequest(tx, ctx);
    const r = await balanceService.release(tx, req.entitlementId, req.units, meta(ctx, req, 'release'));
    await tx.leaveRequest.update({ where: { id: req.id }, data: { status: ST.REJECTED, rejectedAt: new Date() } });
    await auditService.log(audit(ctx, 'REJECT_LEAVE_REQUEST', req.id, { status: ST.PENDING }, { status: ST.REJECTED, units: req.units, workflowInstanceId: ctx.instanceId, comment: ctx.comment, balance: r.summary }), tx);
  },
  /** Requester withdrawal of a pending request: reservation released, status CANCELLED. */
  async onCancelled(ctx: WorkflowCallbackContext, tx: Tx) {
    const req = await pendingRequest(tx, ctx);
    const r = await balanceService.release(tx, req.entitlementId, req.units, meta(ctx, req, 'release'));
    await tx.leaveRequest.update({ where: { id: req.id }, data: { status: ST.CANCELLED, cancelledAt: new Date() } });
    await auditService.log(audit(ctx, 'CANCEL_LEAVE_REQUEST', req.id, { status: ST.PENDING }, { status: ST.CANCELLED, units: req.units, workflowInstanceId: ctx.instanceId, comment: ctx.comment, balance: r.summary }), tx);
  },
};

/** Called once at app start (routes.ts). Idempotent. */
export function registerLeaveWorkflowHandlers() {
  workflowEngine.registerHandler(LEAVE_WORKFLOW.module, leaveWorkflowHandlers);
}
