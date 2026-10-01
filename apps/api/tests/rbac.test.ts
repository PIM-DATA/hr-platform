import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma';
import { computeEffectivePermissions, resolveDataScope } from '../src/services/authorization/authorization.service';
import { cleanUsers, createTestServer, createUser, ensureRoles, loginAs, resetDatabase, resetRolePermissions } from './helpers';

const app = createTestServer();
const PW = 'Correct-Horse-1';

beforeAll(async () => {
  await resetDatabase();
  await createUser({ email: 'sysadmin@rbac.local', password: PW, role: 'SYSTEM_ADMIN' });
  await createUser({ email: 'employee@rbac.local', password: PW, role: 'EMPLOYEE' });
  // multi-role user: HR (ALL) + MANAGER (TEAM)
  const multi = await createUser({ email: 'multi@rbac.local', password: PW, role: 'HR' });
  const manager = await prisma.role.findUniqueOrThrow({ where: { code: 'MANAGER' } });
  await prisma.userRole.create({ data: { userId: multi.id, roleId: manager.id } });
});
afterAll(async () => {
  await resetDatabase();
  await prisma.$disconnect();
});

describe('requirePermission', () => {
  it('1. unauthenticated → 401', async () => {
    const res = await request(app).get('/api/v1/users');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('2. authenticated without permission → 403 FORBIDDEN', async () => {
    const { cookie } = await loginAs(app, 'employee@rbac.local', PW);
    const res = await request(app).get('/api/v1/users').set('Cookie', cookie);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('3. permission allowed → 200', async () => {
    const { cookie } = await loginAs(app, 'sysadmin@rbac.local', PW);
    const res = await request(app).get('/api/v1/users').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.meta.total).toBeGreaterThan(0);
  });

  it('10. client-supplied role/permission claims are ignored (backend is the source of truth)', async () => {
    const { cookie, csrf } = await loginAs(app, 'employee@rbac.local', PW);
    const res = await request(app)
      .post('/api/v1/users')
      .set('Cookie', cookie)
      .set('x-csrf-token', csrf)
      .set('x-permissions', 'users.create')
      .set('x-role', 'SYSTEM_ADMIN')
      .send({ email: 'x@rbac.local', password: PW, roleCodes: ['EMPLOYEE'], permissions: ['users.create'], roles: ['SYSTEM_ADMIN'] });
    expect(res.status).toBe(403);
    expect(await prisma.user.findUnique({ where: { email: 'x@rbac.local' } })).toBeNull();
  });
});

describe('effective permissions', () => {
  it('4. multiple roles → union of permissions; 5. no duplicates', async () => {
    const { user } = await loginAs(app, 'multi@rbac.local', PW);
    const perms: string[] = user.permissions;
    expect(user.roles.map((r: { code: string }) => r.code).sort()).toEqual(['HR', 'MANAGER']);
    expect(perms).toContain('employees.create'); // from HR
    expect(perms).toContain('dashboard.view'); // in both roles
    expect(new Set(perms).size).toBe(perms.length);
    expect([...perms].sort()).toEqual(perms); // deterministic order
  });

  it('computeEffectivePermissions dedupes across roles', () => {
    const roles = [
      { code: 'A', dataScope: 'SELF', rolePermissions: [{ permission: { code: 'x.view' } }, { permission: { code: 'y.view' } }] },
      { code: 'B', dataScope: 'SELF', rolePermissions: [{ permission: { code: 'x.view' } }, { permission: { code: 'z.manage' } }] },
    ];
    expect(computeEffectivePermissions(roles)).toEqual(['x.view', 'y.view', 'z.manage']);
    expect(computeEffectivePermissions([])).toEqual([]);
  });
});

describe('data scope', () => {
  it('6. SELF + TEAM → TEAM', () => expect(resolveDataScope([{ dataScope: 'SELF' }, { dataScope: 'TEAM' }])).toBe('TEAM'));
  it('7. TEAM + ALL → ALL', () => expect(resolveDataScope([{ dataScope: 'TEAM' }, { dataScope: 'ALL' }])).toBe('ALL'));
  it('8. SELF + ALL → ALL', () => expect(resolveDataScope([{ dataScope: 'SELF' }, { dataScope: 'ALL' }])).toBe('ALL'));
  it('no roles / unknown value → SELF', () => {
    expect(resolveDataScope([])).toBe('SELF');
    expect(resolveDataScope([{ dataScope: 'BOGUS' }])).toBe('SELF');
  });
  // Task 50 (T44-P1-21) — BEFORE: /auth/me exposed one user-wide `dataScope` (HR + MANAGER → ALL for everything).
  // AFTER: a scope per permission, from the roles that grant it: employees.view (both roles) → ALL; performance.review
  // (MANAGER only) → TEAM.
  it('is computed by the backend per permission and exposed on /auth/me (HR + MANAGER)', async () => {
    const { user } = await loginAs(app, 'multi@rbac.local', PW);
    expect(user.permissionScopes['employees.view']).toBe('ALL');
    expect(user.permissionScopes['performance.review']).toBe('TEAM');
    expect(user).not.toHaveProperty('dataScope');
    const emp = await loginAs(app, 'employee@rbac.local', PW);
    expect(emp.user.permissionScopes['employees.view']).toBe('SELF');
  });
});

describe('permission changes propagate immediately', () => {
  it('9. granting users.view to EMPLOYEE takes effect on the next request with the SAME session', async () => {
    const admin = await loginAs(app, 'sysadmin@rbac.local', PW);
    const emp = await loginAs(app, 'employee@rbac.local', PW);
    expect((await request(app).get('/api/v1/users').set('Cookie', emp.cookie)).status).toBe(403);

    const role = await prisma.role.findUniqueOrThrow({ where: { code: 'EMPLOYEE' }, include: { rolePermissions: { include: { permission: true } } } });
    const current = role.rolePermissions.map((rp) => rp.permission.code);
    const grant = await request(app)
      .patch(`/api/v1/roles/${role.id}/permissions`)
      .set('Cookie', admin.cookie)
      .set('x-csrf-token', admin.csrf)
      .send({ permissionCodes: [...current, 'users.view'] });
    expect(grant.status).toBe(200);

    expect((await request(app).get('/api/v1/users').set('Cookie', emp.cookie)).status).toBe(200);
    const me = await request(app).get('/api/v1/auth/me').set('Cookie', emp.cookie);
    expect(me.body.data.permissions).toContain('users.view');

    // revoke again → next request is 403 again
    await request(app).patch(`/api/v1/roles/${role.id}/permissions`).set('Cookie', admin.cookie).set('x-csrf-token', admin.csrf).send({ permissionCodes: current });
    expect((await request(app).get('/api/v1/users').set('Cookie', emp.cookie)).status).toBe(403);
  });
});
