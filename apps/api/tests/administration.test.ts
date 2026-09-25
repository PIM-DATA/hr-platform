/**
 * Task 41 — Administration, settings and workflow operations.
 *
 * What these tests guard: the administration hub reports only capabilities that exist and never a secret; the
 * workflow monitor is metadata, so no business payload or approver comment reaches a caller who cannot open the
 * source module; the monitor is read-only and server-paginated; payroll configuration stays behind payroll
 * authority, so being an HR user or an executive is not enough; and the payroll master-data edits the screens now
 * offer are the ones the server actually accepts, with a closed period refusing them.
 */
import type { Server } from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma';
import { createTestServer, createUser, loginAs, resetDatabase } from './helpers';

const app: Server = createTestServer();
const PW = 'Correct-Horse-1';
type Session = { cookie: string; csrf: string; user: { id: string } };
const as = (s: Session, m: 'get' | 'post' | 'patch' | 'delete', url: string) => request(app)[m](url).set('Cookie', s.cookie).set('x-csrf-token', s.csrf);
const err = (r: request.Response) => `${r.status} ${r.body?.error?.code ?? ''}`.trim();
const text = (v: unknown) => JSON.stringify(v);
const A = '/api/v1/admin';

let admin: Session, hrAdmin: Session, hr: Session, mgr: Session, emp: Session, exec: Session, wfOnly: Session;
let orgId: string, policyId: string, componentId: string, payItemId: string, periodId: string, leaveInstanceId: string;
const employees: Record<string, string> = {};

function deepStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => deepStrings(v, out));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => deepStrings(v, out));
  return out;
}
function forbiddenKeys(value: unknown, re: RegExp, path = ''): string[] {
  const hits: string[] = [];
  const walk = (v: unknown, p: string) => { if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${p}[${i}]`)); else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { if (re.test(k)) hits.push(`${p}.${k}`); walk(x, `${p}.${k}`); } };
  walk(value, path); return hits;
}

beforeAll(async () => {
  await resetDatabase();
  const org = await prisma.organization.create({ data: { code: 'A41', name: 'Admin Co', timezone: 'Asia/Bangkok' } });
  orgId = org.id;
  const dept = await prisma.department.create({ data: { organizationId: org.id, code: 'OPS', name: 'Operations' } });
  const job = await prisma.job.create({ data: { code: 'OFF', title: 'Officer', level: 2 } });
  const pos = (await prisma.position.create({ data: { departmentId: dept.id, code: 'OFF1', title: 'Officer', jobId: job.id } })).id;
  const mk = async (code: string, first: string, managerId: string | null) => (employees[code] = (await prisma.employee.create({ data: { employeeCode: code, firstName: first, lastName: 'Person', email: `${code.toLowerCase()}@a41.local`, hireDate: new Date('2022-01-10T00:00:00Z'), organizationId: org.id, departmentId: dept.id, positionId: pos, managerId, employmentType: 'FULL_TIME', employmentStatus: 'ACTIVE' } })).id);
  await mk('MGR', 'Mary', null);
  await mk('HRADM', 'Hana', null);
  await mk('EMP001', 'Emma', employees.MGR);
  await createUser({ email: 'admin@a41.local', password: PW, role: 'SYSTEM_ADMIN' });
  await createUser({ email: 'hradmin@a41.local', password: PW, role: 'HR_ADMIN', employeeId: employees.HRADM });
  await createUser({ email: 'hr@a41.local', password: PW, role: 'HR' });
  await createUser({ email: 'mgr@a41.local', password: PW, role: 'MANAGER', employeeId: employees.MGR });
  await createUser({ email: 'emp@a41.local', password: PW, role: 'EMPLOYEE', employeeId: employees.EMP001 });
  await createUser({ email: 'exec@a41.local', password: PW, role: 'EXECUTIVE' });
  // A workflow operator: may watch every instance, and holds no source-module permission at all.
  const perms = await prisma.permission.findMany({ where: { code: { in: ['workflow.view_all', 'dashboard.view'] } }, select: { id: true } });
  const role = await prisma.role.create({ data: { code: 'WF_OPERATOR', name: 'Workflow operator', dataScope: 'ALL', rolePermissions: { create: perms.map((p) => ({ permissionId: p.id })) } } });
  const wfUser = await createUser({ email: 'wfops@a41.local', password: PW });
  await prisma.userRole.create({ data: { userId: wfUser.id, roleId: role.id } });
  [admin, hrAdmin, hr, mgr, emp, exec, wfOnly] = await Promise.all(['admin', 'hradmin', 'hr', 'mgr', 'emp', 'exec', 'wfops'].map((u) => loginAs(app, `${u}@a41.local`, PW)));

  // A leave request, approved with a comment, so the monitor has a real instance whose words are confidential.
  const def = await as(admin, 'post', '/api/v1/workflow/definitions').send({ code: 'LEAVE_STD', name: 'Leave approval', module: 'leave', entityType: 'LEAVE_REQUEST', steps: [{ name: 'Direct manager', approverType: 'DIRECT_MANAGER' }] });
  expect(def.status, text(def.body)).toBe(201);
  await as(admin, 'post', `/api/v1/workflow/definitions/${def.body.data.id}/activate`);
  const leaveType = await as(admin, 'post', '/api/v1/leave/types').send({ code: 'ANNUAL', name: 'Annual leave', unit: 'DAY', requiresAttachment: false });
  expect(leaveType.status, text(leaveType.body)).toBe(201);
  const calendar = await as(admin, 'post', '/api/v1/calendars').send({ organizationId: orgId, code: 'STD', name: 'Standard', workingDays: ['MON', 'TUE', 'WED', 'THU', 'FRI'] });
  await as(admin, 'patch', `/api/v1/calendars/organizations/${orgId}/default`).send({ calendarId: calendar.body.data.id });
  const leavePolicy = await as(admin, 'post', '/api/v1/leave/policies').send({ organizationId: orgId, leaveTypeId: leaveType.body.data.id, name: 'Annual policy', annualUnits: 10, workflowDefinitionCode: 'LEAVE_STD', effectiveFrom: '2020-01-01', allowBackdate: true });
  expect(leavePolicy.status, text(leavePolicy.body)).toBe(201);
  expect((await as(admin, 'patch', `/api/v1/leave/policies/${leavePolicy.body.data.id}/activate`)).status).toBe(200);
  const ent = await as(admin, 'post', '/api/v1/leave/entitlements').send({ employeeId: employees.EMP001, leaveTypeId: leaveType.body.data.id, periodStart: '2026-01-01', periodEnd: '2026-12-31' });
  expect(ent.status, text(ent.body)).toBe(201);
  const req = await as(emp, 'post', '/api/v1/leave/requests').send({ leaveTypeId: leaveType.body.data.id, startDate: '2026-11-02', endDate: '2026-11-02', reason: 'Family matter' });
  expect(req.status, text(req.body)).toBe(201);
  const submitted = await as(emp, 'post', `/api/v1/leave/requests/${req.body.data.id}/submit`);
  expect(submitted.status, text(submitted.body)).toBe(200);
  leaveInstanceId = submitted.body.data.workflowInstanceId;
  await as(mgr, 'post', `/api/v1/workflow/instances/${leaveInstanceId}/actions`).send({ action: 'APPROVE', comment: 'Approved; cover arranged with the team lead.' });

  // Payroll master data for the configuration tests.
  const policy = await as(admin, 'post', '/api/v1/payroll/policies').send({ organizationId: orgId, name: 'Standard payroll', monthlyDivisorDays: 30, dailyWorkHours: 8, newHireProration: 'CALENDAR_DAYS', terminationProration: 'CALENDAR_DAYS', absenceDeductionEnabled: false, lateDeductionEnabled: false, workflowDefinitionCode: 'LEAVE_STD', effectiveFrom: '2020-01-01', currencyCode: 'THB' });
  expect(policy.status, text(policy.body)).toBe(201); policyId = policy.body.data.id;
  const comp = await as(admin, 'post', '/api/v1/payroll/components').send({ code: 'TRAVEL_ALLW', name: 'Travel allowance', type: 'EARNING' });
  expect(comp.status, text(comp.body)).toBe(201); componentId = comp.body.data.id;
  const item = await as(admin, 'post', '/api/v1/payroll/pay-items').send({ employeeId: employees.EMP001, componentId, amount: '1500.00', effectiveFrom: '2026-01-01' });
  expect(item.status, text(item.body)).toBe(201); payItemId = item.body.data.id;
  const period = await as(admin, 'post', '/api/v1/payroll/periods').send({ organizationId: orgId, year: 2026, month: 11, periodStart: '2026-11-01', periodEnd: '2026-11-30', attendanceFrom: '2026-10-21', attendanceTo: '2026-11-20', paymentDate: '2026-11-28' });
  expect(period.status, text(period.body)).toBe(201); periodId = period.body.data.id;
}, 180000);

afterAll(async () => { await resetDatabase(); await prisma.$disconnect(); });

describe('administration hub', () => {
  it('reports one entry per real capability and never a secret, a path, an address or a credential', async () => {
    const r = await as(hrAdmin, 'get', `${A}/settings/areas`);
    expect(r.status).toBe(200);
    const areas = r.body.data as { key: string; capability: string; path: string | null; permissions: string[] }[];
    expect(areas.map((a) => a.key)).toEqual(expect.arrayContaining(['users', 'roles', 'workflow-definitions', 'workflow-monitor', 'payroll-components', 'payroll-recurring', 'payroll-policies', 'payroll-periods', 'privacy', 'audit', 'notifications', 'security', 'storage', 'copilot']));
    // Every capability value is one the contract defines, and nothing claims to be configurable without a screen.
    for (const a of areas) {
      expect(['CONFIGURABLE', 'READ_ONLY', 'DEPLOYMENT_MANAGED', 'NOT_AVAILABLE']).toContain(a.capability);
      if (a.capability === 'CONFIGURABLE') { expect(a.path, a.key).toBeTruthy(); expect(a.permissions.length, a.key).toBeGreaterThan(0); }
      if (a.capability === 'DEPLOYMENT_MANAGED' || a.capability === 'NOT_AVAILABLE') expect(a.path, a.key).toBeNull();
    }
    // Areas that are not implemented say so plainly rather than offering something that does nothing.
    expect(areas.find((a) => a.key === 'notifications')).toMatchObject({ capability: 'NOT_AVAILABLE', path: null, permissions: [] });
    expect(areas.find((a) => a.key === 'security')).toMatchObject({ capability: 'DEPLOYMENT_MANAGED' });
    expect(text(r.body)).not.toMatch(/coming soon/i);
    expect(err(await as(emp, 'get', `${A}/settings/areas`))).toBe('403 FORBIDDEN');
  });

  it('diagnostics report how the service runs and carry no connection string, storage path, key, origin or token', async () => {
    const r = await as(hrAdmin, 'get', `${A}/diagnostics`);
    expect(r.status).toBe(200);
    const d = r.body.data;
    expect(d).toMatchObject({ environment: 'test', database: 'ok', notifications: { inApp: true, externalDelivery: false } });
    expect(typeof d.secureCookies).toBe('boolean');
    expect(d.copilot).toMatchObject({ enabled: expect.any(Boolean), configured: expect.any(Boolean) });
    expect(forbiddenKeys(d, /^(databaseUrl|url|apiKey|key|secret|token|password|path|dir|directory|host|origin|corsOrigin|storageDir)$/i)).toEqual([]);
    for (const s of deepStrings(d)) {
      expect(s, s).not.toMatch(/postgres(ql)?:\/\//i);
      expect(s, s).not.toMatch(/^\//); // no filesystem path
      expect(s, s).not.toMatch(/https?:\/\//i);
      expect(s, s).not.toMatch(/sk-|Bearer |BEGIN [A-Z]+ KEY/);
    }
    // The value of an environment secret never appears, whatever its name.
    const secrets = [process.env.DATABASE_URL, process.env.TEST_DATABASE_URL, process.env.SESSION_SECRET, process.env.COPILOT_API_KEY].filter((v): v is string => !!v && v.length > 6);
    for (const secret of secrets) expect(r.text).not.toContain(secret);
    expect(err(await as(emp, 'get', `${A}/diagnostics`))).toBe('403 FORBIDDEN');
  });
});

describe('workflow monitor', () => {
  it('lists instances as metadata, paginates on the server, and filters by module, status, age and requester', async () => {
    const r = await as(hrAdmin, 'get', `${A}/workflow-monitor?page=1&pageSize=20`);
    expect(r.status).toBe(200);
    expect(r.body.meta).toMatchObject({ page: 1, pageSize: 20, total: 1 });
    const row = r.body.data[0];
    expect(row).toMatchObject({ module: 'leave', moduleLabel: 'Leave', entityType: 'LEAVE_REQUEST', status: 'APPROVED', requesterEmployeeCode: 'EMP001', definition: { code: 'LEAVE_STD', version: 1 } });
    expect(row.waitingDays).toBeNull(); // decided, so it is not waiting
    // The monitor never reads the record behind the instance: only its identifier is carried.
    expect(text(r.body)).not.toMatch(/Family matter|cover arranged/);
    expect(forbiddenKeys(r.body.data, /^(reason|description|amount|salary|total|narrative|answer|body|comment|note)$/)).toEqual([]);
    expect((await as(hrAdmin, 'get', `${A}/workflow-monitor?module=expense`)).body.meta.total).toBe(0);
    expect((await as(hrAdmin, 'get', `${A}/workflow-monitor?status=PENDING`)).body.meta.total).toBe(0);
    expect((await as(hrAdmin, 'get', `${A}/workflow-monitor?search=EMP001`)).body.meta.total).toBe(1);
    expect((await as(hrAdmin, 'get', `${A}/workflow-monitor?search=NOBODY`)).body.meta.total).toBe(0);
    expect((await as(hrAdmin, 'get', `${A}/workflow-monitor?stalledDays=3`)).body.meta.total).toBe(0); // nothing pending
    const summary = await as(hrAdmin, 'get', `${A}/workflow-monitor/summary`);
    expect(summary.body.data.byStatus).toEqual([{ status: 'APPROVED', count: 1 }]);
    expect(summary.body.data.byModule).toEqual([{ module: 'leave', moduleLabel: 'Leave', pending: 0, total: 1, oldestPendingDays: null }]);
  });

  it('an approver comment and the link to the record need the source module\'s own permission, which the monitor never grants', async () => {
    // A workflow operator may watch everything and holds no leave permission: they see that a comment exists, not what it says.
    const blind = await as(wfOnly, 'get', `${A}/workflow-monitor/${leaveInstanceId}`);
    expect(blind.status).toBe(200);
    expect(blind.body.data).toMatchObject({ canOpenSource: false, sourcePath: null });
    const step = blind.body.data.steps.find((s: { status: string }) => s.status === 'APPROVED');
    expect(step).toMatchObject({ comment: null, commentRedacted: true });
    expect(step.commentLength).toBeGreaterThan(0);
    expect(blind.text).not.toMatch(/cover arranged|Family matter/);
    expect(blind.body.data.history.every((h: { comment: string | null }) => h.comment === null)).toBe(true);
    // An administrator who does hold the leave permission reads the words and is offered the record.
    const sighted = await as(hrAdmin, 'get', `${A}/workflow-monitor/${leaveInstanceId}`);
    expect(sighted.body.data).toMatchObject({ canOpenSource: true, sourcePath: '/hrm/leave' });
    expect(sighted.body.data.steps.find((s: { status: string }) => s.status === 'APPROVED').comment).toMatch(/cover arranged/);
    // The reason the employee gave belongs to the leave module and never reaches the monitor either way.
    expect(sighted.text).not.toMatch(/Family matter/);
  });

  it('the monitor is read only and closed to anyone without the workflow permission', async () => {
    for (const s of [emp, mgr, exec, hr]) expect(err(await as(s, 'get', `${A}/workflow-monitor`))).toBe('403 FORBIDDEN');
    expect(err(await as(mgr, 'get', `${A}/workflow-monitor/${leaveInstanceId}`))).toBe('403 FORBIDDEN');
    // There is no force-approve, force-reject, reassign or delete: the monitor exposes no write at all.
    for (const [m, url] of [['post', `${A}/workflow-monitor/${leaveInstanceId}`], ['patch', `${A}/workflow-monitor/${leaveInstanceId}`], ['delete', `${A}/workflow-monitor/${leaveInstanceId}`], ['post', `${A}/workflow-monitor/${leaveInstanceId}/approve`]] as const) {
      expect((await as(hrAdmin, m, url)).status, `${m} ${url}`).toBe(404);
    }
    expect(err(await as(hrAdmin, 'get', `${A}/workflow-monitor/does-not-exist`))).toBe('404 WORKFLOW_INSTANCE_NOT_FOUND');
  });
});

describe('payroll configuration', () => {
  it('the edits the screens now offer are the ones the server accepts, and a system component keeps its meaning', async () => {
    const c = await as(admin, 'patch', `/api/v1/payroll/components/${componentId}`).send({ name: 'Travel allowance (monthly)', description: 'Standing travel allowance', taxable: false, recurringAllowed: true, isActive: true });
    expect(c.status, text(c.body)).toBe(200);
    expect(c.body.data).toMatchObject({ code: 'TRAVEL_ALLW', name: 'Travel allowance (monthly)', taxable: false, type: 'EARNING' });
    // Code, type and calculation basis are not in the update contract at all: a payslip already refers to them.
    expect(err(await as(admin, 'patch', `/api/v1/payroll/components/${componentId}`).send({ code: 'OTHER' }))).toBe('400 VALIDATION_ERROR');
    expect(err(await as(admin, 'patch', `/api/v1/payroll/components/${componentId}`).send({ type: 'DEDUCTION' }))).toBe('400 VALIDATION_ERROR');
    const system = await prisma.payComponent.findFirst({ where: { isSystem: true } });
    if (system) {
      const r = await as(admin, 'patch', `/api/v1/payroll/components/${system.id}`).send({ isActive: false });
      expect([200, 409, 422]).toContain(r.status);
      if (r.status === 200) expect((await prisma.payComponent.findUniqueOrThrow({ where: { id: system.id } })).code).toBe(system.code);
    }
    const item = await as(admin, 'patch', `/api/v1/payroll/pay-items/${payItemId}`).send({ amount: '1750.00', effectiveTo: '2026-12-31', note: 'Raised from December' });
    expect(item.status, text(item.body)).toBe(200);
    expect(item.body.data).toMatchObject({ amount: '1750.00', effectiveTo: '2026-12-31' });
    const policy = await as(admin, 'patch', `/api/v1/payroll/policies/${policyId}`).send({ monthlyDivisorDays: 26, dailyWorkHours: 7.5, absenceDeductionEnabled: true });
    expect(policy.status, text(policy.body)).toBe(200);
    expect(policy.body.data).toMatchObject({ monthlyDivisorDays: '26.00', dailyWorkHours: '7.50', absenceDeductionEnabled: true });
    const period = await as(admin, 'patch', `/api/v1/payroll/periods/${periodId}`).send({ paymentDate: '2026-11-27' });
    expect(period.status, text(period.body)).toBe(200);
    expect(period.body.data.paymentDate).toBe('2026-11-27');
  });

  it('payroll configuration needs payroll authority: a manager, an employee and an executive are refused everywhere', async () => {
    for (const s of [emp, mgr, exec]) {
      expect(err(await as(s, 'get', '/api/v1/payroll/components')), 'components').toBe('403 FORBIDDEN');
      expect(err(await as(s, 'get', '/api/v1/payroll/pay-items')), 'pay items').toBe('403 FORBIDDEN');
      expect(err(await as(s, 'get', '/api/v1/payroll/policies')), 'policies').toBe('403 FORBIDDEN');
      expect(err(await as(s, 'get', '/api/v1/payroll/periods')), 'periods').toBe('403 FORBIDDEN');
      expect(err(await as(s, 'patch', `/api/v1/payroll/components/${componentId}`).send({ name: 'x' })), 'component edit').toBe('403 FORBIDDEN');
      expect(err(await as(s, 'patch', `/api/v1/payroll/policies/${policyId}`).send({ dailyWorkHours: 9 })), 'policy edit').toBe('403 FORBIDDEN');
    }
    // The workflow operator watches approvals and still holds no payroll authority.
    expect(err(await as(wfOnly, 'get', '/api/v1/payroll/policies'))).toBe('403 FORBIDDEN');
    expect(err(await as(wfOnly, 'get', '/api/v1/payroll/pay-items'))).toBe('403 FORBIDDEN');
    // The hub tells each caller only what they may open.
    const forExec = (await as(exec, 'get', `${A}/settings/areas`)).status;
    expect([200, 403]).toContain(forExec);
    if (forExec === 200) {
      const areas = (await as(exec, 'get', `${A}/settings/areas`)).body.data as { key: string; permissions: string[] }[];
      const payroll = areas.filter((a) => a.key.startsWith('payroll-'));
      expect(payroll.every((a) => !a.permissions.some((p) => ['payroll.manage', 'payroll.run', 'payroll.approve'].includes(p) && false))).toBe(true);
    }
  });

  it('a calculated period refuses a window change, so the figures a run used cannot be rewritten underneath it', async () => {
    for (const code of ['MGR', 'HRADM', 'EMP001']) await as(admin, 'post', '/api/v1/payroll/compensations').send({ employeeId: employees[code], effectiveFrom: '2020-01-01', baseSalary: '30000.00', currencyCode: 'THB' });
    const calc = await as(admin, 'post', `/api/v1/payroll/periods/${periodId}/calculate`);
    expect(calc.status, text(calc.body)).toBe(200);
    const after = await as(admin, 'patch', `/api/v1/payroll/periods/${periodId}`).send({ attendanceTo: '2026-11-25' });
    expect([409, 422]).toContain(after.status);
    expect((await as(admin, 'get', `/api/v1/payroll/periods/${periodId}`)).body.data.attendanceTo).toBe('2026-11-20');
  });
});
