import type { TrainingEnrollmentStatus } from './enums';

/**
 * Training and development: the pure parts.
 *
 * The rule this module exists to protect is not arithmetic, it is a boundary: **completing a course is not the same
 * as becoming more capable.** Finishing Advanced SQL is evidence that development happened; whether somebody's SQL
 * level has actually moved is a question only a competency assessment answers. Nothing here, and nothing downstream
 * of here, raises a competency level.
 */

/** Enrolments that count in a completion rate. A cancelled enrolment is not a failure — it never happened. */
export const COMPLETION_RATE_STATUSES: readonly TrainingEnrollmentStatus[] = ['COMPLETED', 'FAILED', 'NO_SHOW'];

/**
 * Completion rate = completed ÷ (completed + failed + no-show).
 *
 * Cancelled enrolments are excluded deliberately: a session that was called off, or somebody pulled from it, says
 * nothing about whether training works, and counting it as a failure would make the number meaningless.
 * Still-enrolled people are excluded too — they have not finished yet.
 */
export function completionRate(counts: { completed: number; failed: number; noShow: number }): number | null {
  const terminal = counts.completed + counts.failed + counts.noShow;
  if (terminal === 0) return null;
  return Math.round((counts.completed / terminal) * 100);
}

/**
 * Training hours, from the session's own duration.
 *
 * Only enrolments that were actually **attended or completed** contribute: somebody who was enrolled and never
 * turned up did not spend the hours, and reporting them as if they had would overstate every figure built on top.
 */
export function trainingHours(rows: { status: TrainingEnrollmentStatus; durationMinutes: number | null }[]): number {
  const minutes = rows
    .filter((row) => row.status === 'COMPLETED' || row.status === 'ATTENDED')
    .reduce((sum, row) => sum + (row.durationMinutes ?? 0), 0);
  return Math.round((minutes / 60) * 10) / 10;
}

/** `90` → `1h 30m`, for a duration that reads rather than counts. */
export function formatDuration(minutes: number | null | undefined): string {
  if (!minutes) return '—';
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours ? `${hours}h${rest ? ` ${rest}m` : ''}` : `${rest}m`;
}

const ENROLLMENT_LABEL: Record<TrainingEnrollmentStatus, string> = {
  ENROLLED: 'Enrolled',
  ATTENDED: 'Attended',
  COMPLETED: 'Completed',
  FAILED: 'Did not pass',
  NO_SHOW: 'Did not attend',
  CANCELLED: 'Cancelled',
};
export const enrollmentStatusLabel = (status: TrainingEnrollmentStatus) => ENROLLMENT_LABEL[status] ?? status;

/**
 * Whether completing this enrolment should fulfil the need it came from.
 *
 * Only a completion does. Failing or not turning up leaves the need open — the development has not happened — and a
 * cancelled session cannot fulfil anything either.
 */
export const fulfilsNeed = (status: TrainingEnrollmentStatus) => status === 'COMPLETED';
