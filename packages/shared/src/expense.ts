/**
 * Expense and travel vocabulary (Task 39). Business expenditure reimbursed to an employee — a different thing from
 * a welfare entitlement (Benefits, Task 36), which is why nothing here shares a table or a status word by accident.
 */
export const EXPENSE_CATEGORY_TYPES = ['GENERAL', 'TRAVEL'] as const;
export const EXPENSE_POLICY_STATUSES = ['DRAFT', 'ACTIVE', 'INACTIVE', 'ARCHIVED'] as const;
/** Allow-listed employee-master dimensions for policy applicability. No field exists for a protected attribute. */
export const EXPENSE_RULE_TYPES = ['ORGANIZATION', 'DEPARTMENT', 'JOB', 'POSITION', 'EMPLOYMENT_TYPE', 'EMPLOYMENT_STATUS'] as const;
/**
 * Policy precedence when several ACTIVE policies apply to one employee on one date: the most specific applicability
 * wins (POSITION > JOB > DEPARTMENT > ORGANIZATION > EMPLOYMENT_TYPE / STATUS > unrestricted). Two policies at the same
 * specificity are an ambiguous configuration and are refused (409), never picked at random.
 */
export const EXPENSE_RULE_SPECIFICITY: Record<(typeof EXPENSE_RULE_TYPES)[number], number> = { POSITION: 5, JOB: 4, DEPARTMENT: 3, ORGANIZATION: 2, EMPLOYMENT_TYPE: 1, EMPLOYMENT_STATUS: 1 };
export const TRAVEL_REQUEST_STATUSES = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'CANCELLED', 'COMPLETED'] as const;
export type TravelRequestStatus = (typeof TRAVEL_REQUEST_STATUSES)[number];
/** APPROVED and READY_FOR_PAYMENT are one state: final approval makes a report ready for payment at once. */
export const EXPENSE_REPORT_STATUSES = ['DRAFT', 'PENDING_APPROVAL', 'READY_FOR_PAYMENT', 'SENT_TO_PAYROLL', 'PAID', 'REJECTED', 'CANCELLED'] as const;
export type ExpenseReportStatus = (typeof EXPENSE_REPORT_STATUSES)[number];
export const EXPENSE_PAYMENT_METHODS = ['EXTERNAL', 'PAYROLL', 'OTHER'] as const;
export const EXPENSE_TEXT_MAX = 300;
export const EXPENSE_WORKFLOW = { module: 'expense', travel: 'TRAVEL_REQUEST', report: 'EXPENSE_REPORT' } as const;
/**
 * Receipt threshold semantics: a receipt is required when `amount >= receiptRequiredAbove` (inclusive). With a
 * threshold of 500.00, 499.99 needs none and 500.00 does. Compared as exact decimals on the server.
 */
export const RECEIPT_THRESHOLD_INCLUSIVE = true;
