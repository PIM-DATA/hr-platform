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
  /** What kind of request needs approving, for the generic approval notification ("leave", "attendance correction"). */
  requestKind?: string;
  /** A single business date, for day-shaped records such as an attendance correction. */
  date?: string;
  /** A formatted duration, e.g. `2h 30m` — never an amount of money. */
  minutes?: string;
  /** A performance cycle's name. Never a score, a rating or a review comment. */
  cycleName?: string;
  /** A course title, for training notifications. Never a score, a result or a development comment. */
  courseTitle?: string;
  /** An opening's title, for recruitment notifications. Never a candidate's name, feedback or an offer figure. */
  openingTitle?: string;
  /** A survey's name and closing date. Never an answer, a result or a manager's request to respond. */
  surveyName?: string;
  closingDate?: string;
}

const templates: Record<NotificationType, (v: TemplateVars) => { title: string; body: string }> = {
  // Generic on purpose: the workflow engine raises this for any module, so the wording names the kind of request.
  [NOTIFICATION_TYPES.APPROVAL_REQUIRED]: (v) => ({
    title: 'Approval required',
    body: `${v.employeeName ?? 'An employee'} submitted a ${v.requestKind ?? `${v.leaveType ?? 'leave'} request`}${v.dateRange ? ` for ${v.dateRange}` : v.date ? ` for ${v.date}` : ''}.`,
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
  [NOTIFICATION_TYPES.ATTENDANCE_CORRECTION_APPROVED]: (v) => ({
    title: 'Attendance correction approved',
    body: `Your attendance correction${v.date ? ` for ${v.date}` : ''} was approved and the day has been updated.`,
  }),
  [NOTIFICATION_TYPES.ATTENDANCE_CORRECTION_REJECTED]: (v) => ({
    title: 'Attendance correction rejected',
    body: `Your attendance correction${v.date ? ` for ${v.date}` : ''} was rejected. Open it to see the details.`,
  }),
  [NOTIFICATION_TYPES.OVERTIME_APPROVED]: (v) => ({
    title: 'Overtime approved',
    body: `Your overtime claim${v.date ? ` for ${v.date}` : ''}${v.minutes ? ` (${v.minutes})` : ''} was approved.`,
  }),
  [NOTIFICATION_TYPES.OVERTIME_REJECTED]: (v) => ({
    title: 'Overtime rejected',
    body: `Your overtime claim${v.date ? ` for ${v.date}` : ''} was rejected. Open it to see the details.`,
  }),
  [NOTIFICATION_TYPES.PAYSLIP_AVAILABLE]: (v) => ({
    title: 'Payslip available',
    body: `Your payslip${v.date ? ` for ${v.date}` : ''} is available. Amounts are never included in a notification — open the payslip to see it.`,
  }),
  // Performance: a cycle and a name at most. Scores, ratings and review comments stay behind the plan's own
  // authorization — a notification is delivered to an inbox and quoted in support tickets.
  [NOTIFICATION_TYPES.PERFORMANCE_REVIEW_OPENED]: (v) => ({
    title: 'Performance review open',
    body: `The review stage of ${v.cycleName ?? 'your performance cycle'} is open. Open your plan to complete it.`,
  }),
  [NOTIFICATION_TYPES.PERFORMANCE_SELF_REVIEW_SUBMITTED]: (v) => ({
    title: 'Self review submitted',
    body: `${v.employeeName ?? 'An employee'} submitted their self review${v.cycleName ? ` for ${v.cycleName}` : ''}.`,
  }),
  [NOTIFICATION_TYPES.PERFORMANCE_MANAGER_REVIEW_REQUIRED]: (v) => ({
    title: 'Performance review required',
    body: `${v.employeeName ?? 'An employee'}${v.cycleName ? ` in ${v.cycleName}` : ''} is waiting for your review.`,
  }),
  [NOTIFICATION_TYPES.PERFORMANCE_FINALIZED]: (v) => ({
    title: 'Performance review complete',
    body: `Your review${v.cycleName ? ` for ${v.cycleName}` : ''} is complete. Open your plan to see the result.`,
  }),
  // Competency: a cycle and a name. A level, a gap or an assessment comment never leaves the assessment itself.
  [NOTIFICATION_TYPES.COMPETENCY_ASSESSMENT_OPENED]: (v) => ({
    title: 'Competency assessment open',
    body: `Your competency assessment${v.cycleName ? ` for ${v.cycleName}` : ''} is open. Open it to complete your self assessment.`,
  }),
  [NOTIFICATION_TYPES.COMPETENCY_SELF_ASSESSMENT_SUBMITTED]: (v) => ({
    title: 'Self assessment submitted',
    body: `${v.employeeName ?? 'An employee'} submitted their competency self assessment${v.cycleName ? ` for ${v.cycleName}` : ''}.`,
  }),
  [NOTIFICATION_TYPES.COMPETENCY_MANAGER_ASSESSMENT_REQUIRED]: (v) => ({
    title: 'Competency assessment required',
    body: `${v.employeeName ?? 'An employee'}${v.cycleName ? ` in ${v.cycleName}` : ''} is waiting for your competency assessment.`,
  }),
  [NOTIFICATION_TYPES.COMPETENCY_ASSESSMENT_FINALIZED]: (v) => ({
    title: 'Competency assessment complete',
    body: `Your competency assessment${v.cycleName ? ` for ${v.cycleName}` : ''} is complete. Open it to see your levels and any gaps.`,
  }),
  // Training and development: a course, a date, a plan. Results and development comments stay on the record.
  [NOTIFICATION_TYPES.TRAINING_ENROLLED]: (v) => ({
    title: 'Training booked',
    body: `You are booked on ${v.courseTitle ?? 'a training course'}${v.date ? ` on ${v.date}` : ''}.`,
  }),
  [NOTIFICATION_TYPES.TRAINING_SESSION_UPDATED]: (v) => ({
    title: 'Training session changed',
    body: `${v.courseTitle ?? 'A training session'}${v.date ? ` on ${v.date}` : ''} has changed. Open it to see the details.`,
  }),
  [NOTIFICATION_TYPES.TRAINING_COMPLETED]: (v) => ({
    title: 'Training recorded',
    body: `Your record for ${v.courseTitle ?? 'a training course'} has been updated. Open your training history to see it.`,
  }),
  [NOTIFICATION_TYPES.IDP_ACTIVATED]: (v) => ({
    title: 'Development plan active',
    body: `Your development plan${v.cycleName ? ` "${v.cycleName}"` : ''} is active. Open it to see what is planned.`,
  }),
  [NOTIFICATION_TYPES.IDP_COMPLETED]: (v) => ({
    title: 'Development plan complete',
    body: `Your development plan${v.cycleName ? ` "${v.cycleName}"` : ''} has been completed.`,
  }),
  // Employee relations: a document exists. Nothing about what it says — not the reason, not the action, not the case.
  [NOTIFICATION_TYPES.DISCIPLINARY_ACTION_ISSUED]: () => ({
    title: 'New employee relations document',
    body: 'A new employee relations document has been issued to you. Please open the system to read it.',
  }),
  [NOTIFICATION_TYPES.DISCIPLINARY_ACTION_ACKNOWLEDGED]: () => ({
    title: 'Document receipt acknowledged',
    body: 'An employee has acknowledged receipt of an employee relations document. Open the case to see it.',
  }),
  // Recruitment: an opening title and a date. Candidates are named only inside the ATS, where access is purpose-specific.
  [NOTIFICATION_TYPES.INTERVIEW_ASSIGNED]: (v) => ({
    title: 'Interview assigned',
    body: `You are an interviewer for ${v.openingTitle ?? 'an opening'}${v.date ? ` on ${v.date}` : ''}. Open the interview to see the details.`,
  }),
  [NOTIFICATION_TYPES.INTERVIEW_FEEDBACK_REQUIRED]: (v) => ({
    title: 'Interview feedback needed',
    body: `Your feedback for an interview for ${v.openingTitle ?? 'an opening'}${v.date ? ` on ${v.date}` : ''} has not been submitted.`,
  }),
  [NOTIFICATION_TYPES.HIRING_COMPLETED]: (v) => ({
    title: 'Hire recorded',
    body: `A candidate for ${v.openingTitle ?? 'an opening'} has been hired and an employee record created. Open the application to see it.`,
  }),
  // Talent: a cycle name. Never a potential level, a cell, a comment or a nomination.
  [NOTIFICATION_TYPES.TALENT_REVIEW_REQUIRED]: (v) => ({
    title: 'Talent review assigned',
    body: `${v.employeeName ?? 'An employee'}${v.cycleName ? ` in ${v.cycleName}` : ''} is waiting for your potential assessment.`,
  }),
  // Engagement: the survey name and, when set, its closing date. Nothing about answers or results.
  [NOTIFICATION_TYPES.ENGAGEMENT_SURVEY_OPENED]: (v) => ({
    title: 'A survey is open for you',
    body: `${v.surveyName ?? 'A survey'} is open${v.closingDate ? ` until ${v.closingDate}` : ''}. Your participation is voluntary.`,
  }),
  [NOTIFICATION_TYPES.TALENT_REVIEW_COMPLETED]: (v) => ({
    title: 'Talent review submitted',
    body: `A potential assessment${v.cycleName ? ` in ${v.cycleName}` : ''} has been submitted. Open the cycle to see progress.`,
  }),
  [NOTIFICATION_TYPES.LEAVE_CANCELLED]: (v) => ({
    title: 'Leave request cancelled',
    body: `The ${v.leaveType ?? 'leave'} request${v.dateRange ? ` for ${v.dateRange}` : ''} was cancelled.`,
  }),
};

export function renderTemplate(type: NotificationType, vars: TemplateVars) {
  return templates[type](vars);
}
