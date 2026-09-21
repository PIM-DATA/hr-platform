import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { prisma } from '../src/lib/prisma';
import { cleanUsers, createUser, ensureRoles, loginAs, resetDatabase } from './helpers';

const app = createApp();
const PW = 'Correct-Horse-1';
type Session = { cookie: string; csrf: string };
let admin: Session; // organization.manage
let viewer: Session; // EMPLOYEE → organization.view only
let noAccess: Session; // custom role without organization.*

const as = (s: Session, m: 'get' | 'post' | 'patch', url: string) => request(app)[m](url).set('Cookie', s.cookie).set('x-csrf-token', s.csrf);

beforeAll(async () => {
  await resetDatabase();
  const dash = await prisma.permission.findUniqueOrThrow({ where: { code: 'dashboard.view' } });
  await prisma.role.upsert({ where: { code: 'NO_ORG' }, update: {}, create: { code: 'NO_ORG', name: 'No org access', dataScope: 'SELF', rolePermissions: { create: [{ permissionId: dash.id }] } } });
  await createUser({ email: 'admin@org.local', password: PW, role: 'SYSTEM_ADMIN' });
  await createUser({ email: 'viewer@org.local', password: PW, role: 'EMPLOYEE' });
  await createUser({ email: 'none@org.local', password: PW, role: 'NO_ORG' });
  admin = await loginAs(app, 'admin@org.local', PW);
  viewer = await loginAs(app, 'viewer@org.local', PW);
  noAccess = await loginAs(app, 'none@org.local', PW);
});
afterAll(async () => {
  await resetDatabase();
  await prisma.$disconnect();
});

// ------------------------------------------------------------------ permissions
describe('permissions', () => {
  it('1. unauthenticated → 401', async () => {
    for (const url of ['/api/v1/organizations', '/api/v1/departments', '/api/v1/jobs', '/api/v1/positions', '/api/v1/organization/tree']) {
      expect((await request(app).get(url)).status).toBe(401);
    }
  });
  it('2. without organization.view → 403', async () => {
    for (const url of ['/api/v1/organizations', '/api/v1/departments', '/api/v1/jobs', '/api/v1/positions', '/api/v1/organization/tree']) {
      expect((await as(noAccess, 'get', url)).status).toBe(403);
    }
  });
  it('3. organization.view → GET allowed; 4. mutation → 403', async () => {
    expect((await as(viewer, 'get', '/api/v1/organizations')).status).toBe(200);
    expect((await as(viewer, 'get', '/api/v1/organization/tree')).status).toBe(200);
    expect((await as(viewer, 'post', '/api/v1/organizations').send({ code: 'X', name: 'X' })).status).toBe(403);
    expect((await as(viewer, 'post', '/api/v1/jobs').send({ code: 'X', title: 'X' })).status).toBe(403);
    expect((await as(viewer, 'patch', '/api/v1/organizations/any/deactivate')).status).toBe(403);
  });
  it('5. organization.manage → mutation allowed', async () => {
    const res = await as(admin, 'post', '/api/v1/organizations').send({ code: 'perm-co', name: 'Perm Co' });
    expect(res.status).toBe(201);
    expect(res.body.data.code).toBe('PERM-CO'); // normalized
    await prisma.organization.delete({ where: { id: res.body.data.id } });
  });
});

// ------------------------------------------------------------------ organizations
describe('organizations', () => {
  let orgId: string;
  it('6. create organization (201, audited)', async () => {
    const res = await as(admin, 'post', '/api/v1/organizations').send({ code: ' acme ', name: ' ACME Ltd ' });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ code: 'ACME', name: 'ACME Ltd', isActive: true, departmentCount: 0, employeeCount: 0 });
    orgId = res.body.data.id;
    expect(await prisma.auditLog.count({ where: { action: 'CREATE_ORGANIZATION', recordId: orgId } })).toBe(1);
  });
  it('7. duplicate code → 409 ORGANIZATION_CODE_EXISTS', async () => {
    const res = await as(admin, 'post', '/api/v1/organizations').send({ code: 'acme', name: 'Other' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ORGANIZATION_CODE_EXISTS');
  });
  it('validation → 400 (bad code chars, empty name)', async () => {
    const res = await as(admin, 'post', '/api/v1/organizations').send({ code: 'bad code!', name: '' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
  it('8. update organization → field diff audited', async () => {
    const res = await as(admin, 'patch', `/api/v1/organizations/${orgId}`).send({ name: 'ACME Limited' });
    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe('ACME Limited');
    const audit = await prisma.auditLog.findFirst({ where: { action: 'UPDATE_ORGANIZATION', recordId: orgId } });
    expect(JSON.parse(audit!.oldValue!)).toEqual({ name: 'ACME Ltd' });
    expect(JSON.parse(audit!.newValue!)).toEqual({ name: 'ACME Limited' });
  });
  it('9. deactivate empty organization; 11. activate again', async () => {
    const off = await as(admin, 'patch', `/api/v1/organizations/${orgId}/deactivate`);
    expect(off.status).toBe(200);
    expect(off.body.data.isActive).toBe(false);
    const list = await as(admin, 'get', '/api/v1/organizations?status=inactive');
    expect(list.body.data.map((o: { id: string }) => o.id)).toContain(orgId);
    const on = await as(admin, 'patch', `/api/v1/organizations/${orgId}/activate`);
    expect(on.status).toBe(200);
    expect(on.body.data.isActive).toBe(true);
    expect(await prisma.auditLog.count({ where: { recordId: orgId, action: { in: ['DEACTIVATE_ORGANIZATION', 'ACTIVATE_ORGANIZATION'] } } })).toBe(2);
  });
  it('10. cannot deactivate organization with active departments → 409 ORGANIZATION_IN_USE', async () => {
    const dept = await as(admin, 'post', '/api/v1/departments').send({ organizationId: orgId, code: 'HQ', name: 'Head Office' });
    expect(dept.status).toBe(201);
    const res = await as(admin, 'patch', `/api/v1/organizations/${orgId}/deactivate`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ORGANIZATION_IN_USE');
    expect(res.body.error.message).toContain('1 active department');
  });
  it('404 ORGANIZATION_NOT_FOUND', async () => {
    expect((await as(admin, 'get', '/api/v1/organizations/nope')).body.error.code).toBe('ORGANIZATION_NOT_FOUND');
    const dept = await as(admin, 'post', '/api/v1/departments').send({ organizationId: 'nope', code: 'X', name: 'X' });
    expect(dept.status).toBe(404);
    expect(dept.body.error.code).toBe('ORGANIZATION_NOT_FOUND');
  });
  it('list: search / status / sort whitelist / pagination', async () => {
    await as(admin, 'post', '/api/v1/organizations').send({ code: 'ZED', name: 'Zed Corp' });
    const search = await as(admin, 'get', '/api/v1/organizations?search=zed');
    expect(search.body.meta.total).toBe(1);
    const sorted = await as(admin, 'get', '/api/v1/organizations?sortBy=code&sortDir=desc&pageSize=1');
    expect(sorted.body.data[0].code).toBe('ZED');
    expect(sorted.body.meta).toEqual({ page: 1, pageSize: 1, total: 2 });
    expect((await as(admin, 'get', '/api/v1/organizations?sortBy=id')).status).toBe(400);
  });
});

// ------------------------------------------------------------------ departments
describe('departments', () => {
  let orgA: string, orgB: string, root: string, child: string, grandchild: string;
  beforeAll(async () => {
    orgA = (await prisma.organization.findUniqueOrThrow({ where: { code: 'ACME' } })).id;
    orgB = (await prisma.organization.findUniqueOrThrow({ where: { code: 'ZED' } })).id;
    root = (await prisma.department.findUniqueOrThrow({ where: { organizationId_code: { organizationId: orgA, code: 'HQ' } } })).id;
  });

  it('12. create root department (already covered) + 13. create child + grandchild', async () => {
    const c = await as(admin, 'post', '/api/v1/departments').send({ organizationId: orgA, parentId: root, code: 'SALES', name: 'Sales' });
    expect(c.status).toBe(201);
    expect(c.body.data.parent).toMatchObject({ code: 'HQ' });
    child = c.body.data.id;
    const g = await as(admin, 'post', '/api/v1/departments').send({ organizationId: orgA, parentId: child, code: 'SALES-BKK', name: 'Sales Bangkok' });
    expect(g.status).toBe(201);
    grandchild = g.body.data.id;
    const one = await as(admin, 'get', `/api/v1/departments/${root}`);
    expect(one.body.data.childCount).toBe(1);
  });
  it('department code unique within organization only', async () => {
    const dup = await as(admin, 'post', '/api/v1/departments').send({ organizationId: orgA, code: 'sales', name: 'Dup' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('DEPARTMENT_CODE_EXISTS');
    const other = await as(admin, 'post', '/api/v1/departments').send({ organizationId: orgB, code: 'SALES', name: 'Zed Sales' });
    expect(other.status).toBe(201);
  });
  it('14. parent must be in the same organization → 400 PARENT_ORGANIZATION_MISMATCH', async () => {
    const res = await as(admin, 'post', '/api/v1/departments').send({ organizationId: orgB, parentId: root, code: 'X', name: 'X' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('PARENT_ORGANIZATION_MISMATCH');
    const move = await as(admin, 'patch', `/api/v1/departments/${child}`).send({ parentId: (await prisma.department.findFirstOrThrow({ where: { organizationId: orgB } })).id });
    expect(move.body.error.code).toBe('PARENT_ORGANIZATION_MISMATCH');
  });
  it('15. self-parent rejected → 400 SELF_PARENT_NOT_ALLOWED', async () => {
    const res = await as(admin, 'patch', `/api/v1/departments/${child}`).send({ parentId: child });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('SELF_PARENT_NOT_ALLOWED');
  });
  it('16. circular hierarchy rejected → 400 CIRCULAR_HIERARCHY (HQ → Sales → BKK; set HQ.parent = BKK)', async () => {
    const res = await as(admin, 'patch', `/api/v1/departments/${root}`).send({ parentId: grandchild });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CIRCULAR_HIERARCHY');
    const direct = await as(admin, 'patch', `/api/v1/departments/${child}`).send({ parentId: grandchild });
    expect(direct.body.error.code).toBe('CIRCULAR_HIERARCHY');
    expect((await prisma.department.findUniqueOrThrow({ where: { id: root } })).parentId).toBeNull();
  });
  it('17. move department (valid) → audited diff; move to root with parentId null', async () => {
    const res = await as(admin, 'patch', `/api/v1/departments/${grandchild}`).send({ parentId: root });
    expect(res.status).toBe(200);
    expect(res.body.data.parent.code).toBe('HQ');
    const audit = await prisma.auditLog.findFirst({ where: { action: 'UPDATE_DEPARTMENT', recordId: grandchild } });
    expect(JSON.parse(audit!.oldValue!)).toEqual({ parentId: child });
    expect(JSON.parse(audit!.newValue!)).toEqual({ parentId: root });
    const toRoot = await as(admin, 'patch', `/api/v1/departments/${grandchild}`).send({ parentId: null });
    expect(toRoot.body.data.parentId).toBeNull();
    await as(admin, 'patch', `/api/v1/departments/${grandchild}`).send({ parentId: child }); // restore HQ → Sales → BKK
  });
  it('unknown parent → 404 PARENT_DEPARTMENT_NOT_FOUND', async () => {
    const res = await as(admin, 'post', '/api/v1/departments').send({ organizationId: orgA, parentId: 'nope', code: 'X', name: 'X' });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('PARENT_DEPARTMENT_NOT_FOUND');
  });
  it('18. inactive parent rejected; inactive organization rejected', async () => {
    const zedRoot = await prisma.department.findFirstOrThrow({ where: { organizationId: orgB } });
    await as(admin, 'patch', `/api/v1/departments/${zedRoot.id}/deactivate`);
    const res = await as(admin, 'post', '/api/v1/departments').send({ organizationId: orgB, parentId: zedRoot.id, code: 'X', name: 'X' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PARENT_DEPARTMENT_INACTIVE');
    await as(admin, 'patch', `/api/v1/organizations/${orgB}/deactivate`);
    const res2 = await as(admin, 'post', '/api/v1/departments').send({ organizationId: orgB, code: 'Y', name: 'Y' });
    expect(res2.status).toBe(409);
    expect(res2.body.error.code).toBe('ORGANIZATION_INACTIVE');
    // reactivating a department under an inactive org is refused too
    const act = await as(admin, 'patch', `/api/v1/departments/${zedRoot.id}/activate`);
    expect(act.body.error.code).toBe('ORGANIZATION_INACTIVE');
  });
  it('19. cannot deactivate department with active child → 409 DEPARTMENT_IN_USE', async () => {
    const res = await as(admin, 'patch', `/api/v1/departments/${child}/deactivate`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('DEPARTMENT_IN_USE');
    expect(res.body.error.message).toContain('sub-department');
  });
  it('20. cannot deactivate department with active position; 21. with active employee', async () => {
    const job = await as(admin, 'post', '/api/v1/jobs').send({ code: 'SE', title: 'Sales Executive', level: 2 });
    const pos = await as(admin, 'post', '/api/v1/positions').send({ departmentId: grandchild, jobId: job.body.data.id, code: 'POS-SE-BKK', title: 'Sales Executive BKK' });
    expect(pos.status).toBe(201);
    const withPos = await as(admin, 'patch', `/api/v1/departments/${grandchild}/deactivate`);
    expect(withPos.body.error.code).toBe('DEPARTMENT_IN_USE');
    expect(withPos.body.error.message).toContain('position');

    await prisma.employee.create({ data: { employeeCode: 'E1', firstName: 'A', lastName: 'B', email: 'e1@org.local', hireDate: new Date(), organizationId: orgA, departmentId: grandchild, positionId: pos.body.data.id } });
    await prisma.position.update({ where: { id: pos.body.data.id }, data: { isActive: false } }); // bypass so only the employee blocks
    const withEmp = await as(admin, 'patch', `/api/v1/departments/${grandchild}/deactivate`);
    expect(withEmp.body.error.code).toBe('DEPARTMENT_IN_USE');
    expect(withEmp.body.error.message).toContain('employee');
    await prisma.position.update({ where: { id: pos.body.data.id }, data: { isActive: true } });
  });
  it('GET /organizations/:id/departments + filters', async () => {
    const res = await as(admin, 'get', `/api/v1/organizations/${orgA}/departments?parentId=${root}`);
    expect(res.status).toBe(200);
    expect(res.body.data.map((d: { code: string }) => d.code)).toEqual(['SALES']);
    const all = await as(admin, 'get', `/api/v1/departments?organizationId=${orgA}&status=active`);
    expect(all.body.meta.total).toBe(3);
  });
});

// ------------------------------------------------------------------ jobs
describe('jobs', () => {
  it('22. create job; 23. duplicate code; 24. update', async () => {
    const res = await as(admin, 'post', '/api/v1/jobs').send({ code: 'da', title: 'Data Analyst', level: 3, description: 'Analyses data' });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ code: 'DA', title: 'Data Analyst', level: 3, positionCount: 0 });
    expect((await as(admin, 'post', '/api/v1/jobs').send({ code: 'DA', title: 'Dup' })).body.error.code).toBe('JOB_CODE_EXISTS');
    const upd = await as(admin, 'patch', `/api/v1/jobs/${res.body.data.id}`).send({ level: 4, description: null });
    expect(upd.status).toBe(200);
    expect(upd.body.data).toMatchObject({ level: 4, description: null });
    const audit = await prisma.auditLog.findFirst({ where: { action: 'UPDATE_JOB', recordId: res.body.data.id } });
    expect(JSON.parse(audit!.newValue!)).toEqual({ level: 4, description: null });
  });
  it('25. cannot deactivate job in use → 409 JOB_IN_USE; 26. deactivate unused job', async () => {
    const se = await prisma.job.findUniqueOrThrow({ where: { code: 'SE' } });
    const res = await as(admin, 'patch', `/api/v1/jobs/${se.id}/deactivate`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('JOB_IN_USE');
    const da = await prisma.job.findUniqueOrThrow({ where: { code: 'DA' } });
    const ok = await as(admin, 'patch', `/api/v1/jobs/${da.id}/deactivate`);
    expect(ok.status).toBe(200);
    expect(ok.body.data.isActive).toBe(false);
  });
});

// ------------------------------------------------------------------ positions
describe('positions', () => {
  let dept: string, jobSE: string, jobDA: string;
  beforeAll(async () => {
    dept = (await prisma.department.findFirstOrThrow({ where: { code: 'SALES' } })).id;
    jobSE = (await prisma.job.findUniqueOrThrow({ where: { code: 'SE' } })).id;
    jobDA = (await prisma.job.findUniqueOrThrow({ where: { code: 'DA' } })).id; // inactive
  });
  it('27. create position with derived organization', async () => {
    const res = await as(admin, 'post', '/api/v1/positions').send({ departmentId: dept, jobId: jobSE, code: 'POS-SE-1', title: 'Sales Executive' });
    expect(res.status).toBe(201);
    expect(res.body.data.department.organization.code).toBe('ACME');
    expect(res.body.data.job.code).toBe('SE');
    expect((await as(admin, 'post', '/api/v1/positions').send({ departmentId: dept, jobId: jobSE, code: 'pos-se-1', title: 'Dup' })).body.error.code).toBe('POSITION_CODE_EXISTS');
  });
  it('28. invalid department → 404; 29. invalid job → 404', async () => {
    const d = await as(admin, 'post', '/api/v1/positions').send({ departmentId: 'nope', jobId: jobSE, code: 'P1', title: 'X' });
    expect(d.status).toBe(404);
    expect(d.body.error.code).toBe('DEPARTMENT_NOT_FOUND');
    const j = await as(admin, 'post', '/api/v1/positions').send({ departmentId: dept, jobId: 'nope', code: 'P1', title: 'X' });
    expect(j.status).toBe(404);
    expect(j.body.error.code).toBe('JOB_NOT_FOUND');
    expect((await as(admin, 'post', '/api/v1/positions').send({ departmentId: dept, code: 'P1', title: 'X' })).status).toBe(400); // jobId required
  });
  it('30. inactive department rejected; 31. inactive job rejected', async () => {
    const zedDept = await prisma.department.findFirstOrThrow({ where: { code: 'SALES', isActive: false } });
    const d = await as(admin, 'post', '/api/v1/positions').send({ departmentId: zedDept.id, jobId: jobSE, code: 'P2', title: 'X' });
    expect(d.status).toBe(409);
    expect(d.body.error.code).toBe('DEPARTMENT_INACTIVE');
    const j = await as(admin, 'post', '/api/v1/positions').send({ departmentId: dept, jobId: jobDA, code: 'P2', title: 'X' });
    expect(j.status).toBe(409);
    expect(j.body.error.code).toBe('JOB_INACTIVE');
  });
  it('32. update position (title, move department) → audited diff', async () => {
    const pos = await prisma.position.findUniqueOrThrow({ where: { code: 'POS-SE-1' } });
    const hq = await prisma.department.findFirstOrThrow({ where: { code: 'HQ' } });
    const res = await as(admin, 'patch', `/api/v1/positions/${pos.id}`).send({ title: 'Senior Sales Executive', departmentId: hq.id });
    expect(res.status).toBe(200);
    expect(res.body.data.department.code).toBe('HQ');
    const audit = await prisma.auditLog.findFirst({ where: { action: 'UPDATE_POSITION', recordId: pos.id } });
    expect(JSON.parse(audit!.newValue!)).toEqual({ departmentId: hq.id, title: 'Senior Sales Executive' });
    expect((await as(admin, 'patch', `/api/v1/positions/${pos.id}`).send({ jobId: jobDA })).body.error.code).toBe('JOB_INACTIVE');
  });
  it('33. cannot deactivate position with active employee → 409 POSITION_IN_USE; 34. deactivate unused', async () => {
    const held = await prisma.position.findUniqueOrThrow({ where: { code: 'POS-SE-BKK' } });
    const res = await as(admin, 'patch', `/api/v1/positions/${held.id}/deactivate`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('POSITION_IN_USE');
    const free = await prisma.position.findUniqueOrThrow({ where: { code: 'POS-SE-1' } });
    const ok = await as(admin, 'patch', `/api/v1/positions/${free.id}/deactivate`);
    expect(ok.status).toBe(200);
    expect(ok.body.data.isActive).toBe(false);
    const back = await as(admin, 'patch', `/api/v1/positions/${free.id}/activate`);
    expect(back.body.data.isActive).toBe(true);
  });
  it('list filters: organizationId / departmentId / jobId / status / search', async () => {
    const orgA = (await prisma.organization.findUniqueOrThrow({ where: { code: 'ACME' } })).id;
    expect((await as(admin, 'get', `/api/v1/positions?organizationId=${orgA}`)).body.meta.total).toBe(2);
    expect((await as(admin, 'get', `/api/v1/positions?jobId=${jobSE}&status=active`)).body.meta.total).toBe(2);
    expect((await as(admin, 'get', `/api/v1/positions?search=BKK`)).body.meta.total).toBe(1);
    expect((await as(admin, 'get', `/api/v1/positions?departmentId=nope`)).body.meta.total).toBe(0);
  });
});

// ------------------------------------------------------------------ position structure protection (Task 4.1)
describe('position structural fields are frozen once assigned', () => {
  let sales: string, hq: string, jobSE: string, jobDA: string, orgA: string;
  beforeAll(async () => {
    sales = (await prisma.department.findFirstOrThrow({ where: { code: 'SALES', isActive: true } })).id;
    hq = (await prisma.department.findFirstOrThrow({ where: { code: 'HQ' } })).id;
    jobSE = (await prisma.job.findUniqueOrThrow({ where: { code: 'SE' } })).id;
    orgA = (await prisma.organization.findUniqueOrThrow({ where: { code: 'ACME' } })).id;
    const da = await prisma.job.findUniqueOrThrow({ where: { code: 'DA' } });
    await prisma.job.update({ where: { id: da.id }, data: { isActive: true } });
    jobDA = da.id;
  });
  afterAll(async () => {
    // remove fixtures created by this block so the tree assertions below see the original structure
    await prisma.employeePosition.deleteMany({ where: { position: { code: 'POS-HIST' } } });
    await prisma.position.deleteMany({ where: { code: { in: ['POS-FREE', 'POS-HIST'] } } });
  });
  const snapshotEmployees = () => prisma.employee.findMany({ select: { id: true, organizationId: true, departmentId: true, positionId: true, managerId: true, updatedAt: true }, orderBy: { id: 'asc' } });

  it('unused position can change department and job', async () => {
    const pos = await as(admin, 'post', '/api/v1/positions').send({ departmentId: sales, jobId: jobSE, code: 'POS-FREE', title: 'Free seat' });
    const res = await as(admin, 'patch', `/api/v1/positions/${pos.body.data.id}`).send({ departmentId: hq, jobId: jobDA });
    expect(res.status).toBe(200);
    expect(res.body.data.department.code).toBe('HQ');
    expect(res.body.data.job.code).toBe('DA');
  });

  it('position held as CURRENT assignment cannot change department; employees untouched', async () => {
    const held = await prisma.position.findUniqueOrThrow({ where: { code: 'POS-SE-BKK' } }); // E1's current position
    const before = await snapshotEmployees();
    const res = await as(admin, 'patch', `/api/v1/positions/${held.id}`).send({ departmentId: hq });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('POSITION_ASSIGNMENT_IN_USE');
    expect(res.body.error.message).toContain('1 current');
    expect((await prisma.position.findUniqueOrThrow({ where: { id: held.id } })).departmentId).toBe(held.departmentId);
    expect(await snapshotEmployees()).toEqual(before); // no silent cascade
  });

  it('position that only appears in HISTORY cannot change department', async () => {
    const pos = await as(admin, 'post', '/api/v1/positions').send({ departmentId: sales, jobId: jobSE, code: 'POS-HIST', title: 'Former seat' });
    const emp = await prisma.employee.findFirstOrThrow({ where: { employeeCode: 'E1' } });
    await prisma.employeePosition.create({ data: { employeeId: emp.id, positionId: pos.body.data.id, departmentId: sales, startDate: new Date('2020-01-01'), endDate: new Date('2021-01-01') } });
    const res = await as(admin, 'patch', `/api/v1/positions/${pos.body.data.id}`).send({ departmentId: hq });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('POSITION_ASSIGNMENT_IN_USE');
    expect(res.body.error.message).toContain('1 historical');
  });

  it('used position cannot change job either', async () => {
    const held = await prisma.position.findUniqueOrThrow({ where: { code: 'POS-SE-BKK' } });
    const res = await as(admin, 'patch', `/api/v1/positions/${held.id}`).send({ jobId: jobDA });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('POSITION_ASSIGNMENT_IN_USE');
    expect((await prisma.position.findUniqueOrThrow({ where: { id: held.id } })).jobId).toBe(held.jobId);
  });

  it('used position can still change cosmetic fields (title/code) and status', async () => {
    const held = await prisma.position.findUniqueOrThrow({ where: { code: 'POS-SE-BKK' } });
    const res = await as(admin, 'patch', `/api/v1/positions/${held.id}`).send({ title: 'Sales Executive — Bangkok', code: 'POS-SE-BKK' });
    expect(res.status).toBe(200);
    expect(res.body.data.title).toBe('Sales Executive — Bangkok');
    // sending the SAME department/job is not a structural change
    const same = await as(admin, 'patch', `/api/v1/positions/${held.id}`).send({ departmentId: held.departmentId, jobId: held.jobId });
    expect(same.status).toBe(200);
    expect(orgA).toBeDefined();
  });
});

// ------------------------------------------------------------------ tree
describe('organization tree', () => {
  it('35–37. nesting, multi-level, positions under the right department; 39. no duplicates', async () => {
    const res = await as(viewer, 'get', '/api/v1/organization/tree');
    expect(res.status).toBe(200);
    const acme = res.body.data.find((o: { code: string }) => o.code === 'ACME');
    expect(acme).toBeDefined();
    expect(acme.departments.map((d: { code: string }) => d.code)).toEqual(['HQ']); // only roots at top level
    const hq = acme.departments[0];
    expect(hq.children.map((d: { code: string }) => d.code)).toEqual(['SALES']);
    expect(hq.children[0].children.map((d: { code: string }) => d.code)).toEqual(['SALES-BKK']);
    expect(hq.positions.map((p: { code: string }) => p.code)).toEqual(['POS-SE-1']);
    expect(hq.children[0].children[0].positions[0]).toMatchObject({ code: 'POS-SE-BKK', job: { code: 'SE' } });

    const ids: string[] = [];
    const walk = (d: { id: string; children: typeof d[]; positions: { id: string }[] }) => { ids.push(d.id, ...d.positions.map((p) => p.id)); d.children.forEach(walk); };
    acme.departments.forEach(walk);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it('38. organizationId filter', async () => {
    const orgA = (await prisma.organization.findUniqueOrThrow({ where: { code: 'ACME' } })).id;
    const res = await as(viewer, 'get', `/api/v1/organization/tree?organizationId=${orgA}`);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].code).toBe('ACME');
    expect((await as(viewer, 'get', '/api/v1/organization/tree?organizationId=nope')).body.data).toEqual([]);
  });
  it('40. inactive policy: hidden by default, included with includeInactive=true', async () => {
    const def = await as(viewer, 'get', '/api/v1/organization/tree');
    expect(def.body.data.map((o: { code: string }) => o.code)).toEqual(['ACME']); // ZED is inactive
    const all = await as(viewer, 'get', '/api/v1/organization/tree?includeInactive=true');
    expect(all.body.data.map((o: { code: string }) => o.code)).toEqual(['ACME', 'ZED']);
    const zed = all.body.data[1];
    expect(zed.isActive).toBe(false);
    expect(zed.departments[0]).toMatchObject({ code: 'SALES', isActive: false });
  });
});
