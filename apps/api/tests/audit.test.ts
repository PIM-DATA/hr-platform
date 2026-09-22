import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AUDIT_ACTIONS } from '@hr/shared';
import { prisma } from '../src/lib/prisma';
import { auditService } from '../src/services/audit/audit.service';
import { cleanUsers, createTestServer, createUser, ensureRoles, loginAs, resetDatabase } from './helpers';

const app = createTestServer();
const PW = 'Correct-Horse-1';
type Session = { cookie: string; csrf: string; user: { id: string } };
let admin: Session; // SYSTEM_ADMIN: audit.view + everything
let hrAdmin: Session; // HR_ADMIN: audit.view
let employee: Session; // no audit.view
const as = (s: Session, m: 'get' | 'post' | 'patch', url: string) => request(app)[m](url).set('Cookie', s.cookie).set('x-csrf-token', s.csrf);

let orgId: string, deptId: string, jobId: string, posId: string, posId2: string, empA: string, empB: string;

beforeAll(async () => {
  await resetDatabase();
  await createUser({ email: 'admin@audit.local', password: PW, role: 'SYSTEM_ADMIN' });
  await createUser({ email: 'hradmin@audit.local', password: PW, role: 'HR_ADMIN' });
  await createUser({ email: 'emp@audit.local', password: PW, role: 'EMPLOYEE' });
  admin = await loginAs(app, 'admin@audit.local', PW);
  hrAdmin = await loginAs(app, 'hradmin@audit.local', PW);
  employee = await loginAs(app, 'emp@audit.local', PW);
  await prisma.auditLog.deleteMany(); // start from a clean ledger (test tooling only)

  // representative mutations across every module → produce the ledger the tests read
  orgId = (await as(admin, 'post', '/api/v1/organizations').send({ code: 'AUD', name: 'Audit Co' })).body.data.id;
  deptId = (await as(admin, 'post', '/api/v1/departments').send({ organizationId: orgId, code: 'D1', name: 'Dept 1' })).body.data.id;
  jobId = (await as(admin, 'post', '/api/v1/jobs').send({ code: 'J1', title: 'Job 1' })).body.data.id;
  posId = (await as(admin, 'post', '/api/v1/positions').send({ departmentId: deptId, jobId, code: 'P1', title: 'Pos 1' })).body.data.id;
  posId2 = (await as(admin, 'post', '/api/v1/positions').send({ departmentId: deptId, jobId, code: 'P2', title: 'Pos 2' })).body.data.id;
  empA = (await as(admin, 'post', '/api/v1/employees').send({ employeeCode: 'A1', firstName: 'Ann', lastName: 'Audit', email: 'a1@audit.local', hireDate: '2026-01-01', positionId: posId })).body.data.id;
  empB = (await as(admin, 'post', '/api/v1/employees').send({ employeeCode: 'B1', firstName: 'Bob', lastName: 'Audit', email: 'b1@audit.local', hireDate: '2026-01-01', positionId: posId })).body.data.id;
});
afterAll(async () => {
  await resetDatabase();
  await prisma.$disconnect();
});

const list = (s: Session, qs = '') => as(s, 'get', `/api/v1/audit-logs${qs}`);

// ------------------------------------------------------------------ permissions
describe('permissions', () => {
  it('1. unauthenticated → 401', async () => {
    expect((await request(app).get('/api/v1/audit-logs')).status).toBe(401);
  });
  it('2. without audit.view → 403 (list); 4. detail 403', async () => {
    expect((await list(employee)).status).toBe(403);
    const any = await prisma.auditLog.findFirstOrThrow();
    expect((await as(employee, 'get', `/api/v1/audit-logs/${any.id}`)).status).toBe(403);
  });
  it('3. audit.view → 200 (HR_ADMIN)', async () => {
    const res = await list(hrAdmin);
    expect(res.status).toBe(200);
    expect(res.body.meta.total).toBeGreaterThan(5);
  });
  it('audit API is read-only: no POST/PATCH/DELETE routes', async () => {
    const any = await prisma.auditLog.findFirstOrThrow();
    expect((await as(admin, 'post', '/api/v1/audit-logs').send({})).status).toBe(404);
    expect((await as(admin, 'patch', `/api/v1/audit-logs/${any.id}`).send({})).status).toBe(404);
    expect((await request(app).delete(`/api/v1/audit-logs/${any.id}`).set('Cookie', admin.cookie).set('x-csrf-token', admin.csrf)).status).toBe(404);
  });
});

// ------------------------------------------------------------------ filters
describe('filters / pagination', () => {
  it('5. by user', async () => {
    const res = await list(admin, `?userId=${admin.user.id}`);
    expect(res.body.data.length).toBeGreaterThan(0);
    expect(res.body.data.every((r: { actor: { userId: string } }) => r.actor.userId === admin.user.id)).toBe(true);
    expect((await list(admin, `?userId=${employee.user.id}&action=CREATE_EMPLOYEE`)).body.meta.total).toBe(0);
  });
  it('6. by module; 7. by action; 8. by recordType; 9. by recordId', async () => {
    const mod = await list(admin, '?module=organization');
    expect(mod.body.data.every((r: { module: string }) => r.module === 'organization')).toBe(true);
    expect(mod.body.meta.total).toBe(5); // org + dept + job + 2 positions
    const act = await list(admin, '?action=CREATE_EMPLOYEE');
    expect(act.body.meta.total).toBe(2);
    const type = await list(admin, '?recordType=Position');
    expect(type.body.meta.total).toBe(2);
    const rec = await list(admin, `?recordId=${empA}`);
    expect(rec.body.data.every((r: { recordId: string }) => r.recordId === empA)).toBe(true);
    expect(rec.body.meta.total).toBe(1);
  });
  it('10. dateFrom (inclusive) / 11. dateTo (exclusive) / 12. combined', async () => {
    const all = (await list(admin, '?sortDir=asc&pageSize=100')).body.data as { createdAt: string; module: string }[];
    const first = all[0].createdAt, last = all.at(-1)!.createdAt;
    expect((await list(admin, `?dateFrom=${first}`)).body.meta.total).toBe(all.length); // inclusive lower bound
    expect((await list(admin, `?dateTo=${first}`)).body.meta.total).toBe(0); // exclusive upper bound
    const afterLast = new Date(new Date(last).getTime() + 1).toISOString();
    expect((await list(admin, `?dateTo=${afterLast}`)).body.meta.total).toBe(all.length);
    expect((await list(admin, `?dateFrom=${afterLast}`)).body.meta.total).toBe(0);
    const combined = await list(admin, `?dateFrom=${first}&dateTo=${afterLast}&module=employees&action=CREATE_EMPLOYEE&recordType=Employee`);
    expect(combined.body.meta.total).toBe(2);
  });
  it('13. pagination; 14. newest first by default', async () => {
    const p1 = await list(admin, '?pageSize=3&page=1');
    const p2 = await list(admin, '?pageSize=3&page=2');
    expect(p1.body.data).toHaveLength(3);
    expect(p1.body.meta).toMatchObject({ page: 1, pageSize: 3 });
    expect(p1.body.data.map((r: { id: string }) => r.id)).not.toEqual(p2.body.data.map((r: { id: string }) => r.id));
    const times = p1.body.data.map((r: { createdAt: string }) => new Date(r.createdAt).getTime());
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    expect(p1.body.data[0].action).toBe('CREATE_EMPLOYEE'); // last mutation in beforeAll
    const asc = await list(admin, '?sortDir=asc&pageSize=1');
    expect(asc.body.data[0].action).toBe('CREATE_ORGANIZATION');
  });
  it('15. invalid query rejected (unknown module/action, bad recordType, pageSize > 100, from > to)', async () => {
    for (const qs of ['?module=hacker', '?action=DROP_TABLE', '?recordType=Employee;--', '?pageSize=500', '?dateFrom=2026-02-01&dateTo=2026-01-01', '?dateFrom=not-a-date', '?sortDir=random']) {
      const res = await list(admin, qs);
      expect(res.status, qs).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }
  });
  it('list items carry actor/hasChanges but no old/new payload', async () => {
    const res = await list(admin, '?action=CREATE_EMPLOYEE&pageSize=1');
    const row = res.body.data[0];
    expect(row).toMatchObject({ module: 'employees', recordType: 'Employee', recordId: expect.any(String), hasChanges: true, actor: { userId: admin.user.id, email: 'admin@audit.local' } });
    expect(row).not.toHaveProperty('oldValue');
    expect(row).not.toHaveProperty('newValue');
  });
});

// ------------------------------------------------------------------ detail / redaction
describe('detail / redaction', () => {
  it('16. detail returns old/new (parsed JSON)', async () => {
    const upd = await as(admin, 'patch', `/api/v1/organizations/${orgId}`).send({ name: 'Audit Company' });
    expect(upd.status).toBe(200);
    const row = await prisma.auditLog.findFirstOrThrow({ where: { action: 'UPDATE_ORGANIZATION', recordId: orgId } });
    const res = await as(hrAdmin, 'get', `/api/v1/audit-logs/${row.id}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ action: 'UPDATE_ORGANIZATION', oldValue: { name: 'Audit Co' }, newValue: { name: 'Audit Company' }, actor: { email: 'admin@audit.local' } });
  });
  it('17. actor null (system / anonymous) is handled', async () => {
    await request(app).post('/api/v1/auth/login').send({ email: 'ghost@audit.local', password: 'whatever-1' }); // LOGIN_FAILED with no user
    const row = await prisma.auditLog.findFirstOrThrow({ where: { action: 'LOGIN_FAILED', userId: null } });
    const res = await as(admin, 'get', `/api/v1/audit-logs/${row.id}`);
    expect(res.status).toBe(200);
    expect(res.body.data.actor).toBeNull();
    expect(res.body.data.recordId).toBeNull();
    expect(res.body.data.newValue).toEqual({ email: 'ghost@audit.local', reason: 'INVALID_CREDENTIALS' });
    const inList = await list(admin, '?action=LOGIN_FAILED');
    expect(inList.body.data[0].actor).toBeNull();
  });
  it('18. missing id → 404 AUDIT_LOG_NOT_FOUND', async () => {
    const res = await as(admin, 'get', '/api/v1/audit-logs/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('AUDIT_LOG_NOT_FOUND');
  });
  it('19–22. read-side redaction: nested password/token, array-nested secret, authorization/cookie (row written raw, bypassing the write redaction)', async () => {
    // simulate a legacy/malicious row that contains secrets in old_value/new_value
    const raw = await prisma.auditLog.create({
      data: {
        action: 'UPDATE_USER', module: 'users', recordType: 'User', recordId: 'x',
        oldValue: JSON.stringify({ profile: { password: 'p@ss', passwordHash: '$2b$12$abc', nested: { accessToken: 'tok', refresh_token: 'r' } }, keep: 'visible' }),
        newValue: JSON.stringify({ items: [{ apiKey: 'k1' }, { list: [{ secret: 's' }, { safe: 1 }] }], headers: { Authorization: 'Bearer x', cookie: 'hr_session=abc', csrf: 'c' }, token_hash: 'th' }),
      },
    });
    const res = await as(admin, 'get', `/api/v1/audit-logs/${raw.id}`);
    expect(res.status).toBe(200);
    expect(res.body.data.oldValue).toEqual({ profile: { password: '[REDACTED]', passwordHash: '[REDACTED]', nested: { accessToken: '[REDACTED]', refresh_token: '[REDACTED]' } }, keep: 'visible' });
    expect(res.body.data.newValue).toEqual({ items: [{ apiKey: '[REDACTED]' }, { list: [{ secret: '[REDACTED]' }, { safe: 1 }] }], headers: { Authorization: '[REDACTED]', cookie: '[REDACTED]', csrf: '[REDACTED]' }, token_hash: '[REDACTED]' });
    expect(JSON.stringify(res.body)).not.toMatch(/"p@ss"|\$2b\$|"Bearer x"|hr_session=abc|"tok"|"r"|"k1"|"s"|"c"|"th"/);
    // the stored row is untouched (no mutation on read)
    const stored = await prisma.auditLog.findUniqueOrThrow({ where: { id: raw.id } });
    expect(stored.oldValue).toContain('p@ss');
  });
  it('23. malformed stored JSON does not crash', async () => {
    const bad = await prisma.auditLog.create({ data: { action: 'UPDATE_USER', module: 'users', recordType: 'User', oldValue: '{not json', newValue: 'null' } });
    const res = await as(admin, 'get', `/api/v1/audit-logs/${bad.id}`);
    expect(res.status).toBe(200);
    expect(res.body.data.oldValue).toEqual({ _unparsed: true });
    expect(res.body.data.newValue).toBeNull();
    expect(res.body.data.hasChanges).toBe(true);
  });
});

// ------------------------------------------------------------------ completeness
describe('completeness', () => {
  const count = (action: string, recordId?: string) => prisma.auditLog.count({ where: { action, ...(recordId ? { recordId } : {}) } });

  it('24. create user → CREATE_USER', async () => {
    const res = await as(admin, 'post', '/api/v1/users').send({ email: 'new@audit.local', password: PW, roleCodes: ['HR'] });
    expect(res.status).toBe(201);
    expect(await count('CREATE_USER', res.body.data.id)).toBe(1);
  });
  it('25. update role permissions → UPDATE_ROLE_PERMISSIONS', async () => {
    const role = await prisma.role.findUniqueOrThrow({ where: { code: 'EXECUTIVE' }, include: { rolePermissions: { include: { permission: true } } } });
    const codes = role.rolePermissions.map((rp) => rp.permission.code);
    expect((await as(admin, 'patch', `/api/v1/roles/${role.id}/permissions`).send({ permissionCodes: [...codes, 'audit.view'] })).status).toBe(200);
    expect(await count('UPDATE_ROLE_PERMISSIONS', role.id)).toBe(1);
    await as(admin, 'patch', `/api/v1/roles/${role.id}/permissions`).send({ permissionCodes: codes });
  });
  it('26. create department → CREATE_DEPARTMENT (already produced in setup)', async () => {
    expect(await count('CREATE_DEPARTMENT', deptId)).toBe(1);
  });
  it('27. change employee position → CHANGE_EMPLOYEE_POSITION with org/dept/position old→new', async () => {
    expect((await as(admin, 'patch', `/api/v1/employees/${empA}/position`).send({ positionId: posId2 })).status).toBe(200);
    const row = await prisma.auditLog.findFirstOrThrow({ where: { action: 'CHANGE_EMPLOYEE_POSITION', recordId: empA } });
    expect(JSON.parse(row.oldValue!)).toEqual({ organizationId: orgId, departmentId: deptId, positionId: posId });
    expect(JSON.parse(row.newValue!)).toMatchObject({ organizationId: orgId, departmentId: deptId, positionId: posId2 });
  });
  it('28. change employee manager → CHANGE_EMPLOYEE_MANAGER', async () => {
    expect((await as(admin, 'patch', `/api/v1/employees/${empB}/manager`).send({ managerId: empA })).status).toBe(200);
    expect(await count('CHANGE_EMPLOYEE_MANAGER', empB)).toBe(1);
  });
  it('29. department head change → UPDATE_DEPARTMENT_HEAD', async () => {
    expect((await as(admin, 'patch', `/api/v1/departments/${deptId}/head`).send({ employeeId: empA })).status).toBe(200);
    expect(await count('UPDATE_DEPARTMENT_HEAD', deptId)).toBe(1);
  });
  it('30. failed administrative mutation leaves no audit record', async () => {
    const before = await prisma.auditLog.count();
    expect((await as(admin, 'post', '/api/v1/organizations').send({ code: 'AUD', name: 'dup' })).status).toBe(409);
    expect((await as(admin, 'patch', `/api/v1/employees/${empA}/manager`).send({ managerId: empA })).status).toBe(400);
    expect((await as(admin, 'patch', `/api/v1/employees/${empA}/deactivate`)).status).toBe(409); // head + manager
    expect(await prisma.auditLog.count()).toBe(before);
  });

  it('matrix: every AUDIT_ACTIONS code is written by exactly one service (no orphan enum values, no untracked writers)', () => {
    const files: string[] = [];
    const walk = (dir: string) => { for (const f of readdirSync(dir)) { const p = path.join(dir, f); statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') && files.push(p); } };
    walk(path.join(__dirname, '../src'));
    const sources = files.map((f) => ({ f, s: readFileSync(f, 'utf8') }));
    const missing: string[] = [];
    for (const action of Object.values(AUDIT_ACTIONS)) {
      const used = sources.some(({ s }) => s.includes(`AUDIT_ACTIONS.${action}`) || s.includes(`'${action}'`) || new RegExp(`\\b${action}\\b`).test(s));
      if (!used) missing.push(action);
    }
    expect(missing).toEqual([]);
    // only the audit service (and test tooling) may write to audit_logs
    const writers = sources.filter(({ s }) => /auditLog\.(create|update|delete|upsert|updateMany|deleteMany)/.test(s)).map(({ f }) => path.relative(path.join(__dirname, '../src'), f));
    expect(writers).toEqual(['services/audit/audit.service.ts']);
    const creators = sources.filter(({ s }) => /auditLog\.create/.test(s)).map(({ f }) => path.basename(f));
    expect(creators).toEqual(['audit.service.ts']);
  });
});

// ------------------------------------------------------------------ transaction policy
describe('transaction policy', () => {
  it('audit insert failure rolls back the administrative mutation (department update)', async () => {
    const before = await prisma.department.findUniqueOrThrow({ where: { id: deptId } });
    const spy = vi.spyOn(auditService, 'log').mockRejectedValueOnce(new Error('audit store unavailable'));
    const res = await as(admin, 'patch', `/api/v1/departments/${deptId}`).send({ name: 'Should not persist' });
    spy.mockRestore();
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
    const after = await prisma.department.findUniqueOrThrow({ where: { id: deptId } });
    expect(after.name).toBe(before.name);
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    expect(await prisma.auditLog.count({ where: { action: 'UPDATE_DEPARTMENT', recordId: deptId } })).toBe(0);
  });
  it('audit failure on an employee position change rolls back pointers AND history', async () => {
    const before = await prisma.employee.findUniqueOrThrow({ where: { id: empB } });
    const histBefore = await prisma.employeePosition.count({ where: { employeeId: empB } });
    const spy = vi.spyOn(auditService, 'log').mockRejectedValueOnce(new Error('audit store unavailable'));
    const res = await as(admin, 'patch', `/api/v1/employees/${empB}/position`).send({ positionId: posId2 });
    spy.mockRestore();
    expect(res.status).toBe(500);
    const after = await prisma.employee.findUniqueOrThrow({ where: { id: empB } });
    expect(after.positionId).toBe(before.positionId);
    expect(await prisma.employeePosition.count({ where: { employeeId: empB } })).toBe(histBefore);
    expect(await prisma.employeePosition.count({ where: { employeeId: empB, endDate: null } })).toBe(1);
  });
  it('auth events are best-effort: login still succeeds when the audit INSERT fails', async () => {
    // simulate the database rejecting the audit row (the service itself swallows the error in best-effort mode)
    const spy = vi.spyOn(prisma.auditLog, 'create').mockRejectedValueOnce(new Error('audit store unavailable'));
    const res = await request(app).post('/api/v1/auth/login').send({ email: 'admin@audit.local', password: PW });
    spy.mockRestore();
    expect(res.status).toBe(200);
  });
});
