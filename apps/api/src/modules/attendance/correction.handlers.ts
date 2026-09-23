import { ATTENDANCE_WORKFLOW, AUDIT_ACTIONS, NOTIFICATION_TYPES } from '@hr/shared';
import { auditService } from '../../services/audit/audit.service';
import { workflowEngine, type WorkflowCallbackContext, type WorkflowStepPendingContext } from '../../services/workflow';
import { notificationService } from '../../services/notification';
import { attendanceAudit, type Tx } from './attendance.types';
import { correctionsService } from './corrections.service';

/**
 * Attendance-side workflow callbacks, run INSIDE the engine's transaction — the same contract Leave uses, so an
 * approval is one atomic step: decision recorded, day recalculated, audit written, notification queued.
 *
 * Approving never edits a raw clock event. It flips the correction to APPROVED, and the recalculation then reads it
 * as an input, which is why a later recalculation cannot undo a human decision.
 */
const notifyEmployee = async (tx: Tx, correction: { id: string; employeeId: string; attendanceDate: string }, type: typeof NOTIFICATION_TYPES.ATTENDANCE_CORRECTION_APPROVED | typeof NOTIFICATION_TYPES.ATTENDANCE_CORRECTION_REJECTED, suffix: string) => {
  const employee = await tx.employee.findUnique({ where: { id: correction.employeeId }, select: { user: { select: { id: true } } } });
  await notificationService.publish(
    {
      userId: employee?.user?.id,
      type,
      source: { module: ATTENDANCE_WORKFLOW.module, entityType: ATTENDANCE_WORKFLOW.entityType, entityId: correction.id },
      data: { correctionId: correction.id, attendanceDate: correction.attendanceDate },
      dedupeKey: `attendance-correction:${correction.id}:${suffix}`,
    },
    { date: correction.attendanceDate },
    tx,
  );
};

export const attendanceWorkflowHandlers = {
  async onApproved(ctx: WorkflowCallbackContext, tx: Tx) {
    const row = await correctionsService.applyDecision(tx, ctx.entityId, 'APPROVED');
    await auditService.log(attendanceAudit(ctx.actor, AUDIT_ACTIONS.APPROVE_ATTENDANCE_CORRECTION, 'AttendanceCorrection', row.id,
      { status: 'APPROVED', attendanceDate: row.attendanceDate, workflowInstanceId: ctx.instanceId, comment: ctx.comment },
      { status: 'PENDING' }), tx);
    await notifyEmployee(tx, row, NOTIFICATION_TYPES.ATTENDANCE_CORRECTION_APPROVED, 'approved');
  },

  async onRejected(ctx: WorkflowCallbackContext, tx: Tx) {
    const row = await correctionsService.applyDecision(tx, ctx.entityId, 'REJECTED');
    await auditService.log(attendanceAudit(ctx.actor, AUDIT_ACTIONS.REJECT_ATTENDANCE_CORRECTION, 'AttendanceCorrection', row.id,
      { status: 'REJECTED', attendanceDate: row.attendanceDate, workflowInstanceId: ctx.instanceId, comment: ctx.comment },
      { status: 'PENDING' }), tx);
    // The approver's comment stays in the workflow timeline; the notification only says it was rejected.
    await notifyEmployee(tx, row, NOTIFICATION_TYPES.ATTENDANCE_CORRECTION_REJECTED, 'rejected');
  },

  /** The requester withdrew it: no notification, they did it themselves. */
  async onCancelled(ctx: WorkflowCallbackContext, tx: Tx) {
    const row = await correctionsService.applyDecision(tx, ctx.entityId, 'CANCELLED');
    await auditService.log(attendanceAudit(ctx.actor, AUDIT_ACTIONS.CANCEL_ATTENDANCE_CORRECTION, 'AttendanceCorrection', row.id,
      { status: 'CANCELLED', attendanceDate: row.attendanceDate, workflowInstanceId: ctx.instanceId },
      { status: 'PENDING' }), tx);
  },

  /** A step became the current one: tell that approver, and only that approver. */
  async onStepPending(ctx: WorkflowStepPendingContext, tx: Tx) {
    if (!ctx.step.approverUserId) return;
    const row = await tx.attendanceCorrection.findUnique({
      where: { id: ctx.entityId },
      select: { id: true, attendanceDate: true, employee: { select: { firstName: true, lastName: true } } },
    });
    if (!row) return;
    await notificationService.publish(
      {
        userId: ctx.step.approverUserId,
        type: NOTIFICATION_TYPES.APPROVAL_REQUIRED,
        source: { module: ATTENDANCE_WORKFLOW.module, entityType: ATTENDANCE_WORKFLOW.entityType, entityId: row.id },
        data: { correctionId: row.id, workflowInstanceId: ctx.instanceId, attendanceDate: row.attendanceDate },
        dedupeKey: `workflow:${ctx.instanceId}:step:${ctx.step.id}:approval-required`,
      },
      { employeeName: `${row.employee.firstName} ${row.employee.lastName}`, requestKind: 'attendance correction', date: row.attendanceDate },
      tx,
    );
  },
};

workflowEngine.registerHandler(ATTENDANCE_WORKFLOW.module, attendanceWorkflowHandlers);
