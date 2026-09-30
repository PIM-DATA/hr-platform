import { AUDIT_ACTIONS, businessToday, enumerateDates, type AttendanceDailySummaryDto, type AttendanceListQuery, type AttendanceRecordDto, type AttendanceReportDto, type AttendanceReportQuery, type AttendanceStatus, type MyAttendanceQuery } from '@hr/shared';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { AppError } from '../../lib/errors';
import { auditService } from '../../services/audit/audit.service';
import { employeeScopeWhere } from '../employees/employees.scope';
import type { AuthContext } from '../auth/auth.types';
import { attendanceAudit, employeeRef, type Actor } from './attendance.types';
import { attendanceCalculationService } from './attendance-calculation.service';

/**
 * Reading attendance: my own days, my team's day, the whole organization's day, and a range report.
 *
 * Every query is filtered by `employeeScopeWhere(auth)` in SQL — SELF sees itself, TEAM sees itself and direct
 * reports, ALL sees everyone. There is no attendance-specific scope logic, so a manager can no more read a stranger's
 * attendance than they can read their employee record.
 */
const recordInclude = {
  employee: employeeRef,
  shift: { select: { id: true, code: true, name: true, startTime: true, endTime: true, isOvernight: true } },
} satisfies Prisma.AttendanceRecordInclude;
type Row = Prisma.AttendanceRecordGetPayload<{ include: typeof recordInclude }>;

export function toRecordDto(row: Row): AttendanceRecordDto {
  return {
    id: row.id,
    employee: row.employee,
    attendanceDate: row.attendanceDate,
    dayType: row.dayType,
    shift: row.shift,
    scheduledStart: row.scheduledStart?.toISOString() ?? null,
    scheduledEnd: row.scheduledEnd?.toISOString() ?? null,
    firstClockIn: row.firstClockIn?.toISOString() ?? null,
    lastClockOut: row.lastClockOut?.toISOString() ?? null,
    workMinutes: row.workMinutes,
    lateMinutes: row.lateMinutes,
    earlyLeaveMinutes: row.earlyLeaveMinutes,
    extraMinutes: row.extraMinutes,
    leaveUnits: row.leaveUnits,
    status: row.status as AttendanceStatus,
    correctionId: row.correctionId,
    calculatedAt: row.calculatedAt.toISOString(),
  };
}

/** Employees the caller may see, as a WHERE fragment used by every list below. */
const scopedEmployeeWhere = (auth: AuthContext, extra: Prisma.EmployeeWhereInput[] = []): Prisma.EmployeeWhereInput => ({
  AND: [employeeScopeWhere(auth), ...extra],
});

const reportEmployeeWhere = (auth: AuthContext, q: { departmentId?: string; employeeId?: string }) => scopedEmployeeWhere(auth, [
  ...(q.departmentId ? [{ departmentId: q.departmentId }] : []),
  ...(q.employeeId ? [{ id: q.employeeId }] : []),
]);

/** Status groups (of one employee, or of a whole scope) → the report's figures. */
function attendanceFigures(groups: { status: string; _count: { _all: number }; _sum: { workMinutes: number | null; lateMinutes: number | null } }[]): AttendanceReportDto['totals'] {
  const countOf = (...statuses: AttendanceStatus[]) => groups.filter((g) => statuses.includes(g.status as AttendanceStatus)).reduce((sum, g) => sum + g._count._all, 0);
  const present = countOf('NORMAL', 'LATE', 'EARLY_LEAVE', 'LATE_AND_EARLY');
  return {
    scheduledDays: present + countOf('ABSENT', 'INCOMPLETE', 'SCHEDULED'),
    presentDays: present,
    lateDays: countOf('LATE', 'LATE_AND_EARLY'),
    absentDays: countOf('ABSENT'),
    leaveDays: countOf('ON_LEAVE'),
    incompleteDays: countOf('INCOMPLETE'),
    workMinutes: groups.reduce((sum, g) => sum + (g._sum.workMinutes ?? 0), 0),
    lateMinutes: groups.reduce((sum, g) => sum + (g._sum.lateMinutes ?? 0), 0),
  };
}

const RECALCULATE_BATCH = 500;

export const attendanceRecordsService = {
  /** The caller's own attendance for a date range (ESS). Days with no record yet are calculated on the fly. */
  async mine(auth: AuthContext, q: MyAttendanceQuery): Promise<{ data: AttendanceRecordDto[] }> {
    if (!auth.employeeId) throw new AppError(409, 'EMPLOYEE_PROFILE_REQUIRED', 'This account is not linked to an employee record');
    const dates = enumerateDates(q.from, q.to);
    if (dates.length > 92) throw new AppError(400, 'VALIDATION_ERROR', 'Ask for at most 92 days at a time');
    const rows = await prisma.attendanceRecord.findMany({
      where: { employeeId: auth.employeeId, attendanceDate: { gte: q.from, lte: q.to } },
      include: recordInclude,
      orderBy: { attendanceDate: 'desc' },
    });
    return { data: rows.map(toRecordDto) };
  },

  /** Team / organization view for a single day or a range, inside the caller's scope. */
  async list(auth: AuthContext, q: AttendanceListQuery): Promise<{ data: AttendanceRecordDto[]; meta: { page: number; pageSize: number; total: number } }> {
    const from = q.date ?? q.from;
    const to = q.date ?? q.to;
    const where: Prisma.AttendanceRecordWhereInput = {
      employee: scopedEmployeeWhere(auth, [
        ...(q.departmentId ? [{ departmentId: q.departmentId }] : []),
        ...(q.employeeId ? [{ id: q.employeeId }] : []),
        ...(q.search
          ? [{ OR: [
              { employeeCode: { contains: q.search, mode: 'insensitive' as const } },
              { firstName: { contains: q.search, mode: 'insensitive' as const } },
              { lastName: { contains: q.search, mode: 'insensitive' as const } },
            ] }]
          : []),
      ]),
      ...(from ? { attendanceDate: { gte: from, ...(to ? { lte: to } : {}) } } : {}),
      ...(q.status ? { status: q.status } : {}),
    };
    const [total, rows] = await prisma.$transaction([
      prisma.attendanceRecord.count({ where }),
      prisma.attendanceRecord.findMany({ where, include: recordInclude, orderBy: [{ attendanceDate: 'desc' }, { employeeId: 'asc' }], skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
    ]);
    return { data: rows.map(toRecordDto), meta: { page: q.page, pageSize: q.pageSize, total } };
  },

  /** The KPI strip above the daily table — counted in SQL, in the caller's scope, never from a fetched page. */
  async dailySummary(auth: AuthContext, date: string, departmentId?: string): Promise<AttendanceDailySummaryDto> {
    const grouped = await prisma.attendanceRecord.groupBy({
      by: ['status'],
      where: {
        attendanceDate: date,
        employee: scopedEmployeeWhere(auth, departmentId ? [{ departmentId }] : []),
      },
      _count: { _all: true },
    });
    const count = (status: AttendanceStatus) => grouped.find((g) => g.status === status)?._count._all ?? 0;
    const working = count('NORMAL') + count('LATE') + count('EARLY_LEAVE') + count('LATE_AND_EARLY') + count('INCOMPLETE') + count('ABSENT') + count('SCHEDULED');
    return {
      date,
      scheduled: working,
      normal: count('NORMAL'),
      late: count('LATE') + count('LATE_AND_EARLY'),
      earlyLeave: count('EARLY_LEAVE') + count('LATE_AND_EARLY'),
      absent: count('ABSENT'),
      onLeave: count('ON_LEAVE'),
      incomplete: count('INCOMPLETE'),
      notClockedYet: count('SCHEDULED'),
      notScheduled: count('NOT_SCHEDULED'),
    };
  },

  /**
   * Recalculate a day (or range) for everybody in scope. This is how a day becomes final: `ABSENT` only appears once
   * the shift has ended, so the administrator (or a future scheduled job) runs this after the day is over.
   */
  async recalculate(auth: AuthContext, input: { from: string; to: string; employeeId?: string; departmentId?: string }, actor: Actor): Promise<{ employees: number; records: number }> {
    const dates = enumerateDates(input.from, input.to);
    if (dates.length === 0 || dates.length > 62) throw new AppError(400, 'VALIDATION_ERROR', 'Recalculate at most 62 days at a time');
    const where = scopedEmployeeWhere(auth, [
      { employmentStatus: 'ACTIVE' },
      ...(input.employeeId ? [{ id: input.employeeId }] : []),
      ...(input.departmentId ? [{ departmentId: input.departmentId }] : []),
    ]);
    // Task 48 (T44-P1-13): every employee in scope, in id-ordered batches. Before, `take: 2000` silently skipped the
    // rest, leaving their days (and the payroll inputs read from them) stale.
    let employees = 0;
    let records = 0;
    let cursor: string | undefined;
    for (;;) {
      const batch = await prisma.employee.findMany({ where, select: { id: true }, orderBy: { id: 'asc' }, take: RECALCULATE_BATCH, ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}) });
      if (batch.length === 0) break;
      records += (await attendanceCalculationService.recalculateRange(batch.map((e) => e.id), dates)).records;
      employees += batch.length;
      cursor = batch[batch.length - 1]!.id;
      if (batch.length < RECALCULATE_BATCH) break;
    }
    await auditService.log(attendanceAudit(actor, AUDIT_ACTIONS.RECALCULATE_ATTENDANCE, 'AttendanceRecord', `${input.from}..${input.to}`, {
      from: input.from, to: input.to, employees, records,
    }));
    return { employees, records };
  },

  /**
   * Range report: one row per employee with the counts HR actually asks for.
   *
   * Task 48 (T44-P1-13): the totals are one SQL aggregate over every employee in scope; the rows are a separate page.
   * Before, the report loaded the first 500 employees and summed only them, so employee #501 onward vanished from the
   * totals (and from the executive overview) without a word.
   */
  async report(auth: AuthContext, q: AttendanceReportQuery): Promise<AttendanceReportDto> {
    const page = q.page ?? 1;
    const pageSize = q.pageSize ?? 50;
    const where = reportEmployeeWhere(auth, q);
    const [totalEmployees, totals, employees] = await Promise.all([
      prisma.employee.count({ where }),
      attendanceRecordsService.totals(auth, q),
      prisma.employee.findMany({ where, ...employeeRef, orderBy: [{ employeeCode: 'asc' }, { id: 'asc' }], skip: (page - 1) * pageSize, take: pageSize }),
    ]);
    const grouped = employees.length === 0 ? [] : await prisma.attendanceRecord.groupBy({
      by: ['employeeId', 'status'],
      where: { employeeId: { in: employees.map((e) => e.id) }, attendanceDate: { gte: q.from, lte: q.to } },
      _count: { _all: true },
      _sum: { workMinutes: true, lateMinutes: true },
    });
    const rows = employees.map((employee) => ({ employee, ...attendanceFigures(grouped.filter((g) => g.employeeId === employee.id)) }));
    return { from: q.from, to: q.to, rows, totals, totalEmployees, meta: { page, pageSize, total: totalEmployees } };
  },

  /** The report's totals alone — every employee in scope, one grouped query, no rows. Used by the executive overview. */
  async totals(auth: AuthContext, q: Pick<AttendanceReportQuery, 'from' | 'to' | 'departmentId' | 'employeeId'>): Promise<AttendanceReportDto['totals']> {
    const grouped = await prisma.attendanceRecord.groupBy({
      by: ['status'],
      where: { employee: reportEmployeeWhere(auth, q), attendanceDate: { gte: q.from, lte: q.to } },
      _count: { _all: true },
      _sum: { workMinutes: true, lateMinutes: true },
    });
    return attendanceFigures(grouped);
  },

  /** Population + totals, no rows (executive overview). */
  async summary(auth: AuthContext, q: Pick<AttendanceReportQuery, 'from' | 'to' | 'departmentId'>): Promise<{ totalEmployees: number; totals: AttendanceReportDto['totals'] }> {
    const [totalEmployees, totals] = await Promise.all([prisma.employee.count({ where: reportEmployeeWhere(auth, q) }), attendanceRecordsService.totals(auth, q)]);
    return { totalEmployees, totals };
  },

  /** Report rows for named employees (the copilot's team view) — the caller's scope still applies. */
  async rowsFor(auth: AuthContext, q: { from: string; to: string }, employeeIds: string[]): Promise<AttendanceReportDto['rows']> {
    if (employeeIds.length === 0) return [];
    const employees = await prisma.employee.findMany({ where: scopedEmployeeWhere(auth, [{ id: { in: employeeIds } }]), ...employeeRef, orderBy: { employeeCode: 'asc' } });
    const grouped = await prisma.attendanceRecord.groupBy({
      by: ['employeeId', 'status'],
      where: { employeeId: { in: employees.map((e) => e.id) }, attendanceDate: { gte: q.from, lte: q.to } },
      _count: { _all: true },
      _sum: { workMinutes: true, lateMinutes: true },
    });
    return employees.map((employee) => ({ employee, ...attendanceFigures(grouped.filter((g) => g.employeeId === employee.id)) }));
  },

  /** Business "today" for an organization — the UI asks so it never guesses the customer's timezone. */
  async today(auth: AuthContext): Promise<{ date: string; timezone: string }> {
    const employee = auth.employeeId
      ? await prisma.employee.findUnique({ where: { id: auth.employeeId }, select: { organization: { select: { timezone: true } } } })
      : null;
    const timezone = employee?.organization.timezone ?? (await prisma.organization.findFirst({ select: { timezone: true }, orderBy: { code: 'asc' } }))?.timezone ?? 'UTC';
    return { date: businessToday(timezone), timezone };
  },
};
