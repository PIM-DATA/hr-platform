import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app';
import { prisma } from '../src/lib/prisma';
import { AppError } from '../src/lib/errors';
import { auditService } from '../src/services/audit/audit.service';
import { workflowEngine } from '../src/services/workflow';
import type { Actor } from '../src/services/workflow/workflow.types';
import { createTestServer, createUser, loginAs, resetDatabase } from './helpers';

const app = createTestServer();
const PW = 'Correct-Horse-1';
type Session = { cookie: string; csrf: string; user: { id: string; employee: { id: string } | null } };
const as = (s: Session, m: 'get' | 'post', url: string) => request(app)[m](url).set('Cookie', s.cookie).set('x-csrf-token', s.csrf);

// dataset: dept DATA (head = HEAD) ; CEO → HEAD → MGR → EMP ; LONER has no manager ; HR user (SPECIFIC_USER)
let deptData: string, deptSales: string;
let CEO: string, HEAD: string, MGR: string, EMP: string, LONER: string, NOACC: string;
let admin: Session, ceoS: Session, headS: Session, mgrS: Session, empS: Session, lonerS: Session, hrS: Session, viewerS: Session;
let entityCounter = 0;
const newEntityId = () => `req-${++entityCounter}`;

async function mkEmployee(code: string, departmentId: string, managerId: string | null, status = 'ACTIVE') {
  const pos = await prisma.position.create({ data: { departmentId, code: `P-${code}`, title: code } });
  const org = (await prisma.department.findUniqueOrThrow({ where: { id: departmentId } })).organizationId;
  return (await prisma.employee.create({ data: { employeeCode: code, firstName: code, lastName: 'Wf', email: `${code.toLowerCase()}@wf.local`, hireDate: new Date('2020-01-01'), organizationId: org, departmentId, positionId: pos.id, managerId, employmentStatus: status, positionHistory: { create: { positionId: pos.id, departmentId, startDate: new Date('2020-01-01') } }, managerHistory: managerId ? { create: { managerId, startDate: new Date('2020-01-01') } } : undefined } })).id;
}
const actorOf = (s: Session): Actor => ({ auth: { userId: s.user.id, email: '', employeeId: s.user.employee?.id ?? null, roles: [], permissions: [], permissionScopes: {}, dataScope: 'SELF', sessionId: 's', csrfToken: 'c' }, ipAddress: null, userAgent: null });
/** Submits inside a transaction, like a business module would. */
const submit = (code: string, requesterEmployeeId: string, s: Session, entityId = newEntityId()) =>
  prisma.$transaction((tx) => workflowEngine.submit({ definitionCode: code, module: 'test', entityType: 'TestRequest', entityId, requesterEmployeeId }, actorOf(s), tx));
const act = (s: Session, instanceId: string, action: 'APPROVE' | 'REJECT', comment?: string) => as(s, 'post', `/api/v1/workflow/instances/${instanceId}/actions`).send({ action, comment });
const steps = (t: string, extra: object = {}) => ({ name: t, approverType: t, ...extra });

async function createDefinition(s: Session, code: string, stepList: object[], activate = true, extra: object = {}) {
  const res = await as(s, 'post', '/api/v1/workflow/definitions').send({ code, name: `${code} workflow`, module: 'test', entityType: 'TestRequest', steps: stepList, ...extra });
  if (res.status !== 201) throw new Error(`createDefinition ${code}: ${res.status} ${JSON.stringify(res.body)}`);
  if (activate) { const a = await as(s, 'post', `/api/v1/workflow/definitions/${res.body.data.id}/activate`); if (a.status !== 200) throw new Error(`activate ${code}: ${a.status} ${JSON.stringify(a.body)}`); }
  return res.body.data as { id: string; code: string; version: number; isActive: boolean };
}

beforeAll(async () => {
  await resetDatabase();
  const org = await prisma.organization.create({ data: { code: 'WF', name: 'Workflow Co' } });
  deptData = (await prisma.department.create({ data: { organizationId: org.id, code: 'DATA', name: 'Data' } })).id;
  deptSales = (await prisma.department.create({ data: { organizationId: org.id, code: 'SALES', name: 'Sales' } })).id;
  CEO = await mkEmployee('CEO', deptSales, null);
  HEAD = await mkEmployee('HEAD', deptData, CEO);
  MGR = await mkEmployee('MGR', deptData, HEAD);
  EMP = await mkEmployee('EMP', deptData, MGR);
  LONER = await mkEmployee('LONER', deptSales, null);
  NOACC = await mkEmployee('NOACC', deptData, MGR); // manager MGR; NOACC itself has no account
  await prisma.department.update({ where: { id: deptData }, data: { headEmployeeId: HEAD } });
  await createUser({ email: 'admin@wf.local', password: PW, role: 'SYSTEM_ADMIN' });
  await createUser({ email: 'ceo@wf.local', password: PW, role: 'EXECUTIVE', employeeId: CEO });
  await createUser({ email: 'head@wf.local', password: PW, role: 'MANAGER', employeeId: HEAD });
  await createUser({ email: 'mgr@wf.local', password: PW, role: 'MANAGER', employeeId: MGR });
  await createUser({ email: 'emp@wf.local', password: PW, role: 'EMPLOYEE', employeeId: EMP });
  await createUser({ email: 'loner@wf.local', password: PW, role: 'EMPLOYEE', employeeId: LONER });
  await createUser({ email: 'hr@wf.local', password: PW, role: 'HR' }); // no employee; SPECIFIC_USER approver
  await createUser({ email: 'viewer@wf.local', password: PW, role: 'HR_ADMIN' }); // workflow.view_all + manage_definitions
  [admin, ceoS, headS, mgrS, empS, lonerS, hrS, viewerS] = await Promise.all(['admin', 'ceo', 'head', 'mgr', 'emp', 'loner', 'hr', 'viewer'].map((u) => loginAs(app, `${u}@wf.local`, PW)));
});
afterAll(async () => {
  workflowEngine._clearHandlers();
  await resetDatabase();
  await prisma.$disconnect();
});
beforeEach(() => workflowEngine._clearHandlers());

// ------------------------------------------------------------------ definitions
describe('definitions / versions', () => {
  it('create v1 (inactive) → activate; duplicate version impossible (server assigns versions)', async () => {
    const d = await createDefinition(admin, 'STD', [steps('DIRECT_MANAGER'), steps('SPECIFIC_USER', { approverUserId: hrS.user.id })], false);
    expect(d).toMatchObject({ code: 'STD', version: 1, isActive: false });
    const a = await as(admin, 'post', `/api/v1/workflow/definitions/${d.id}/activate`);
    expect(a.status).toBe(200);
    expect(a.body.data.isActive).toBe(true);
    expect(await prisma.workflowDefinition.count({ where: { code: 'STD', version: 1 } })).toBe(1);
    await expect(prisma.workflowDefinition.create({ data: { code: 'STD', version: 1, name: 'dup', module: 'test', entityType: 'TestRequest' } })).rejects.toThrow(); // DB unique (code, version)
  });
  it('new version created correctly; only one active version per code; old version immutable & still referenced by instances', async () => {
    const inst = await submit('STD', EMP, empS);
    expect(inst.definition.version).toBe(1);
    const v2 = await createDefinition(admin, 'STD', [steps('DIRECT_MANAGER')]);
    expect(v2.version).toBe(2);
    const all = await as(admin, 'get', '/api/v1/workflow/definitions?code=STD');
    expect(all.body.data.map((d: { version: number; isActive: boolean }) => [d.version, d.isActive])).toEqual([[2, true], [1, false]]);
    // v1 steps unchanged, instance still points at v1 and keeps its 2-step snapshot
    const v1 = await prisma.workflowDefinition.findUniqueOrThrow({ where: { code_version: { code: 'STD', version: 1 } }, include: { steps: true } });
    expect(v1.steps).toHaveLength(2);
    const stored = await prisma.workflowInstance.findUniqueOrThrow({ where: { id: inst.id }, include: { steps: true } });
    expect(stored.definitionId).toBe(v1.id);
    expect(stored.steps).toHaveLength(2);
    // there is no endpoint that mutates an existing version (immutable by construction)
    expect((await request(app).patch(`/api/v1/workflow/definitions/${v1.id}`).set('Cookie', admin.cookie).set('x-csrf-token', admin.csrf).send({ name: 'x' })).status).toBe(404);
    await as(admin, 'post', `/api/v1/workflow/definitions/${v1.id}/activate`); // back to v1 for the rest of the file
    expect((await as(admin, 'get', `/api/v1/workflow/definitions/${v2.id}`)).body.data.isActive).toBe(false);
  });
  it('invalid definitions rejected: no steps, SPECIFIC_USER without user / unknown user, DIRECT_MANAGER with user, ROLE unsupported, bad onSelf', async () => {
    const post = (body: object) => as(admin, 'post', '/api/v1/workflow/definitions').send({ code: 'BAD', name: 'bad', module: 'test', entityType: 'TestRequest', ...body });
    expect((await post({ steps: [] })).status).toBe(400);
    expect((await post({ steps: [steps('SPECIFIC_USER')] })).status).toBe(400);
    const unknown = await post({ steps: [steps('SPECIFIC_USER', { approverUserId: 'nope' })] });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error.code).toBe('INVALID_WORKFLOW_DEFINITION');
    expect((await post({ steps: [steps('DIRECT_MANAGER', { approverUserId: hrS.user.id })] })).status).toBe(400);
    const role = await post({ steps: [steps('ROLE')] });
    expect(role.status).toBe(400);
    expect(JSON.stringify(role.body)).toMatch(/not supported/);
    expect((await post({ steps: [steps('DIRECT_MANAGER', { onSelf: 'IGNORE' })] })).status).toBe(400);
    expect(await prisma.workflowDefinition.count({ where: { code: 'BAD' } })).toBe(0);
  });
  it('non-contiguous / duplicate step orders are rejected at activation (rows inserted directly)', async () => {
    const def = await prisma.workflowDefinition.create({ data: { code: 'GAP', version: 1, name: 'gap', module: 'test', entityType: 'TestRequest', steps: { create: [{ stepOrder: 1, name: 'a', approverType: 'DIRECT_MANAGER' }, { stepOrder: 3, name: 'b', approverType: 'DIRECT_MANAGER' }] } } });
    const res = await as(admin, 'post', `/api/v1/workflow/definitions/${def.id}/activate`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_WORKFLOW_DEFINITION');
    expect(res.body.error.details[0].message).toMatch(/contiguous/);
    await expect(prisma.workflowDefinitionStep.create({ data: { definitionId: def.id, stepOrder: 1, name: 'dup', approverType: 'DIRECT_MANAGER' } })).rejects.toThrow(); // unique (definitionId, stepOrder)
  });
  it('definitions API requires workflow.manage_definitions; code must keep its module/entity', async () => {
    expect((await as(mgrS, 'get', '/api/v1/workflow/definitions')).status).toBe(403);
    expect((await as(mgrS, 'post', '/api/v1/workflow/definitions').send({})).status).toBe(403);
    const res = await as(admin, 'post', '/api/v1/workflow/definitions').send({ code: 'STD', name: 'x', module: 'other', entityType: 'Other', steps: [steps('DIRECT_MANAGER')] });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('WORKFLOW_CODE_MODULE_MISMATCH');
  });
});

// ------------------------------------------------------------------ submit / resolution / snapshot
describe('submit: approver resolution + snapshot', () => {
  it('DIRECT_MANAGER, DEPARTMENT_HEAD and SPECIFIC_USER resolved and snapshotted (employee + user ids, source type)', async () => {
    await createDefinition(admin, 'THREE', [steps('DIRECT_MANAGER'), steps('DEPARTMENT_HEAD'), steps('SPECIFIC_USER', { approverUserId: hrS.user.id })]);
    const inst = await submit('THREE', EMP, empS);
    expect(inst.status).toBe('PENDING');
    expect(inst.currentStepOrder).toBe(1);
    expect(inst.steps.map((s) => [s.stepOrder, s.approverType, s.approverEmployee?.employeeCode ?? null, s.approverUser?.email, s.status])).toEqual([
      [1, 'DIRECT_MANAGER', 'MGR', 'mgr@wf.local', 'PENDING'],
      [2, 'DEPARTMENT_HEAD', 'HEAD', 'head@wf.local', 'WAITING'],
      [3, 'SPECIFIC_USER', null, 'hr@wf.local', 'WAITING'],
    ]);
    expect(inst.actions.map((a) => a.action)).toEqual(['SUBMIT']);
  });
  it('changing the manager / department head AFTER submit does not change the snapshot approver', async () => {
    const inst = await submit('THREE', EMP, empS);
    await prisma.employee.update({ where: { id: EMP }, data: { managerId: CEO } });
    await prisma.department.update({ where: { id: deptData }, data: { headEmployeeId: CEO } });
    const after = await prisma.workflowInstance.findUniqueOrThrow({ where: { id: inst.id }, include: { steps: { orderBy: { stepOrder: 'asc' } } } });
    expect(after.steps[0].approverEmployeeId).toBe(MGR);
    expect(after.steps[1].approverEmployeeId).toBe(HEAD);
    // the old approver can still act, the new manager cannot
    expect((await act(ceoS, inst.id, 'APPROVE')).status).toBe(403);
    expect((await act(mgrS, inst.id, 'APPROVE')).status).toBe(200);
    await prisma.employee.update({ where: { id: EMP }, data: { managerId: MGR } });
    await prisma.department.update({ where: { id: deptData }, data: { headEmployeeId: HEAD } });
  });
  it('unresolved (default FAIL): missing manager, inactive approver user, approver without account → 409 APPROVER_UNRESOLVED with step info only', async () => {
    await createDefinition(admin, 'MGR_ONLY', [steps('DIRECT_MANAGER')]);
    const noMgr = await submit('MGR_ONLY', LONER, lonerS).catch((e) => e);
    expect(noMgr).toBeInstanceOf(AppError);
    expect(noMgr.code).toBe('APPROVER_UNRESOLVED');
    expect(noMgr.details[0].message).toBe('DIRECT_MANAGER: NO_MANAGER');
    expect(JSON.stringify(noMgr)).not.toMatch(/passwordHash|token/);

    await prisma.user.update({ where: { email: 'mgr@wf.local' }, data: { isActive: false } });
    const inactive = await submit('MGR_ONLY', EMP, empS).catch((e) => e);
    expect(inactive.code).toBe('APPROVER_UNRESOLVED');
    expect(inactive.details[0].message).toBe('DIRECT_MANAGER: USER_INACTIVE');
    await prisma.user.update({ where: { email: 'mgr@wf.local' }, data: { isActive: true } });

    const noAccount = await submit('MGR_ONLY', MGR, mgrS).catch((e) => e); // MGR's manager is HEAD (has account) → ok; use NOACC as manager instead
    expect(noAccount.status).toBe('PENDING');
    await prisma.employee.update({ where: { id: EMP }, data: { managerId: NOACC } });
    const noAcc = await submit('MGR_ONLY', EMP, empS).catch((e) => e);
    expect(noAcc.code).toBe('APPROVER_UNRESOLVED');
    expect(noAcc.details[0].message).toBe('DIRECT_MANAGER: NO_USER_ACCOUNT');
    await prisma.employee.update({ where: { id: EMP }, data: { managerId: MGR } });
    expect(await prisma.workflowInstance.count({ where: { requesterEmployeeId: LONER } })).toBe(0); // nothing persisted on failure
  });
  it('onUnresolved SKIP: step skipped with reason UNRESOLVED and the next step becomes PENDING', async () => {
    await createDefinition(admin, 'SKIP_UNRES', [steps('DIRECT_MANAGER', { onUnresolved: 'SKIP' }), steps('SPECIFIC_USER', { approverUserId: hrS.user.id })]);
    const inst = await submit('SKIP_UNRES', LONER, lonerS);
    expect(inst.steps.map((s) => [s.status, s.skipReason])).toEqual([['SKIPPED', 'UNRESOLVED'], ['PENDING', null]]);
    expect(inst.currentStepOrder).toBe(2);
  });
  it('self approval default FAIL → 409 SELF_APPROVAL_NOT_ALLOWED (department head requesting on a DEPARTMENT_HEAD step)', async () => {
    await createDefinition(admin, 'HEAD_STEP', [steps('DEPARTMENT_HEAD')]);
    const err = await submit('HEAD_STEP', HEAD, headS).catch((e) => e);
    expect(err.code).toBe('SELF_APPROVAL_NOT_ALLOWED');
    expect(await prisma.workflowInstance.count({ where: { requesterEmployeeId: HEAD } })).toBe(0);
  });
  it('explicit onSelf SKIP skips with reason SELF; all-skipped instance is APPROVED immediately and the handler runs', async () => {
    await createDefinition(admin, 'HEAD_SKIP', [steps('DEPARTMENT_HEAD', { onSelf: 'SKIP' })]);
    const approved: string[] = [];
    workflowEngine.registerHandler('test', { onApproved: async (ctx) => { approved.push(ctx.entityId); } });
    const inst = await submit('HEAD_SKIP', HEAD, headS, 'auto-1');
    expect(inst.status).toBe('APPROVED');
    expect(inst.currentStepOrder).toBeNull();
    expect(inst.completedAt).not.toBeNull();
    expect(inst.steps[0]).toMatchObject({ status: 'SKIPPED', skipReason: 'SELF' });
    expect(approved).toEqual(['auto-1']);
    const audit = await prisma.auditLog.findFirst({ where: { action: 'WORKFLOW_SUBMIT', recordId: inst.id } });
    expect(JSON.parse(audit!.newValue!).autoApproved).toBe(true);
  });
  it('same entity cannot have two pending workflows; inactive definition / wrong module rejected', async () => {
    const inst = await submit('THREE', EMP, empS, 'dup-1');
    const dup = await submit('THREE', EMP, empS, 'dup-1').catch((e) => e);
    expect(dup.code).toBe('WORKFLOW_ALREADY_PENDING');
    const v = await createDefinition(admin, 'OFF', [steps('DIRECT_MANAGER')], false);
    expect((await submit('OFF', EMP, empS).catch((e) => e)).code).toBe('WORKFLOW_DEFINITION_NOT_ACTIVE');
    expect(v.isActive).toBe(false);
    const wrong = await prisma.$transaction((tx) => workflowEngine.submit({ definitionCode: 'THREE', module: 'leave', entityType: 'LeaveRequest', entityId: 'x', requesterEmployeeId: EMP }, actorOf(empS), tx)).catch((e) => e);
    expect(wrong.code).toBe('WORKFLOW_DEFINITION_MISMATCH');
    expect(inst.status).toBe('PENDING');
  });
});

describe('SPECIFIC_USER resolution policy (Task 8.1)', () => {
  it('1. active user + active linked employee → resolved with employee snapshot; 2. active user without employee → resolved, approverEmployeeId null', async () => {
    await createDefinition(admin, 'SU_LINKED', [steps('SPECIFIC_USER', { approverUserId: mgrS.user.id })]);
    const a = await submit('SU_LINKED', EMP, empS);
    expect(a.steps[0]).toMatchObject({ status: 'PENDING', approverUser: { email: 'mgr@wf.local' }, approverEmployee: { employeeCode: 'MGR' } });
    await createDefinition(admin, 'SU_SYSTEM', [steps('SPECIFIC_USER', { approverUserId: hrS.user.id })]);
    const b = await submit('SU_SYSTEM', EMP, empS);
    expect(b.steps[0].approverUser?.email).toBe('hr@wf.local');
    expect(b.steps[0].approverEmployee).toBeNull();
    expect((await prisma.workflowInstanceStep.findFirstOrThrow({ where: { instanceId: b.id } })).approverEmployeeId).toBeNull(); // 5. stored null
    expect((await act(hrS, b.id, 'APPROVE')).status).toBe(200); // a system user can still act
  });
  it('3. inactive user → unresolved USER_INACTIVE; 4. linked inactive employee → unresolved EMPLOYEE_INACTIVE', async () => {
    await prisma.user.update({ where: { email: 'hr@wf.local' }, data: { isActive: false } });
    const inactive = await submit('SU_SYSTEM', EMP, empS).catch((e) => e);
    expect(inactive.code).toBe('APPROVER_UNRESOLVED');
    expect(inactive.details[0].message).toBe('SPECIFIC_USER: USER_INACTIVE');
    await prisma.user.update({ where: { email: 'hr@wf.local' }, data: { isActive: true } });

    await prisma.employee.update({ where: { id: MGR }, data: { employmentStatus: 'INACTIVE' } });
    const empInactive = await submit('SU_LINKED', EMP, empS).catch((e) => e);
    expect(empInactive.code).toBe('APPROVER_UNRESOLVED');
    expect(empInactive.details[0].message).toBe('SPECIFIC_USER: EMPLOYEE_INACTIVE');
    await prisma.employee.update({ where: { id: MGR }, data: { employmentStatus: 'ACTIVE' } });
  });
});

describe('approver options endpoint (Task 8.1)', () => {
  it('workflow admin without users.view can search; normal user → 403; only active users; no sensitive fields', async () => {
    await createUser({ email: 'inactive-approver@wf.local', password: PW, role: 'HR', isActive: false });
    // viewerS = HR_ADMIN (has users.view) — build a manage_definitions-only user to prove no users.view coupling
    const perm = await prisma.permission.findUniqueOrThrow({ where: { code: 'workflow.manage_definitions' } });
    await prisma.role.create({ data: { code: 'WF_ADMIN_ONLY', name: 'wf admin only', dataScope: 'SELF', rolePermissions: { create: [{ permissionId: perm.id }] } } });
    await createUser({ email: 'wfadmin@wf.local', password: PW, role: 'WF_ADMIN_ONLY' });
    const wfAdmin = await loginAs(app, 'wfadmin@wf.local', PW);
    expect((await as(wfAdmin, 'get', '/api/v1/users')).status).toBe(403); // really has no users.view
    const res = await as(wfAdmin, 'get', '/api/v1/workflow/approver-options?search=wf.local&limit=50');
    expect(res.status).toBe(200);
    const emails = res.body.data.map((u: { email: string }) => u.email);
    expect(emails).toContain('mgr@wf.local');
    expect(emails).not.toContain('inactive-approver@wf.local');
    const mgrRow = res.body.data.find((u: { email: string }) => u.email === 'mgr@wf.local');
    expect(Object.keys(mgrRow).sort()).toEqual(['email', 'employee', 'id']);
    expect(mgrRow.employee).toMatchObject({ employeeCode: 'MGR', employmentStatus: 'ACTIVE' });
    expect(JSON.stringify(res.body)).not.toMatch(/password|roles|permissions|session|lastLogin|isActive/i);
    expect((await as(empS, 'get', '/api/v1/workflow/approver-options')).status).toBe(403);
    expect((await as(mgrS, 'get', '/api/v1/workflow/approver-options')).status).toBe(403);
    expect((await as(wfAdmin, 'get', '/api/v1/workflow/approver-options?search=mgr')).body.data).toHaveLength(1);
  });
});

// ------------------------------------------------------------------ sequential flow
describe('sequential flow', () => {
  it('only the current PENDING step can act; WAITING approver and wrong users get 403; approve advances; final approve completes; handler runs', async () => {
    const done: string[] = [];
    workflowEngine.registerHandler('test', { onApproved: async (ctx) => { done.push(`approved:${ctx.entityId}`); }, onRejected: async (ctx) => { done.push(`rejected:${ctx.entityId}`); } });
    const inst = await submit('THREE', EMP, empS, 'flow-1');
    expect((await act(headS, inst.id, 'APPROVE')).body.error.code).toBe('NOT_STEP_APPROVER'); // step 2 approver, step 2 is WAITING
    expect((await act(hrS, inst.id, 'APPROVE')).status).toBe(403);
    expect((await act(empS, inst.id, 'APPROVE')).status).toBe(403); // requester lacks workflow.approve entirely
    const s1 = await act(mgrS, inst.id, 'APPROVE', 'ok by manager');
    expect(s1.status).toBe(200);
    expect(s1.body.data).toMatchObject({ status: 'PENDING', currentStepOrder: 2 });
    expect(s1.body.data.steps.map((s: { status: string }) => s.status)).toEqual(['APPROVED', 'PENDING', 'WAITING']);
    expect(s1.body.data.steps[0]).toMatchObject({ actedBy: { email: 'mgr@wf.local' }, comment: 'ok by manager' });
    expect((await act(mgrS, inst.id, 'APPROVE')).body.error.code).toBe('NOT_STEP_APPROVER'); // step 1 done; mgr not approver of step 2
    expect((await act(headS, inst.id, 'APPROVE')).status).toBe(200);
    expect(done).toEqual([]);
    const fin = await act(hrS, inst.id, 'APPROVE');
    expect(fin.body.data).toMatchObject({ status: 'APPROVED', currentStepOrder: null });
    expect(fin.body.data.completedAt).not.toBeNull();
    expect(done).toEqual(['approved:flow-1']);
    // completed instance cannot be acted again (consistent 409)
    const again = await act(hrS, inst.id, 'APPROVE');
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('WORKFLOW_NOT_PENDING');
    expect((await act(hrS, inst.id, 'REJECT')).body.error.code).toBe('WORKFLOW_NOT_PENDING');
    expect(await prisma.workflowAction.count({ where: { instanceId: inst.id } })).toBe(4); // SUBMIT + 3 APPROVE
  });
  it('reject at any active step → instance REJECTED, remaining steps CANCELLED, handler onRejected', async () => {
    const done: string[] = [];
    workflowEngine.registerHandler('test', { onRejected: async (ctx) => { done.push(`rejected:${ctx.entityId}:${ctx.comment}`); } });
    const inst = await submit('THREE', EMP, empS, 'flow-2');
    await act(mgrS, inst.id, 'APPROVE');
    const rej = await act(headS, inst.id, 'REJECT', 'no budget');
    expect(rej.status).toBe(200);
    expect(rej.body.data.status).toBe('REJECTED');
    expect(rej.body.data.steps.map((s: { status: string }) => s.status)).toEqual(['APPROVED', 'REJECTED', 'CANCELLED']);
    expect(done).toEqual(['rejected:flow-2:no budget']);
    expect((await act(hrS, inst.id, 'APPROVE')).status).toBe(409);
  });
  it('invalid action payload rejected (CANCEL is not an approver action)', async () => {
    const inst = await submit('THREE', EMP, empS, 'flow-3');
    const res = await as(mgrS, 'post', `/api/v1/workflow/instances/${inst.id}/actions`).send({ action: 'CANCEL' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect((await prisma.workflowInstance.findUniqueOrThrow({ where: { id: inst.id } })).status).toBe('PENDING');
    expect((await as(mgrS, 'post', `/api/v1/workflow/instances/${inst.id}/actions`).send({ action: 'SUBMIT' })).status).toBe(400);
  });
});

// ------------------------------------------------------------------ inbox / authorization
describe('inbox and instance authorization', () => {
  it('inbox shows only MY pending steps (snapshot approver), independent of data scope; another employee\'s request appears when I am the approver', async () => {
    const a = await submit('THREE', EMP, empS, 'inbox-1');
    const b = await submit('MGR_ONLY', NOACC, admin, 'inbox-2'); // NOACC's manager = MGR → appears in MGR's inbox
    const mgrInbox = await as(mgrS, 'get', '/api/v1/workflow/inbox');
    expect(mgrInbox.status).toBe(200);
    const mgrIds = mgrInbox.body.data.map((i: { entityId: string }) => i.entityId);
    expect(mgrIds).toEqual(expect.arrayContaining(['inbox-1', 'inbox-2']));
    expect(mgrInbox.body.data.every((i: { stepOrder: number; module: string }) => i.stepOrder === 1 && i.module === 'test')).toBe(true);
    expect(mgrInbox.body.data.find((i: { entityId: string }) => i.entityId === 'inbox-2')).toMatchObject({ entityType: 'TestRequest', stepName: 'DIRECT_MANAGER', requesterEmployee: { employeeCode: 'NOACC' } });
    expect((await as(headS, 'get', '/api/v1/workflow/inbox')).body.data.map((i: { entityId: string }) => i.entityId)).not.toContain('inbox-1'); // step 2 still WAITING
    expect((await as(hrS, 'get', '/api/v1/workflow/inbox')).body.data.map((i: { entityId: string }) => i.entityId)).not.toEqual(expect.arrayContaining(['inbox-1', 'inbox-2'])); // hr is step 3, still WAITING
    // CEO has data scope ALL (EXECUTIVE) but is nobody's approver here → empty inbox and cannot act
    expect((await as(ceoS, 'get', '/api/v1/workflow/inbox')).body.meta.total).toBe(0);
    expect((await act(ceoS, a.id, 'APPROVE')).status).toBe(403);
    // employee without workflow.approve
    expect((await as(empS, 'get', '/api/v1/workflow/inbox')).status).toBe(403);
    expect((await act(empS, b.id, 'APPROVE')).status).toBe(403);
    // after manager approves, step 2 appears in HEAD's inbox and leaves MGR's
    await act(mgrS, a.id, 'APPROVE');
    expect((await as(headS, 'get', '/api/v1/workflow/inbox')).body.data.map((i: { entityId: string }) => i.entityId)).toContain('inbox-1');
    expect((await as(mgrS, 'get', '/api/v1/workflow/inbox')).body.data.map((i: { entityId: string }) => i.entityId)).not.toContain('inbox-1');
  });
  it('instance read: requester, snapshot approvers and workflow.view_all can read; others get 404; list needs view_all', async () => {
    const inst = await submit('THREE', EMP, empS, 'read-1');
    expect((await as(empS, 'get', `/api/v1/workflow/instances/${inst.id}`)).status).toBe(200); // requester
    expect((await as(hrS, 'get', `/api/v1/workflow/instances/${inst.id}`)).status).toBe(200); // step-3 approver
    expect((await as(viewerS, 'get', `/api/v1/workflow/instances/${inst.id}`)).status).toBe(200); // view_all
    const stranger = await as(lonerS, 'get', `/api/v1/workflow/instances/${inst.id}`);
    expect(stranger.status).toBe(404);
    expect(stranger.body.error.code).toBe('WORKFLOW_INSTANCE_NOT_FOUND');
    expect((await as(ceoS, 'get', `/api/v1/workflow/instances/${inst.id}`)).status).toBe(404); // scope ALL ≠ workflow access
    expect((await as(mgrS, 'get', '/api/v1/workflow/instances')).status).toBe(403);
    const list = await as(viewerS, 'get', '/api/v1/workflow/instances?status=PENDING&module=test');
    expect(list.status).toBe(200);
    expect(list.body.data.every((i: { status: string }) => i.status === 'PENDING')).toBe(true);
    expect((await request(app).get('/api/v1/workflow/inbox')).status).toBe(401);
  });
});

// ------------------------------------------------------------------ cancel
describe('cancel (internal only)', () => {
  it('engine.cancel marks PENDING/WAITING steps CANCELLED, keeps decided steps, writes CANCEL action + audit; cannot cancel twice', async () => {
    const inst = await submit('THREE', EMP, empS, 'cancel-1');
    await act(mgrS, inst.id, 'APPROVE');
    const res = await prisma.$transaction((tx) => workflowEngine.cancel(inst.id, actorOf(empS), tx, 'changed my mind'));
    expect(res.status).toBe('CANCELLED');
    expect(res.steps.map((s) => s.status)).toEqual(['APPROVED', 'CANCELLED', 'CANCELLED']);
    expect(res.actions.map((a) => a.action)).toEqual(['SUBMIT', 'APPROVE', 'CANCEL']);
    expect(await prisma.auditLog.count({ where: { action: 'WORKFLOW_CANCEL', recordId: inst.id } })).toBe(1);
    const twice = await prisma.$transaction((tx) => workflowEngine.cancel(inst.id, actorOf(empS), tx)).catch((e) => e);
    expect(twice.code).toBe('WORKFLOW_NOT_PENDING');
    expect((await act(headS, inst.id, 'APPROVE')).status).toBe(409);
  });
  it('no HTTP route cancels an instance (business modules own cancellation)', async () => {
    const inst = await submit('THREE', EMP, empS, 'cancel-2');
    for (const [m, url] of [['post', `/api/v1/workflow/instances/${inst.id}/cancel`], ['delete', `/api/v1/workflow/instances/${inst.id}`]] as const) {
      const res = await request(app)[m](url).set('Cookie', admin.cookie).set('x-csrf-token', admin.csrf).send({});
      expect(res.status, url).toBe(404);
    }
    expect((await prisma.workflowInstance.findUniqueOrThrow({ where: { id: inst.id } })).status).toBe('PENDING');
  });
});

// ------------------------------------------------------------------ audit / transaction
describe('audit + transactions', () => {
  it('SUBMIT / APPROVE / REJECT / CANCEL are recorded in workflow_actions and audit_logs; both are append-only in code', async () => {
    const before = await prisma.auditLog.count({ where: { module: 'workflow' } });
    const a = await submit('THREE', EMP, empS, 'audit-1');
    await act(mgrS, a.id, 'APPROVE');
    await act(headS, a.id, 'REJECT', 'nope');
    const b = await submit('THREE', EMP, empS, 'audit-2');
    await prisma.$transaction((tx) => workflowEngine.cancel(b.id, actorOf(empS), tx));
    const audits = await prisma.auditLog.findMany({ where: { module: 'workflow', createdAt: { gte: new Date(Date.now() - 60_000) } }, orderBy: { createdAt: 'asc' } });
    expect(audits.length).toBe(before === 0 ? 5 : audits.length); // SUBMIT, APPROVE, REJECT, SUBMIT, CANCEL (+ earlier ones)
    expect(audits.slice(-5).map((x) => x.action)).toEqual(['WORKFLOW_SUBMIT', 'WORKFLOW_APPROVE', 'WORKFLOW_REJECT', 'WORKFLOW_SUBMIT', 'WORKFLOW_CANCEL']);
    expect(JSON.stringify(audits)).not.toMatch(/passwordHash|tokenHash|csrf/);
    // static: nothing updates/deletes workflow_actions outside test tooling
    const { readFileSync, readdirSync, statSync } = await import('node:fs');
    const path = await import('node:path');
    const files: string[] = [];
    const walk = (d: string) => { for (const f of readdirSync(d)) { const p = path.join(d, f); statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') && files.push(p); } };
    walk(path.join(__dirname, '../src'));
    const offenders = files.filter((f) => /workflowAction\.(update|delete|upsert|updateMany|deleteMany)/.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
  it('audit failure rolls back the whole transition (step, action, instance untouched)', async () => {
    const inst = await submit('THREE', EMP, empS, 'tx-1');
    const spy = vi.spyOn(auditService, 'log').mockRejectedValueOnce(new Error('audit store unavailable'));
    const res = await act(mgrS, inst.id, 'APPROVE');
    spy.mockRestore();
    expect(res.status).toBe(500);
    const after = await prisma.workflowInstance.findUniqueOrThrow({ where: { id: inst.id }, include: { steps: { orderBy: { stepOrder: 'asc' } }, actions: true } });
    expect(after.status).toBe('PENDING');
    expect(after.currentStepOrder).toBe(1);
    expect(after.steps.map((s) => s.status)).toEqual(['PENDING', 'WAITING', 'WAITING']);
    expect(after.actions.map((a) => a.action)).toEqual(['SUBMIT']);
    expect((await act(mgrS, inst.id, 'APPROVE')).status).toBe(200); // still actionable afterwards
  });
  it('a failing business handler rolls back the final approval', async () => {
    workflowEngine.registerHandler('test', { onApproved: async () => { throw new AppError(409, 'BUSINESS_RULE', 'balance exhausted'); } });
    await createDefinition(admin, 'ONE', [steps('DIRECT_MANAGER')]);
    const inst = await submit('ONE', EMP, empS, 'handler-1');
    const res = await act(mgrS, inst.id, 'APPROVE');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('BUSINESS_RULE');
    const after = await prisma.workflowInstance.findUniqueOrThrow({ where: { id: inst.id }, include: { steps: true } });
    expect(after.status).toBe('PENDING');
    expect(after.steps[0].status).toBe('PENDING');
  });
});
