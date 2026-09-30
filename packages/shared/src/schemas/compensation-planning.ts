import { z } from 'zod';
import { isBusinessDate } from '../business-date';

/**
 * Compensation planning (Task 43) — salary-review cycles.
 *
 * A high-impact employment domain. People decide every number: the system snapshots the population and its current
 * base salary, derives the increase from the salary a person entered, checks it against a budget ceiling, keeps an
 * append-only history, and — only on an explicit, separately authorized action — hands approved salaries to the
 * compensation source. It never recommends, ranks, scores or infers anything about a person.
 */
export const COMP_CYCLE_STATUSES = ['DRAFT', 'ACTIVE', 'REVIEW', 'FINALIZED', 'ARCHIVED'] as const;
export type CompCycleStatus = (typeof COMP_CYCLE_STATUSES)[number];
export const COMP_PROPOSAL_STATUSES = ['NOT_STARTED', 'DRAFT', 'SUBMITTED', 'HR_REVIEW', 'APPROVED', 'RETURNED'] as const;
export type CompProposalStatus = (typeof COMP_PROPOSAL_STATUSES)[number];
/** Why a population row can or cannot be planned. Nothing here is a judgment about the person. */
export const COMP_ELIGIBILITY = ['ELIGIBLE', 'MISSING_COMPENSATION', 'CURRENCY_MISMATCH'] as const;
export type CompEligibility = (typeof COMP_ELIGIBILITY)[number];
/** Controlled vocabularies: a reason is a code, never free text about a person. */
export const COMP_RETURN_REASONS = ['OVER_BUDGET', 'NEEDS_JUSTIFICATION', 'POLICY_MISMATCH', 'DATA_CORRECTION', 'OTHER'] as const;
export const COMP_OVERRIDE_REASONS = ['BUDGET_ALIGNMENT', 'POLICY_ALIGNMENT', 'DATA_CORRECTION', 'CALIBRATION_OUTCOME', 'OTHER'] as const;
export const COMP_PLANNER_REASONS = ['MANAGER_CHANGED', 'NO_PLANNER', 'WORKLOAD', 'CONFLICT_OF_INTEREST', 'OTHER'] as const;
/** Why a finalized row cannot be applied to salary history right now. */
export const COMP_APPLY_BLOCKERS = ['SOURCE_COMPENSATION_CHANGED', 'EMPLOYEE_NOT_ACTIVE', 'COMPENSATION_IN_USE'] as const;
export type CompApplyBlocker = (typeof COMP_APPLY_BLOCKERS)[number];

const businessDate = z.string().refine(isBusinessDate, 'Use a real date in YYYY-MM-DD format');
/** Money on the wire is a decimal string with at most 2 places — never a JSON number. */
export const moneyString = z.string().trim().regex(/^\d{1,13}(\.\d{1,2})?$/, 'Use an amount like 31500 or 31500.50');
const currency = z.string().trim().regex(/^[A-Z]{3}$/, 'Use a 3-letter ISO currency code');

export const createCompCycleSchema = z.object({
  code: z.string().trim().min(2).max(30).regex(/^[A-Za-z0-9_-]+$/, 'Letters, digits, - and _ only'),
  name: z.string().trim().min(2).max(120),
  organizationId: z.string().min(1),
  effectiveDate: businessDate,
  currency,
  showPerformanceContext: z.boolean().default(true),
}).strict();
export type CreateCompCycleInput = z.infer<typeof createCompCycleSchema>;
export const updateCompCycleSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  effectiveDate: businessDate.optional(),
  currency: currency.optional(),
  showPerformanceContext: z.boolean().optional(),
}).strict();
export type UpdateCompCycleInput = z.infer<typeof updateCompCycleSchema>;
export const compCycleListQuerySchema = z.object({ status: z.enum(COMP_CYCLE_STATUSES).optional() }).strict();

export const setCompExclusionSchema = z.object({ employeeId: z.string().min(1), excluded: z.boolean() }).strict();
export const compBudgetSchema = z.object({ budgetAmount: moneyString }).strict();

export const updateCompProposalSchema = z.object({
  proposedBaseSalary: moneyString,
  managerComment: z.string().trim().max(500).nullable().optional(),
}).strict();
export type UpdateCompProposalInput = z.infer<typeof updateCompProposalSchema>;
export const overrideCompProposalSchema = z.object({ proposedBaseSalary: moneyString, reasonCode: z.enum(COMP_OVERRIDE_REASONS) }).strict();
export const returnCompProposalSchema = z.object({ reasonCode: z.enum(COMP_RETURN_REASONS) }).strict();
export const reassignCompPlannerSchema = z.object({ plannerUserId: z.string().min(1).nullable(), reasonCode: z.enum(COMP_PLANNER_REASONS) }).strict();
export const approveCompProposalsSchema = z.object({ plannerUserId: z.string().min(1).optional(), departmentId: z.string().min(1).optional() }).strict();

export const compCycleEmployeesQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
  departmentId: z.string().min(1).optional(),
  plannerUserId: z.string().min(1).optional(),
  status: z.enum(COMP_PROPOSAL_STATUSES).optional(),
  eligibility: z.enum(COMP_ELIGIBILITY).optional(),
  search: z.string().trim().max(80).optional(),
}).strict();
export type CompCycleEmployeesQuery = z.infer<typeof compCycleEmployeesQuerySchema>;
export const compPopulationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
  search: z.string().trim().max(80).optional(),
}).strict();

// ---------- DTOs ----------
export interface CompMoneyTotalsDto { currentBase: string; proposedBase: string; increase: string }
export interface CompBudgetDto { amount: string; used: string; remaining: string; overBudget: boolean }
export interface CompProgressDto { notStarted: number; draft: number; submitted: number; hrReview: number; approved: number; returned: number }
export interface CompCycleDto {
  id: string; code: string; name: string; organization: { id: string; name: string }; effectiveDate: string; currency: string;
  status: CompCycleStatus; showPerformanceContext: boolean;
  activatedAt: string | null; reviewStartedAt: string | null; finalizedAt: string | null; appliedAt: string | null; archivedAt: string | null;
  population: { total: number; eligible: number; missingCompensation: number; currencyMismatch: number } | null;
  progress: CompProgressDto | null;
  budget: CompBudgetDto | null;
  totals: CompMoneyTotalsDto | null;
  planners: { userId: string | null; name: string | null; rows: number; submitted: number }[];
  createdAt: string;
}
export interface CompPerformanceContextDto { cycleName: string; score: string | null; rating: string | null; finalizedAt: string | null }
export interface CompRowDto {
  id: string; proposalId: string | null;
  employee: { id: string; code: string; name: string };
  department: string | null; job: string | null; managerName: string | null;
  planner: { userId: string; name: string } | null;
  eligibility: CompEligibility;
  currentBaseSalary: string | null; currency: string | null; compensationEffectiveFrom: string | null;
  proposedBaseSalary: string | null; increaseAmount: string | null; increasePercent: string | null;
  status: CompProposalStatus | null;
  managerComment: string | null;
  performance: CompPerformanceContextDto | null;
  submittedAt: string | null; approvedAt: string | null;
  applied: { at: string; compensationId: string | null } | null;
}
export interface CompMyPlanDto {
  cycle: { id: string; code: string; name: string; effectiveDate: string; currency: string; status: CompCycleStatus };
  rows: CompRowDto[];
  totals: CompMoneyTotalsDto & { rows: number; addressed: number; submitted: number };
  canEdit: boolean; canSubmit: boolean;
}
export interface CompPopulationRowDto {
  employeeId: string; code: string; name: string; department: string; job: string | null; managerName: string | null;
  currentBaseSalary: string | null; currency: string | null; eligibility: CompEligibility; excluded: boolean;
}
export interface CompPopulationPreviewDto {
  rows: CompPopulationRowDto[]; meta: { page: number; pageSize: number; total: number };
  counts: { candidates: number; excluded: number; eligible: number; missingCompensation: number; currencyMismatch: number };
}
export interface CompHistoryDto { action: string; oldProposedBaseSalary: string | null; newProposedBaseSalary: string | null; actorName: string | null; reasonCode: string | null; at: string }
export interface CompApplyPreviewDto { toApply: number; noChange: number; alreadyApplied: boolean; blockers: { employeeCode: string; employeeName: string; reason: CompApplyBlocker }[] }
export interface CompApplyResultDto { applied: number; noChange: number; appliedAt: string }
export interface CompReportDto {
  cycle: { id: string; code: string; name: string; status: CompCycleStatus; currency: string; effectiveDate: string; applied: boolean };
  population: { total: number; eligible: number; notPlannable: number };
  completion: CompProgressDto & { addressedPercent: number | null };
  totals: CompMoneyTotalsDto & { approvedIncrease: string };
  /** Σ increase ÷ Σ current base × 100 over proposals with a value — a weighted average, 2 dp. */
  averageIncreasePercent: string | null;
  budget: CompBudgetDto | null;
  /** Compensation-authorized HR only; omitted for aggregate-only readers (an executive). */
  byDepartment: { department: string; rows: number; addressed: number; currentBase: string; proposedBase: string; increase: string }[] | null;
  generatedAt: string;
}
