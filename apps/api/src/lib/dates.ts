/**
 * UTC day arithmetic for values that are UTC instants by definition. Task 53: business "today" and business-day
 * boundaries are NOT computed here — they come from services/business-time (the organization's IANA zone).
 */

const DAY_MS = 86_400_000;

export function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** Start of the "last N days including today" window: startOfDay(today − (N−1)). */
export function windowStartIncludingToday(days: number, now: Date = new Date()): Date {
  return new Date(startOfUtcDay(now).getTime() - (days - 1) * DAY_MS);
}
