/**
 * Task 10.6 — entitlement (grant) policy vs request policy.
 * leave_entitlements.policyId = historical grant policy (why the employee got N units; carry-forward cap; admin accounting).
 * leave_requests.policyId    = policy resolved at SUBMIT from the employee's CURRENT org/type — may differ after a transfer.
 * reserve() takes the request policy's allowNegativeBalance via `balancePolicyId`; adjust/carryForward keep the grant policy.
 */
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma';
import { balanceService } from '../src/modules/leave/balance.service';
import { createTestServer, createUser, loginAs, resetDatabase } from './helpers';

const app = createTestServer();
const PW = 'Correct-Horse-1';
type Session = { cookie: string; csrf: string; user: { id: string } };
const as = (s: Session, m: 'post' | 'patch', url: string) => request(app)[m](url).set('Cookie', s.cookie).set('x-csrf-token', s.csrf);
let admin: Session;
let orgA: string, orgB: string, annual: string, sick: string, EMP: string;
let policyA: string, policyB: string, policySick: string, entitlement: string;
let seq = 0;
const meta = (k: string, extra: object = {}) => ({ operationKey: `${k}:${++seq}`, actorUserId: admin.user.id, ...extra });
const reserve = (units: number, extra: object = {}) => prisma.$transaction((tx) => balanceService.reserve(tx, entitlement, units, meta('res', extra)));
const cached = () => prisma.leaveEntitlement.findUniqueOrThrow({ where: { id: entitlement } });

beforeAll(async () => {
  await resetDatabase();
  orgA = (await prisma.organization.create({ data: { code: 'PA', name: 'Policy A Co' } })).id;
  orgB = (await prisma.organization.create({ data: { code: 'PB', name: 'Policy B Co' } })).id;
  const dept = await prisma.department.create({ data: { organizationId: orgA, code: 'D', name: 'D' } });
  const pos = await prisma.position.create({ data: { departmentId: dept.id, code: 'P', title: 'P' } });
  EMP = (await prisma.employee.create({ data: { employeeCode: 'PS1', firstName: 'P', lastName: 'S', email: 'ps1@ps.local', hireDate: new Date('2020-01-01'), organizationId: orgA, departmentId: dept.id, positionId: pos.id, employmentType: 'FULL_TIME', employmentStatus: 'ACTIVE' } })).id;
  await createUser({ email: 'admin@ps.local', password: PW, role: 'SYSTEM_ADMIN' });
  admin = await loginAs(app, 'admin@ps.local', PW);
  const wf = await as(admin, 'post', '/api/v1/workflow/definitions').send({ code: 'LEAVE_STD', name: 'std', module: 'leave', entityType: 'LEAVE_REQUEST', steps: [{ name: 'Manager', approverType: 'DIRECT_MANAGER' }] });
  await as(admin, 'post', `/api/v1/workflow/definitions/${wf.body.data.id}/activate`);
  annual = (await prisma.leaveType.create({ data: { code: 'ANNUAL', name: 'Annual' } })).id;
  sick = (await prisma.leaveType.create({ data: { code: 'SICK', name: 'Sick' } })).id;
  policyA = (await prisma.leavePolicy.create({ data: { name: 'A: no negative', leaveTypeId: annual, organizationId: orgA, annualUnits: 2, effectiveFrom: '2026-01-01', isActive: true, workflowDefinitionCode: 'LEAVE_STD', allowNegativeBalance: false, carryForwardMaxUnits: 0 } })).id;
  policyB = (await prisma.leavePolicy.create({ data: { name: 'B: negative ok', leaveTypeId: annual, organizationId: orgB, annualUnits: 2, effectiveFrom: '2026-01-01', isActive: true, workflowDefinitionCode: 'LEAVE_STD', allowNegativeBalance: true } })).id;
  policySick = (await prisma.leavePolicy.create({ data: { name: 'Sick', leaveTypeId: sick, annualUnits: 5, effectiveFrom: '2026-01-01', isActive: true, workflowDefinitionCode: 'LEAVE_STD', allowNegativeBalance: true } })).id;
  // entitlement granted under policy A (employee was in org A on 2026-01-01)
  const e = await prisma.leaveEntitlement.create({ data: { employeeId: EMP, leaveTypeId: annual, policyId: policyA, policyResolvedDate: '2026-01-01', periodStart: '2026-01-01', periodEnd: '2026-12-31', createdByUserId: admin.user.id } });
  entitlement = e.id;
  await prisma.$transaction((tx) => balanceService.grant(tx, entitlement, 2, meta('grant')));
});
afterAll(async () => { await resetDatabase(); await prisma.$disconnect(); });

describe('request policy vs entitlement policy', () => {
  it('reserve without a request policy → entitlement grant policy A rule (no negative) → INSUFFICIENT_LEAVE_BALANCE', async () => {
    await expect(reserve(3)).rejects.toMatchObject({ code: 'INSUFFICIENT_LEAVE_BALANCE' });
    expect(await cached()).toMatchObject({ reserved: 0 });
  });

  it('entitlement policy A / request policy B → reserve uses policy B negative rule (allowed), balance from the old entitlement', async () => {
    const r = await reserve(3, { balancePolicyId: policyB, referenceType: 'LeaveRequest', referenceId: 'req-1' });
    expect(r.available).toBe(-1);
    expect(await cached()).toMatchObject({ policyId: policyA, reserved: 3 });
    expect((await balanceService.reconcile(prisma, entitlement)).matches).toBe(true);
    await prisma.$transaction((tx) => balanceService.release(tx, entitlement, 3, meta('rel')));
  });

  it('request policy for the same leave type is required: different leave type → BALANCE_POLICY_MISMATCH; unknown → LEAVE_POLICY_NOT_FOUND', async () => {
    await expect(reserve(1, { balancePolicyId: policySick })).rejects.toMatchObject({ code: 'BALANCE_POLICY_MISMATCH' });
    await expect(reserve(1, { balancePolicyId: 'nope' })).rejects.toMatchObject({ code: 'LEAVE_POLICY_NOT_FOUND' });
    expect(await cached()).toMatchObject({ reserved: 0 });
    expect(await prisma.leaveLedger.count({ where: { entitlementId: entitlement, entryType: 'RESERVE' } })).toBe(1); // only the earlier successful one
  });

  it('admin adjustment and carry-forward still use the entitlement grant policy A (negative not allowed; cf cap 0)', async () => {
    const adj = await as(admin, 'post', `/api/v1/leave/entitlements/${entitlement}/adjust`).send({ units: -3, note: 'over' });
    expect(adj.status).toBe(409); expect(adj.body.error.code).toBe('INSUFFICIENT_LEAVE_BALANCE');
    const cf = await as(admin, 'post', `/api/v1/leave/entitlements/${entitlement}/carry-forward`).send({ units: 1 });
    expect(cf.status).toBe(409); expect(cf.body.error.code).toBe('CARRY_FORWARD_EXCEEDS_POLICY');
    // the HTTP adjust route never accepts a balancePolicyId from the client (strict schema drops/ignores it)
    const forged = await as(admin, 'post', `/api/v1/leave/entitlements/${entitlement}/adjust`).send({ units: -3, note: 'forged', balancePolicyId: policyB });
    expect(forged.status).toBe(409); expect(forged.body.error.code).toBe('INSUFFICIENT_LEAVE_BALANCE');
  });

  it('a submitted leave request referencing policy B freezes its rule fields (LEAVE_POLICY_IN_USE); name/effectiveTo stay editable; drafts without policyId are not references', async () => {
    // draft (no policyId) → not a reference
    await prisma.leaveRequest.create({ data: { employeeId: EMP, leaveTypeId: annual, startDate: '2026-03-02', endDate: '2026-03-02', status: 'DRAFT', createdByUserId: admin.user.id } });
    const draftOnly = await as(admin, 'patch', `/api/v1/leave/policies/${policyB}`).send({ annualUnits: 3 });
    expect(draftOnly.status, JSON.stringify(draftOnly.body)).toBe(200);
    // submitted request snapshot → reference
    await prisma.leaveRequest.create({ data: { employeeId: EMP, leaveTypeId: annual, startDate: '2026-03-10', endDate: '2026-03-11', units: 2, status: 'PENDING', policyId: policyB, entitlementId: entitlement, submittedAt: new Date(), createdByUserId: admin.user.id } });
    const frozen = await as(admin, 'patch', `/api/v1/leave/policies/${policyB}`).send({ allowNegativeBalance: false });
    expect(frozen.status).toBe(409); expect(frozen.body.error.code).toBe('LEAVE_POLICY_IN_USE'); expect(frozen.body.error.message).toMatch(/1 leave request/);
    expect((await as(admin, 'patch', `/api/v1/leave/policies/${policyB}`).send({ name: 'B renamed' })).status).toBe(200);
    const early = await as(admin, 'patch', `/api/v1/leave/policies/${policyB}`).send({ effectiveTo: '2026-03-09' });
    expect(early.status).toBe(409); expect(early.body.error.code).toBe('LEAVE_POLICY_IN_USE');
    expect((await as(admin, 'patch', `/api/v1/leave/policies/${policyB}`).send({ effectiveTo: '2026-03-10' })).status).toBe(200);
    // deactivation stays allowed; the request keeps its historical policyId
    expect((await as(admin, 'patch', `/api/v1/leave/policies/${policyB}/deactivate`)).status).toBe(200);
    expect((await prisma.leaveRequest.findFirst({ where: { status: 'PENDING' } }))?.policyId).toBe(policyB);
  });
});
