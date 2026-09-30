import { ATTENDANCE_WORKFLOW, AUDIT_ACTIONS, NOTIFICATION_TYPES, OVERTIME_WORKFLOW } from '@hr/shared';
import { AppError } from '../../lib/errors';
import { auditService } from '../../services/audit/audit.service';
import { workflowEngine, type WorkflowCallbackContext, type WorkflowStepPendingContext } from '../../services/workflow';
import { notificationService } from '../../services/notification';
import { attendanceAudit, type Tx } from './attendance.types';
import { correctionsService } from './corrections.service';
import { overtimeEligibilityService } from './overtime-eligibility.service';
import { overtimeService } from './overtime.service';
import { overtimeWorkflowHandlers } from './overtime.handlers';

/**
 * Attendance-side workflow callbacks, run INSIDE the engine's transaction.
 *
 * The engine keys handlers by **module**, and this module now has two kinds of request — corrections and overtime
 * claims — so everything is dispatched on `entityType` at the bottom of this file. Each kind keeps its own
 * transaction-scoped behaviour; neither knows about the other, except where they genuinely interact (below).
 *
 * Approving a correction never edits a raw clock event. It flips the correction to APPROVED, and the recalculation
 * then reads it as an input, which is why a later recalculation cannot undo a human decision.
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

/**
 * A correction may not pull the ground out from under overtime somebody has already been granted.
 *
 * Once a claim is APPROVED it is payroll input. If applying this correction would leave the day supporting less
 * overtime than has already been approved, the approval fails and the whole transition rolls back — the correction
 * stays pending, the attendance stays as it was, and a person decides which of the two is wrong. A *pending* claim is
 * not protected: it is revalidated when somebody tries to approve it.
 */
async function assertApprovedOvertimeStillSupported(tx: Tx, employeeId: string, attendanceDate: string) {
  const approvedMinutes = await overtimeService.approvedMinutesForDay(tx, employeeId, attendanceDate);
  if (approvedMinutes === 0) return;
  const assessment = await overtimeEligibilityService.assess(tx, employeeId, attendanceDate);
  if (assessment.eligibility.eligibleMinutes < approvedMinutes) {
    throw new AppError(
      409,
      'ATTENDANCE_CORRECTION_CONFLICTS_WITH_APPROVED_OT',
      `This correction would leave ${attendanceDate} supporting ${assessment.eligibility.eligibleMinutes} minute(s) of overtime, but ${approvedMinutes} minute(s) are already approved. Resolve the overtime claim first.`,
    );
  }
}

export const attendanceCorrectionHandlers = {
  async onApproved(ctx: WorkflowCallbackContext, tx: Tx) {
    const row = await correctionsService.applyDecision(tx, ctx.entityId, 'APPROVED');
    // The day has just been recalculated with the corrected times — check it still supports any approved overtime.
    await assertApprovedOvertimeStillSupported(tx, row.employeeId, row.attendanceDate);
    await auditService.log(attendanceAudit(ctx.actor, AUDIT_ACTIONS.APPROVE_ATTENDANCE_CORRECTION, 'AttendanceCorrection', row.id,
      { status: 'APPROVED', attendanceDate: row.attendanceDate, workflowInstanceId: ctx.instanceId, commentLength: ctx.comment?.length ?? 0 },
      { status: 'PENDING' }), tx);
    await notifyEmployee(tx, row, NOTIFICATION_TYPES.ATTENDANCE_CORRECTION_APPROVED, 'approved');
  },

  async onRejected(ctx: WorkflowCallbackContext, tx: Tx) {
    const row = await correctionsService.applyDecision(tx, ctx.entityId, 'REJECTED');
    await auditService.log(attendanceAudit(ctx.actor, AUDIT_ACTIONS.REJECT_ATTENDANCE_CORRECTION, 'AttendanceCorrection', row.id,
      { status: 'REJECTED', attendanceDate: row.attendanceDate, workflowInstanceId: ctx.instanceId, commentLength: ctx.comment?.length ?? 0 },
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

/**
 * One registration for the module, dispatching on the entity type. Adding another attendance-side request kind means
 * another branch here, not another engine.
 */
type EntityHandlers = {
  onApproved: (ctx: WorkflowCallbackContext, tx: Tx) => Promise<void>;
  onRejected: (ctx: WorkflowCallbackContext, tx: Tx) => Promise<void>;
  onCancelled: (ctx: WorkflowCallbackContext, tx: Tx) => Promise<void>;
  onStepPending: (ctx: WorkflowStepPendingContext, tx: Tx) => Promise<void>;
};
const byEntityType: Record<string, EntityHandlers> = {
  [ATTENDANCE_WORKFLOW.entityType]: attendanceCorrectionHandlers,
  [OVERTIME_WORKFLOW.entityType]: overtimeWorkflowHandlers,
};

const dispatch = <K extends 'onApproved' | 'onRejected' | 'onCancelled'>(hook: K) =>
  async (ctx: WorkflowCallbackContext, tx: Tx) => {
    const handler = byEntityType[ctx.entityType];
    if (handler) await handler[hook](ctx, tx);
  };

export const attendanceWorkflowHandlers = {
  onApproved: dispatch('onApproved'),
  onRejected: dispatch('onRejected'),
  onCancelled: dispatch('onCancelled'),
  async onStepPending(ctx: WorkflowStepPendingContext, tx: Tx) {
    const handler = byEntityType[ctx.entityType];
    if (handler) await handler.onStepPending(ctx, tx);
  },
};

workflowEngine.registerHandler(ATTENDANCE_WORKFLOW.module, attendanceWorkflowHandlers);
