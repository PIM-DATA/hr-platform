import {
  AUDIT_ACTIONS, enumerateDates, weekdayOf,
  type AssignScheduleInput, type ScheduleListQuery, type ScheduleRowDto, type Weekday,
} from '@hr/shared';
import { prisma } from '../../lib/prisma';
import { AppError } from '../../lib/errors';
import { auditService } from '../../services/audit/audit.service';
import { calendarsService } from '../calendar/calendars.service';
import { employeeScopeWhere } from '../employees/employees.scope';
import type { AuthContext } from '../auth/auth.types';
import { attendanceAudit, employeeRef, type Actor, type Db } from './attendance.types';

/**
 * Who works when. One row per employee per date — the grid HR looks at, and the first input the calculation reads.
 *
 * The work calendar from Leave is reused, never duplicated: weekends and holidays come from the organization's
 * default calendar, so a holiday added there is a holiday here too. Approved leave is **not** written into the
 * schedule; it is read when attendance is calculated, so cancelling leave can never leave a stale "on leave" day
 * behind.
 */
const MAX_ASSIGNMENT_DAYS = 366;

export const schedulesService = {
  /**
   * Assign a shift (or a day off) to employees across a date range.
   *
   * Weekends and holidays follow the organization's calendar unless the operator asks for them explicitly; the
   * result is one row per employee per date, which is what makes the calculation a lookup rather than a guess.
   */
  async assign(input: AssignScheduleInput, actor: Actor): Promise<{ created: number; updated: number; skipped: number; days: number; employees: number }> {
    const dates = enumerateDates(input.from, input.to);
    if (dates.length > MAX_ASSIGNMENT_DAYS) throw new AppError(400, 'VALIDATION_ERROR', `Assign at most ${MAX_ASSIGNMENT_DAYS} days at a time`);

    const employees = await prisma.employee.findMany({
      where: { id: { in: input.employeeIds } },
      select: { id: true, organizationId: true, employmentStatus: true },
    });
    if (employees.length !== input.employeeIds.length) throw new AppError(404, 'EMPLOYEE_NOT_FOUND', 'One or more employees were not found');

    const shift = input.shiftId ? await prisma.attendanceShift.findUnique({ where: { id: input.shiftId }, select: { id: true, organizationId: true, isActive: true, code: true } }) : null;
    if (input.shiftId && !shift) throw new AppError(404, 'SHIFT_NOT_FOUND', 'Shift not found');
    if (shift && !shift.isActive) throw new AppError(409, 'SHIFT_INACTIVE', 'That shift is inactive');
    if (shift && employees.some((e) => e.organizationId !== shift.organizationId)) {
      throw new AppError(409, 'SHIFT_ORGANIZATION_MISMATCH', 'The shift belongs to a different organization than one of the employees');
    }

    // One calendar lookup per organization involved, not per employee.
    const calendars = new Map<string, { workingDays: Weekday[]; holidays: Set<string> }>();
    for (const organizationId of new Set(employees.map((e) => e.organizationId))) {
      const calendar = await calendarsService.effectiveForOrganization(prisma, organizationId);
      if (!calendar) throw new AppError(409, 'WORK_CALENDAR_NOT_CONFIGURED', 'The organization has no active default work calendar');
      calendars.set(organizationId, calendar);
    }

    let created = 0;
    let updated = 0;
    let skipped = 0;
    await prisma.$transaction(async (tx) => {
      for (const employee of employees) {
        const calendar = calendars.get(employee.organizationId)!;
        const weekdays = input.weekdays ?? calendar.workingDays;
        for (const date of dates) {
          const isHoliday = calendar.holidays.has(date);
          const matchesWeekday = weekdays.includes(weekdayOf(date));
          const dayType = !matchesWeekday ? 'OFF' : isHoliday && !input.includeHolidays ? 'HOLIDAY' : input.shiftId ? 'WORK' : 'OFF';
          const shiftId = dayType === 'WORK' ? input.shiftId : null;

          const existing = await tx.attendanceSchedule.findUnique({ where: { employeeId_date: { employeeId: employee.id, date } }, select: { id: true, dayType: true, shiftId: true } });
          if (existing && !input.overwriteExisting) {
            skipped += 1;
            continue;
          }
          if (existing) {
            if (existing.dayType === dayType && existing.shiftId === shiftId) {
              skipped += 1;
              continue;
            }
            await tx.attendanceSchedule.update({ where: { id: existing.id }, data: { dayType, shiftId, source: 'MANUAL', createdByUserId: actor.auth.userId } });
            updated += 1;
          } else {
            await tx.attendanceSchedule.create({ data: { employeeId: employee.id, date, dayType, shiftId, source: 'MANUAL', createdByUserId: actor.auth.userId } });
            created += 1;
          }
        }
        await auditService.log(attendanceAudit(actor, AUDIT_ACTIONS.ASSIGN_SCHEDULE, 'Employee', employee.id, {
          from: input.from, to: input.to, shiftCode: shift?.code ?? null, days: dates.length, weekdays: input.weekdays ?? null, includeHolidays: input.includeHolidays,
        }), tx);
      }
    }, { timeout: 60_000 });

    return { created, updated, skipped, days: dates.length, employees: employees.length };
  },

  /** The schedule grid: employees down the side, dates across the top — always inside the caller's data scope. */
  async grid(auth: AuthContext, q: ScheduleListQuery): Promise<{ data: ScheduleRowDto[]; meta: { page: number; pageSize: number; total: number; from: string; to: string } }> {
    const dates = enumerateDates(q.from, q.to);
    if (dates.length > 62) throw new AppError(400, 'VALIDATION_ERROR', 'Ask for at most 62 days at a time');

    const where = {
      AND: [
        employeeScopeWhere(auth),
        { employmentStatus: 'ACTIVE' as const },
        ...(q.departmentId ? [{ departmentId: q.departmentId }] : []),
        ...(q.employeeId ? [{ id: q.employeeId }] : []),
        ...(q.search
          ? [{ OR: [
              { employeeCode: { contains: q.search, mode: 'insensitive' as const } },
              { firstName: { contains: q.search, mode: 'insensitive' as const } },
              { lastName: { contains: q.search, mode: 'insensitive' as const } },
            ] }]
          : []),
      ],
    };
    const [total, employees] = await prisma.$transaction([
      prisma.employee.count({ where }),
      prisma.employee.findMany({ where, ...employeeRef, orderBy: { employeeCode: 'asc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
    ]);

    const schedules = await prisma.attendanceSchedule.findMany({
      where: { employeeId: { in: employees.map((e) => e.id) }, date: { gte: q.from, lte: q.to } },
      select: { employeeId: true, date: true, dayType: true, source: true, shift: { select: { id: true, code: true, startTime: true, endTime: true } } },
    });
    const byEmployee = new Map<string, Map<string, (typeof schedules)[number]>>();
    for (const s of schedules) {
      if (!byEmployee.has(s.employeeId)) byEmployee.set(s.employeeId, new Map());
      byEmployee.get(s.employeeId)!.set(s.date, s);
    }

    return {
      data: employees.map((employee) => ({
        employee,
        days: dates.map((date) => {
          const row = byEmployee.get(employee.id)?.get(date);
          // No row means nothing has been assigned yet — shown as an empty cell, never guessed at.
          return { date, dayType: (row?.dayType ?? 'OFF') as 'WORK' | 'OFF' | 'HOLIDAY', shift: row?.shift ?? null, source: row?.source ?? 'NONE' };
        }),
      })),
      meta: { page: q.page, pageSize: q.pageSize, total, from: q.from, to: q.to },
    };
  },

  /** Internal: the schedule for one employee on one date, if any. */
  async forDate(db: Db, employeeId: string, date: string) {
    return db.attendanceSchedule.findUnique({
      where: { employeeId_date: { employeeId, date } },
      select: {
        dayType: true,
        shift: { select: { id: true, code: true, name: true, startTime: true, endTime: true, breakMinutes: true, lateGraceMinutes: true, earlyLeaveGraceMinutes: true, isOvernight: true } },
      },
    });
  },
};
