/**
 * OJT, learning paths and certifications — pure vocabulary and helpers (Task 35).
 *
 * Learning is recorded, never scored into a person: an observation is evidence, a completed OJT changes no
 * competency level, a certification is a record the organization tracks, and every fulfilment rule here is a
 * projection of a source domain's own completion, not a second copy of it.
 */
export const OJT_ACTIVITY_TYPES = ['OBSERVE', 'PRACTICE', 'PERFORM', 'REVIEW', 'OTHER'] as const;
export type OjtActivityType = (typeof OJT_ACTIVITY_TYPES)[number];
export const OJT_PLAN_STATUSES = ['DRAFT', 'ACTIVE', 'COMPLETED', 'CANCELLED'] as const;
export type OjtPlanStatus = (typeof OJT_PLAN_STATUSES)[number];
export const OJT_ACTIVITY_STATUSES = ['PENDING', 'IN_PROGRESS', 'COMPLETED', 'SKIPPED'] as const;
export type OjtActivityStatus = (typeof OJT_ACTIVITY_STATUSES)[number];
export const OBSERVATION_RESULTS = ['NOT_OBSERVED', 'MEETS', 'NEEDS_PRACTICE'] as const;
export type ObservationResult = (typeof OBSERVATION_RESULTS)[number];
export const OJT_ASSESSMENT_OUTCOMES = ['COMPLETED', 'MORE_PRACTICE_REQUIRED'] as const;
export type OjtAssessmentOutcome = (typeof OJT_ASSESSMENT_OUTCOMES)[number];
export const OJT_IMPORTANCE = ['CORE', 'SUPPORTING'] as const;

export const LEARNING_STEP_TYPES = ['COURSE', 'OJT_PROGRAM', 'IDP_ACTIVITY', 'CERTIFICATION'] as const;
export type LearningStepType = (typeof LEARNING_STEP_TYPES)[number];
export const PATH_ASSIGNMENT_STATUSES = ['ACTIVE', 'COMPLETED', 'CANCELLED'] as const;
export type PathAssignmentStatus = (typeof PATH_ASSIGNMENT_STATUSES)[number];
export const PATH_STEP_STATES = ['LOCKED', 'AVAILABLE', 'FULFILLED'] as const;
export type PathStepState = (typeof PATH_STEP_STATES)[number];

export const CERTIFICATION_ISSUER_TYPES = ['INTERNAL', 'EXTERNAL'] as const;
export const CERTIFICATION_STATUSES = ['ACTIVE', 'EXPIRING_SOON', 'EXPIRED', 'REVOKED'] as const;
export type CertificationStatus = (typeof CERTIFICATION_STATUSES)[number];
/** Default "expiring soon" window in days; a definition may override it. */
export const CERTIFICATION_EXPIRY_WINDOW_DAYS = 30;
export const OJT_REFLECTION_MAX_CHARS = 1000;
export const OJT_COMMENT_MAX_CHARS = 2000;

export const addDaysIso = (date: string, days: number): string => { const d = new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
export const daysUntil = (from: string, to: string): number => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/** Derived on read, never scheduled: a revoked certificate stays revoked; otherwise the expiry date decides. */
export function certificationStatus(input: { expiryDate: string | null; revokedAt: string | Date | null }, today: string, windowDays = CERTIFICATION_EXPIRY_WINDOW_DAYS): CertificationStatus {
  if (input.revokedAt) return 'REVOKED';
  if (!input.expiryDate) return 'ACTIVE';
  if (input.expiryDate < today) return 'EXPIRED';
  if (daysUntil(today, input.expiryDate) <= windowDays) return 'EXPIRING_SOON';
  return 'ACTIVE';
}

/** OJT progress: required activities decide readiness; the percentage counts every activity that is not skipped. */
export function ojtProgress(activities: { status: string; required: boolean }[]): { total: number; completed: number; pct: number; requiredOpen: number; ready: boolean } {
  const total = activities.length;
  const completed = activities.filter((a) => a.status === 'COMPLETED').length;
  const requiredOpen = activities.filter((a) => a.required && a.status !== 'COMPLETED' && a.status !== 'SKIPPED').length;
  return { total, completed, pct: total ? Math.round((completed / total) * 1000) / 10 : 0, requiredOpen, ready: requiredOpen === 0 };
}
/** An activity with observation criteria needs a MEETS result on every required criterion before it can be completed. */
export function activityCompletionBlockers(a: { requiresEvidence: boolean; documentId: string | null; criteria: { required: boolean; result: string | null }[] }): string[] {
  const out: string[] = [];
  if (a.requiresEvidence && !a.documentId) out.push('Evidence document required');
  const open = a.criteria.filter((c) => c.required && c.result !== 'MEETS');
  if (open.length) out.push(`${open.length} required criterion(s) not yet observed as met`);
  return out;
}
