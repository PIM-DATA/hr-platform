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
  /** The service request type's name, for employee-services notifications. Never the subject, an answer or a message. */
  requestType?: string;
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
  /** Lifecycle: a task count (names and dates reuse the fields above). Never a reason note, a review comment or a security detail. */
  taskCount?: string;
  /** A benefit claim number and plan name. Never an amount, a description or a receipt name. */
  claimNumber?: string;
  planName?: string;
  /** A travel request or expense report number. Never a purpose, merchant, description, receipt or reference. */
  referenceNumber?: string;
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
  // Expense and travel (Task 39): request / report number and status only.
  [NOTIFICATION_TYPES.TRAVEL_REQUEST_SUBMITTED]: (v) => ({ title: 'Travel request submitted', body: `Travel request ${v.referenceNumber ?? ''} was submitted and is waiting for approval.` }),
  [NOTIFICATION_TYPES.TRAVEL_APPROVAL_REQUIRED]: (v) => ({ title: 'Travel request to review', body: `${v.employeeName ?? 'An employee'} submitted travel request ${v.referenceNumber ?? ''}. Please review it.` }),
  [NOTIFICATION_TYPES.TRAVEL_REQUEST_APPROVED]: (v) => ({ title: 'Travel request approved', body: `Travel request ${v.referenceNumber ?? ''} was approved. You can create an expense report from it after the trip.` }),
  [NOTIFICATION_TYPES.TRAVEL_REQUEST_REJECTED]: (v) => ({ title: 'Travel request not approved', body: `Travel request ${v.referenceNumber ?? ''} was not approved.` }),
  [NOTIFICATION_TYPES.EXPENSE_REPORT_SUBMITTED]: (v) => ({ title: 'Expense report submitted', body: `Expense report ${v.referenceNumber ?? ''} was submitted and is waiting for approval.` }),
  [NOTIFICATION_TYPES.EXPENSE_APPROVAL_REQUIRED]: (v) => ({ title: 'Expense report to review', body: `${v.employeeName ?? 'An employee'} submitted expense report ${v.referenceNumber ?? ''}. Please review it.` }),
  [NOTIFICATION_TYPES.EXPENSE_REPORT_APPROVED]: (v) => ({ title: 'Expense report approved', body: `Expense report ${v.referenceNumber ?? ''} was approved and is ready for payment.` }),
  [NOTIFICATION_TYPES.EXPENSE_REPORT_REJECTED]: (v) => ({ title: 'Expense report not approved', body: `Expense report ${v.referenceNumber ?? ''} was not approved.` }),
  [NOTIFICATION_TYPES.EXPENSE_READY_FOR_PAYMENT]: (v) => ({ title: 'Expense report ready for payment', body: `Expense report ${v.referenceNumber ?? ''} is ready for payment.` }),
  [NOTIFICATION_TYPES.EXPENSE_PAID]: (v) => ({ title: 'Expense report paid', body: `Expense report ${v.referenceNumber ?? ''} is recorded as paid.` }),
  [NOTIFICATION_TYPES.SERVICE_REQUEST_SUBMITTED]: (v) => ({ title: 'Request submitted', body: `Your ${v.requestType ?? 'service'} request ${v.referenceNumber ?? ''} was submitted to HR.` }),
  [NOTIFICATION_TYPES.SERVICE_REQUEST_ASSIGNED]: (v) => ({ title: 'Request assigned to you', body: `Service request ${v.referenceNumber ?? ''}${v.requestType ? ` (${v.requestType})` : ''} is assigned to you.` }),
  [NOTIFICATION_TYPES.SERVICE_REQUEST_WAITING_EMPLOYEE]: (v) => ({ title: 'Your request needs an answer', body: `HR is waiting for you on request ${v.referenceNumber ?? ''}. Open it to reply.` }),
  [NOTIFICATION_TYPES.SERVICE_REQUEST_FULFILLED]: (v) => ({ title: 'Request completed', body: `Service request ${v.referenceNumber ?? ''} has been completed.` }),
  [NOTIFICATION_TYPES.SERVICE_REQUEST_REJECTED]: (v) => ({ title: 'Request declined', body: `Service request ${v.referenceNumber ?? ''} was declined. Open it for the explanation.` }),
  [NOTIFICATION_TYPES.HR_LETTER_ISSUED]: (v) => ({ title: 'A letter was issued for you', body: `Letter ${v.referenceNumber ?? ''} is available in your employee services page.` }),
  [NOTIFICATION_TYPES.HR_LETTER_VOIDED]: (v) => ({ title: 'A letter was voided', body: `Letter ${v.referenceNumber ?? ''} has been voided. HR will issue a replacement if one is needed.` }),
  [NOTIFICATION_TYPES.COMP_PLAN_CYCLE_OPENED]: (v) => ({ title: 'Salary review open for planning', body: `Salary review "${v.cycleName ?? ''}" is open. Employees are assigned to you for planning.` }),
  [NOTIFICATION_TYPES.COMP_PLAN_MANAGER_SUBMITTED]: (v) => ({ title: 'Salary review plan submitted', body: `A planner submitted their plan in salary review "${v.cycleName ?? ''}".` }),
  [NOTIFICATION_TYPES.COMP_PLAN_RETURNED]: (v) => ({ title: 'Salary review proposal returned', body: `HR returned a proposal to you in salary review "${v.cycleName ?? ''}". Open your planning sheet.` }),
  [NOTIFICATION_TYPES.COMP_PLAN_READY_FOR_REVIEW]: (v) => ({ title: 'Salary review ready for HR review', body: `Every plannable row in salary review "${v.cycleName ?? ''}" has been submitted.` }),
  [NOTIFICATION_TYPES.COMP_PLAN_FINALIZED]: (v) => ({ title: 'Salary review finalized', body: `Salary review "${v.cycleName ?? ''}" is finalized. No salary has changed until HR applies it.` }),
  [NOTIFICATION_TYPES.COMP_PLAN_APPLIED]: (v) => ({ title: 'Salary review applied', body: `Salary review "${v.cycleName ?? ''}" was applied to salary history.` }),
  // Benefits (Task 36): claim number, plan name, status. Never an amount, a description, a receipt or a reviewer's words.
  [NOTIFICATION_TYPES.BENEFIT_ENROLLMENT_CONFIRMED]: (v) => ({ title: 'Benefit enrolment confirmed', body: `You are enrolled in ${v.planName ?? 'a benefit plan'}.` }),
  [NOTIFICATION_TYPES.BENEFIT_CLAIM_SUBMITTED]: (v) => ({ title: 'Claim submitted', body: `Claim ${v.claimNumber ?? ''} for ${v.planName ?? 'your benefit'} was submitted and is waiting for approval.` }),
  [NOTIFICATION_TYPES.BENEFIT_CLAIM_APPROVAL_REQUIRED]: (v) => ({ title: 'Benefit claim to review', body: `${v.employeeName ?? 'An employee'} submitted claim ${v.claimNumber ?? ''} (${v.planName ?? 'benefit'}). Please review it.` }),
  [NOTIFICATION_TYPES.BENEFIT_CLAIM_APPROVED]: (v) => ({ title: 'Claim approved', body: `Claim ${v.claimNumber ?? ''} for ${v.planName ?? 'your benefit'} was approved and is ready for payment.` }),
  [NOTIFICATION_TYPES.BENEFIT_CLAIM_REJECTED]: (v) => ({ title: 'Claim not approved', body: `Claim ${v.claimNumber ?? ''} for ${v.planName ?? 'your benefit'} was not approved. The reserved amount is available again.` }),
  [NOTIFICATION_TYPES.BENEFIT_CLAIM_READY_FOR_PAYMENT]: (v) => ({ title: 'Claim ready for payment', body: `Claim ${v.claimNumber ?? ''} is ready for payment.` }),
  [NOTIFICATION_TYPES.BENEFIT_CLAIM_PAID]: (v) => ({ title: 'Claim paid', body: `Claim ${v.claimNumber ?? ''} for ${v.planName ?? 'your benefit'} is recorded as paid.` }),
  // Learning (Task 35): program, path and certification names, dates. Never an observation, a comment or a reflection.
  [NOTIFICATION_TYPES.OJT_PLAN_ASSIGNED]: (v) => ({ title: 'You are the trainer on an OJT plan', body: `${v.employeeName ?? 'An employee'} is assigned to you for ${v.courseTitle ?? 'an OJT program'}. Record observations as activities are performed.` }),
  [NOTIFICATION_TYPES.OJT_ACTIVITY_READY]: (v) => ({ title: 'Your OJT plan is active', body: `${v.courseTitle ?? 'Your OJT program'} has started. Open My learning to see the activities.` }),
  [NOTIFICATION_TYPES.OJT_ASSESSMENT_REQUIRED]: (v) => ({ title: 'OJT assessment due', body: `${v.employeeName ?? 'A trainee'} has finished the required activities of ${v.courseTitle ?? 'an OJT program'}. Please record your assessment.` }),
  [NOTIFICATION_TYPES.OJT_COMPLETED]: (v) => ({ title: 'OJT completed', body: `Your OJT plan for ${v.courseTitle ?? 'the program'} is recorded as completed.` }),
  [NOTIFICATION_TYPES.LEARNING_PATH_ASSIGNED]: (v) => ({ title: 'A learning path was assigned to you', body: `${v.courseTitle ?? 'A learning path'} was assigned to you${v.date ? ` with a target date of ${v.date}` : ''}.` }),
  [NOTIFICATION_TYPES.CERTIFICATION_EXPIRING]: (v) => ({ title: 'Certification expiring', body: `${v.courseTitle ?? 'A certification'} expires on ${v.date ?? 'the recorded date'}.` }),
  // Lifecycle (Task 34): names, counts and dates only.
  [NOTIFICATION_TYPES.ONBOARDING_PLAN_STARTED]: (v) => ({ title: 'Your onboarding has started', body: `Your onboarding checklist is ready${v.date ? ` (start date ${v.date})` : ''}. Open My Onboarding to see your tasks.` }),
  [NOTIFICATION_TYPES.ONBOARDING_TASK_ASSIGNED]: (v) => ({ title: 'Onboarding tasks assigned to you', body: `${v.taskCount ?? 'Some'} onboarding task(s) for ${v.employeeName ?? 'a new joiner'} are assigned to you.` }),
  [NOTIFICATION_TYPES.PROBATION_REVIEW_REQUIRED]: (v) => ({ title: 'Probation review due', body: `${v.employeeName ?? 'An employee'}'s probation ends on ${v.date ?? 'the scheduled date'}. Please record your review.` }),
  [NOTIFICATION_TYPES.PROBATION_OUTCOME_RECORDED]: (v) => ({ title: 'Probation outcome recorded', body: `A probation outcome has been recorded for your probation period${v.date ? ` ending ${v.date}` : ''}.` }),
  [NOTIFICATION_TYPES.OFFBOARDING_STARTED]: (v) => ({ title: 'Offboarding checklist started', body: `Your offboarding checklist is ready${v.date ? ` (planned last working day ${v.date})` : ''}.` }),
  [NOTIFICATION_TYPES.OFFBOARDING_TASK_ASSIGNED]: (v) => ({ title: 'Offboarding tasks assigned to you', body: `${v.taskCount ?? 'Some'} offboarding task(s) for ${v.employeeName ?? 'a colleague'} are assigned to you.` }),
  [NOTIFICATION_TYPES.OFFBOARDING_COMPLETED]: (v) => ({ title: 'Employment separation completed', body: `The separation process for ${v.employeeName ?? 'an employee'} was completed${v.date ? ` (last working day ${v.date})` : ''}.` }),
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
