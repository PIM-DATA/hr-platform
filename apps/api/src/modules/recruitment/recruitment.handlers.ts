import { NOTIFICATION_TYPES, RECRUITMENT_WORKFLOW } from '@hr/shared';
import { workflowEngine, type WorkflowCallbackContext, type WorkflowStepPendingContext } from '../../services/workflow';
import { notificationService } from '../../services/notification';
import { prisma } from '../../lib/prisma';
import { requisitionService } from './requisition.service';
import { offerService } from './offer.service';
import type { Tx } from './recruitment.types';

/**
 * Recruitment's workflow callbacks — one handler for the module, dispatching on the entity type: a requisition
 * (headcount) and an offer (terms to one candidate) are approved through separate definitions chosen by policy.
 * The approver's inbox line names the document and nothing about the candidate.
 */
const isOffer = (ctx: { entityType: string }) => ctx.entityType === RECRUITMENT_WORKFLOW.offer;

export const recruitmentWorkflowHandlers = {
  async onApproved(ctx: WorkflowCallbackContext, tx: Tx) {
    if (isOffer(ctx)) await offerService.approveFromWorkflow(tx, ctx.entityId, ctx.actor);
    else await requisitionService.approveFromWorkflow(tx, ctx.entityId, ctx.actor);
  },
  async onRejected(ctx: WorkflowCallbackContext, tx: Tx) {
    if (isOffer(ctx)) await offerService.rejectFromWorkflow(tx, ctx.entityId, ctx.actor);
    else await requisitionService.rejectFromWorkflow(tx, ctx.entityId, ctx.actor);
  },
  async onCancelled(ctx: WorkflowCallbackContext, tx: Tx) {
    if (isOffer(ctx)) await offerService.cancelFromWorkflow(tx, ctx.entityId);
    else await requisitionService.cancelFromWorkflow(tx, ctx.entityId);
  },
  async onStepPending(ctx: WorkflowStepPendingContext, tx: Tx) {
    if (!ctx.step.approverUserId) return;
    const label = isOffer(ctx)
      ? await prisma.recruitmentOffer.findUnique({ where: { id: ctx.entityId }, select: { offerNumber: true } }).then((o) => (o ? `job offer ${o.offerNumber}` : null))
      : await prisma.recruitmentRequisition.findUnique({ where: { id: ctx.entityId }, select: { requisitionNumber: true } }).then((r) => (r ? `recruitment requisition ${r.requisitionNumber}` : null));
    if (!label) return;
    await notificationService.publish(
      {
        userId: ctx.step.approverUserId, type: NOTIFICATION_TYPES.APPROVAL_REQUIRED,
        source: { module: RECRUITMENT_WORKFLOW.module, entityType: ctx.entityType, entityId: ctx.entityId },
        data: { entityId: ctx.entityId, workflowInstanceId: ctx.instanceId },
        dedupeKey: `workflow:${ctx.instanceId}:step:${ctx.step.id}:approval-required`,
      },
      { employeeName: 'Recruitment', requestKind: label },
      tx,
    );
  },
};

workflowEngine.registerHandler(RECRUITMENT_WORKFLOW.module, recruitmentWorkflowHandlers);
