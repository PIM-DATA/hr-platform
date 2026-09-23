import { AUDIT_ACTIONS, businessDateOf, type ClockEventDto, type ClockInput, type ClockSource, type ClockStatusDto } from '@hr/shared';
import { prisma } from '../../lib/prisma';
import { AppError } from '../../lib/errors';
import { auditService } from '../../services/audit/audit.service';
import type { AuthContext } from '../auth/auth.types';
import { attendanceAudit, type Actor, type Tx } from './attendance.types';
import { attendanceCalculationService } from './attendance-calculation.service';

/**
 * Clocking in and out.
 *
 * Three rules hold this together:
 *  1. **The employee is the session, never the request body.** A clock event is a statement about who was at work;
 *     letting a client name the employee would make it a statement about anyone.
 *  2. **Events are append-only.** Nothing here updates or deletes; a mistake is fixed by a correction request, which
 *     records what should have been next to what actually happened.
 *  3. **The database decides, not the button.** Every clock takes the employee row lock first, so two taps — or two
 *     browser tabs, or a retry — cannot both create an event. A disabled button is a courtesy; this is the guarantee.
 *
 * Overnight shifts fall out of rule 3: a clock-out closes the **open clock-in**, whatever date that was, so leaving at
 * 05:00 belongs to the shift that started at 20:00 the previous day.
 */
type EventRow = { id: string; eventType: string; occurredAt: Date; attendanceDate: string; source: string; note: string | null };

const toEventDto = (e: EventRow): ClockEventDto => ({
  id: e.id,
  eventType: e.eventType,
  occurredAt: e.occurredAt.toISOString(),
  attendanceDate: e.attendanceDate,
  source: e.source as ClockSource,
  note: e.note,
});

/** The employee behind the session, or a clear error. A system account without an employee cannot clock. */
async function requireEmployee(auth: AuthContext) {
  if (!auth.employeeId) throw new AppError(409, 'EMPLOYEE_PROFILE_REQUIRED', 'This account is not linked to an employee record, so it cannot clock in or out');
  const employee = await prisma.employee.findUnique({
    where: { id: auth.employeeId },
    select: { id: true, employmentStatus: true, organization: { select: { timezone: true } } },
  });
  if (!employee) throw new AppError(409, 'EMPLOYEE_PROFILE_REQUIRED', 'This account is not linked to an employee record');
  if (employee.employmentStatus !== 'ACTIVE') throw new AppError(409, 'EMPLOYEE_NOT_ACTIVE', 'This employee is not active');
  return employee;
}

/** Serialises everything one employee does: the lock is taken before any state is read. */
async function lockEmployee(tx: Tx, employeeId: string) {
  await tx.$executeRaw`SELECT "id" FROM "employees" WHERE "id" = ${employeeId} FOR UPDATE`;
}

/** The clock-in that has not been closed yet, if any — the anchor for both the duplicate check and overnight shifts. */
async function openClockIn(tx: Tx, employeeId: string) {
  const last = await tx.attendanceClockEvent.findFirst({
    where: { employeeId },
    orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
    select: { id: true, eventType: true, occurredAt: true, attendanceDate: true },
  });
  return last?.eventType === 'CLOCK_IN' ? last : null;
}

export const clockService = {
  async clockIn(auth: AuthContext, input: ClockInput, actor: Actor, source: ClockSource = 'WEB'): Promise<ClockEventDto> {
    const employee = await requireEmployee(auth);
    const now = new Date();
    return prisma.$transaction(async (tx) => {
      await lockEmployee(tx, employee.id);
      const open = await openClockIn(tx, employee.id);
      if (open) throw new AppError(409, 'ALREADY_CLOCKED_IN', `You clocked in for ${open.attendanceDate} and have not clocked out yet`);

      const attendanceDate = businessDateOf(now, employee.organization.timezone);
      const event = await tx.attendanceClockEvent.create({
        data: { employeeId: employee.id, eventType: 'CLOCK_IN', occurredAt: now, attendanceDate, source, note: input.note ?? null, createdByUserId: auth.userId },
        select: { id: true, eventType: true, occurredAt: true, attendanceDate: true, source: true, note: true },
      });
      await attendanceCalculationService.recalculate(tx, employee.id, attendanceDate, now);
      await auditService.log(attendanceAudit(actor, AUDIT_ACTIONS.CLOCK_IN, 'AttendanceClockEvent', event.id, { attendanceDate, occurredAt: now.toISOString(), source }), tx);
      return toEventDto(event);
    });
  },

  async clockOut(auth: AuthContext, input: ClockInput, actor: Actor, source: ClockSource = 'WEB'): Promise<ClockEventDto> {
    const employee = await requireEmployee(auth);
    const now = new Date();
    return prisma.$transaction(async (tx) => {
      await lockEmployee(tx, employee.id);
      const open = await openClockIn(tx, employee.id);
      if (!open) {
        const anyToday = await tx.attendanceClockEvent.findFirst({
          where: { employeeId: employee.id, attendanceDate: businessDateOf(now, employee.organization.timezone) },
          orderBy: { occurredAt: 'desc' },
          select: { eventType: true },
        });
        if (anyToday?.eventType === 'CLOCK_OUT') throw new AppError(409, 'ALREADY_CLOCKED_OUT', 'You have already clocked out');
        throw new AppError(409, 'NOT_CLOCKED_IN', 'You have not clocked in yet');
      }

      // The clock-out belongs to the day the shift STARTED, which is what makes an overnight shift one day of work.
      const attendanceDate = open.attendanceDate;
      const event = await tx.attendanceClockEvent.create({
        data: { employeeId: employee.id, eventType: 'CLOCK_OUT', occurredAt: now, attendanceDate, source, note: input.note ?? null, createdByUserId: auth.userId },
        select: { id: true, eventType: true, occurredAt: true, attendanceDate: true, source: true, note: true },
      });
      await attendanceCalculationService.recalculate(tx, employee.id, attendanceDate, now);
      await auditService.log(attendanceAudit(actor, AUDIT_ACTIONS.CLOCK_OUT, 'AttendanceClockEvent', event.id, { attendanceDate, occurredAt: now.toISOString(), source }), tx);
      return toEventDto(event);
    });
  },

  /** Everything the clock screen renders: today's shift, what has been clocked, and what the employee may do next. */
  async status(auth: AuthContext): Promise<ClockStatusDto> {
    const employee = await requireEmployee(auth);
    const now = new Date();
    const timezone = employee.organization.timezone;
    const open = await prisma.attendanceClockEvent.findFirst({
      where: { employeeId: employee.id },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      select: { eventType: true, attendanceDate: true },
    });
    // While a shift is open the screen stays on that day, even after midnight, so an overnight worker clocks out of
    // the day they started.
    const attendanceDate = open?.eventType === 'CLOCK_IN' ? open.attendanceDate : businessDateOf(now, timezone);

    const { inputs, result } = await attendanceCalculationService.preview(prisma, employee.id, attendanceDate, now);
    const schedule = await prisma.attendanceSchedule.findUnique({
      where: { employeeId_date: { employeeId: employee.id, date: attendanceDate } },
      select: { shift: { select: { id: true, code: true, name: true, startTime: true, endTime: true, isOvernight: true } } },
    });
    const events = await prisma.attendanceClockEvent.findMany({
      where: { employeeId: employee.id, attendanceDate },
      orderBy: { occurredAt: 'asc' },
      select: { id: true, eventType: true, occurredAt: true, attendanceDate: true, source: true, note: true },
    });

    return {
      attendanceDate,
      timezone,
      serverTime: now.toISOString(),
      shift: schedule?.shift ?? null,
      dayType: inputs.dayType,
      scheduledStart: result.scheduledStart?.toISOString() ?? null,
      scheduledEnd: result.scheduledEnd?.toISOString() ?? null,
      firstClockIn: inputs.rawClockIn?.toISOString() ?? null,
      lastClockOut: inputs.rawClockOut?.toISOString() ?? null,
      canClockIn: open?.eventType !== 'CLOCK_IN',
      canClockOut: open?.eventType === 'CLOCK_IN',
      status: result.status,
      workMinutes: result.workMinutes,
      events: events.map(toEventDto),
    };
  },
};
