import { LEAVE_WORKFLOW, type NotificationType } from '@hr/shared';
import { notificationService } from '../../services/notification';
import type { TemplateVars } from '../../services/notification/notification.templates';
import type { Tx } from './balance.service';

type NotifiableRequest = { id: string; startDate: string; endDate: string; createdByUserId: string; employeeId: string; leaveType: { name: string } };

/** Only the facts a notification may state: leave type and date range — never reason, attachment, comment or balance. */
export function leaveNotificationVars(r: NotifiableRequest): TemplateVars {
  return { leaveType: r.leaveType.name, dateRange: r.startDate === r.endDate ? r.startDate : `${r.startDate} → ${r.endDate}` };
}

/**
 * Notifies the requester about their own leave request. The recipient is the employee's user account (not the actor),
 * so an HR-initiated transition still reaches the employee; a missing or inactive account is skipped by the service.
 */
export async function notifyLeaveEvent(tx: Tx, request: NotifiableRequest, type: NotificationType, keySuffix: string) {
  const user = await tx.user.findUnique({ where: { employeeId: request.employeeId }, select: { id: true } });
  await notificationService.publish(
    {
      userId: user?.id ?? null,
      type,
      source: { module: LEAVE_WORKFLOW.module, entityType: LEAVE_WORKFLOW.entityType, entityId: request.id },
      data: { leaveRequestId: request.id },
      dedupeKey: `leave:${request.id}:${keySuffix}`,
    },
    leaveNotificationVars(request),
    tx,
  );
}
