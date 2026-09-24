/**
 * Performance: the pure parts.
 *
 * Nothing here touches a database or a Decimal library — these are the rules that the API enforces and the UI is
 * allowed to *explain* (never to apply on its own). Scores and weights are decimal strings for the same reason money
 * is: `0.1 + 0.2` is not 0.3, and a weight that adds up to 99.999999 would block a review for no reason a human could
 * see.
 */

/** A rating band as the API stores it: an inclusive score range with a stable code and a label. */
export interface RatingBandLike {
  code: string;
  label: string;
  minScore: string;
  maxScore: string;
}

/** Compare two decimal strings without turning them into floats. Returns -1, 0 or 1. */
export function compareDecimal(a: string, b: string): number {
  const norm = (v: string) => {
    const negative = v.trim().startsWith('-');
    const [whole = '0', fraction = ''] = v.trim().replace(/^[+-]/, '').split('.');
    return { negative, whole: whole.replace(/^0+(?=\d)/, ''), fraction: fraction.padEnd(6, '0').slice(0, 6) };
  };
  const x = norm(a);
  const y = norm(b);
  if (x.negative !== y.negative) return x.negative ? -1 : 1;
  const sign = x.negative ? -1 : 1;
  if (x.whole.length !== y.whole.length) return x.whole.length > y.whole.length ? sign : -sign;
  if (x.whole !== y.whole) return x.whole > y.whole ? sign : -sign;
  if (x.fraction !== y.fraction) return x.fraction > y.fraction ? sign : -sign;
  return 0;
}

/** `3.5` → `3.50`, for display and for equality against a stored value. */
export function formatScore(value: string | null | undefined, places = 2): string {
  if (value === null || value === undefined || value === '') return '—';
  const negative = value.trim().startsWith('-');
  const [whole = '0', fraction = ''] = value.trim().replace(/^[+-]/, '').split('.');
  return `${negative ? '-' : ''}${whole}.${fraction.padEnd(places, '0').slice(0, places)}`;
}

/** A weight for reading: `40.00` → `40%`, `33.33` → `33.33%`. */
export function formatWeight(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  const trimmed = value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value;
  return `${trimmed}%`;
}

/**
 * The band a score falls in, or null when no band covers it.
 *
 * Bands are inclusive at both ends and must not overlap — that is validated where they are configured, so a score can
 * match at most one band here.
 */
export function resolveRatingBand<T extends RatingBandLike>(bands: T[], score: string): T | null {
  return bands.find((band) => compareDecimal(score, band.minScore) >= 0 && compareDecimal(score, band.maxScore) <= 0) ?? null;
}

/** Whether a set of bands overlaps anywhere. Used wherever bands are saved. */
export function findOverlappingBands<T extends RatingBandLike>(bands: T[]): [T, T] | null {
  const sorted = [...bands].sort((a, b) => compareDecimal(a.minScore, b.minScore));
  for (let i = 1; i < sorted.length; i++) {
    if (compareDecimal(sorted[i].minScore, sorted[i - 1].maxScore) <= 0) return [sorted[i - 1], sorted[i]];
  }
  return null;
}

/**
 * Whether the bands cover the whole scale without a gap — checked when a cycle is activated, because a finalized plan
 * whose score lands in a gap would have no rating to show.
 */
export function findBandGap<T extends RatingBandLike>(bands: T[], minScore: string, maxScore: string): string | null {
  if (bands.length === 0) return `No rating band covers ${minScore}–${maxScore}`;
  const sorted = [...bands].sort((a, b) => compareDecimal(a.minScore, b.minScore));
  if (compareDecimal(sorted[0].minScore, minScore) > 0) return `No rating band covers ${minScore}`;
  if (compareDecimal(sorted[sorted.length - 1].maxScore, maxScore) < 0) return `No rating band covers ${maxScore}`;
  return null;
}

/**
 * Progress across a plan, weighted by each item's share. **Display only** — it is a progress bar, never an input to a
 * score, which is why ordinary arithmetic is honest enough here.
 */
export function planProgressPercent(items: { progressPercent: number | null; weight: string }[]): number {
  const total = items.reduce((sum, item) => sum + Number(item.weight), 0);
  if (total <= 0) return 0;
  const weighted = items.reduce((sum, item) => sum + (item.progressPercent ?? 0) * Number(item.weight), 0);
  return Math.round(weighted / total);
}
