export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const pad = (n: number) => String(n).padStart(2, '0');

/**
 * Task 53: a calendar date — `YYYY-MM-DD`, or the date part of a date-only column sent as UTC midnight (hire date,
 * position history) — shown as that same date in every browser zone. `new Date('2026-10-01')` is UTC midnight and
 * would read as 30 September in New York.
 */
export function formatCalendarDate(value: string | null | undefined): string {
  if (!value) return '—';
  const [y, m, d] = value.slice(0, 10).split('-').map(Number);
  return new Date(y!, m! - 1, d!).toLocaleDateString(undefined, { dateStyle: 'medium' });
}

/** A date: business dates (`YYYY-MM-DD`) as calendar dates, instants in the viewer's zone. */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  if (DATE_ONLY.test(iso)) return formatCalendarDate(iso);
  return new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' });
}

/**
 * Task 53: today's calendar date on the user's own clock, for date-picker defaults — never `toISOString()` (UTC), which
 * is yesterday in Bangkok before 07:00 and tomorrow in New York after 20:00. The server re-checks every business date
 * against the organization's timezone.
 */
export function localToday(now: Date = new Date()): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** Full integer with thousands separators (1,234) — no compact notation for HR operational numbers. */
export function formatNumber(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(n);
}

/** Time-of-day greeting; tiny helper so the wording lives in one place. */
export function greeting(now: Date = new Date()): string {
  const h = now.getHours();
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}
