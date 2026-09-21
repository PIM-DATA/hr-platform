import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { prisma } from '../src/lib/prisma';
import { cleanUsers, createUser, ensureRoles, loginAs } from './helpers';

const app = createApp();
const PW = 'Correct-Horse-1';
type Session = { cookie: string; csrf: string; user: { id: string } };
const as = (s: Session, m: 'get' | 'post' | 'patch', url: string) => request(app)[m](url).set('Cookie', s.cookie).set('x-csrf-token', s.csrf);

// fixture ids
let org: string, orgB: string, deptData: string, deptSales: string, deptSalesB: string;
let posDataMgr: string, posAnalyst: string, posSalesExec: string, posSalesExecB: string, posInactive: string, jobActive: string;
let A: string, B: string, C: string, X: string; // A manages B, B manages C; X unrelated (Sales)
let hr: Session, admin: Session, sysNoEmp: Session, aTeam: Session, cSelf: Session, noPerm: Session;

async function resetData() {
  await prisma.employeeManager.deleteMany();
  await prisma.employeePosition.deleteMany();
  await prisma.user.updateMany({ data: { employeeId: null } });
  await prisma.department.updateMany({ data: { headEmployeeId: null } });
  await prisma.employee.deleteMany();
  await prisma.position.deleteMany();
  await prisma.department.deleteMany();
  await prisma.job.deleteMany();
  await prisma.organization.deleteMany();
}

async function mkEmployee(code: string, positionId: string, managerId: string | null, extra: Partial<{ status: string }> = {}) {
  const pos = await prisma.position.findUniqueOrThrow({ where: { id: positionId }, include: { department: true } });
  const start = new Date('2020-01-01');
  const e = await prisma.employee.create({
    data: {
      employeeCode: code, firstName: code, lastName: 'Test', email: `${code.toLowerCase()}@emp.local`, hireDate: start,
      organizationId: pos.department.organizationId, departmentId: pos.departmentId, positionId, managerId, employmentStatus: extra.status ?? 'ACTIVE',
      positionHistory: { create: { positionId, departmentId: pos.departmentId, startDate: start } },
      managerHistory: managerId ? { create: { managerId, startDate: start } } : undefined,
    },
  });
  return e.id;
}

beforeAll(async () => {
  await ensureRoles();
  await cleanUsers();
  await resetData();
  const o = await prisma.organization.create({ data: { code: 'ACME', name: 'ACME' } });
  const ob = await prisma.organization.create({ data: { code: 'OTHER', name: 'Other Co' } });
  org = o.id; orgB = ob.id;
  deptData = (await prisma.department.create({ data: { organizationId: org, code: 'DATA', name: 'Data' } })).id;
  deptSales = (await prisma.department.create({ data: { organizationId: org, code: 'SALES', name: 'Sales' } })).id;
  deptSalesB = (await prisma.department.create({ data: { organizationId: orgB, code: 'SALES', name: 'Other Sales' } })).id;
  jobActive = (await prisma.job.create({ data: { code: 'GEN', title: 'Generalist' } })).id;
  const jobOff = (await prisma.job.create({ data: { code: 'OLD', title: 'Retired job', isActive: false } })).id;
  posDataMgr = (await prisma.position.create({ data: { departmentId: deptData, jobId: jobActive, code: 'P-DATA-MGR', title: 'Data Manager' } })).id;
  posAnalyst = (await prisma.position.create({ data: { departmentId: deptData, jobId: jobActive, code: 'P-ANALYST', title: 'Data Analyst' } })).id;
  posSalesExec = (await prisma.position.create({ data: { departmentId: deptSales, jobId: jobActive, code: 'P-SALES', title: 'Sales Executive' } })).id;
  posSalesExecB = (await prisma.position.create({ data: { departmentId: deptSalesB, jobId: jobActive, code: 'P-SALES-B', title: 'Sales Exec B' } })).id;
  posInactive = (await prisma.position.create({ data: { departmentId: deptData, jobId: jobOff, code: 'P-OLD', title: 'Old seat', isActive: false } })).id;

  A = await mkEmployee('A', posDataMgr, null);
  B = await mkEmployee('B', posAnalyst, A);
  C = await mkEmployee('C', posAnalyst, B);
  X = await mkEmployee('X', posSalesExec, null);

  await createUser({ email: 'hr@emp.local', password: PW, role: 'HR' }); // ALL, no employee link
  await createUser({ email: 'admin@emp.local', password: PW, role: 'SYSTEM_ADMIN' });
  await createUser({ email: 'a@emp.local', password: PW, role: 'MANAGER', employeeId: A }); // TEAM
  await createUser({ email: 'c@emp.local', password: PW, role: 'EMPLOYEE', employeeId: C }); // SELF
  await createUser({ email: 'self-noemp@emp.local', password: PW, role: 'EMPLOYEE' }); // SELF, no employee
  const dash = await prisma.permission.findUniqueOrThrow({ where: { code: 'dashboard.view' } });
  await prisma.role.upsert({ where: { code: 'NO_EMP' }, update: {}, create: { code: 'NO_EMP', name: 'no employees perms', dataScope: 'ALL', rolePermissions: { create: [{ permissionId: dash.id }] } } });
  await createUser({ email: 'noperm@emp.local', password: PW, role: 'NO_EMP' });

  hr = await loginAs(app, 'hr@emp.local', PW);
  admin = await loginAs(app, 'admin@emp.local', PW);
  aTeam = await loginAs(app, 'a@emp.local', PW);
  cSelf = await loginAs(app, 'c@emp.local', PW);
  sysNoEmp = await loginAs(app, 'self-noemp@emp.local', PW);
  noPerm = await loginAs(app, 'noperm@emp.local', PW);
});
afterAll(async () => {
  await resetData();
  await cleanUsers();
  await prisma.role.deleteMany({ where: { code: 'NO_EMP' } });
  await prisma.$disconnect();
});

const codes = (res: request.Response) => (res.body.data as { employeeCode: string }[]).map((e) => e.employeeCode).sort();
const openPositions = (id: string) => prisma.employeePosition.count({ where: { employeeId: id, endDate: null } });
const openManagers = (id: string) => prisma.employeeManager.count({ where: { employeeId: id, endDate: null } });

/** Invariants every mutation must keep. */
async function assertConsistent(id: string) {
  const e = await prisma.employee.findUniqueOrThrow({ where: { id }, include: { position: { include: { department: true } } } });
  expect(e.departmentId).toBe(e.position.departmentId);
  expect(e.organizationId).toBe(e.position.department.organizationId);
  const openPos = await prisma.employeePosition.findMany({ where: { employeeId: id, endDate: null } });
  expect(openPos).toHaveLength(1);
  expect(openPos[0].positionId).toBe(e.positionId);
  expect(openPos[0].departmentId).toBe(e.departmentId);
  const openMgr = await prisma.employeeManager.findMany({ where: { employeeId: id, endDate: null } });
  if (e.managerId) {
    expect(openMgr).toHaveLength(1);
    expect(openMgr[0].managerId).toBe(e.managerId);
  } else expect(openMgr).toHaveLength(0);
}

// ------------------------------------------------------------------ data scope
describe('data scope', () => {
  it('1. unauthenticated → 401; 2. without employees.view → 403', async () => {
    expect((await request(app).get('/api/v1/employees')).status).toBe(401);
    expect((await as(noPerm, 'get', '/api/v1/employees')).status).toBe(403);
    expect((await as(noPerm, 'get', `/api/v1/employees/${A}`)).status).toBe(403);
  });
  it('3. SELF sees self; 4. cannot see another employee (404, no existence leak)', async () => {
    const list = await as(cSelf, 'get', '/api/v1/employees');
    expect(list.status).toBe(200);
    expect(codes(list)).toEqual(['C']);
    expect((await as(cSelf, 'get', `/api/v1/employees/${C}`)).status).toBe(200);
    const other = await as(cSelf, 'get', `/api/v1/employees/${B}`);
    expect(other.status).toBe(404);
    expect(other.body.error.code).toBe('EMPLOYEE_NOT_FOUND');
    expect((await as(cSelf, 'get', `/api/v1/employees/${B}/position-history`)).status).toBe(404);
    expect((await as(cSelf, 'get', `/api/v1/employees/does-not-exist`)).status).toBe(404);
  });
  it('5–8. TEAM = self + direct reports only (no indirect, no unrelated)', async () => {
    const list = await as(aTeam, 'get', '/api/v1/employees');
    expect(codes(list)).toEqual(['A', 'B']);
    expect(list.body.meta.total).toBe(2);
  });
  it('9. TEAM direct detail of indirect/unrelated → 404; reports endpoint cannot bypass scope', async () => {
    expect((await as(aTeam, 'get', `/api/v1/employees/${C}`)).status).toBe(404);
    expect((await as(aTeam, 'get', `/api/v1/employees/${X}`)).status).toBe(404);
    const own = await as(aTeam, 'get', `/api/v1/employees/${A}/reports`);
    expect(codes(own)).toEqual(['B']);
    const viaB = await as(aTeam, 'get', `/api/v1/employees/${B}/reports`); // B is in scope, but B's reports (C) are not
    expect(viaB.status).toBe(200);
    expect(viaB.body.data).toEqual([]);
    expect((await as(aTeam, 'get', `/api/v1/employees/${X}/reports`)).status).toBe(404);
  });
  it('10. ALL sees all; 12. user with no employeeId + ALL can view all', async () => {
    expect(codes(await as(hr, 'get', '/api/v1/employees'))).toEqual(['A', 'B', 'C', 'X']);
    expect((await as(hr, 'get', `/api/v1/employees/${C}`)).status).toBe(200);
  });
  it('11. user with no employeeId + SELF → empty list', async () => {
    const list = await as(sysNoEmp, 'get', '/api/v1/employees');
    expect(list.status).toBe(200);
    expect(list.body.data).toEqual([]);
    expect(list.body.meta.total).toBe(0);
    expect((await as(sysNoEmp, 'get', `/api/v1/employees/${A}`)).status).toBe(404);
  });
  it('options endpoint is scoped too', async () => {
    expect(codes(await as(cSelf, 'get', '/api/v1/employees/options'))).toEqual(['C']);
    expect(codes(await as(aTeam, 'get', '/api/v1/employees/options'))).toEqual(['A', 'B']);
    expect(codes(await as(hr, 'get', `/api/v1/employees/options?departmentId=${deptData}&excludeId=${A}`))).toEqual(['B', 'C']);
    expect((await as(noPerm, 'get', '/api/v1/employees/options')).status).toBe(403);
  });
  it('list: search (full name), filters, sort whitelist, pagination', async () => {
    expect(codes(await as(hr, 'get', '/api/v1/employees?search=B%20Test'))).toEqual(['B']);
    expect(codes(await as(hr, 'get', `/api/v1/employees?departmentId=${deptSales}`))).toEqual(['X']);
    expect(codes(await as(hr, 'get', `/api/v1/employees?managerId=${B}`))).toEqual(['C']);
    expect(codes(await as(hr, 'get', `/api/v1/employees?positionId=${posAnalyst}&employmentStatus=ACTIVE`))).toEqual(['B', 'C']);
    const paged = await as(hr, 'get', '/api/v1/employees?sortBy=employeeCode&sortDir=desc&pageSize=2&page=1');
    expect(paged.body.data.map((e: { employeeCode: string }) => e.employeeCode)).toEqual(['X', 'C']);
    expect(paged.body.meta).toEqual({ page: 1, pageSize: 2, total: 4 });
    expect((await as(hr, 'get', '/api/v1/employees?sortBy=passwordHash')).status).toBe(400);
    const row = paged.body.data[0];
    expect(row).toMatchObject({ organization: { code: 'ACME' }, department: { code: 'SALES' }, position: { code: 'P-SALES' }, manager: null });
  });
  it('detail exposes account summary only to callers with users.view', async () => {
    const asAdmin = await as(admin, 'get', `/api/v1/employees/${A}`);
    expect(asAdmin.body.data.account).toMatchObject({ email: 'a@emp.local', isActive: true });
    expect(asAdmin.body.data).toMatchObject({ directReportCount: 1, job: { code: 'GEN' }, headOfDepartments: [] });
    const asHr = await as(hr, 'get', `/api/v1/employees/${A}`);
    expect(asHr.body.data).not.toHaveProperty('account');
    expect(JSON.stringify(asHr.body)).not.toMatch(/passwordHash|token/i);
  });
});

// ------------------------------------------------------------------ create / profile
describe('create / profile', () => {
  const base = { employeeCode: ' new01 ', firstName: 'Nina', lastName: 'New', email: ' Nina.New@EMP.local ', hireDate: '2026-01-15', employmentType: 'FULL_TIME' };
  let newId: string;
  it('13. create success; 17. department/org derived from position; 18–19. initial histories', async () => {
    const res = await as(hr, 'post', '/api/v1/employees').send({ ...base, positionId: posSalesExec, managerId: A, organizationId: orgB, departmentId: deptData });
    expect(res.status).toBe(201);
    newId = res.body.data.id;
    expect(res.body.data).toMatchObject({ employeeCode: 'NEW01', email: 'nina.new@emp.local', employmentStatus: 'ACTIVE', organization: { code: 'ACME' }, department: { code: 'SALES' }, position: { code: 'P-SALES' }, manager: { employeeCode: 'A' } });
    await assertConsistent(newId); // forged org/department ignored (57/58)
    const ph = await prisma.employeePosition.findMany({ where: { employeeId: newId } });
    expect(ph).toHaveLength(1);
    expect(ph[0]).toMatchObject({ positionId: posSalesExec, departmentId: deptSales, endDate: null });
    expect(ph[0].startDate.toISOString()).toBe(new Date('2026-01-15').toISOString());
    const mh = await prisma.employeeManager.findMany({ where: { employeeId: newId } });
    expect(mh).toHaveLength(1);
    expect(mh[0]).toMatchObject({ managerId: A, endDate: null });
    const audit = await prisma.auditLog.findFirst({ where: { action: 'CREATE_EMPLOYEE', recordId: newId } });
    expect(JSON.parse(audit!.newValue!)).toMatchObject({ employeeCode: 'NEW01', positionId: posSalesExec, departmentId: deptSales, organizationId: org, managerId: A });
  });
  it('14. duplicate employeeCode → 409; 15. duplicate email → 409', async () => {
    const code = await as(hr, 'post', '/api/v1/employees').send({ ...base, email: 'other@emp.local', positionId: posSalesExec });
    expect(code.status).toBe(409);
    expect(code.body.error.code).toBe('EMPLOYEE_CODE_ALREADY_EXISTS');
    const email = await as(hr, 'post', '/api/v1/employees').send({ ...base, employeeCode: 'NEW02', positionId: posSalesExec });
    expect(email.status).toBe(409);
    expect(email.body.error.code).toBe('EMAIL_ALREADY_EXISTS');
  });
  it('16. inactive position rejected; unknown position → 404; missing position → 400', async () => {
    const res = await as(hr, 'post', '/api/v1/employees').send({ ...base, employeeCode: 'NEW03', email: 'n3@emp.local', positionId: posInactive });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('POSITION_INACTIVE');
    expect((await as(hr, 'post', '/api/v1/employees').send({ ...base, employeeCode: 'NEW03', email: 'n3@emp.local', positionId: 'nope' })).body.error.code).toBe('POSITION_NOT_FOUND');
    expect((await as(hr, 'post', '/api/v1/employees').send({ ...base, employeeCode: 'NEW03', email: 'n3@emp.local' })).status).toBe(400);
  });
  it('20. create rolls back entirely when the manager is invalid', async () => {
    const res = await as(hr, 'post', '/api/v1/employees').send({ ...base, employeeCode: 'NEW04', email: 'n4@emp.local', positionId: posSalesExec, managerId: 'nope' });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('MANAGER_NOT_FOUND');
    expect(await prisma.employee.findUnique({ where: { employeeCode: 'NEW04' } })).toBeNull();
    expect(await prisma.employeePosition.count({ where: { employee: { employeeCode: 'NEW04' } } })).toBe(0);
  });
  it('21. generic PATCH cannot mutate assignment fields; 59. client cannot write history', async () => {
    const before = await prisma.employee.findUniqueOrThrow({ where: { id: newId } });
    const res = await as(hr, 'patch', `/api/v1/employees/${newId}`).send({ nickname: 'Nin', positionId: posAnalyst, departmentId: deptData, organizationId: orgB, managerId: B, positionHistory: [{}], employmentStatus: 'TERMINATED' });
    expect(res.status).toBe(200);
    const after = await prisma.employee.findUniqueOrThrow({ where: { id: newId } });
    expect(after).toMatchObject({ nickname: 'Nin', positionId: before.positionId, departmentId: before.departmentId, organizationId: before.organizationId, managerId: before.managerId, employmentStatus: 'ACTIVE' });
    expect(await prisma.employeePosition.count({ where: { employeeId: newId } })).toBe(1);
    expect((await as(hr, 'patch', `/api/v1/employees/${newId}`).send({ positionId: posAnalyst })).status).toBe(400); // nothing valid to update
  });
  it('22. profile update audit stores field diff only', async () => {
    const res = await as(hr, 'patch', `/api/v1/employees/${newId}`).send({ phone: '0812345678', firstName: 'Nina' });
    expect(res.status).toBe(200);
    const audit = await prisma.auditLog.findFirst({ where: { action: 'UPDATE_EMPLOYEE', recordId: newId }, orderBy: { createdAt: 'desc' } });
    expect(JSON.parse(audit!.oldValue!)).toEqual({ phone: null });
    expect(JSON.parse(audit!.newValue!)).toEqual({ phone: '0812345678' });
  });
});

// ------------------------------------------------------------------ position
describe('position change', () => {
  it('23–27. valid change closes old row, opens new, one open row, pointers consistent, audited', async () => {
    const before = await as(hr, 'get', `/api/v1/employees/${X}`);
    expect(before.body.data.department.code).toBe('SALES');
    const res = await as(hr, 'patch', `/api/v1/employees/${X}/position`).send({ positionId: posAnalyst });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ position: { code: 'P-ANALYST' }, department: { code: 'DATA' }, organization: { code: 'ACME' } });
    await assertConsistent(X);
    const rows = await prisma.employeePosition.findMany({ where: { employeeId: X }, orderBy: { startDate: 'asc' } });
    expect(rows).toHaveLength(2);
    expect(rows[0].positionId).toBe(posSalesExec);
    expect(rows[0].endDate).not.toBeNull();
    expect(rows[1]).toMatchObject({ positionId: posAnalyst, departmentId: deptData, endDate: null });
    expect(rows[1].startDate.getTime()).toBe(rows[0].endDate!.getTime()); // endDate is the exclusive boundary
    const audit = await prisma.auditLog.findFirst({ where: { action: 'CHANGE_EMPLOYEE_POSITION', recordId: X } });
    expect(JSON.parse(audit!.oldValue!)).toEqual({ organizationId: org, departmentId: deptSales, positionId: posSalesExec });
    expect(JSON.parse(audit!.newValue!)).toMatchObject({ organizationId: org, departmentId: deptData, positionId: posAnalyst });
    const hist = await as(hr, 'get', `/api/v1/employees/${X}/position-history`);
    expect(hist.body.data.map((h: { position: { code: string }; endDate: string | null }) => [h.position.code, h.endDate === null])).toEqual([['P-ANALYST', true], ['P-SALES', false]]); // newest first
  });
  it('28. same position → no duplicate history', async () => {
    const res = await as(hr, 'patch', `/api/v1/employees/${X}/position`).send({ positionId: posAnalyst });
    expect(res.status).toBe(200);
    expect(await prisma.employeePosition.count({ where: { employeeId: X } })).toBe(2);
    expect(await openPositions(X)).toBe(1);
  });
  it('29. inactive position rejected, state unchanged', async () => {
    const res = await as(hr, 'patch', `/api/v1/employees/${X}/position`).send({ positionId: posInactive });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('POSITION_INACTIVE');
    await assertConsistent(X);
    expect(await prisma.employeePosition.count({ where: { employeeId: X } })).toBe(2);
  });
  it('30. move across departments / organizations through a new position (effectiveDate honoured)', async () => {
    const res = await as(hr, 'patch', `/api/v1/employees/${X}/position`).send({ positionId: posSalesExecB, effectiveDate: '2026-03-01' });
    expect(res.status).toBe(200);
    expect(res.body.data.organization.code).toBe('OTHER');
    await assertConsistent(X);
    const open = await prisma.employeePosition.findFirst({ where: { employeeId: X, endDate: null } });
    expect(open!.startDate.toISOString()).toBe(new Date('2026-03-01').toISOString());
    await as(hr, 'patch', `/api/v1/employees/${X}/position`).send({ positionId: posSalesExec }); // back to Sales
  });
  it('31. department head cannot move out until the head is cleared', async () => {
    expect((await as(admin, 'patch', `/api/v1/departments/${deptData}/head`).send({ employeeId: A })).status).toBe(200);
    const res = await as(hr, 'patch', `/api/v1/employees/${A}/position`).send({ positionId: posSalesExec });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EMPLOYEE_IS_DEPARTMENT_HEAD');
    await assertConsistent(A);
    // same department is fine even while head
    expect((await as(hr, 'patch', `/api/v1/employees/${A}/position`).send({ positionId: posAnalyst })).status).toBe(200);
    await as(hr, 'patch', `/api/v1/employees/${A}/position`).send({ positionId: posDataMgr });
    await as(admin, 'patch', `/api/v1/departments/${deptData}/head`).send({ employeeId: null });
    expect((await as(hr, 'patch', `/api/v1/employees/${A}/position`).send({ positionId: posSalesExec })).status).toBe(200);
    await as(hr, 'patch', `/api/v1/employees/${A}/position`).send({ positionId: posDataMgr });
    await assertConsistent(A);
  });
});

// ------------------------------------------------------------------ manager
describe('manager change', () => {
  it('32–35. assign, history created, change closes previous, exactly one open row', async () => {
    expect((await as(hr, 'patch', `/api/v1/employees/${X}/manager`).send({ managerId: A })).status).toBe(200);
    expect(await openManagers(X)).toBe(1);
    await assertConsistent(X);
    const res = await as(hr, 'patch', `/api/v1/employees/${X}/manager`).send({ managerId: B });
    expect(res.status).toBe(200);
    expect(res.body.data.manager.employeeCode).toBe('B');
    const rows = await prisma.employeeManager.findMany({ where: { employeeId: X }, orderBy: { startDate: 'asc' } });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ managerId: A });
    expect(rows[0].endDate).not.toBeNull();
    expect(rows[1]).toMatchObject({ managerId: B, endDate: null });
    await assertConsistent(X);
    const audit = await prisma.auditLog.findFirst({ where: { action: 'CHANGE_EMPLOYEE_MANAGER', recordId: X }, orderBy: { createdAt: 'desc' } });
    expect(JSON.parse(audit!.oldValue!)).toEqual({ managerId: A });
    expect(JSON.parse(audit!.newValue!)).toMatchObject({ managerId: B });
    const hist = await as(hr, 'get', `/api/v1/employees/${X}/manager-history`);
    expect(hist.body.data[0]).toMatchObject({ manager: { employeeCode: 'B', position: { title: 'Data Analyst' } }, endDate: null });
    // same manager → no-op
    await as(hr, 'patch', `/api/v1/employees/${X}/manager`).send({ managerId: B });
    expect(await prisma.employeeManager.count({ where: { employeeId: X } })).toBe(2);
  });
  it('36. clear manager closes history, no null row', async () => {
    const res = await as(hr, 'patch', `/api/v1/employees/${X}/manager`).send({ managerId: null });
    expect(res.status).toBe(200);
    expect(res.body.data.manager).toBeNull();
    expect(await openManagers(X)).toBe(0);
    expect(await prisma.employeeManager.count({ where: { employeeId: X } })).toBe(2);
    await assertConsistent(X);
  });
  it('37. self manager rejected; 38. inactive manager rejected; unknown → 404', async () => {
    const self = await as(hr, 'patch', `/api/v1/employees/${X}/manager`).send({ managerId: X });
    expect(self.status).toBe(400);
    expect(self.body.error.code).toBe('SELF_MANAGER_NOT_ALLOWED');
    const inactive = await mkEmployee('OFF', posSalesExec, null, { status: 'INACTIVE' });
    const res = await as(hr, 'patch', `/api/v1/employees/${X}/manager`).send({ managerId: inactive });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('MANAGER_INACTIVE');
    expect((await as(hr, 'patch', `/api/v1/employees/${X}/manager`).send({ managerId: 'nope' })).body.error.code).toBe('MANAGER_NOT_FOUND');
    expect(await openManagers(X)).toBe(0);
  });
  it('39. A→B, B→C, C→A rejected (also direct A→B→A); 40. valid non-cycle chain allowed', async () => {
    const cycle = await as(hr, 'patch', `/api/v1/employees/${A}/manager`).send({ managerId: C });
    expect(cycle.status).toBe(400);
    expect(cycle.body.error.code).toBe('MANAGER_CYCLE_NOT_ALLOWED');
    expect((await as(hr, 'patch', `/api/v1/employees/${A}/manager`).send({ managerId: B })).body.error.code).toBe('MANAGER_CYCLE_NOT_ALLOWED');
    expect((await prisma.employee.findUniqueOrThrow({ where: { id: A } })).managerId).toBeNull();
    const ok = await as(hr, 'patch', `/api/v1/employees/${A}/manager`).send({ managerId: X }); // X → (none); A → X is fine
    expect(ok.status).toBe(200);
    await assertConsistent(A);
    await as(hr, 'patch', `/api/v1/employees/${A}/manager`).send({ managerId: null });
  });
});

// ------------------------------------------------------------------ activate / deactivate
describe('activate / deactivate', () => {
  it('43. cannot deactivate a manager with active direct reports (EMPLOYEE_IN_USE with details)', async () => {
    const res = await as(admin, 'patch', `/api/v1/employees/${B}/deactivate`); // HR has no employees.activate (matrix)
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EMPLOYEE_IN_USE');
    expect(res.body.error.details).toEqual(expect.arrayContaining([{ field: 'activeDirectReports', message: '1' }, { field: 'headedDepartments', message: '0' }]));
    expect((await prisma.employee.findUniqueOrThrow({ where: { id: B } })).employmentStatus).toBe('ACTIVE');
  });
  it('44. cannot deactivate a department head', async () => {
    await as(admin, 'patch', `/api/v1/departments/${deptSales}/head`).send({ employeeId: X });
    const res = await as(admin, 'patch', `/api/v1/employees/${X}/deactivate`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EMPLOYEE_IN_USE');
    await as(admin, 'patch', `/api/v1/departments/${deptSales}/head`).send({ employeeId: null });
  });
  it('41. deactivate → INACTIVE (not TERMINATED); 45. linked user account untouched', async () => {
    const res = await as(admin, 'patch', `/api/v1/employees/${C}/deactivate`);
    expect(res.status).toBe(200);
    expect(res.body.data.employmentStatus).toBe('INACTIVE');
    const user = await prisma.user.findUniqueOrThrow({ where: { email: 'c@emp.local' } });
    expect(user.isActive).toBe(true);
    expect((await request(app).get('/api/v1/auth/me').set('Cookie', cSelf.cookie)).status).toBe(200); // session still valid
    expect(await prisma.auditLog.count({ where: { action: 'DEACTIVATE_EMPLOYEE', recordId: C } })).toBe(1);
    // and the reverse: deactivating the USER must not touch employmentStatus
    await as(admin, 'patch', `/api/v1/users/${user.id}/deactivate`);
    expect((await prisma.employee.findUniqueOrThrow({ where: { id: C } })).employmentStatus).toBe('INACTIVE');
    await as(admin, 'patch', `/api/v1/users/${user.id}/activate`);
    cSelf = await loginAs(app, 'c@emp.local', PW); // deactivating the account revoked C's session
  });
  it('46. activation rejected if position inactive; 47. if manager inactive; 42/48. successful reactivation, account unchanged', async () => {
    await prisma.position.update({ where: { id: posAnalyst }, data: { isActive: false } }); // C's position
    const pos = await as(admin, 'patch', `/api/v1/employees/${C}/activate`);
    expect(pos.status).toBe(409);
    expect(pos.body.error.code).toBe('EMPLOYEE_POSITION_INACTIVE');
    await prisma.position.update({ where: { id: posAnalyst }, data: { isActive: true } });

    await prisma.employee.update({ where: { id: B }, data: { employmentStatus: 'INACTIVE' } }); // C's manager
    const mgr = await as(admin, 'patch', `/api/v1/employees/${C}/activate`);
    expect(mgr.status).toBe(409);
    expect(mgr.body.error.code).toBe('EMPLOYEE_MANAGER_INACTIVE');
    await prisma.employee.update({ where: { id: B }, data: { employmentStatus: 'ACTIVE' } });

    const userBefore = await prisma.user.findUniqueOrThrow({ where: { email: 'c@emp.local' } });
    await prisma.user.update({ where: { id: userBefore.id }, data: { isActive: false } });
    const ok = await as(admin, 'patch', `/api/v1/employees/${C}/activate`);
    expect(ok.status).toBe(200);
    expect(ok.body.data.employmentStatus).toBe('ACTIVE');
    expect((await prisma.user.findUniqueOrThrow({ where: { id: userBefore.id } })).isActive).toBe(false); // not restored
    await prisma.user.update({ where: { id: userBefore.id }, data: { isActive: true } });
    await assertConsistent(C);
  });
});

// ------------------------------------------------------------------ department head
describe('department head', () => {
  it('49. assign valid head; shows on department + employee detail; 54. manager relationships unchanged', async () => {
    const snapshot = await prisma.employee.findMany({ select: { id: true, managerId: true }, orderBy: { id: 'asc' } });
    const res = await as(admin, 'patch', `/api/v1/departments/${deptData}/head`).send({ employeeId: A });
    expect(res.status).toBe(200);
    expect(res.body.data.headEmployee.employeeCode).toBe('A');
    expect((await as(hr, 'get', `/api/v1/employees/${A}`)).body.data.headOfDepartments).toEqual([{ id: deptData, code: 'DATA', name: 'Data' }]);
    expect(await prisma.employee.findMany({ select: { id: true, managerId: true }, orderBy: { id: 'asc' } })).toEqual(snapshot);
    const audit = await prisma.auditLog.findFirst({ where: { action: 'UPDATE_DEPARTMENT_HEAD', recordId: deptData }, orderBy: { createdAt: 'desc' } });
    expect(JSON.parse(audit!.newValue!)).toEqual({ headEmployeeId: A });
  });
  it('51. inactive employee rejected; 52. other organization rejected; 53. other department rejected', async () => {
    const inactive = await prisma.employee.findUniqueOrThrow({ where: { employeeCode: 'OFF' } });
    expect((await as(admin, 'patch', `/api/v1/departments/${deptData}/head`).send({ employeeId: inactive.id })).body.error.code).toBe('EMPLOYEE_INACTIVE');
    expect((await as(admin, 'patch', `/api/v1/departments/${deptSalesB}/head`).send({ employeeId: A })).body.error.code).toBe('HEAD_ORGANIZATION_MISMATCH');
    expect((await as(admin, 'patch', `/api/v1/departments/${deptSales}/head`).send({ employeeId: A })).body.error.code).toBe('HEAD_DEPARTMENT_MISMATCH');
    expect((await as(admin, 'patch', `/api/v1/departments/${deptData}/head`).send({ employeeId: 'nope' })).status).toBe(404);
  });
  it('50. clear head; requires organization.manage', async () => {
    expect((await as(hr, 'patch', `/api/v1/departments/${deptData}/head`).send({ employeeId: null })).status).toBe(403); // HR has organization.view only
    const res = await as(admin, 'patch', `/api/v1/departments/${deptData}/head`).send({ employeeId: null });
    expect(res.status).toBe(200);
    expect(res.body.data.headEmployee).toBeNull();
  });
});

// ------------------------------------------------------------------ security / scope on mutations
describe('scope on mutations', () => {
  it('55. SELF user cannot update another employee (403 by permission; scope-aware service returns 404 if granted)', async () => {
    expect((await as(cSelf, 'patch', `/api/v1/employees/${B}`).send({ nickname: 'x' })).status).toBe(403);
    // grant employees.update to EMPLOYEE temporarily → service scope still hides B
    const role = await prisma.role.findUniqueOrThrow({ where: { code: 'EMPLOYEE' } });
    const perm = await prisma.permission.findUniqueOrThrow({ where: { code: 'employees.update' } });
    await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: perm.id } });
    const res = await as(cSelf, 'patch', `/api/v1/employees/${B}`).send({ nickname: 'x' });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('EMPLOYEE_NOT_FOUND');
    expect((await as(cSelf, 'patch', `/api/v1/employees/${C}`).send({ nickname: 'me' })).status).toBe(200);
    await prisma.rolePermission.delete({ where: { roleId_permissionId: { roleId: role.id, permissionId: perm.id } } });
  });
  it('56. TEAM manager cannot update unrelated employee', async () => {
    expect((await as(aTeam, 'patch', `/api/v1/employees/${X}`).send({ nickname: 'x' })).status).toBe(403);
    const role = await prisma.role.findUniqueOrThrow({ where: { code: 'MANAGER' } });
    const perm = await prisma.permission.findUniqueOrThrow({ where: { code: 'employees.update' } });
    await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: perm.id } });
    expect((await as(aTeam, 'patch', `/api/v1/employees/${X}/manager`).send({ managerId: null })).status).toBe(404);
    expect((await as(aTeam, 'patch', `/api/v1/employees/${C}/position`).send({ positionId: posSalesExec })).status).toBe(404);
    expect((await as(aTeam, 'patch', `/api/v1/employees/${B}`).send({ nickname: 'report' })).status).toBe(200);
    await prisma.rolePermission.delete({ where: { roleId_permissionId: { roleId: role.id, permissionId: perm.id } } });
  });
  it('mutations require their permissions (HR cannot activate; noPerm cannot create)', async () => {
    expect((await as(hr, 'patch', `/api/v1/employees/${X}/deactivate`)).status).toBe(403);
    expect((await as(noPerm, 'post', '/api/v1/employees').send({})).status).toBe(403);
  });
});
