/**
 * Task 20 — Time & Attendance MVP.
 *
 * The calculation is a pure function, so the arithmetic is tested directly; everything else goes through HTTP against
 * the real app, with clock events written at chosen instants so "late", "absent" and "overnight" are deterministic
 * rather than dependent on when the suite happens to run.
 */
import type { Server } from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, businessToday, calculateAttendance, weekdayOf, zonedTimeToUtc } from '@hr/shared';
import { prisma } from '../src/lib/prisma';
import { createTestServer, createUser, loginAs, resetDatabase } from './helpers';

const app: Server = createTestServer();
const PW = 'Correct-Horse-1';
const TZ = 'Asia/Bangkok';

type Session = { cookie: string; csrf: string; user: { id: string } };
const as = (s: Session, m: 'get' | 'post' | 'patch', url: string) => request(app)[m](url).set('Cookie', s.cookie).set('x-csrf-token', s.csrf);
const err = (r: request.Response) => `${r.status} ${r.body?.error?.code ?? ''}`.trim();

let admin: Session, manager: Session, staff: Session, colleague: Session, outsider: Session;
let orgId: string, deptId: string;
let shiftDay: string, shiftNight: string;
const emp: Record<string, string> = {};
/**
 * Finished weekdays, most recent first: `past[0]` is the last weekday before today. Every calculation test picks its
 * own day from this list, so no two tests share a date and "the day has ended" is always true.
 */
const past: string[] = [];
let pastDay = '';
let holiday = '';

function collectPastWeekdays(today: string, count: number) {
  let d = today;
  while (past.length < count) {
    d = addDays(d, -1);
    if (!['SAT', 'SUN'].includes(weekdayOf(d))) past.push(d);
  }
}

beforeAll(async () => {
  await resetDatabase();
  const org = await prisma.organization.create({ data: { code: 'ATT', name: 'Attendance Co', timezone: TZ } });
  orgId = org.id;
  const dept = await prisma.department.create({ data: { organizationId: org.id, code: 'OPS', name: 'Operations' } });
  deptId = dept.id;
  const otherDept = await prisma.department.create({ data: { organizationId: org.id, code: 'FIN', name: 'Finance' } });
  const position = await prisma.position.create({ data: { departmentId: dept.id, code: 'P1', title: 'Officer' } });
  const mk = async (code: string, managerId: string | null, departmentId = dept.id) =>
    (await prisma.employee.create({
      data: {
        employeeCode: code, firstName: code, lastName: 'Person', email: `${code.toLowerCase()}@att.local`,
        hireDate: new Date('2020-01-01'), organizationId: org.id, departmentId, positionId: position.id, managerId,
        employmentType: 'FULL_TIME', employmentStatus: 'ACTIVE',
        positionHistory: { create: { positionId: position.id, departmentId, startDate: new Date('2020-01-01') } },
      },
    })).id;
  emp.MGR = await mk('MGR', null);
  emp.STAFF = await mk('STAFF', emp.MGR);
  emp.COLL = await mk('COLL', emp.MGR);
  emp.OUT = await mk('OUT', null, otherDept.id);

  await createUser({ email: 'admin@att.local', password: PW, role: 'SYSTEM_ADMIN' });
  await createUser({ email: 'mgr@att.local', password: PW, role: 'MANAGER', employeeId: emp.MGR });
  await createUser({ email: 'staff@att.local', password: PW, role: 'EMPLOYEE', employeeId: emp.STAFF });
  await createUser({ email: 'coll@att.local', password: PW, role: 'EMPLOYEE', employeeId: emp.COLL });
  await createUser({ email: 'out@att.local', password: PW, role: 'EMPLOYEE', employeeId: emp.OUT });
  [admin, manager, staff, colleague, outsider] = await Promise.all(
    ['admin', 'mgr', 'staff', 'coll', 'out'].map((u) => loginAs(app, `${u}@att.local`, PW)),
  );

  collectPastWeekdays(businessToday(TZ), 14);
  pastDay = past[0];
  holiday = past[12]; // far away from every day a calculation test uses

  // the work calendar from Leave is reused, never duplicated
  const calendar = await as(admin, 'post', '/api/v1/calendars').send({ organizationId: org.id, code: 'STD', name: 'Standard', workingDays: ['MON', 'TUE', 'WED', 'THU', 'FRI'] });
  expect(calendar.status).toBe(201);
  await as(admin, 'post', `/api/v1/calendars/${calendar.body.data.id}/holidays`).send({ date: holiday, name: 'Company holiday' });
  await as(admin, 'patch', `/api/v1/calendars/organizations/${org.id}/default`).send({ calendarId: calendar.body.data.id });

  const day = await as(admin, 'post', '/api/v1/attendance/shifts').send({ organizationId: org.id, code: 'D1', name: 'Day', startTime: '08:00', endTime: '17:00', breakMinutes: 60, lateGraceMinutes: 10, earlyLeaveGraceMinutes: 10 });
  expect(day.status).toBe(201);
  shiftDay = day.body.data.id;
  const night = await as(admin, 'post', '/api/v1/attendance/shifts').send({ organizationId: org.id, code: 'N1', name: 'Night', startTime: '20:00', endTime: '05:00', breakMinutes: 60, lateGraceMinutes: 10, earlyLeaveGraceMinutes: 10 });
  expect(night.status).toBe(201);
  shiftNight = night.body.data.id;
}, 120000);

afterAll(async () => {
  await resetDatabase();
  await prisma.$disconnect();
});

/** Writes raw clock events at chosen wall-clock times, then recalculates the day through the API. */
async function clockAt(employeeId: string, date: string, times: { in?: string; out?: string; outNextDay?: boolean }) {
  if (times.in) {
    await prisma.attendanceClockEvent.create({ data: { employeeId, eventType: 'CLOCK_IN', occurredAt: zonedTimeToUtc(date, times.in, TZ), attendanceDate: date, source: 'ADMIN' } });
  }
  if (times.out) {
    await prisma.attendanceClockEvent.create({ data: { employeeId, eventType: 'CLOCK_OUT', occurredAt: zonedTimeToUtc(times.outNextDay ? addDays(date, 1) : date, times.out, TZ), attendanceDate: date, source: 'ADMIN' } });
  }
}
const assign = (employeeIds: string[], from: string, to: string, shiftId: string | null, extra: object = {}) =>
  as(admin, 'post', '/api/v1/attendance/schedules/assign').send({ employeeIds, from, to, shiftId, ...extra });
const recalc = (from: string, to: string, employeeId?: string) => as(admin, 'post', '/api/v1/attendance/recalculate').send({ from, to, employeeId });
const recordOf = async (employeeId: string, date: string) =>
  prisma.attendanceRecord.findUnique({ where: { employeeId_attendanceDate: { employeeId, attendanceDate: date } } });

// ---------------------------------------------------------------------------
describe('the calculation itself (pure, no database)', () => {
  const shift = { code: 'D1', startTime: '08:00', endTime: '17:00', breakMinutes: 60, lateGraceMinutes: 10, earlyLeaveGraceMinutes: 10 };
  const date = '2026-03-10'; // a Tuesday
  const at = (time: string, on = date) => zonedTimeToUtc(on, time, TZ);
  const run = (over: Partial<Parameters<typeof calculateAttendance>[0]> = {}) =>
    calculateAttendance({ date, timezone: TZ, dayType: 'WORK', shift, clockIn: null, clockOut: null, leavePortion: null, now: at('23:00'), ...over });

  it('a normal day: worked minutes are the span minus the break, nothing is late', () => {
    const r = run({ clockIn: at('08:00'), clockOut: at('17:00') });
    expect(r.status).toBe('NORMAL');
    expect(r.workMinutes).toBe(480); // 9 hours minus a 1 hour break
    expect(r.requiredMinutes).toBe(480);
    expect(r.lateMinutes).toBe(0);
    expect(r.extraMinutes).toBe(0);
  });

  it('grace decides the status; the recorded minutes are the real ones', () => {
    expect(run({ clockIn: at('08:08'), clockOut: at('17:00') }).status).toBe('NORMAL'); // inside the 10-minute grace
    const late = run({ clockIn: at('08:15'), clockOut: at('17:00') });
    expect(late.status).toBe('LATE');
    expect(late.lateMinutes).toBe(15); // not 5: HR sees the real lateness
    const early = run({ clockIn: at('08:00'), clockOut: at('16:30') });
    expect(early.status).toBe('EARLY_LEAVE');
    expect(early.earlyLeaveMinutes).toBe(30);
    expect(run({ clockIn: at('08:20'), clockOut: at('16:00') }).status).toBe('LATE_AND_EARLY');
  });

  it('a half-finished day is INCOMPLETE, and an unfinished day is never absent', () => {
    expect(run({ clockIn: at('08:00') }).status).toBe('INCOMPLETE');
    expect(run({ clockOut: at('17:00') }).status).toBe('INCOMPLETE');
    expect(run({ now: at('12:00') }).status).toBe('SCHEDULED'); // the day is still running
    expect(run({ now: at('23:00') }).status).toBe('ABSENT'); // it has ended with nothing recorded
  });

  it('leave is authoritative: a full day is ON_LEAVE, a half day narrows the expected window', () => {
    expect(run({ leavePortion: 'FULL' }).status).toBe('ON_LEAVE');
    expect(run({ leavePortion: 'FULL' }).leaveUnits).toBe(1);
    // morning on leave → expected 12:30–17:00; arriving at 12:30 is not late
    const morningOff = run({ leavePortion: 'AM', clockIn: at('12:30'), clockOut: at('17:00') });
    expect(morningOff.status).toBe('NORMAL');
    expect(morningOff.leaveUnits).toBe(0.5);
    expect(morningOff.requiredMinutes).toBe(240); // half the span minus half the break
    expect(run({ leavePortion: 'AM', clockIn: at('08:00'), clockOut: at('17:00') }).workMinutes).toBe(510);
    // afternoon on leave → expected 08:00–12:30; leaving then is not early
    expect(run({ leavePortion: 'PM', clockIn: at('08:00'), clockOut: at('12:30') }).status).toBe('NORMAL');
    // and a half day of leave does not excuse the working half
    expect(run({ leavePortion: 'PM' }).status).toBe('ABSENT');
  });

  it('a day that was never scheduled is NOT_SCHEDULED, and working on it is still recorded', () => {
    expect(run({ dayType: 'OFF', shift: null }).status).toBe('NOT_SCHEDULED');
    const onHoliday = run({ dayType: 'HOLIDAY', clockIn: at('09:00'), clockOut: at('13:00') });
    expect(onHoliday.status).toBe('NOT_SCHEDULED');
    expect(onHoliday.workMinutes).toBe(180); // 4 hours minus the break — overtime is Task 21, not this one
  });

  it('an overnight shift belongs to the day it started, across the date boundary', () => {
    const night = { ...shift, startTime: '20:00', endTime: '05:00' };
    const r = calculateAttendance({
      date, timezone: TZ, dayType: 'WORK', shift: night,
      clockIn: at('20:00'), clockOut: at('05:00', '2026-03-11'),
      leavePortion: null, now: at('08:00', '2026-03-11'),
    });
    expect(r.status).toBe('NORMAL');
    expect(r.workMinutes).toBe(480); // 9 hours minus the break
    expect(r.scheduledEnd?.toISOString()).toBe(zonedTimeToUtc('2026-03-11', '05:00', TZ).toISOString());
  });

  it('the wall clock is the organization\'s, not the server\'s', () => {
    // 08:00 in Bangkok is 01:00 UTC; the same shift in London is a different instant
    expect(zonedTimeToUtc(date, '08:00', 'Asia/Bangkok').toISOString()).toBe('2026-03-10T01:00:00.000Z');
    expect(zonedTimeToUtc(date, '08:00', 'Europe/London').toISOString()).toBe('2026-03-10T08:00:00.000Z');
    // and it survives a daylight-saving change (London is UTC+1 in July)
    expect(zonedTimeToUtc('2026-07-10', '08:00', 'Europe/London').toISOString()).toBe('2026-07-10T07:00:00.000Z');
  });
});

// ---------------------------------------------------------------------------
describe('shifts', () => {
  it('a shift is validated, unique per organization, and its overnight flag is derived', async () => {
    expect((await as(admin, 'post', '/api/v1/attendance/shifts').send({ organizationId: orgId, code: 'D1', name: 'Duplicate', startTime: '09:00', endTime: '18:00' })).status).toBe(409);
    expect((await as(admin, 'post', '/api/v1/attendance/shifts').send({ organizationId: orgId, code: 'BAD', name: 'Bad', startTime: '08:00', endTime: '08:00' })).status).toBe(400);
    expect((await as(admin, 'post', '/api/v1/attendance/shifts').send({ organizationId: orgId, code: 'BAD2', name: 'Bad', startTime: '25:00', endTime: '18:00' })).status).toBe(400);

    const day = await as(admin, 'get', `/api/v1/attendance/shifts/${shiftDay}`);
    expect(day.body.data).toMatchObject({ code: 'D1', isOvernight: false, requiredMinutes: 480 });
    const night = await as(admin, 'get', `/api/v1/attendance/shifts/${shiftNight}`);
    expect(night.body.data).toMatchObject({ code: 'N1', isOvernight: true, requiredMinutes: 480 });
  });

  it('only attendance.manage may create or change a shift', async () => {
    expect((await as(staff, 'post', '/api/v1/attendance/shifts').send({ organizationId: orgId, code: 'X1', name: 'X', startTime: '08:00', endTime: '17:00' })).status).toBe(403);
    expect((await as(staff, 'patch', `/api/v1/attendance/shifts/${shiftDay}`).send({ name: 'Renamed' })).status).toBe(403);
    expect((await as(admin, 'patch', `/api/v1/attendance/shifts/${shiftDay}`).send({ lateGraceMinutes: 10 })).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
describe('schedules', () => {
  it('assigning a range follows the work calendar: weekends off, holidays holidays', async () => {
    const from = past[13];
    const to = addDays(pastDay, 5);
    const res = await assign([emp.STAFF, emp.COLL], from, to, shiftDay);
    expect(res.status).toBe(201);
    expect(res.body.data.employees).toBe(2);

    const rows = await prisma.attendanceSchedule.findMany({ where: { employeeId: emp.STAFF, date: { gte: from, lte: to } }, select: { date: true, dayType: true, shiftId: true } });
    const byDate = new Map(rows.map((r) => [r.date, r]));
    expect(byDate.get(pastDay)).toMatchObject({ dayType: 'WORK', shiftId: shiftDay });
    expect(byDate.get(holiday)).toMatchObject({ dayType: 'HOLIDAY', shiftId: null });
    const weekend = rows.find((r) => ['SAT', 'SUN'].includes(weekdayOf(r.date)));
    expect(weekend).toMatchObject({ dayType: 'OFF', shiftId: null });
  });

  it('the grid is scoped, and only attendance.schedule_manage may assign', async () => {
    expect((await as(staff, 'post', '/api/v1/attendance/schedules/assign').send({ employeeIds: [emp.STAFF], from: pastDay, to: pastDay, shiftId: shiftDay })).status).toBe(403);
    const mine = await as(staff, 'get', `/api/v1/attendance/schedules?from=${pastDay}&to=${pastDay}`);
    expect(mine.status).toBe(200);
    expect(mine.body.data).toHaveLength(1); // SELF scope: only me
    const team = await as(manager, 'get', `/api/v1/attendance/schedules?from=${pastDay}&to=${pastDay}`);
    expect(team.body.data.map((r: { employee: { employeeCode: string } }) => r.employee.employeeCode).sort()).toEqual(['COLL', 'MGR', 'STAFF']);
    expect(team.body.data[0].days[0]).toMatchObject({ date: pastDay });
  });

  it('a shift from another organization is refused', async () => {
    const other = await prisma.organization.create({ data: { code: 'OTH', name: 'Other Co', timezone: TZ } });
    const otherShift = await as(admin, 'post', '/api/v1/attendance/shifts').send({ organizationId: other.id, code: 'O1', name: 'Other', startTime: '08:00', endTime: '17:00' });
    expect(err(await assign([emp.STAFF], pastDay, pastDay, otherShift.body.data.id))).toBe('409 SHIFT_ORGANIZATION_MISMATCH');
  });
});

// ---------------------------------------------------------------------------
describe('clocking in and out', () => {
  it('an employee clocks themselves in and out; the employee comes from the session', async () => {
    const today = businessToday(TZ);
    await assign([emp.STAFF], today, today, shiftDay, { includeHolidays: true, weekdays: [weekdayOf(today)] });

    const status = await as(staff, 'get', '/api/v1/attendance/clock/status');
    expect(status.status).toBe(200);
    expect(status.body.data).toMatchObject({ attendanceDate: today, timezone: TZ, canClockIn: true, canClockOut: false });

    const inRes = await as(staff, 'post', '/api/v1/attendance/clock-in').send({});
    expect(inRes.status).toBe(201);
    expect(inRes.body.data).toMatchObject({ eventType: 'CLOCK_IN', attendanceDate: today, source: 'WEB' });
    expect(err(await as(staff, 'post', '/api/v1/attendance/clock-in').send({}))).toBe('409 ALREADY_CLOCKED_IN');

    const afterIn = await as(staff, 'get', '/api/v1/attendance/clock/status');
    expect(afterIn.body.data).toMatchObject({ canClockIn: false, canClockOut: true });

    const outRes = await as(staff, 'post', '/api/v1/attendance/clock-out').send({});
    expect(outRes.status).toBe(201);
    expect(err(await as(staff, 'post', '/api/v1/attendance/clock-out').send({}))).toBe('409 ALREADY_CLOCKED_OUT');

    // the event trail is append-only: two events, nothing updated
    const events = await prisma.attendanceClockEvent.findMany({ where: { employeeId: emp.STAFF, attendanceDate: today }, orderBy: { occurredAt: 'asc' } });
    expect(events.map((e) => e.eventType)).toEqual(['CLOCK_IN', 'CLOCK_OUT']);
    expect(await recordOf(emp.STAFF, today)).toMatchObject({ dayType: 'WORK', shiftId: shiftDay });
  }, 60000);

  it('clocking out without clocking in is refused, and an account with no employee cannot clock at all', async () => {
    expect(err(await as(colleague, 'post', '/api/v1/attendance/clock-out').send({}))).toBe('409 NOT_CLOCKED_IN');
    const systemUser = await loginAs(app, 'admin@att.local', PW); // SYSTEM_ADMIN has no employee record
    expect(err(await as(systemUser, 'post', '/api/v1/attendance/clock-in').send({}))).toBe('409 EMPLOYEE_PROFILE_REQUIRED');
  });

  it('two concurrent clock-ins produce exactly one event', async () => {
    const today = businessToday(TZ);
    await prisma.attendanceClockEvent.deleteMany({ where: { employeeId: emp.COLL } });
    await assign([emp.COLL], today, today, shiftDay, { includeHolidays: true, weekdays: [weekdayOf(today)] });

    const results = await Promise.all([
      as(colleague, 'post', '/api/v1/attendance/clock-in').send({}),
      as(colleague, 'post', '/api/v1/attendance/clock-in').send({}),
    ]);
    const codes = results.map((r) => (r.status === 201 ? 'OK' : r.body.error.code)).sort();
    expect(codes).toEqual(['ALREADY_CLOCKED_IN', 'OK']);
    expect(await prisma.attendanceClockEvent.count({ where: { employeeId: emp.COLL, eventType: 'CLOCK_IN' } })).toBe(1);

    const outs = await Promise.all([
      as(colleague, 'post', '/api/v1/attendance/clock-out').send({}),
      as(colleague, 'post', '/api/v1/attendance/clock-out').send({}),
    ]);
    expect(outs.map((r) => (r.status === 201 ? 'OK' : r.body.error.code)).sort()).toEqual(['ALREADY_CLOCKED_OUT', 'OK']);
    expect(await prisma.attendanceClockEvent.count({ where: { employeeId: emp.COLL, eventType: 'CLOCK_OUT' } })).toBe(1);
  }, 60000);
});

// ---------------------------------------------------------------------------
describe('daily calculation through the API', () => {
  it('normal, late, early and absent days are derived from the events', async () => {
    const day = past[1];
    await assign([emp.STAFF, emp.COLL, emp.MGR], day, day, shiftDay, { weekdays: [weekdayOf(day)] });
    await clockAt(emp.STAFF, day, { in: '08:05', out: '17:00' });
    await clockAt(emp.COLL, day, { in: '08:25', out: '16:30' });
    // MGR never clocked
    expect((await recalc(day, day)).status).toBe(200);

    expect(await recordOf(emp.STAFF, day)).toMatchObject({ status: 'NORMAL', workMinutes: 475, lateMinutes: 0 });
    expect(await recordOf(emp.COLL, day)).toMatchObject({ status: 'LATE_AND_EARLY', lateMinutes: 25, earlyLeaveMinutes: 30 });
    expect(await recordOf(emp.MGR, day)).toMatchObject({ status: 'ABSENT', workMinutes: 0 });
  }, 60000);

  it('approved leave prevents a false absence', async () => {
    const day = past[3];
    await assign([emp.STAFF], day, day, shiftDay, { weekdays: [weekdayOf(day)] });
    await prisma.leaveRequest.create({
      data: {
        employeeId: emp.STAFF, leaveTypeId: (await prisma.leaveType.create({ data: { code: 'ANN', name: 'Annual' } })).id,
        startDate: day, endDate: day, startPart: 'FULL', endPart: 'FULL', units: 1, status: 'APPROVED',
        createdByUserId: staff.user.id, approvedAt: new Date(),
      },
    });
    await recalc(day, day, emp.STAFF);
    expect(await recordOf(emp.STAFF, day)).toMatchObject({ status: 'ON_LEAVE', leaveUnits: 1 });
  }, 60000);

  it('half-day leave leaves the other half to be worked', async () => {
    const day = past[4];
    await assign([emp.COLL], day, day, shiftDay, { weekdays: [weekdayOf(day)] });
    const type = await prisma.leaveType.findFirstOrThrow();
    await prisma.leaveRequest.create({
      data: {
        employeeId: emp.COLL, leaveTypeId: type.id, startDate: day, endDate: day, startPart: 'FULL', endPart: 'AM',
        units: 0.5, status: 'APPROVED', createdByUserId: colleague.user.id, approvedAt: new Date(),
      },
    });
    await clockAt(emp.COLL, day, { in: '12:30', out: '17:00' });
    await recalc(day, day, emp.COLL);
    const record = await recordOf(emp.COLL, day);
    expect(record).toMatchObject({ status: 'NORMAL', leaveUnits: 0.5 });
    expect(record?.workMinutes).toBe(240);
  }, 60000);

  it('a holiday is not an absence, and an overnight shift is one day of work', async () => {
    await assign([emp.STAFF], holiday, holiday, shiftDay, { weekdays: [weekdayOf(holiday)] });
    await recalc(holiday, holiday, emp.STAFF);
    expect(await recordOf(emp.STAFF, holiday)).toMatchObject({ status: 'NOT_SCHEDULED', dayType: 'HOLIDAY' });

    const night = past[6];
    await assign([emp.STAFF], night, night, shiftNight, { weekdays: [weekdayOf(night)] });
    await clockAt(emp.STAFF, night, { in: '20:00', out: '05:00', outNextDay: true });
    await recalc(night, night, emp.STAFF);
    const record = await recordOf(emp.STAFF, night);
    expect(record).toMatchObject({ status: 'NORMAL', workMinutes: 480 });
    expect(record?.scheduledEnd?.toISOString()).toBe(zonedTimeToUtc(addDays(night, 1), '05:00', TZ).toISOString());
  }, 60000);

  it('a missing clock-out is INCOMPLETE, not a guess', async () => {
    const day = past[7];
    await assign([emp.COLL], day, day, shiftDay, { weekdays: [weekdayOf(day)] });
    await clockAt(emp.COLL, day, { in: '08:00' });
    await recalc(day, day, emp.COLL);
    expect(await recordOf(emp.COLL, day)).toMatchObject({ status: 'INCOMPLETE', workMinutes: 0 });
  }, 60000);

  it('recalculating twice changes nothing (the record is a cache, not a second truth)', async () => {
    const day = past[1];
    const before = await recordOf(emp.STAFF, day);
    await recalc(day, day, emp.STAFF);
    const after = await recordOf(emp.STAFF, day);
    expect({ ...after, calculatedAt: null }).toEqual({ ...before, calculatedAt: null });
  }, 60000);
});

// ---------------------------------------------------------------------------
describe('reading attendance is scoped', () => {
  it('SELF sees only itself, TEAM sees the team, ALL sees everyone', async () => {
    const day = past[1];
    const own = await as(staff, 'get', `/api/v1/attendance/records?date=${day}&pageSize=50`);
    expect(own.body.data.every((r: { employee: { employeeCode: string } }) => r.employee.employeeCode === 'STAFF')).toBe(true);

    const team = await as(manager, 'get', `/api/v1/attendance/records?date=${day}&pageSize=50`);
    const teamCodes = new Set(team.body.data.map((r: { employee: { employeeCode: string } }) => r.employee.employeeCode));
    expect(teamCodes.has('STAFF')).toBe(true);
    expect(teamCodes.has('OUT')).toBe(false); // not their report

    const all = await as(admin, 'get', `/api/v1/attendance/records?date=${day}&pageSize=50`);
    expect(all.body.meta.total).toBeGreaterThanOrEqual(team.body.meta.total);

    const mine = await as(staff, 'get', `/api/v1/attendance/me?from=${day}&to=${day}`);
    expect(mine.status).toBe(200);
    expect(mine.body.data.every((r: { employee: { employeeCode: string } }) => r.employee.employeeCode === 'STAFF')).toBe(true);
  });

  it('the daily summary and the report count what the caller may see', async () => {
    const day = past[1];
    const summary = await as(admin, 'get', `/api/v1/attendance/summary?date=${day}`);
    expect(summary.status).toBe(200);
    expect(summary.body.data).toMatchObject({ date: day, absent: expect.any(Number), normal: expect.any(Number) });

    const report = await as(admin, 'get', `/api/v1/attendance/reports/overview?from=${past[9]}&to=${pastDay}`);
    expect(report.status).toBe(200);
    const staffRow = report.body.data.rows.find((r: { employee: { employeeCode: string } }) => r.employee.employeeCode === 'STAFF');
    expect(staffRow).toMatchObject({ presentDays: expect.any(Number), absentDays: expect.any(Number), leaveDays: 1 });
    expect(report.body.data.totals.workMinutes).toBeGreaterThan(0);

    const scopedReport = await as(staff, 'get', `/api/v1/attendance/reports/overview?from=${pastDay}&to=${pastDay}`);
    expect(scopedReport.body.data.rows).toHaveLength(1);
  });

  it('attendance.view is required to read anything', async () => {
    await prisma.rolePermission.deleteMany({ where: { role: { code: 'EMPLOYEE' }, permission: { code: 'attendance.view' } } });
    const fresh = await loginAs(app, 'out@att.local', PW);
    expect((await as(fresh, 'get', `/api/v1/attendance/records?date=${pastDay}`)).status).toBe(403);
    await prisma.rolePermission.create({
      data: { roleId: (await prisma.role.findUniqueOrThrow({ where: { code: 'EMPLOYEE' } })).id, permissionId: (await prisma.permission.findUniqueOrThrow({ where: { code: 'attendance.view' } })).id },
    });
  });
});

// ---------------------------------------------------------------------------
describe('correction requests', () => {
  let correctionId = '';
  const day = () => past[7]; // the INCOMPLETE day from the calculation tests

  beforeAll(async () => {
    const definition = await as(admin, 'post', '/api/v1/workflow/definitions').send({
      code: 'ATTENDANCE_CORRECTION', name: 'Attendance correction', module: 'attendance', entityType: 'ATTENDANCE_CORRECTION',
      steps: [{ name: 'Direct manager', approverType: 'DIRECT_MANAGER' }],
    });
    expect(definition.status).toBe(201);
    expect((await as(admin, 'post', `/api/v1/workflow/definitions/${definition.body.data.id}/activate`)).status).toBe(200);
  });

  it('an employee submits a correction for their own day, and the approver is notified', async () => {
    const res = await as(colleague, 'post', '/api/v1/attendance/corrections').send({ attendanceDate: day(), requestedClockOut: '17:00', reason: 'Forgot to clock out before leaving' });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ status: 'PENDING', attendanceDate: day(), employee: { employeeCode: 'COLL' } });
    correctionId = res.body.data.id;

    expect(err(await as(colleague, 'post', '/api/v1/attendance/corrections').send({ attendanceDate: day(), requestedClockOut: '18:00', reason: 'Another one for the same day' }))).toBe('409 CORRECTION_ALREADY_PENDING');
    expect((await as(colleague, 'post', '/api/v1/attendance/corrections').send({ attendanceDate: addDays(businessToday(TZ), 3), requestedClockOut: '17:00', reason: 'A day that has not happened' })).status).toBe(400);

    const inbox = await as(manager, 'get', '/api/v1/notifications?page=1&pageSize=20');
    expect(inbox.body.data.some((n: { type: string; body: string }) => n.type === 'APPROVAL_REQUIRED' && n.body.includes('attendance correction'))).toBe(true);

    const queue = await as(manager, 'get', '/api/v1/attendance/corrections?view=inbox');
    expect(queue.body.data.map((c: { id: string }) => c.id)).toContain(correctionId);
  }, 60000);

  it('approving applies the corrected time without touching the raw events', async () => {
    const before = await prisma.attendanceClockEvent.findMany({ where: { employeeId: emp.COLL, attendanceDate: day() }, select: { id: true, eventType: true, occurredAt: true } });
    const instanceId = (await as(manager, 'get', `/api/v1/attendance/corrections/${correctionId}`)).body.data.workflowInstanceId;
    expect((await as(manager, 'post', `/api/v1/workflow/instances/${instanceId}/actions`).send({ action: 'APPROVE', comment: 'Confirmed with the team' })).status).toBe(200);

    const record = await recordOf(emp.COLL, day());
    expect(record).toMatchObject({ status: 'NORMAL', correctionId });
    expect(record?.lastClockOut?.toISOString()).toBe(zonedTimeToUtc(day(), '17:00', TZ).toISOString());
    expect(record?.workMinutes).toBe(480);

    const after = await prisma.attendanceClockEvent.findMany({ where: { employeeId: emp.COLL, attendanceDate: day() }, select: { id: true, eventType: true, occurredAt: true } });
    expect(after).toEqual(before); // append-only: the correction never rewrote history

    const notified = await as(colleague, 'get', '/api/v1/notifications?page=1&pageSize=20');
    expect(notified.body.data.some((n: { type: string }) => n.type === 'ATTENDANCE_CORRECTION_APPROVED')).toBe(true);

    const audits = await prisma.auditLog.findMany({ where: { recordType: 'AttendanceCorrection', recordId: correctionId }, select: { action: true } });
    expect(audits.map((a) => a.action).sort()).toEqual(['APPROVE_ATTENDANCE_CORRECTION', 'SUBMIT_ATTENDANCE_CORRECTION']);
  }, 60000);

  it('a recalculation keeps the approved correction (it is an input, not an edit)', async () => {
    await recalc(day(), day(), emp.COLL);
    expect(await recordOf(emp.COLL, day())).toMatchObject({ status: 'NORMAL', correctionId });
  }, 60000);

  it('a rejected correction leaves the day as it was', async () => {
    const target = past[8];
    await assign([emp.COLL], target, target, shiftDay, { weekdays: [weekdayOf(target)] });
    await clockAt(emp.COLL, target, { in: '09:30' });
    await recalc(target, target, emp.COLL);

    const submitted = await as(colleague, 'post', '/api/v1/attendance/corrections').send({ attendanceDate: target, requestedClockIn: '08:00', requestedClockOut: '17:00', reason: 'The clock in the lobby was down' });
    expect(submitted.status).toBe(201);
    const instanceId = submitted.body.data.workflowInstanceId;
    expect((await as(manager, 'post', `/api/v1/workflow/instances/${instanceId}/actions`).send({ action: 'REJECT', comment: 'No record of that' })).status).toBe(200);

    const detail = await as(colleague, 'get', `/api/v1/attendance/corrections/${submitted.body.data.id}`);
    expect(detail.body.data.status).toBe('REJECTED');
    const record = await recordOf(emp.COLL, target);
    expect(record).toMatchObject({ status: 'INCOMPLETE', correctionId: null }); // unchanged by the rejection
    const rejected = await as(colleague, 'get', '/api/v1/notifications?page=1&pageSize=20');
    expect(rejected.body.data.some((n: { type: string }) => n.type === 'ATTENDANCE_CORRECTION_REJECTED')).toBe(true);
  }, 60000);

  it('nobody reads or withdraws somebody else\'s correction', async () => {
    const own = await as(colleague, 'post', '/api/v1/attendance/corrections').send({ attendanceDate: past[10], requestedClockIn: '08:00', requestedClockOut: '17:00', reason: 'Was at the client site all day' });
    expect(own.status).toBe(201);
    expect(err(await as(outsider, 'get', `/api/v1/attendance/corrections/${own.body.data.id}`))).toBe('404 CORRECTION_NOT_FOUND');
    expect(err(await as(outsider, 'post', `/api/v1/attendance/corrections/${own.body.data.id}/cancel`))).toBe('404 CORRECTION_NOT_FOUND');
    // the requester may withdraw their own
    expect((await as(colleague, 'post', `/api/v1/attendance/corrections/${own.body.data.id}/cancel`)).body.data.status).toBe('CANCELLED');
  }, 60000);
});
