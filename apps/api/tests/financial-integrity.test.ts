/**
 * Task 48 — financial and data correctness (T44-P1-14, T44-P1-16, T44-P2-15).
 *
 * Two organizations: PAY (THB payroll) and USCO (USD payroll), five employees each so organization totals clear the
 * small-group rule. Every expectation below was first run against the pre-Task-48 code and failed (log kept with the
 * task); the comments say what used to happen.
 */
import type { Server } from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma';
import { createTestServer, createUser, loginAs, resetDatabase } from './helpers';

const app: Server = createTestServer();
const PW = 'Correct-Horse-1';
const TZ = 'Asia/Bangkok';
type Session = { cookie: string; csrf: string; user: { id: string } };
const as = (s: Session, m: 'get' | 'post' | 'patch' | 'delete', url: string) => request(app)[m](url).set('Cookie', s.cookie).set('x-csrf-token', s.csrf);
const err = (r: request.Response) => `${r.status} ${r.body?.error?.code ?? ''}`.trim();
const P = '/api/v1/payroll';

let admin: Session, approver: Session;
const org: Record<string, string> = {};
const emp: Record<string, string> = {};
const period: Record<string, string> = {};

async function mkOrg(code: string, currency: string, salaries: [string, string, string][]) {
  const o = await prisma.organization.create({ data: { code, name: `${code} Co`, timezone: TZ } });
  org[code] = o.id;
  const dept = await prisma.department.create({ data: { organizationId: o.id, code: `${code}D`, name: `${code} Ops` } });
  const position = await prisma.position.create({ data: { departmentId: dept.id, code: `${code}P`, title: 'Officer' } });
  for (const [ecode] of salaries) {
    emp[ecode] = (await prisma.employee.create({ data: {
      employeeCode: ecode, firstName: ecode, lastName: 'Person', email: `${ecode.toLowerCase()}@fin.local`, hireDate: new Date('2020-01-01T00:00:00Z'),
      organizationId: o.id, departmentId: dept.id, positionId: position.id, employmentType: 'FULL_TIME', employmentStatus: 'ACTIVE',
    } })).id;
  }
  const policy = await as(admin, 'post', `${P}/policies`).send({
    organizationId: o.id, name: `${code} payroll`, monthlyDivisorDays: 30, dailyWorkHours: 8, newHireProration: 'CALENDAR_DAYS', terminationProration: 'CALENDAR_DAYS',
    absenceDeductionEnabled: false, lateDeductionEnabled: false, workflowDefinitionCode: 'PAYROLL_STD', effectiveFrom: '2020-01-01', currencyCode: currency,
  });
  expect(policy.status).toBe(201);
  for (const [ecode, salary, cur] of salaries) {
    expect((await as(admin, 'post', `${P}/compensations`).send({ employeeId: emp[ecode], effectiveFrom: '2020-01-01', baseSalary: salary, currencyCode: cur })).status).toBe(201);
  }
  const p = await as(admin, 'post', `${P}/periods`).send({ organizationId: o.id, year: 2026, month: 5, periodStart: '2026-05-01', periodEnd: '2026-05-31', attendanceFrom: '2026-04-21', attendanceTo: '2026-05-20', paymentDate: '2026-05-28' });
  expect(p.status).toBe(201);
  period[code] = p.body.data.id;
}

async function approveRun(runId: string) {
  const sub = await as(admin, 'post', `${P}/runs/${runId}/submit`);
  expect(sub.status, JSON.stringify(sub.body)).toBe(200);
  const inst = (await prisma.payrollRun.findUniqueOrThrow({ where: { id: runId } })).workflowInstanceId!;
  const ap = await as(approver, 'post', `/api/v1/workflow/instances/${inst}/actions`).send({ action: 'APPROVE' });
  expect(ap.status, JSON.stringify(ap.body)).toBe(200);
}

beforeAll(async () => {
  await resetDatabase();
  // payroll officer and approver sit in a back office outside both paid populations (no self-approval)
  const back = await prisma.organization.create({ data: { code: 'BACK', name: 'Back office', timezone: TZ } });
  const backDept = await prisma.department.create({ data: { organizationId: back.id, code: 'ADM', name: 'Administration' } });
  const backPos = await prisma.position.create({ data: { departmentId: backDept.id, code: 'ADMP', title: 'Officer' } });
  const mkBack = async (code: string) => (await prisma.employee.create({ data: { employeeCode: code, firstName: code, lastName: 'Officer', email: `${code.toLowerCase()}@fin.local`, hireDate: new Date('2020-01-01T00:00:00Z'), organizationId: back.id, departmentId: backDept.id, positionId: backPos.id, employmentType: 'FULL_TIME', employmentStatus: 'ACTIVE' } })).id;
  await createUser({ email: 'admin@fin.local', password: PW, role: 'SYSTEM_ADMIN', employeeId: await mkBack('PAYADM') });
  await createUser({ email: 'approver@fin.local', password: PW, role: 'HR_ADMIN', employeeId: await mkBack('APPROVER') });
  [admin, approver] = await Promise.all(['admin', 'approver'].map((u) => loginAs(app, `${u}@fin.local`, PW)));
  const def = await as(admin, 'post', '/api/v1/workflow/definitions').send({ code: 'PAYROLL_STD', name: 'Payroll', module: 'payroll', entityType: 'PAYROLL_RUN', steps: [{ name: 'Approver', approverType: 'SPECIFIC_USER', approverUserId: approver.user.id }] });
  await as(admin, 'post', `/api/v1/workflow/definitions/${def.body.data.id}/activate`);

  // PAY: THB payroll; T05's salary record is in USD — the defect T44-P1-14 is about.
  await mkOrg('PAY', 'THB', [['T01', '30000.00', 'THB'], ['T02', '24000.00', 'THB'], ['T03', '45000.00', 'THB'], ['T04', '18000.50', 'THB'], ['T05', '1000.00', 'USD']]);
  await mkOrg('USCO', 'USD', [['U01', '5000.00', 'USD'], ['U02', '4000.00', 'USD'], ['U03', '3000.00', 'USD'], ['U04', '2500.25', 'USD'], ['U05', '2000.00', 'USD']]);
}, 180000);

afterAll(async () => { await resetDatabase(); await prisma.$disconnect(); });

describe('T44-P1-14 — payroll never books money in a currency it does not pay in', () => {
  it('a salary record in another currency blocks the calculation with a named error; nothing is written', async () => {
    // Before Task 48: 200, T05's USD 1,000.00 was paid as THB 1,000.00.
    const r = await as(admin, 'post', `${P}/periods/${period.PAY}/calculate`);
    expect(err(r)).toBe('409 PAYROLL_CURRENCY_MISMATCH');
    expect(r.body.error.message).toContain('T05');
    expect(r.body.error.message).toContain('USD');
    expect(await prisma.payrollRun.count({ where: { periodId: period.PAY } })).toBe(0);
  });

  it('once the salary is recorded in the payroll currency the period calculates; results carry the period currency', async () => {
    // The correct salary record (THB) replaces the wrong one — HR's fix, done here directly on the fixture row.
    await prisma.employeeCompensation.updateMany({ where: { employeeId: emp.T05 }, data: { currencyCode: 'THB', baseSalary: '35000.00' } });
    const r = await as(admin, 'post', `${P}/periods/${period.PAY}/calculate`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data).toMatchObject({ currencyCode: 'THB', grossTotal: '152000.50', netTotal: '152000.50', employeeCount: 5 });
    expect(await prisma.payrollResult.count({ where: { runId: r.body.data.id, currencyCode: { not: 'THB' } } })).toBe(0);
  });

  it('the salary currency is part of the input fingerprint: changing it after calculation makes the run stale', async () => {
    const before = (await as(admin, 'get', `${P}/periods/${period.PAY}`)).body.data;
    expect(before.run.inputsCurrent).toBe(true);
    await prisma.employeeCompensation.updateMany({ where: { employeeId: emp.T05 }, data: { currencyCode: 'USD' } });
    // Before Task 48: still "current" — the currency was not an input.
    expect((await as(admin, 'get', `${P}/periods/${period.PAY}`)).body.data.run.inputsCurrent).toBe(false);
    await prisma.employeeCompensation.updateMany({ where: { employeeId: emp.T05 }, data: { currencyCode: 'THB' } });
    expect((await as(admin, 'get', `${P}/periods/${period.PAY}`)).body.data.run.inputsCurrent).toBe(true);
  });

  it('a manual adjustment is entered in the run currency: its amount is exact to the satang (Decimal end to end)', async () => {
    const result = await prisma.payrollResult.findFirstOrThrow({ where: { employeeId: emp.T04 } });
    const component = await prisma.payComponent.create({ data: { code: 'ADJ_E', name: 'Adjustment', type: 'EARNING' } });
    const a = await as(admin, 'post', `${P}/results/${result.id}/adjustments`).send({ componentId: component.id, amount: '0.10', note: 'first' });
    expect(a.status).toBe(201);
    const b = await as(admin, 'post', `${P}/results/${result.id}/adjustments`).send({ componentId: component.id, amount: '0.20', note: 'second' });
    expect(b.body.data.grossPay).toBe('18000.80'); // 18000.50 + 0.10 + 0.20 — never 18000.800000000003
    for (const item of b.body.data.items.filter((i: { isManual: boolean }) => i.isManual)) {
      expect((await as(admin, 'delete', `${P}/adjustments/${item.id}`)).status).toBe(200); // ordinary manual lines stay removable
    }
  });
});

describe('T44-P1-16 — an approved payroll cannot drift from its inputs', () => {
  let runId: string;
  it('setup: an attendance day inside the window is part of the run; the run is approved', async () => {
    await prisma.attendanceRecord.create({ data: { employeeId: emp.T01, attendanceDate: '2026-05-06', dayType: 'WORKDAY', workMinutes: 480, status: 'NORMAL', calculatedAt: new Date('2026-05-06T12:00:00Z') } });
    const calc = await as(admin, 'post', `${P}/periods/${period.PAY}/calculate`);
    expect(calc.status).toBe(200);
    runId = calc.body.data.id;
    await approveRun(runId);
    expect((await prisma.payrollPeriod.findUniqueOrThrow({ where: { id: period.PAY } })).status).toBe('APPROVED');
  });

  it('a recurring pay item dated inside the approved period is refused', async () => {
    const component = await prisma.payComponent.create({ data: { code: 'ALLOW', name: 'Allowance', type: 'EARNING', recurringAllowed: true } });
    // Before Task 48: 201 — the approved run then closed without it, and nothing said so.
    const r = await as(admin, 'post', `${P}/pay-items`).send({ employeeId: emp.T01, componentId: component.id, amount: '1500.00', effectiveFrom: '2026-05-01', effectiveTo: '2026-05-31' });
    expect(err(r)).toBe('409 PAYROLL_PERIOD_LOCKED');
    // the same item starting after the period is accepted
    const later = await as(admin, 'post', `${P}/pay-items`).send({ employeeId: emp.T01, componentId: component.id, amount: '1500.00', effectiveFrom: '2026-06-01' });
    expect(later.status).toBe(201);
    // an item outside the frozen period stays editable
    expect((await as(admin, 'patch', `${P}/pay-items/${later.body.data.id}`).send({ amount: '1600.00' })).status).toBe(200);
    // an item covering the frozen period cannot be re-priced (that would rewrite what the approved run paid)
    const t03 = await prisma.employeePayItem.create({ data: { employeeId: emp.T03, componentId: component.id, amount: '500.00', effectiveFrom: '2026-01-01', createdByUserId: admin.user.id } });
    expect(err(await as(admin, 'patch', `${P}/pay-items/${t03.id}`).send({ amount: '900.00' }))).toBe('409 PAYROLL_PERIOD_LOCKED');
    // ...but ending it after the period is fine
    expect((await as(admin, 'patch', `${P}/pay-items/${t03.id}`).send({ effectiveTo: '2026-06-30' })).status).toBe(200);
    await prisma.employeePayItem.delete({ where: { id: t03.id } }); // a raw fixture row: it must not stay an input of the approved run
  });

  it('a salary record starting inside the approved period is refused', async () => {
    const t02 = await prisma.employeeCompensation.findFirstOrThrow({ where: { employeeId: emp.T02 } });
    // Closing the current record inside the period is already refused (COMPENSATION_IN_USE); a record for somebody
    // without one would have slipped in.
    await prisma.employeeCompensation.update({ where: { id: t02.id }, data: { effectiveTo: '2026-04-30' } }); // simulate: T02's record ended before May
    const r = await as(admin, 'post', `${P}/compensations`).send({ employeeId: emp.T02, effectiveFrom: '2026-05-10', baseSalary: '99999.00', currencyCode: 'THB' });
    expect(err(r)).toBe('409 PAYROLL_PERIOD_LOCKED');
    await prisma.employeeCompensation.update({ where: { id: t02.id }, data: { effectiveTo: null } });
  });

  it('recalculating an attendance day inside the approved window is refused when it would change the day', async () => {
    // Before Task 48: 200 — the day became ABSENT (no clock-in), the approved run still paid it as NORMAL.
    const r = await as(admin, 'post', '/api/v1/attendance/recalculate').send({ from: '2026-05-06', to: '2026-05-06', employeeId: emp.T01 });
    expect(err(r)).toBe('409 PAYROLL_PERIOD_LOCKED');
    expect((await prisma.attendanceRecord.findFirstOrThrow({ where: { employeeId: emp.T01, attendanceDate: '2026-05-06' } })).status).toBe('NORMAL');
  });

  it('close re-checks the inputs: a change that got past the guards stops the close', async () => {
    // Anything not guarded at its source (here: a raw edit) is caught when the run is closed.
    await prisma.attendanceRecord.updateMany({ where: { employeeId: emp.T01, attendanceDate: '2026-05-06' }, data: { status: 'ABSENT' } });
    // Before Task 48: 200 CLOSED with the old figures.
    expect(err(await as(admin, 'post', `${P}/runs/${runId}/close`))).toBe('409 PAYROLL_INPUT_CHANGED');
    expect((await prisma.payrollRun.findUniqueOrThrow({ where: { id: runId } })).status).toBe('APPROVED');
    await prisma.attendanceRecord.updateMany({ where: { employeeId: emp.T01, attendanceDate: '2026-05-06' }, data: { status: 'NORMAL' } });
    expect((await as(admin, 'post', `${P}/runs/${runId}/close`)).status).toBe(200);
  });

  it('after close the same guards hold (CLOSED is frozen too)', async () => {
    const r = await as(admin, 'post', '/api/v1/attendance/recalculate').send({ from: '2026-05-06', to: '2026-05-06', employeeId: emp.T01 });
    expect(err(r)).toBe('409 PAYROLL_PERIOD_LOCKED');
  });
});

describe('T44-P2-15 — money is never added across currencies', () => {
  it('setup: the USD organization closes its May run', async () => {
    const calc = await as(admin, 'post', `${P}/periods/${period.USCO}/calculate`);
    expect(calc.status, JSON.stringify(calc.body)).toBe(200);
    expect(calc.body.data).toMatchObject({ currencyCode: 'USD', netTotal: '16500.25' });
    await approveRun(calc.body.data.id);
    expect((await as(admin, 'post', `${P}/runs/${calc.body.data.id}/close`)).status).toBe(200);
  });

  it('executive overview: one entry per currency, never a THB+USD total', async () => {
    const r = await as(admin, 'get', '/api/v1/analytics/executive/overview?from=2026-05-01&to=2026-05-31');
    expect(r.status).toBe(200);
    const p = r.body.data.sections.payroll;
    // Before Task 48: { currencyCode: 'THB', grossTotal: '168500.75' } — 152,000.50 THB + 16,500.25 USD.
    expect(JSON.stringify(p)).not.toContain('168500.75');
    expect(p.byCurrency).toEqual([
      { currencyCode: 'THB', runs: 1, employeesPaid: 5, grossTotal: '152000.50', deductionTotal: '0.00', netTotal: '152000.50' },
      { currencyCode: 'USD', runs: 1, employeesPaid: 5, grossTotal: '16500.25', deductionTotal: '0.00', netTotal: '16500.25' },
    ]);
    expect(p.byPeriod.map((x: { currencyCode: string }) => x.currencyCode).sort()).toEqual(['THB', 'USD']);
    expect(p).not.toHaveProperty('grossTotal');
  });

  it('executive CSV lists the currencies separately', async () => {
    const r = await as(admin, 'get', '/api/v1/analytics/executive/export?from=2026-05-01&to=2026-05-31');
    expect(r.status).toBe(200);
    expect(r.text).toContain('THB');
    expect(r.text).toContain('USD');
    expect(r.text).not.toContain('168500.75');
  });

  it('Report Center: payroll money fields declare their currency; grouped by currency, each currency stands alone', async () => {
    await import('../src/modules/reports/datasets');
    const { getDataset } = await import('../src/modules/reports/registry');
    const ds = getDataset('payroll_period_summary')!;
    // Before Task 48: no currencyField — safe only because currencyCode happened to be the one groupable field.
    expect(ds.fields.filter((f) => f.type === 'DECIMAL').map((f) => [f.id, f.currencyField])).toEqual([['grossTotal', 'currencyCode'], ['deductionTotal', 'currencyCode'], ['netTotal', 'currencyCode']]);
    const ok = await as(admin, 'post', '/api/v1/reports/run').send({ datasetId: 'payroll_period_summary', page: 1, definition: { columns: ['currencyCode'], filters: [], sort: [], groupBy: ['currencyCode'], aggregations: [{ fieldId: 'netTotal', function: 'SUM', alias: 'Net' }], pageSize: 50 } });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(JSON.stringify(ok.body.data.rows)).not.toContain('168500.75');
    expect(ok.body.data.rows).toHaveLength(2);
  });

  it('a closed run of fewer than five people is withheld from the executive totals (the Report Center rule)', async () => {
    const small = await prisma.organization.create({ data: { code: 'TINY', name: 'Tiny Co', timezone: TZ } });
    const tinyPeriod = await prisma.payrollPeriod.create({ data: { organizationId: small.id, year: 2026, month: 5, periodStart: '2026-05-01', periodEnd: '2026-05-31', attendanceFrom: '2026-05-01', attendanceTo: '2026-05-31', currencyCode: 'THB', status: 'CLOSED' } });
    const run = await prisma.payrollRun.create({ data: { periodId: tinyPeriod.id, startedByUserId: admin.user.id, status: 'CLOSED', employeeCount: 1, grossTotal: '77777.00', deductionTotal: '0.00', netTotal: '77777.00', currencyCode: 'THB', closedAt: new Date() } });
    const r = await as(admin, 'get', '/api/v1/analytics/executive/overview?from=2026-05-01&to=2026-05-31');
    const p = r.body.data.sections.payroll;
    expect(JSON.stringify(p)).not.toContain('77777');
    expect(p.byCurrency.find((c: { currencyCode: string }) => c.currencyCode === 'THB').runs).toBe(1);
    expect(p.withheldRuns).toBe(1);
    await prisma.payrollRun.delete({ where: { id: run.id } });
  });
});

describe('concurrency — approval against a source change (T44-P1-16)', () => {
  it('an approval racing a recurring pay item for the same period never ends with both accepted', async () => {
    for (let round = 0; round < 3; round++) {
      const month = 6 + round;
      const mm = String(month).padStart(2, '0');
      const end = `2026-${mm}-${month === 6 || month === 9 ? '30' : '31'}`;
      const p = await as(admin, 'post', `${P}/periods`).send({ organizationId: org.PAY, year: 2026, month, periodStart: `2026-${mm}-01`, periodEnd: end, attendanceFrom: `2026-${mm}-01`, attendanceTo: `2026-${mm}-20` });
      expect(p.status, JSON.stringify(p.body)).toBe(201);
      const calc = await as(admin, 'post', `${P}/periods/${p.body.data.id}/calculate`);
      expect(calc.status, JSON.stringify(calc.body)).toBe(200);
      const sub = await as(admin, 'post', `${P}/runs/${calc.body.data.id}/submit`);
      expect(sub.status).toBe(200);
      const inst = (await prisma.payrollRun.findUniqueOrThrow({ where: { id: calc.body.data.id } })).workflowInstanceId!;
      const component = await prisma.payComponent.create({ data: { code: `RACE${round}`, name: `Race ${round}`, type: 'EARNING', recurringAllowed: true } });
      const [approval, item] = await Promise.all([
        as(approver, 'post', `/api/v1/workflow/instances/${inst}/actions`).send({ action: 'APPROVE' }),
        as(admin, 'post', `${P}/pay-items`).send({ employeeId: emp.T02, componentId: component.id, amount: '700.00', effectiveFrom: `2026-${mm}-01`, effectiveTo: end }),
      ]);
      const run = await prisma.payrollRun.findUniqueOrThrow({ where: { id: calc.body.data.id } });
      const itemExists = (await prisma.employeePayItem.count({ where: { componentId: component.id } })) === 1;
      // Exactly one side wins: either the run is approved and the item was refused, or the item exists and the run
      // is still in review (approval refused because its inputs changed).
      if (run.status === 'APPROVED') {
        expect(itemExists).toBe(false);
        expect(`${item.status} ${item.body?.error?.code}`).toBe('409 PAYROLL_PERIOD_LOCKED');
      } else {
        expect(run.status).toBe('REVIEW');
        expect(itemExists).toBe(true);
        expect(approval.status).toBe(409);
      }
    }
  }, 120000);
});

describe('Report Center — DECIMAL filters compare exactly (Task 48, Decimal audit)', () => {
  it('EQ / GT on amounts beyond float precision match exactly one row', async () => {
    const { memoryDataset } = await import('../src/modules/reports/prisma-runner');
    const field = { id: 'amount', label: 'Amount', type: 'DECIMAL', column: 'amount', selectable: true, filterable: true, sortable: true, groupable: false, aggregatable: true } as never;
    const ds = memoryDataset({ id: 't48_decimal', name: 'T48', description: 'T48', requiredPermissions: [], aggregateOnly: false, requiredDateRange: null, fields: [field], load: async () => [{ amount: '9999999999999999.01' }, { amount: '9999999999999999.02' }] });
    const run = (filters: unknown[]) => ds.run({ auth: {} as never, definition: { columns: ['amount'], filters, sort: [], groupBy: [], aggregations: [], pageSize: 50 } as never, page: 1, pageSize: 50 });
    // Before Task 48: Number('9999999999999999.01') === Number('9999999999999999.02'), so EQ matched both rows and GT none.
    expect((await run([{ fieldId: 'amount', operator: 'EQ', value: '9999999999999999.01' }])).rows).toHaveLength(1);
    expect((await run([{ fieldId: 'amount', operator: 'GT', value: '9999999999999999.01' }])).rows).toHaveLength(1);
  });
});
