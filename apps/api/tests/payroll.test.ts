/**
 * Task 22 — Payroll MVP.
 *
 * Payroll is money, so these tests are about arithmetic that must be exact, inputs that must not move under a run,
 * and confidentiality that must not leak. Every amount is asserted as a decimal string: a test that compared floats
 * would pass while the product was wrong by satang.
 */
import type { Server } from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, weekdayOf, zonedTimeToUtc } from '@hr/shared';
import { prisma } from '../src/lib/prisma';
import { deriveRates, money, sumMoney, toMoneyString } from '../src/modules/payroll/money';
import { payrollResultsCsv } from '../src/modules/payroll/payslip.service';
import { createTestServer, createUser, loginAs, resetDatabase } from './helpers';

const app: Server = createTestServer();
const PW = 'Correct-Horse-1';
const TZ = 'Asia/Bangkok';
/** A period safely in the past, so attendance days are always finished. */
const YEAR = 2026;
const MONTH = 5;
const PERIOD_START = '2026-05-01';
const PERIOD_END = '2026-05-31';
const CUTOFF_FROM = '2026-04-21';
const CUTOFF_TO = '2026-05-20';

type Session = { cookie: string; csrf: string; user: { id: string } };
const as = (s: Session, m: 'get' | 'post' | 'patch' | 'delete', url: string) => request(app)[m](url).set('Cookie', s.cookie).set('x-csrf-token', s.csrf);
const err = (r: request.Response) => `${r.status} ${r.body?.error?.code ?? ''}`.trim();

let admin: Session, approver: Session, hr: Session, manager: Session, emp1: Session, emp2: Session;
let orgId: string, deptId: string, policyId: string, periodId: string, shiftId: string;
const emp: Record<string, string> = {};
const components: Record<string, string> = {};

const money2 = (value: string) => toMoneyString(value);

beforeAll(async () => {
  await resetDatabase();
  const org = await prisma.organization.create({ data: { code: 'PAY', name: 'Payroll Co', timezone: TZ } });
  orgId = org.id;
  const dept = await prisma.department.create({ data: { organizationId: org.id, code: 'OPS', name: 'Operations' } });
  deptId = dept.id;
  const position = await prisma.position.create({ data: { departmentId: dept.id, code: 'P1', title: 'Officer' } });
  const mk = async (code: string, managerId: string | null, hireDate = '2020-01-01') =>
    (await prisma.employee.create({
      data: {
        employeeCode: code, firstName: code, lastName: 'Person', email: `${code.toLowerCase()}@pay.local`,
        hireDate: new Date(`${hireDate}T00:00:00Z`), organizationId: org.id, departmentId: dept.id, positionId: position.id, managerId,
        employmentType: 'FULL_TIME', employmentStatus: 'ACTIVE',
        positionHistory: { create: { positionId: position.id, departmentId: dept.id, startDate: new Date(`${hireDate}T00:00:00Z`) } },
      },
    })).id;
  emp.MGR = await mk('MGR', null);
  emp.EMP001 = await mk('EMP001', emp.MGR);
  emp.EMP002 = await mk('EMP002', emp.MGR);

  // The payroll officer and the approver belong to a SEPARATE organization, so they are not part of the population
  // this period pays — and so submitter and approver are never the same person (the engine forbids self-approval).
  const backOffice = await prisma.organization.create({ data: { code: 'BACK', name: 'Back office', timezone: TZ } });
  const backDept = await prisma.department.create({ data: { organizationId: backOffice.id, code: 'ADM', name: 'Administration' } });
  const backPosition = await prisma.position.create({ data: { departmentId: backDept.id, code: 'P2', title: 'Officer' } });
  const mkBack = async (code: string) =>
    (await prisma.employee.create({
      data: {
        employeeCode: code, firstName: code, lastName: 'Officer', email: `${code.toLowerCase()}@pay.local`,
        hireDate: new Date('2020-01-01T00:00:00Z'), organizationId: backOffice.id, departmentId: backDept.id, positionId: backPosition.id,
        employmentType: 'FULL_TIME', employmentStatus: 'ACTIVE',
        positionHistory: { create: { positionId: backPosition.id, departmentId: backDept.id, startDate: new Date('2020-01-01T00:00:00Z') } },
      },
    })).id;
  emp.PAYADM = await mkBack('PAYADM');
  emp.APPROVER = await mkBack('APPROVER');

  await createUser({ email: 'admin@pay.local', password: PW, role: 'SYSTEM_ADMIN', employeeId: emp.PAYADM });
  await createUser({ email: 'approver@pay.local', password: PW, role: 'HR_ADMIN', employeeId: emp.APPROVER });
  await createUser({ email: 'hr@pay.local', password: PW, role: 'HR' });
  await createUser({ email: 'mgr@pay.local', password: PW, role: 'MANAGER', employeeId: emp.MGR });
  await createUser({ email: 'emp1@pay.local', password: PW, role: 'EMPLOYEE', employeeId: emp.EMP001 });
  await createUser({ email: 'emp2@pay.local', password: PW, role: 'EMPLOYEE', employeeId: emp.EMP002 });
  [admin, approver, hr, manager, emp1, emp2] = await Promise.all(['admin', 'approver', 'hr', 'mgr', 'emp1', 'emp2'].map((u) => loginAs(app, `${u}@pay.local`, PW)));

  // calendar + shift, so attendance and leave have somewhere to live
  const calendar = await as(admin, 'post', '/api/v1/calendars').send({ organizationId: org.id, code: 'STD', name: 'Standard', workingDays: ['MON', 'TUE', 'WED', 'THU', 'FRI'] });
  await as(admin, 'patch', `/api/v1/calendars/organizations/${org.id}/default`).send({ calendarId: calendar.body.data.id });
  const shift = await as(admin, 'post', '/api/v1/attendance/shifts').send({ organizationId: org.id, code: 'D1', name: 'Day', startTime: '08:00', endTime: '17:00', breakMinutes: 60, lateGraceMinutes: 10, earlyLeaveGraceMinutes: 10 });
  shiftId = shift.body.data.id;

  // one workflow for payroll approval, one for overtime
  for (const [code, entityType, module] of [['PAYROLL_STD', 'PAYROLL_RUN', 'payroll'], ['OVERTIME_STD', 'OVERTIME_REQUEST', 'attendance']] as const) {
    const definition = await as(admin, 'post', '/api/v1/workflow/definitions').send({
      code, name: code, module, entityType, steps: [{ name: 'Approver', approverType: 'SPECIFIC_USER', approverUserId: approver.user.id }],
    });
    expect(definition.status).toBe(201);
    await as(admin, 'post', `/api/v1/workflow/definitions/${definition.body.data.id}/activate`);
  }

  const policy = await as(admin, 'post', '/api/v1/payroll/policies').send({
    organizationId: org.id, name: 'Standard payroll', monthlyDivisorDays: 30, dailyWorkHours: 8,
    newHireProration: 'CALENDAR_DAYS', terminationProration: 'CALENDAR_DAYS',
    absenceDeductionEnabled: true, lateDeductionEnabled: true,
    workflowDefinitionCode: 'PAYROLL_STD', effectiveFrom: '2020-01-01', currencyCode: 'THB',
  });
  expect(policy.status).toBe(201);
  policyId = policy.body.data.id;

  // salaries: 30,000 and 24,000
  for (const [code, salary] of [['EMP001', '30000.00'], ['EMP002', '24000.00'], ['MGR', '45000.00']] as const) {
    const created = await as(admin, 'post', '/api/v1/payroll/compensations').send({ employeeId: emp[code], effectiveFrom: '2020-01-01', baseSalary: salary, currencyCode: 'THB' });
    expect(created.status).toBe(201);
  }

  const componentList = await as(admin, 'get', '/api/v1/payroll/components?pageSize=50');
  for (const c of componentList.body.data) components[c.code] = c.id;
}, 180000);

afterAll(async () => {
  await resetDatabase();
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------
describe('money arithmetic (the reason this module exists)', () => {
  it('decimal addition does not drift the way floating point does', () => {
    expect(0.1 + 0.2).not.toBe(0.3); // the bug being avoided
    expect(sumMoney(['0.10', '0.20']).toString()).toBe('0.3');
    expect(toMoneyString(sumMoney(['0.10', '0.20']))).toBe('0.30');
    // a thousand satang add up to exactly ten baht, not 9.999999999
    expect(toMoneyString(sumMoney(Array.from({ length: 1000 }, () => '0.01')))).toBe('10.00');
  });

  it('rates are derived at six places so multiplying back does not lose baht', () => {
    const { dailyRate, hourlyRate, minuteRate } = deriveRates('30000.00', 30, 8);
    expect(dailyRate.toString()).toBe('1000');
    expect(hourlyRate.toString()).toBe('125');
    expect(minuteRate.toString()).toBe('2.083333');
    // 120 minutes of overtime at ×1.5 = 374.99994, which rounds once, at the line, to 375.00
    expect(toMoneyString(minuteRate.times(120).times(1.5))).toBe('375.00');
    // rounding the minute rate to satang first would quietly pay 60 satang less
    expect(toMoneyString(money('2.08').times(120).times(1.5))).toBe('374.40');
  });

  it('half-up rounding is applied once, at the line', () => {
    expect(toMoneyString('1.005')).toBe('1.01');
    expect(toMoneyString('1.004')).toBe('1.00');
    expect(toMoneyString('-1.005')).toBe('-1.01');
  });

  it('the CSV export cannot be used to smuggle a formula into a spreadsheet', () => {
    const csv = payrollResultsCsv([
      { employeeCode: '=cmd|calc', employeeName: 'Evil, "quoted"', departmentName: '+1', baseSalary: '1', grossPay: '1', totalDeductions: '0', netPay: '1', currencyCode: 'THB' },
    ]);
    expect(csv).toContain('"\'=cmd|calc"');
    expect(csv).toContain('"\'+1"');
    expect(csv).toContain('"Evil, ""quoted"""');
  });
});

// ---------------------------------------------------------------------------
describe('compensation', () => {
  it('salary periods cannot overlap, and a change is history rather than an edit', async () => {
    const overlap = await as(admin, 'post', '/api/v1/payroll/compensations').send({ employeeId: emp.EMP001, effectiveFrom: '2021-01-01', baseSalary: '31000.00' });
    expect(err(overlap)).toBe('409 COMPENSATION_OVERLAP');

    // the supported way: close the current record, then open the next one
    const current = await prisma.employeeCompensation.findFirstOrThrow({ where: { employeeId: emp.MGR } });
    expect((await as(admin, 'patch', `/api/v1/payroll/compensations/${current.id}`).send({ effectiveTo: '2026-12-31' })).status).toBe(200);
    const next = await as(admin, 'post', '/api/v1/payroll/compensations').send({ employeeId: emp.MGR, effectiveFrom: '2027-01-01', baseSalary: '48000.00' });
    expect(next.status).toBe(201);
    const history = await as(admin, 'get', `/api/v1/payroll/compensations?employeeId=${emp.MGR}`);
    expect(history.body.data.map((c: { baseSalary: string }) => c.baseSalary).sort()).toEqual(['45000.00', '48000.00']);

    // resolving a date returns exactly one
    const asOf = await as(admin, 'get', `/api/v1/payroll/compensations?employeeId=${emp.MGR}&asOfDate=2026-06-15`);
    expect(asOf.body.data).toHaveLength(1);
    expect(asOf.body.data[0].baseSalary).toBe('45000.00');
  });

  it('salary is not visible without a payroll permission — a manager\'s team scope grants nothing', async () => {
    expect((await as(manager, 'get', `/api/v1/payroll/compensations?employeeId=${emp.EMP001}`)).status).toBe(403);
    expect((await as(emp1, 'get', '/api/v1/payroll/compensations')).status).toBe(403);
    expect((await as(hr, 'get', '/api/v1/payroll/compensations')).status).toBe(200); // HR has payroll.manage
  });
});

// ---------------------------------------------------------------------------
describe('pay components and recurring items', () => {
  it('system components exist, cannot be deactivated, and cannot be assigned as recurring', async () => {
    const list = await as(admin, 'get', '/api/v1/payroll/components?pageSize=50');
    const codes = list.body.data.map((c: { code: string }) => c.code);
    expect(codes).toEqual(expect.arrayContaining(['BASE_SALARY', 'OT_PAY', 'UNPAID_LEAVE_DEDUCTION', 'ABSENCE_DEDUCTION', 'LATE_DEDUCTION', 'MANUAL_EARNING', 'MANUAL_DEDUCTION']));
    expect(err(await as(admin, 'patch', `/api/v1/payroll/components/${components.BASE_SALARY}`).send({ isActive: false }))).toBe('409 PAY_COMPONENT_IS_SYSTEM');
    expect(err(await as(admin, 'post', '/api/v1/payroll/pay-items').send({ employeeId: emp.EMP001, componentId: components.BASE_SALARY, amount: '100.00', effectiveFrom: '2020-01-01' }))).toBe('409 PAY_COMPONENT_NOT_RECURRING');
  });

  it('a recurring allowance and a fixed deduction can be assigned, once each per period', async () => {
    const allowance = await as(admin, 'post', '/api/v1/payroll/components').send({ code: 'POSITION_ALLOWANCE', name: 'Position allowance', type: 'EARNING' });
    expect(allowance.status).toBe(201);
    components.POSITION_ALLOWANCE = allowance.body.data.id;
    const dues = await as(admin, 'post', '/api/v1/payroll/components').send({ code: 'UNION_DUES', name: 'Union dues', type: 'DEDUCTION' });
    components.UNION_DUES = dues.body.data.id;

    expect((await as(admin, 'post', '/api/v1/payroll/pay-items').send({ employeeId: emp.EMP001, componentId: components.POSITION_ALLOWANCE, amount: '1000.00', effectiveFrom: '2020-01-01' })).status).toBe(201);
    expect(err(await as(admin, 'post', '/api/v1/payroll/pay-items').send({ employeeId: emp.EMP001, componentId: components.POSITION_ALLOWANCE, amount: '1500.00', effectiveFrom: '2021-01-01' }))).toBe('409 PAY_ITEM_OVERLAP');
    expect((await as(admin, 'post', '/api/v1/payroll/pay-items').send({ employeeId: emp.EMP001, componentId: components.UNION_DUES, amount: '200.00', effectiveFrom: '2020-01-01' })).status).toBe(201);
  });
});

// ---------------------------------------------------------------------------
describe('calculating a period', () => {
  beforeAll(async () => {
    // EMP001: two absences, 25 late minutes, an unpaid leave day and 120 approved overtime minutes in the cutoff
    const workday = (offset: number) => {
      let d = CUTOFF_FROM;
      let found = 0;
      while (found < offset) {
        d = addDays(d, 1);
        if (!['SAT', 'SUN'].includes(weekdayOf(d))) found += 1;
      }
      return d;
    };
    const days = Array.from({ length: 12 }, (_, i) => workday(i + 1));
    await as(admin, 'post', '/api/v1/attendance/schedules/assign').send({
      employeeIds: [emp.EMP001, emp.EMP002], from: CUTOFF_FROM, to: CUTOFF_TO, shiftId, weekdays: ['MON', 'TUE', 'WED', 'THU', 'FRI'], includeHolidays: true, overwriteExisting: true,
    });

    // a normal day, a late day, an overtime day, two absent days (nothing clocked)
    const clock = async (employeeId: string, date: string, inAt: string, outAt: string) => {
      await prisma.attendanceClockEvent.create({ data: { employeeId, eventType: 'CLOCK_IN', occurredAt: zonedTimeToUtc(date, inAt, TZ), attendanceDate: date, source: 'ADMIN' } });
      await prisma.attendanceClockEvent.create({ data: { employeeId, eventType: 'CLOCK_OUT', occurredAt: zonedTimeToUtc(date, outAt, TZ), attendanceDate: date, source: 'ADMIN' } });
    };
    await clock(emp.EMP001, days[0], '08:00', '17:00');
    await clock(emp.EMP001, days[1], '08:25', '17:00'); // 25 late minutes
    await clock(emp.EMP001, days[2], '08:00', '19:00'); // 120 minutes of overtime
    await clock(emp.EMP002, days[0], '08:00', '17:00');
    await as(admin, 'post', '/api/v1/attendance/recalculate').send({ from: CUTOFF_FROM, to: CUTOFF_TO });

    // overtime claim, approved
    const otPolicy = await as(admin, 'post', '/api/v1/attendance/overtime/policies').send({
      organizationId: orgId, name: 'OT', effectiveFrom: '2020-01-01', workdayMultiplier: 1.5, offDayMultiplier: 2, holidayMultiplier: 3,
      minimumEligibleMinutes: 30, maximumApprovedMinutesPerDay: 240, workflowDefinitionCode: 'OVERTIME_STD',
    });
    expect(otPolicy.status).toBe(201);
    const claim = await as(emp1, 'post', '/api/v1/attendance/overtime/requests').send({ attendanceDate: days[2], claimedMinutes: 120, reason: 'Month end' });
    const submitted = await as(emp1, 'post', `/api/v1/attendance/overtime/requests/${claim.body.data.id}/submit`);
    expect(submitted.body.data.status).toBe('PENDING');
    expect((await as(approver, 'post', `/api/v1/workflow/instances/${submitted.body.data.workflowInstanceId}/actions`).send({ action: 'APPROVE' })).status).toBe(200);

    // one unpaid leave day inside the cutoff (approved), and one paid leave day
    const leaveType = await prisma.leaveType.create({ data: { code: 'UNPAID', name: 'Unpaid leave' } });
    const paidType = await prisma.leaveType.create({ data: { code: 'ANNUAL', name: 'Annual leave' } });
    const unpaidPolicy = await prisma.leavePolicy.create({ data: { name: 'Unpaid', leaveTypeId: leaveType.id, organizationId: orgId, annualUnits: 0, isPaid: false, effectiveFrom: '2020-01-01', workflowDefinitionCode: 'OVERTIME_STD', isActive: true } });
    const paidPolicy = await prisma.leavePolicy.create({ data: { name: 'Annual', leaveTypeId: paidType.id, organizationId: orgId, annualUnits: 10, isPaid: true, effectiveFrom: '2020-01-01', workflowDefinitionCode: 'OVERTIME_STD', isActive: true } });
    await prisma.leaveRequest.create({
      data: { employeeId: emp.EMP001, leaveTypeId: leaveType.id, policyId: unpaidPolicy.id, startDate: days[4], endDate: days[4], startPart: 'FULL', endPart: 'FULL', units: 1, status: 'APPROVED', createdByUserId: emp1.user.id, approvedAt: new Date() },
    });
    await prisma.leaveRequest.create({
      data: { employeeId: emp.EMP001, leaveTypeId: paidType.id, policyId: paidPolicy.id, startDate: days[5], endDate: days[5], startPart: 'FULL', endPart: 'FULL', units: 1, status: 'APPROVED', createdByUserId: emp1.user.id, approvedAt: new Date() },
    });
    await as(admin, 'post', '/api/v1/attendance/recalculate').send({ from: CUTOFF_FROM, to: CUTOFF_TO });

    const period = await as(admin, 'post', '/api/v1/payroll/periods').send({
      organizationId: orgId, year: YEAR, month: MONTH, periodStart: PERIOD_START, periodEnd: PERIOD_END,
      attendanceFrom: CUTOFF_FROM, attendanceTo: CUTOFF_TO, paymentDate: '2026-05-28',
    });
    expect(period.status).toBe(201);
    periodId = period.body.data.id;
  }, 180000);

  it('calculates every employee with the lines that explain the money', async () => {
    const calculated = await as(admin, 'post', `/api/v1/payroll/periods/${periodId}/calculate`);
    expect(calculated.status).toBe(200);
    expect(calculated.body.data).toMatchObject({ status: 'REVIEW', employeeCount: 3, currencyCode: 'THB' });

    const results = await as(admin, 'get', `/api/v1/payroll/runs/${calculated.body.data.id}/results?pageSize=50`);
    const one = results.body.data.find((r: { employee: { employeeCode: string } }) => r.employee.employeeCode === 'EMP001');
    const byCode = Object.fromEntries(one.items.map((i: { componentCode: string; amount: string }) => [i.componentCode, i.amount]));

    expect(byCode.BASE_SALARY).toBe('30000.00');
    expect(byCode.POSITION_ALLOWANCE).toBe('1000.00');
    expect(byCode.UNION_DUES).toBe('200.00');
    expect(byCode.OT_PAY).toBe('375.00'); // 120 min × 2.083333 × 1.5, rounded once
    expect(byCode.UNPAID_LEAVE_DEDUCTION).toBe('1000.00'); // one day at 30000/30
    expect(byCode.LATE_DEDUCTION).toBe('52.08'); // 25 min × 2.083333
    expect(byCode.ABSENCE_DEDUCTION).toBeDefined();

    // gross − deductions = net, to the satang
    const gross = Number(one.grossPay);
    const deductions = Number(one.totalDeductions);
    expect(money(one.grossPay).minus(one.totalDeductions).toFixed(2)).toBe(one.netPay);
    expect(gross).toBeGreaterThan(deductions);
    expect(one.inputs).toMatchObject({ approvedOtMinutes: 120, lateMinutes: 25, unpaidLeaveUnits: '1.00' });

    const two = results.body.data.find((r: { employee: { employeeCode: string } }) => r.employee.employeeCode === 'EMP002');
    expect(two.baseSalary).toBe('24000.00');
    expect(two.items.some((i: { componentCode: string }) => i.componentCode === 'OT_PAY')).toBe(false); // no overtime of their own
  }, 120000);

  it('paid leave costs nothing, and a day of leave is never also an absence', async () => {
    const run = (await as(admin, 'get', `/api/v1/payroll/periods/${periodId}`)).body.data.run;
    const results = await as(admin, 'get', `/api/v1/payroll/runs/${run.id}/results?pageSize=50`);
    const one = results.body.data.find((r: { employee: { employeeCode: string } }) => r.employee.employeeCode === 'EMP001');

    const leaveLines = one.items.filter((i: { source: string }) => i.source === 'LEAVE');
    expect(leaveLines).toHaveLength(1); // only the unpaid day
    expect(leaveLines[0].description).toMatch(/unpaid/);

    // the absence line must not count the days covered by leave
    const absence = one.items.find((i: { componentCode: string }) => i.componentCode === 'ABSENCE_DEDUCTION');
    const leaveDates = await prisma.leaveRequest.findMany({ where: { employeeId: emp.EMP001, status: 'APPROVED' }, select: { startDate: true } });
    for (const { startDate } of leaveDates) expect(absence.description).not.toContain(startDate);
  }, 60000);

  it('every source line references what produced it', async () => {
    const run = (await as(admin, 'get', `/api/v1/payroll/periods/${periodId}`)).body.data.run;
    const results = await as(admin, 'get', `/api/v1/payroll/runs/${run.id}/results?pageSize=50`);
    const one = results.body.data.find((r: { employee: { employeeCode: string } }) => r.employee.employeeCode === 'EMP001');
    const base = one.items.find((i: { source: string }) => i.source === 'BASE');
    const ot = one.items.find((i: { source: string }) => i.source === 'OT');
    const recurring = one.items.find((i: { source: string }) => i.source === 'RECURRING');
    const leave = one.items.find((i: { source: string }) => i.source === 'LEAVE');
    expect(base.referenceType).toBe('EmployeeCompensation');
    expect(ot.referenceType).toBe('OvertimeRequest');
    expect(recurring.referenceType).toBe('EmployeePayItem');
    expect(leave.referenceType).toBe('LeaveRequest');
    for (const line of [base, ot, recurring, leave]) expect(line.referenceId).toBeTruthy();
  });

  it('only approved overtime is paid, exactly once', async () => {
    const run = (await as(admin, 'get', `/api/v1/payroll/periods/${periodId}`)).body.data.run;
    const otLines = await prisma.payrollResultItem.findMany({ where: { payrollResult: { runId: run.id }, source: 'OT' } });
    expect(otLines).toHaveLength(1);
    const approvedCount = await prisma.overtimeRequest.count({ where: { status: 'APPROVED' } });
    expect(otLines.length).toBe(approvedCount);
    // recalculating does not double it
    await as(admin, 'post', `/api/v1/payroll/periods/${periodId}/calculate`);
    expect(await prisma.payrollResultItem.count({ where: { payrollResult: { run: { periodId } }, source: 'OT' } })).toBe(1);
  }, 120000);
});

// ---------------------------------------------------------------------------
describe('review, adjustment and reconciliation', () => {
  it('a manual earning and deduction change the totals, and the run still reconciles', async () => {
    const run = (await as(admin, 'get', `/api/v1/payroll/periods/${periodId}`)).body.data.run;
    const results = await as(admin, 'get', `/api/v1/payroll/runs/${run.id}/results?pageSize=50`);
    const one = results.body.data.find((r: { employee: { employeeCode: string } }) => r.employee.employeeCode === 'EMP001');
    const before = one.netPay;

    const bonus = await as(admin, 'post', `/api/v1/payroll/results/${one.id}/adjustments`).send({ componentId: components.MANUAL_EARNING, amount: '500.00', note: 'Agreed project bonus' });
    expect(bonus.status).toBe(201);
    const fine = await as(admin, 'post', `/api/v1/payroll/results/${one.id}/adjustments`).send({ componentId: components.MANUAL_DEDUCTION, amount: '100.00', note: 'Equipment replacement' });
    expect(fine.status).toBe(201);
    expect(money(fine.body.data.netPay).minus(before).toFixed(2)).toBe('400.00');
    expect((await as(admin, 'post', `/api/v1/payroll/results/${one.id}/adjustments`).send({ componentId: components.MANUAL_EARNING, amount: '10.00', note: '' })).status).toBe(400); // a reason is required

    const reconciliation = await as(admin, 'get', `/api/v1/payroll/runs/${run.id}/reconciliation`);
    expect(reconciliation.body.data).toMatchObject({ ok: true, problems: [], negativeNetEmployees: [] });

    // a generated line cannot be removed; a manual one can
    const generated = one.items.find((i: { isManual: boolean }) => !i.isManual);
    expect(err(await as(admin, 'delete', `/api/v1/payroll/adjustments/${generated.id}`))).toBe('409 PAYROLL_ITEM_GENERATED');
    const manualItem = fine.body.data.items.find((i: { isManual: boolean; componentCode: string }) => i.isManual && i.componentCode === 'MANUAL_DEDUCTION');
    expect((await as(admin, 'delete', `/api/v1/payroll/adjustments/${manualItem.id}`)).status).toBe(200);
  }, 120000);

  it('a manual adjustment survives a recalculation, and generated lines are rebuilt', async () => {
    const run = (await as(admin, 'get', `/api/v1/payroll/periods/${periodId}`)).body.data.run;
    const before = await prisma.payrollResultItem.findMany({ where: { payrollResult: { runId: run.id }, isManual: true }, select: { amount: true, description: true } });
    expect(before.length).toBeGreaterThan(0);

    await as(admin, 'post', `/api/v1/payroll/periods/${periodId}/calculate`);
    const after = await prisma.payrollResultItem.findMany({ where: { payrollResult: { run: { periodId } }, isManual: true }, select: { amount: true, description: true } });
    expect(after.map((i) => i.description).sort()).toEqual(before.map((i) => i.description).sort());
    expect(after.map((i) => i.amount.toString()).sort()).toEqual(before.map((i) => i.amount.toString()).sort());
  }, 120000);

  it('a negative net blocks approval rather than paying somebody a negative amount', async () => {
    const run = (await as(admin, 'get', `/api/v1/payroll/periods/${periodId}`)).body.data.run;
    const results = await as(admin, 'get', `/api/v1/payroll/runs/${run.id}/results?pageSize=50`);
    const two = results.body.data.find((r: { employee: { employeeCode: string } }) => r.employee.employeeCode === 'EMP002');
    const huge = await as(admin, 'post', `/api/v1/payroll/results/${two.id}/adjustments`).send({ componentId: components.MANUAL_DEDUCTION, amount: '99000.00', note: 'Deliberate overdraft for the test' });
    expect(huge.status).toBe(201);

    const reconciliation = await as(admin, 'get', `/api/v1/payroll/runs/${run.id}/reconciliation`);
    expect(reconciliation.body.data.ok).toBe(false);
    expect(reconciliation.body.data.negativeNetEmployees[0]).toMatchObject({ employeeCode: 'EMP002' });
    expect(err(await as(admin, 'post', `/api/v1/payroll/runs/${run.id}/submit`))).toBe('409 PAYROLL_NEGATIVE_NET');

    const manualItem = huge.body.data.items.find((i: { isManual: boolean }) => i.isManual);
    await as(admin, 'delete', `/api/v1/payroll/adjustments/${manualItem.id}`);
  }, 120000);
});

// ---------------------------------------------------------------------------
describe('stale inputs, approval and close', () => {
  it('a source that changes after calculation blocks approval until the run is recalculated', async () => {
    const run = (await as(admin, 'get', `/api/v1/payroll/periods/${periodId}`)).body.data.run;
    // an allowance changes after the run was calculated
    const item = await prisma.employeePayItem.findFirstOrThrow({ where: { employeeId: emp.EMP001, component: { code: 'POSITION_ALLOWANCE' } } });
    await as(admin, 'patch', `/api/v1/payroll/pay-items/${item.id}`).send({ amount: '1200.00' });

    const period = await as(admin, 'get', `/api/v1/payroll/periods/${periodId}`);
    expect(period.body.data.run.inputsCurrent).toBe(false);
    expect(err(await as(admin, 'post', `/api/v1/payroll/runs/${run.id}/submit`))).toBe('409 PAYROLL_INPUT_CHANGED');

    await as(admin, 'post', `/api/v1/payroll/periods/${periodId}/calculate`);
    const recalculated = await as(admin, 'get', `/api/v1/payroll/periods/${periodId}`);
    expect(recalculated.body.data.run.inputsCurrent).toBe(true);
    const results = await as(admin, 'get', `/api/v1/payroll/runs/${run.id}/results?pageSize=50`);
    const one = results.body.data.find((r: { employee: { employeeCode: string } }) => r.employee.employeeCode === 'EMP001');
    expect(one.items.find((i: { componentCode: string }) => i.componentCode === 'POSITION_ALLOWANCE').amount).toBe('1200.00');
  }, 180000);

  it('approval goes through the workflow, then the run can be closed and never changes again', async () => {
    const run = (await as(admin, 'get', `/api/v1/payroll/periods/${periodId}`)).body.data.run;
    const submitted = await as(admin, 'post', `/api/v1/payroll/runs/${run.id}/submit`);
    expect(submitted.status).toBe(200);
    expect(submitted.body.data.workflowInstanceId).toBeTruthy();

    expect(err(await as(admin, 'post', `/api/v1/payroll/runs/${run.id}/close`))).toBe('409 PAYROLL_RUN_NOT_APPROVED');
    expect((await as(approver, 'post', `/api/v1/workflow/instances/${submitted.body.data.workflowInstanceId}/actions`).send({ action: 'APPROVE', comment: 'Checked against the register' })).status).toBe(200);

    const approved = await as(admin, 'get', `/api/v1/payroll/periods/${periodId}`);
    expect(approved.body.data.status).toBe('APPROVED');
    expect(approved.body.data.run.status).toBe('APPROVED');
    // an approved run is no longer calculable
    expect(err(await as(admin, 'post', `/api/v1/payroll/periods/${periodId}/calculate`))).toBe('409 PAYROLL_PERIOD_NOT_OPEN');

    const closed = await as(admin, 'post', `/api/v1/payroll/runs/${run.id}/close`);
    expect(closed.body.data.status).toBe('CLOSED');
    expect(err(await as(admin, 'post', `/api/v1/payroll/runs/${run.id}/close`))).toBe('409 PAYROLL_RUN_CLOSED');
    expect(err(await as(admin, 'post', `/api/v1/payroll/periods/${periodId}/calculate`))).toBe('409 PAYROLL_PERIOD_NOT_OPEN');
    expect(err(await as(admin, 'patch', `/api/v1/payroll/periods/${periodId}`).send({ paymentDate: '2026-06-01' }))).toBe('409 PAYROLL_PERIOD_FROZEN');

    const audits = await prisma.auditLog.findMany({ where: { module: 'payroll' }, select: { action: true } });
    expect(audits.map((a) => a.action)).toEqual(expect.arrayContaining([
      'CREATE_COMPENSATION', 'CREATE_PAY_COMPONENT', 'ASSIGN_PAY_ITEM', 'CREATE_PAYROLL_PERIOD',
      'CALCULATE_PAYROLL', 'ADD_PAYROLL_ADJUSTMENT', 'SUBMIT_PAYROLL_RUN', 'APPROVE_PAYROLL_RUN', 'CLOSE_PAYROLL_RUN',
    ]));
  }, 180000);

  it('a closed payslip does not change when the salary does', async () => {
    const result = await prisma.payrollResult.findFirstOrThrow({ where: { employeeId: emp.EMP001 }, select: { id: true, baseSalary: true, netPay: true } });
    const compensation = await prisma.employeeCompensation.findFirstOrThrow({ where: { employeeId: emp.EMP001 } });
    await as(admin, 'patch', `/api/v1/payroll/compensations/${compensation.id}`).send({ effectiveTo: '2026-12-31' });
    await as(admin, 'post', '/api/v1/payroll/compensations').send({ employeeId: emp.EMP001, effectiveFrom: '2027-01-01', baseSalary: '36000.00' });
    // renaming a component must not rewrite the payslip either
    await as(admin, 'patch', `/api/v1/payroll/components/${components.POSITION_ALLOWANCE}`).send({ name: 'Position allowance (revised)' });

    const after = await prisma.payrollResult.findUniqueOrThrow({ where: { id: result.id }, include: { items: true } });
    expect(after.baseSalary.toString()).toBe(result.baseSalary.toString());
    expect(after.netPay.toString()).toBe(result.netPay.toString());
    expect(after.items.find((i) => i.componentCodeSnapshot === 'POSITION_ALLOWANCE')?.componentNameSnapshot).toBe('Position allowance');
  }, 120000);
});

// ---------------------------------------------------------------------------
describe('payslips and confidentiality', () => {
  it('an employee sees their own closed payslip and nobody else\'s', async () => {
    const mine = await as(emp1, 'get', '/api/v1/payroll/payslips/me');
    expect(mine.status).toBe(200);
    expect(mine.body.data).toHaveLength(1);
    const payslip = await as(emp1, 'get', `/api/v1/payroll/payslips/me/${mine.body.data[0].id}`);
    expect(payslip.body.data).toMatchObject({ employee: { employeeCode: 'EMP001' }, currencyCode: 'THB' });
    expect(payslip.body.data.earnings.some((i: { componentCode: string }) => i.componentCode === 'BASE_SALARY')).toBe(true);
    expect(payslip.body.data.notice).toMatch(/does not include automatically calculated withholding tax/);

    // somebody else's result id is a 404, not a 403
    const other = await prisma.payrollResult.findFirstOrThrow({ where: { employeeId: emp.EMP002 }, select: { id: true } });
    expect(err(await as(emp1, 'get', `/api/v1/payroll/payslips/me/${other.id}`))).toBe('404 PAYSLIP_NOT_FOUND');
    const theirs = await as(emp2, 'get', '/api/v1/payroll/payslips/me');
    expect(theirs.body.data).toHaveLength(1);
    expect(theirs.body.data[0].id).not.toBe(mine.body.data[0].id);
  });

  it('payroll screens are closed to everybody without a payroll permission', async () => {
    for (const session of [emp1, manager]) {
      expect((await as(session, 'get', '/api/v1/payroll/periods')).status).toBe(403);
      expect((await as(session, 'get', `/api/v1/payroll/runs/${(await prisma.payrollRun.findFirstOrThrow()).id}/results`)).status).toBe(403);
      expect((await as(session, 'get', '/api/v1/payroll/compensations')).status).toBe(403);
    }
    // HR can configure but not run payroll
    expect((await as(hr, 'get', '/api/v1/payroll/periods')).status).toBe(200);
    expect((await as(hr, 'post', `/api/v1/payroll/periods/${periodId}/calculate`)).status).toBe(403);
  });

  it('the summary and export are payroll-only, and the export is a real CSV', async () => {
    const run = await prisma.payrollRun.findFirstOrThrow();
    const summary = await as(admin, 'get', `/api/v1/payroll/runs/${run.id}/summary`);
    expect(summary.body.data).toMatchObject({ employeeCount: 3, currencyCode: 'THB' });
    expect(summary.body.data.byComponent.some((c: { componentCode: string }) => c.componentCode === 'BASE_SALARY')).toBe(true);
    expect(summary.body.data.byDepartment[0]).toMatchObject({ departmentName: 'Operations' });

    const exported = await as(admin, 'get', `/api/v1/payroll/runs/${run.id}/export`);
    expect(exported.status).toBe(200);
    expect(exported.headers['content-type']).toMatch(/text\/csv/);
    expect(exported.text).toContain('Employee code');
    expect(exported.text).toContain('EMP001');
    expect((await as(emp1, 'get', `/api/v1/payroll/runs/${run.id}/export`)).status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
describe('concurrency', () => {
  it('two calculations of the same period do not produce duplicate results', async () => {
    const period = await as(admin, 'post', '/api/v1/payroll/periods').send({
      organizationId: orgId, year: YEAR, month: 6, periodStart: '2026-06-01', periodEnd: '2026-06-30',
      attendanceFrom: '2026-05-21', attendanceTo: '2026-06-20',
    });
    expect(period.status).toBe(201);
    const results = await Promise.all([
      as(admin, 'post', `/api/v1/payroll/periods/${period.body.data.id}/calculate`),
      as(admin, 'post', `/api/v1/payroll/periods/${period.body.data.id}/calculate`),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    const runs = await prisma.payrollRun.findMany({ where: { periodId: period.body.data.id } });
    expect(runs).toHaveLength(1);
    expect(await prisma.payrollResult.count({ where: { runId: runs[0].id } })).toBe(3); // one per employee, not two
    const reconciliation = await as(admin, 'get', `/api/v1/payroll/runs/${runs[0].id}/reconciliation`);
    expect(reconciliation.body.data.ok).toBe(true);
  }, 180000);

  it('a run can only be approved once, and cannot be recalculated while it is being approved', async () => {
    const period = await prisma.payrollPeriod.findFirstOrThrow({ where: { month: 6 } });
    const run = await prisma.payrollRun.findFirstOrThrow({ where: { periodId: period.id } });
    const submitted = await as(admin, 'post', `/api/v1/payroll/runs/${run.id}/submit`);
    expect(submitted.status).toBe(200);

    const decisions = await Promise.all([
      as(approver, 'post', `/api/v1/workflow/instances/${submitted.body.data.workflowInstanceId}/actions`).send({ action: 'APPROVE' }),
      as(approver, 'post', `/api/v1/workflow/instances/${submitted.body.data.workflowInstanceId}/actions`).send({ action: 'APPROVE' }),
    ]);
    expect(decisions.filter((r) => r.status === 200)).toHaveLength(1);
    const after = await prisma.payrollRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(after.status).toBe('APPROVED');
    expect(await prisma.payrollResult.count({ where: { runId: run.id } })).toBe(3);

    const closeRace = await Promise.all([as(admin, 'post', `/api/v1/payroll/runs/${run.id}/close`), as(admin, 'post', `/api/v1/payroll/runs/${run.id}/close`)]);
    expect(closeRace.filter((r) => r.status === 200)).toHaveLength(1);
  }, 180000);
});

// ---------------------------------------------------------------------------
describe('a run waiting for an approver', () => {
  /**
   * A run keeps the status REVIEW while it waits for a decision, but it no longer belongs to the payroll officer: the
   * approver must decide on the amounts they were shown. Rejection hands it back, and only then is it editable again.
   */
  it('is frozen until the decision, and editable again once it is rejected', async () => {
    const period = await as(admin, 'post', '/api/v1/payroll/periods').send({
      organizationId: orgId, year: YEAR, month: 7, periodStart: '2026-07-01', periodEnd: '2026-07-31',
      attendanceFrom: '2026-06-21', attendanceTo: '2026-07-20',
    });
    expect(period.status).toBe(201);
    const periodId7 = period.body.data.id as string;
    const run = (await as(admin, 'post', `/api/v1/payroll/periods/${periodId7}/calculate`)).body.data;
    const results = await as(admin, 'get', `/api/v1/payroll/runs/${run.id}/results?pageSize=50`);
    const result = results.body.data.find((r: { employee: { employeeCode: string } }) => r.employee.employeeCode === 'EMP001');

    const submitted = await as(admin, 'post', `/api/v1/payroll/runs/${run.id}/submit`);
    expect(submitted.status).toBe(200);
    expect(submitted.body.data.status).toBe('REVIEW'); // still in review, but no longer the officer's to change

    const adjustment = { componentId: components.MANUAL_EARNING, amount: '100.00', note: 'While the approver looks at it' };
    expect(err(await as(admin, 'post', `/api/v1/payroll/results/${result.id}/adjustments`).send(adjustment))).toBe('409 PAYROLL_RUN_PENDING_APPROVAL');
    expect(err(await as(admin, 'post', `/api/v1/payroll/periods/${periodId7}/calculate`))).toBe('409 PAYROLL_RUN_PENDING_APPROVAL');
    const manualLine = result.items.find((i: { isManual: boolean }) => i.isManual);
    if (manualLine) expect(err(await as(admin, 'delete', `/api/v1/payroll/adjustments/${manualLine.id}`))).toBe('409 PAYROLL_RUN_PENDING_APPROVAL');

    const rejected = await as(approver, 'post', `/api/v1/workflow/instances/${submitted.body.data.workflowInstanceId}/actions`).send({ action: 'REJECT', comment: 'Check the allowances' });
    expect(rejected.status).toBe(200);
    const back = (await as(admin, 'get', `/api/v1/payroll/periods/${periodId7}`)).body.data.run;
    expect(back.status).toBe('REVIEW');
    expect(back.workflowInstanceId).toBeNull();
    expect((await as(admin, 'post', `/api/v1/payroll/results/${result.id}/adjustments`).send(adjustment)).status).toBe(201);
    expect((await as(admin, 'post', `/api/v1/payroll/periods/${periodId7}/calculate`)).status).toBe(200);
  }, 180000);
});
