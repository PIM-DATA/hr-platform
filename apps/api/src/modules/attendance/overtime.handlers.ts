import { AUDIT_ACTIONS, NOTIFICATION_TYPES, formatOvertimeMinutes } from '@hr/shared';
import { AppError } from '../../lib/errors';
import { auditService } from '../../services/audit/audit.service';
import type { WorkflowCallbackContext, WorkflowStepPendingContext } from '../../services/workflow';
import { notificationService } from '../../services/notification';
import { attendanceAudit, type Tx } from './attendance.types';
import { overtimeEligibilityService } from './overtime-eligibility.service';
import { overtimeService } from './overtime.service';

/**
 * Overtime workflow callbacks, run INSIDE the engine's transaction.
 *
 * The important one is `onApproved`. Between a claim being submitted and somebody approving it, the day underneath it
 * can change — an attendance correction is exactly that. So the eligibility is recomputed here, against the day as it
 * stands now, and approval **fails** if the claim no longer has attendance to support it. Failing rolls the whole
 * transition back: the claim stays pending, the workflow stays pending, and a human decides what to do. The
 * alternative — quietly approving overtime the attendance no longer shows — is the kind of thing payroll discovers
 * three months later.
 *
 * The multiplier is never re-resolved on approval. It was snapshotted at submit, and a policy edited in between must
 * not silently re-price a claim.
 */
const notifyRequester = async (
  tx: Tx,
  request: { id: string; employeeId: string; attendanceDate: string; approvedMinutes: number | null },
  type: typeof NOTIFICATION_TYPES.OVERTIME_APPROVED | typeof NOTIFICATION_TYPES.OVERTIME_REJECTED,
  suffix: string,
) => {
  const employee = await tx.employee.findUnique({ where: { id: request.employeeId }, select: { user: { select: { id: true } } } });
  await notificationService.publish(
    {
      userId: employee?.user?.id,
      type,
      source: { module: 'attendance', entityType: 'OVERTIME_REQUEST', entityId: request.id },
      data: { overtimeRequestId: request.id, attendanceDate: request.attendanceDate },
      dedupeKey: `overtime:${request.id}:${suffix}`,
    },
    { date: request.attendanceDate, minutes: request.approvedMinutes ? formatOvertimeMinutes(request.approvedMinutes) : undefined },
    tx,
  );
};

export const overtimeWorkflowHandlers = {
  /** Final approval: revalidate against the current attendance, then freeze the claim. */
  async onApproved(ctx: WorkflowCallbackContext, tx: Tx) {
    const request = await overtimeService.loadForMutation(tx, ctx.entityId);
    if (request.status !== 'PENDING') throw new AppError(409, 'OT_REQUEST_NOT_PENDING', `This claim is ${request.status.toLowerCase()}`);

    const assessment = await overtimeEligibilityService.assess(tx, request.employeeId, request.attendanceDate);
    if (assessment.notFinalReason || request.claimedMinutes > assessment.eligibility.eligibleMinutes) {
      throw new AppError(
        409,
        'OT_ATTENDANCE_CHANGED_REVIEW_REQUIRED',
        `The attendance for ${request.attendanceDate} now supports ${assessment.eligibility.eligibleMinutes} minute(s) of overtime, not ${request.claimedMinutes}. The claim stays pending; withdraw it and claim again.`,
      );
    }

    const approved = await tx.overtimeRequest.update({
      where: { id: request.id },
      data: { status: 'APPROVED', approvedAt: new Date(), approvedMinutes: request.claimedMinutes },
      select: { id: true, employeeId: true, attendanceDate: true, approvedMinutes: true, dayType: true, rateMultiplierSnapshot: true },
    });
    await auditService.log(attendanceAudit(ctx.actor, AUDIT_ACTIONS.APPROVE_OVERTIME_REQUEST, 'OvertimeRequest', request.id,
      { status: 'APPROVED', approvedMinutes: approved.approvedMinutes, dayType: approved.dayType, multiplier: approved.rateMultiplierSnapshot, workflowInstanceId: ctx.instanceId, comment: ctx.comment },
      { status: 'PENDING', claimedMinutes: request.claimedMinutes }), tx);
    await notifyRequester(tx, approved, NOTIFICATION_TYPES.OVERTIME_APPROVED, 'approved');
  },

  async onRejected(ctx: WorkflowCallbackContext, tx: Tx) {
    const request = await overtimeService.loadForMutation(tx, ctx.entityId);
    if (request.status !== 'PENDING') throw new AppError(409, 'OT_REQUEST_NOT_PENDING', `This claim is ${request.status.toLowerCase()}`);
    const rejected = await tx.overtimeRequest.update({
      where: { id: request.id },
      data: { status: 'REJECTED', rejectedAt: new Date() },
      select: { id: true, employeeId: true, attendanceDate: true, approvedMinutes: true },
    });
    await auditService.log(attendanceAudit(ctx.actor, AUDIT_ACTIONS.REJECT_OVERTIME_REQUEST, 'OvertimeRequest', request.id,
      { status: 'REJECTED', workflowInstanceId: ctx.instanceId, comment: ctx.comment }, { status: 'PENDING' }), tx);
    // The approver's comment stays in the workflow timeline; the notification only says it was rejected.
    await notifyRequester(tx, rejected, NOTIFICATION_TYPES.OVERTIME_REJECTED, 'rejected');
  },

  /** The requester withdrew it: no notification, they did it themselves. */
  async onCancelled(ctx: WorkflowCallbackContext, tx: Tx) {
    const request = await overtimeService.loadForMutation(tx, ctx.entityId);
    if (request.status !== 'PENDING') throw new AppError(409, 'OT_REQUEST_NOT_PENDING', `This claim is ${request.status.toLowerCase()}`);
    await tx.overtimeRequest.update({ where: { id: request.id }, data: { status: 'CANCELLED', cancelledAt: new Date() } });
    await auditService.log(attendanceAudit(ctx.actor, AUDIT_ACTIONS.CANCEL_OVERTIME_REQUEST, 'OvertimeRequest', request.id,
      { status: 'CANCELLED', workflowInstanceId: ctx.instanceId }, { status: 'PENDING' }), tx);
  },

  async onStepPending(ctx: WorkflowStepPendingContext, tx: Tx) {
    if (!ctx.step.approverUserId) return;
    const request = await tx.overtimeRequest.findUnique({
      where: { id: ctx.entityId },
      select: { id: true, attendanceDate: true, claimedMinutes: true, employee: { select: { firstName: true, lastName: true } } },
    });
    if (!request) return;
    await notificationService.publish(
      {
        userId: ctx.step.approverUserId,
        type: NOTIFICATION_TYPES.APPROVAL_REQUIRED,
        source: { module: 'attendance', entityType: 'OVERTIME_REQUEST', entityId: request.id },
        data: { overtimeRequestId: request.id, workflowInstanceId: ctx.instanceId, attendanceDate: request.attendanceDate },
        dedupeKey: `workflow:${ctx.instanceId}:step:${ctx.step.id}:approval-required`,
      },
      {
        employeeName: `${request.employee.firstName} ${request.employee.lastName}`,
        requestKind: `${formatOvertimeMinutes(request.claimedMinutes)} overtime claim`,
        date: request.attendanceDate,
      },
      tx,
    );
  },
};
