import { z } from 'zod';
import { EXPENSE_CATEGORY_TYPES, EXPENSE_PAYMENT_METHODS, EXPENSE_POLICY_STATUSES, EXPENSE_REPORT_STATUSES, EXPENSE_RULE_TYPES, EXPENSE_TEXT_MAX, TRAVEL_REQUEST_STATUSES, type ExpenseReportStatus, type TravelRequestStatus } from '../expense';
import { paginationQuerySchema } from './common';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');
const text = (max: number) => z.string().trim().max(max).nullable().optional();
const code = z.string().trim().min(2).max(40).regex(/^[A-Z0-9_-]+$/i);
/** Money crosses the API as a string with at most two decimals. Never a JSON number. */
export const expenseMoneyField = z.string().trim().regex(/^\d{1,13}(\.\d{1,2})?$/, 'Use an amount like 4500 or 450.50 (at most two decimal places)');
const currency = z.string().trim().length(3).regex(/^[A-Z]{3}$/, 'Use a three-letter currency code, e.g. THB');

// ---------- categories ----------
export const createExpenseCategorySchema = z.object({ code, name: z.string().trim().min(2).max(120), description: text(500), type: z.enum(EXPENSE_CATEGORY_TYPES).optional() }).strict();
export type CreateExpenseCategoryInput = z.infer<typeof createExpenseCategorySchema>;
export const updateExpenseCategorySchema = createExpenseCategorySchema.omit({ code: true }).partial().extend({ isActive: z.boolean().optional() }).strict().refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type UpdateExpenseCategoryInput = z.infer<typeof updateExpenseCategorySchema>;

// ---------- expense policies ----------
export const expensePolicyRuleSchema = z.object({
  categoryId: z.string().min(1), requiresReceipt: z.boolean().optional(), receiptRequiredAbove: expenseMoneyField.nullable().optional(), perItemMaximum: expenseMoneyField.nullable().optional(),
  maximumAgeDays: z.number().int().min(1).max(730).nullable().optional(), allowedForTravelOnly: z.boolean().optional(), descriptionRequired: z.boolean().optional(),
}).strict();
export const expenseApplicabilitySchema = z.object({ ruleType: z.enum(EXPENSE_RULE_TYPES), value: z.string().trim().min(1).max(60) }).strict();
export const createExpensePolicySchema = z.object({
  code, name: z.string().trim().min(2).max(160), description: text(1000), organizationId: z.string().min(1).nullable().optional(), currency, effectiveFrom: date, effectiveTo: date.nullable().optional(),
  workflowCode: z.string().trim().min(1).max(40), maximumReportAmount: expenseMoneyField.nullable().optional(), rules: z.array(expensePolicyRuleSchema).max(50).optional(), applicability: z.array(expenseApplicabilitySchema).max(50).optional(),
}).strict().refine((v) => !v.effectiveTo || v.effectiveTo >= v.effectiveFrom, { message: 'Effective to must not be before effective from', path: ['effectiveTo'] });
export type CreateExpensePolicyInput = z.infer<typeof createExpensePolicySchema>;
export const updateExpensePolicySchema = z.object({
  name: z.string().trim().min(2).max(160).optional(), description: text(1000), organizationId: z.string().min(1).nullable().optional(), currency: currency.optional(), effectiveFrom: date.optional(), effectiveTo: date.nullable().optional(),
  workflowCode: z.string().trim().min(1).max(40).optional(), maximumReportAmount: expenseMoneyField.nullable().optional(), rules: z.array(expensePolicyRuleSchema).max(50).optional(), applicability: z.array(expenseApplicabilitySchema).max(50).optional(), status: z.enum(EXPENSE_POLICY_STATUSES).optional(),
}).strict().refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type UpdateExpensePolicyInput = z.infer<typeof updateExpensePolicySchema>;

// ---------- travel policies ----------
export const createTravelPolicySchema = z.object({ code, name: z.string().trim().min(2).max(160), description: text(1000), organizationId: z.string().min(1).nullable().optional(), currency, workflowCode: z.string().trim().min(1).max(40), expensePolicyId: z.string().min(1).nullable().optional(), maximumEstimatedAmount: expenseMoneyField.nullable().optional(), effectiveFrom: date, effectiveTo: date.nullable().optional() }).strict();
export type CreateTravelPolicyInput = z.infer<typeof createTravelPolicySchema>;
export const updateTravelPolicySchema = createTravelPolicySchema.omit({ code: true }).partial().extend({ status: z.enum(EXPENSE_POLICY_STATUSES).optional() }).strict().refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type UpdateTravelPolicyInput = z.infer<typeof updateTravelPolicySchema>;

// ---------- travel requests ----------
export const createTravelRequestSchema = z.object({ travelPolicyId: z.string().min(1), purpose: z.string().trim().min(2).max(EXPENSE_TEXT_MAX), destination: z.string().trim().min(2).max(160), startDate: date, endDate: date, estimatedAmount: expenseMoneyField }).strict().refine((v) => v.endDate >= v.startDate, { message: 'End date must not be before start date', path: ['endDate'] });
export type CreateTravelRequestInput = z.infer<typeof createTravelRequestSchema>;
export const updateTravelRequestSchema = z.object({ purpose: z.string().trim().min(2).max(EXPENSE_TEXT_MAX).optional(), destination: z.string().trim().min(2).max(160).optional(), startDate: date.optional(), endDate: date.optional(), estimatedAmount: expenseMoneyField.optional() }).strict().refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type UpdateTravelRequestInput = z.infer<typeof updateTravelRequestSchema>;
export const travelListQuerySchema = paginationQuerySchema.extend({ status: z.enum(TRAVEL_REQUEST_STATUSES).optional(), employeeId: z.string().min(1).optional(), search: z.string().trim().max(120).optional() });

// ---------- expense reports and items ----------
export const createExpenseReportSchema = z.object({ policyId: z.string().min(1).nullable().optional(), travelRequestId: z.string().min(1).nullable().optional(), title: z.string().trim().min(2).max(160) }).strict();
export type CreateExpenseReportInput = z.infer<typeof createExpenseReportSchema>;
export const updateExpenseReportSchema = z.object({ title: z.string().trim().min(2).max(160).optional(), travelRequestId: z.string().min(1).nullable().optional() }).strict().refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type UpdateExpenseReportInput = z.infer<typeof updateExpenseReportSchema>;
export const expenseItemSchema = z.object({ categoryId: z.string().min(1), expenseDate: date, amount: expenseMoneyField, merchant: text(120), description: text(EXPENSE_TEXT_MAX), originalAmount: expenseMoneyField.nullable().optional(), originalCurrency: currency.nullable().optional() }).strict();
export type ExpenseItemInput = z.infer<typeof expenseItemSchema>;
export const updateExpenseItemSchema = expenseItemSchema.partial().strict().refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type UpdateExpenseItemInput = z.infer<typeof updateExpenseItemSchema>;
export const expenseListQuerySchema = paginationQuerySchema.extend({ status: z.enum(EXPENSE_REPORT_STATUSES).optional(), policyId: z.string().min(1).optional(), employeeId: z.string().min(1).optional(), search: z.string().trim().max(120).optional() });
export const recordExpensePaymentSchema = z.object({ paymentMethod: z.enum(EXPENSE_PAYMENT_METHODS), paymentReference: text(120), paidDate: date }).strict();
export type RecordExpensePaymentInput = z.infer<typeof recordExpensePaymentSchema>;
export const sendExpenseToPayrollSchema = z.object({ payrollPeriodId: z.string().min(1), componentId: z.string().min(1) }).strict();
export type SendExpenseToPayrollInput = z.infer<typeof sendExpenseToPayrollSchema>;
export const expenseReportQuerySchema = z.object({ from: date.optional(), to: date.optional(), organizationId: z.string().min(1).optional() });

// ---------- DTOs (money as decimal strings) ----------
export interface ExpenseCategoryDto { id: string; code: string; name: string; description: string | null; type: (typeof EXPENSE_CATEGORY_TYPES)[number]; isActive: boolean }
export interface ExpensePolicyRuleDto { id: string; categoryId: string; categoryCode: string; categoryName: string; requiresReceipt: boolean; receiptRequiredAbove: string | null; perItemMaximum: string | null; maximumAgeDays: number | null; allowedForTravelOnly: boolean; descriptionRequired: boolean }
export interface ExpenseApplicabilityDto { id: string; ruleType: (typeof EXPENSE_RULE_TYPES)[number]; value: string; label: string }
export interface ExpensePolicyDto { id: string; code: string; name: string; description: string | null; organizationId: string | null; organizationName: string | null; currency: string; effectiveFrom: string; effectiveTo: string | null; workflowCode: string; maximumReportAmount: string | null; status: (typeof EXPENSE_POLICY_STATUSES)[number]; rules: ExpensePolicyRuleDto[]; applicability: ExpenseApplicabilityDto[]; reportCount: number; createdAt: string; updatedAt: string }
export interface TravelPolicyDto { id: string; code: string; name: string; description: string | null; organizationId: string | null; organizationName: string | null; currency: string; workflowCode: string; expensePolicyId: string | null; expensePolicyName: string | null; maximumEstimatedAmount: string | null; status: (typeof EXPENSE_POLICY_STATUSES)[number]; effectiveFrom: string; effectiveTo: string | null; requestCount: number }
export interface ExpenseSnapshotDto { employeeCode: string; employeeName: string; organization: string | null; department: string | null; job: string | null; position: string | null }
export interface ExpenseHistoryDto { from: string | null; to: string; actorName: string | null; reasonCode: string | null; at: string }
export interface TravelRequestDto {
  id: string; requestNumber: string; employeeId: string; travelPolicyId: string; travelPolicyName: string; snapshot: ExpenseSnapshotDto; purpose: string | null; destination: string; startDate: string; endDate: string; estimatedAmount: string; currency: string;
  status: TravelRequestStatus; workflowInstanceId: string | null; submittedAt: string | null; approvedAt: string | null; rejectedAt: string | null; cancelledAt: string | null; completedAt: string | null; expenseReports: { id: string; reportNumber: string; status: string; total: string }[]; createdAt: string; updatedAt: string;
  can: { edit: boolean; submit: boolean; cancel: boolean; complete: boolean; createExpenseReport: boolean };
}
export interface TravelRequestDetailDto extends TravelRequestDto { history: ExpenseHistoryDto[] }
export interface ExpenseItemDto { id: string; categoryId: string; categoryCode: string; categoryName: string; expenseDate: string; amount: string; merchant: string | null; description: string | null; originalAmount: string | null; originalCurrency: string | null; receiptRequired: boolean; perItemMaximum: string | null; documents: { documentId: string; title: string; documentNumber: string; accessible: boolean }[]; blockers: string[] }
export interface ExpenseReportDto {
  id: string; reportNumber: string; title: string; employeeId: string; policyId: string; policyCode: string; policyName: string; travelRequestId: string | null; travelRequestNumber: string | null; snapshot: ExpenseSnapshotDto; currency: string; total: string; itemCount: number;
  status: ExpenseReportStatus; workflowInstanceId: string | null; submittedAt: string | null; approvedAt: string | null; rejectedAt: string | null; cancelledAt: string | null; paymentMethod: string | null; paymentReference: string | null; paidDate: string | null; paidAt: string | null; payrollResultItemId: string | null; createdAt: string; updatedAt: string;
  can: { edit: boolean; submit: boolean; cancel: boolean; recordPayment: boolean; sendToPayroll: boolean };
}
export interface ExpenseReportDetailDto extends ExpenseReportDto { items: ExpenseItemDto[]; history: ExpenseHistoryDto[]; blockers: string[]; travel: { requestNumber: string; destination: string; startDate: string; endDate: string; estimatedAmount: string } | null; maximumReportAmount: string | null }
export interface ExpenseReviewDto { report: ExpenseReportDetailDto | null; travel: TravelRequestDetailDto | null; workflowInstanceId: string | null; myStepPending: boolean }
export interface ExpensePolicyConflictDto { policies: { id: string; code: string; name: string }[]; employeeCount: number }
/** How the server resolved the employee's expense policy today. RESOLVED = the unique most-specific policy; AMBIGUOUS = HR must fix applicability; NONE = no policy applies. */
export interface ExpensePolicyResolutionDto { kind: 'RESOLVED' | 'AMBIGUOUS' | 'NONE'; policy: { id: string; code: string; name: string; currency: string } | null; conflicting: { id: string; code: string; name: string }[]; message: string }
export interface MyExpensesDto { policyResolution: ExpensePolicyResolutionDto; travelRequests: TravelRequestDto[]; reports: ExpenseReportDto[]; policies: { id: string; code: string; name: string; currency: string; isDefault: boolean }[]; travelPolicies: { id: string; code: string; name: string; currency: string }[]; queue: { instanceId: string; entityType: string; entityId: string; stepName: string; requesterName: string; submittedAt: string }[] }
export interface ExpenseDashboardDto { travel: { draft: number; pendingApproval: number; approved: number; completed: number }; reports: { draft: number; pendingApproval: number; readyForPayment: number; sentToPayroll: number; paid: number; rejected: number }; money: { currency: string; pendingTotal: string; readyTotal: string; readyForPaymentTotal: string; sentToPayrollTotal: string; paidThisMonth: string; paidYearToDate: string }[]; definitions: Record<string, string>; generatedAt: string }
export interface ExpenseReportsDto {
  range: { from: string; to: string };
  byPolicy: { policy: string; currency: string; reports: number; submittedTotal: string; readyTotal: string; paidTotal: string; rejected: number }[];
  byCategory: { category: string; currency: string; items: number; total: string }[];
  byMonth: { month: string; currency: string; reports: number; total: string; paid: string }[];
  travel: { requests: number; approved: number; rejected: number; estimatedTotal: string; estimatedByCurrency: { currency: string; requests: number; estimatedTotal: string }[]; byMonth: { month: string; requests: number; estimatedTotal: string }[] };
}
