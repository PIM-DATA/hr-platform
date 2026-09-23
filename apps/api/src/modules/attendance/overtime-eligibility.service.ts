import {
  calculateOvertimeEligibility, checkOvertimeClaim, multiplierFor, overtimeDayTypeOf,
  type AttendanceDayType, type OvertimeDayType, type OvertimeEligibility, type OvertimePreviewDto,
} from '@hr/shared';
import { prisma } from '../../lib/prisma';
import { AppError } from '../../lib/errors';
import { attendanceCalculationService } from './attendance-calculation.service';
import { overtimePoliciesService } from './overtime-policies.service';
import type { Db } from './attendance.types';

/**
 * The one place that answers "how much of this day is overtime, and at what rate".
 *
 * It reads the **attendance record** rather than recomputing the day: that record is already derived from the
 * schedule, the calendar, approved leave, the clock events and any approved correction, so overtime inherits every
 * one of those decisions instead of forming a second opinion about them. If the day changes, this answer changes
 * with it — which is exactly why a claim is revalidated when it is approved.
 *
 * Nothing here converts anything into money.
 */
export interface OvertimeAssessment {
  attendanceDate: string;
  employeeId: string;
  organizationId: string;
  /** The organization's timezone — what "a day that has already happened" means for this employee. */
  timezone: string;
  departmentId: string | null;
  positionId: string | null;
  dayType: OvertimeDayType;
  attendanceStatus: string;
  scheduledStart: Date | null;
  scheduledEnd: Date | null;
  firstClockIn: Date | null;
  lastClockOut: Date | null;
  workedMinutes: number;
  requiredMinutes: number;
  eligibility: OvertimeEligibility;
  /** False when the day cannot be claimed yet: it has not finished, or one side of the clock is missing. */
  claimable: boolean;
  notFinalReason: string | null;
}

/** The paid minutes a shift asked for on that day — recomputed from the same inputs the record was built from. */
async function requiredMinutesFor(db: Db, employeeId: string, attendanceDate: string): Promise<number> {
  const { result } = await attendanceCalculationService.preview(db, employeeId, attendanceDate);
  return result.requiredMinutes;
}

export const overtimeEligibilityService = {
  /**
   * Assess one employee-day. Throws only when the day cannot be assessed at all (no employee); a day that simply
   * cannot be claimed comes back with `claimable: false` and a reason, because the preview screen needs to say why.
   */
  async assess(db: Db, employeeId: string, attendanceDate: string): Promise<OvertimeAssessment> {
    const employee = await db.employee.findUnique({
      where: { id: employeeId },
      select: { id: true, organizationId: true, departmentId: true, positionId: true, organization: { select: { timezone: true } } },
    });
    if (!employee) throw new AppError(404, 'EMPLOYEE_NOT_FOUND', 'Employee not found');

    const record = await db.attendanceRecord.findUnique({
      where: { employeeId_attendanceDate: { employeeId, attendanceDate } },
      select: {
        dayType: true, status: true, scheduledStart: true, scheduledEnd: true,
        firstClockIn: true, lastClockOut: true, workMinutes: true,
      },
    });

    const base = {
      attendanceDate,
      employeeId,
      organizationId: employee.organizationId,
      timezone: employee.organization.timezone,
      departmentId: employee.departmentId,
      positionId: employee.positionId,
    };

    if (!record) {
      // No calculated day at all: nothing was scheduled and nobody clocked, or the day has not been calculated yet.
      return {
        ...base,
        dayType: 'OFF_DAY',
        attendanceStatus: 'NONE',
        scheduledStart: null, scheduledEnd: null, firstClockIn: null, lastClockOut: null,
        workedMinutes: 0, requiredMinutes: 0,
        eligibility: { eligibleMinutes: 0, preShiftMinutes: 0, postShiftMinutes: 0, excessMinutes: 0, reason: 'NO_CLOCK' },
        claimable: false,
        notFinalReason: 'There is no attendance for that day yet',
      };
    }

    const dayType = overtimeDayTypeOf(record.dayType as AttendanceDayType);
    const requiredMinutes = record.scheduledStart && record.scheduledEnd ? await requiredMinutesFor(db, employeeId, attendanceDate) : 0;
    const eligibility = calculateOvertimeEligibility({
      dayType,
      scheduledStart: record.scheduledStart,
      scheduledEnd: record.scheduledEnd,
      requiredMinutes,
      clockIn: record.firstClockIn,
      clockOut: record.lastClockOut,
      workMinutes: record.workMinutes,
    });

    // A claim is about time that was demonstrably worked, so both ends of the clock must exist and the day must be
    // over. `SCHEDULED` means the shift has not ended yet.
    const notFinalReason =
      record.status === 'SCHEDULED' ? 'That day has not finished yet'
      : !record.firstClockIn || !record.lastClockOut ? 'That day has no complete clock-in and clock-out'
      : null;

    return {
      ...base,
      dayType,
      attendanceStatus: record.status,
      scheduledStart: record.scheduledStart,
      scheduledEnd: record.scheduledEnd,
      firstClockIn: record.firstClockIn,
      lastClockOut: record.lastClockOut,
      workedMinutes: record.workMinutes,
      requiredMinutes,
      eligibility,
      claimable: notFinalReason === null && eligibility.eligibleMinutes > 0,
      notFinalReason,
    };
  },

  /** What the claim screen shows before anybody claims anything. Reads only — nothing is written. */
  async preview(db: Db, employeeId: string, attendanceDate: string): Promise<OvertimePreviewDto> {
    const assessment = await overtimeEligibilityService.assess(db, employeeId, attendanceDate);
    // A missing policy is not an error here: the preview says so, rather than a form failing with no explanation.
    const policy = await overtimePoliciesService.resolve(db, assessment.organizationId, attendanceDate).catch(() => null);
    const claim = policy
      ? checkOvertimeClaim(
          {
            eligibleMinutes: assessment.eligibility.eligibleMinutes,
            minimumEligibleMinutes: policy.minimumEligibleMinutes,
            maximumApprovedMinutesPerDay: policy.maximumApprovedMinutesPerDay,
          },
          assessment.eligibility.eligibleMinutes,
        )
      : null;

    const reason = assessment.notFinalReason
      ?? (assessment.eligibility.reason === 'WITHIN_SCHEDULE'
        ? 'Nothing was worked outside the shift beyond what the day required'
        : assessment.eligibility.reason === 'NO_CLOCK' ? 'Nothing was clocked on that day'
        : assessment.eligibility.reason === 'INCOMPLETE_CLOCK' ? 'That day has only one side of the clock'
        : !policy ? 'No overtime policy is in force for that day'
        : 'OK');

    return {
      attendanceDate,
      dayType: assessment.dayType,
      attendanceStatus: assessment.attendanceStatus,
      scheduledStart: assessment.scheduledStart?.toISOString() ?? null,
      scheduledEnd: assessment.scheduledEnd?.toISOString() ?? null,
      firstClockIn: assessment.firstClockIn?.toISOString() ?? null,
      lastClockOut: assessment.lastClockOut?.toISOString() ?? null,
      workedMinutes: assessment.workedMinutes,
      requiredMinutes: assessment.requiredMinutes,
      preShiftMinutes: assessment.eligibility.preShiftMinutes,
      postShiftMinutes: assessment.eligibility.postShiftMinutes,
      eligibleMinutes: assessment.eligibility.eligibleMinutes,
      maximumClaimableMinutes: claim?.maximumClaimableMinutes ?? 0,
      reason,
      policy: policy
        ? {
            id: policy.id,
            name: policy.name,
            multiplier: multiplierFor(policy, assessment.dayType),
            minimumEligibleMinutes: policy.minimumEligibleMinutes,
            maximumApprovedMinutesPerDay: policy.maximumApprovedMinutesPerDay,
          }
        : null,
      claimable: assessment.claimable && !!policy && (claim?.maximumClaimableMinutes ?? 0) > 0,
    };
  },

  /** Convenience for the services that need both without a DTO in between. */
  async assessWithPolicy(db: Db, employeeId: string, attendanceDate: string) {
    const assessment = await overtimeEligibilityService.assess(db, employeeId, attendanceDate);
    const policy = await overtimePoliciesService.resolve(db, assessment.organizationId, attendanceDate);
    return { assessment, policy };
  },
};

export { checkOvertimeClaim, multiplierFor };
export const overtimeEligibilityPreviewForEmployee = (employeeId: string, date: string) => overtimeEligibilityService.preview(prisma, employeeId, date);
