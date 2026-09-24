import type { CareerReadinessStatus, GapStatus, TalentBucket } from './enums';

/**
 * Pure rules for career, talent and succession (Task 28). Every function here turns facts into other facts;
 * none of them decides anything about a person.
 */

/**
 * What a set of competency gaps says about a target job. Requirements met, gaps exist, or somebody has not been
 * assessed yet — and "requirements met" means the competency requirements only. It is not a promotion decision.
 */
export function careerReadinessStatus(rows: { gapStatus: GapStatus }[]): CareerReadinessStatus {
  if (rows.length === 0) return 'NO_REQUIREMENTS_DEFINED';
  if (rows.some((r) => r.gapStatus === 'GAP')) return 'GAPS_EXIST';
  if (rows.some((r) => r.gapStatus === 'UNASSESSED')) return 'ASSESSMENT_REQUIRED';
  return 'READY_REQUIREMENTS_MET';
}

export const CAREER_READINESS_LABEL: Record<CareerReadinessStatus, string> = {
  READY_REQUIREMENTS_MET: 'Requirements met',
  GAPS_EXIST: 'Gaps to develop',
  ASSESSMENT_REQUIRED: 'Assessment required',
  NO_REQUIREMENTS_DEFINED: 'No requirements defined',
};

/** The 9-box cell name from its two axes, e.g. `HIGH_PERFORMANCE_MEDIUM_POTENTIAL`. A label, not a rank. */
export function nineBoxCell(performance: TalentBucket | null | undefined, potential: TalentBucket | null | undefined): string | null {
  if (!performance || !potential) return null;
  return `${performance}_PERFORMANCE_${potential}_POTENTIAL`;
}

export function nineBoxLabel(cell: string | null | undefined): string {
  if (!cell) return '—';
  const m = /^(LOW|MEDIUM|HIGH)_PERFORMANCE_(LOW|MEDIUM|HIGH)_POTENTIAL$/.exec(cell);
  if (!m) return cell;
  const word = (b: string) => b.charAt(0) + b.slice(1).toLowerCase();
  return `${word(m[1]!)} performance / ${word(m[2]!)} potential`;
}

/** Every cell of the matrix, potential rows top-down (HIGH first), performance columns left-right (LOW first). */
export const NINE_BOX_CELLS: string[] = (['HIGH', 'MEDIUM', 'LOW'] as const).flatMap((potential) => (['LOW', 'MEDIUM', 'HIGH'] as const).map((performance) => nineBoxCell(performance, potential)!));

/**
 * Performance-bucket rules must cover every rating band of the performance cycle exactly once. Ambiguity (a rating
 * mapped twice, or not at all) is refused rather than resolved by a default — the organization decides what "high"
 * means, not the code.
 */
export function validateBucketRules(ratingCodes: string[], rules: { ratingCode: string; bucket: TalentBucket }[]): { ok: true } | { ok: false; missing: string[]; duplicated: string[]; unknown: string[] } {
  const seen = new Map<string, number>();
  for (const r of rules) seen.set(r.ratingCode, (seen.get(r.ratingCode) ?? 0) + 1);
  const missing = ratingCodes.filter((c) => !seen.has(c));
  const duplicated = [...seen.entries()].filter(([, n]) => n > 1).map(([c]) => c);
  const unknown = [...seen.keys()].filter((c) => !ratingCodes.includes(c));
  return missing.length || duplicated.length || unknown.length ? { ok: false, missing, duplicated, unknown } : { ok: true };
}

export const bucketFor = (ratingCode: string | null | undefined, rules: { ratingCode: string; bucket: TalentBucket }[]): TalentBucket | null =>
  ratingCode ? rules.find((r) => r.ratingCode === ratingCode)?.bucket ?? null : null;
