/**
 * Task 45 — privileged account protection and RBAC separation of duties.
 *
 * P0-01 (Task 44): an HR_ADMIN could issue a password-reset link for a SYSTEM_ADMIN, consume it and sign in as them;
 * the same "any target" gap existed for PATCH, activate/deactivate, session revocation and role changes. And a
 * `roles.manage` holder could grant itself business authority (self-assign a role, edit a role it holds, or edit
 * another role and then self-assign it). Every test here goes through the HTTP API — no UI involved.
 */
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma';
import { buildAuthContext } from '../src/services/authorization/authorization.service';
import { deactivateUserWithTx } from '../src/modules/users/users.service';
import { createTestServer, createUser, loginAs, resetDatabase } from './helpers';

const app = createTestServer();
const PW = 'Correct-Horse-1';
type Session = { cookie: string; csrf: string; user: { id: string } };
const as = (s: Session, m: 'get' | 'post' | 'patch', url: string) => request(app)[m](url).set('Cookie', s.cookie).set('x-csrf-token', s.csrf);
const err = (r: request.Response) => `${r.status} ${r.body?.error?.code ?? ''}`.trim();
const U = '/api/v1/users';
const A = '/api/v1/admin/users';

const ids: Record<string, string> = {};
let sys: Session, sys2: Session, hrAdmin: Session, hr: Session, employee: Session, rbacOnly: Session;
const permsOf = async (s: Session) => (await as(s, 'get', '/api/v1/auth/me')).body.data.permissions as string[];
const rolesOf = async (userId: string) => (await prisma.userRole.findMany({ where: { userId }, include: { role: true } })).map((r) => r.role.code).sort();
const setRolesDirect = async (userId: string, codes: string[]) => {
  await prisma.userRole.deleteMany({ where: { userId } });
  for (const code of codes) await prisma.userRole.create({ data: { userId, roleId: (await prisma.role.findUniqueOrThrow({ where: { code } })).id } });
};
const rolePerms = async (code: string) => (await prisma.rolePermission.findMany({ where: { role: { code } }, include: { permission: true } })).map((rp) => rp.permission.code).sort();
const roleId = async (code: string) => (await prisma.role.findUniqueOrThrow({ where: { code } })).id;
const mkRole = async (code: string, dataScope: string, perms: string[]) => {
  const role = await prisma.role.create({ data: { code, name: code, dataScope, isSystem: false } });
  for (const p of perms) await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: (await prisma.permission.findUniqueOrThrow({ where: { code: p } })).id } });
};

beforeAll(async () => {
  await resetDatabase();
  const org = await prisma.organization.create({ data: { code: 'T45', name: 'T45 Co', timezone: 'Asia/Bangkok' } });
  const dept = await prisma.department.create({ data: { organizationId: org.id, code: 'D45', name: 'Dept 45' } });
  const job = await prisma.job.create({ data: { code: 'J45', title: 'Job 45', level: 1 } });
  const pos = await prisma.position.create({ data: { departmentId: dept.id, code: 'P45', title: 'Pos 45', jobId: job.id } });
  const mkEmp = async (code: string) => (await prisma.employee.create({ data: { employeeCode: code, firstName: code, lastName: 'P', email: `${code.toLowerCase()}@t45.local`, hireDate: new Date('2024-01-01T00:00:00Z'), organizationId: org.id, departmentId: dept.id, positionId: pos.id, employmentType: 'FULL_TIME', employmentStatus: 'ACTIVE' } })).id;
  ids.empMgr = await mkEmp('MGR45');
  ids.empEmp = await mkEmp('EMP45');
  ids.empSpare = await mkEmp('SPARE45');
  // A narrow RBAC administrator: role administration only, no business authority, SELF scope.
  await mkRole('RBAC_ONLY', 'SELF', ['roles.view', 'roles.manage', 'users.view', 'users.update', 'dashboard.view']);
  await mkRole('PLAIN_VIEWER', 'SELF', ['dashboard.view']);
  await mkRole('TEAM_VIEWER', 'TEAM', ['dashboard.view']);
  for (const [key, role, employeeId] of [
    ['sys', 'SYSTEM_ADMIN', undefined], ['sys2', 'SYSTEM_ADMIN', undefined], ['hrAdmin', 'HR_ADMIN', undefined], ['hrAdmin2', 'HR_ADMIN', undefined],
    ['hr', 'HR', undefined], ['manager', 'MANAGER', ids.empMgr], ['employee', 'EMPLOYEE', ids.empEmp], ['rbacOnly', 'RBAC_ONLY', undefined],
    ['a', 'EMPLOYEE', undefined], ['b', 'EMPLOYEE', undefined], ['c', 'EMPLOYEE', undefined], ['d', 'EMPLOYEE', undefined],
  ] as const) ids[key] = (await createUser({ email: `${key.toLowerCase()}@t45.local`, password: PW, role, employeeId })).id;
  [sys, sys2, hrAdmin, hr, employee, rbacOnly] = await Promise.all(['sys', 'sys2', 'hradmin', 'hr', 'employee', 'rbaconly'].map((u) => loginAs(app, `${u}@t45.local`, PW)));
}, 120000);
afterAll(async () => { await resetDatabase(); await prisma.$disconnect(); });

describe('P0-01 regression: HR_ADMIN cannot take over a SYSTEM_ADMIN', () => {
  it('the Task 44 exploit (issue reset link → consume → sign in as SYSTEM_ADMIN) is refused with no token and no change', async () => {
    const sessionsBefore = await prisma.session.count({ where: { userId: ids.sys2 } });
    const r = await as(hrAdmin, 'post', `${A}/${ids.sys2}/password-reset`);
    expect(err(r)).toBe('403 PRIVILEGED_ACCOUNT_PROTECTED');
    expect(JSON.stringify(r.body)).not.toMatch(/token|reset-password/i);
    expect(await prisma.passwordResetToken.count({ where: { userId: ids.sys2 } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { action: 'ISSUE_PASSWORD_RESET', recordId: ids.sys2 } })).toBe(0);
    expect(await prisma.session.count({ where: { userId: ids.sys2 } })).toBe(sessionsBefore);
    expect((await as(sys2, 'get', '/api/v1/auth/me')).status).toBe(200); // still signed in
    expect((await loginAs(app, 'sys2@t45.local', PW)).user.id).toBe(ids.sys2); // password unchanged
  });

  it('PATCH (email, employee link), role changes, deactivate, activate and sign-out of a SYSTEM_ADMIN are refused for HR_ADMIN', async () => {
    const before = await prisma.user.findUniqueOrThrow({ where: { id: ids.sys2 } });
    expect(err(await as(hrAdmin, 'patch', `${U}/${ids.sys2}`).send({ email: 'hijack@t45.local' }))).toBe('403 PRIVILEGED_ACCOUNT_PROTECTED');
    expect(err(await as(hrAdmin, 'patch', `${U}/${ids.sys2}`).send({ employeeId: ids.empSpare }))).toBe('403 PRIVILEGED_ACCOUNT_PROTECTED');
    expect(err(await as(hrAdmin, 'patch', `${U}/${ids.sys2}/roles`).send({ roleCodes: ['SYSTEM_ADMIN', 'HR'] }))).toBe('403 PRIVILEGED_ACCOUNT_PROTECTED');
    expect(err(await as(hrAdmin, 'patch', `${U}/${ids.sys2}/deactivate`))).toBe('403 PRIVILEGED_ACCOUNT_PROTECTED');
    expect(err(await as(hrAdmin, 'post', `${A}/${ids.sys2}/revoke-sessions`))).toBe('403 PRIVILEGED_ACCOUNT_PROTECTED');
    const after = await prisma.user.findUniqueOrThrow({ where: { id: ids.sys2 } });
    expect({ email: after.email, employeeId: after.employeeId, isActive: after.isActive }).toEqual({ email: before.email, employeeId: before.employeeId, isActive: true });
    expect(await rolesOf(ids.sys2)).toEqual(['SYSTEM_ADMIN']);
    expect((await as(sys2, 'get', '/api/v1/auth/me')).status).toBe(200); // sessions untouched
    // activate: a deactivated privileged account cannot be brought back by HR_ADMIN either
    expect(err(await as(sys, 'patch', `${U}/${ids.sys2}/deactivate`))).toBe('200');
    expect(err(await as(hrAdmin, 'patch', `${U}/${ids.sys2}/activate`))).toBe('403 PRIVILEGED_ACCOUNT_PROTECTED');
    expect((await prisma.user.findUniqueOrThrow({ where: { id: ids.sys2 } })).isActive).toBe(false);
    expect(err(await as(sys, 'patch', `${U}/${ids.sys2}/activate`))).toBe('200');
    sys2 = await loginAs(app, 'sys2@t45.local', PW);
  });

  it('the offboarding path (deactivateUserWithTx) applies the same boundary', async () => {
    const actorUser = await prisma.user.findUniqueOrThrow({ where: { id: ids.hrAdmin }, include: { userRoles: { include: { role: { include: { rolePermissions: { include: { permission: true } } } } } } } });
    const auth = buildAuthContext({ user: actorUser, roles: actorUser.userRoles.map((ur) => ur.role), sessionId: 'x', csrfToken: 'x' });
    await expect(prisma.$transaction((tx) => deactivateUserWithTx(tx, ids.sys2, { auth, ipAddress: null, userAgent: null }, 'OFFBOARDING:test'))).rejects.toMatchObject({ code: 'PRIVILEGED_ACCOUNT_PROTECTED' });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: ids.sys2 } })).isActive).toBe(true);
  });

  it('privileged is decided by permissions, not by role name: a custom role holding roles.manage is protected too', async () => {
    expect(err(await as(hrAdmin, 'post', `${A}/${ids.rbacOnly}/password-reset`))).toBe('403 PRIVILEGED_ACCOUNT_PROTECTED');
    expect(err(await as(hrAdmin, 'patch', `${U}/${ids.rbacOnly}/deactivate`))).toBe('403 PRIVILEGED_ACCOUNT_PROTECTED');
  });

  it('HR_ADMIN still administers ordinary accounts (reset, edit, sign-out, deactivate, activate, roles)', async () => {
    const r = await as(hrAdmin, 'post', `${A}/${ids.employee}/password-reset`);
    expect(r.status).toBe(201);
    expect(await prisma.auditLog.count({ where: { action: 'ISSUE_PASSWORD_RESET', recordId: ids.employee } })).toBe(1);
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'ISSUE_PASSWORD_RESET', recordId: ids.employee } });
    expect(JSON.stringify(audit)).not.toContain(r.body.data.token);
    expect(err(await as(hrAdmin, 'patch', `${U}/${ids.a}`).send({ email: 'a2@t45.local' }))).toBe('200');
    expect(err(await as(hrAdmin, 'post', `${A}/${ids.employee}/revoke-sessions`))).toBe('200');
    expect(err(await as(hrAdmin, 'patch', `${U}/${ids.a}/deactivate`))).toBe('200');
    expect(err(await as(hrAdmin, 'patch', `${U}/${ids.a}/activate`))).toBe('200');
    expect(err(await as(hrAdmin, 'patch', `${U}/${ids.a}/roles`).send({ roleCodes: ['MANAGER'] }))).toBe('200');
    // an HR_ADMIN peer is not a privileged (RBAC) account: ordinary recovery applies
    expect(err(await as(hrAdmin, 'post', `${A}/${ids.hrAdmin2}/password-reset`))).toBe('201');
    await setRolesDirect(ids.a, ['EMPLOYEE']);
  });

  it('a privileged administrator (users.manage_privileged) administers ordinary users and peer administrators', async () => {
    expect(err(await as(sys, 'post', `${A}/${ids.employee}/password-reset`))).toBe('201');
    expect(err(await as(sys, 'post', `${A}/${ids.sys2}/password-reset`))).toBe('201');
    expect(err(await as(sys, 'patch', `${U}/${ids.sys2}/deactivate`))).toBe('200');
    expect((await as(sys2, 'get', '/api/v1/auth/me')).status).toBe(401); // existing revocation semantics
    expect(err(await as(sys, 'patch', `${U}/${ids.sys}/deactivate`))).toBe('409 SELF_DEACTIVATION_NOT_ALLOWED');
    expect(err(await as(sys, 'patch', `${U}/${ids.sys}/roles`).send({ roleCodes: ['HR'] }))).toBe('409 SELF_ROLE_REMOVAL_NOT_ALLOWED');
    expect(err(await as(sys, 'patch', `${U}/${ids.sys2}/activate`))).toBe('200');
    sys2 = await loginAs(app, 'sys2@t45.local', PW);
  });

  it('LAST_SYSTEM_ADMIN: the final active System Admin cannot be deactivated or demoted, even by a privileged administrator', async () => {
    await prisma.user.update({ where: { id: ids.sys2 }, data: { isActive: false } });
    // a privileged RBAC admin that is not a System Admin (custom role) tries to remove the last one
    await mkRole('PRIV_ADMIN', 'ALL', ['users.view', 'users.update', 'users.activate', 'users.manage_privileged', 'roles.view', 'roles.manage', 'dashboard.view']);
    const priv = (await createUser({ email: 'priv@t45.local', password: PW, role: 'PRIV_ADMIN' })).id;
    const privS = await loginAs(app, 'priv@t45.local', PW);
    expect(err(await as(privS, 'patch', `${U}/${ids.sys}/deactivate`))).toBe('409 LAST_SYSTEM_ADMIN');
    expect(err(await as(privS, 'patch', `${U}/${ids.sys}/roles`).send({ roleCodes: ['SYSTEM_ADMIN', 'EMPLOYEE'] }))).toMatch(/^(200|403)/); // keeping it is fine or refused by grant rules
    expect(err(await as(privS, 'patch', `${U}/${ids.sys}/roles`).send({ roleCodes: ['EMPLOYEE'] }))).toBe('409 LAST_SYSTEM_ADMIN');
    expect(await rolesOf(ids.sys)).toContain('SYSTEM_ADMIN');
    expect((await prisma.user.findUniqueOrThrow({ where: { id: ids.sys } })).isActive).toBe(true);
    await setRolesDirect(ids.sys, ['SYSTEM_ADMIN']);
    await prisma.user.update({ where: { id: ids.sys2 }, data: { isActive: true } });
    await prisma.user.update({ where: { id: priv }, data: { isActive: false } });
    sys2 = await loginAs(app, 'sys2@t45.local', PW);
  });
});

describe('RBAC separation of duties: roles.manage is not self-service authority', () => {
  it('SYSTEM_ADMIN holds no compensation permission and cannot self-assign HR_ADMIN (path A)', async () => {
    expect((await permsOf(sys)).filter((p) => p.startsWith('compensation_planning.'))).toEqual([]);
    const r = await as(sys, 'patch', `${U}/${ids.sys}/roles`).send({ roleCodes: ['SYSTEM_ADMIN', 'HR_ADMIN'] });
    expect(err(r)).toBe('403 SELF_PRIVILEGE_ESCALATION_NOT_ALLOWED');
    expect(await rolesOf(ids.sys)).toEqual(['SYSTEM_ADMIN']);
    expect(await permsOf(sys)).not.toContain('compensation_planning.apply');
  });

  it('cannot add a permission to a role the actor holds (path C) — compensation, payroll and another confidential domain', async () => {
    const sysPerms = await rolePerms('SYSTEM_ADMIN');
    expect(err(await as(sys, 'patch', `/api/v1/roles/${await roleId('SYSTEM_ADMIN')}/permissions`).send({ permissionCodes: [...sysPerms, 'compensation_planning.apply'] }))).toBe('403 SELF_PRIVILEGE_ESCALATION_NOT_ALLOWED');
    expect(await rolePerms('SYSTEM_ADMIN')).toEqual(sysPerms);
    const x = await rolePerms('RBAC_ONLY');
    for (const add of ['compensation_planning.apply', 'payroll.manage', 'employee_relations.manage', 'benefits.manage']) {
      const r = await as(rbacOnly, 'patch', `/api/v1/roles/${await roleId('RBAC_ONLY')}/permissions`).send({ permissionCodes: [...x, add] });
      expect(`${add} ${err(r)}`).toBe(`${add} 403 SELF_PRIVILEGE_ESCALATION_NOT_ALLOWED`);
    }
    expect(await rolePerms('RBAC_ONLY')).toEqual(x);
    // removing from a held role is not an escalation
    expect(err(await as(rbacOnly, 'patch', `/api/v1/roles/${await roleId('RBAC_ONLY')}/permissions`).send({ permissionCodes: x.filter((p) => p !== 'dashboard.view') }))).toBe('200');
    await prisma.rolePermission.create({ data: { roleId: await roleId('RBAC_ONLY'), permissionId: (await prisma.permission.findUniqueOrThrow({ where: { code: 'dashboard.view' } })).id } });
  });

  it('edit an ordinary role for others, then self-assign it (path D): the edit governs others, the self-assignment is refused', async () => {
    const empPerms = await rolePerms('EMPLOYEE');
    const added = ['compensation_planning.apply', 'payroll.manage', 'employee_relations.manage'];
    expect(err(await as(rbacOnly, 'patch', `/api/v1/roles/${await roleId('EMPLOYEE')}/permissions`).send({ permissionCodes: [...empPerms, ...added] }))).toBe('200');
    const self = await as(rbacOnly, 'patch', `${U}/${ids.rbacOnly}/roles`).send({ roleCodes: ['RBAC_ONLY', 'EMPLOYEE'] });
    expect(err(self)).toBe('403 SELF_PRIVILEGE_ESCALATION_NOT_ALLOWED');
    const mine = await permsOf(rbacOnly);
    for (const p of added) expect(mine).not.toContain(p);
    await as(sys, 'patch', `/api/v1/roles/${await roleId('EMPLOYEE')}/permissions`).send({ permissionCodes: empPerms });
    expect(await rolePerms('EMPLOYEE')).toEqual(empPerms);
  });

  it('data scope: self-assignment cannot widen SELF → TEAM or SELF → ALL', async () => {
    for (const role of ['TEAM_VIEWER', 'HR']) {
      const r = await as(rbacOnly, 'patch', `${U}/${ids.rbacOnly}/roles`).send({ roleCodes: ['RBAC_ONLY', role] });
      expect(r.status).toBe(403);
      expect(['SELF_PRIVILEGE_ESCALATION_NOT_ALLOWED', 'ROLE_SCOPE_ESCALATION_NOT_ALLOWED']).toContain(r.body.error.code);
    }
    // Task 50 — BEFORE: me.dataScope === 'SELF'. AFTER: every permission the actor holds is still at SELF.
    expect(Object.values((await as(rbacOnly, 'get', '/api/v1/auth/me')).body.data.permissionScopes as Record<string, string>).every((s) => s === 'SELF')).toBe(true);
    expect(await rolesOf(ids.rbacOnly)).toEqual(['RBAC_ONLY']);
    // a self-assignment that adds nothing new is not an escalation
    expect(err(await as(rbacOnly, 'patch', `${U}/${ids.rbacOnly}/roles`).send({ roleCodes: ['RBAC_ONLY', 'PLAIN_VIEWER'] }))).toBe('200');
    await setRolesDirect(ids.rbacOnly, ['RBAC_ONLY']);
  });

  it('crafting a second administrator: a role carrying roles.manage needs the full subset; administration permissions are never bypassed', async () => {
    const plain = await rolePerms('PLAIN_VIEWER');
    // "Role Evil" = roles.manage + compensation_planning.apply, built from a role the actor does not hold
    const evil = await as(rbacOnly, 'patch', `/api/v1/roles/${await roleId('PLAIN_VIEWER')}/permissions`).send({ permissionCodes: [...plain, 'roles.manage', 'compensation_planning.apply'] });
    expect(err(evil)).toBe('403 ROLE_EDIT_ESCALATION_NOT_ALLOWED');
    for (const admin of ['users.activate', 'users.create', 'users.manage_privileged', 'account.manage_recovery']) {
      const r = await as(rbacOnly, 'patch', `/api/v1/roles/${await roleId('PLAIN_VIEWER')}/permissions`).send({ permissionCodes: [...plain, admin] });
      expect(`${admin} ${err(r)}`).toBe(`${admin} 403 ROLE_EDIT_ESCALATION_NOT_ALLOWED`);
    }
    expect(await rolePerms('PLAIN_VIEWER')).toEqual(plain);
  });

  it('legitimate governance still works: SYSTEM_ADMIN assigns MANAGER, HR, HR_ADMIN and EXECUTIVE to others without inheriting them', async () => {
    for (const [key, role] of [['a', 'MANAGER'], ['b', 'HR'], ['c', 'HR_ADMIN'], ['d', 'EXECUTIVE']] as const) {
      expect(`${role} ${err(await as(sys, 'patch', `${U}/${ids[key]}/roles`).send({ roleCodes: [role] }))}`).toBe(`${role} 200`);
    }
    expect((await loginAs(app, 'c@t45.local', PW)).user).toMatchObject({ permissions: expect.arrayContaining(['compensation_planning.apply']) });
    expect((await permsOf(sys)).filter((p) => p.startsWith('compensation_planning.'))).toEqual([]);
    for (const k of ['a', 'b', 'c', 'd']) await setRolesDirect(ids[k]!, ['EMPLOYEE']);
  });

  it('ordinary administrators keep the Task 3/3.1 rules', async () => {
    expect(err(await as(hrAdmin, 'patch', `${U}/${ids.a}/roles`).send({ roleCodes: ['SYSTEM_ADMIN'] }))).toBe('403 ROLE_ESCALATION_NOT_ALLOWED');
    expect(err(await as(hrAdmin, 'patch', `${U}/${ids.hrAdmin}/roles`).send({ roleCodes: ['HR_ADMIN', 'SYSTEM_ADMIN'] }))).toBe('403 ROLE_ESCALATION_NOT_ALLOWED');
    expect(err(await as(hrAdmin, 'patch', `/api/v1/roles/${await roleId('EMPLOYEE')}/permissions`).send({ permissionCodes: ['dashboard.view'] }))).toBe('403 FORBIDDEN');
  });

  it('after every failed escalation, compensation Apply and payroll administration stay denied and nothing is written', async () => {
    const comps = await prisma.employeeCompensation.count();
    expect(err(await as(sys, 'post', '/api/v1/compensation-planning/cycles/any/apply'))).toBe('403 FORBIDDEN');
    expect(err(await as(rbacOnly, 'post', '/api/v1/compensation-planning/cycles/any/apply'))).toBe('403 FORBIDDEN');
    expect(err(await as(rbacOnly, 'get', '/api/v1/payroll/compensations'))).toBe('403 FORBIDDEN');
    expect(err(await as(rbacOnly, 'post', '/api/v1/payroll/compensations').send({ employeeId: ids.empEmp, effectiveFrom: '2026-01-01', baseSalary: '1.00', currencyCode: 'THB' }))).toBe('403 FORBIDDEN');
    expect(await prisma.employeeCompensation.count()).toBe(comps);
  });
});

describe('security matrix (actor × target × action)', () => {
  // Expected outcome per actor for each target. "priv" = refused because the target is a privileged account.
  type Outcome = 'ok' | 'forbidden' | 'priv';
  const targets = ['employee', 'manager', 'hrAdmin2', 'sys2'] as const;
  const expected: Record<string, Record<(typeof targets)[number], Outcome>> = {
    employee: { employee: 'forbidden', manager: 'forbidden', hrAdmin2: 'forbidden', sys2: 'forbidden' },
    hr: { employee: 'forbidden', manager: 'forbidden', hrAdmin2: 'forbidden', sys2: 'forbidden' },
    hrAdmin: { employee: 'ok', manager: 'ok', hrAdmin2: 'ok', sys2: 'priv' },
    sys: { employee: 'ok', manager: 'ok', hrAdmin2: 'ok', sys2: 'ok' },
  };
  const code = (o: Outcome, okStatus: number) => (o === 'ok' ? `${okStatus}` : o === 'priv' ? '403 PRIVILEGED_ACCOUNT_PROTECTED' : '403 FORBIDDEN');

  it('reset / patch / deactivate / assign role', async () => {
    // fresh sessions: earlier tests revoked some of them on purpose
    [employee, hr, hrAdmin, sys] = await Promise.all(['employee', 'hr', 'hradmin', 'sys'].map((u) => loginAs(app, `${u}@t45.local`, PW)));
    const sessions: Record<string, Session> = { employee, hr, hrAdmin, sys };
    const rows: string[] = [];
    for (const [actor, byTarget] of Object.entries(expected)) {
      for (const t of targets) {
        const s = sessions[actor]!;
        const id = ids[t]!;
        const snapshot = await prisma.user.findUniqueOrThrow({ where: { id } });
        const roles = await rolesOf(id);
        const results = [
          err(await as(s, 'post', `${A}/${id}/password-reset`)),
          err(await as(s, 'patch', `${U}/${id}`).send({ email: `m-${actor}-${t}@t45.local`.toLowerCase() })),
          err(await as(s, 'patch', `${U}/${id}/deactivate`)),
          err(await as(s, 'patch', `${U}/${id}/roles`).send({ roleCodes: [...roles, 'EMPLOYEE'].filter((v, i, a) => a.indexOf(v) === i) })),
        ];
        const want = [code(byTarget[t], 201), code(byTarget[t], 200), code(byTarget[t], 200), code(byTarget[t], 200)];
        rows.push(`${actor}→${t}: ${results.join(' | ')}`);
        expect(`${actor}→${t}: ${results.join(' | ')}`).toBe(`${actor}→${t}: ${want.join(' | ')}`);
        // restore the target for the next actor
        await prisma.user.update({ where: { id }, data: { email: snapshot.email, isActive: true } });
        await setRolesDirect(id, roles);
        await prisma.passwordResetToken.deleteMany({ where: { userId: id } });
      }
    }
    expect(rows).toHaveLength(16);
  });
});
