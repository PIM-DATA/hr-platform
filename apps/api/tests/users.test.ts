import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma';
import { cleanUsers, createTestServer, createUser, ensureRoles, loginAs, resetDatabase, sessionCookie } from './helpers';

const app = createTestServer();
const PW = 'Correct-Horse-1';
const ADMIN = 'sysadmin@users.local';
let admin: { cookie: string; csrf: string; user: { id: string } };

const authed = (m: 'get' | 'post' | 'patch', url: string, a = admin) => request(app)[m](url).set('Cookie', a.cookie).set('x-csrf-token', a.csrf);

beforeAll(async () => {
  await resetDatabase();
  await createUser({ email: ADMIN, password: PW, role: 'SYSTEM_ADMIN' });
  await createUser({ email: 'hradmin@users.local', password: PW, role: 'HR_ADMIN' });
  await createUser({ email: 'employee@users.local', password: PW, role: 'EMPLOYEE' });
  admin = await loginAs(app, ADMIN, PW);
});
afterAll(async () => {
  await resetDatabase();
  await prisma.$disconnect();
});

describe('create user', () => {
  it('11. create user success (201) — 13. no password fields in response — 14. roles assigned', async () => {
    const res = await authed('post', '/api/v1/users').send({ email: '  New.User@Users.Local ', password: PW, roleCodes: ['HR', 'MANAGER'] });
    expect(res.status).toBe(201);
    expect(res.body.data.email).toBe('new.user@users.local'); // normalized
    expect(res.body.data.roles.map((r: { code: string }) => r.code)).toEqual(['HR', 'MANAGER']);
    expect(JSON.stringify(res.body)).not.toMatch(/password|Hash|token/i);

    const stored = await prisma.user.findUniqueOrThrow({ where: { email: 'new.user@users.local' } });
    expect(stored.passwordHash).toMatch(/^\$2[aby]\$12\$/);
    expect(stored.passwordHash).not.toBe(PW);

    const audit = await prisma.auditLog.findFirst({ where: { action: 'CREATE_USER', recordId: stored.id } });
    expect(audit).not.toBeNull();
    expect(audit!.newValue).not.toMatch(/password|\$2[aby]\$/i);
    expect(JSON.parse(audit!.newValue!).roles).toEqual(['HR', 'MANAGER']);
  });

  it('12. duplicate email → 409 EMAIL_ALREADY_EXISTS', async () => {
    const res = await authed('post', '/api/v1/users').send({ email: 'NEW.USER@users.local', password: PW, roleCodes: ['HR'] });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EMAIL_ALREADY_EXISTS');
  });

  it('22. invalid role → 400 INVALID_ROLE and nothing is created (transaction)', async () => {
    const res = await authed('post', '/api/v1/users').send({ email: 'bad.role@users.local', password: PW, roleCodes: ['HR', 'NOT_A_ROLE'] });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_ROLE');
    expect(await prisma.user.findUnique({ where: { email: 'bad.role@users.local' } })).toBeNull();
  });

  it('validation: short password / no roles → 400', async () => {
    const res = await authed('post', '/api/v1/users').send({ email: 'v@users.local', password: 'short', roleCodes: [] });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details.map((d: { field: string }) => d.field)).toEqual(expect.arrayContaining(['password', 'roleCodes']));
  });

  it('links an employee (and refuses to link the same employee twice)', async () => {
    const employee = await prisma.employee.findFirst({ where: { user: null } });
    if (!employee) {
      // test DB has no seeded employees; create a minimal one
      const org = await prisma.organization.create({ data: { code: 'T', name: 'T' } });
      const dept = await prisma.department.create({ data: { organizationId: org.id, code: 'D', name: 'D' } });
      const pos = await prisma.position.create({ data: { departmentId: dept.id, code: 'P', title: 'P' } });
      await prisma.employee.create({ data: { employeeCode: 'T001', firstName: 'Test', lastName: 'Emp', email: 't001@users.local', hireDate: new Date(), organizationId: org.id, departmentId: dept.id, positionId: pos.id } });
    }
    const emp = (await prisma.employee.findFirst({ where: { user: null } }))!;
    const ok = await authed('post', '/api/v1/users').send({ email: 'linked@users.local', password: PW, roleCodes: ['EMPLOYEE'], employeeId: emp.id });
    expect(ok.status).toBe(201);
    expect(ok.body.data.employee.employeeCode).toBe(emp.employeeCode);

    const dup = await authed('post', '/api/v1/users').send({ email: 'linked2@users.local', password: PW, roleCodes: ['EMPLOYEE'], employeeId: emp.id });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('EMPLOYEE_ALREADY_LINKED');
  });
});

describe('list / get', () => {
  it('search, filter, pagination, sort — and no sensitive fields', async () => {
    const list = await authed('get', '/api/v1/users?search=new.user&status=active&role=HR&page=1&pageSize=5&sortBy=email&sortDir=asc');
    expect(list.status).toBe(200);
    expect(list.body.meta).toEqual({ page: 1, pageSize: 5, total: 1 });
    expect(list.body.data[0].email).toBe('new.user@users.local');
    expect(JSON.stringify(list.body)).not.toMatch(/passwordHash|tokenHash|csrf/i);

    const bad = await authed('get', '/api/v1/users?sortBy=passwordHash');
    expect(bad.status).toBe(400); // unsafe sort column rejected by schema

    const inactive = await authed('get', '/api/v1/users?status=inactive');
    expect(inactive.body.meta.total).toBe(0);
  });

  it('404 USER_NOT_FOUND', async () => {
    const res = await authed('get', '/api/v1/users/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('USER_NOT_FOUND');
  });
});

describe('update user', () => {
  it('15. update email → 200 and audit stores only the diff', async () => {
    const u = await prisma.user.findUniqueOrThrow({ where: { email: 'new.user@users.local' } });
    const res = await authed('patch', `/api/v1/users/${u.id}`).send({ email: 'renamed@users.local' });
    expect(res.status).toBe(200);
    expect(res.body.data.email).toBe('renamed@users.local');
    const audit = await prisma.auditLog.findFirst({ where: { action: 'UPDATE_USER', recordId: u.id }, orderBy: { createdAt: 'desc' } });
    expect(JSON.parse(audit!.oldValue!)).toEqual({ email: 'new.user@users.local' });
    expect(JSON.parse(audit!.newValue!)).toEqual({ email: 'renamed@users.local' });
  });

  it('password cannot be changed through PATCH /users/:id', async () => {
    const u = await prisma.user.findUniqueOrThrow({ where: { email: 'renamed@users.local' } });
    const before = u.passwordHash;
    const res = await authed('patch', `/api/v1/users/${u.id}`).send({ password: 'Another-Pass-9', email: 'renamed@users.local' });
    expect(res.status).toBe(200); // unknown key stripped by zod, email unchanged
    expect((await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).passwordHash).toBe(before);
  });

  it('21. update roles success (deterministic, audited)', async () => {
    const u = await prisma.user.findUniqueOrThrow({ where: { email: 'renamed@users.local' } });
    const res = await authed('patch', `/api/v1/users/${u.id}/roles`).send({ roleCodes: ['EMPLOYEE', 'EMPLOYEE', 'EXECUTIVE'] });
    expect(res.status).toBe(200);
    expect(res.body.data.roles.map((r: { code: string }) => r.code)).toEqual(['EMPLOYEE', 'EXECUTIVE']);
    const audit = await prisma.auditLog.findFirst({ where: { action: 'UPDATE_USER_ROLES', recordId: u.id } });
    expect(JSON.parse(audit!.oldValue!)).toEqual({ roles: ['HR', 'MANAGER'] });
    expect(JSON.parse(audit!.newValue!)).toEqual({ roles: ['EMPLOYEE', 'EXECUTIVE'] });
  });

  it('22b. invalid role on roles update → 400, roles unchanged', async () => {
    const u = await prisma.user.findUniqueOrThrow({ where: { email: 'renamed@users.local' } });
    const res = await authed('patch', `/api/v1/users/${u.id}/roles`).send({ roleCodes: ['NOPE'] });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_ROLE');
    expect((await authed('get', `/api/v1/users/${u.id}`)).body.data.roles).toHaveLength(2);
  });
});

describe('deactivate / activate', () => {
  it('16. deactivate → 17. all sessions revoked → 18. deactivated session gets 401', async () => {
    const target = await loginAs(app, 'employee@users.local', PW);
    const target2 = await loginAs(app, 'employee@users.local', PW); // two devices
    const id = target.user.id;
    expect(await prisma.session.count({ where: { userId: id } })).toBe(2);

    const res = await authed('patch', `/api/v1/users/${id}/deactivate`);
    expect(res.status).toBe(200);
    expect(res.body.data.isActive).toBe(false);
    expect(await prisma.session.count({ where: { userId: id } })).toBe(0);
    expect((await request(app).get('/api/v1/auth/me').set('Cookie', target.cookie)).status).toBe(401);
    expect((await request(app).get('/api/v1/auth/me').set('Cookie', target2.cookie)).status).toBe(401);
    expect((await request(app).post('/api/v1/auth/login').send({ email: 'employee@users.local', password: PW })).status).toBe(403);

    const audit = await prisma.auditLog.findFirst({ where: { action: 'DEACTIVATE_USER', recordId: id } });
    expect(JSON.parse(audit!.newValue!)).toEqual({ isActive: false, sessionsRevoked: 2 });
  });

  it('19. activate → 20. old cookie still invalid, login works again', async () => {
    const id = (await prisma.user.findUniqueOrThrow({ where: { email: 'employee@users.local' } })).id;
    const res = await authed('patch', `/api/v1/users/${id}/activate`);
    expect(res.status).toBe(200);
    expect(res.body.data.isActive).toBe(true);
    expect(await prisma.session.count({ where: { userId: id } })).toBe(0);
    const login = await request(app).post('/api/v1/auth/login').send({ email: 'employee@users.local', password: PW });
    expect(login.status).toBe(200);
    expect(sessionCookie(login)).toBeDefined();
    expect(await prisma.auditLog.count({ where: { action: 'ACTIVATE_USER', recordId: id } })).toBe(1);
  });

  it('23. user cannot deactivate self → 409 SELF_DEACTIVATION_NOT_ALLOWED', async () => {
    const res = await authed('patch', `/api/v1/users/${admin.user.id}/deactivate`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SELF_DEACTIVATION_NOT_ALLOWED');
  });

  it('24. cannot deactivate the last active SYSTEM_ADMIN → 409 LAST_SYSTEM_ADMIN', async () => {
    // second sysadmin deactivates the first one? No — the acting admin is the only one, so a HR_ADMIN tries.
    const hrAdmin = await loginAs(app, 'hradmin@users.local', PW);
    const res = await authed('patch', `/api/v1/users/${admin.user.id}/deactivate`, hrAdmin);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('LAST_SYSTEM_ADMIN');
    expect((await prisma.user.findUniqueOrThrow({ where: { id: admin.user.id } })).isActive).toBe(true);
  });

  it('25. cannot remove SYSTEM_ADMIN from the last active admin (self → SELF_ROLE_REMOVAL_NOT_ALLOWED, other → LAST_SYSTEM_ADMIN)', async () => {
    const self = await authed('patch', `/api/v1/users/${admin.user.id}/roles`).send({ roleCodes: ['HR_ADMIN'] });
    expect(self.status).toBe(409);
    expect(self.body.error.code).toBe('SELF_ROLE_REMOVAL_NOT_ALLOWED');

    const hrAdmin = await loginAs(app, 'hradmin@users.local', PW);
    const other = await authed('patch', `/api/v1/users/${admin.user.id}/roles`, hrAdmin).send({ roleCodes: ['HR_ADMIN'] });
    expect(other.status).toBe(409);
    expect(other.body.error.code).toBe('LAST_SYSTEM_ADMIN');

    // with a second active sysadmin it is allowed
    const second = await createUser({ email: 'sysadmin2@users.local', password: PW, role: 'SYSTEM_ADMIN' });
    const ok = await authed('patch', `/api/v1/users/${second.id}/roles`).send({ roleCodes: ['HR_ADMIN'] });
    expect(ok.status).toBe(200);
  });

  it('26. unauthorized user cannot manage users (HR has no users.* permission)', async () => {
    await createUser({ email: 'hr@users.local', password: PW, role: 'HR' });
    const hr = await loginAs(app, 'hr@users.local', PW);
    const target = (await prisma.user.findUniqueOrThrow({ where: { email: 'employee@users.local' } })).id;
    expect((await authed('get', '/api/v1/users', hr)).status).toBe(403);
    expect((await authed('post', '/api/v1/users', hr).send({ email: 'z@users.local', password: PW, roleCodes: ['HR'] })).status).toBe(403);
    expect((await authed('patch', `/api/v1/users/${target}/deactivate`, hr)).status).toBe(403);
    expect((await authed('patch', `/api/v1/users/${target}/roles`, hr).send({ roleCodes: ['SYSTEM_ADMIN'] })).status).toBe(403);
  });
});

describe('privilege escalation guard', () => {
  it('HR_ADMIN cannot grant SYSTEM_ADMIN (to self or others) → 403 ROLE_ESCALATION_NOT_ALLOWED', async () => {
    const hrAdmin = await loginAs(app, 'hradmin@users.local', PW);
    const self = await authed('patch', `/api/v1/users/${hrAdmin.user.id}/roles`, hrAdmin).send({ roleCodes: ['HR_ADMIN', 'SYSTEM_ADMIN'] });
    expect(self.status).toBe(403);
    expect(self.body.error.code).toBe('ROLE_ESCALATION_NOT_ALLOWED');
    const create = await authed('post', '/api/v1/users', hrAdmin).send({ email: 'esc@users.local', password: PW, roleCodes: ['SYSTEM_ADMIN'] });
    expect(create.status).toBe(403);
    expect(await prisma.user.findUnique({ where: { email: 'esc@users.local' } })).toBeNull();
    // roles within own permissions are fine
    const ok = await authed('post', '/api/v1/users', hrAdmin).send({ email: 'esc-ok@users.local', password: PW, roleCodes: ['HR', 'EMPLOYEE'] });
    expect(ok.status).toBe(201);
    // editing a user who already holds SYSTEM_ADMIN (keeping it) is allowed for HR_ADMIN
    const keep = await authed('patch', `/api/v1/users/${admin.user.id}/roles`, hrAdmin).send({ roleCodes: ['SYSTEM_ADMIN', 'HR'] });
    expect(keep.status).toBe(200);
    await authed('patch', `/api/v1/users/${admin.user.id}/roles`).send({ roleCodes: ['SYSTEM_ADMIN'] }); // restore
  });
});

describe('data scope escalation guard', () => {
  // Custom roles created only for these tests (removed afterwards):
  //   TEAM_USER_ADMIN : scope TEAM, permissions users.view/create/update (the acting user)
  //   TEAM_VIEWER     : scope TEAM, permissions dashboard.view           (same-scope target)
  //   ALL_VIEWER      : scope ALL,  permissions dashboard.view           (wider-scope target)
  let teamAdmin: { cookie: string; csrf: string; user: { id: string } };
  beforeAll(async () => {
    const perm = async (code: string) => (await prisma.permission.findUniqueOrThrow({ where: { code } })).id;
    const mk = (code: string, dataScope: string, codes: string[]) =>
      Promise.all(codes.map(perm)).then((ids) => prisma.role.create({ data: { code, name: code, dataScope, rolePermissions: { create: ids.map((permissionId) => ({ permissionId })) } } }));
    await mk('TEAM_USER_ADMIN', 'TEAM', ['users.view', 'users.create', 'users.update', 'dashboard.view']);
    await mk('TEAM_VIEWER', 'TEAM', ['dashboard.view']);
    await mk('ALL_VIEWER', 'ALL', ['dashboard.view']);
    await createUser({ email: 'teamadmin@users.local', password: PW, role: 'TEAM_USER_ADMIN' });
    await createUser({ email: 'scope-target@users.local', password: PW, role: 'EMPLOYEE' });
    teamAdmin = await loginAs(app, 'teamadmin@users.local', PW);
    expect(teamAdmin.user).toMatchObject({ dataScope: 'TEAM' });
  });
  afterAll(async () => {
    await prisma.role.deleteMany({ where: { code: { in: ['TEAM_USER_ADMIN', 'TEAM_VIEWER', 'ALL_VIEWER'] } } });
  });
  const target = () => prisma.user.findUniqueOrThrow({ where: { email: 'scope-target@users.local' } });

  it('TEAM actor cannot grant an ALL-scope role → 403 ROLE_SCOPE_ESCALATION_NOT_ALLOWED (even though permissions are a subset)', async () => {
    const t = await target();
    const res = await authed('patch', `/api/v1/users/${t.id}/roles`, teamAdmin).send({ roleCodes: ['ALL_VIEWER'] });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ROLE_SCOPE_ESCALATION_NOT_ALLOWED');
    const self = await authed('patch', `/api/v1/users/${teamAdmin.user.id}/roles`, teamAdmin).send({ roleCodes: ['TEAM_USER_ADMIN', 'ALL_VIEWER'] });
    expect(self.status).toBe(403);
    expect(self.body.error.code).toBe('ROLE_SCOPE_ESCALATION_NOT_ALLOWED');
    const create = await authed('post', '/api/v1/users', teamAdmin).send({ email: 'scope-esc@users.local', password: PW, roleCodes: ['ALL_VIEWER'] });
    expect(create.status).toBe(403);
    expect(await prisma.user.findUnique({ where: { email: 'scope-esc@users.local' } })).toBeNull();
  });

  it('same-scope grant allowed when permissions are valid (TEAM actor → TEAM role)', async () => {
    const t = await target();
    const res = await authed('patch', `/api/v1/users/${t.id}/roles`, teamAdmin).send({ roleCodes: ['TEAM_VIEWER'] });
    expect(res.status).toBe(200);
    expect(res.body.data.roles.map((r: { code: string }) => r.code)).toEqual(['TEAM_VIEWER']);
  });

  it('TEAM actor cannot grant a same-scope role whose permissions exceed their own → ROLE_ESCALATION_NOT_ALLOWED', async () => {
    const t = await target();
    const res = await authed('patch', `/api/v1/users/${t.id}/roles`, teamAdmin).send({ roleCodes: ['MANAGER'] }); // TEAM scope but has organization.view
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ROLE_ESCALATION_NOT_ALLOWED');
  });

  it('ALL actor can grant a TEAM-scope role (and an ALL-scope one)', async () => {
    const t = await target();
    const res = await authed('patch', `/api/v1/users/${t.id}/roles`).send({ roleCodes: ['TEAM_VIEWER', 'ALL_VIEWER', 'MANAGER'] });
    expect(res.status).toBe(200);
    expect(res.body.data.roles.map((r: { code: string }) => r.code)).toEqual(['ALL_VIEWER', 'MANAGER', 'TEAM_VIEWER']);
    await authed('patch', `/api/v1/users/${t.id}/roles`).send({ roleCodes: ['EMPLOYEE'] }); // restore
  });
});

describe('RBAC administration vs business authority (Task 43 separation of duties)', () => {
  // Custom roles (removed afterwards). The acting users hold user administration; only RBAC_ADMIN_LITE holds roles.manage.
  //   USER_ADMIN_ONLY : users.* + roles.view, scope ALL, NO roles.manage      → ordinary user administrator
  //   RBAC_ADMIN_LITE : users.* + roles.view + roles.manage, scope ALL        → RBAC authority, few business permissions
  //   PARTIAL_ADMIN   : users.view + dashboard.view + roles.manage            → holds roles.manage, so a "highest-role" target
  //   USER_ACTIVATOR  : users.activate                                         → an administration permission
  let userAdmin: { cookie: string; csrf: string; user: { id: string } };
  let rbacAdmin: { cookie: string; csrf: string; user: { id: string } };
  const USERS_ALL = ['users.view', 'users.create', 'users.update', 'users.activate', 'roles.view'];
  beforeAll(async () => {
    const perm = async (code: string) => (await prisma.permission.findUniqueOrThrow({ where: { code } })).id;
    const mk = (code: string, codes: string[]) =>
      Promise.all(codes.map(perm)).then((ids) => prisma.role.create({ data: { code, name: code, dataScope: 'ALL', rolePermissions: { create: ids.map((permissionId) => ({ permissionId })) } } }));
    await mk('USER_ADMIN_ONLY', [...USERS_ALL, 'dashboard.view']);
    await mk('RBAC_ADMIN_LITE', [...USERS_ALL, 'roles.manage', 'dashboard.view']);
    await mk('PARTIAL_ADMIN', ['users.view', 'dashboard.view', 'roles.manage']);
    await mk('USER_ACTIVATOR', ['users.activate']);
    await createUser({ email: 'useradmin@users.local', password: PW, role: 'USER_ADMIN_ONLY' });
    await createUser({ email: 'rbacadmin@users.local', password: PW, role: 'RBAC_ADMIN_LITE' });
    await createUser({ email: 'rbac-target@users.local', password: PW, role: 'EMPLOYEE' });
    userAdmin = await loginAs(app, 'useradmin@users.local', PW);
    rbacAdmin = await loginAs(app, 'rbacadmin@users.local', PW);
  });
  afterAll(async () => {
    await prisma.userRole.deleteMany({ where: { role: { code: { in: ['USER_ADMIN_ONLY', 'RBAC_ADMIN_LITE', 'PARTIAL_ADMIN', 'USER_ACTIVATOR'] } } } });
    await prisma.role.deleteMany({ where: { code: { in: ['USER_ADMIN_ONLY', 'RBAC_ADMIN_LITE', 'PARTIAL_ADMIN', 'USER_ACTIVATOR'] } } });
  });
  // Reset the target to EMPLOYEE only: roles a user already holds are exempt from the guard (edits never "re-grant").
  const target = async () => {
    const t = await prisma.user.findUniqueOrThrow({ where: { email: 'rbac-target@users.local' } });
    await prisma.userRole.deleteMany({ where: { userId: t.id } });
    await prisma.userRole.create({ data: { userId: t.id, roleId: (await prisma.role.findUniqueOrThrow({ where: { code: 'EMPLOYEE' } })).id } });
    return t;
  };

  it('SYSTEM_ADMIN holds no compensation permission yet assigns MANAGER; the grantee gets the role, the admin gains nothing; audited', async () => {
    const me = await authed('get', '/api/v1/auth/me');
    expect(JSON.stringify(me.body)).not.toContain('compensation_planning.');
    const t = await target();
    const res = await authed('patch', `/api/v1/users/${t.id}/roles`).send({ roleCodes: ['MANAGER'] });
    expect(res.status).toBe(200);
    const grantee = await loginAs(app, 'rbac-target@users.local', PW);
    expect(grantee.user).toMatchObject({ permissions: expect.arrayContaining(['compensation_planning.plan', 'compensation_planning.view_team']) });
    expect(JSON.stringify((await authed('get', '/api/v1/auth/me')).body)).not.toContain('compensation_planning.');
    const audit = await prisma.auditLog.findFirst({ where: { action: 'UPDATE_USER_ROLES', recordId: t.id }, orderBy: { createdAt: 'desc' } });
    expect(audit).toMatchObject({ userId: admin.user.id, module: 'users' });
    expect(JSON.parse(audit!.newValue!)).toEqual({ roles: ['MANAGER'] });
    const create = await authed('post', '/api/v1/users').send({ email: 'sys-grants@users.local', password: PW, roleCodes: ['HR_ADMIN', 'EXECUTIVE'] });
    expect(create.status).toBe(201);
  });

  it('an ordinary user administrator (no roles.manage) still cannot grant beyond their own permissions — to others or themselves', async () => {
    const t = await target();
    for (const roleCodes of [['MANAGER'], ['HR_ADMIN'], ['SYSTEM_ADMIN']]) {
      const res = await authed('patch', `/api/v1/users/${(await target()).id}/roles`, userAdmin).send({ roleCodes });
      expect(`${roleCodes} ${res.status} ${res.body.error?.code}`).toBe(`${roleCodes} 403 ROLE_ESCALATION_NOT_ALLOWED`);
    }
    const self = await authed('patch', `/api/v1/users/${userAdmin.user.id}/roles`, userAdmin).send({ roleCodes: ['USER_ADMIN_ONLY', 'RBAC_ADMIN_LITE'] });
    expect(self.body.error?.code).toBe('ROLE_ESCALATION_NOT_ALLOWED');
    const create = await authed('post', '/api/v1/users', userAdmin).send({ email: 'ua-esc@users.local', password: PW, roleCodes: ['HR'] });
    expect(create.status).toBe(403);
    expect(await prisma.user.findUnique({ where: { email: 'ua-esc@users.local' } })).toBeNull();
  });

  it('HR_ADMIN (users.* but no roles.manage) keeps the subset rule: HR/MANAGER/EXECUTIVE yes, SYSTEM_ADMIN no', async () => {
    const hrAdmin = await loginAs(app, 'hradmin@users.local', PW);
    const t = await target();
    expect((await authed('patch', `/api/v1/users/${t.id}/roles`, hrAdmin).send({ roleCodes: ['HR', 'MANAGER', 'EXECUTIVE'] })).status).toBe(200);
    const sys = await authed('patch', `/api/v1/users/${(await target()).id}/roles`, hrAdmin).send({ roleCodes: ['SYSTEM_ADMIN'] });
    expect(sys.body.error?.code).toBe('ROLE_ESCALATION_NOT_ALLOWED');
  });

  it('roles.manage lets an RBAC administrator grant business roles, but never administration permissions it lacks or a wider administrator', async () => {
    const t = await target();
    // business roles: allowed although RBAC_ADMIN_LITE holds none of their business permissions
    expect((await authed('patch', `/api/v1/users/${t.id}/roles`, rbacAdmin).send({ roleCodes: ['MANAGER', 'HR'] })).status).toBe(200);
    // a role carrying roles.manage needs the full subset — SYSTEM_ADMIN and PARTIAL_ADMIN (dashboard/users.view are held; nothing else) differ
    const sys = await authed('patch', `/api/v1/users/${(await target()).id}/roles`, rbacAdmin).send({ roleCodes: ['SYSTEM_ADMIN'] });
    expect(sys.body.error?.code).toBe('ROLE_ESCALATION_NOT_ALLOWED');
    expect((await authed('patch', `/api/v1/users/${(await target()).id}/roles`, rbacAdmin).send({ roleCodes: ['PARTIAL_ADMIN'] })).status).toBe(200);
    // HR_ADMIN carries users.* (held) and no roles.manage → grantable; a role with an administration permission the actor lacks is not
    expect((await authed('patch', `/api/v1/users/${(await target()).id}/roles`, rbacAdmin).send({ roleCodes: ['HR_ADMIN'] })).status).toBe(200);
    await prisma.userRole.deleteMany({ where: { userId: rbacAdmin.user.id } });
    await prisma.userRole.create({ data: { userId: rbacAdmin.user.id, roleId: (await prisma.role.findUniqueOrThrow({ where: { code: 'PARTIAL_ADMIN' } })).id } });
    await prisma.role.update({ where: { code: 'PARTIAL_ADMIN' }, data: { rolePermissions: { create: [{ permissionId: (await prisma.permission.findUniqueOrThrow({ where: { code: 'users.update' } })).id }] } } });
    const narrow = await loginAs(app, 'rbacadmin@users.local', PW);
    const act = await authed('patch', `/api/v1/users/${(await target()).id}/roles`, narrow).send({ roleCodes: ['USER_ACTIVATOR'] });
    expect(act.body.error?.code).toBe('ROLE_ESCALATION_NOT_ALLOWED'); // users.activate is administration: never bypassed
    const hrA = await authed('patch', `/api/v1/users/${(await target()).id}/roles`, narrow).send({ roleCodes: ['HR_ADMIN'] });
    expect(hrA.body.error?.code).toBe('ROLE_ESCALATION_NOT_ALLOWED'); // HR_ADMIN carries users.create / users.activate
    expect((await authed('patch', `/api/v1/users/${(await target()).id}/roles`, narrow).send({ roleCodes: ['EXECUTIVE'] })).status).toBe(200);
    // and self-escalation to SYSTEM_ADMIN is refused
    expect((await authed('patch', `/api/v1/users/${narrow.user.id}/roles`, narrow).send({ roleCodes: ['PARTIAL_ADMIN', 'SYSTEM_ADMIN'] })).body.error?.code).toBe('ROLE_ESCALATION_NOT_ALLOWED');
  });

  it('roles.manage does not satisfy any business permission check', async () => {
    for (const url of ['/api/v1/compensation-planning/cycles', '/api/v1/payroll/compensations', '/api/v1/employees']) {
      expect(`${url} ${(await authed('get', url, rbacAdmin)).status}`).toBe(`${url} 403`);
    }
  });
});

describe('password recovery (Task 18 requirement change)', () => {
  // An administrator may no longer choose a user's password: POST /users/:id/reset-password was removed and replaced
  // by a one-time reset link (POST /admin/users/:id/password-reset). The link flow itself is covered in
  // account-privacy.test.ts; here we only assert that the old, stronger capability is really gone.
  it('the old "set this user\'s password" endpoint no longer exists', async () => {
    const victim = await loginAs(app, 'employee@users.local', PW);
    const res = await authed('post', `/api/v1/users/${victim.user.id}/reset-password`).send({ password: 'Temporary-Pass-7' });
    expect(res.status).toBe(404);
    // nothing changed: the session still works and the original password still signs in
    expect((await request(app).get('/api/v1/auth/me').set('Cookie', victim.cookie)).status).toBe(200);
    expect((await request(app).post('/api/v1/auth/login').send({ email: 'employee@users.local', password: 'Temporary-Pass-7' })).status).toBe(401);
    expect((await request(app).post('/api/v1/auth/login').send({ email: 'employee@users.local', password: PW })).status).toBe(200);
  });

  it('a one-time reset link is issued instead, and signs the user out everywhere', async () => {
    const victim = await loginAs(app, 'employee@users.local', PW);
    const issued = await authed('post', `/api/v1/admin/users/${victim.user.id}/password-reset`);
    expect(issued.status).toBe(201);
    expect((await request(app).post('/api/v1/account/reset-password').send({ token: issued.body.data.token, newPassword: 'Link-Chosen-Pass-8' })).status).toBe(204);
    expect((await request(app).get('/api/v1/auth/me').set('Cookie', victim.cookie)).status).toBe(401);
    expect((await request(app).post('/api/v1/auth/login').send({ email: 'employee@users.local', password: 'Link-Chosen-Pass-8' })).status).toBe(200);
    const audit = await prisma.auditLog.findFirst({ where: { action: 'RESET_USER_PASSWORD', recordId: victim.user.id }, orderBy: { createdAt: 'desc' } });
    expect(`${audit!.oldValue}${audit!.newValue}`).not.toMatch(/Link-Chosen|\$2[aby]\$/);
    expect(audit!.newValue).not.toMatch(issued.body.data.token);
  });
});
