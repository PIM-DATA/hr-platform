/**
 * Business-date domain helpers — the ONLY place that parses/compares `YYYY-MM-DD` values,
 * validates IANA timezones and does working-day / leave-unit arithmetic.
 * Business dates are calendar dates (no timezone); timestamps stay UTC `Date`s elsewhere.
 */

export const WEEKDAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

// ---------- YYYY-MM-DD ----------
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** True only for a real calendar date in canonical `YYYY-MM-DD` form (2028-02-29 ok, 2026-02-30 / 2026-9-2 not). */
export function isBusinessDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const m = DATE_RE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

/** Lexicographic compare is exact for canonical dates: negative, zero or positive. */
export function compareBusinessDate(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Converts a business date to a UTC-midnight `Date` (for arithmetic only, never for display). */
export function toUtcDate(date: string): Date {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
export function fromUtcDate(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}
export function addDays(date: string, days: number): string {
  const d = toUtcDate(date);
  d.setUTCDate(d.getUTCDate() + days);
  return fromUtcDate(d);
}

/** Every date from `from` to `to` inclusive (empty when from > to). */
export function enumerateDates(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; compareBusinessDate(d, to) <= 0; d = addDays(d, 1)) out.push(d);
  return out;
}

export function weekdayOf(date: string): Weekday {
  const js = toUtcDate(date).getUTCDay(); // 0 = Sunday
  return WEEKDAYS[(js + 6) % 7];
}

// ---------- timezone ----------
const IANA_RE = /^(UTC|[A-Za-z]+(?:\/[A-Za-z0-9_+-]+)+)$/;

/** Accepts IANA names such as Asia/Bangkok or UTC; rejects offsets (+07:00), GMT+7 variants and free text. */
export function isValidTimezone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !IANA_RE.test(tz)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The business date "today" in `timezone` for a given instant (default: now). Injectable for tests. */
export function businessToday(timezone: string, now: Date = new Date()): string {
  if (!isValidTimezone(timezone)) throw new RangeError(`Invalid timezone: ${String(timezone)}`);
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

// ---------- working days ----------
/** Normalizes a working-day list: known codes only, unique, deterministic MON..SUN order, at least one. Returns null when invalid. */
export function normalizeWorkingDays(input: unknown): Weekday[] | null {
  if (!Array.isArray(input) || input.length === 0) return null;
  const set = new Set<string>();
  for (const v of input) {
    if (typeof v !== 'string' || !(WEEKDAYS as readonly string[]).includes(v) || set.has(v)) return null;
    set.add(v);
  }
  return WEEKDAYS.filter((d) => set.has(d));
}

export function isWorkingDay(date: string, workingDays: readonly Weekday[]): boolean {
  return workingDays.includes(weekdayOf(date));
}

export interface WorkingCalendar {
  workingDays: readonly Weekday[];
  /** Active holiday dates (YYYY-MM-DD). A holiday on a non-working day is simply ignored. */
  holidays: ReadonlySet<string> | readonly string[];
}

/** Dates in [from, to] that are working days and not holidays. */
export function enumerateWorkingDays(calendar: WorkingCalendar, from: string, to: string): string[] {
  const holidays = calendar.holidays instanceof Set ? calendar.holidays : new Set(calendar.holidays);
  return enumerateDates(from, to).filter((d) => isWorkingDay(d, calendar.workingDays) && !holidays.has(d));
}

// ---------- leave units (Phase 2 precision: half-day) ----------
/** Units are whole or half days: >= 0 and a multiple of 0.5. */
export function isHalfDayUnit(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 && Number.isInteger(n * 2);
}

/** `startPart` FULL|PM (PM = leave starts at noon of startDate); `endPart` FULL|AM (AM = leave ends at noon of endDate). */
export type StartPart = 'FULL' | 'PM';
export type EndPart = 'FULL' | 'AM';

export interface LeaveUnitsInput {
  calendar: WorkingCalendar;
  startDate: string;
  endDate: string;
  startPart: StartPart;
  endPart: EndPart;
}
export type LeaveUnitsResult = { ok: true; units: number; workingDays: string[] } | { ok: false; code: 'INVALID_DATE_RANGE' | 'INVALID_HALF_DAY_BOUNDARY' | 'HALF_DAY_ON_NON_WORKING_DAY' };

/**
 * Leave units = working days in the range, minus 0.5 for a PM start and 0.5 for an AM end.
 * Same-day PM→AM is invalid (it would be a zero-length "middle" of a day). A half-day boundary must
 * fall on a working day (otherwise it has no work units to take). Non-working days and holidays never count.
 */
export function calculateLeaveUnits(input: LeaveUnitsInput): LeaveUnitsResult {
  const { startDate, endDate, startPart, endPart } = input;
  if (compareBusinessDate(startDate, endDate) > 0) return { ok: false, code: 'INVALID_DATE_RANGE' };
  if (startDate === endDate && startPart === 'PM' && endPart === 'AM') return { ok: false, code: 'INVALID_HALF_DAY_BOUNDARY' };
  const workingDays = enumerateWorkingDays(input.calendar, startDate, endDate);
  const working = new Set(workingDays);
  if (startPart === 'PM' && !working.has(startDate)) return { ok: false, code: 'HALF_DAY_ON_NON_WORKING_DAY' };
  if (endPart === 'AM' && !working.has(endDate)) return { ok: false, code: 'HALF_DAY_ON_NON_WORKING_DAY' };
  let units = workingDays.length;
  if (startPart === 'PM') units -= 0.5;
  if (endPart === 'AM') units -= 0.5;
  return { ok: true, units, workingDays };
}
