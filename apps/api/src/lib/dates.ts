/** Date helpers — the only place day boundaries are computed. All boundaries are UTC (hireDate is stored as UTC midnight). */

const DAY_MS = 86_400_000;

export function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** Start of the "last N days including today" window: startOfDay(today − (N−1)). */
export function windowStartIncludingToday(days: number, now: Date = new Date()): Date {
  return new Date(startOfUtcDay(now).getTime() - (days - 1) * DAY_MS);
}
