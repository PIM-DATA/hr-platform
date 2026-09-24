/**
 * Task 32 — organization design and workforce planning.
 *
 * What these tests guard: the plan is a layer beside the live organization (initialize copies the current
 * workforce, finalize freezes it, and neither touches an employee, position, department or payroll row); the
 * delta is a number with a factual classification and nobody is selected for it; the recruitment handoff is an
 * explicit action through the recruitment service under both permissions; scenarios can contain units that do
 * not exist, be duplicated and compared without a verdict; and access follows permissions and the data scope.
 */
import type { Server } from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { headcountDelta, remainingDemand } from '@hr/shared';
import { prisma } from '../src/lib/prisma';
import { createTestServer, createUser, loginAs, resetDatabase } from './helpers';

const app: Server = createTestServer();
const PW = 'Correct-Horse-1';
type Session = { cookie: string; csrf: string; user: { id: string } };
const as = (s: Session, m: 'get' | 'post' | 'patch' | 'delete', url: string) => request(app)[m](url).set('Cookie', s.cookie).set('x-csrf-token', s.csrf);
const err = (r: request.Response) => `${r.status} ${r.body?.error?.code ?? ''}`.trim();
const W = '/api/v1/workforce';
const text = (v: unknown) => JSON.stringify(v);

let hrAdmin: Session, hr: Session, mgr: Session, emp: Session, exec: Session, planner: Session, wfManager: Session;
let orgId: string, analyticsId: string, salesId: string, marketingId: string;
let daJob: string, srDaJob: string, mgrJob: string, salesJob: string;
let cycleId: string;
const before: Record<string, number> = {};

async function customRole(code: string, permissions: string[]) {
  const role = await prisma.role.create({ data: { code, name: code, isSystem: false, dataScope: 'ALL' } });
  const perms = await prisma.permission.findMany({ where: { code: { in: permissions } } });
  await prisma.rolePermission.createMany({ data: perms.map((p) => ({ roleId: role.id, permissionId: p.id })) });
}
const snapshotMasters = async () => ({
  employees: await prisma.employee.count(), active: await prisma.employee.count({ where: { employmentStatus: 'ACTIVE' } }), positions: await prisma.position.count(), departments: await prisma.department.count(), jobs: await prisma.job.count(),
  payroll: await prisma.payrollRun.count(), requisitions: await prisma.recruitmentRequisition.count(), positionHistory: await prisma.employeePosition.count(),
});

beforeAll(async () => {
  await resetDatabase();
  const org = await prisma.organization.create({ data: { code: 'A32', name: 'Planning Co', timezone: 'Asia/Bangkok' } });
  orgId = org.id;
  const analytics = await prisma.department.create({ data: { organizationId: org.id, code: 'ANA', name: 'Analytics' } });
  const sales = await prisma.department.create({ data: { organizationId: org.id, code: 'SAL', name: 'Sales' } });
  const marketing = await prisma.department.create({ data: { organizationId: org.id, code: 'MKT', name: 'Marketing' } });
  analyticsId = analytics.id; salesId = sales.id; marketingId = marketing.id;
  const mk = async (code: string, title: string, level: number) => (await prisma.job.create({ data: { code, title, level } })).id;
  daJob = await mk('DA', 'Data Analyst', 2); srDaJob = await mk('SDA', 'Senior Data Analyst', 3); mgrJob = await mk('AM', 'Analytics Manager', 4); salesJob = await mk('SR', 'Sales Representative', 2);
  const pos = async (code: string, departmentId: string, jobId: string | null) => (await prisma.position.create({ data: { departmentId, code, title: code, jobId } })).id;
  const daPos = await pos('P-DA', analytics.id, daJob); const srPos = await pos('P-SDA', analytics.id, srDaJob); const amPos = await pos('P-AM', analytics.id, mgrJob); const salesPos = await pos('P-SR', sales.id, salesJob);
  await pos('P-SR-EMPTY', sales.id, salesJob); // an active position nobody holds
  const mkEmp = async (code: string, departmentId: string, positionId: string, managerId: string | null = null) => (await prisma.employee.create({ data: { employeeCode: code, firstName: code, lastName: 'Person', email: `${code.toLowerCase()}@a32.local`, hireDate: new Date('2020-01-01T00:00:00Z'), organizationId: org.id, departmentId, positionId, managerId, employmentType: 'FULL_TIME', employmentStatus: 'ACTIVE', positionHistory: { create: { positionId, departmentId, startDate: new Date('2020-01-01T00:00:00Z') } } } })).id;
  const am = await mkEmp('AM1', analytics.id, amPos);
  for (let i = 1; i <= 5; i += 1) await mkEmp(`DA${i}`, analytics.id, daPos, am);
  for (let i = 1; i <= 2; i += 1) await mkEmp(`SDA${i}`, analytics.id, srPos, am);
  for (let i = 1; i <= 10; i += 1) await mkEmp(`SR${i}`, sales.id, salesPos);
  await prisma.employee.create({ data: { employeeCode: 'GONE1', firstName: 'Gone', lastName: 'Person', email: 'gone@a32.local', hireDate: new Date('2019-01-01T00:00:00Z'), terminationDate: new Date('2025-01-01T00:00:00Z'), organizationId: org.id, departmentId: sales.id, positionId: salesPos, employmentType: 'FULL_TIME', employmentStatus: 'TERMINATED' } });
  await prisma.department.update({ where: { id: analytics.id }, data: { headEmployeeId: am } });
  await customRole('WFPLAN', ['workforce.view', 'workforce.plan', 'organization_design.view']);
  await customRole('WFMANAGE', ['workforce.view', 'workforce.plan', 'workforce.manage', 'organization_design.view', 'organization_design.manage']);
  await createUser({ email: 'hradmin@a32.local', password: PW, role: 'HR_ADMIN' });
  await createUser({ email: 'hr@a32.local', password: PW, role: 'HR' });
  await createUser({ email: 'mgr@a32.local', password: PW, role: 'MANAGER', employeeId: am });
  await createUser({ email: 'emp@a32.local', password: PW, role: 'EMPLOYEE', employeeId: (await prisma.employee.findUniqueOrThrow({ where: { employeeCode: 'DA1' } })).id });
  await createUser({ email: 'exec@a32.local', password: PW, role: 'EXECUTIVE' });
  await createUser({ email: 'planner@a32.local', password: PW, role: 'WFPLAN' });
  await createUser({ email: 'wfmanager@a32.local', password: PW, role: 'WFMANAGE' });
  [hrAdmin, hr, mgr, emp, exec, planner, wfManager] = await Promise.all(['hradmin', 'hr', 'mgr', 'emp', 'exec', 'planner', 'wfmanager'].map((u) => loginAs(app, `${u}@a32.local`, PW)));
  Object.assign(before, await snapshotMasters());
}, 180000);

afterAll(async () => { await resetDatabase(); await prisma.$disconnect(); });

describe('access', () => {
  it('an employee gets 403 everywhere; HR reads but cannot plan; a planner plans but cannot finalize', async () => {
    expect(err(await as(emp, 'get', `${W}/dashboard`))).toBe('403 FORBIDDEN');
    expect(err(await as(emp, 'get', `${W}/cycles`))).toBe('403 FORBIDDEN');
    expect(err(await as(emp, 'get', `${W}/scenarios`))).toBe('403 FORBIDDEN');
    expect(err(await as(hr, 'get', `${W}/cycles`))).toBe('200');
    expect(err(await as(hr, 'post', `${W}/cycles`).send({ code: 'X', name: 'x', periodStart: '2027-01-01', periodEnd: '2027-12-31' }))).toBe('403 FORBIDDEN');
    expect(err(await as(mgr, 'post', `${W}/cycles`).send({ code: 'X', name: 'x', periodStart: '2027-01-01', periodEnd: '2027-12-31' }))).toBe('403 FORBIDDEN');
  });
  it('the live dashboard (no cycle) counts the active workforce; a manager with TEAM scope sees their own department only', async () => {
    const all = (await as(hrAdmin, 'get', `${W}/dashboard`)).body.data;
    expect(all).toMatchObject({ cycle: null, currentHeadcount: 18, plannedHeadcount: 18, netDelta: 0, vacantPositions: 1 });
    const mine = (await as(mgr, 'get', `${W}/dashboard`)).body.data;
    expect(mine.currentHeadcount).toBe(8);
    const vac = (await as(mgr, 'get', `${W}/vacancies`)).body.data;
    expect(vac.every((v: { departmentId: string }) => v.departmentId === analyticsId)).toBe(true);
    expect((await as(hrAdmin, 'get', `${W}/vacancies`)).body.data.find((v: { positionCode: string }) => v.positionCode === 'P-SR-EMPTY')).toMatchObject({ status: 'VACANT', activeEmployees: 0 });
  });
});

describe('planning cycle and headcount plan', () => {
  it('creates the 2027 plan and initializes it from the current workforce, idempotently and under concurrency', async () => {
    const c = await as(hrAdmin, 'post', `${W}/cycles`).send({ code: 'WFP-2027', name: '2027 Workforce Plan', organizationId: orgId, periodStart: '2027-01-01', periodEnd: '2027-12-31', description: 'Annual plan' });
    expect(err(c)).toBe('201');
    cycleId = c.body.data.id;
    expect(c.body.data).toMatchObject({ status: 'DRAFT', itemCount: 0, can: { edit: true, finalize: false } });
    const [a, b] = await Promise.all([as(hrAdmin, 'post', `${W}/cycles/${cycleId}/initialize`), as(planner, 'post', `${W}/cycles/${cycleId}/initialize`)]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(a.body.data.created + b.body.data.created).toBe(4); // DA, SDA, AM in Analytics + SR in Sales; the terminated employee counts nowhere
    const again = await as(hrAdmin, 'post', `${W}/cycles/${cycleId}/initialize`);
    expect(again.body.data).toEqual({ created: 0, existing: 4 });
    const items = (await as(hrAdmin, 'get', `${W}/cycles/${cycleId}/items`)).body.data;
    expect(items).toHaveLength(4);
    const da = items.find((i: { jobId: string }) => i.jobId === daJob);
    expect(da).toMatchObject({ departmentName: 'Analytics', jobTitle: 'Data Analyst', currentHeadcountSnapshot: 5, plannedHeadcount: 5, delta: 0, classification: 'NO_CHANGE', currentHeadcountLive: 5 });
    expect(text(items)).not.toMatch(/DA1|firstName|Person/);
  });
  it('planned 8 against 5 is +3 EXPANSION with 3 remaining demand — and no requisition appears by itself', async () => {
    const items = (await as(hrAdmin, 'get', `${W}/cycles/${cycleId}/items`)).body.data;
    const da = items.find((i: { jobId: string }) => i.jobId === daJob);
    const r = await as(planner, 'patch', `${W}/items/${da.id}`).send({ plannedHeadcount: 8, reason: 'GROWTH', priority: 'HIGH', targetDate: '2027-06-30', notes: 'Two for the new dashboard programme, one replacement' });
    expect(err(r)).toBe('200');
    expect(r.body.data).toMatchObject({ plannedHeadcount: 8, delta: 3, classification: 'EXPANSION', remainingDemand: 3, recruitment: { openRecruitmentDemand: 0, approvedOpenings: 0 }, requisitions: [] });
    expect(await prisma.recruitmentRequisition.count()).toBe(before.requisitions);
    expect(headcountDelta(8, 5)).toEqual({ delta: 3, classification: 'EXPANSION' });
    expect(remainingDemand(8, 5, 2)).toBe(1);
    expect(remainingDemand(8, 10, 0)).toBe(0);
    const sr = items.find((i: { jobId: string }) => i.jobId === srDaJob);
    expect(err(await as(planner, 'patch', `${W}/items/${sr.id}`).send({ plannedHeadcount: 3 }))).toBe('200');
  });
  it('planned 8 against 10 is −2 REDUCTION_PLANNED: a number, no employee list, no termination', async () => {
    const items = (await as(hrAdmin, 'get', `${W}/cycles/${cycleId}/items`)).body.data;
    const sales = items.find((i: { jobId: string }) => i.jobId === salesJob);
    const r = await as(hrAdmin, 'patch', `${W}/items/${sales.id}`).send({ plannedHeadcount: 8, reason: 'RESTRUCTURE' });
    expect(r.body.data).toMatchObject({ delta: -2, classification: 'REDUCTION_PLANNED', remainingDemand: 0 });
    expect(text(r.body.data)).not.toMatch(/SR\d|employeeCode|OVERSTAFF/i);
    expect(await prisma.employee.count({ where: { employmentStatus: 'ACTIVE' } })).toBe(before.active);
    expect(await prisma.employeeRelationCase.count()).toBe(0);
  });
  it('a row can be added for a department + job with nobody today; a duplicate row is refused', async () => {
    const r = await as(planner, 'post', `${W}/cycles/${cycleId}/items`).send({ departmentId: marketingId, jobId: daJob, plannedHeadcount: 2 });
    expect(err(r)).toBe('201');
    expect(r.body.data).toMatchObject({ departmentName: 'Marketing', currentHeadcountSnapshot: 0, plannedHeadcount: 2, delta: 2, classification: 'EXPANSION' });
    expect(err(await as(planner, 'post', `${W}/cycles/${cycleId}/items`).send({ departmentId: marketingId, jobId: daJob }))).toBe('409 WORKFORCE_PLAN_ITEM_EXISTS');
    expect(err(await as(planner, 'post', `${W}/cycles/${cycleId}/items`).send({ departmentId: marketingId, jobId: daJob, scope: 'ALL' }))).toBe('400 VALIDATION_ERROR');
  });
  it('the dashboard sums the plan: current 18, planned 22, +4 net, 6 expansion, 2 reductions', async () => {
    const d = (await as(exec, 'get', `${W}/dashboard?cycleId=${cycleId}`)).body.data;
    expect(d).toMatchObject({ currentHeadcount: 18, plannedHeadcount: 22, netDelta: 4, expansionDemand: 6, plannedReductions: 2, remainingDemand: 6, vacantPositions: 1 });
    expect(d.byDepartment.find((x: { departmentName: string }) => x.departmentName === 'Sales')).toMatchObject({ current: 10, planned: 8, delta: -2, classification: 'REDUCTION_PLANNED' });
    expect(d.byJob.find((x: { jobTitle: string }) => x.jobTitle === 'Data Analyst')).toMatchObject({ current: 5, planned: 10, delta: 5 });
    expect(text(d)).not.toMatch(/employeeCode|firstName|Person|DA1/);
    // The manager sees only Analytics figures.
    const m = (await as(mgr, 'get', `${W}/dashboard?cycleId=${cycleId}`)).body.data;
    expect(m.byDepartment.map((x: { departmentName: string }) => x.departmentName)).toEqual(['Analytics']);
    expect(m).toMatchObject({ currentHeadcount: 8, plannedHeadcount: 12 });
    expect(err(await as(mgr, 'patch', `${W}/items/${(await as(hrAdmin, 'get', `${W}/cycles/${cycleId}/items`)).body.data[0].id}`).send({ plannedHeadcount: 1 }))).toBe('403 FORBIDDEN');
  });
});

describe('recruitment handoff', () => {
  it('needs workforce.manage AND recruitment.manage; HR explicitly asks for 2 openings and gets a DRAFT requisition from the recruitment service', async () => {
    const da = (await as(hrAdmin, 'get', `${W}/cycles/${cycleId}/items`)).body.data.find((i: { jobId: string }) => i.jobId === daJob);
    expect(err(await as(planner, 'post', `${W}/items/${da.id}/requisition`).send({ requestedOpenings: 2 }))).toBe('403 FORBIDDEN');
    expect(err(await as(wfManager, 'post', `${W}/items/${da.id}/requisition`).send({ requestedOpenings: 2 }))).toBe('403 FORBIDDEN');
    const r = await as(hrAdmin, 'post', `${W}/items/${da.id}/requisition`).send({ requestedOpenings: 2 });
    expect(err(r)).toBe('201');
    expect(r.body.data).toMatchObject({ status: 'DRAFT', requestedOpenings: 2, reason: 'NEW_HEADCOUNT' });
    expect(r.body.data.requisitionNumber).toMatch(/^REQ-\d{4}-\d{6}$/);
    expect(r.body.data.justification).toMatch(/Workforce plan WFP-2027: current 5, planned 8/);
    const row = await prisma.recruitmentRequisition.findUniqueOrThrow({ where: { id: r.body.data.id } });
    expect(row).toMatchObject({ organizationId: orgId, departmentId: analyticsId, jobId: daJob, createdByUserId: hrAdmin.user.id });
    expect(await prisma.auditLog.count({ where: { module: 'recruitment', action: 'CREATE_RECRUITMENT_REQUISITION', recordId: row.id } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { module: 'workforce', action: 'CREATE_REQUISITION_FROM_WORKFORCE_PLAN' } })).toBe(1);
    const after = (await as(hrAdmin, 'get', `${W}/cycles/${cycleId}/items`)).body.data.find((i: { id: string }) => i.id === da.id);
    expect(after.requisitions).toEqual([{ id: row.id, requisitionNumber: row.requisitionNumber, status: 'DRAFT', requestedOpenings: 2 }]);
    expect(after.remainingDemand).toBe(3); // a draft is not demand in flight
    // Once recruitment opens the demand, the plan shows it factually and the remaining delta shrinks.
    await prisma.recruitmentRequisition.update({ where: { id: row.id }, data: { status: 'APPROVED' } });
    await prisma.recruitmentOpening.create({ data: { openingNumber: 'OPN-2027-000001', requisitionId: row.id, jobId: daJob, titleSnapshot: 'Data Analyst', openingsCount: 2, status: 'OPEN', createdByUserId: hrAdmin.user.id } });
    const live = (await as(hrAdmin, 'get', `${W}/cycles/${cycleId}/items`)).body.data.find((i: { id: string }) => i.id === da.id);
    expect(live.recruitment).toMatchObject({ approvedRequisitions: 1, approvedOpenings: 2, openOpenings: 2, hired: 0, openRecruitmentDemand: 2 });
    expect(live.remainingDemand).toBe(1);
    expect(err(await as(hrAdmin, 'delete', `${W}/items/${da.id}`))).toBe('409 WORKFORCE_PLAN_ITEM_HAS_REQUISITIONS');
  });
});

describe('finalization and history', () => {
  it('DRAFT → FINALIZED is not a transition; ACTIVE → FINALIZED needs workforce.manage; a double finalize yields one transition', async () => {
    expect(err(await as(hrAdmin, 'post', `${W}/cycles/${cycleId}/transition`).send({ status: 'FINALIZED' }))).toBe('409 WORKFORCE_CYCLE_INVALID_TRANSITION');
    expect(err(await as(planner, 'post', `${W}/cycles/${cycleId}/transition`).send({ status: 'ACTIVE' }))).toBe('200');
    expect(err(await as(planner, 'post', `${W}/cycles/${cycleId}/transition`).send({ status: 'FINALIZED' }))).toBe('403 FORBIDDEN');
    expect(err(await as(planner, 'patch', `${W}/items/${(await as(hrAdmin, 'get', `${W}/cycles/${cycleId}/items`)).body.data[0].id}`).send({ plannedHeadcount: 9 }))).toBe('409 WORKFORCE_CYCLE_NOT_EDITABLE');
    const masters = await snapshotMasters();
    const [a, b] = await Promise.all([as(hrAdmin, 'post', `${W}/cycles/${cycleId}/transition`).send({ status: 'FINALIZED' }), as(wfManager, 'post', `${W}/cycles/${cycleId}/transition`).send({ status: 'FINALIZED' })]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(await prisma.auditLog.count({ where: { module: 'workforce', action: 'FINALIZE_WORKFORCE_CYCLE' } })).toBe(1);
    expect(await snapshotMasters()).toEqual(masters); // finalizing creates and closes nothing
    expect((await as(hr, 'get', `${W}/cycles/${cycleId}`)).body.data).toMatchObject({ status: 'FINALIZED', can: { edit: false, finalize: false } });
  });
  it('after finalization the workforce moves on and the plan snapshot stays where it was', async () => {
    // Two data analysts transfer to Sales; one senior leaves.
    const [da1, da2] = await prisma.employee.findMany({ where: { employeeCode: { in: ['DA1', 'DA2'] } }, select: { id: true } });
    const salesPos = await prisma.position.findUniqueOrThrow({ where: { code: 'P-SR' } });
    await prisma.employee.updateMany({ where: { id: { in: [da1.id, da2.id] } }, data: { departmentId: salesId, positionId: salesPos.id } });
    await prisma.employee.update({ where: { employeeCode: 'SDA2' }, data: { employmentStatus: 'TERMINATED', terminationDate: new Date() } });
    const items = (await as(hrAdmin, 'get', `${W}/cycles/${cycleId}/items`)).body.data;
    expect(items.find((i: { jobId: string }) => i.jobId === daJob)).toMatchObject({ currentHeadcountSnapshot: 5, plannedHeadcount: 8, delta: 3, currentHeadcountLive: null });
    expect(items.find((i: { jobId: string }) => i.jobId === srDaJob)).toMatchObject({ currentHeadcountSnapshot: 2, plannedHeadcount: 3 });
    const live = (await as(hrAdmin, 'get', `${W}/dashboard`)).body.data;
    expect(live.currentHeadcount).toBe(17);
    const frozen = (await as(hrAdmin, 'get', `${W}/dashboard?cycleId=${cycleId}`)).body.data;
    expect(frozen).toMatchObject({ currentHeadcount: 18, plannedHeadcount: 22 });
    // A new draft initialized today sees the moved workforce.
    const c2 = await as(hrAdmin, 'post', `${W}/cycles`).send({ code: 'WFP-2028', name: '2028 Workforce Plan', organizationId: orgId, periodStart: '2028-01-01', periodEnd: '2028-12-31' });
    await as(hrAdmin, 'post', `${W}/cycles/${c2.body.data.id}/initialize`);
    const items2 = (await as(hrAdmin, 'get', `${W}/cycles/${c2.body.data.id}/items`)).body.data;
    expect(items2.find((i: { jobId: string; departmentId: string }) => i.jobId === daJob && i.departmentId === analyticsId).currentHeadcountSnapshot).toBe(3);
    expect(items2.find((i: { jobId: string; departmentId: string }) => i.jobId === salesJob && i.departmentId === salesId).currentHeadcountSnapshot).toBe(12);
    expect(err(await as(hrAdmin, 'post', `${W}/cycles/${cycleId}/transition`).send({ status: 'ARCHIVED' }))).toBe('200');
    expect(err(await as(hrAdmin, 'post', `${W}/cycles/${cycleId}/transition`).send({ status: 'DRAFT' }))).toBe('409 WORKFORCE_CYCLE_INVALID_TRANSITION');
  });
  it('planned movements are records: the executive cannot read them, and the employee master does not change', async () => {
    const c = (await as(hrAdmin, 'get', `${W}/cycles?status=DRAFT`)).body.data[0];
    const da3 = await prisma.employee.findUniqueOrThrow({ where: { employeeCode: 'DA3' } });
    const r = await as(planner, 'post', `${W}/cycles/${c.id}/movements`).send({ employeeId: da3.id, fromDepartmentId: analyticsId, toDepartmentId: marketingId, fromJobId: daJob, toJobId: daJob, targetDate: '2028-03-01' });
    expect(err(r)).toBe('201');
    expect(r.body.data).toMatchObject({ status: 'PLANNED', fromDepartment: { name: 'Analytics' }, toDepartment: { name: 'Marketing' }, employee: { employeeCode: 'DA3' } });
    expect(err(await as(exec, 'get', `${W}/cycles/${c.id}/movements`))).toBe('403 FORBIDDEN');
    expect((await prisma.employee.findUniqueOrThrow({ where: { id: da3.id } })).departmentId).toBe(analyticsId);
    expect(err(await as(planner, 'patch', `${W}/movements/${r.body.data.id}`).send({ status: 'COMPLETED_EXTERNALLY' }))).toBe('200');
    expect((await prisma.employee.findUniqueOrThrow({ where: { id: da3.id } })).departmentId).toBe(analyticsId);
  });
});

describe('organization design', () => {
  let scenarioId: string, copyId: string, digitalNodeId: string;
  it('a scenario imports the current departments, adds a planned-only Digital unit and headcount, and the live master gains nothing', async () => {
    expect(err(await as(planner, 'post', `${W}/scenarios`).send({ name: 'x', organizationId: orgId }))).toBe('403 FORBIDDEN');
    const s = await as(hrAdmin, 'post', `${W}/scenarios`).send({ name: '2028 Target Organization', organizationId: orgId });
    expect(err(s)).toBe('201');
    scenarioId = s.body.data.id;
    expect((await as(hrAdmin, 'post', `${W}/scenarios/${scenarioId}/import-current`)).body.data).toEqual({ created: 3 });
    expect((await as(hrAdmin, 'post', `${W}/scenarios/${scenarioId}/import-current`)).body.data).toEqual({ created: 0 });
    const digital = await as(hrAdmin, 'post', `${W}/scenarios/${scenarioId}/nodes`).send({ nodeType: 'DEPARTMENT', name: 'Digital', code: 'DIG' });
    expect(err(digital)).toBe('201');
    digitalNodeId = digital.body.data.id;
    expect(err(await as(hrAdmin, 'post', `${W}/scenarios/${scenarioId}/positions`).send({ nodeId: digitalNodeId, jobId: daJob, plannedHeadcount: 3 }))).toBe('201');
    expect(err(await as(hrAdmin, 'post', `${W}/scenarios/${scenarioId}/positions`).send({ nodeId: digitalNodeId, plannedJobTitle: 'AI Engineer', plannedHeadcount: 2 }))).toBe('201');
    const tree = (await as(hr, 'get', `${W}/scenarios/${scenarioId}`)).body.data;
    expect(tree.roots).toHaveLength(1);
    expect(tree.roots[0]).toMatchObject({ nodeType: 'ORGANIZATION', plannedOnly: false });
    const dig = tree.roots[0].children.find((n: { name: string }) => n.name === 'Digital');
    expect(dig).toMatchObject({ plannedOnly: true, sourceDepartmentId: null, plannedHeadcount: 5, currentHeadcount: 0 });
    expect(tree.roots[0].children.find((n: { name: string }) => n.name === 'Analytics')).toMatchObject({ plannedOnly: false, sourceDepartmentId: analyticsId, currentHeadcount: 5 });
    expect(await prisma.department.count({ where: { name: 'Digital' } })).toBe(0);
    expect(await prisma.job.count({ where: { title: 'AI Engineer' } })).toBe(0);
    expect(await prisma.position.count()).toBe(before.positions);
    const cmp = (await as(exec, 'get', `${W}/scenarios/${scenarioId}/comparison`)).body.data;
    expect(cmp.byDepartment.find((d: { name: string }) => d.name === 'Digital')).toMatchObject({ plannedOnly: true, current: 0, planned: 5, delta: 5 });
    expect(cmp.byJob.find((j: { jobTitle: string }) => j.jobTitle === 'AI Engineer')).toMatchObject({ current: 0, planned: 2 });
    expect(text(cmp)).not.toMatch(/best|recommend/i);
  });
  it('duplicating gives a new scenario with the same structure; editing the copy leaves the original alone; two concurrent copies are independent', async () => {
    const [c1, c2] = await Promise.all([as(hrAdmin, 'post', `${W}/scenarios/${scenarioId}/duplicate`).send({ name: 'Scenario B — Expansion' }), as(hrAdmin, 'post', `${W}/scenarios/${scenarioId}/duplicate`).send({ name: 'Scenario C — Conservative' })]);
    expect([c1.status, c2.status]).toEqual([201, 201]);
    expect(c1.body.data.id).not.toBe(c2.body.data.id);
    copyId = c1.body.data.id;
    expect(c1.body.data).toMatchObject({ nodeCount: 5, plannedHeadcount: 5, status: 'DRAFT' });
    const copyTree = (await as(hrAdmin, 'get', `${W}/scenarios/${copyId}`)).body.data;
    const copyDigital = copyTree.roots[0].children.find((n: { name: string }) => n.name === 'Digital');
    expect(copyDigital.id).not.toBe(digitalNodeId);
    const pos = copyDigital.positions.find((p: { jobId: string }) => p.jobId === daJob);
    expect(err(await as(hrAdmin, 'patch', `${W}/scenarios/${copyId}/positions/${pos.id}`).send({ plannedHeadcount: 10 }))).toBe('204');
    expect((await as(hrAdmin, 'get', `${W}/scenarios/${scenarioId}`)).body.data.totals.planned).toBe(5);
    expect((await as(hrAdmin, 'get', `${W}/scenarios/${copyId}`)).body.data.totals.planned).toBe(12);
    const cmp = (await as(hrAdmin, 'get', `${W}/scenarios/${scenarioId}/compare?with=${copyId}`)).body.data;
    expect(cmp).toMatchObject({ a: { planned: 5 }, b: { planned: 12 }, delta: 7 });
    expect(cmp.byDepartment.find((d: { name: string }) => d.name === 'Digital')).toEqual({ name: 'Digital', a: 5, b: 12, delta: 7 });
  });
  it('finalizing freezes a target snapshot and mutates no live organization row; a node cannot be its own ancestor', async () => {
    const masters = await snapshotMasters();
    const team = await as(hrAdmin, 'post', `${W}/scenarios/${scenarioId}/nodes`).send({ nodeType: 'TEAM', name: 'AI Team', parentNodeId: digitalNodeId });
    expect(err(await as(hrAdmin, 'patch', `${W}/scenarios/${scenarioId}/nodes/${digitalNodeId}`).send({ parentNodeId: team.body.data.id }))).toBe('422 ORG_DESIGN_CYCLE');
    expect(err(await as(hrAdmin, 'post', `${W}/scenarios/${scenarioId}/transition`).send({ status: 'FINALIZED' }))).toBe('200');
    expect(err(await as(hrAdmin, 'post', `${W}/scenarios/${scenarioId}/nodes`).send({ nodeType: 'TEAM', name: 'Late' }))).toBe('409 ORG_DESIGN_SCENARIO_NOT_EDITABLE');
    const row = await prisma.organizationDesignScenario.findUniqueOrThrow({ where: { id: scenarioId } });
    expect(row.status).toBe('FINALIZED');
    expect((row.finalSnapshot as { totals: { planned: number } }).totals.planned).toBe(5);
    expect(await snapshotMasters()).toEqual(masters);
    expect(await prisma.auditLog.count({ where: { module: { in: ['organization', 'employees', 'payroll'] } } })).toBe(0);
  });
  it('the Report Center datasets are aggregate-safe and permission-bound', async () => {
    const run = (s: Session, datasetId: string, groupBy: string[], columns: string[]) => as(s, 'post', '/api/v1/reports/run').send({ datasetId, definition: { columns, filters: [], sort: [], groupBy, aggregations: [{ fieldId: 'planned', function: 'SUM', alias: 'Planned' }], pageSize: 50 }, page: 1 });
    const r = await run(exec, 'workforce_plan_summary', ['cycle'], ['cycle']);
    expect(err(r)).toBe('200');
    expect(Number(r.body.data.rows.find((x: { cycle: string }) => x.cycle === '2027 Workforce Plan').Planned)).toBe(22);
    expect(err(await run(emp, 'workforce_plan_summary', ['cycle'], ['cycle']))).toBe('403 FORBIDDEN');
    const od = await as(hr, 'post', '/api/v1/reports/run').send({ datasetId: 'organization_design_summary', definition: { columns: ['scenario', 'unit', 'plannedOnly', 'plannedHeadcount'], filters: [{ fieldId: 'plannedOnly', operator: 'EQ', value: true }], sort: [], groupBy: [], aggregations: [], pageSize: 50 }, page: 1 });
    expect(err(od)).toBe('200');
    expect(od.body.data.rows.some((x: { unit: string; plannedHeadcount: number }) => x.unit === 'Digital' && x.plannedHeadcount === 5)).toBe(true);
    expect(text(od.body)).not.toMatch(/notes/);
  });
});
