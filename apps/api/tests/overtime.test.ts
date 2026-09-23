/**
 * Task 21 — Overtime MVP.
 *
 * Overtime is payroll input, so the tests care about three things above all: the eligibility arithmetic (especially
 * that making up a late arrival is never overtime), that what is snapshotted at submit stays snapshotted, and that a
 * claim can never end up approved without attendance to support it.
 */
import type { Server } from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, businessToday, calculateOvertimeEligibility, checkOvertimeClaim, weekdayOf, zonedTimeToUtc } from '@hr/shared';
import { prisma } from '../src/lib/prisma';
import { overtimeService } from '../src/modules/attendance/overtime.service';
import { createTestServer, createUser, loginAs, resetDatabase } from './helpers';

const app: Server = createTestServer();
const PW = 'Correct-Horse-1';
const TZ = 'Asia/Bangkok';

type Session = { cookie: string; csrf: string; user: { id: string } };
const as = (s: Session, m: 'get' | 'post' | 'patch', url: string) => request(app)[m](url).set('Cookie', s.cookie).set('x-csrf-token', s.csrf);
const err = (r: request.Response) => `${r.status} ${r.body?.error?.code ?? ''}`.trim();

let admin: Session, manager: Session, staff: Session, colleague: Session, outsider: Session;
let orgId: string, otherOrgId: string, shiftDay: string, policyId: string;
const emp: Record<string, string> = {};
const past: string[] = [];
let holiday = '';

function collectPastWeekdays(today: string, count: number) {
  let d = today;
  while (past.length < count) {
    d = addDays(d, -1);
    if (!['SAT', 'SUN'].includes(weekdayOf(d))) past.push(d);
  }
}
const at = (date: string, time: string) => zonedTimeToUtc(date, time, TZ);

/** Writes the clock events for a day and recalculates it, the same way the attendance suite does. */
async function workedDay(employeeId: string, date: string, times: { in?: string; out?: string; outNextDay?: boolean }) {
  if (times.in) await prisma.attendanceClockEvent.create({ data: { employeeId, eventType: 'CLOCK_IN', occurredAt: at(date, times.in), attendanceDate: date, source: 'ADMIN' } });
  if (times.out) await prisma.attendanceClockEvent.create({ data: { employeeId, eventType: 'CLOCK_OUT', occurredAt: at(times.outNextDay ? addDays(date, 1) : date, times.out), attendanceDate: date, source: 'ADMIN' } });
  await as(admin, 'post', '/api/v1/attendance/recalculate').send({ from: date, to: date, employeeId });
}
const assign = (employeeIds: string[], date: string, shiftId: string | null, extra: object = {}) =>
  as(admin, 'post', '/api/v1/attendance/schedules/assign').send({ employeeIds, from: date, to: date, shiftId, weekdays: [weekdayOf(date)], ...extra });
const preview = (s: Session, attendanceDate: string) => as(s, 'post', '/api/v1/attendance/overtime/preview').send({ attendanceDate });
const claim = (s: Session, attendanceDate: string, claimedMinutes: number, reason = 'Finished the month-end run') =>
  as(s, 'post', '/api/v1/attendance/overtime/requests').send({ attendanceDate, claimedMinutes, reason });
const submit = (s: Session, id: string) => as(s, 'post', `/api/v1/attendance/overtime/requests/${id}/submit`);
const decide = (s: Session, instanceId: string, action: 'APPROVE' | 'REJECT', comment = 'ok') =>
  as(s, 'post', `/api/v1/workflow/instances/${instanceId}/actions`).send({ action, comment });

beforeAll(async () => {
  await resetDatabase();
  const org = await prisma.organization.create({ data: { code: 'OT', name: 'Overtime Co', timezone: TZ } });
  orgId = org.id;
  const other = await prisma.organization.create({ data: { code: 'OT2', name: 'Other Co', timezone: TZ } });
  otherOrgId = other.id;
  const dept = await prisma.department.create({ data: { organizationId: org.id, code: 'OPS', name: 'Operations' } });
  const otherDept = await prisma.department.create({ data: { organizationId: other.id, code: 'X', name: 'Elsewhere' } });
  const position = await prisma.position.create({ data: { departmentId: dept.id, code: 'P1', title: 'Officer' } });
  const otherPosition = await prisma.position.create({ data: { departmentId: otherDept.id, code: 'P2', title: 'Officer' } });
  const mk = async (code: string, managerId: string | null, d = dept, p = position, o = org) =>
    (await prisma.employee.create({
      data: {
        employeeCode: code, firstName: code, lastName: 'Person', email: `${code.toLowerCase()}@ot.local`,
        hireDate: new Date('2020-01-01'), organizationId: o.id, departmentId: d.id, positionId: p.id, managerId,
        employmentType: 'FULL_TIME', employmentStatus: 'ACTIVE',
        positionHistory: { create: { positionId: p.id, departmentId: d.id, startDate: new Date('2020-01-01') } },
      },
    })).id;
  emp.MGR = await mk('MGR', null);
  emp.STAFF = await mk('STAFF', emp.MGR);
  emp.COLL = await mk('COLL', emp.MGR);
  emp.OUT = await mk('OUT', null, otherDept, otherPosition, other);

  await createUser({ email: 'admin@ot.local', password: PW, role: 'SYSTEM_ADMIN' });
  await createUser({ email: 'mgr@ot.local', password: PW, role: 'MANAGER', employeeId: emp.MGR });
  await createUser({ email: 'staff@ot.local', password: PW, role: 'EMPLOYEE', employeeId: emp.STAFF });
  await createUser({ email: 'coll@ot.local', password: PW, role: 'EMPLOYEE', employeeId: emp.COLL });
  await createUser({ email: 'out@ot.local', password: PW, role: 'EMPLOYEE', employeeId: emp.OUT });
  [admin, manager, staff, colleague, outsider] = await Promise.all(
    ['admin', 'mgr', 'staff', 'coll', 'out'].map((u) => loginAs(app, `${u}@ot.local`, PW)),
  );

  collectPastWeekdays(businessToday(TZ), 16);
  holiday = past[14];

  for (const o of [org, other]) {
    const calendar = await as(admin, 'post', '/api/v1/calendars').send({ organizationId: o.id, code: `STD-${o.code}`, name: 'Standard', workingDays: ['MON', 'TUE', 'WED', 'THU', 'FRI'] });
    await as(admin, 'post', `/api/v1/calendars/${calendar.body.data.id}/holidays`).send({ date: holiday, name: 'Company holiday' });
    await as(admin, 'patch', `/api/v1/calendars/organizations/${o.id}/default`).send({ calendarId: calendar.body.data.id });
  }

  const shift = await as(admin, 'post', '/api/v1/attendance/shifts').send({ organizationId: org.id, code: 'D1', name: 'Day', startTime: '08:00', endTime: '17:00', breakMinutes: 60, lateGraceMinutes: 10, earlyLeaveGraceMinutes: 10 });
  shiftDay = shift.body.data.id;

  const definition = await as(admin, 'post', '/api/v1/workflow/definitions').send({
    code: 'OVERTIME_STD', name: 'Overtime approval', module: 'attendance', entityType: 'OVERTIME_REQUEST',
    steps: [{ name: 'Direct manager', approverType: 'DIRECT_MANAGER' }],
  });
  expect(definition.status).toBe(201);
  await as(admin, 'post', `/api/v1/workflow/definitions/${definition.body.data.id}/activate`);

  const policy = await as(admin, 'post', '/api/v1/attendance/overtime/policies').send({
    organizationId: org.id, name: 'Standard overtime', effectiveFrom: '2020-01-01',
    workdayMultiplier: 1.5, offDayMultiplier: 2, holidayMultiplier: 3,
    minimumEligibleMinutes: 30, maximumApprovedMinutesPerDay: 240, workflowDefinitionCode: 'OVERTIME_STD',
  });
  expect(policy.status).toBe(201);
  policyId = policy.body.data.id;
}, 120000);

afterAll(async () => {
  await resetDatabase();
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------
describe('eligibility (pure, no database)', () => {
  const date = '2026-03-10';
  const workday = (clockIn: string, clockOut: string, workMinutes: number) =>
    calculateOvertimeEligibility({
      dayType: 'WORKDAY',
      scheduledStart: at(date, '08:00'),
      scheduledEnd: at(date, '17:00'),
      requiredMinutes: 480,
      clockIn: at(date, clockIn),
      clockOut: at(date, clockOut),
      workMinutes,
    });

  it('a normal day has no overtime', () => {
    const r = workday('08:00', '17:00', 480);
    expect(r.eligibleMinutes).toBe(0);
    expect(r.reason).toBe('WITHIN_SCHEDULE');
  });

  it('staying late after arriving on time is overtime', () => {
    const r = workday('08:00', '19:00', 600);
    expect(r).toMatchObject({ eligibleMinutes: 120, postShiftMinutes: 120, excessMinutes: 120, reason: 'OK' });
  });

  it('making up a late arrival is NOT overtime', () => {
    // 09:00–18:00 against an 08:00–17:00 shift: an hour "after the shift", but only the hour that was missed.
    const r = workday('09:00', '18:00', 480);
    expect(r.postShiftMinutes).toBe(60);
    expect(r.excessMinutes).toBe(0);
    expect(r.eligibleMinutes).toBe(0);
    // and staying two hours late after arriving an hour late leaves one genuine hour
    expect(workday('09:00', '19:00', 540).eligibleMinutes).toBe(60);
  });

  it('time before the shift counts, and the break is never deducted twice', () => {
    const early = workday('07:00', '17:00', 540); // an hour early, break already out of workMinutes
    expect(early).toMatchObject({ preShiftMinutes: 60, postShiftMinutes: 0, eligibleMinutes: 60 });
    const both = workday('07:00', '18:00', 600);
    expect(both).toMatchObject({ preShiftMinutes: 60, postShiftMinutes: 60, eligibleMinutes: 120 });
  });

  it('an off day or holiday makes every worked minute eligible, with no invented break', () => {
    for (const dayType of ['OFF_DAY', 'HOLIDAY'] as const) {
      const r = calculateOvertimeEligibility({ dayType, scheduledStart: null, scheduledEnd: null, requiredMinutes: 0, clockIn: at(date, '09:00'), clockOut: at(date, '13:00'), workMinutes: 240 });
      expect(r.eligibleMinutes).toBe(240);
    }
  });

  it('a missing or half clock yields nothing', () => {
    const base = { dayType: 'WORKDAY' as const, scheduledStart: at(date, '08:00'), scheduledEnd: at(date, '17:00'), requiredMinutes: 480, workMinutes: 0 };
    expect(calculateOvertimeEligibility({ ...base, clockIn: null, clockOut: null }).reason).toBe('NO_CLOCK');
    expect(calculateOvertimeEligibility({ ...base, clockIn: at(date, '08:00'), clockOut: null }).reason).toBe('INCOMPLETE_CLOCK');
  });

  it('an overnight shift measures overtime past the shift end, not past midnight', () => {
    const r = calculateOvertimeEligibility({
      dayType: 'WORKDAY',
      scheduledStart: at(date, '20:00'),
      scheduledEnd: at(addDays(date, 1), '05:00'),
      requiredMinutes: 480,
      clockIn: at(date, '20:00'),
      clockOut: at(addDays(date, 1), '07:00'),
      workMinutes: 600,
    });
    expect(r).toMatchObject({ postShiftMinutes: 120, eligibleMinutes: 120 });
  });

  it('a minimum is a threshold, never a rounding rule', () => {
    expect(checkOvertimeClaim({ eligibleMinutes: 20, minimumEligibleMinutes: 30 }, 20)).toMatchObject({ ok: false, code: 'OT_BELOW_MINIMUM' });
    expect(checkOvertimeClaim({ eligibleMinutes: 120, maximumApprovedMinutesPerDay: 60 }, 90)).toMatchObject({ ok: false, code: 'OT_EXCEEDS_DAILY_MAX', maximumClaimableMinutes: 60 });
    expect(checkOvertimeClaim({ eligibleMinutes: 60 }, 90)).toMatchObject({ ok: false, code: 'OT_EXCEEDS_ELIGIBLE_TIME' });
    expect(checkOvertimeClaim({ eligibleMinutes: 0 }, 30)).toMatchObject({ ok: false, code: 'OT_NOT_ELIGIBLE' });
    expect(checkOvertimeClaim({ eligibleMinutes: 120, minimumEligibleMinutes: 30, maximumApprovedMinutesPerDay: 240 }, 120)).toMatchObject({ ok: true, maximumClaimableMinutes: 120 });
  });
});

// ---------------------------------------------------------------------------
describe('policy', () => {
  it('resolves one policy per organization and date, and refuses an overlap', async () => {
    const overlap = await as(admin, 'post', '/api/v1/attendance/overtime/policies').send({
      organizationId: orgId, name: 'Another', effectiveFrom: '2021-01-01',
      workdayMultiplier: 2, offDayMultiplier: 2, holidayMultiplier: 2, workflowDefinitionCode: 'OVERTIME_STD',
    });
    expect(err(overlap)).toBe('409 OT_POLICY_OVERLAP');

    // A different organization may have its own policy for the same dates.
    const otherPolicy = await as(admin, 'post', '/api/v1/attendance/overtime/policies').send({
      organizationId: otherOrgId, name: 'Other org', effectiveFrom: '2020-01-01',
      workdayMultiplier: 1.25, offDayMultiplier: 1.5, holidayMultiplier: 2, workflowDefinitionCode: 'OVERTIME_STD',
    });
    expect(otherPolicy.status).toBe(201);
  });

  it('validates the multipliers and the workflow', async () => {
    const base = { organizationId: otherOrgId, name: 'Bad', effectiveFrom: '2030-01-01', workdayMultiplier: 1.5, offDayMultiplier: 2, holidayMultiplier: 3, workflowDefinitionCode: 'OVERTIME_STD' };
    expect((await as(admin, 'post', '/api/v1/attendance/overtime/policies').send({ ...base, workdayMultiplier: 0 })).status).toBe(400);
    expect((await as(admin, 'post', '/api/v1/attendance/overtime/policies').send({ ...base, workdayMultiplier: 15 })).status).toBe(400); // 1.5 mistyped
    expect(err(await as(admin, 'post', '/api/v1/attendance/overtime/policies').send({ ...base, workflowDefinitionCode: 'NOPE' }))).toMatch(/WORKFLOW/);
    expect((await as(staff, 'post', '/api/v1/attendance/overtime/policies').send(base)).status).toBe(403);
  });

  it('a day with no policy cannot be claimed', async () => {
    const day = past[1];
    await assign([emp.OUT], day, null);
    await workedDay(emp.OUT, day, { in: '09:00', out: '13:00' });
    // the other organization's policy starts in 2020 too, so remove it for this check
    const otherPolicies = await prisma.overtimePolicy.findMany({ where: { organizationId: otherOrgId } });
    await prisma.overtimePolicy.updateMany({ where: { organizationId: otherOrgId }, data: { isActive: false, effectiveFrom: '2099-01-01' } });
    const res = await preview(outsider, day);
    expect(res.body.data.policy).toBeNull();
    expect(res.body.data.claimable).toBe(false);
    expect(err(await claim(outsider, day, 60))).toBe('409 OT_POLICY_NOT_FOUND');
    await prisma.overtimePolicy.updateMany({ where: { id: { in: otherPolicies.map((p) => p.id) } }, data: { isActive: true, effectiveFrom: '2020-01-01' } });
  }, 60000);
});

// ---------------------------------------------------------------------------
describe('claiming overtime', () => {
  it('previews a day without writing anything, and derives the day type on the server', async () => {
    const day = past[2];
    await assign([emp.STAFF], day, shiftDay);
    await workedDay(emp.STAFF, day, { in: '08:00', out: '19:00' });

    const before = await prisma.overtimeRequest.count();
    const res = await preview(staff, day);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      dayType: 'WORKDAY', workedMinutes: 600, eligibleMinutes: 120, postShiftMinutes: 120,
      maximumClaimableMinutes: 120, claimable: true,
      policy: { name: 'Standard overtime', multiplier: 1.5, minimumEligibleMinutes: 30, maximumApprovedMinutesPerDay: 240 },
    });
    expect(await prisma.overtimeRequest.count()).toBe(before); // preview mutates nothing
  }, 60000);

  it('a claim is for the caller\'s own day, in whole minutes, inside what the day allows', async () => {
    const day = past[2];
    expect(err(await claim(staff, day, 200))).toBe('409 OT_EXCEEDS_ELIGIBLE_TIME');
    expect(err(await claim(staff, day, 10))).toBe('409 OT_BELOW_MINIMUM');
    expect((await claim(staff, day, 90.5)).status).toBe(400); // minutes are integers
    // the employee is the session: there is no field to forge
    const created = await claim(staff, day, 120);
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ status: 'DRAFT', claimedMinutes: 120, employee: { employeeCode: 'STAFF' } });
    expect(created.body.data.employee.id).toBe(emp.STAFF);

    const edited = await as(staff, 'patch', `/api/v1/attendance/overtime/requests/${created.body.data.id}`).send({ claimedMinutes: 60 });
    expect(edited.body.data.claimedMinutes).toBe(60);
    expect(err(await as(colleague, 'patch', `/api/v1/attendance/overtime/requests/${created.body.data.id}`).send({ claimedMinutes: 30 }))).toBe('404 OT_REQUEST_NOT_FOUND');
    await as(staff, 'post', `/api/v1/attendance/overtime/requests/${created.body.data.id}/cancel`);
  }, 60000);

  it('a day that is not finished, or has half a clock, cannot be claimed', async () => {
    const today = businessToday(TZ);
    await assign([emp.STAFF], today, shiftDay, { includeHolidays: true });
    expect(err(await claim(staff, today, 60))).toBe('409 OT_ATTENDANCE_NOT_FINAL');
    expect((await claim(staff, addDays(today, 2), 60)).status).toBe(400); // a day that has not happened

    const half = past[3];
    await assign([emp.COLL], half, shiftDay);
    await workedDay(emp.COLL, half, { in: '08:00' });
    expect(err(await claim(colleague, half, 60))).toBe('409 OT_ATTENDANCE_NOT_FINAL');
  }, 60000);

  it('making up a late arrival is refused as a claim, not just in the arithmetic', async () => {
    const day = past[4];
    await assign([emp.COLL], day, shiftDay);
    await workedDay(emp.COLL, day, { in: '09:00', out: '18:00' });
    const view = await preview(colleague, day);
    expect(view.body.data).toMatchObject({ eligibleMinutes: 0, postShiftMinutes: 60, claimable: false });
    expect(view.body.data.reason).toMatch(/beyond what the day required/);
    expect(err(await claim(colleague, day, 60))).toBe('409 OT_NOT_ELIGIBLE');
  }, 60000);

  it('an off day and a holiday are claimable from the clock alone, at their own multiplier', async () => {
    const offDay = addDays(past[5], weekdayOf(past[5]) === 'MON' ? -2 : -1); // a weekend day
    await workedDay(emp.STAFF, offDay, { in: '09:00', out: '13:00' });
    const off = await preview(staff, offDay);
    expect(off.body.data).toMatchObject({ dayType: 'OFF_DAY', eligibleMinutes: 240, policy: { multiplier: 2 } });

    await assign([emp.STAFF], holiday, shiftDay, { includeHolidays: false });
    await workedDay(emp.STAFF, holiday, { in: '09:00', out: '13:00' });
    const onHoliday = await preview(staff, holiday);
    expect(onHoliday.body.data).toMatchObject({ dayType: 'HOLIDAY', eligibleMinutes: 240, policy: { multiplier: 3 } });
  }, 60000);
});

// ---------------------------------------------------------------------------
describe('workflow', () => {
  const day = () => past[6];
  let requestId = '';
  let instanceId = '';

  beforeAll(async () => {
    await assign([emp.STAFF], day(), shiftDay);
    await workedDay(emp.STAFF, day(), { in: '08:00', out: '19:00' });
  });

  it('submitting snapshots the day type, eligibility, policy and multiplier', async () => {
    const created = await claim(staff, day(), 120);
    requestId = created.body.data.id;
    const submitted = await submit(staff, requestId);
    expect(submitted.status).toBe(200);
    expect(submitted.body.data).toMatchObject({
      status: 'PENDING', dayType: 'WORKDAY', claimedMinutes: 120,
      eligibleMinutesSnapshot: 120, rateMultiplierSnapshot: 1.5, policy: { id: policyId },
    });
    instanceId = submitted.body.data.workflowInstanceId;
    expect(instanceId).toBeTruthy();

    const inbox = await as(manager, 'get', '/api/v1/attendance/overtime/requests?view=inbox');
    expect(inbox.body.data.map((r: { id: string }) => r.id)).toContain(requestId);
    const notified = await as(manager, 'get', '/api/v1/notifications?page=1&pageSize=20');
    expect(notified.body.data.some((n: { type: string; body: string }) => n.type === 'APPROVAL_REQUIRED' && n.body.includes('overtime claim'))).toBe(true);
  }, 60000);

  it('one open claim per day, and the wrong approver is refused', async () => {
    expect(err(await claim(staff, day(), 60))).toBe('409 OT_ALREADY_CLAIMED');
    expect((await decide(colleague, instanceId, 'APPROVE')).status).toBe(403);
  });

  it('approving freezes the minutes and tells the employee', async () => {
    expect((await decide(manager, instanceId, 'APPROVE', 'Month-end, agreed beforehand')).status).toBe(200);
    const approved = await as(staff, 'get', `/api/v1/attendance/overtime/requests/${requestId}`);
    expect(approved.body.data).toMatchObject({ status: 'APPROVED', approvedMinutes: 120, rateMultiplierSnapshot: 1.5 });
    expect(approved.body.data.approvedAt).toBeTruthy();

    const notified = await as(staff, 'get', '/api/v1/notifications?page=1&pageSize=20');
    expect(notified.body.data.some((n: { type: string }) => n.type === 'OVERTIME_APPROVED')).toBe(true);
    const audits = await prisma.auditLog.findMany({ where: { recordType: 'OvertimeRequest', recordId: requestId }, select: { action: true } });
    expect(audits.map((a) => a.action).sort()).toEqual(['APPROVE_OVERTIME_REQUEST', 'CREATE_OVERTIME_REQUEST', 'SUBMIT_OVERTIME_REQUEST']);

    // an approved claim is payroll input: the requester cannot withdraw it
    expect(err(await as(staff, 'post', `/api/v1/attendance/overtime/requests/${requestId}/cancel`))).toBe('409 OT_REQUEST_APPROVED');
  }, 60000);

  it('a rejected claim frees the day for another attempt', async () => {
    const day2 = past[7];
    await assign([emp.COLL], day2, shiftDay);
    await workedDay(emp.COLL, day2, { in: '08:00', out: '18:30' });
    const first = await claim(colleague, day2, 90);
    const submitted = await submit(colleague, first.body.data.id);
    expect((await decide(manager, submitted.body.data.workflowInstanceId, 'REJECT', 'Not agreed in advance')).status).toBe(200);
    const rejected = await as(colleague, 'get', `/api/v1/attendance/overtime/requests/${first.body.data.id}`);
    expect(rejected.body.data.status).toBe('REJECTED');
    expect((await as(colleague, 'get', '/api/v1/notifications?page=1&pageSize=20')).body.data.some((n: { type: string }) => n.type === 'OVERTIME_REJECTED')).toBe(true);

    const second = await claim(colleague, day2, 60);
    expect(second.status).toBe(201); // the rejected one does not block a new claim
    await as(colleague, 'post', `/api/v1/attendance/overtime/requests/${second.body.data.id}/cancel`);
  }, 60000);

  it('a pending claim can be withdrawn by its owner', async () => {
    const day3 = past[8];
    await assign([emp.COLL], day3, shiftDay);
    await workedDay(emp.COLL, day3, { in: '08:00', out: '19:00' });
    const created = await claim(colleague, day3, 120);
    const submitted = await submit(colleague, created.body.data.id);
    expect(err(await as(staff, 'post', `/api/v1/attendance/overtime/requests/${created.body.data.id}/cancel`))).toBe('404 OT_REQUEST_NOT_FOUND');
    const cancelled = await as(colleague, 'post', `/api/v1/attendance/overtime/requests/${created.body.data.id}/cancel`);
    expect(cancelled.body.data.status).toBe('CANCELLED');
    const instance = await prisma.workflowInstance.findUniqueOrThrow({ where: { id: submitted.body.data.workflowInstanceId } });
    expect(instance.status).toBe('CANCELLED');
  }, 60000);
});

// ---------------------------------------------------------------------------
describe('attendance changing underneath a claim', () => {
  it('approval fails when the day no longer supports the claim, and the claim stays pending', async () => {
    const day = past[9];
    await assign([emp.STAFF], day, shiftDay);
    await workedDay(emp.STAFF, day, { in: '08:00', out: '19:00' }); // 120 minutes eligible
    const created = await claim(staff, day, 120);
    const submitted = await submit(staff, created.body.data.id);
    const instanceId = submitted.body.data.workflowInstanceId;

    // the day is corrected down to a normal day while the claim waits
    await prisma.attendanceCorrection.create({
      data: { employeeId: emp.STAFF, attendanceDate: day, requestedClockOut: zonedTimeToUtc(day, '17:00', TZ), reason: 'Left at five, the gate log was wrong', status: 'APPROVED', decidedAt: new Date(), createdByUserId: admin.user.id },
    });
    await as(admin, 'post', '/api/v1/attendance/recalculate').send({ from: day, to: day, employeeId: emp.STAFF });

    const decision = await decide(manager, instanceId, 'APPROVE');
    expect(err(decision)).toBe('409 OT_ATTENDANCE_CHANGED_REVIEW_REQUIRED');
    const after = await as(staff, 'get', `/api/v1/attendance/overtime/requests/${created.body.data.id}`);
    expect(after.body.data).toMatchObject({ status: 'PENDING', approvedMinutes: null }); // rolled back, nothing decided
    expect((await prisma.workflowInstance.findUniqueOrThrow({ where: { id: instanceId } })).status).toBe('PENDING');

    await as(staff, 'post', `/api/v1/attendance/overtime/requests/${created.body.data.id}/cancel`);
  }, 60000);

  it('a correction that would strand approved overtime is refused, and the day is left alone', async () => {
    const day = past[10];
    await assign([emp.COLL], day, shiftDay);
    await workedDay(emp.COLL, day, { in: '08:00', out: '19:00' });
    const created = await claim(colleague, day, 120);
    const submitted = await submit(colleague, created.body.data.id);
    expect((await decide(manager, submitted.body.data.workflowInstanceId, 'APPROVE')).status).toBe(200);
    const recordBefore = await prisma.attendanceRecord.findUniqueOrThrow({ where: { employeeId_attendanceDate: { employeeId: emp.COLL, attendanceDate: day } } });

    // the employee now says they actually left at 17:00 — which would leave no overtime at all
    const workflowDefinition = await as(admin, 'post', '/api/v1/workflow/definitions').send({
      code: 'ATTENDANCE_CORRECTION', name: 'Attendance correction', module: 'attendance', entityType: 'ATTENDANCE_CORRECTION',
      steps: [{ name: 'Direct manager', approverType: 'DIRECT_MANAGER' }],
    });
    await as(admin, 'post', `/api/v1/workflow/definitions/${workflowDefinition.body.data.id}/activate`);
    const correction = await as(colleague, 'post', '/api/v1/attendance/corrections').send({ attendanceDate: day, requestedClockOut: '17:00', reason: 'I left at five, the claim was a mistake' });
    expect(correction.status).toBe(201);

    const decision = await decide(manager, correction.body.data.workflowInstanceId, 'APPROVE');
    expect(err(decision)).toBe('409 ATTENDANCE_CORRECTION_CONFLICTS_WITH_APPROVED_OT');

    // nothing moved: the correction is still pending, the day and the approved claim are untouched
    const correctionAfter = await as(colleague, 'get', `/api/v1/attendance/corrections/${correction.body.data.id}`);
    expect(correctionAfter.body.data.status).toBe('PENDING');
    const recordAfter = await prisma.attendanceRecord.findUniqueOrThrow({ where: { employeeId_attendanceDate: { employeeId: emp.COLL, attendanceDate: day } } });
    expect(recordAfter.lastClockOut?.toISOString()).toBe(recordBefore.lastClockOut?.toISOString());
    expect((await as(colleague, 'get', `/api/v1/attendance/overtime/requests/${created.body.data.id}`)).body.data).toMatchObject({ status: 'APPROVED', approvedMinutes: 120 });
  }, 60000);

  it('a correction is free to proceed when only a pending claim is affected', async () => {
    const day = past[11];
    await assign([emp.STAFF], day, shiftDay);
    await workedDay(emp.STAFF, day, { in: '08:00', out: '19:00' });
    const created = await claim(staff, day, 120);
    await submit(staff, created.body.data.id);

    const correction = await as(staff, 'post', '/api/v1/attendance/corrections').send({ attendanceDate: day, requestedClockOut: '17:30', reason: 'Left at half five' });
    expect((await decide(manager, correction.body.data.workflowInstanceId, 'APPROVE')).status).toBe(200);
    const record = await prisma.attendanceRecord.findUniqueOrThrow({ where: { employeeId_attendanceDate: { employeeId: emp.STAFF, attendanceDate: day } } });
    expect(record.lastClockOut?.toISOString()).toBe(zonedTimeToUtc(day, '17:30', TZ).toISOString());
    // …and the pending claim now fails its revalidation, rather than being approved on stale ground
    const request = await prisma.overtimeRequest.findUniqueOrThrow({ where: { id: created.body.data.id } });
    const instance = await prisma.workflowInstance.findUniqueOrThrow({ where: { id: request.workflowInstanceId! } });
    expect(err(await decide(manager, instance.id, 'APPROVE'))).toBe('409 OT_ATTENDANCE_CHANGED_REVIEW_REQUIRED');
  }, 60000);
});

// ---------------------------------------------------------------------------
describe('concurrency', () => {
  it('two submissions of the same claim produce one workflow', async () => {
    const day = past[12];
    await assign([emp.STAFF], day, shiftDay);
    await workedDay(emp.STAFF, day, { in: '08:00', out: '19:00' });
    const created = await claim(staff, day, 120);
    const results = await Promise.all([submit(staff, created.body.data.id), submit(staff, created.body.data.id)]);
    const codes = results.map((r) => (r.status === 200 ? 'OK' : r.body.error.code)).sort();
    expect(codes).toEqual(['OK', 'OT_REQUEST_NOT_DRAFT']);
    expect(await prisma.workflowInstance.count({ where: { entityId: created.body.data.id } })).toBe(1);
    await as(staff, 'post', `/api/v1/attendance/overtime/requests/${created.body.data.id}/cancel`);
  }, 60000);

  it('two claims for the same day leave exactly one open', async () => {
    const day = past[13];
    await assign([emp.COLL], day, shiftDay);
    await workedDay(emp.COLL, day, { in: '08:00', out: '19:00' });
    const first = await claim(colleague, day, 120);
    const second = await claim(colleague, day, 60);
    // drafts are allowed side by side; submitting is what claims the day
    const submissions = await Promise.all([submit(colleague, first.body.data.id), submit(colleague, second.body.data.id)]);
    const codes = submissions.map((r) => (r.status === 200 ? 'OK' : r.body.error.code)).sort();
    expect(codes).toEqual(['OK', 'OT_ALREADY_CLAIMED']);
    expect(await prisma.overtimeRequest.count({ where: { employeeId: emp.COLL, attendanceDate: day, status: { in: ['PENDING', 'APPROVED'] } } })).toBe(1);
  }, 60000);

  it('a claim cannot be approved twice, and approve beats cancel or the other way round — never both', async () => {
    const day = past[13];
    const pending = await prisma.overtimeRequest.findFirstOrThrow({ where: { employeeId: emp.COLL, attendanceDate: day, status: 'PENDING' } });
    const instanceId = pending.workflowInstanceId!;
    const twice = await Promise.all([decide(manager, instanceId, 'APPROVE'), decide(manager, instanceId, 'APPROVE')]);
    expect(twice.filter((r) => r.status === 200)).toHaveLength(1);
    const final = await prisma.overtimeRequest.findUniqueOrThrow({ where: { id: pending.id } });
    expect(final.status).toBe('APPROVED');
    expect(final.approvedMinutes).toBe(pending.claimedMinutes);
  }, 60000);
});

// ---------------------------------------------------------------------------
describe('scope, reporting and the payroll handoff', () => {
  it('SELF sees only its own claims, TEAM the team, ALL everyone', async () => {
    const mine = await as(staff, 'get', '/api/v1/attendance/overtime/requests?view=mine&pageSize=50');
    expect(mine.body.data.every((r: { employee: { employeeCode: string } }) => r.employee.employeeCode === 'STAFF')).toBe(true);

    const team = await as(manager, 'get', '/api/v1/attendance/overtime/requests?view=all&pageSize=50');
    const codes = new Set(team.body.data.map((r: { employee: { employeeCode: string } }) => r.employee.employeeCode));
    expect(codes.has('OUT')).toBe(false);

    const all = await as(admin, 'get', '/api/v1/attendance/overtime/requests?view=all&pageSize=50');
    expect(all.body.meta.total).toBeGreaterThanOrEqual(team.body.meta.total);

    // somebody else's claim is a 404, not a 403: the endpoint never confirms it exists
    const someone = await prisma.overtimeRequest.findFirstOrThrow({ where: { employeeId: emp.STAFF } });
    expect(err(await as(outsider, 'get', `/api/v1/attendance/overtime/requests/${someone.id}`))).toBe('404 OT_REQUEST_NOT_FOUND');
  });

  it('the report counts approved minutes by day type and says it is not money', async () => {
    const report = await as(admin, 'get', `/api/v1/attendance/overtime/reports/overview?from=${past[15]}&to=${past[0]}`);
    expect(report.status).toBe(200);
    expect(report.body.data.note).toMatch(/no monetary overtime/);
    const staffRow = report.body.data.rows.find((r: { employee: { employeeCode: string } }) => r.employee.employeeCode === 'STAFF');
    expect(staffRow.approvedMinutes).toBeGreaterThanOrEqual(120);
    expect(staffRow.byDayType.WORKDAY).toBeGreaterThanOrEqual(120);
    expect(report.body.data.totals.approvedMinutes).toBeGreaterThanOrEqual(staffRow.approvedMinutes);
    expect(JSON.stringify(report.body)).not.toMatch(/amount|salary|baht|currency/i);
  });

  it('the payroll handoff returns minutes and a multiplier — and nothing else', async () => {
    const rows = await overtimeService.getApprovedOvertimeForPayroll({ employeeId: emp.STAFF, from: past[15], to: past[0] });
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(['approvedMinutes', 'attendanceDate', 'dayType', 'employeeId', 'policyId', 'rateMultiplierSnapshot', 'requestId']);
      expect(row.approvedMinutes).toBeGreaterThan(0);
      expect(row.rateMultiplierSnapshot).toBeGreaterThan(0);
    }
    // only approved claims are handed over
    const pendingIds = (await prisma.overtimeRequest.findMany({ where: { status: { not: 'APPROVED' } }, select: { id: true } })).map((r) => r.id);
    expect(rows.some((r) => pendingIds.includes(r.requestId))).toBe(false);
  });

  it('a policy that has been claimed under cannot have its rates edited', async () => {
    const rename = await as(admin, 'patch', `/api/v1/attendance/overtime/policies/${policyId}`).send({ name: 'Standard overtime (2026)' });
    expect(rename.status).toBe(200); // a name is not a rate

    const reprice = await as(admin, 'patch', `/api/v1/attendance/overtime/policies/${policyId}`).send({ workdayMultiplier: 2 });
    expect(err(reprice)).toBe('409 OT_POLICY_IN_USE');

    // and the approved claim keeps the multiplier it was approved with
    const approved = await prisma.overtimeRequest.findFirstOrThrow({ where: { status: 'APPROVED', employeeId: emp.STAFF } });
    expect(approved.rateMultiplierSnapshot).toBe(1.5);
  });
});
