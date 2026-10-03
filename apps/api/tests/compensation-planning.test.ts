/**
 * Task 43 — compensation planning / salary review.
 *
 * A high-impact domain, so the tests guard what the system must NOT do as much as what it does: no recommended
 * salary or percentage (even beside a strong performance record), no view outside a planner's assigned rows, no
 * salary change at finalization, no Apply without payroll authority, no Apply over a changed salary record or a
 * departed employee, no duplicates under concurrent Apply, no salary figures in notifications, audit or the
 * executive report — and exact Decimal budget arithmetic.
 */
import type { Server } from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma';
import { compensationService } from '../src/modules/payroll/payroll-master.service';
import { createTestServer, createUser, loginAs, resetDatabase } from './helpers';

const app: Server = createTestServer();
const PW = 'Correct-Horse-1';
const C = '/api/v1/compensation-planning';
type Session = { cookie: string; csrf: string; user: { id: string } };
const as = (s: Session, m: 'get' | 'post' | 'patch' | 'put', url: string) => request(app)[m](url).set('Cookie', s.cookie).set('x-csrf-token', s.csrf);
const err = (r: request.Response) => `${r.status} ${r.body?.error?.code ?? ''}`.trim();
const text = (v: unknown) => JSON.stringify(v);
const COMMENT = 'SECRET-COMMENT-A1 strong delivery';

let hrAdmin: Session, hr: Session, mgrA: Session, mgrB: Session, exec: Session, sysAdmin: Session, emp: Session, clerk: Session;
const E: Record<string, string> = {};
const comp: Record<string, string> = {};
let orgId: string, deptEng: string, deptOps: string, cycleId: string;
const rowsOf = async (s: Session, id: string) => (await as(s, 'get', `${C}/my/cycles/${id}`)).body.data;
const proposalOf = (plan: { rows: { employee: { code: string }; proposalId: string }[] }, code: string) => plan.rows.find((r) => r.employee.code === code)!.proposalId;

beforeAll(async () => {
  await resetDatabase();
  const org = await prisma.organization.create({ data: { code: 'C43', name: 'Comp Co', timezone: 'Asia/Bangkok' } });
  orgId = org.id;
  const eng = await prisma.department.create({ data: { organizationId: org.id, code: 'ENG', name: 'Engineering' } });
  const ops = await prisma.department.create({ data: { organizationId: org.id, code: 'OPS', name: 'Operations' } });
  deptEng = eng.id; deptOps = ops.id;
  const job = await prisma.job.create({ data: { code: 'ENG43', title: 'Engineer', level: 2 } });
  const posE = await prisma.position.create({ data: { departmentId: eng.id, code: 'E43', title: 'Engineer', jobId: job.id } });
  const posO = await prisma.position.create({ data: { departmentId: ops.id, code: 'O43', title: 'Operator', jobId: job.id } });
  const mk = async (code: string, dept: string, pos: string, managerId: string | null) =>
    (await prisma.employee.create({ data: { employeeCode: code, firstName: code, lastName: 'Person', email: `${code.toLowerCase()}@c43.local`, hireDate: new Date('2020-01-01T00:00:00Z'), organizationId: org.id, departmentId: dept, positionId: pos, managerId, employmentType: 'FULL_TIME', employmentStatus: 'ACTIVE' } })).id;
  E.HEAD = await mk('HEAD', eng.id, posE.id, null);
  E.MGRA = await mk('MGRA', eng.id, posE.id, E.HEAD);
  E.MGRB = await mk('MGRB', ops.id, posO.id, E.HEAD);
  E.EMP001 = await mk('EMP001', eng.id, posE.id, E.MGRA);
  E.EMP002 = await mk('EMP002', eng.id, posE.id, E.MGRA);
  E.B1 = await mk('B1', ops.id, posO.id, E.MGRB);
  E.NOCOMP = await mk('NOCOMP', ops.id, posO.id, E.MGRB);
  E.USD = await mk('USDPAID', ops.id, posO.id, E.MGRB);
  E.HRA = await mk('HRA', ops.id, posO.id, null);
  await createUser({ email: 'hradmin@c43.local', password: PW, role: 'HR_ADMIN', employeeId: E.HRA });
  const hrUser = await createUser({ email: 'hr@c43.local', password: PW, role: 'HR' });
  await createUser({ email: 'mgra@c43.local', password: PW, role: 'MANAGER', employeeId: E.MGRA });
  await createUser({ email: 'mgrb@c43.local', password: PW, role: 'MANAGER', employeeId: E.MGRB });
  await createUser({ email: 'exec@c43.local', password: PW, role: 'EXECUTIVE' });
  await createUser({ email: 'sysadmin@c43.local', password: PW, role: 'SYSTEM_ADMIN' });
  await createUser({ email: 'emp@c43.local', password: PW, role: 'EMPLOYEE', employeeId: E.EMP001 });
  // A compensation clerk who may apply and review but lacks the payroll authority over salaries.
  const role = await prisma.role.create({ data: { code: 'COMP_CLERK', name: 'Comp clerk', isSystem: false, dataScope: 'ALL' } });
  for (const code of ['compensation_planning.apply', 'compensation_planning.review']) await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: (await prisma.permission.findUniqueOrThrow({ where: { code } })).id } });
  await createUser({ email: 'clerk@c43.local', password: PW, role: 'COMP_CLERK' });
  [hrAdmin, hr, mgrA, mgrB, exec, sysAdmin, emp, clerk] = await Promise.all(['hradmin', 'hr', 'mgra', 'mgrb', 'exec', 'sysadmin', 'emp', 'clerk'].map((u) => loginAs(app, `${u}@c43.local`, PW)));
  void hrUser;
  const salary = async (emp: string, amount: string, currency = 'THB') => (await prisma.employeeCompensation.create({ data: { employeeId: emp, effectiveFrom: '2025-01-01', baseSalary: amount, currencyCode: currency, createdByUserId: hrAdmin.user.id } })).id;
  comp.EMP001 = await salary(E.EMP001, '30000.00');
  comp.EMP002 = await salary(E.EMP002, '40000.00');
  comp.B1 = await salary(E.B1, '35000.00');
  comp.MGRA = await salary(E.MGRA, '60000.00');
  comp.MGRB = await salary(E.MGRB, '60000.00');
  comp.USD = await salary(E.USD, '2000.00', 'USD');
  // Performance: a finalized strong result for EMP001, only a draft for EMP002.
  const pc = await prisma.performanceCycle.create({ data: { code: 'P43', name: 'Performance 2026', organizationId: org.id, periodStart: '2026-01-01', periodEnd: '2026-12-31', status: 'CLOSED', ratingBands: { create: [{ code: 'MEETS', label: 'Meets', minScore: 1, maxScore: 3.79 }, { code: 'EXCEEDS', label: 'Exceeds', minScore: 3.8, maxScore: 5 }] } } });
  await prisma.performancePlan.create({ data: { cycleId: pc.id, employeeId: E.EMP001, employeeCodeSnapshot: 'EMP001', employeeNameSnapshot: 'EMP001 Person', departmentId: eng.id, departmentName: 'Engineering', status: 'FINALIZED', finalizedAt: new Date('2026-06-30T00:00:00Z'), weightedScore: 4.5, ratingCode: 'EXCEEDS', ratingLabelSnapshot: 'Exceeds', reviewerEmployeeId: E.MGRA, reviewerNameSnapshot: 'MGRA Person', reviewerUserId: mgrA.user.id } });
  await prisma.performancePlan.create({ data: { cycleId: pc.id, employeeId: E.EMP002, employeeCodeSnapshot: 'EMP002', employeeNameSnapshot: 'EMP002 Person', departmentId: eng.id, departmentName: 'Engineering', status: 'MANAGER_REVIEW', weightedScore: 2.1, reviewerEmployeeId: E.MGRA, reviewerNameSnapshot: 'MGRA Person', reviewerUserId: mgrA.user.id } });
}, 180000);
afterAll(async () => { await resetDatabase(); await prisma.$disconnect(); });

describe('access', () => {
  it('HR administration needs a compensation permission and an organization-wide scope; nobody else gets in by role alone', async () => {
    for (const s of [exec, mgrA, emp]) expect(err(await as(s, 'get', `${C}/cycles`))).toBe('403 FORBIDDEN');
    expect(err(await as(emp, 'get', `${C}/my/cycles`))).toBe('403 FORBIDDEN');
    expect(err(await as(hrAdmin, 'get', `${C}/cycles`))).toBe('200');
    // Separation of duties: administering RBAC is not salary authority. SYSTEM_ADMIN holds no compensation permission.
    expect((sysAdmin.user as unknown as { permissions: string[] }).permissions.filter((p: string) => p.startsWith('compensation_planning.'))).toEqual([]);
    for (const url of ['/cycles', '/my/cycles', '/reports/cycles', '/options']) expect(err(await as(sysAdmin, 'get', `${C}${url}`))).toBe('403 FORBIDDEN');
    expect(err(await as(sysAdmin, 'post', `${C}/cycles`).send({ code: 'SYS1', name: 'x', organizationId: orgId, effectiveDate: '2027-01-01', currency: 'THB' }))).toBe('403 FORBIDDEN');
  });

  it('SYSTEM_ADMIN still grants MANAGER / HR / HR_ADMIN / EXECUTIVE through RBAC administration, without gaining their permissions', async () => {
    const target = await createUser({ email: 'grantee@c43.local', password: PW, role: 'EMPLOYEE' });
    for (const role of ['MANAGER', 'HR', 'HR_ADMIN', 'EXECUTIVE']) {
      const r = await as(sysAdmin, 'patch', `/api/v1/users/${target.id}/roles`).send({ roleCodes: [role] });
      expect(`${role} ${err(r)}`).toBe(`${role} 200`);
    }
    expect(err(await as(sysAdmin, 'patch', `/api/v1/users/${target.id}/roles`).send({ roleCodes: ['MANAGER', 'HR_ADMIN'] }))).toBe('200');
    const grantee = await loginAs(app, 'grantee@c43.local', PW);
    expect((grantee.user as unknown as { permissions: string[] }).permissions).toEqual(expect.arrayContaining(['compensation_planning.apply', 'compensation_planning.plan']));
    const me = await as(sysAdmin, 'get', '/api/v1/auth/me');
    expect(JSON.stringify(me.body)).not.toContain('compensation_planning.');
    await prisma.user.update({ where: { id: target.id }, data: { isActive: false } });
  });
});

describe('cycle, population and activation', () => {
  it('creates a cycle and previews the population from facts only', async () => {
    const r = await as(hrAdmin, 'post', `${C}/cycles`).send({ code: 'SR2027', name: '2027 Salary Review', organizationId: orgId, effectiveDate: '2027-01-01', currency: 'THB' });
    expect(err(r)).toBe('201'); cycleId = r.body.data.id;
    expect(r.body.data).toMatchObject({ status: 'DRAFT', currency: 'THB', effectiveDate: '2027-01-01', population: null });
    const p = (await as(hrAdmin, 'get', `${C}/cycles/${cycleId}/population?pageSize=50`)).body.data;
    const by = (code: string) => p.rows.find((x: { code: string }) => x.code === code);
    expect(by('EMP001')).toMatchObject({ eligibility: 'ELIGIBLE', currentBaseSalary: '30000.00', currency: 'THB' });
    expect(by('NOCOMP')).toMatchObject({ eligibility: 'MISSING_COMPENSATION', currentBaseSalary: null });
    expect(by('USDPAID')).toMatchObject({ eligibility: 'CURRENCY_MISMATCH', currency: 'USD' });
    expect(p.counts).toMatchObject({ candidates: 9, excluded: 0 });
  });

  it('HR excludes people explicitly before activation', async () => {
    for (const e of [E.MGRA, E.MGRB, E.HEAD, E.HRA]) expect(err(await as(hrAdmin, 'post', `${C}/cycles/${cycleId}/exclusions`).send({ employeeId: e, excluded: true }))).toBe('200');
    const p = (await as(hrAdmin, 'get', `${C}/cycles/${cycleId}/population`)).body.data;
    expect(p.counts).toMatchObject({ candidates: 9, excluded: 4, eligible: 3, missingCompensation: 1, currencyMismatch: 1 });
    expect(err(await as(hrAdmin, 'put', `${C}/cycles/${cycleId}/budget`).send({ budgetAmount: '100000.00' }))).toBe('200');
  });

  it('activates once under concurrency: frozen population, planners from the manager snapshot, no duplicates', async () => {
    const [a, b] = await Promise.all([as(hrAdmin, 'post', `${C}/cycles/${cycleId}/activate`), as(hrAdmin, 'post', `${C}/cycles/${cycleId}/activate`)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(await prisma.compensationCycleEmployee.count({ where: { cycleId } })).toBe(5);
    expect(await prisma.compensationProposal.count({ where: { cycleId } })).toBe(3);
    const c = (await as(hrAdmin, 'get', `${C}/cycles/${cycleId}`)).body.data;
    expect(c).toMatchObject({ status: 'ACTIVE', population: { total: 5, eligible: 3, missingCompensation: 1, currencyMismatch: 1 }, budget: { amount: '100000.00', used: '0.00', remaining: '100000.00' } });
    const row = await prisma.compensationCycleEmployee.findFirstOrThrow({ where: { cycleId, employeeId: E.EMP001 } });
    expect(row).toMatchObject({ plannerUserId: mgrA.user.id, sourceCompensationId: comp.EMP001, departmentNameSnapshot: 'Engineering', jobTitleSnapshot: 'Engineer' });
    expect(row.currentBaseSalarySnapshot!.toFixed(2)).toBe('30000.00');
  });

  it('no automatic pay: before anyone enters a number every proposal is NOT_STARTED with no value — even beside a strong performance result', async () => {
    const plan = await rowsOf(mgrA, cycleId);
    for (const r of plan.rows) expect(r).toMatchObject({ status: 'NOT_STARTED', proposedBaseSalary: null, increaseAmount: null, increasePercent: null });
    // Performance context is the finalized fact only; a draft review shows nothing.
    expect(plan.rows.find((r: { employee: { code: string } }) => r.employee.code === 'EMP001').performance).toMatchObject({ score: '4.50', rating: 'Exceeds', cycleName: 'Performance 2026' });
    expect(plan.rows.find((r: { employee: { code: string } }) => r.employee.code === 'EMP002').performance).toBeNull();
    expect(text(plan)).not.toMatch(/recommend|suggest|merit|rank/i);
  });
});

describe('planning', () => {
  it('a manager sees only the rows assigned to them', async () => {
    const a = await rowsOf(mgrA, cycleId);
    expect(a.rows.map((r: { employee: { code: string } }) => r.employee.code).sort()).toEqual(['EMP001', 'EMP002']);
    const b = await rowsOf(mgrB, cycleId);
    expect(b.rows.map((r: { employee: { code: string } }) => r.employee.code)).toEqual(['B1']);
    expect(text(a)).not.toMatch(/B1|35000/);
    const b1 = proposalOf(b, 'B1');
    expect(err(await as(mgrA, 'patch', `${C}/proposals/${b1}`).send({ proposedBaseSalary: '99999' }))).toBe('404 COMPENSATION_PROPOSAL_NOT_FOUND');
    expect(err(await as(mgrA, 'get', `${C}/proposals/${b1}/history`))).toBe('404 COMPENSATION_PROPOSAL_NOT_FOUND');
    expect(err(await as(mgrA, 'get', `${C}/cycles/${cycleId}/employees`))).toBe('403 FORBIDDEN');
    expect(err(await as(mgrA, 'get', `${C}/cycles/${cycleId}`))).toBe('403 FORBIDDEN');
  });

  it('proposals: no decrease; increase and percent derived in Decimal; budget used and remaining exact', async () => {
    const plan = await rowsOf(mgrA, cycleId);
    const p1 = proposalOf(plan, 'EMP001'); const p2 = proposalOf(plan, 'EMP002');
    expect(err(await as(mgrA, 'patch', `${C}/proposals/${p1}`).send({ proposedBaseSalary: '29999.99' }))).toBe('422 COMP_DECREASE_NOT_ALLOWED');
    expect(err(await as(mgrA, 'patch', `${C}/proposals/${p1}`).send({ proposedBaseSalary: 31500 }))).toBe('400 VALIDATION_ERROR'); // money is a string
    const r1 = await as(mgrA, 'patch', `${C}/proposals/${p1}`).send({ proposedBaseSalary: '31500.00', managerComment: COMMENT });
    expect(r1.body.data).toMatchObject({ status: 'DRAFT', proposedBaseSalary: '31500.00', increaseAmount: '1500.00', increasePercent: '5.00' });
    const r2 = await as(mgrA, 'patch', `${C}/proposals/${p2}`).send({ proposedBaseSalary: '42000.00' });
    expect(r2.body.data).toMatchObject({ increaseAmount: '2000.00', increasePercent: '5.00' });
    const c = (await as(hrAdmin, 'get', `${C}/cycles/${cycleId}`)).body.data;
    expect(c.budget).toMatchObject({ used: '3500.00', remaining: '96500.00', overBudget: false });
    const mine = await rowsOf(mgrA, cycleId);
    expect(mine.totals).toMatchObject({ currentBase: '70000.00', increase: '3500.00', proposedBase: '73500.00', rows: 2, addressed: 2 });
  });

  it('submit needs every assigned row addressed; zero increase is a valid answer; submitted rows are locked', async () => {
    expect(err(await as(mgrB, 'post', `${C}/my/cycles/${cycleId}/submit`))).toBe('409 COMP_PLAN_INCOMPLETE');
    const b1 = proposalOf(await rowsOf(mgrB, cycleId), 'B1');
    expect((await as(mgrB, 'patch', `${C}/proposals/${b1}`).send({ proposedBaseSalary: '35000.00' })).body.data).toMatchObject({ increaseAmount: '0.00', increasePercent: '0.00' });
    expect(err(await as(mgrB, 'post', `${C}/my/cycles/${cycleId}/submit`))).toBe('200');
    expect(err(await as(mgrA, 'post', `${C}/my/cycles/${cycleId}/submit`))).toBe('200');
    const p1 = proposalOf(await rowsOf(mgrA, cycleId), 'EMP001');
    expect(err(await as(mgrA, 'patch', `${C}/proposals/${p1}`).send({ proposedBaseSalary: '33000.00' }))).toBe('409 COMP_PROPOSAL_LOCKED');
  });

  it('keeps the activation snapshot when the employee master changes', async () => {
    await prisma.employee.update({ where: { id: E.EMP001 }, data: { departmentId: deptOps, managerId: E.MGRB } });
    const row = (await as(hrAdmin, 'get', `${C}/cycles/${cycleId}/employees?search=EMP001`)).body.data[0];
    expect(row).toMatchObject({ department: 'Engineering', managerName: 'MGRA Person', planner: { userId: mgrA.user.id } });
    await prisma.employee.update({ where: { id: E.EMP001 }, data: { departmentId: deptEng, managerId: E.MGRA } });
  });
});

describe('HR review and finalization', () => {
  it('review: override with a reason (history keeps old and new), return to the planner, resubmit, approve', async () => {
    expect(err(await as(hr, 'post', `${C}/cycles/${cycleId}/start-review`))).toBe('200');
    const grid = (await as(hr, 'get', `${C}/cycles/${cycleId}/employees?eligibility=ELIGIBLE`)).body.data;
    expect(grid.every((r: { status: string }) => r.status === 'HR_REVIEW')).toBe(true);
    expect(grid.find((r: { employee: { code: string } }) => r.employee.code === 'EMP001').managerComment).toBe(COMMENT);
    const p2 = grid.find((r: { employee: { code: string } }) => r.employee.code === 'EMP002').proposalId;
    const p1 = grid.find((r: { employee: { code: string } }) => r.employee.code === 'EMP001').proposalId;
    expect(err(await as(hr, 'post', `${C}/proposals/${p2}/override`).send({ proposedBaseSalary: '41000.00' }))).toBe('400 VALIDATION_ERROR');
    const o = await as(hr, 'post', `${C}/proposals/${p2}/override`).send({ proposedBaseSalary: '41000.00', reasonCode: 'BUDGET_ALIGNMENT' });
    expect(o.body.data).toMatchObject({ proposedBaseSalary: '41000.00', increaseAmount: '1000.00', increasePercent: '2.50' });
    const h = (await as(hr, 'get', `${C}/proposals/${p2}/history`)).body.data;
    expect(h.at(-1)).toMatchObject({ action: 'OVERRIDDEN', oldProposedBaseSalary: '42000.00', newProposedBaseSalary: '41000.00', reasonCode: 'BUDGET_ALIGNMENT' });
    expect(err(await as(hr, 'post', `${C}/proposals/${p1}/return`).send({ reasonCode: 'NEEDS_JUSTIFICATION' }))).toBe('200');
    expect(err(await as(mgrA, 'patch', `${C}/proposals/${p1}`).send({ proposedBaseSalary: '31500.00', managerComment: COMMENT }))).toBe('200');
    expect(err(await as(mgrA, 'post', `${C}/my/cycles/${cycleId}/submit`))).toBe('200');
    expect(err(await as(hradmin(), 'post', `${C}/cycles/${cycleId}/finalize`))).toBe('409 COMP_PROPOSALS_NOT_APPROVED');
    // Task 51 (T44-P1-19) — BEFORE: { approved: 3 } — `hr` approved p2 although `hr` had just set its amount by override.
    // AFTER: maker ≠ checker — the bulk approval leaves p2 for another reviewer (counted), and hradmin approves it.
    expect((await as(hr, 'post', `${C}/cycles/${cycleId}/approve`).send({})).body.data).toEqual({ approved: 2, skipped: 1 });
    expect(err(await as(hr, 'post', `${C}/proposals/${p2}/approve`))).toBe('409 MAKER_CHECKER_CONFLICT');
    expect(err(await as(hradmin(), 'post', `${C}/proposals/${p2}/approve`))).toBe('200');
  });

  it('finalize freezes the plan and changes no salary', async () => {
    const before = text(await prisma.employeeCompensation.findMany({ orderBy: { id: 'asc' } }));
    expect(err(await as(hr, 'post', `${C}/cycles/${cycleId}/finalize`))).toBe('403 FORBIDDEN'); // HR role cannot finalize
    expect(err(await as(hrAdmin, 'post', `${C}/cycles/${cycleId}/finalize`))).toBe('200');
    expect(text(await prisma.employeeCompensation.findMany({ orderBy: { id: 'asc' } }))).toBe(before);
    const p2 = (await as(hr, 'get', `${C}/cycles/${cycleId}/employees?search=EMP002`)).body.data[0].proposalId;
    expect(err(await as(hr, 'post', `${C}/proposals/${p2}/override`).send({ proposedBaseSalary: '50000.00', reasonCode: 'OTHER' }))).toBe('409 COMP_CYCLE_INVALID_STATE');
    expect(err(await as(mgrA, 'patch', `${C}/proposals/${p2}`).send({ proposedBaseSalary: '50000.00' }))).toBe('409 COMP_PROPOSAL_LOCKED');
  });
});

describe('apply', () => {
  it('needs compensation_planning.apply AND payroll.manage', async () => {
    expect(err(await as(hr, 'post', `${C}/cycles/${cycleId}/apply`))).toBe('403 FORBIDDEN');
    expect(err(await as(clerk, 'post', `${C}/cycles/${cycleId}/apply`))).toBe('403 FORBIDDEN');
    const before = await prisma.employeeCompensation.count();
    for (const url of ['apply', 'finalize', 'apply-preview']) expect(err(await as(sysAdmin, url === 'apply-preview' ? 'get' : 'post', `${C}/cycles/${cycleId}/${url}`))).toBe('403 FORBIDDEN');
    expect(await prisma.employeeCompensation.count()).toBe(before);
    expect((await as(hrAdmin, 'get', `${C}/cycles/${cycleId}/apply-preview`)).body.data).toEqual({ toApply: 2, noChange: 1, alreadyApplied: false, blockers: [] });
  });

  it('a salary changed at the source since activation blocks the whole cycle — nothing is written', async () => {
    await prisma.employeeCompensation.update({ where: { id: comp.EMP001 }, data: { effectiveTo: '2026-10-31' } });
    const manual = await prisma.employeeCompensation.create({ data: { employeeId: E.EMP001, effectiveFrom: '2026-11-01', baseSalary: '32000.00', currencyCode: 'THB', createdByUserId: hrAdmin.user.id } });
    const before = await prisma.employeeCompensation.count();
    const r = await as(hrAdmin, 'post', `${C}/cycles/${cycleId}/apply`);
    expect(err(r)).toBe('409 COMP_APPLY_BLOCKED');
    expect(r.body.error.details).toEqual([{ field: 'EMP001', message: 'SOURCE_COMPENSATION_CHANGED' }]);
    expect(await prisma.employeeCompensation.count()).toBe(before);
    expect((await prisma.employeeCompensation.findUniqueOrThrow({ where: { id: manual.id } })).baseSalary.toFixed(2)).toBe('32000.00'); // not reduced to 31,500
    await prisma.employeeCompensation.delete({ where: { id: manual.id } });
    await prisma.employeeCompensation.update({ where: { id: comp.EMP001 }, data: { effectiveTo: null } });
  });

  it('an employee who left before Apply is a blocker, never a silent future salary', async () => {
    await prisma.employee.update({ where: { id: E.EMP002 }, data: { employmentStatus: 'TERMINATED' } });
    expect((await as(hrAdmin, 'get', `${C}/cycles/${cycleId}/apply-preview`)).body.data.blockers).toEqual([{ employeeCode: 'EMP002', employeeName: 'EMP002 Person', reason: 'EMPLOYEE_NOT_ACTIVE' }]);
    expect(err(await as(hrAdmin, 'post', `${C}/cycles/${cycleId}/apply`))).toBe('409 COMP_APPLY_BLOCKED');
    expect(await prisma.employeeCompensation.count({ where: { employeeId: E.EMP002, effectiveFrom: '2027-01-01' } })).toBe(0);
    await prisma.employee.update({ where: { id: E.EMP002 }, data: { employmentStatus: 'ACTIVE' } });
  });

  it('applies once under concurrency: one new record per changed employee from the effective date, history preserved', async () => {
    const [a, b] = await Promise.all([as(hrAdmin, 'post', `${C}/cycles/${cycleId}/apply`), as(hrAdmin, 'post', `${C}/cycles/${cycleId}/apply`)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect([a, b].find((x) => x.status === 200)!.body.data).toMatchObject({ applied: 2, noChange: 1 });
    expect([a, b].find((x) => x.status === 409)!.body.error.code).toBe('COMP_CYCLE_ALREADY_APPLIED');
    const hist = async (e: string) => (await prisma.employeeCompensation.findMany({ where: { employeeId: e }, orderBy: { effectiveFrom: 'asc' } })).map((c) => [c.effectiveFrom, c.effectiveTo, c.baseSalary.toFixed(2)]);
    expect(await hist(E.EMP001)).toEqual([['2025-01-01', '2026-12-31', '30000.00'], ['2027-01-01', null, '31500.00']]);
    expect(await hist(E.EMP002)).toEqual([['2025-01-01', '2026-12-31', '40000.00'], ['2027-01-01', null, '41000.00']]);
    expect(await hist(E.B1)).toEqual([['2025-01-01', null, '35000.00']]); // zero increase: no new record
    // Payroll resolves the new salary through its own source function for a 2027 period.
    const jan = await compensationService.forPeriod(prisma, E.EMP001, '2027-01-01', '2027-01-31');
    expect(jan.map((c) => c.baseSalary.toFixed(2))).toEqual(['31500.00']);
    const p = await prisma.compensationProposal.findFirstOrThrow({ where: { cycleId, cycleEmployee: { employeeId: E.EMP001 } } });
    expect(p.appliedCompensationId).toBeTruthy();
    expect(err(await as(hrAdmin, 'post', `${C}/cycles/${cycleId}/apply`))).toBe('409 COMP_CYCLE_ALREADY_APPLIED');
  });
});

describe('confidentiality', () => {
  it('executive and HR reports are aggregate; only compensation HR gets the department split', async () => {
    const x = await as(exec, 'get', `${C}/reports/cycles/${cycleId}`);
    expect(err(x)).toBe('200');
    expect(x.body.data).toMatchObject({ population: { total: 5, eligible: 3 }, totals: { currentBase: '105000.00', increase: '2500.00', proposedBase: '107500.00', approvedIncrease: '2500.00' }, averageIncreasePercent: '2.38', byDepartment: null, budget: { used: '2500.00', remaining: '97500.00' } });
    const walk = (v: unknown, hits: string[] = [], path = '$'): string[] => {
      if (Array.isArray(v)) v.forEach((y, i) => walk(y, hits, `${path}[${i}]`));
      else if (v && typeof v === 'object') for (const [k, y] of Object.entries(v)) { if (/^(employeeId|employeeCode|employeeName|email|currentBaseSalary|proposedBaseSalary|managerComment|proposalId|increaseAmount)$/.test(k)) hits.push(`${path}.${k}`); walk(y, hits, `${path}.${k}`); }
      return hits;
    };
    expect(walk(x.body.data)).toEqual([]);
    expect(text(x.body.data)).not.toMatch(/EMP00|31500|41000|SECRET-COMMENT/);
    const h = (await as(hr, 'get', `${C}/reports/cycles/${cycleId}`)).body.data;
    expect(h.byDepartment).toEqual(expect.arrayContaining([{ department: 'Engineering', rows: 2, addressed: 2, currentBase: '70000.00', proposedBase: '72500.00', increase: '2500.00' }]));
    expect(err(await as(mgrA, 'get', `${C}/reports/cycles/${cycleId}`))).toBe('403 FORBIDDEN');
  });

  it('Report Center: aggregate dataset for report readers; a manager cannot see it', async () => {
    const run = (s: Session) => as(s, 'post', '/api/v1/reports/run').send({ datasetId: 'compensation_planning_summary', definition: { columns: ['cycle', 'currency', 'increase', 'budget'], filters: [], sort: [], groupBy: [], aggregations: [], pageSize: 50 }, page: 1 });
    const r = await run(exec);
    expect(err(r)).toBe('200');
    expect(r.body.data.rows).toEqual([{ cycle: '2027 Salary Review', currency: 'THB', increase: '2500.00', budget: '100000.00' }]);
    expect(err(await run(mgrA))).toBe('404 REPORT_DATASET_NOT_FOUND');
  });

  it('notifications, audit and the privacy export carry no salary, increase or comment', async () => {
    const notes = await prisma.notification.findMany({ where: { type: { startsWith: 'COMP_PLAN_' } } });
    expect(notes.length).toBeGreaterThan(0);
    expect(text(notes)).not.toMatch(/30000|31500|40000|41000|42000|1500\.00|5\.00|SECRET-COMMENT/);
    const audit = await prisma.auditLog.findMany({ where: { module: 'compensation_planning' } });
    expect(audit.length).toBeGreaterThan(10);
    expect(text(audit)).not.toMatch(/31500|41000|42000|SECRET-COMMENT/);
    const x = await as(hrAdmin, 'post', `/api/v1/privacy/employees/${E.EMP001}/export`);
    expect(x.status).toBe(200);
    expect(x.text).not.toMatch(/SECRET-COMMENT|compensationProposal/);
    expect(x.text).toMatch(/salary-review planning records/);
  });

  it('reassigning a planner is explicit, recorded, and moves visibility with it', async () => {
    const c2 = (await as(hrAdmin, 'post', `${C}/cycles`).send({ code: 'SR2027B', name: 'Second review', organizationId: orgId, effectiveDate: '2027-04-01', currency: 'THB' })).body.data.id;
    for (const e of [E.MGRA, E.MGRB, E.HEAD, E.HRA]) await as(hrAdmin, 'post', `${C}/cycles/${c2}/exclusions`).send({ employeeId: e, excluded: true });
    expect(err(await as(hrAdmin, 'post', `${C}/cycles/${c2}/activate`))).toBe('200');
    const row = await prisma.compensationCycleEmployee.findFirstOrThrow({ where: { cycleId: c2, employeeId: E.B1 } });
    expect(err(await as(hrAdmin, 'post', `${C}/cycle-employees/${row.id}/planner`).send({ plannerUserId: exec.user.id, reasonCode: 'WORKLOAD' }))).toBe('422 COMP_PLANNER_NOT_ALLOWED');
    expect(err(await as(hrAdmin, 'post', `${C}/cycle-employees/${row.id}/planner`).send({ plannerUserId: mgrA.user.id, reasonCode: 'MANAGER_CHANGED' }))).toBe('200');
    expect(err(await as(mgrB, 'get', `${C}/my/cycles/${c2}`))).toBe('404 COMPENSATION_CYCLE_NOT_FOUND');
    expect((await rowsOf(mgrA, c2)).rows.map((r: { employee: { code: string } }) => r.employee.code).sort()).toEqual(['B1', 'EMP001', 'EMP002']);
    expect(await prisma.compensationPlannerAssignment.count({ where: { cycleEmployeeId: row.id } })).toBe(1);
  });
});

describe('budget arithmetic', () => {
  it('Σ increase is exact: 333.37 + 666.73 = 1000.10 fits a 1000.10 budget; one satang more is blocked', async () => {
    const org = await prisma.organization.create({ data: { code: 'D43', name: 'Decimal Co', timezone: 'Asia/Bangkok' } });
    const dept = await prisma.department.create({ data: { organizationId: org.id, code: 'D', name: 'Decimal dept' } });
    const pos = await prisma.position.create({ data: { departmentId: dept.id, code: 'D43P', title: 'Clerk' } });
    const boss = await prisma.employee.create({ data: { employeeCode: 'DBOSS', firstName: 'D', lastName: 'Boss', email: 'dboss@c43.local', hireDate: new Date('2020-01-01T00:00:00Z'), organizationId: org.id, departmentId: dept.id, positionId: pos.id, employmentType: 'FULL_TIME', employmentStatus: 'ACTIVE' } });
    await createUser({ email: 'dboss@c43.local', password: PW, role: 'MANAGER', employeeId: boss.id });
    const dboss = await loginAs(app, 'dboss@c43.local', PW);
    for (const code of ['D1', 'D2']) {
      const e = await prisma.employee.create({ data: { employeeCode: code, firstName: code, lastName: 'X', email: `${code.toLowerCase()}@c43.local`, hireDate: new Date('2020-01-01T00:00:00Z'), organizationId: org.id, departmentId: dept.id, positionId: pos.id, managerId: boss.id, employmentType: 'FULL_TIME', employmentStatus: 'ACTIVE' } });
      await prisma.employeeCompensation.create({ data: { employeeId: e.id, effectiveFrom: '2025-01-01', baseSalary: '10000.00', currencyCode: 'THB', createdByUserId: hrAdmin.user.id } });
    }
    const c = (await as(hrAdmin, 'post', `${C}/cycles`).send({ code: 'DEC43', name: 'Decimal review', organizationId: org.id, effectiveDate: '2027-01-01', currency: 'THB' })).body.data.id;
    await as(hrAdmin, 'post', `${C}/cycles/${c}/exclusions`).send({ employeeId: boss.id, excluded: true });
    await as(hrAdmin, 'put', `${C}/cycles/${c}/budget`).send({ budgetAmount: '1000.10' });
    expect(err(await as(hrAdmin, 'post', `${C}/cycles/${c}/activate`))).toBe('200');
    const plan = await rowsOf(dboss, c);
    await as(dboss, 'patch', `${C}/proposals/${proposalOf(plan, 'D1')}`).send({ proposedBaseSalary: '10333.37' });
    await as(dboss, 'patch', `${C}/proposals/${proposalOf(plan, 'D2')}`).send({ proposedBaseSalary: '10666.73' });
    expect((await as(hrAdmin, 'get', `${C}/cycles/${c}`)).body.data.budget).toEqual({ amount: '1000.10', used: '1000.10', remaining: '0.00', overBudget: false });
    const [sql] = await prisma.$queryRaw<{ used: string }[]>`SELECT sum("increase_amount")::text AS used FROM "compensation_proposals" WHERE "cycle_id" = ${c}`;
    expect(sql.used).toBe('1000.10');
    await as(dboss, 'patch', `${C}/proposals/${proposalOf(plan, 'D2')}`).send({ proposedBaseSalary: '10666.74' });
    expect((await as(hrAdmin, 'get', `${C}/cycles/${c}`)).body.data.budget).toMatchObject({ used: '1000.11', remaining: '-0.01', overBudget: true });
    expect(err(await as(dboss, 'post', `${C}/my/cycles/${c}/submit`))).toBe('409 COMP_BUDGET_EXCEEDED');
    await as(dboss, 'patch', `${C}/proposals/${proposalOf(plan, 'D2')}`).send({ proposedBaseSalary: '10666.73' });
    expect(err(await as(dboss, 'post', `${C}/my/cycles/${c}/submit`))).toBe('200');
  });
});

function hradmin() { return hrAdmin; }
