import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma';
import { leavePoliciesService } from '../src/modules/leave/leave-policies.service';
import { createTestServer, createUser, loginAs, resetDatabase } from './helpers';

const app = createTestServer();
const PW = 'Correct-Horse-1';
type Session = { cookie: string; csrf: string; user: { id: string } };
const as = (s: Session, m: 'get' | 'post' | 'patch', url: string) => request(app)[m](url).set('Cookie', s.cookie).set('x-csrf-token', s.csrf);
let admin: Session, hr: Session, emp: Session;
let orgA: string, orgB: string, orgOff: string, annual: string, sick: string;
let empA_FT: string, empB_PT: string;

async function mkEmployee(code: string, organizationId: string, employmentType: string) {
  const dept = await prisma.department.create({ data: { organizationId, code: `D-${code}`, name: code } });
  const pos = await prisma.position.create({ data: { departmentId: dept.id, code: `P-${code}`, title: code } });
  return (await prisma.employee.create({ data: { employeeCode: code, firstName: code, lastName: 'L', email: `${code.toLowerCase()}@lm.local`, hireDate: new Date('2020-01-01'), organizationId, departmentId: dept.id, positionId: pos.id, employmentType, positionHistory: { create: { positionId: pos.id, departmentId: dept.id, startDate: new Date('2020-01-01') } } } })).id;
}
const policy = (s: Session, body: object) => as(s, 'post', '/api/v1/leave/policies').send({ name: 'p', leaveTypeId: annual, annualUnits: 10, effectiveFrom: '2026-01-01', workflowDefinitionCode: 'LEAVE_STD', ...body });
async function activePolicy(body: object) {
  const c = await policy(admin, body);
  if (c.status !== 201) throw new Error(`policy create: ${c.status} ${JSON.stringify(c.body)}`);
  const a = await as(admin, 'patch', `/api/v1/leave/policies/${c.body.data.id}/activate`);
  if (a.status !== 200) throw new Error(`policy activate: ${a.status} ${JSON.stringify(a.body)}`);
  return a.body.data as { id: string; name: string };
}
const workflow = async (code: string, module = 'leave', entityType = 'LEAVE_REQUEST') => {
  const c = await as(admin, 'post', '/api/v1/workflow/definitions').send({ code, name: code, module, entityType, steps: [{ name: 'Manager', approverType: 'DIRECT_MANAGER' }] });
  await as(admin, 'post', `/api/v1/workflow/definitions/${c.body.data.id}/activate`);
  return c.body.data.id as string;
};

beforeAll(async () => {
  await resetDatabase();
  orgA = (await prisma.organization.create({ data: { code: 'LA', name: 'Leave A' } })).id;
  orgB = (await prisma.organization.create({ data: { code: 'LB', name: 'Leave B' } })).id;
  orgOff = (await prisma.organization.create({ data: { code: 'LOFF', name: 'Inactive Co', isActive: false } })).id;
  empA_FT = await mkEmployee('AFT', orgA, 'FULL_TIME');
  empB_PT = await mkEmployee('BPT', orgB, 'PART_TIME');
  await createUser({ email: 'admin@lm.local', password: PW, role: 'SYSTEM_ADMIN' });
  await createUser({ email: 'hr@lm.local', password: PW, role: 'HR' });
  await createUser({ email: 'emp@lm.local', password: PW, role: 'EMPLOYEE' });
  [admin, hr, emp] = await Promise.all(['admin', 'hr', 'emp'].map((u) => loginAs(app, `${u}@lm.local`, PW)));
  await workflow('LEAVE_STD');
  await workflow('OTHER_MODULE', 'test', 'LEAVE_REQUEST');
  await workflow('OTHER_ENTITY', 'leave', 'OtherThing');
});
afterAll(async () => { await resetDatabase(); await prisma.$disconnect(); });

describe('leave types', () => {
  it('permissions: HR (no leave.manage_types) → 403; employee → 403', async () => {
    expect((await as(hr, 'get', '/api/v1/leave/types')).status).toBe(403);
    expect((await as(emp, 'post', '/api/v1/leave/types').send({ code: 'X', name: 'x' })).status).toBe(403);
  });
  it('21. create; 22. duplicate code; 23. update', async () => {
    const res = await as(admin, 'post', '/api/v1/leave/types').send({ code: 'annual', name: 'Annual Leave', description: 'Paid annual leave' });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ code: 'ANNUAL', isActive: true, activePolicyCount: 0 });
    annual = res.body.data.id;
    sick = (await as(admin, 'post', '/api/v1/leave/types').send({ code: 'SICK', name: 'Sick Leave' })).body.data.id;
    const dup = await as(admin, 'post', '/api/v1/leave/types').send({ code: 'ANNUAL', name: 'dup' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('LEAVE_TYPE_CODE_ALREADY_EXISTS');
    const upd = await as(admin, 'patch', `/api/v1/leave/types/${annual}`).send({ name: 'Annual leave', description: null });
    expect(upd.status).toBe(200);
    expect(JSON.parse((await prisma.auditLog.findFirst({ where: { action: 'UPDATE_LEAVE_TYPE', recordId: annual } }))!.newValue!)).toEqual({ name: 'Annual leave', description: null });
    // type-level must not carry business rules
    const strict = await as(admin, 'post', '/api/v1/leave/types').send({ code: 'PERS', name: 'Personal', isPaid: true, allowHalfDay: false });
    expect(strict.status).toBe(201);
    expect(strict.body.data).not.toHaveProperty('isPaid');
  });
  it('24. deactivate unused; 26. reactivate; 25. type with active policy cannot deactivate', async () => {
    const pers = (await prisma.leaveType.findUniqueOrThrow({ where: { code: 'PERS' } })).id;
    expect((await as(admin, 'patch', `/api/v1/leave/types/${pers}/deactivate`)).body.data.isActive).toBe(false);
    expect((await as(admin, 'patch', `/api/v1/leave/types/${pers}/activate`)).body.data.isActive).toBe(true);
    await activePolicy({ name: 'Global any', leaveTypeId: annual });
    const blocked = await as(admin, 'patch', `/api/v1/leave/types/${annual}/deactivate`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('LEAVE_TYPE_IN_USE');
    expect((await as(admin, 'get', `/api/v1/leave/types/${annual}`)).body.data).toMatchObject({ isActive: true, activePolicyCount: 1 });
  });
});

describe('policies: validation basics', () => {
  it('unit precision (POLICY_UNIT_INVALID via validation), effective dates, permissions', async () => {
    for (const bad of [10.25, -1, 'abc']) {
      const r = await policy(admin, { annualUnits: bad });
      expect(r.status, String(bad)).toBe(400);
      expect(r.body.error.code).toBe('VALIDATION_ERROR');
      expect(r.body.error.details.some((d: { field: string }) => d.field === 'annualUnits')).toBe(true);
    }
    expect((await policy(admin, { annualUnits: 10.5 })).status).toBe(201);
    const dates = await policy(admin, { effectiveFrom: '2026-06-01', effectiveTo: '2026-05-31' });
    expect(dates.status).toBe(400);
    expect(dates.body.error.code).toBe('POLICY_EFFECTIVE_DATE_INVALID');
    expect((await policy(admin, { effectiveFrom: '2026-02-30' })).status).toBe(400);
    expect((await policy(admin, { employmentType: 'GIG' })).status).toBe(400);
    expect((await policy(hr, {})).status).toBe(403);
    expect((await as(hr, 'get', '/api/v1/leave/policies')).status).toBe(403);
    expect((await policy(admin, { leaveTypeId: 'nope' })).body.error.code).toBe('LEAVE_TYPE_NOT_FOUND');
    expect((await policy(admin, { organizationId: 'nope' })).body.error.code).toBe('ORGANIZATION_NOT_FOUND');
  });
});

describe('policy matching (precedence)', () => {
  let globalAny: string, globalFT: string, orgAAny: string, orgAFT: string;
  beforeAll(async () => {
    await prisma.leavePolicy.deleteMany();
    globalAny = (await activePolicy({ name: 'Global any', leaveTypeId: annual })).id;
    globalFT = (await activePolicy({ name: 'Global FULL_TIME', leaveTypeId: annual, employmentType: 'FULL_TIME' })).id;
    orgAAny = (await activePolicy({ name: 'Org A any', leaveTypeId: annual, organizationId: orgA })).id;
    orgAFT = (await activePolicy({ name: 'Org A FULL_TIME', leaveTypeId: annual, organizationId: orgA, employmentType: 'FULL_TIME' })).id;
  });
  const resolve = (organizationId: string, employmentType: string, asOfDate = '2026-09-22', leaveTypeId = annual) => leavePoliciesService.resolve(prisma, { leaveTypeId, organizationId, employmentType, asOfDate });
  it('32. Org A FULL_TIME → exact/exact', async () => expect((await resolve(orgA, 'FULL_TIME')).id).toBe(orgAFT));
  it('33. Org A PART_TIME → org/any', async () => expect((await resolve(orgA, 'PART_TIME')).id).toBe(orgAAny));
  it('34. Org B FULL_TIME → global/type', async () => expect((await resolve(orgB, 'FULL_TIME')).id).toBe(globalFT));
  it('35. Org B PART_TIME → global default', async () => expect((await resolve(orgB, 'PART_TIME')).id).toBe(globalAny));
  it('36. no matching policy → LEAVE_POLICY_NOT_FOUND', async () => {
    await expect(resolve(orgB, 'PART_TIME', '2026-09-22', sick)).rejects.toMatchObject({ code: 'LEAVE_POLICY_NOT_FOUND' });
  });
  it('37. inactive policy ignored; 38. outside effective range ignored', async () => {
    await as(admin, 'patch', `/api/v1/leave/policies/${orgAFT}/deactivate`);
    expect((await resolve(orgA, 'FULL_TIME')).id).toBe(orgAAny);
    await as(admin, 'patch', `/api/v1/leave/policies/${orgAFT}/activate`);
    await expect(resolve(orgA, 'FULL_TIME', '2025-12-31')).rejects.toMatchObject({ code: 'LEAVE_POLICY_NOT_FOUND' });
  });
  it('admin preview endpoint derives org/employment type from the employee and never lets the client pick a policy', async () => {
    const res = await as(admin, 'get', `/api/v1/leave/policies/resolve?employeeId=${empA_FT}&leaveTypeId=${annual}&asOfDate=2026-09-22`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ asOfDate: '2026-09-22', policy: { id: orgAFT } });
    expect((await as(admin, 'get', `/api/v1/leave/policies/resolve?employeeId=${empB_PT}&leaveTypeId=${annual}`)).body.data.policy.id).toBe(globalAny);
    expect((await as(admin, 'get', `/api/v1/leave/policies/resolve?employeeId=${empB_PT}&leaveTypeId=${sick}`)).status).toBe(404);
  });
});

describe('policy overlap (same selector + overlapping inclusive ranges)', () => {
  it('39. same selector overlapping → LEAVE_POLICY_OVERLAP; 40. adjacent allowed; boundary 06-30 vs 06-30 rejects, 07-01 allowed', async () => {
    await prisma.leavePolicy.deleteMany();
    await activePolicy({ name: 'A FT H1', organizationId: orgA, employmentType: 'FULL_TIME', effectiveFrom: '2026-01-01', effectiveTo: '2026-06-30' });
    const overlap = await policy(admin, { name: 'A FT overlap', organizationId: orgA, employmentType: 'FULL_TIME', effectiveFrom: '2026-06-01', effectiveTo: '2026-12-31' });
    const act = await as(admin, 'patch', `/api/v1/leave/policies/${overlap.body.data.id}/activate`);
    expect(act.status).toBe(409);
    expect(act.body.error.code).toBe('LEAVE_POLICY_OVERLAP');
    expect((await as(admin, 'get', `/api/v1/leave/policies/${overlap.body.data.id}`)).body.data.isActive).toBe(false);
    const boundary = await policy(admin, { name: 'A FT boundary', organizationId: orgA, employmentType: 'FULL_TIME', effectiveFrom: '2026-06-30' });
    expect((await as(admin, 'patch', `/api/v1/leave/policies/${boundary.body.data.id}/activate`)).body.error.code).toBe('LEAVE_POLICY_OVERLAP');
    const adjacent = await activePolicy({ name: 'A FT H2', organizationId: orgA, employmentType: 'FULL_TIME', effectiveFrom: '2026-07-01', effectiveTo: '2026-12-31' });
    expect(adjacent.id).toBeDefined();
  });
  it('41. open-ended + overlapping rejected; 42/43/44. different org / employment selector and global+specific coexist', async () => {
    const open = await policy(admin, { name: 'A FT open', organizationId: orgA, employmentType: 'FULL_TIME', effectiveFrom: '2026-10-01' }); // overlaps H2 (07-01 → 12-31)
    expect((await as(admin, 'patch', `/api/v1/leave/policies/${open.body.data.id}/activate`)).body.error.code).toBe('LEAVE_POLICY_OVERLAP');
    await activePolicy({ name: 'B FT', organizationId: orgB, employmentType: 'FULL_TIME', effectiveFrom: '2026-01-01' });
    await activePolicy({ name: 'A PT', organizationId: orgA, employmentType: 'PART_TIME', effectiveFrom: '2026-01-01' });
    await activePolicy({ name: 'Global FT', employmentType: 'FULL_TIME', effectiveFrom: '2026-01-01' });
    await activePolicy({ name: 'Global any', effectiveFrom: '2026-01-01' });
    expect(await prisma.leavePolicy.count({ where: { isActive: true } })).toBe(6);
    // editing an ACTIVE policy into an overlap is rejected too
    const h2 = await prisma.leavePolicy.findFirstOrThrow({ where: { name: 'A FT H2' } });
    const edit = await as(admin, 'patch', `/api/v1/leave/policies/${h2.id}`).send({ effectiveFrom: '2026-06-15' });
    expect(edit.status).toBe(409);
    expect(edit.body.error.code).toBe('LEAVE_POLICY_OVERLAP');
    expect((await prisma.leavePolicy.findUniqueOrThrow({ where: { id: h2.id } })).effectiveFrom).toBe('2026-07-01'); // rolled back
  });
});

describe('policy activation rules', () => {
  it('45. inactive leave type; 46. inactive organization; 47. workflow missing; 48. wrong module; 49. wrong entity; 50. compatible → success; 51. reactivation re-validates', async () => {
    await prisma.leavePolicy.deleteMany();
    const inactiveType = (await as(admin, 'post', '/api/v1/leave/types').send({ code: 'OLD', name: 'Old' })).body.data.id;
    await as(admin, 'patch', `/api/v1/leave/types/${inactiveType}/deactivate`);
    const tryActivate = async (body: object) => { const c = await policy(admin, body); const a = await as(admin, 'patch', `/api/v1/leave/policies/${c.body.data.id}/activate`); return { id: c.body.data.id as string, code: a.body.error?.code, status: a.status }; };
    expect((await tryActivate({ leaveTypeId: inactiveType })).code).toBe('LEAVE_TYPE_INACTIVE');
    expect((await tryActivate({ organizationId: orgOff })).code).toBe('ORGANIZATION_INACTIVE');
    expect((await tryActivate({ workflowDefinitionCode: null })).code).toBe('WORKFLOW_DEFINITION_NOT_FOUND');
    expect((await tryActivate({ workflowDefinitionCode: 'NOPE' })).code).toBe('WORKFLOW_DEFINITION_NOT_FOUND');
    expect((await tryActivate({ workflowDefinitionCode: 'OTHER_MODULE' })).code).toBe('WORKFLOW_DEFINITION_INCOMPATIBLE');
    expect((await tryActivate({ workflowDefinitionCode: 'OTHER_ENTITY' })).code).toBe('WORKFLOW_DEFINITION_INCOMPATIBLE');
    const ok = await tryActivate({ name: 'ok', workflowDefinitionCode: 'LEAVE_STD' });
    expect(ok.status).toBe(200);
    // reactivation reruns validation: deactivate the workflow, then activate again → rejected
    await as(admin, 'patch', `/api/v1/leave/policies/${ok.id}/deactivate`);
    const def = await prisma.workflowDefinition.findFirstOrThrow({ where: { code: 'LEAVE_STD' } });
    await as(admin, 'post', `/api/v1/workflow/definitions/${def.id}/deactivate`);
    const re = await as(admin, 'patch', `/api/v1/leave/policies/${ok.id}/activate`);
    expect(re.status).toBe(409);
    expect(re.body.error.code).toBe('WORKFLOW_DEFINITION_NOT_FOUND');
    await as(admin, 'post', `/api/v1/workflow/definitions/${def.id}/activate`);
    expect((await as(admin, 'patch', `/api/v1/leave/policies/${ok.id}/activate`)).status).toBe(200);
    expect(await prisma.auditLog.count({ where: { action: { in: ['ACTIVATE_LEAVE_POLICY', 'DEACTIVATE_LEAVE_POLICY'] }, recordId: ok.id } })).toBe(3);
  });
  it('52. workflow picker returns only active, compatible definitions (leave.manage_policies, not workflow admin)', async () => {
    const res = await as(admin, 'get', '/api/v1/leave/workflow-options');
    expect(res.status).toBe(200);
    expect(res.body.data.map((d: { code: string }) => d.code)).toEqual(['LEAVE_STD']);
    expect(res.body.data[0]).toMatchObject({ version: 1, steps: [{ stepOrder: 1, approverType: 'DIRECT_MANAGER' }] });
    expect(Object.keys(res.body.data[0]).sort()).toEqual(['code', 'name', 'steps', 'version']);
    const perm = await prisma.permission.findUniqueOrThrow({ where: { code: 'leave.manage_policies' } });
    await prisma.role.create({ data: { code: 'POLICY_ONLY', name: 'policy only', dataScope: 'SELF', rolePermissions: { create: [{ permissionId: perm.id }] } } });
    await createUser({ email: 'policy@lm.local', password: PW, role: 'POLICY_ONLY' });
    const pol = await loginAs(app, 'policy@lm.local', PW);
    expect((await as(pol, 'get', '/api/v1/leave/workflow-options')).status).toBe(200);
    expect((await as(pol, 'get', '/api/v1/workflow/definitions')).status).toBe(403);
    expect((await as(hr, 'get', '/api/v1/leave/workflow-options')).status).toBe(403);
  });
});
