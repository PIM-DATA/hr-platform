import { EMPLOYEE_RELATIONS_WORKFLOW, NOTIFICATION_TYPES } from '@hr/shared';
import { workflowEngine, type WorkflowCallbackContext, type WorkflowStepPendingContext } from '../../services/workflow';
import { notificationService } from '../../services/notification';
import { prisma } from '../../lib/prisma';
import { erCaseService } from './er-case.service';
import type { Tx } from './er.types';

/**
 * Disciplinary approval, inside the workflow engine's transaction.
 *
 * Final approval is the only road to ISSUED. Rejection ends that proposal — HR drafts a new one rather than editing a
 * refused one — and withdrawal hands the draft back. The approver's inbox line names nothing about the case beyond
 * its number: what somebody is said to have done is not something to leave lying in a notification.
 */
export const employeeRelationsWorkflowHandlers = {
  async onApproved(ctx: WorkflowCallbackContext, tx: Tx) {
    await erCaseService.issueFromWorkflow(tx, ctx.entityId, ctx.actor, ctx.comment);
  },
  async onRejected(ctx: WorkflowCallbackContext, tx: Tx) {
    await erCaseService.rejectFromWorkflow(tx, ctx.entityId, ctx.actor, ctx.comment);
  },
  async onCancelled(ctx: WorkflowCallbackContext, tx: Tx) {
    await erCaseService.withdrawFromWorkflow(tx, ctx.entityId);
  },
  async onStepPending(ctx: WorkflowStepPendingContext, tx: Tx) {
    if (!ctx.step.approverUserId) return;
    const action = await prisma.disciplinaryAction.findUnique({ where: { id: ctx.entityId }, select: { id: true, case: { select: { caseNumber: true } } } });
    if (!action) return;
    await notificationService.publish(
      {
        userId: ctx.step.approverUserId,
        type: NOTIFICATION_TYPES.APPROVAL_REQUIRED,
        source: { module: EMPLOYEE_RELATIONS_WORKFLOW.module, entityType: EMPLOYEE_RELATIONS_WORKFLOW.entityType, entityId: action.id },
        data: { actionId: action.id, workflowInstanceId: ctx.instanceId },
        dedupeKey: `workflow:${ctx.instanceId}:step:${ctx.step.id}:approval-required`,
      },
      { employeeName: 'Employee relations', requestKind: `employee relations proposal ${action.case.caseNumber}` },
      tx,
    );
  },
};

workflowEngine.registerHandler(EMPLOYEE_RELATIONS_WORKFLOW.module, employeeRelationsWorkflowHandlers);
