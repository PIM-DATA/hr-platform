import { z } from 'zod';
import { BENEFIT_ADJUSTMENT_REASONS, BENEFIT_CLAIM_DESCRIPTION_MAX, BENEFIT_CLAIM_STATUSES, BENEFIT_ENROLLMENT_SOURCES, BENEFIT_ENROLLMENT_STATUSES, BENEFIT_LEDGER_ENTRY_TYPES, BENEFIT_OVERRIDE_MODES, BENEFIT_OVERRIDE_REASONS, BENEFIT_PAYMENT_METHODS, BENEFIT_PERIOD_STATUSES, BENEFIT_PLAN_STATUSES, BENEFIT_PLAN_TYPES, BENEFIT_RULE_TYPES, BENEFIT_SENSITIVITIES, type BenefitClaimStatus } from '../benefits';
import { paginationQuerySchema } from './common';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');
const text = (max: number) => z.string().trim().max(max).nullable().optional();
const code = z.string().trim().min(2).max(40).regex(/^[A-Z0-9_-]+$/i);
/** Money crosses the API as a string with at most two decimals. It is never a JSON number. */
export const benefitMoneyField = z.string().trim().regex(/^\d{1,13}(\.\d{1,2})?$/, 'Use an amount like 10000 or 1250.50 (at most two decimal places)');
const signedMoney = z.string().trim().regex(/^-?\d{1,13}(\.\d{1,2})?$/, 'Use an amount like 500 or -250.00 (at most two decimal places)');
const currency = z.string().trim().length(3).regex(/^[A-Z]{3}$/, 'Use a three-letter currency code, e.g. THB');

// ---------- categories and plans ----------
export const createBenefitCategorySchema = z.object({ code, name: z.string().trim().min(2).max(120), description: text(500) }).strict();
export type CreateBenefitCategoryInput = z.infer<typeof createBenefitCategorySchema>;
export const updateBenefitCategorySchema = createBenefitCategorySchema.omit({ code: true }).partial().extend({ isActive: z.boolean().optional() }).strict().refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type UpdateBenefitCategoryInput = z.infer<typeof updateBenefitCategorySchema>;

export const benefitRuleSchema = z.object({ ruleType: z.enum(BENEFIT_RULE_TYPES), value: z.string().trim().min(1).max(60) }).strict();
export const createBenefitPlanSchema = z.object({
  code, name: z.string().trim().min(2).max(160), description: text(2000), categoryId: z.string().min(1), organizationId: z.string().min(1).nullable().optional(),
  planType: z.enum(BENEFIT_PLAN_TYPES), currency: currency.nullable().optional(), defaultEntitlementAmount: benefitMoneyField.nullable().optional(), perClaimMaximum: benefitMoneyField.nullable().optional(),
  requiresDocument: z.boolean().optional(), employeeSelectable: z.boolean().optional(), allowPostEmploymentClaims: z.boolean().optional(), sensitivity: z.enum(BENEFIT_SENSITIVITIES).optional(),
  workflowDefinitionCode: z.string().trim().min(1).max(40).nullable().optional(), effectiveFrom: date, effectiveTo: date.nullable().optional(), rules: z.array(benefitRuleSchema).max(50).optional(),
}).strict().superRefine((v, ctx) => {
  if (v.planType !== 'COVERAGE_ONLY' && !v.currency) ctx.addIssue({ code: 'custom', path: ['currency'], message: 'A monetary plan needs a currency' });
  if (v.planType !== 'COVERAGE_ONLY' && !v.workflowDefinitionCode) ctx.addIssue({ code: 'custom', path: ['workflowDefinitionCode'], message: 'A monetary plan needs an approval workflow for its claims' });
  if (v.effectiveTo && v.effectiveTo < v.effectiveFrom) ctx.addIssue({ code: 'custom', path: ['effectiveTo'], message: 'Effective to must not be before effective from' });
});
export type CreateBenefitPlanInput = z.infer<typeof createBenefitPlanSchema>;
export const updateBenefitPlanSchema = z.object({
  name: z.string().trim().min(2).max(160).optional(), description: text(2000), categoryId: z.string().min(1).optional(), organizationId: z.string().min(1).nullable().optional(),
  currency: currency.nullable().optional(), defaultEntitlementAmount: benefitMoneyField.nullable().optional(), perClaimMaximum: benefitMoneyField.nullable().optional(),
  requiresDocument: z.boolean().optional(), employeeSelectable: z.boolean().optional(), allowPostEmploymentClaims: z.boolean().optional(), sensitivity: z.enum(BENEFIT_SENSITIVITIES).optional(),
  workflowDefinitionCode: z.string().trim().min(1).max(40).nullable().optional(), effectiveFrom: date.optional(), effectiveTo: date.nullable().optional(), rules: z.array(benefitRuleSchema).max(50).optional(),
  status: z.enum(BENEFIT_PLAN_STATUSES).optional(),
}).strict().refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type UpdateBenefitPlanInput = z.infer<typeof updateBenefitPlanSchema>;
export const benefitPlanListQuerySchema = z.object({ status: z.enum(BENEFIT_PLAN_STATUSES).optional(), categoryId: z.string().min(1).optional(), planType: z.enum(BENEFIT_PLAN_TYPES).optional(), includeInactive: z.coerce.boolean().optional() });

// ---------- eligibility ----------
export const eligibilityPreviewQuerySchema = z.object({ asOfDate: date.optional(), includeEmployees: z.coerce.boolean().optional() });
export const setEligibilityOverrideSchema = z.object({ employeeId: z.string().min(1), mode: z.enum(BENEFIT_OVERRIDE_MODES), reasonCode: z.enum(BENEFIT_OVERRIDE_REASONS), note: text(300) }).strict();
export type SetEligibilityOverrideInput = z.infer<typeof setEligibilityOverrideSchema>;

// ---------- periods ----------
export const createBenefitPeriodSchema = z.object({ planId: z.string().min(1), name: z.string().trim().min(2).max(120), periodStart: date, periodEnd: date, entitlementAmount: benefitMoneyField.nullable().optional() }).strict().refine((v) => v.periodEnd >= v.periodStart, { message: 'Period end must not be before period start', path: ['periodEnd'] });
export type CreateBenefitPeriodInput = z.infer<typeof createBenefitPeriodSchema>;
export const updateBenefitPeriodSchema = z.object({ name: z.string().trim().min(2).max(120).optional(), periodStart: date.optional(), periodEnd: date.optional(), entitlementAmount: benefitMoneyField.nullable().optional() }).strict().refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type UpdateBenefitPeriodInput = z.infer<typeof updateBenefitPeriodSchema>;
export const benefitPeriodListQuerySchema = z.object({ planId: z.string().min(1).optional(), status: z.enum(BENEFIT_PERIOD_STATUSES).optional() });

// ---------- enrollment and entitlements ----------
export const enrollBenefitSchema = z.object({ employeeId: z.string().min(1), coverageStart: date.nullable().optional(), coverageEnd: date.nullable().optional() }).strict();
export type EnrollBenefitInput = z.infer<typeof enrollBenefitSchema>;
export const selfEnrollBenefitSchema = z.object({ coverageStart: date.nullable().optional() }).strict();
export const endEnrollmentSchema = z.object({ coverageEnd: date.nullable().optional() }).strict();
export const benefitEnrollmentListQuerySchema = paginationQuerySchema.extend({ planId: z.string().min(1).optional(), status: z.enum(BENEFIT_ENROLLMENT_STATUSES).optional(), employeeId: z.string().min(1).optional() });
export const generateEntitlementsSchema = z.object({ periodId: z.string().min(1), employeeIds: z.array(z.string().min(1)).min(1).max(5000).optional() }).strict();
export type GenerateEntitlementsInput = z.infer<typeof generateEntitlementsSchema>;
export const adjustBenefitEntitlementSchema = z.object({ amount: signedMoney.refine((v) => !/^-?0+(\.0+)?$/.test(v), 'An adjustment of zero changes nothing'), reasonCode: z.enum(BENEFIT_ADJUSTMENT_REASONS), note: text(300) }).strict();
export type AdjustBenefitEntitlementInput = z.infer<typeof adjustBenefitEntitlementSchema>;
export const benefitEntitlementListQuerySchema = paginationQuerySchema.extend({ planId: z.string().min(1).optional(), periodId: z.string().min(1).optional(), employeeId: z.string().min(1).optional() });

// ---------- claims ----------
export const createBenefitClaimSchema = z.object({ planId: z.string().min(1), periodId: z.string().min(1), claimedAmount: benefitMoneyField, serviceDate: date, description: text(BENEFIT_CLAIM_DESCRIPTION_MAX) }).strict();
export type CreateBenefitClaimInput = z.infer<typeof createBenefitClaimSchema>;
export const updateBenefitClaimSchema = z.object({ periodId: z.string().min(1).optional(), claimedAmount: benefitMoneyField.optional(), serviceDate: date.optional(), description: text(BENEFIT_CLAIM_DESCRIPTION_MAX) }).strict().refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type UpdateBenefitClaimInput = z.infer<typeof updateBenefitClaimSchema>;
export const claimListQuerySchema = paginationQuerySchema.extend({ status: z.enum(BENEFIT_CLAIM_STATUSES).optional(), planId: z.string().min(1).optional(), periodId: z.string().min(1).optional(), employeeId: z.string().min(1).optional(), search: z.string().trim().max(120).optional() });
export const recordBenefitPaymentSchema = z.object({ paymentMethod: z.enum(BENEFIT_PAYMENT_METHODS), paymentReference: text(120), paidDate: date }).strict();
export type RecordBenefitPaymentInput = z.infer<typeof recordBenefitPaymentSchema>;
export const sendClaimToPayrollSchema = z.object({ payrollPeriodId: z.string().min(1), componentId: z.string().min(1) }).strict();
export type SendClaimToPayrollInput = z.infer<typeof sendClaimToPayrollSchema>;
export const benefitsReportQuerySchema = z.object({ from: date.optional(), to: date.optional(), organizationId: z.string().min(1).optional() });

// ---------- DTOs (all money as decimal strings) ----------
export interface BenefitCategoryDto { id: string; code: string; name: string; description: string | null; isActive: boolean; planCount: number }
export interface BenefitRuleDto { id: string; ruleType: (typeof BENEFIT_RULE_TYPES)[number]; value: string; label: string }
export interface BenefitPlanDto {
  id: string; code: string; name: string; description: string | null; categoryId: string; categoryName: string; organizationId: string | null; organizationName: string | null;
  planType: (typeof BENEFIT_PLAN_TYPES)[number]; currency: string | null; defaultEntitlementAmount: string | null; perClaimMaximum: string | null; requiresDocument: boolean; employeeSelectable: boolean; allowPostEmploymentClaims: boolean;
  sensitivity: (typeof BENEFIT_SENSITIVITIES)[number]; workflowDefinitionCode: string | null; status: (typeof BENEFIT_PLAN_STATUSES)[number]; effectiveFrom: string; effectiveTo: string | null; rules: BenefitRuleDto[];
  counts: { enrollments: number; periods: number }; createdAt: string; updatedAt: string;
}
export interface EligibilityResultDto { eligible: boolean; reasons: { code: string; message: string }[]; matchedRules: string[]; override: { mode: (typeof BENEFIT_OVERRIDE_MODES)[number]; reasonCode: string } | null; asOfDate: string }
export interface EligibilityPreviewDto { planId: string; asOfDate: string; eligible: number; ineligible: number; employees?: { employeeId: string; employeeCode: string; name: string; department: string | null; eligible: boolean; reasons: string[] }[] }
export interface EligibilityOverrideDto { id: string; employeeId: string; employeeCode: string; employeeName: string; mode: (typeof BENEFIT_OVERRIDE_MODES)[number]; reasonCode: string; note: string | null; supersededAt: string | null; createdByName: string | null; createdAt: string }
export interface BenefitPeriodDto { id: string; planId: string; planName: string; planCode: string; name: string; periodStart: string; periodEnd: string; status: (typeof BENEFIT_PERIOD_STATUSES)[number]; entitlementAmountSnapshot: string | null; perClaimMaximumSnapshot: string | null; currencySnapshot: string | null; requiresDocumentSnapshot: boolean; openedAt: string | null; closedAt: string | null; entitlementCount: number; createdAt: string }
export interface BenefitSnapshotDto { employeeCode: string; employeeName: string; organization: string | null; department: string | null; job: string | null; position: string | null }
export interface BenefitEnrollmentDto { id: string; employeeId: string; planId: string; planName: string; planCode: string; planType: (typeof BENEFIT_PLAN_TYPES)[number]; categoryName: string; snapshot: BenefitSnapshotDto; status: (typeof BENEFIT_ENROLLMENT_STATUSES)[number]; source: (typeof BENEFIT_ENROLLMENT_SOURCES)[number] | null; enrolledAt: string | null; waivedAt: string | null; endedAt: string | null; coverageStart: string | null; coverageEnd: string | null; createdAt: string }
export interface BenefitBalanceDto { currency: string; granted: string; adjustment: string; reserved: string; consumed: string; available: string }
export interface BenefitLedgerEntryDto { id: string; entryType: (typeof BENEFIT_LEDGER_ENTRY_TYPES)[number]; amount: string; claimId: string | null; claimNumber: string | null; reasonCode: string | null; note: string | null; createdByName: string | null; createdAt: string }
export interface BenefitEntitlementDto { id: string; employeeId: string; planId: string; planName: string; planCode: string; periodId: string; periodName: string; periodStart: string; periodEnd: string; periodStatus: (typeof BENEFIT_PERIOD_STATUSES)[number]; snapshot: BenefitSnapshotDto; balance: BenefitBalanceDto; perClaimMaximum: string | null; requiresDocument: boolean; createdAt: string }
export interface BenefitEntitlementDetailDto extends BenefitEntitlementDto { ledger: BenefitLedgerEntryDto[] }
export interface BenefitClaimHistoryDto { from: string | null; to: string; actorName: string | null; reasonCode: string | null; at: string }
export interface BenefitClaimDocumentDto { documentId: string; title: string; documentNumber: string; accessible: boolean }
export interface BenefitClaimDto {
  id: string; claimNumber: string; employeeId: string; planId: string; periodId: string; entitlementId: string | null; planName: string; planCode: string; categoryName: string; snapshot: BenefitSnapshotDto;
  currency: string; claimedAmount: string; approvedAmount: string | null; serviceDate: string; submittedDate: string | null; description: string | null; status: BenefitClaimStatus;
  workflowInstanceId: string | null; approvedAt: string | null; rejectedAt: string | null; cancelledAt: string | null; paymentMethod: string | null; paymentReference: string | null; paidDate: string | null; paidAt: string | null; payrollResultItemId: string | null;
  requiresDocument: boolean; documentCount: number; createdAt: string; updatedAt: string;
  can: { edit: boolean; submit: boolean; cancel: boolean; recordPayment: boolean; sendToPayroll: boolean; review: boolean };
}
export interface BenefitClaimDetailDto extends BenefitClaimDto { documents: BenefitClaimDocumentDto[]; history: BenefitClaimHistoryDto[]; balance: BenefitBalanceDto | null; perClaimMaximum: string | null; blockers: string[] }
export interface ClaimReviewDto { claim: BenefitClaimDetailDto; workflowInstanceId: string | null; myStepPending: boolean; descriptionVisible: boolean }
export interface MyBenefitsDto {
  enrollments: BenefitEnrollmentDto[]; entitlements: BenefitEntitlementDto[]; claims: BenefitClaimDto[]; coverage: BenefitEnrollmentDto[];
  selectablePlans: { id: string; code: string; name: string; planType: (typeof BENEFIT_PLAN_TYPES)[number]; categoryName: string; requiresDocument: boolean; eligible: boolean; reasons: string[]; enrollmentStatus: string | null }[];
}
export interface BenefitsDashboardDto {
  plans: { active: number; draft: number; inactive: number }; enrollments: { enrolled: number; waived: number; eligible: number }; periods: { open: number };
  claims: { draft: number; pendingApproval: number; readyForPayment: number; sentToPayroll: number; paid: number; rejected: number; cancelled: number };
  money: { currency: string; granted: string; reserved: string; consumed: string; available: string; claimedPending: string; approved: string; readyForPayment: string; sentToPayroll: string; paid: string }[];
  definitions: Record<string, string>; generatedAt: string;
}
/**
 * Money in the benefits report is always keyed by currency — the currency recorded on the entitlement or claim
 * row, never the plan's current setting — and never added across currencies. There is no FX conversion.
 */
export interface BenefitMoneyByCurrencyDto { currency: string; granted: string; consumed: string; available: string; approvedAmount: string; paidAmount: string }
export interface BenefitsReportDto {
  range: { from: string; to: string };
  byPlan: { plan: string; category: string; planType: string; enrolled: number; entitlements: number; claims: number; approvedClaims: number; rejectedClaims: number; amounts: BenefitMoneyByCurrencyDto[] }[];
  byCategory: { category: string; plans: number; enrolled: number; claims: number; amounts: { currency: string; approvedAmount: string; paidAmount: string }[] }[];
  claimsByStatus: { status: string; count: number; amounts: { currency: string; count: number; amount: string }[] }[];
  /** Per currency across all plans in the report. */
  totals: BenefitMoneyByCurrencyDto[];
}
