/**
 * Task 51 — T44-P1-19: self-approval / self-dealing (maker ≠ checker, subject ≠ actor).
 *
 * Task 44 evidence (audit §6.3 / P1-19): "Compensation override/approve/apply chain; payroll own compensation/adjustments;
 * ER subject; service fulfiller own ticket/letter — one person can raise and pay their own salary or handle their own case."
 *
 * Fixture: one organization. HRA (user adminA) and HRB (user adminB) are both financial / HR administrators with the same
 * custom role FIN_ADMIN (payroll, compensation planning, employee relations, services and letters) and are themselves
 * employees of the organization. MGRX manages HRA; HRA manages EMP1 and EMP2.
 * Every expectation below was first run against the pre-Task-51 code (log kept with the task); comments say what happened.
 */
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma';
import { createTestServer, createUser, loginAs, resetDatabase } from './helpers';

const app = createTestServer();
const PW = 'Correct-Horse-1';
type S = { cookie: string; csrf: string; user: { id: string } };
const as = (s: S, m: 'get' | 'post' | 'patch' | 'put' | 'delete', url: string) => request(app)[m](url).set('Cookie', s.cookie).set('x-csrf-token', s.csrf);
const err = (r: request.Response) => `${r.status} ${r.body?.error?.code ?? ''}`.trim();
const P = '/api/v1/payroll';
const C = '/api/v1/compensation-planning';
const E: Record<string, string> = {};
let adminA: S, adminA2: S, adminB: S, mgrX: S;
let orgId: string;

beforeAll(async () => {
  await resetDatabase();
  const org = await prisma.organization.create({ data: { code: 'SD', name: 'Self Dealing Co', timezone: 'Asia/Bangkok' } });
  orgId = org.id;
  const dept = await prisma.department.create({ data: { organizationId: org.id, code: 'SDD', name: 'People' } });
  const job = await prisma.job.create({ data: { code: 'SDJ', title: 'Officer', level: 2 } });
  const pos = await prisma.position.create({ data: { departmentId: dept.id, code: 'SDP', title: 'Officer', jobId: job.id } });
  const mk = async (code: string, managerId: string | null) => (await prisma.employee.create({ data: { employeeCode: code, firstName: code, lastName: 'X', email: `${code.toLowerCase()}@sd.local`, hireDate: new Date('2020-01-01T00:00:00Z'), organizationId: org.id, departmentId: dept.id, positionId: pos.id, managerId, employmentType: 'FULL_TIME', employmentStatus: 'ACTIVE' } })).id;
  E.HEAD = await mk('HEAD', null);
  E.MGRX = await mk('MGRX', E.HEAD);
  E.HRA = await mk('HRA', E.MGRX);
  E.HRB = await mk('HRB', E.HEAD);
  E.EMP1 = await mk('EMP1', E.HRA);
  E.EMP2 = await mk('EMP2', E.HRA);

  const perms = await prisma.permission.findMany({ where: { OR: [
    { code: { startsWith: 'payroll.' } }, { code: { startsWith: 'compensation_planning.' } }, { code: { startsWith: 'employee_relations.' } },
    { code: { startsWith: 'service_request.' } }, { code: { startsWith: 'hr_letter.' } },
    { code: { in: ['employees.view', 'workflow.approve', 'users.view', 'users.update', 'dashboard.view', 'organization.view', 'workflow.manage_definitions'] } },
  ] } });
  await prisma.role.create({ data: { code: 'FIN_ADMIN', name: 'Financial / HR administrator', dataScope: 'ALL', rolePermissions: { create: perms.map((p) => ({ permissionId: p.id })) } } });
  const ua = await createUser({ email: 'admina@sd.local', password: PW, role: 'FIN_ADMIN', employeeId: E.HRA });
  const ub = await createUser({ email: 'adminb@sd.local', password: PW, role: 'FIN_ADMIN', employeeId: E.HRB });
  await createUser({ email: 'mgrx@sd.local', password: PW, role: 'MANAGER', employeeId: E.MGRX });
  adminA = await loginAs(app, 'admina@sd.local', PW);
  adminA2 = await loginAs(app, 'admina@sd.local', PW); // the same user in a second session
  adminB = await loginAs(app, 'adminb@sd.local', PW);
  mgrX = await loginAs(app, 'mgrx@sd.local', PW);

  for (const [code, salary] of [['HEAD', '90000.00'], ['MGRX', '70000.00'], ['HRA', '50000.00'], ['HRB', '50000.00'], ['EMP1', '30000.00'], ['EMP2', '30000.00']] as const) {
    await prisma.employeeCompensation.create({ data: { employeeId: E[code]!, effectiveFrom: '2020-01-01', baseSalary: salary, currencyCode: 'THB', createdByUserId: ub.id } });
  }
  // workflows: payroll runs and ER actions are approved by adminA (SPECIFIC_USER)
  for (const [code, module, entityType] of [['PAYROLL_STD', 'payroll', 'PAYROLL_RUN'], ['ER_STD', 'employee_relations', 'DISCIPLINARY_ACTION']] as const) {
    const def = await as(adminB, 'post', '/api/v1/workflow/definitions').send({ code, name: code, module, entityType, steps: [{ name: 'Approver', approverType: 'SPECIFIC_USER', approverUserId: ua.id }] });
    expect(def.status, JSON.stringify(def.body)).toBe(201);
    await as(adminB, 'post', `/api/v1/workflow/definitions/${def.body.data.id}/activate`);
  }
  expect((await as(adminB, 'post', `${P}/policies`).send({ organizationId: org.id, name: 'Payroll', monthlyDivisorDays: 30, dailyWorkHours: 8, newHireProration: 'CALENDAR_DAYS', terminationProration: 'CALENDAR_DAYS', absenceDeductionEnabled: false, lateDeductionEnabled: false, workflowDefinitionCode: 'PAYROLL_STD', effectiveFrom: '2020-01-01', currencyCode: 'THB' })).status).toBe(201);
  void ub;
}, 180000);
afterAll(async () => { await resetDatabase(); await prisma.$disconnect(); });

const compOf = (emp: string) => prisma.employeeCompensation.findMany({ where: { employeeId: emp }, orderBy: { effectiveFrom: 'asc' }, select: { id: true, baseSalary: true, effectiveFrom: true, effectiveTo: true } });

describe('payroll: own salary, own recurring item, own adjustment', () => {
  it('B. an administrator cannot change their OWN salary record — end it, or open a new one (no write)', async () => {
    const before = JSON.stringify(await compOf(E.HRA!));
    const own = (await prisma.employeeCompensation.findFirstOrThrow({ where: { employeeId: E.HRA } })).id;
    // Before Task 51: 200 and 201 — adminA ended their own salary and opened 99,999.00 from 2027.
    expect(err(await as(adminA, 'patch', `${P}/compensations/${own}`).send({ effectiveTo: '2026-12-31' }))).toBe('403 FINANCIAL_SELF_BENEFIT_NOT_ALLOWED');
    expect(err(await as(adminA, 'post', `${P}/compensations`).send({ employeeId: E.HRA, effectiveFrom: '2027-01-01', baseSalary: '99999.00', currencyCode: 'THB' }))).toBe('403 FINANCIAL_SELF_BENEFIT_NOT_ALLOWED');
    expect(JSON.stringify(await compOf(E.HRA!))).toBe(before);
    expect(await prisma.auditLog.count({ where: { module: 'payroll', action: { in: ['CREATE_COMPENSATION', 'UPDATE_COMPENSATION'] }, userId: adminA.user.id } })).toBe(0);
  });

  it('A. the same administrator changes ANOTHER employee\'s salary normally; an independent administrator may change theirs', async () => {
    const emp2 = (await prisma.employeeCompensation.findFirstOrThrow({ where: { employeeId: E.EMP2 } })).id;
    expect(err(await as(adminA, 'patch', `${P}/compensations/${emp2}`).send({ effectiveTo: '2027-12-31' }))).toBe('200');
    await prisma.employeeCompensation.update({ where: { id: emp2 }, data: { effectiveTo: null } });
    // adminB (independent) for HRA: allowed — a second, authorized person
    const hra = (await prisma.employeeCompensation.findFirstOrThrow({ where: { employeeId: E.HRA } })).id;
    expect(err(await as(adminB, 'patch', `${P}/compensations/${hra}`).send({ note: 'reviewed by B' }))).toBe('200');
  });

  it('own recurring pay item: refused; for another employee: allowed', async () => {
    const component = await prisma.payComponent.create({ data: { code: 'SDALLOW', name: 'Allowance', type: 'EARNING', recurringAllowed: true } });
    // Before Task 51: 201 — a 5,000 monthly allowance for themselves.
    expect(err(await as(adminA, 'post', `${P}/pay-items`).send({ employeeId: E.HRA, componentId: component.id, amount: '5000.00', effectiveFrom: '2026-01-01' }))).toBe('403 FINANCIAL_SELF_BENEFIT_NOT_ALLOWED');
    expect(await prisma.employeePayItem.count({ where: { employeeId: E.HRA } })).toBe(0);
    expect(err(await as(adminA, 'post', `${P}/pay-items`).send({ employeeId: E.EMP1, componentId: component.id, amount: '500.00', effectiveFrom: '2026-01-01' }))).toBe('201');
  });

  let mayRun: string;
  it('own manual adjustment: refused, the payable amount does not move; another employee\'s: allowed', async () => {
    const p = await as(adminA, 'post', `${P}/periods`).send({ organizationId: orgId, year: 2026, month: 5, periodStart: '2026-05-01', periodEnd: '2026-05-31', attendanceFrom: '2026-04-21', attendanceTo: '2026-05-20' });
    expect(p.status, JSON.stringify(p.body)).toBe(201);
    const calc = await as(adminA, 'post', `${P}/periods/${p.body.data.id}/calculate`);
    expect(calc.status, JSON.stringify(calc.body)).toBe(200);
    mayRun = calc.body.data.id;
    const bonus = await prisma.payComponent.create({ data: { code: 'SDBONUS', name: 'Bonus', type: 'EARNING' } });
    const own = await prisma.payrollResult.findFirstOrThrow({ where: { runId: mayRun, employeeId: E.HRA } });
    // Before Task 51: 201 — +20,000 on their own payslip.
    expect(err(await as(adminA, 'post', `${P}/results/${own.id}/adjustments`).send({ componentId: bonus.id, amount: '20000.00', note: 'performance bonus' }))).toBe('403 FINANCIAL_SELF_BENEFIT_NOT_ALLOWED');
    expect((await prisma.payrollResult.findUniqueOrThrow({ where: { id: own.id } })).netPay.toFixed(2)).toBe(own.netPay.toFixed(2));
    const emp1 = await prisma.payrollResult.findFirstOrThrow({ where: { runId: mayRun, employeeId: E.EMP1 } });
    expect(err(await as(adminA, 'post', `${P}/results/${emp1.id}/adjustments`).send({ componentId: bonus.id, amount: '1000.00', note: 'spot award' }))).toBe('201');
  });

  it('D. the approver authored a self-benefiting line in the run (e.g. before Task 51): approval is blocked; the run stays in review', async () => {
    // a line written before this rule existed, or by any path that bypassed the source check, authored by adminA for HRA
    const own = await prisma.payrollResult.findFirstOrThrow({ where: { runId: mayRun, employeeId: E.HRA } });
    const bonus = await prisma.payComponent.findUniqueOrThrow({ where: { code: 'SDBONUS' } });
    await prisma.payrollResultItem.create({ data: { payrollResultId: own.id, componentId: bonus.id, componentCodeSnapshot: 'SDBONUS', componentNameSnapshot: 'Bonus', type: 'EARNING', source: 'MANUAL', amount: '20000.00', description: 'legacy', isManual: true, createdByUserId: adminA.user.id } });
    const period = (await prisma.payrollRun.findUniqueOrThrow({ where: { id: mayRun } })).periodId;
    expect((await as(adminB, 'post', `${P}/periods/${period}/calculate`)).status).toBe(200); // totals include the line
    expect(err(await as(adminB, 'post', `${P}/runs/${mayRun}/submit`))).toBe('200');
    const inst = (await prisma.payrollRun.findUniqueOrThrow({ where: { id: mayRun } })).workflowInstanceId!;
    // Before Task 51: 200 — adminA approved the run that pays their own 20,000.
    const r = await as(adminA, 'post', `/api/v1/workflow/instances/${inst}/actions`).send({ action: 'APPROVE' });
    expect(err(r)).toBe('409 PAYROLL_APPROVER_SELF_BENEFIT');
    expect(JSON.stringify(r.body)).not.toContain('20000');
    expect((await prisma.payrollRun.findUniqueOrThrow({ where: { id: mayRun } })).status).toBe('REVIEW');
  });

  it('C. a normal run that merely includes the approver\'s unchanged salary is approved as usual', async () => {
    const p = await as(adminB, 'post', `${P}/periods`).send({ organizationId: orgId, year: 2026, month: 6, periodStart: '2026-06-01', periodEnd: '2026-06-30', attendanceFrom: '2026-05-21', attendanceTo: '2026-06-20' });
    const calc = await as(adminB, 'post', `${P}/periods/${p.body.data.id}/calculate`);
    expect(calc.status).toBe(200);
    expect(await prisma.payrollResult.count({ where: { runId: calc.body.data.id, employeeId: E.HRA } })).toBe(1);
    expect(err(await as(adminB, 'post', `${P}/runs/${calc.body.data.id}/submit`))).toBe('200');
    const inst = (await prisma.payrollRun.findUniqueOrThrow({ where: { id: calc.body.data.id } })).workflowInstanceId!;
    expect(err(await as(adminA, 'post', `/api/v1/workflow/instances/${inst}/actions`).send({ action: 'APPROVE' }))).toBe('200');
  });

  it('the same user in two sessions is not two people: the engine refuses a run whose only approver is its submitter', async () => {
    const p = await as(adminA, 'post', `${P}/periods`).send({ organizationId: orgId, year: 2026, month: 7, periodStart: '2026-07-01', periodEnd: '2026-07-31', attendanceFrom: '2026-06-21', attendanceTo: '2026-07-20' });
    const calc = await as(adminA, 'post', `${P}/periods/${p.body.data.id}/calculate`);
    // adminA (session 2) is the definition's only approver: the workflow engine already refuses the submission itself
    // (unchanged by Task 51) — a second session of the same user is the same person.
    expect(err(await as(adminA2, 'post', `${P}/runs/${calc.body.data.id}/submit`))).toBe('409 SELF_APPROVAL_NOT_ALLOWED');
    const run = await prisma.payrollRun.findUniqueOrThrow({ where: { id: calc.body.data.id } });
    expect({ status: run.status, workflowInstanceId: run.workflowInstanceId }).toEqual({ status: 'REVIEW', workflowInstanceId: null });
  });

  it('concurrency: an approval racing self-benefiting and independent adjustments never ends approved with a self-authored line', async () => {
    const bonus = await prisma.payComponent.findUniqueOrThrow({ where: { code: 'SDBONUS' } });
    for (const month of [8, 9, 10]) {
      const mm = String(month).padStart(2, '0');
      const p = await as(adminB, 'post', `${P}/periods`).send({ organizationId: orgId, year: 2026, month, periodStart: `2026-${mm}-01`, periodEnd: `2026-${mm}-28`, attendanceFrom: `2026-${mm}-01`, attendanceTo: `2026-${mm}-20` });
      const calc = await as(adminB, 'post', `${P}/periods/${p.body.data.id}/calculate`);
      expect(calc.status).toBe(200);
      const own = await prisma.payrollResult.findFirstOrThrow({ where: { runId: calc.body.data.id, employeeId: E.HRA } });
      expect(err(await as(adminB, 'post', `${P}/runs/${calc.body.data.id}/submit`))).toBe('200');
      const inst = (await prisma.payrollRun.findUniqueOrThrow({ where: { id: calc.body.data.id } })).workflowInstanceId!;
      const [approval, selfAdj, otherAdj] = await Promise.all([
        as(adminA, 'post', `/api/v1/workflow/instances/${inst}/actions`).send({ action: 'APPROVE' }),
        as(adminA2, 'post', `${P}/results/${own.id}/adjustments`).send({ componentId: bonus.id, amount: '9000.00', note: 'race self' }),
        as(adminB, 'post', `${P}/results/${own.id}/adjustments`).send({ componentId: bonus.id, amount: '100.00', note: 'race other' }),
      ]);
      expect(approval.status).toBe(200); // the run carries nothing adminA authored for themselves
      expect(err(selfAdj)).toBe('403 FINANCIAL_SELF_BENEFIT_NOT_ALLOWED');
      expect(otherAdj.status).toBeGreaterThanOrEqual(400); // a run with an approver is frozen (PAYROLL_RUN_PENDING_APPROVAL / NOT_IN_REVIEW)
      expect(await prisma.payrollResultItem.count({ where: { payrollResultId: own.id, isManual: true } })).toBe(0);
      expect((await prisma.payrollRun.findUniqueOrThrow({ where: { id: calc.body.data.id } })).status).toBe('APPROVED');
    }
  });

  it('re-linking one\'s own account to another employee is refused (it would reset who "self" is)', async () => {
    // Before Task 51: 200 — adminA could re-link to EMP2, act on HRA as "someone else", and link back.
    expect(err(await as(adminA, 'patch', `/api/v1/users/${adminA.user.id}`).send({ employeeId: E.EMP2 }))).toBe('403 SELF_EMPLOYEE_LINK_CHANGE_NOT_ALLOWED');
    expect((await prisma.user.findUniqueOrThrow({ where: { id: adminA.user.id } })).employeeId).toBe(E.HRA);
  });
});

describe('compensation planning: no self-benefit, maker ≠ checker', () => {
  let cycleId: string;
  const grid = async () => (await as(adminB, 'get', `${C}/cycles/${cycleId}/employees?eligibility=ELIGIBLE`)).body.data as { employee: { code: string }; proposalId: string; cycleEmployeeId?: string; id?: string }[];
  const proposal = async (code: string) => (await grid()).find((r) => r.employee.code === code)!.proposalId;

  it('setup: a cycle whose population includes adminA (HRA) and a report of adminA (EMP2)', async () => {
    const c = await as(adminA, 'post', `${C}/cycles`).send({ code: 'SD2027', name: '2027 review', organizationId: orgId, effectiveDate: '2027-01-01', currency: 'THB' });
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    cycleId = c.body.data.id;
    for (const e of [E.HEAD, E.MGRX, E.HRB, E.EMP1]) expect(err(await as(adminA, 'post', `${C}/cycles/${cycleId}/exclusions`).send({ employeeId: e, excluded: true }))).toBe('200');
    expect(err(await as(adminA, 'put', `${C}/cycles/${cycleId}/budget`).send({ budgetAmount: '100000.00' }))).toBe('200');
    expect(err(await as(adminA, 'post', `${C}/cycles/${cycleId}/activate`))).toBe('200');
    const rows = await prisma.compensationCycleEmployee.findMany({ where: { cycleId, eligibility: 'ELIGIBLE' }, select: { employeeId: true, plannerUserId: true } });
    expect(rows.find((r) => r.employeeId === E.HRA)!.plannerUserId).toBe(mgrX.user.id);
    expect(rows.find((r) => r.employeeId === E.EMP2)!.plannerUserId).toBe(adminA.user.id);
  });

  it('a planner cannot be (re)assigned to plan their own salary', async () => {
    const row = await prisma.compensationCycleEmployee.findFirstOrThrow({ where: { cycleId, employeeId: E.HRA } });
    // Before Task 51: 200 — adminA became the planner of their own row.
    expect(err(await as(adminA, 'post', `${C}/cycle-employees/${row.id}/planner`).send({ plannerUserId: adminA.user.id, reasonCode: 'OTHER' }))).toBe('409 COMP_PLANNER_SELF_ROW');
    expect((await prisma.compensationCycleEmployee.findUniqueOrThrow({ where: { id: row.id } })).plannerUserId).toBe(mgrX.user.id);
  });

  it('planning and review: own row cannot be overridden or approved by its subject; the author of an amount cannot approve it', async () => {
    const plan = (await as(mgrX, 'get', `${C}/my/cycles/${cycleId}`)).body.data;
    const hraP = plan.rows.find((r: { employee: { code: string } }) => r.employee.code === 'HRA').proposalId;
    expect(err(await as(mgrX, 'patch', `${C}/proposals/${hraP}`).send({ proposedBaseSalary: '52000.00' }))).toBe('200');
    expect(err(await as(mgrX, 'post', `${C}/my/cycles/${cycleId}/submit`))).toBe('200');
    const mine = (await as(adminA, 'get', `${C}/my/cycles/${cycleId}`)).body.data;
    const emp2P = mine.rows.find((r: { employee: { code: string } }) => r.employee.code === 'EMP2').proposalId;
    expect(err(await as(adminA, 'patch', `${C}/proposals/${emp2P}`).send({ proposedBaseSalary: '31000.00' }))).toBe('200');
    expect(err(await as(adminA, 'post', `${C}/my/cycles/${cycleId}/submit`))).toBe('200');
    expect(err(await as(adminA, 'post', `${C}/cycles/${cycleId}/start-review`))).toBe('200');

    // Before Task 51: 200 / 200 — adminA raised their own proposal to 99,999.00 and approved it.
    expect(err(await as(adminA, 'post', `${C}/proposals/${hraP}/override`).send({ proposedBaseSalary: '99999.00', reasonCode: 'OTHER' }))).toBe('403 FINANCIAL_SELF_BENEFIT_NOT_ALLOWED');
    expect(err(await as(adminA, 'post', `${C}/proposals/${hraP}/approve`))).toBe('403 FINANCIAL_SELF_BENEFIT_NOT_ALLOWED');
    expect(err(await as(adminA, 'post', `${C}/proposals/${hraP}/return`).send({ reasonCode: 'OTHER' }))).toBe('403 FINANCIAL_SELF_BENEFIT_NOT_ALLOWED');

    // maker-checker: adminA set EMP2's amount (as planner) and changes it again as HR — and may not approve it
    expect(err(await as(adminA, 'post', `${C}/proposals/${emp2P}/override`).send({ proposedBaseSalary: '31500.00', reasonCode: 'OTHER' }))).toBe('200');
    // Before Task 51: 200 — the same person proposed/overrode and approved the amount.
    expect(err(await as(adminA, 'post', `${C}/proposals/${emp2P}/approve`))).toBe('409 MAKER_CHECKER_CONFLICT');
    // bulk approval skips what this reviewer may not approve, and says so
    expect((await as(adminA, 'post', `${C}/cycles/${cycleId}/approve`).send({})).body.data).toEqual({ approved: 0, skipped: 2 });
    // an independent reviewer approves both
    expect(err(await as(adminB, 'post', `${C}/proposals/${hraP}/approve`))).toBe('200');
    expect(err(await as(adminB, 'post', `${C}/proposals/${emp2P}/approve`))).toBe('200');
    expect(err(await as(adminA, 'post', `${C}/cycles/${cycleId}/finalize`))).toBe('200');
  });

  it('Apply: a cycle carrying the applier\'s own raise is applied by somebody else — nothing is written otherwise', async () => {
    const before = await prisma.employeeCompensation.count();
    // Before Task 51: 200 — adminA applied the cycle that raises their own salary.
    expect(err(await as(adminA, 'post', `${C}/cycles/${cycleId}/apply`))).toBe('403 FINANCIAL_SELF_BENEFIT_NOT_ALLOWED');
    expect(await prisma.employeeCompensation.count()).toBe(before);
    expect(err(await as(adminB, 'post', `${C}/cycles/${cycleId}/apply`))).toBe('200');
    expect((await compOf(E.HRA!)).at(-1)).toMatchObject({ effectiveFrom: '2027-01-01' });
    expect((await compOf(E.HRA!)).at(-1)!.baseSalary.toFixed(2)).toBe('52000.00');
  });
});

describe('employee relations: the subject never handles their own case', () => {
  let caseId: string;
  it('a case about adminA: hidden from adminA, and adminA cannot open one about themselves', async () => {
    expect(err(await as(adminB, 'put', '/api/v1/employee-relations/policies').send({ organizationId: orgId, name: 'Standard', workflowDefinitionCode: 'ER_STD', defaultAcknowledgementDueDays: 7, effectiveFrom: '2020-01-01' }))).toMatch(/^20[01]$/);
    const c = await as(adminB, 'post', '/api/v1/employee-relations/cases').send({ employeeId: E.HRA, incidentDate: '2026-05-10', title: 'Expense irregularity', description: 'Details.' });
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    caseId = c.body.data.id;
    // Before Task 51: 200 — the subject read (and could edit) the case about themselves.
    expect(err(await as(adminA, 'get', `/api/v1/employee-relations/cases/${caseId}`))).toBe('404 ER_CASE_NOT_FOUND');
    expect(err(await as(adminA, 'patch', `/api/v1/employee-relations/cases/${caseId}`).send({ title: 'Nothing to see' }))).toBe('404 ER_CASE_NOT_FOUND');
    expect((await as(adminA, 'get', '/api/v1/employee-relations/cases')).body.data.map((x: { id: string }) => x.id)).not.toContain(caseId);
    expect(err(await as(adminA, 'get', `/api/v1/employee-relations/summary/${E.HRA}`))).toBe('404 ER_CASE_NOT_FOUND');
    expect(err(await as(adminA, 'post', '/api/v1/employee-relations/cases').send({ employeeId: E.HRA, incidentDate: '2026-05-10', title: 'Self', description: 'x' }))).toBe('403 ER_SUBJECT_NOT_ALLOWED');
    // another employee's case: normal
    expect(err(await as(adminA, 'post', '/api/v1/employee-relations/cases').send({ employeeId: E.EMP1, incidentDate: '2026-05-10', title: 'Late', description: 'x' }))).toBe('201');
  });

  it('the subject cannot decide a disciplinary action about themselves, even as the configured approver', async () => {
    const type = await as(adminB, 'post', '/api/v1/employee-relations/action-types').send({ code: 'SDVERBAL', name: 'Verbal', severityOrder: 1, requiresWarningLetter: false, requiresAcknowledgement: false });
    const a = await as(adminB, 'post', `/api/v1/employee-relations/cases/${caseId}/actions`).send({ actionTypeId: type.body.data.id, reason: 'Recorded.' });
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    const actionId = a.body.data.actions[0].id;
    expect(err(await as(adminB, 'post', `/api/v1/employee-relations/actions/${actionId}/submit`))).toBe('200');
    const inst = (await prisma.disciplinaryAction.findUniqueOrThrow({ where: { id: actionId } })).workflowInstanceId!;
    // Before Task 51: 200 — adminA (the subject, and the configured approver) decided their own action.
    expect(err(await as(adminA, 'post', `/api/v1/workflow/instances/${inst}/actions`).send({ action: 'REJECT', comment: 'no' }))).toBe('409 ER_SUBJECT_CANNOT_DECIDE');
    expect((await prisma.disciplinaryAction.findUniqueOrThrow({ where: { id: actionId } })).status).toBe('PENDING_APPROVAL');
  });
});

describe('employee services: a fulfiller never fulfils their own request or issues their own letter', () => {
  it('own request: refused; an independent fulfiller completes it', async () => {
    const t = await as(adminB, 'post', '/api/v1/employee-services/request-types').send({ code: 'SDGEN', name: 'General question', category: 'GENERAL_HR' });
    expect(t.status, JSON.stringify(t.body)).toBe(201);
    const r = await as(adminA, 'post', '/api/v1/employee-services/requests').send({ requestTypeId: t.body.data.id, subject: 'My question' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const id = r.body.data.id;
    expect(err(await as(adminA, 'post', `/api/v1/employee-services/requests/${id}/submit`))).toBe('200');
    // Before Task 51: 200 — adminA assigned and fulfilled their own request.
    expect(err(await as(adminA, 'post', `/api/v1/employee-services/requests/${id}/assign`).send({ assignedToUserId: adminA.user.id }))).toBe('403 SERVICE_SELF_FULFILMENT_NOT_ALLOWED');
    expect(err(await as(adminA, 'post', `/api/v1/employee-services/requests/${id}/fulfill`).send({ resultNote: 'done' }))).toBe('403 SERVICE_SELF_FULFILMENT_NOT_ALLOWED');
    expect(err(await as(adminA, 'post', `/api/v1/employee-services/requests/${id}/reject`).send({ reasonCode: 'OTHER' }))).toMatch(/^4\d\d /);
    // assigning another fulfiller TO adminA's own request is fine; assigning adminA to it by someone else is not
    expect(err(await as(adminB, 'post', `/api/v1/employee-services/requests/${id}/assign`).send({ assignedToUserId: adminA.user.id }))).toBe('409 SERVICE_SELF_ASSIGNMENT_NOT_ALLOWED');
    expect(err(await as(adminB, 'post', `/api/v1/employee-services/requests/${id}/fulfill`).send({ resultNote: 'answered' }))).toBe('200');
  });

  it('own HR letter: refused; another employee\'s letter: issued', async () => {
    const tpl = await as(adminB, 'post', '/api/v1/employee-services/letter-templates').send({ code: 'SDEMP', name: 'Employment', letterType: 'GENERAL', bodyTemplate: 'This letter confirms current employment.' });
    expect(tpl.status, JSON.stringify(tpl.body)).toBe(201);
    // Before Task 51: 201 — adminA issued a letter about themselves.
    expect(err(await as(adminA, 'post', '/api/v1/employee-services/letters').send({ employeeId: E.HRA, templateId: tpl.body.data.id }))).toBe('403 HR_LETTER_SELF_ISSUE_NOT_ALLOWED');
    expect(await prisma.hrLetter.count({ where: { employeeId: E.HRA } })).toBe(0);
    expect(err(await as(adminA, 'post', '/api/v1/employee-services/letters').send({ employeeId: E.EMP1, templateId: tpl.body.data.id }))).toBe('201');
  });
});
