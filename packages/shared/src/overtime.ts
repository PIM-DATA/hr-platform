/**
 * Overtime domain maths — how much of a day counts as overtime, and at which multiplier.
 *
 * Pure and deterministic, like the attendance calculation it builds on: the same inputs always produce the same
 * minutes, on the server, in a test and in the preview the employee sees before claiming.
 *
 * **This file never touches money.** It produces minutes and a multiplier; turning those into an amount is payroll's
 * job, and payroll does not exist yet.
 */
import type { AttendanceDayType, OvertimeDayType } from './enums';

// ---------- day type ----------
/**
 * The attendance day type decides the overtime day type, so the two can never disagree: a day the schedule says is
 * work is a `WORKDAY`, a calendar holiday is a `HOLIDAY`, anything else is an `OFF_DAY`. Derived on the server from
 * the schedule the same way Task 20 derives it — a client never supplies it, because it picks the rate.
 */
export function overtimeDayTypeOf(attendanceDayType: AttendanceDayType): OvertimeDayType {
  return attendanceDayType === 'WORK' ? 'WORKDAY' : attendanceDayType === 'HOLIDAY' ? 'HOLIDAY' : 'OFF_DAY';
}

// ---------- eligibility ----------
export interface OvertimeEligibilityInput {
  dayType: OvertimeDayType;
  /** The instants the shift covered, when there was one. */
  scheduledStart: Date | null;
  scheduledEnd: Date | null;
  /** What the day actually required of the employee, in paid minutes (the shift span minus its break). */
  requiredMinutes: number;
  /** The effective clock times of the day — raw events, or an approved correction. */
  clockIn: Date | null;
  clockOut: Date | null;
  /** Paid minutes actually worked, as the attendance calculation recorded them (break already deducted). */
  workMinutes: number;
}

export interface OvertimeEligibility {
  eligibleMinutes: number;
  /** Time clocked before the shift started. */
  preShiftMinutes: number;
  /** Time clocked after the shift ended. */
  postShiftMinutes: number;
  /** Paid minutes beyond what the day required — the ceiling on a workday claim. */
  excessMinutes: number;
  /** Why the answer is zero, when it is. */
  reason: 'OK' | 'NO_CLOCK' | 'INCOMPLETE_CLOCK' | 'WITHIN_SCHEDULE';
}

const minutesBetween = (from: Date, to: Date) => Math.max(0, Math.round((to.getTime() - from.getTime()) / 60000));

/**
 * Minutes eligible for an overtime claim on one day.
 *
 * **Workdays.** Overtime is time worked *outside* the shift — before it started or after it ended — but never more
 * than the paid time that exceeds what the day required. That second limit is the whole point: somebody who arrives
 * at 09:00 for an 08:00 shift and leaves at 18:00 has an hour "after the shift", but has only made up the hour they
 * missed. Their worked minutes equal the requirement, so their eligible overtime is zero. Staying until 19:00 after
 * arriving on time is two extra hours of paid time and one hour outside the shift on the other side of the break —
 * the smaller of the two is what can be claimed.
 *
 * **Off days and holidays.** There is no shift to be outside of, so every paid minute worked is eligible. No break is
 * invented: the attendance calculation already deducted whatever break the day actually had (none, when no shift is
 * attached).
 *
 * **Both.** A day with no clocking, or with only one side of it, yields nothing — overtime is a claim about time that
 * was demonstrably worked, and the system will not guess the other half. Fix the day with an attendance correction
 * first.
 */
export function calculateOvertimeEligibility(input: OvertimeEligibilityInput): OvertimeEligibility {
  const { clockIn, clockOut } = input;
  const empty = { eligibleMinutes: 0, preShiftMinutes: 0, postShiftMinutes: 0, excessMinutes: 0 } as const;
  if (!clockIn && !clockOut) return { ...empty, reason: 'NO_CLOCK' };
  if (!clockIn || !clockOut) return { ...empty, reason: 'INCOMPLETE_CLOCK' };

  if (input.dayType !== 'WORKDAY' || !input.scheduledStart || !input.scheduledEnd) {
    // Nothing was scheduled: every paid minute is overtime.
    const worked = Math.max(0, input.workMinutes);
    return { eligibleMinutes: worked, preShiftMinutes: 0, postShiftMinutes: 0, excessMinutes: worked, reason: worked > 0 ? 'OK' : 'NO_CLOCK' };
  }

  const preShiftMinutes = minutesBetween(clockIn, input.scheduledStart);
  const postShiftMinutes = minutesBetween(input.scheduledEnd, clockOut);
  const excessMinutes = Math.max(0, input.workMinutes - input.requiredMinutes);
  const eligibleMinutes = Math.min(preShiftMinutes + postShiftMinutes, excessMinutes);
  return {
    eligibleMinutes,
    preShiftMinutes,
    postShiftMinutes,
    excessMinutes,
    reason: eligibleMinutes > 0 ? 'OK' : 'WITHIN_SCHEDULE',
  };
}

// ---------- policy ----------
export interface OvertimeRateSpec {
  workdayMultiplier: number;
  offDayMultiplier: number;
  holidayMultiplier: number;
}

/** The multiplier a day type earns under a policy. Snapshotted onto the request at submit; never re-resolved later. */
export function multiplierFor(policy: OvertimeRateSpec, dayType: OvertimeDayType): number {
  return dayType === 'HOLIDAY' ? policy.holidayMultiplier : dayType === 'OFF_DAY' ? policy.offDayMultiplier : policy.workdayMultiplier;
}

export interface OvertimeClaimLimits {
  eligibleMinutes: number;
  minimumEligibleMinutes?: number | null;
  maximumApprovedMinutesPerDay?: number | null;
}
export type OvertimeClaimCheck =
  | { ok: true; maximumClaimableMinutes: number }
  | { ok: false; code: 'OT_NOT_ELIGIBLE' | 'OT_BELOW_MINIMUM' | 'OT_EXCEEDS_ELIGIBLE_TIME' | 'OT_EXCEEDS_DAILY_MAX'; maximumClaimableMinutes: number };

/**
 * Whether a claim of `claimedMinutes` is allowed, and the most that could be claimed for the day.
 *
 * A minimum is a threshold, not a rounding rule: five minutes under a thirty-minute minimum is not a claim, and is
 * never rounded up to one. Minutes stay whole minutes all the way to payroll, where a customer's rounding policy —
 * if they have one — belongs.
 */
export function checkOvertimeClaim(limits: OvertimeClaimLimits, claimedMinutes: number): OvertimeClaimCheck {
  const max = limits.maximumApprovedMinutesPerDay ?? null;
  const maximumClaimableMinutes = max === null ? limits.eligibleMinutes : Math.min(limits.eligibleMinutes, max);
  if (limits.eligibleMinutes <= 0) return { ok: false, code: 'OT_NOT_ELIGIBLE', maximumClaimableMinutes: 0 };
  if (claimedMinutes > limits.eligibleMinutes) return { ok: false, code: 'OT_EXCEEDS_ELIGIBLE_TIME', maximumClaimableMinutes };
  if (max !== null && claimedMinutes > max) return { ok: false, code: 'OT_EXCEEDS_DAILY_MAX', maximumClaimableMinutes };
  if (limits.minimumEligibleMinutes != null && claimedMinutes < limits.minimumEligibleMinutes) {
    return { ok: false, code: 'OT_BELOW_MINIMUM', maximumClaimableMinutes };
  }
  return { ok: true, maximumClaimableMinutes };
}

/** `150` → `2h 30m`. Minutes are the source of truth everywhere; hours are a display format. */
export function formatOvertimeMinutes(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return '0h';
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return m === 0 ? `${h}h` : h === 0 ? `${m}m` : `${h}h ${m}m`;
}
