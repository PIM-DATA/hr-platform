/**
 * Small-group protection for aggregate outputs (Task 47).
 *
 * An aggregate is not automatically anonymous: an average over one person is that person's score, and a released total
 * minus released parts is the missing part. Two rules, used by every aggregate surface that describes people's
 * outcomes (performance, competency, employee relations, Report Center aggregate datasets, engagement):
 *
 * 1. **Minimum group size.** A cell describing fewer than `min` people (but more than none) is suppressed.
 * 2. **Complementary suppression.** Within one partition whose total is released (the departments of a cycle, the
 *    rows of a grouped report), the suppressed cells together must describe either nobody or at least `min` people —
 *    otherwise "total − visible cells" recovers them. The smallest further cells are suppressed until that holds.
 *
 * A filtered query ("only department X") is released only if X's cell survives the partition rule in the partition
 * that filter selects from; engagement applies the same rule per filter dimension with its survey's own threshold.
 * Suppressed values are reported as suppressed — never as 0 or as "no data".
 */

/** Default minimum number of people behind a released outcome aggregate. Engagement keeps its per-survey threshold. */
export const MIN_AGGREGATE_GROUP_SIZE = 5;

export interface AggregateSuppression {
  suppressed: true;
  reason: 'SMALL_GROUP' | 'COMPLEMENT';
  minimumGroupSize: number;
}
export const suppressedCell = (min: number, reason: AggregateSuppression['reason'] = 'SMALL_GROUP'): AggregateSuppression => ({ suppressed: true, reason, minimumGroupSize: min });

/**
 * Cells of one partition → the keys to suppress. `count` is the number of people a cell describes. Cells with no
 * people are never "suppressed" (there is nothing to protect and nothing to report).
 */
export function partitionSuppression(cells: readonly { key: string; count: number }[], min: number = MIN_AGGREGATE_GROUP_SIZE): Map<string, AggregateSuppression['reason']> {
  const out = new Map<string, AggregateSuppression['reason']>();
  for (const c of cells) if (c.count > 0 && c.count < min) out.set(c.key, 'SMALL_GROUP');
  let hidden = cells.filter((c) => out.has(c.key)).reduce((s, c) => s + c.count, 0);
  // Complement: keep hiding the smallest released cells until the hidden people are none or at least `min`.
  const released = cells.filter((c) => c.count > 0 && !out.has(c.key)).sort((a, b) => a.count - b.count || a.key.localeCompare(b.key));
  while (hidden > 0 && hidden < min && released.length) {
    const next = released.shift()!;
    out.set(next.key, 'COMPLEMENT');
    hidden += next.count;
  }
  return out;
}

/** True when a group of `count` people may be released on its own (ignoring complements). */
export const meetsMinimumGroup = (count: number, min: number = MIN_AGGREGATE_GROUP_SIZE) => count === 0 || count >= min;
