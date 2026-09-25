/**
 * Employee lifecycle — onboarding, probation, offboarding (Task 34). Pure domain vocabulary and helpers.
 *
 * The employee master stays the source of truth for employment. These processes track checklists and decisions
 * beside it; the one action that changes the master is the explicit completion of an employment separation.
 */
export const LIFECYCLE_TEMPLATE_TYPES = ['ONBOARDING', 'OFFBOARDING'] as const;
export type LifecycleTemplateType = (typeof LIFECYCLE_TEMPLATE_TYPES)[number];
export const TASK_ASSIGNEE_TYPES = ['EMPLOYEE', 'MANAGER', 'HR', 'SPECIFIC_USER'] as const;
export type TaskAssigneeType = (typeof TASK_ASSIGNEE_TYPES)[number];
export const TASK_RELATIVE_TO = ['HIRE_DATE', 'START_DATE', 'LAST_WORKING_DATE', 'CASE_START'] as const;
export type TaskRelativeTo = (typeof TASK_RELATIVE_TO)[number];
export const ONBOARDING_TASK_CATEGORIES = ['PRE_START', 'DAY_1', 'FIRST_WEEK', 'FIRST_MONTH', 'DOCUMENT', 'ACCESS', 'OTHER'] as const;
export const OFFBOARDING_TASK_CATEGORIES = ['HANDOVER', 'DOCUMENT', 'ACCESS', 'PAYROLL', 'ASSET', 'EXIT_ADMIN', 'OTHER'] as const;
export const LIFECYCLE_TASK_CATEGORIES = [...new Set([...ONBOARDING_TASK_CATEGORIES, ...OFFBOARDING_TASK_CATEGORIES])] as readonly string[];
export const LIFECYCLE_TASK_STATUSES = ['PENDING', 'IN_PROGRESS', 'COMPLETED', 'SKIPPED', 'CANCELLED'] as const;
export type LifecycleTaskStatus = (typeof LIFECYCLE_TASK_STATUSES)[number];

export const ONBOARDING_PLAN_STATUSES = ['DRAFT', 'ACTIVE', 'COMPLETED', 'CANCELLED'] as const;
export type OnboardingPlanStatus = (typeof ONBOARDING_PLAN_STATUSES)[number];
export const PROBATION_CASE_STATUSES = ['ACTIVE', 'PENDING_REVIEW', 'PASSED', 'EXTENDED', 'NOT_PASSED', 'CANCELLED'] as const;
export type ProbationCaseStatus = (typeof PROBATION_CASE_STATUSES)[number];
export const PROBATION_OUTCOMES = ['PASS', 'EXTEND', 'NOT_PASS'] as const;
export type ProbationOutcome = (typeof PROBATION_OUTCOMES)[number];
export const OFFBOARDING_CASE_STATUSES = ['DRAFT', 'ACTIVE', 'READY_TO_COMPLETE', 'COMPLETED', 'CANCELLED'] as const;
export type OffboardingCaseStatus = (typeof OFFBOARDING_CASE_STATUSES)[number];
export const OFFBOARDING_REASONS = ['RESIGNATION', 'END_OF_CONTRACT', 'RETIREMENT', 'TERMINATION', 'REDUNDANCY', 'TRANSFER_OUT', 'OTHER'] as const;
export type OffboardingReason = (typeof OFFBOARDING_REASONS)[number];
export const EXIT_REASON_CATEGORIES = ['CAREER_GROWTH', 'COMPENSATION', 'MANAGEMENT', 'WORKLOAD', 'RELOCATION', 'PERSONAL', 'ROLE_FIT', 'OTHER'] as const;

/** Business-date arithmetic for due dates: YYYY-MM-DD plus a (possibly negative) number of calendar days. */
export function addCalendarDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
export const calendarDaysBetween = (from: string, to: string): number => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/**
 * Checklist progress. Denominator = tasks still part of the checklist (everything except CANCELLED); numerator =
 * COMPLETED plus SKIPPED. A percentage is bookkeeping, never a statement that a person is "ready".
 */
export function checklistProgress(tasks: { status: string; required: boolean }[]): { total: number; done: number; pct: number; requiredOpen: number; ready: boolean } {
  const active = tasks.filter((t) => t.status !== 'CANCELLED');
  const done = active.filter((t) => t.status === 'COMPLETED' || t.status === 'SKIPPED').length;
  const requiredOpen = active.filter((t) => t.required && t.status !== 'COMPLETED' && t.status !== 'SKIPPED').length;
  return { total: active.length, done, pct: active.length ? Math.round((done / active.length) * 1000) / 10 : 0, requiredOpen, ready: requiredOpen === 0 };
}
/** Allowed task transitions. Completed and cancelled are terminal for everyone but a manager's explicit reopen (not offered in the MVP). */
export const TASK_TRANSITIONS: Record<LifecycleTaskStatus, LifecycleTaskStatus[]> = { PENDING: ['IN_PROGRESS', 'COMPLETED', 'SKIPPED', 'CANCELLED'], IN_PROGRESS: ['COMPLETED', 'SKIPPED', 'CANCELLED', 'PENDING'], COMPLETED: [], SKIPPED: [], CANCELLED: [] };
