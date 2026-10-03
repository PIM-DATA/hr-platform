/**
 * Attendance domain maths — the ONLY place that turns a shift, a schedule, approved leave and two timestamps into a
 * day's attendance. Pure and deterministic: no database, no clock of its own (`now` is an input), so every rule here
 * is testable on its own and the same numbers are produced wherever it runs.
 *
 * Two kinds of time live side by side, as they do in the Leave module:
 *   - **business dates** are calendar dates (`YYYY-MM-DD`) in the organization's timezone;
 *   - **timestamps** are UTC instants.
 * A shift's `08:00` is a wall-clock time in the organization's timezone, so it becomes a different instant in summer
 * and winter, and in a different timezone. Nothing here assumes an offset.
 */
import { addDays, isBusinessDate, isValidTimezone } from './business-date';
import type { AttendanceDayType, AttendanceStatus } from './enums';

// ---------- HH:mm ----------
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isClockTime(value: unknown): value is string {
  return typeof value === 'string' && TIME_RE.test(value);
}
/** Minutes from midnight for a `HH:mm` wall-clock time. */
export function minutesOfDay(time: string): number {
  const m = TIME_RE.exec(time);
  if (!m) throw new RangeError(`Invalid time: ${String(time)}`);
  return Number(m[1]) * 60 + Number(m[2]);
}
/** `HH:mm` for a number of minutes from midnight (wraps within the day). */
export function clockTimeOf(minutes: number): string {
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** A shift whose end is at or before its start runs into the next day. Derived, never trusted from input. */
export function isOvernightShift(startTime: string, endTime: string): boolean {
  return minutesOfDay(endTime) <= minutesOfDay(startTime);
}

// ---------- timezone ----------
/** The offset (ms) of `instant` in `timezone`, e.g. +7h for Asia/Bangkok. */
export function timezoneOffsetMs(instant: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
  return asUtc - instant.getTime();
}

/**
 * The UTC instant of a wall-clock time on a business date in a timezone.
 *
 * Two passes: guess the instant as if the timezone were UTC, read the real offset at that guess, then correct. One
 * pass is wrong across a DST change, because the offset that applies depends on the instant you are computing.
 * (During a spring-forward gap the requested wall time does not exist; the result is the instant the clock jumps to,
 * which is the only defensible answer.)
 */
export function zonedTimeToUtc(date: string, time: string, timezone: string): Date {
  if (!isBusinessDate(date)) throw new RangeError(`Invalid business date: ${String(date)}`);
  if (!isClockTime(time)) throw new RangeError(`Invalid time: ${String(time)}`);
  if (!isValidTimezone(timezone)) throw new RangeError(`Invalid timezone: ${String(timezone)}`);
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const firstPass = new Date(guess - timezoneOffsetMs(new Date(guess), timezone));
  return new Date(guess - timezoneOffsetMs(firstPass, timezone));
}

/**
 * Task 53: the instant a business date begins in a timezone (local 00:00). A local day is not always 24 hours — it
 * is 23 or 25 across a DST change — so day boundaries are always computed, never `date + 86_400_000`.
 */
export function businessDayStart(date: string, timezone: string): Date {
  return zonedTimeToUtc(date, '00:00', timezone);
}
/** Instants covering the business dates `from`..`to` inclusive in a timezone: `[start of from, start of the day after to)`. */
export function businessDateRangeInstants(from: string, to: string, timezone: string): { gte: Date; lt: Date } {
  return { gte: businessDayStart(from, timezone), lt: businessDayStart(addDays(to, 1), timezone) };
}

/** The business date an instant falls on, in a timezone (the inverse of the date part of `zonedTimeToUtc`). */
export function businessDateOf(instant: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(instant);
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

// ---------- shift window ----------
export interface AttendanceShiftSpec {
  code: string;
  startTime: string;
  endTime: string;
  breakMinutes: number;
  lateGraceMinutes: number;
  earlyLeaveGraceMinutes: number;
}

export interface ShiftWindow {
  start: Date;
  end: Date;
  spanMinutes: number;
  /** Paid working time the shift asks for: the span minus the unpaid break. */
  requiredMinutes: number;
}

/**
 * The instants a shift covers on a business date. An overnight shift (20:00 → 05:00) ends on the following calendar
 * day, but the attendance day is the day it **started** — that is the rule the rest of the module follows.
 */
export function shiftWindow(shift: AttendanceShiftSpec, date: string, timezone: string): ShiftWindow {
  const start = zonedTimeToUtc(date, shift.startTime, timezone);
  const overnight = isOvernightShift(shift.startTime, shift.endTime);
  const end = zonedTimeToUtc(overnight ? addDays(date, 1) : date, shift.endTime, timezone);
  const spanMinutes = Math.round((end.getTime() - start.getTime()) / 60000);
  return { start, end, spanMinutes, requiredMinutes: Math.max(0, spanMinutes - shift.breakMinutes) };
}

// ---------- leave on a day ----------
/**
 * Which part of a day approved leave covers.
 *   FULL — the whole day; AM — the morning only; PM — the afternoon only.
 * Derived from a leave request's half-day boundaries: a request that starts on this date with `startPart: 'PM'`
 * leaves the morning available for work, and one that ends here with `endPart: 'AM'` leaves the afternoon.
 */
export type LeavePortion = 'FULL' | 'AM' | 'PM';

export interface LeaveSpanLike {
  startDate: string;
  endDate: string;
  startPart: string;
  endPart: string;
}

export function leavePortionForDate(leave: LeaveSpanLike, date: string): LeavePortion | null {
  if (date < leave.startDate || date > leave.endDate) return null;
  const startsHalf = date === leave.startDate && leave.startPart === 'PM';
  const endsHalf = date === leave.endDate && leave.endPart === 'AM';
  if (startsHalf && endsHalf) return 'FULL'; // cannot happen (the leave schema rejects it) — treated as a full day
  if (startsHalf) return 'PM'; // leave covers the afternoon
  if (endsHalf) return 'AM'; // leave covers the morning
  return 'FULL';
}

/** Units of leave a portion consumes on one day, matching the Leave module's own arithmetic. */
export const leaveUnitsOfPortion = (portion: LeavePortion | null): number => (portion === 'FULL' ? 1 : portion ? 0.5 : 0);

// ---------- the calculation ----------
export interface AttendanceCalculationInput {
  date: string;
  timezone: string;
  dayType: AttendanceDayType;
  shift: AttendanceShiftSpec | null;
  /** Effective times: raw clock events, or the values of an approved correction. */
  clockIn: Date | null;
  clockOut: Date | null;
  /** Approved leave covering this date, if any. */
  leavePortion: LeavePortion | null;
  /** Reference instant. A day that has not ended yet is never marked absent. */
  now: Date;
}

export interface AttendanceCalculationResult {
  status: AttendanceStatus;
  scheduledStart: Date | null;
  scheduledEnd: Date | null;
  /** The window actually expected of the employee — the shift, narrowed by half-day leave. */
  expectedStart: Date | null;
  expectedEnd: Date | null;
  requiredMinutes: number;
  workMinutes: number;
  lateMinutes: number;
  earlyLeaveMinutes: number;
  /** Worked beyond what the day required. Informational only — overtime is not calculated or paid here. */
  extraMinutes: number;
  leaveUnits: number;
}

const minutesBetween = (from: Date, to: Date) => Math.round((to.getTime() - from.getTime()) / 60000);

/**
 * One day of attendance for one employee.
 *
 * Order of decisions, and why:
 *  1. **Not a work day** (off, holiday, or no shift assigned) → `NOT_SCHEDULED`. Clocking is still recorded, because
 *     the fact that somebody worked on a holiday is real; deciding what it earns is overtime, which is not this task.
 *  2. **Full-day approved leave** → `ON_LEAVE`. Leave is authoritative: a day on leave is never absent.
 *  3. **Half-day leave** narrows the expected window to the other half (and halves the break), so lateness is
 *     measured against the time the employee was actually expected, not the shift start.
 *  4. **No clocking**: `SCHEDULED` while the day is still running, `ABSENT` once it has ended. A half day of leave
 *     does not excuse the working half — that half is still absent.
 *  5. **One-sided clocking** (in without out, or out without in) → `INCOMPLETE`; the employee or HR fixes it with a
 *     correction request rather than the system inventing a time.
 *  6. **Both** → minutes worked, lateness and early leaving. Grace decides the *status* only; the recorded minutes are
 *     the real ones, because "5 minutes late but within grace" is still useful to HR and useless if rounded away.
 */
export function calculateAttendance(input: AttendanceCalculationInput): AttendanceCalculationResult {
  const { shift, clockIn, clockOut, leavePortion, now } = input;
  const leaveUnits = leaveUnitsOfPortion(leavePortion);
  const base = {
    scheduledStart: null as Date | null, scheduledEnd: null as Date | null,
    expectedStart: null as Date | null, expectedEnd: null as Date | null,
    requiredMinutes: 0, workMinutes: 0, lateMinutes: 0, earlyLeaveMinutes: 0, extraMinutes: 0, leaveUnits,
  };
  const worked = (breakMinutes: number) =>
    clockIn && clockOut ? Math.max(0, minutesBetween(clockIn, clockOut) - breakMinutes) : 0;

  // 1. nothing was scheduled
  if (input.dayType !== 'WORK' || !shift) {
    return { ...base, status: 'NOT_SCHEDULED', workMinutes: worked(shift?.breakMinutes ?? 0) };
  }

  const window = shiftWindow(shift, input.date, input.timezone);
  const scheduled = { scheduledStart: window.start, scheduledEnd: window.end };

  // 2. the whole day is approved leave
  if (leavePortion === 'FULL') {
    return { ...base, ...scheduled, status: 'ON_LEAVE', workMinutes: worked(shift.breakMinutes) };
  }

  // 3. half-day leave narrows the window to the half that is still working time
  const halfSpan = Math.round(window.spanMinutes / 2);
  const midpoint = new Date(window.start.getTime() + halfSpan * 60000);
  const expectedStart = leavePortion === 'AM' ? midpoint : window.start;
  const expectedEnd = leavePortion === 'PM' ? midpoint : window.end;
  const breakMinutes = leavePortion ? Math.round(shift.breakMinutes / 2) : shift.breakMinutes;
  const requiredMinutes = Math.max(0, minutesBetween(expectedStart, expectedEnd) - breakMinutes);
  const common = { ...base, ...scheduled, expectedStart, expectedEnd, requiredMinutes };

  // 4. nobody clocked
  if (!clockIn && !clockOut) {
    return { ...common, status: now.getTime() < expectedEnd.getTime() ? 'SCHEDULED' : 'ABSENT' };
  }
  // 5. a half-finished day
  if (!clockIn || !clockOut) {
    return { ...common, status: 'INCOMPLETE', workMinutes: 0 };
  }

  // 6. a complete day
  const workMinutes = Math.max(0, minutesBetween(clockIn, clockOut) - breakMinutes);
  const rawLate = Math.max(0, minutesBetween(expectedStart, clockIn));
  const rawEarly = Math.max(0, minutesBetween(clockOut, expectedEnd));
  const late = rawLate > shift.lateGraceMinutes ? rawLate : 0;
  const early = rawEarly > shift.earlyLeaveGraceMinutes ? rawEarly : 0;
  const status: AttendanceStatus = late && early ? 'LATE_AND_EARLY' : late ? 'LATE' : early ? 'EARLY_LEAVE' : 'NORMAL';
  return {
    ...common,
    status,
    workMinutes,
    lateMinutes: late,
    earlyLeaveMinutes: early,
    extraMinutes: Math.max(0, workMinutes - requiredMinutes),
  };
}

/** Minutes → `7h 30m`, for tables and exports. */
export function formatWorkMinutes(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return '0h';
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return m === 0 ? `${h}h` : h === 0 ? `${m}m` : `${h}h ${m}m`;
}
