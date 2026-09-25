import { z } from 'zod';
import { EXIT_REASON_CATEGORIES, LIFECYCLE_TASK_CATEGORIES, LIFECYCLE_TASK_STATUSES, LIFECYCLE_TEMPLATE_TYPES, OFFBOARDING_CASE_STATUSES, OFFBOARDING_REASONS, ONBOARDING_PLAN_STATUSES, PROBATION_CASE_STATUSES, PROBATION_OUTCOMES, TASK_ASSIGNEE_TYPES, TASK_RELATIVE_TO } from '../lifecycle';
import { paginationQuerySchema } from './common';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');
const text = (max: number) => z.string().trim().max(max).nullable().optional();
const category = z.string().trim().min(1).max(40).refine((v) => LIFECYCLE_TASK_CATEGORIES.includes(v), 'Unknown category');

// ---------- templates ----------
export const templateTaskSchema = z.object({
  title: z.string().trim().min(2).max(160), description: text(1000), category, assigneeType: z.enum(TASK_ASSIGNEE_TYPES), specificUserId: z.string().min(1).nullable().optional(),
  dueOffsetDays: z.number().int().min(-365).max(365), relativeTo: z.enum(TASK_RELATIVE_TO), required: z.boolean().optional(), sortOrder: z.number().int().min(0).max(1000).optional(),
  documentCategoryId: z.string().min(1).nullable().optional(), requiresDocument: z.boolean().optional(),
}).strict().refine((v) => v.assigneeType !== 'SPECIFIC_USER' || !!v.specificUserId, { message: 'A specific-user task needs the user', path: ['specificUserId'] });
export type TemplateTaskInput = z.infer<typeof templateTaskSchema>;
export const createTemplateSchema = z.object({ code: z.string().trim().min(2).max(40).regex(/^[A-Z0-9_-]+$/i), name: z.string().trim().min(2).max(160), description: text(2000), type: z.enum(LIFECYCLE_TEMPLATE_TYPES), organizationId: z.string().min(1).nullable().optional(), tasks: z.array(templateTaskSchema).max(100).optional() }).strict();
export type CreateTemplateInput = z.infer<typeof createTemplateSchema>;
export const updateTemplateSchema = z.object({ name: z.string().trim().min(2).max(160).optional(), description: text(2000), isActive: z.boolean().optional(), tasks: z.array(templateTaskSchema).max(100).optional() }).strict();
export type UpdateTemplateInput = z.infer<typeof updateTemplateSchema>;
export const templateListQuerySchema = z.object({ type: z.enum(LIFECYCLE_TEMPLATE_TYPES).optional(), includeInactive: z.coerce.boolean().optional() });

// ---------- onboarding ----------
export const createOnboardingPlanSchema = z.object({ employeeId: z.string().min(1), templateId: z.string().min(1).nullable().optional(), startDate: date.optional(), hrOwnerUserId: z.string().min(1).nullable().optional(), applicationId: z.string().min(1).nullable().optional(), createProbation: z.boolean().optional(), probationPolicyId: z.string().min(1).nullable().optional() }).strict();
export type CreateOnboardingPlanInput = z.infer<typeof createOnboardingPlanSchema>;
export const onboardingListQuerySchema = paginationQuerySchema.extend({ status: z.enum(ONBOARDING_PLAN_STATUSES).optional(), departmentId: z.string().min(1).optional(), employeeId: z.string().min(1).optional(), search: z.string().trim().max(120).optional() });
export const addPlanTaskSchema = z.object({ title: z.string().trim().min(2).max(160), description: text(1000), category, assigneeType: z.enum(TASK_ASSIGNEE_TYPES), assigneeUserId: z.string().min(1).nullable().optional(), dueDate: date, required: z.boolean().optional(), requiresDocument: z.boolean().optional() }).strict();
export type AddPlanTaskInput = z.infer<typeof addPlanTaskSchema>;
/** Task update: a status move and/or a note and/or a document; assignment changes need manage. */
export const updateTaskSchema = z.object({ status: z.enum(LIFECYCLE_TASK_STATUSES).optional(), note: text(2000), documentId: z.string().min(1).nullable().optional(), assigneeUserId: z.string().min(1).nullable().optional(), dueDate: date.optional() }).strict().refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type UpdateTaskInput = z.infer<typeof updateTaskSchema>;

// ---------- probation ----------
export const createProbationPolicySchema = z.object({ name: z.string().trim().min(2).max(120), organizationId: z.string().min(1).nullable().optional(), durationDays: z.number().int().min(1).max(730), reviewLeadDays: z.number().int().min(0).max(90).nullable().optional(), allowExtension: z.boolean().optional(), maxExtensionDays: z.number().int().min(1).max(365).nullable().optional() }).strict();
export type CreateProbationPolicyInput = z.infer<typeof createProbationPolicySchema>;
export const updateProbationPolicySchema = createProbationPolicySchema.partial().extend({ isActive: z.boolean().optional() }).refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type UpdateProbationPolicyInput = z.infer<typeof updateProbationPolicySchema>;
export const createProbationCaseSchema = z.object({ employeeId: z.string().min(1), policyId: z.string().min(1).nullable().optional(), startDate: date.optional(), durationDays: z.number().int().min(1).max(730).optional(), reviewerUserId: z.string().min(1).nullable().optional() }).strict();
export type CreateProbationCaseInput = z.infer<typeof createProbationCaseSchema>;
export const probationListQuerySchema = paginationQuerySchema.extend({ status: z.enum(PROBATION_CASE_STATUSES).optional(), departmentId: z.string().min(1).optional(), employeeId: z.string().min(1).optional(), dueWithinDays: z.coerce.number().int().min(0).max(365).optional(), mine: z.enum(['true']).optional() });
export const reassignProbationReviewerSchema = z.object({ reviewerUserId: z.string().min(1) }).strict();
export const submitProbationReviewSchema = z.object({ outcome: z.enum(PROBATION_OUTCOMES), comment: text(4000), reviewDate: date.optional(), extensionEndDate: date.nullable().optional() }).strict()
  .refine((v) => v.outcome !== 'EXTEND' || !!v.extensionEndDate, { message: 'An extension needs its new end date', path: ['extensionEndDate'] });
export type SubmitProbationReviewInput = z.infer<typeof submitProbationReviewSchema>;

// ---------- offboarding ----------
export const createOffboardingCaseSchema = z.object({ employeeId: z.string().min(1), templateId: z.string().min(1).nullable().optional(), reasonCode: z.enum(OFFBOARDING_REASONS), reasonNote: text(2000), plannedLastWorkingDate: date, hrOwnerUserId: z.string().min(1).nullable().optional() }).strict();
export type CreateOffboardingCaseInput = z.infer<typeof createOffboardingCaseSchema>;
export const updateOffboardingCaseSchema = z.object({ reasonCode: z.enum(OFFBOARDING_REASONS).optional(), reasonNote: text(2000), plannedLastWorkingDate: date.optional(), hrOwnerUserId: z.string().min(1).nullable().optional() }).strict().refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type UpdateOffboardingCaseInput = z.infer<typeof updateOffboardingCaseSchema>;
export const offboardingListQuerySchema = paginationQuerySchema.extend({ status: z.enum(OFFBOARDING_CASE_STATUSES).optional(), departmentId: z.string().min(1).optional(), employeeId: z.string().min(1).optional(), search: z.string().trim().max(120).optional() });
export const completeSeparationSchema = z.object({ actualLastWorkingDate: date.optional(), disableAccount: z.boolean().optional() }).strict();
export type CompleteSeparationInput = z.infer<typeof completeSeparationSchema>;
export const exitInterviewSchema = z.object({ interviewDate: date, reasonCategory: z.enum(EXIT_REASON_CATEGORIES).nullable().optional(), wouldRejoin: z.boolean().nullable().optional(), note: text(4000) }).strict();
export type ExitInterviewInput = z.infer<typeof exitInterviewSchema>;
export const lifecycleReportQuerySchema = z.object({ from: date.optional(), to: date.optional(), organizationId: z.string().min(1).optional() });

// ---------- DTOs ----------
export interface TemplateTaskDto { id: string; title: string; description: string | null; category: string; assigneeType: (typeof TASK_ASSIGNEE_TYPES)[number]; specificUserId: string | null; specificUserName: string | null; dueOffsetDays: number; relativeTo: (typeof TASK_RELATIVE_TO)[number]; required: boolean; sortOrder: number; documentCategoryId: string | null; requiresDocument: boolean }
export interface LifecycleTemplateDto { id: string; code: string; name: string; description: string | null; type: (typeof LIFECYCLE_TEMPLATE_TYPES)[number]; organizationId: string | null; organizationName: string | null; isActive: boolean; taskCount: number; tasks: TemplateTaskDto[]; createdAt: string; updatedAt: string }
export interface LifecycleSnapshotDto { employeeCode: string; employeeName: string; organization: string | null; department: string | null; job: string | null; position: string | null; manager: { employeeId: string; employeeCode: string; name: string } | null }
export interface LifecycleTaskDto {
  id: string; title: string; description: string | null; category: string; assigneeType: (typeof TASK_ASSIGNEE_TYPES)[number]; assigneeUserId: string | null; assigneeName: string | null; assigneeEmployeeId: string | null; unassigned: boolean;
  dueDate: string; required: boolean; requiresDocument: boolean; documentId: string | null; documentTitle: string | null; status: (typeof LIFECYCLE_TASK_STATUSES)[number]; completedAt: string | null; completedByName: string | null; note: string | null; overdue: boolean;
  can: { update: boolean };
}
export interface ProgressDto { total: number; done: number; pct: number; requiredOpen: number; ready: boolean }
export interface OnboardingPlanDto {
  id: string; employeeId: string; templateId: string | null; templateName: string | null; snapshot: LifecycleSnapshotDto; current: { department: string | null; manager: string | null; employmentStatus: string } | null;
  hireDate: string; startDate: string; status: (typeof ONBOARDING_PLAN_STATUSES)[number]; hrOwnerUserId: string | null; hrOwnerName: string | null; applicationId: string | null; probationCaseId: string | null;
  progress: ProgressDto; unassignedTasks: number; overdueTasks: number; createdByUserId: string; activatedAt: string | null; completedAt: string | null; cancelledAt: string | null; createdAt: string; updatedAt: string; can: { manage: boolean; activate: boolean; complete: boolean };
}
export interface OnboardingPlanDetailDto extends OnboardingPlanDto { tasks: LifecycleTaskDto[] }
export interface ProbationPolicyDto { id: string; name: string; organizationId: string | null; organizationName: string | null; durationDays: number; reviewLeadDays: number | null; allowExtension: boolean; maxExtensionDays: number | null; isActive: boolean; createdAt: string; updatedAt: string }
export interface ProbationReviewDto { id: string; reviewerUserId: string; reviewerName: string | null; reviewDate: string; outcome: (typeof PROBATION_OUTCOMES)[number]; comment: string | null; extensionEndDate: string | null; submittedAt: string }
export interface ProbationCaseDto {
  id: string; employeeId: string; policyId: string | null; policyName: string | null; snapshot: LifecycleSnapshotDto; current: { department: string | null; manager: string | null; employmentStatus: string } | null;
  startDate: string; originalEndDate: string; currentEndDate: string; daysRemaining: number; reviewerUserId: string | null; reviewerName: string | null; status: (typeof PROBATION_CASE_STATUSES)[number]; finalOutcome: (typeof PROBATION_OUTCOMES)[number] | null; extensions: number;
  reviews: ProbationReviewDto[]; createdAt: string; updatedAt: string; can: { review: boolean; manage: boolean };
}
export interface OffboardingCaseDto {
  id: string; employeeId: string; templateId: string | null; templateName: string | null; snapshot: LifecycleSnapshotDto; current: { department: string | null; manager: string | null; employmentStatus: string; terminationDate: string | null; accountActive: boolean | null } | null;
  reasonCode: (typeof OFFBOARDING_REASONS)[number]; reasonNote: string | null; plannedLastWorkingDate: string; actualLastWorkingDate: string | null; status: (typeof OFFBOARDING_CASE_STATUSES)[number]; hrOwnerUserId: string | null; hrOwnerName: string | null;
  exitInterview: { interviewDate: string; reasonCategory: string | null; wouldRejoin: boolean | null; note: string | null; interviewerName: string | null } | null;
  progress: ProgressDto; unassignedTasks: number; overdueTasks: number; separation: { completedAt: string; accountDisabled: boolean; sessionsRevoked: number } | null;
  createdByUserId: string; activatedAt: string | null; completedAt: string | null; cancelledAt: string | null; createdAt: string; updatedAt: string; can: { manage: boolean; activate: boolean; completeSeparation: boolean; cancel: boolean };
}
export interface OffboardingCaseDetailDto extends OffboardingCaseDto { tasks: LifecycleTaskDto[] }
export interface MyLifecycleDto { onboarding: OnboardingPlanDetailDto | null; probation: { startDate: string; currentEndDate: string; status: string; finalOutcome: string | null; extensions: number } | null; offboarding: OffboardingCaseDetailDto | null; myTasks: { kind: 'ONBOARDING' | 'OFFBOARDING'; planId: string; employeeName: string; task: LifecycleTaskDto }[] }
export interface LifecycleDashboardDto {
  onboarding: { active: number; draft: number; completedLast90Days: number; overdueTasks: number; unassignedTasks: number; avgProgressPct: number | null };
  probation: { active: number; pendingReview: number; dueWithin14Days: number; passedLast90Days: number; extendedLast90Days: number; notPassedLast90Days: number };
  offboarding: { active: number; readyToComplete: number; departuresNext30Days: number; completedLast90Days: number; overdueTasks: number };
  upcoming: { kind: 'START' | 'PROBATION_END' | 'LAST_DAY'; date: string; employeeCode: string; employeeName: string; department: string | null; id: string }[];
  generatedAt: string;
}
export interface LifecycleReportDto {
  range: { from: string; to: string };
  onboarding: { plansStarted: number; plansCompleted: number; completionRate: number | null; overdueTasks: number; byDepartment: { department: string; plans: number; completed: number; avgProgressPct: number | null }[] };
  probation: { active: number; dueSoon: number; passed: number; extended: number; notPassed: number; byDepartment: { department: string; active: number; passed: number; extended: number; notPassed: number }[]; byMonth: { month: string; passed: number; extended: number; notPassed: number }[] };
  offboarding: { active: number; upcomingDepartures: number; completedSeparations: number; byReason: { reason: string; count: number }[]; byMonth: { month: string; completed: number }[]; byDepartment: { department: string; active: number; completed: number }[] };
}
