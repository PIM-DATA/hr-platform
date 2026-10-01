/**
 * Task 50 — T44-P1-21: data scope is resolved for the permission being exercised.
 *
 * Before Task 50 a user's data scope was the widest across ALL their roles, whatever permission granted the access:
 * MANAGER (TEAM) + EXECUTIVE (ALL) read every private document and every individual Report Center row, because
 * `documents.view` / `reports.view_individual` come only from MANAGER, yet were exercised at EXECUTIVE's ALL.
 * Now: scope(permission) = widest scope among the roles that GRANT that permission; an unrelated role never contributes.
 *
 * Fixture: two departments with different managers. A: MGR_A → A1, A2. B: MGR_B → B1, B2. Plus EXEC, HRA.
 */
import { createHash } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PERMISSIONS as P } from '@hr/shared';
import { prisma } from '../src/lib/prisma';
import { env } from '../src/config/env';
import { resetCopilotProvider, scriptFakeProvider, type ProviderRequest } from '../src/modules/copilot/provider';
import { createTestServer, createUser, loginAs, resetDatabase } from './helpers';

const app = createTestServer();
const PW = 'Correct-Horse-1';
type S = { cookie: string; csrf: string };
const as = (s: S, m: 'get' | 'post' | 'patch' | 'put' | 'delete', url: string) => request(app)[m](url).set('Cookie', s.cookie).set('x-csrf-token', s.csrf);
const E: Record<string, string> = {};
const S: Record<string, S> = {};
const DOC: Record<string, string> = {};

async function role(code: string, dataScope: 'SELF' | 'TEAM' | 'ALL', permissions: string[]) {
  const perms = await prisma.permission.findMany({ where: { code: { in: permissions } } });
  expect(perms).toHaveLength(permissions.length);
  return prisma.role.create({ data: { code, name: code, dataScope, rolePermissions: { create: perms.map((p) => ({ permissionId: p.id })) } } });
}
async function userWith(email: string, employeeId: string | undefined, roleCodes: string[]) {
  const [first, ...rest] = roleCodes;
  const u = await createUser({ email, password: PW, role: first!, employeeId });
  for (const code of rest) {
    const r = await prisma.role.findUniqueOrThrow({ where: { code } });
    await prisma.userRole.create({ data: { userId: u.id, roleId: r.id } });
  }
  return loginAs(app, email, PW);
}
const codes = (body: { data: { employeeCode: string }[] }) => body.data.map((e) => e.employeeCode).sort();

beforeAll(async () => {
  await resetDatabase();
  const org = await prisma.organization.create({ data: { code: 'PS', name: 'Scope Co', timezone: 'Asia/Bangkok' } });
  const mk = async (code: string, dept: string, managerId: string | null) => {
    const d = await prisma.department.upsert({ where: { organizationId_code: { organizationId: org.id, code: dept } }, update: {}, create: { organizationId: org.id, code: dept, name: dept } });
    const pos = await prisma.position.create({ data: { departmentId: d.id, code: `P-${code}`, title: code } });
    E[code] = (await prisma.employee.create({ data: { employeeCode: code, firstName: code, lastName: 'X', email: `${code.toLowerCase()}@ps.local`, hireDate: new Date('2020-01-01'), organizationId: org.id, departmentId: d.id, positionId: pos.id, managerId, employmentType: 'FULL_TIME', employmentStatus: 'ACTIVE' } })).id;
  };
  await mk('EXEC', 'HQ', null);
  await mk('HRA', 'HQ', null);
  await mk('MGR_A', 'DA', E.EXEC!);
  await mk('MGR_B', 'DB', E.EXEC!);
  for (const c of ['A1', 'A2']) await mk(c, 'DA', E.MGR_A!);
  for (const c of ['B1', 'B2']) await mk(c, 'DB', E.MGR_B!);
  await mk('MGR_C', 'DC', E.EXEC!);
  await mk('C1', 'DC', E.MGR_C!);
  await mk('X1', 'HQ', null);
  await mk('R1', 'HQ', null);
  await mk('R2', 'HQ', null);

  // custom roles for the conceptual combinations (§18)
  await role('EMP_VIEW_SELF', 'SELF', [P.EMPLOYEES_VIEW, P.DASHBOARD_VIEW]);
  await role('EMP_VIEW_TEAM', 'TEAM', [P.EMPLOYEES_VIEW]);
  await role('LEAVE_VIEW_ALL', 'ALL', [P.LEAVE_VIEW]);
  await role('ORG_REPORTS_TEAM', 'TEAM', [P.PERFORMANCE_VIEW_REPORTS, P.COMPETENCY_VIEW_REPORTS]);
  await role('RBAC_SELF', 'SELF', [P.ROLES_VIEW, P.ROLES_MANAGE, P.USERS_VIEW, P.USERS_UPDATE]);
  await role('UNRELATED_ALL', 'ALL', [P.DASHBOARD_VIEW]);
  await role('LEAVE_VIEW_TEAM', 'TEAM', [P.LEAVE_VIEW]);

  S.mgrExec = await userWith('mgrexec@ps.local', E.MGR_A!, ['MANAGER', 'EXECUTIVE']); // the Task 44 combination
  S.mgrB = await userWith('mgrb@ps.local', E.MGR_B!, ['MANAGER']);
  S.exec = await userWith('exec@ps.local', E.EXEC!, ['EXECUTIVE']);
  S.hra = await userWith('hra@ps.local', E.HRA!, ['HR_ADMIN']);
  S.selfPlusLeaveAll = await userWith('a1@ps.local', E.A1!, ['EMP_VIEW_SELF', 'LEAVE_VIEW_ALL']); // A
  S.teamPlusLeaveAll = await userWith('mgrc@ps.local', E.MGR_C!, ['EMP_VIEW_TEAM', 'LEAVE_VIEW_ALL']); // B
  S.selfPlusTeam = await userWith('b1@ps.local', E.B1!, ['EMP_VIEW_SELF', 'EMP_VIEW_TEAM']); // C (as B1: team = B1 only)
  S.teamPlusAll = await userWith('x1@ps.local', E.X1!, ['EMP_VIEW_TEAM', 'HR']); // D: employees.view TEAM + ALL
  S.leaveAllOnly = await userWith('b2@ps.local', E.B2!, ['LEAVE_VIEW_ALL']); // E
  S.reportsTeamPlusAll = await userWith('r1@ps.local', E.R1!, ['ORG_REPORTS_TEAM', 'LEAVE_VIEW_ALL']);
  S.rbac = await userWith('r2@ps.local', E.R2!, ['RBAC_SELF', 'UNRELATED_ALL', 'LEAVE_VIEW_TEAM']); // F: RBAC manager, no business authority beyond these

  // documents of A1 (team of MGR_A) and B1 (department B): one PUBLIC_INTERNAL and one EMPLOYEE_PRIVATE each
  const cat = await prisma.documentCategory.create({ data: { code: 'PSCAT', name: 'Employee file', scopeType: 'GENERAL' } });
  const admin = await prisma.user.findFirstOrThrow({ where: { email: 'hra@ps.local' } });
  let n = 0;
  for (const owner of ['A1', 'B1']) {
    for (const classification of ['PUBLIC_INTERNAL', 'EMPLOYEE_PRIVATE'] as const) {
      n += 1;
      const d = await prisma.document.create({ data: { documentNumber: `DOC-PS-${owner}-${classification}`, title: `File of ${owner}`, categoryId: cat.id, ownerEmployeeId: E[owner]!, classification, createdByUserId: admin.id } });
      await prisma.documentVersion.create({ data: { documentId: d.id, versionNumber: 1, storageKey: `documents/aa/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, originalFilename: 'x.pdf', mimeType: 'application/pdf', fileSize: 1, sha256: createHash('sha256').update(String(n)).digest('hex'), uploadedByUserId: admin.id } });
      DOC[`${owner}_${classification === 'PUBLIC_INTERNAL' ? 'PUB' : 'PRIV'}`] = d.id;
    }
  }
}, 120000);
afterAll(async () => { await resetDatabase(); await prisma.$disconnect(); });

describe('the Task 44 exploit: MANAGER + EXECUTIVE', () => {
  it('documents.view comes only from MANAGER (TEAM): no document of another department, no private file', async () => {
    // Before Task 50: 200 for all three — documents.view was exercised at EXECUTIVE's ALL scope.
    for (const k of ['B1_PUB', 'B1_PRIV', 'A1_PRIV']) expect((await as(S.mgrExec!, 'get', `/api/v1/documents/${DOC[k]}`)).status, k).toBe(404);
    expect((await as(S.mgrExec!, 'get', `/api/v1/documents/${DOC.A1_PUB}`)).status).toBe(200); // own team's public file
    const list = await as(S.mgrExec!, 'get', '/api/v1/documents?pageSize=100');
    expect(list.status).toBe(200);
    expect(list.body.data.map((d: { id: string }) => d.id)).toEqual([DOC.A1_PUB]);
    expect((await as(S.mgrExec!, 'get', `/api/v1/documents?ownerEmployeeId=${E.B1}`)).body.data).toEqual([]); // crafted filter
    // HR (documents.manage, ALL) still sees everything
    expect((await as(S.hra!, 'get', '/api/v1/documents?pageSize=100')).body.data).toHaveLength(4);
  });

  it('reports.view_individual comes only from MANAGER (TEAM): the employee directory dataset returns the team only', async () => {
    const r = await as(S.mgrExec!, 'post', '/api/v1/reports/run').send({ datasetId: 'employee_directory', page: 1, definition: { columns: ['employeeCode'], filters: [], sort: [], groupBy: [], aggregations: [], pageSize: 100 } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const got = r.body.data.rows.map((x: { employeeCode: string }) => x.employeeCode).sort();
    expect(got).toEqual(['A1', 'A2', 'MGR_A']); // before Task 50: all 13 employees
  });

  it('employees.view is granted by BOTH roles: the same-permission union is ALL (by design)', async () => {
    const r = await as(S.mgrExec!, 'get', '/api/v1/employees?pageSize=100');
    expect(codes(r.body)).toHaveLength(13);
  });
});

describe('conceptual combinations (§18)', () => {
  it('A. employees.view SELF + unrelated leave.view ALL → employees SELF, leave ALL', async () => {
    const e = await as(S.selfPlusLeaveAll!, 'get', '/api/v1/employees?pageSize=100');
    expect(codes(e.body)).toEqual(['A1']); // before Task 50: all 13
    expect((await as(S.selfPlusLeaveAll!, 'get', `/api/v1/employees/${E.B1}`)).status).toBe(404); // direct detail
    expect((await as(S.selfPlusLeaveAll!, 'get', `/api/v1/employees?departmentId=${(await prisma.employee.findUniqueOrThrow({ where: { id: E.B1! } })).departmentId}`)).body.data).toEqual([]); // crafted filter
    const leave = await as(S.selfPlusLeaveAll!, 'get', `/api/v1/leave/requests?employeeId=${E.B1}`);
    expect(leave.status).toBe(200); // ALL for leave.view: the filter on B1 is allowed
  });

  it('B. employees.view TEAM + unrelated leave.view ALL → employees TEAM', async () => {
    expect(codes((await as(S.teamPlusLeaveAll!, 'get', '/api/v1/employees?pageSize=100')).body)).toEqual(['C1', 'MGR_C']);
    expect((await as(S.teamPlusLeaveAll!, 'get', `/api/v1/employees/${E.B2}`)).status).toBe(404);
  });

  it('C. employees.view SELF + the same permission TEAM → TEAM (widest of the roles granting it)', async () => {
    expect(codes((await as(S.selfPlusTeam!, 'get', '/api/v1/employees?pageSize=100')).body)).toEqual(['B1']); // B1 manages nobody
  });

  it('D. employees.view TEAM + the same permission ALL → ALL', async () => {
    expect(codes((await as(S.teamPlusAll!, 'get', '/api/v1/employees?pageSize=100')).body)).toHaveLength(13);
  });

  it('E. permission absent + unrelated ALL role → 403, no data', async () => {
    const r = await as(S.leaveAllOnly!, 'get', '/api/v1/employees?pageSize=100');
    expect(r.status).toBe(403);
  });

  it('manager TEAM is the direct-report team, not the department or the organization', async () => {
    expect(codes((await as(S.mgrB!, 'get', '/api/v1/employees?pageSize=100')).body)).toEqual(['B1', 'B2', 'MGR_B']);
    expect((await as(S.mgrB!, 'get', `/api/v1/employees/${E.A1}`)).status).toBe(404);
  });
});

const dirDef = { columns: ['employeeCode'], filters: [], sort: [], groupBy: [], aggregations: [], pageSize: 100 };

describe('Report Center: the source permission decides, sharing confers nothing', () => {
  it('CSV export of the employee directory carries the team only', async () => {
    const r = await as(S.mgrExec!, 'post', '/api/v1/reports/export').send({ datasetId: 'employee_directory', definition: dirDef, name: 'dir' });
    expect(r.status, r.text.slice(0, 200)).toBe(200);
    expect(r.text).toContain('A1');
    for (const c of ['B1', 'B2', 'C1', 'X1']) expect(r.text).not.toContain(`"${c}"`);
  });

  it('a report shared by HR (ALL) runs with the RUNNER\'s scope', async () => {
    const saved = await as(S.hra!, 'post', '/api/v1/reports/saved').send({ name: 'Directory', datasetId: 'employee_directory', visibility: 'SHARED', definition: dirDef });
    expect(saved.status, JSON.stringify(saved.body)).toBe(201);
    expect((await as(S.hra!, 'post', `/api/v1/reports/saved/${saved.body.data.id}/run`).send({ page: 1 })).body.data.rows).toHaveLength(13);
    const run = await as(S.mgrExec!, 'post', `/api/v1/reports/saved/${saved.body.data.id}/run`).send({ page: 1 });
    expect(run.body.data.rows.map((x: { employeeCode: string }) => x.employeeCode).sort()).toEqual(['A1', 'A2', 'MGR_A']);
  });
});

describe('organization reports need THEIR permission at ALL (Task 47 + Task 50)', () => {
  it('performance.view_reports / competency.view_reports at TEAM + an unrelated ALL role → 403', async () => {
    // Before Task 50: the ALL of leave.view counted → the performance route went on to the cycle (404), competency → 200.
    expect((await as(S.reportsTeamPlusAll!, 'get', '/api/v1/performance/cycles/any-cycle/report')).status).toBe(403);
    expect((await as(S.reportsTeamPlusAll!, 'get', '/api/v1/competency/reports/gaps')).status).toBe(403);
    // EXECUTIVE grants both at ALL → still allowed
    expect((await as(S.exec!, 'get', '/api/v1/competency/reports/gaps')).status).toBe(200);
  });
});

describe('Task 45 separation of duties, per permission', () => {
  it('F. an RBAC manager holding an unrelated ALL role cannot self-assign a role that widens leave.view TEAM → ALL', async () => {
    const me = await prisma.user.findFirstOrThrow({ where: { email: 'r2@ps.local' } });
    // Before Task 50: allowed — the widest scope was already ALL (from UNRELATED_ALL) and no new permission was gained.
    const r = await as(S.rbac!, 'patch', `/api/v1/users/${me.id}/roles`).send({ roleCodes: ['RBAC_SELF', 'UNRELATED_ALL', 'LEAVE_VIEW_TEAM', 'LEAVE_VIEW_ALL'] });
    expect(r.status).toBe(403);
    expect(['SELF_PRIVILEGE_ESCALATION_NOT_ALLOWED', 'ROLE_SCOPE_ESCALATION_NOT_ALLOWED']).toContain(r.body.error.code);
    expect((await prisma.userRole.count({ where: { userId: me.id } }))).toBe(3);
    // nor grant a wider role to someone else beyond the scope of its own user-administration permission (SELF)
    const other = await prisma.user.findFirstOrThrow({ where: { email: 'b2@ps.local' } });
    expect((await as(S.rbac!, 'patch', `/api/v1/users/${other.id}/roles`).send({ roleCodes: ['LEAVE_VIEW_ALL', 'LEAVE_VIEW_TEAM'] })).body.error?.code).toBe('ROLE_SCOPE_ESCALATION_NOT_ALLOWED');
    // and holds no business data access from its ALL role
    expect((await as(S.rbac!, 'get', '/api/v1/employees')).status).toBe(403);
  });
});

describe('Copilot tools run with their source permission\'s scope', () => {
  it('MANAGER + EXECUTIVE: report_query on the employee directory and document search stay within the team', async () => {
    env.COPILOT_ENABLED = true; env.COPILOT_PROVIDER = 'fake'; resetCopilotProvider();
    const seen: ProviderRequest[] = [];
    const call = (toolId: string, args: unknown) => (req: ProviderRequest) => { seen.push(req); return { kind: 'tool_calls' as const, calls: [{ id: 'c1', toolId, args }], usage: null }; };
    const answer = (req: ProviderRequest) => { seen.push(req); return { kind: 'answer' as const, text: 'ok', usage: { inputTokens: 1, outputTokens: 1 } }; };
    try {
      scriptFakeProvider([call('report_query', { datasetId: 'employee_directory', definition: dirDef }), answer]);
      const r = await as(S.mgrExec!, 'post', '/api/v1/copilot/chat').send({ message: 'list employees', history: [] });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      const shown = JSON.stringify(seen.map((x) => x.messages));
      expect(shown).toContain('A1');
      // copilot.use (both roles, ALL) and reports.view (both, ALL) must not lend their scope to reports.view_individual (TEAM)
      for (const c of ['B1', 'B2', 'C1', 'X1']) expect(shown).not.toContain(`"${c}"`);
    } finally {
      env.COPILOT_ENABLED = false; resetCopilotProvider();
    }
  });
});
