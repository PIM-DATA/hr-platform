import type { GapStatus } from './enums';

/**
 * Competency: the pure parts.
 *
 * The one calculation this module has is a subtraction, and it is here so that the API, the reports and the hand-off
 * to development planning all answer the same question the same way.
 */

/** What a gap calculation needs and returns. Levels are integers on a competency's own scale. */
export interface GapInput {
  requiredLevel: number | null;
  currentLevel: number | null;
}

export interface GapResult {
  /** Signed: positive means short of the requirement, negative means beyond it. Null when nobody has assessed it. */
  gap: number | null;
  /** How far short, never negative — what a development plan would act on. Null when unassessed. */
  gapNeeded: number | null;
  status: GapStatus;
}

/**
 * The gap between what a job asks for and where somebody actually is.
 *
 * **Not being assessed is not level zero.** An employee who has never been assessed on a competency has an *unknown*
 * level, which is a different fact from being assessed and found at the bottom of the scale — and reporting the two
 * the same way would invent a skill deficiency nobody measured. The overqualified case is kept as well, as a negative
 * gap: a framework that silently clamps it loses the information that somebody exceeds their job.
 */
export function calculateGap({ requiredLevel, currentLevel }: GapInput): GapResult {
  if (currentLevel === null || currentLevel === undefined) return { gap: null, gapNeeded: null, status: 'UNASSESSED' };
  if (requiredLevel === null || requiredLevel === undefined) return { gap: null, gapNeeded: null, status: 'NO_GAP' };
  const gap = requiredLevel - currentLevel;
  return {
    gap,
    gapNeeded: Math.max(0, gap),
    status: gap > 0 ? 'GAP' : gap < 0 ? 'EXCEEDS_REQUIREMENT' : 'NO_GAP',
  };
}

const GAP_LABEL: Record<GapStatus, string> = {
  UNASSESSED: 'Not assessed',
  GAP: 'Below requirement',
  NO_GAP: 'Meets requirement',
  EXCEEDS_REQUIREMENT: 'Exceeds requirement',
};
export const gapStatusLabel = (status: GapStatus) => GAP_LABEL[status] ?? status;

/** `3 · Working` — a level always reads with its label, because a bare number means nothing to the person assessed. */
export const formatLevel = (level: number | null | undefined, label?: string | null) =>
  level === null || level === undefined ? '—' : label ? `${level} · ${label}` : String(level);
