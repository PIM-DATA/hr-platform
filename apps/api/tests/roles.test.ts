import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CRITICAL_PERMISSIONS, PERMISSION_DEFINITIONS, ROLE_DEFINITIONS } from '@hr/shared';

const ALL_PERMISSIONS = PERMISSION_DEFINITIONS.length; // permission catalogue grows per phase; tests derive from the shared source of truth
const rolePerms = (code: string) => [...ROLE_DEFINITIONS.find((r) => r.code === code)!.permissions].sort();
import { prisma } from '../src/lib/prisma';
import { cleanUsers, createTestServer, createUser, ensureRoles, loginAs, resetDatabase, resetRolePermissions } from './helpers';

const app = createTestServer();
const PW = 'Correct-Horse-1';
let sysadmin: { cookie: string; csrf: string };
let hrAdmin: { cookie: string; csrf: string }; // roles.view only
let employee: { cookie: string; csrf: string }; // neither

const authed = (a: { cookie: string; csrf: string }, m: 'get' | 'patch', url: string) => request(app)[m](url).set('Cookie', a.cookie).set('x-csrf-token', a.csrf);

beforeAll(async () => {
  await resetDatabase();
  await createUser({ email: 'sys@roles.local', password: PW, role: 'SYSTEM_ADMIN' });
  await createUser({ email: 'hradmin@roles.local', password: PW, role: 'HR_ADMIN' });
  await createUser({ email: 'emp@roles.local', password: PW, role: 'EMPLOYEE' });
  sysadmin = await loginAs(app, 'sys@roles.local', PW);
  hrAdmin = await loginAs(app, 'hradmin@roles.local', PW);
  employee = await loginAs(app, 'emp@roles.local', PW);
});
afterAll(async () => {
  await resetDatabase();
  await prisma.$disconnect();
});

describe('view roles / permissions', () => {
  it('27. roles.view can list roles and permissions', async () => {
    const roles = await authed(hrAdmin, 'get', '/api/v1/roles');
    expect(roles.status).toBe(200);
    expect(roles.body.data.map((r: { code: string }) => r.code).sort()).toEqual(['EMPLOYEE', 'EXECUTIVE', 'HR', 'HR_ADMIN', 'MANAGER', 'SYSTEM_ADMIN']);
    const sys = roles.body.data.find((r: { code: string }) => r.code === 'SYSTEM_ADMIN');
    expect(sys.isSystem).toBe(true);
    expect(sys.permissionCodes).toHaveLength(ALL_PERMISSIONS);
    expect(sys.userCount).toBe(1);

    const perms = await authed(hrAdmin, 'get', '/api/v1/permissions');
    expect(perms.status).toBe(200);
    expect(perms.body.data).toHaveLength(ALL_PERMISSIONS);
    expect(perms.body.data[0]).toHaveProperty('module');

    const one = await authed(hrAdmin, 'get', `/api/v1/roles/${sys.id}`);
    expect(one.status).toBe(200);
    expect(one.body.data.code).toBe('SYSTEM_ADMIN');
  });

  it('28. without roles.view → 403', async () => {
    expect((await authed(employee, 'get', '/api/v1/roles')).status).toBe(403);
    expect((await authed(employee, 'get', '/api/v1/permissions')).status).toBe(403);
  });
});

describe('update role permissions', () => {
  async function roleId(code: string) {
    return (await prisma.role.findUniqueOrThrow({ where: { code } })).id;
  }

  it('29. roles.manage can replace permissions deterministically and audits old/new', async () => {
    const id = await roleId('EXECUTIVE');
    const res = await authed(sysadmin, 'patch', `/api/v1/roles/${id}/permissions`).send({ permissionCodes: ['dashboard.view', 'audit.view'] });
    expect(res.status).toBe(200);
    expect(res.body.data.permissionCodes).toEqual(['audit.view', 'dashboard.view']);
    const audit = await prisma.auditLog.findFirst({ where: { action: 'UPDATE_ROLE_PERMISSIONS', recordId: id }, orderBy: { createdAt: 'desc' } });
    expect(JSON.parse(audit!.oldValue!).permissions).toEqual(rolePerms('EXECUTIVE'));
    expect(JSON.parse(audit!.newValue!).permissions).toEqual(['audit.view', 'dashboard.view']);
  });

  it('30. without roles.manage → 403 (HR_ADMIN has roles.view only)', async () => {
    const id = await roleId('EXECUTIVE');
    const res = await authed(hrAdmin, 'patch', `/api/v1/roles/${id}/permissions`).send({ permissionCodes: ['dashboard.view'] });
    expect(res.status).toBe(403);
    expect((await authed(employee, 'patch', `/api/v1/roles/${id}/permissions`).send({ permissionCodes: [] })).status).toBe(403);
  });

  it('31. invalid permission → 400 INVALID_PERMISSION, nothing changed', async () => {
    const id = await roleId('EXECUTIVE');
    const res = await authed(sysadmin, 'patch', `/api/v1/roles/${id}/permissions`).send({ permissionCodes: ['dashboard.view', 'nope.everything'] });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_PERMISSION');
    expect((await authed(sysadmin, 'get', `/api/v1/roles/${id}`)).body.data.permissionCodes).toEqual(['audit.view', 'dashboard.view']);
  });

  it('32. duplicate permissions in input are collapsed, no duplicate rows', async () => {
    const id = await roleId('EXECUTIVE');
    const res = await authed(sysadmin, 'patch', `/api/v1/roles/${id}/permissions`).send({ permissionCodes: ['dashboard.view', 'dashboard.view', 'employees.view', 'employees.view'] });
    expect(res.status).toBe(200);
    expect(res.body.data.permissionCodes).toEqual(['dashboard.view', 'employees.view']);
    expect(await prisma.rolePermission.count({ where: { roleId: id } })).toBe(2);
  });

  it('33. permission change is reflected immediately for an already-logged-in user', async () => {
    const id = await roleId('EMPLOYEE');
    expect((await authed(employee, 'get', '/api/v1/roles')).status).toBe(403);
    await authed(sysadmin, 'patch', `/api/v1/roles/${id}/permissions`).send({ permissionCodes: ['dashboard.view', 'roles.view'] });
    expect((await authed(employee, 'get', '/api/v1/roles')).status).toBe(200);
    await authed(sysadmin, 'patch', `/api/v1/roles/${id}/permissions`).send({ permissionCodes: ['dashboard.view'] });
    expect((await authed(employee, 'get', '/api/v1/roles')).status).toBe(403);
  });

  it('SYSTEM_ADMIN cannot lose critical permissions → 409 CRITICAL_PERMISSION_REQUIRED', async () => {
    const id = await roleId('SYSTEM_ADMIN');
    const res = await authed(sysadmin, 'patch', `/api/v1/roles/${id}/permissions`).send({ permissionCodes: ['dashboard.view'] });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CRITICAL_PERMISSION_REQUIRED');
    expect((await authed(sysadmin, 'get', `/api/v1/roles/${id}`)).body.data.permissionCodes).toHaveLength(ALL_PERMISSIONS);

    // keeping the critical set (and dropping something else) is allowed
    const ok = await authed(sysadmin, 'patch', `/api/v1/roles/${id}/permissions`).send({ permissionCodes: [...CRITICAL_PERMISSIONS, 'dashboard.view'] });
    expect(ok.status).toBe(200);
    expect(ok.body.data.permissionCodes).toHaveLength(CRITICAL_PERMISSIONS.length + 1);
    // the acting admin still has everything needed to restore
    expect((await authed(sysadmin, 'get', '/api/v1/users')).status).toBe(200);
  });

  it('unknown role → 404 ROLE_NOT_FOUND', async () => {
    const res = await authed(sysadmin, 'patch', '/api/v1/roles/nope/permissions').send({ permissionCodes: ['dashboard.view'] });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('ROLE_NOT_FOUND');
  });
});
