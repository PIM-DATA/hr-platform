import {
  LEAVE_REQUEST_STATUS, calculateAttendance, leavePortionForDate,
  type AttendanceCalculationResult, type AttendanceDayType, type LeavePortion,
} from '@hr/shared';
import { prisma } from '../../lib/prisma';
import { AppError } from '../../lib/errors';
import type { Db, Tx } from './attendance.types';
import { schedulesService } from './schedules.service';
import { assertPayrollInputsOpen } from '../payroll/payroll-freeze';

/**
 * The one place a day of attendance is decided.
 *
 * Everything it needs is read here and handed to the pure function in `@hr/shared`: the schedule, the organization's
 * timezone, approved leave, the raw clock events and an approved correction. Nothing upstream may compute a status,
 * a late minute or a worked minute of its own — if it did, the UI, the report and the record would drift apart.
 *
 * The record it writes is a **cache with a unique key**: delete every row and this service reproduces them exactly.
 * That is what makes recalculation safe after a clock event, a schedule change, an approved leave request or an
 * approved correction. A correction is an input to the calculation, not an edit of the result, so an automatic
 * recalculation can never overwrite a human decision — the decision is part of what is being recalculated.
 */
export interface AttendanceInputs {
  employeeId: string;
  date: string;
  timezone: string;
  dayType: AttendanceDayType;
  shiftId: string | null;
  leavePortion: LeavePortion | null;
  clockIn: Date | null;
  clockOut: Date | null;
  correctionId: string | null;
  rawClockIn: Date | null;
  rawClockOut: Date | null;
}

async function gatherInputs(db: Db, employeeId: string, date: string, now: Date): Promise<{ inputs: AttendanceInputs; result: AttendanceCalculationResult }> {
  const employee = await db.employee.findUnique({
    where: { id: employeeId },
    select: { id: true, organization: { select: { timezone: true } } },
  });
  if (!employee) throw new AppError(404, 'EMPLOYEE_NOT_FOUND', 'Employee not found');
  const timezone = employee.organization.timezone;

  const schedule = await schedulesService.forDate(db, employeeId, date);
  const shift = schedule?.shift ?? null;

  // Approved leave is authoritative and read-only here: Attendance never writes to Leave and never recomputes units.
  const leave = await db.leaveRequest.findFirst({
    where: { employeeId, status: LEAVE_REQUEST_STATUS.APPROVED, startDate: { lte: date }, endDate: { gte: date } },
    select: { startDate: true, endDate: true, startPart: true, endPart: true },
    orderBy: { startDate: 'asc' },
  });
  const leavePortion = leave ? leavePortionForDate(leave, date) : null;

  const events = await db.attendanceClockEvent.findMany({
    where: { employeeId, attendanceDate: date },
    select: { eventType: true, occurredAt: true },
    orderBy: { occurredAt: 'asc' },
  });
  const rawClockIn = events.find((e) => e.eventType === 'CLOCK_IN')?.occurredAt ?? null;
  const rawClockOut = [...events].reverse().find((e) => e.eventType === 'CLOCK_OUT')?.occurredAt ?? null;

  // An approved correction supplies the times the employee should have clocked. The raw events stay untouched.
  const correction = await db.attendanceCorrection.findFirst({
    where: { employeeId, attendanceDate: date, status: 'APPROVED' },
    select: { id: true, requestedClockIn: true, requestedClockOut: true },
    orderBy: { decidedAt: 'desc' },
  });

  const inputs: AttendanceInputs = {
    employeeId,
    date,
    timezone,
    dayType: (schedule?.dayType ?? 'OFF') as AttendanceDayType,
    shiftId: shift?.id ?? null,
    leavePortion,
    clockIn: correction?.requestedClockIn ?? rawClockIn,
    clockOut: correction?.requestedClockOut ?? rawClockOut,
    correctionId: correction?.id ?? null,
    rawClockIn,
    rawClockOut,
  };

  const result = calculateAttendance({
    date,
    timezone,
    dayType: inputs.dayType,
    shift: shift
      ? {
          code: shift.code,
          startTime: shift.startTime,
          endTime: shift.endTime,
          breakMinutes: shift.breakMinutes,
          lateGraceMinutes: shift.lateGraceMinutes,
          earlyLeaveGraceMinutes: shift.earlyLeaveGraceMinutes,
        }
      : null,
    clockIn: inputs.clockIn,
    clockOut: inputs.clockOut,
    leavePortion,
    now,
  });
  return { inputs, result };
}

export const attendanceCalculationService = {
  /** Compute without writing — used by the clock screen, which must not persist a record just because somebody looked. */
  async preview(db: Db, employeeId: string, date: string, now = new Date()) {
    return gatherInputs(db, employeeId, date, now);
  },

  /**
   * Recalculate one employee-day and store the result. Idempotent: the same inputs always produce the same row, so
   * calling it twice (or after a retry) changes nothing.
   */
  async recalculate(tx: Tx, employeeId: string, date: string, now = new Date()) {
    const { inputs, result } = await gatherInputs(tx, employeeId, date, now);
    const data = {
      employeeId,
      attendanceDate: date,
      shiftId: inputs.shiftId,
      dayType: inputs.dayType,
      scheduledStart: result.scheduledStart,
      scheduledEnd: result.scheduledEnd,
      firstClockIn: inputs.clockIn,
      lastClockOut: inputs.clockOut,
      workMinutes: result.workMinutes,
      lateMinutes: result.lateMinutes,
      earlyLeaveMinutes: result.earlyLeaveMinutes,
      extraMinutes: result.extraMinutes,
      leaveUnits: result.leaveUnits,
      status: result.status,
      correctionId: inputs.correctionId,
      calculatedAt: now,
    };
    // Task 48 (T44-P1-16): a change payroll reads (a new day, another status, other late minutes) inside an approved or
    // closed payroll period is refused; an identical recalculation (a retry, a look at a finished day) still passes.
    const existing = await tx.attendanceRecord.findUnique({ where: { employeeId_attendanceDate: { employeeId, attendanceDate: date } }, select: { status: true, lateMinutes: true } });
    if (!existing || existing.status !== data.status || existing.lateMinutes !== data.lateMinutes) {
      await assertPayrollInputsOpen(tx, employeeId, { from: date, to: date }, 'ATTENDANCE', `Attendance on ${date}`);
    }
    return tx.attendanceRecord.upsert({
      where: { employeeId_attendanceDate: { employeeId, attendanceDate: date } },
      create: data,
      update: data,
    });
  },

  /**
   * Recalculate a range for a set of employees — what an administrator runs after changing schedules, and what the
   * daily view uses to fill in days nobody has touched (an absence only exists once the day has ended).
   */
  async recalculateRange(employeeIds: string[], dates: string[], now = new Date()): Promise<{ records: number }> {
    let records = 0;
    // One transaction per employee keeps each unit small: a long range for many people must not hold one long lock.
    for (const employeeId of employeeIds) {
      await prisma.$transaction(async (tx) => {
        for (const date of dates) {
          await attendanceCalculationService.recalculate(tx, employeeId, date, now);
          records += 1;
        }
      }, { timeout: 60_000 });
    }
    return { records };
  },
};
