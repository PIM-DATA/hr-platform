import { NOTIFICATION_TYPES, type NotificationType } from '@hr/shared';

/**
 * Copy for every notification type, in one place so business modules never hardcode wording.
 *
 * Privacy rule: a notification says WHAT happened and links to the record — it never repeats leave reasons,
 * attachment references, approval comments, policy rules or balances. The recipient opens the record to see those,
 * where the normal authorization applies.
 */
export interface TemplateVars {
  employeeName?: string;
  leaveType?: string;
  dateRange?: string;
}

const templates: Record<NotificationType, (v: TemplateVars) => { title: string; body: string }> = {
  [NOTIFICATION_TYPES.APPROVAL_REQUIRED]: (v) => ({
    title: 'Approval required',
    body: `${v.employeeName ?? 'An employee'} submitted a ${v.leaveType ?? 'leave'} request${v.dateRange ? ` for ${v.dateRange}` : ''}.`,
  }),
  [NOTIFICATION_TYPES.LEAVE_SUBMITTED]: (v) => ({
    title: 'Leave request submitted',
    body: `Your ${v.leaveType ?? 'leave'} request${v.dateRange ? ` for ${v.dateRange}` : ''} has been submitted for approval.`,
  }),
  [NOTIFICATION_TYPES.LEAVE_APPROVED]: (v) => ({
    title: 'Leave request approved',
    body: `Your ${v.leaveType ?? 'leave'} request${v.dateRange ? ` for ${v.dateRange}` : ''} has been approved.`,
  }),
  [NOTIFICATION_TYPES.LEAVE_REJECTED]: (v) => ({
    title: 'Leave request rejected',
    body: `Your ${v.leaveType ?? 'leave'} request${v.dateRange ? ` for ${v.dateRange}` : ''} was rejected. Open the request to see the details.`,
  }),
  [NOTIFICATION_TYPES.LEAVE_CANCELLED]: (v) => ({
    title: 'Leave request cancelled',
    body: `The ${v.leaveType ?? 'leave'} request${v.dateRange ? ` for ${v.dateRange}` : ''} was cancelled.`,
  }),
};

export function renderTemplate(type: NotificationType, vars: TemplateVars) {
  return templates[type](vars);
}
