import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { prisma } from '../src/lib/prisma';
import { auditService } from '../src/services/audit/audit.service';
import { balanceService } from '../src/modules/leave/balance.service';
import { createTestServer, createUser, loginAs, resetDatabase } from './helpers';

const app = createTestServer();
const PW = 'Correct-Horse-1';
type Session = { cookie: string; csrf: string; user: { id: string } };
const as = (s: Session, m: 'get' | 'post' | 'patch', url: string) => request(app)[m](url).set('Cookie', s.cookie).set('x-csrf-token', s.csrf);
let admin: Session, hr: Session, emp: Session, mgr: Session;
let orgA: string, annual: string, sick: string, zeroType: string, negType: string;
let EMP: string, PT: string, INACTIVE: string;
let policyA: string, policyZero: string, policyNeg: string;

async function mkEmployee(code: string, organizationId: string, employmentType = 'FULL_TIME', status = 'ACTIVE') {
  const dept = await prisma.department.create({ data: { organizationId, code: `D-${code}`, name: code } });
  const pos = await prisma.position.create({ data: { departmentId: dept.id, code: `P-${code}`, title: code } });
  return (await prisma.employee.create({ data: { employeeCode: code, firstName: code, lastName: 'E', email: `${code.toLowerCase()}@ent.local`, hireDate: new Date('2020-01-01'), organizationId, departmentId: dept.id, positionId: pos.id, employmentType, employmentStatus: status, positionHistory: { create: { positionId: pos.id, departmentId: dept.id, startDate: new Date('2020-01-01') } } } })).id;
}
const gen = (s: Session, body: object) => as(s, 'post', '/api/v1/leave/entitlements').send({ employeeId: EMP, leaveTypeId: annual, periodStart: '2026-01-01', periodEnd: '2026-12-31', ...body });
const adjust = (id: string, units: number, note: string | null = 'manual', s = admin) => as(s, 'post', `/api/v1/leave/entitlements/${id}/adjust`).send(note === null ? { units } : { units, note });
const summaryOf = (id: string) => prisma.leaveEntitlement.findUniqueOrThrow({ where: { id } });
async function expectReconciled(id: string) {
  const r = await balanceService.reconcile(prisma, id);
  expect(r.matches, JSON.stringify(r)).toBe(true);
  return r;
}
const actor = (s: Session) => ({ auth: { userId: s.user.id, email: '', employeeId: null, roles: [], permissions: [], dataScope: 'ALL' as const, sessionId: 's', csrfToken: 'c' }, ipAddress: null, userAgent: null });

beforeAll(async () => {
  await resetDatabase();
  orgA = (await prisma.organization.create({ data: { code: 'EA', name: 'Ent A' } })).id;
  EMP = await mkEmployee('EMP', orgA);
  PT = await mkEmployee('PT', orgA, 'PART_TIME');
  INACTIVE = await mkEmployee('OFF', orgA, 'FULL_TIME', 'INACTIVE');
  await createUser({ email: 'admin@ent.local', password: PW, role: 'SYSTEM_ADMIN' });
  await createUser({ email: 'hr@ent.local', password: PW, role: 'HR' }); // leave.manage_entitlements, no employees.view? HR has employees.view; use a custom role below for that check
  await createUser({ email: 'emp@ent.local', password: PW, role: 'EMPLOYEE' });
  await createUser({ email: 'mgr@ent.local', password: PW, role: 'MANAGER' });
  [admin, hr, emp, mgr] = await Promise.all(['admin', 'hr', 'emp', 'mgr'].map((u) => loginAs(app, `${u}@ent.local`, PW)));
  // workflow + types + policies
  const wf = await as(admin, 'post', '/api/v1/workflow/definitions').send({ code: 'LEAVE_STD', name: 'std', module: 'leave', entityType: 'LEAVE_REQUEST', steps: [{ name: 'Manager', approverType: 'DIRECT_MANAGER' }] });
  await as(admin, 'post', `/api/v1/workflow/definitions/${wf.body.data.id}/activate`);
  annual = (await as(admin, 'post', '/api/v1/leave/types').send({ code: 'ANNUAL', name: 'Annual' })).body.data.id;
  sick = (await as(admin, 'post', '/api/v1/leave/types').send({ code: 'SICK', name: 'Sick' })).body.data.id;
  zeroType = (await as(admin, 'post', '/api/v1/leave/types').send({ code: 'UNPAID', name: 'Unpaid' })).body.data.id;
  negType = (await as(admin, 'post', '/api/v1/leave/types').send({ code: 'ADV', name: 'Advance' })).body.data.id;
  const mkPolicy = async (body: object) => { const c = await as(admin, 'post', '/api/v1/leave/policies').send({ name: 'p', leaveTypeId: annual, annualUnits: 10, effectiveFrom: '2026-01-01', workflowDefinitionCode: 'LEAVE_STD', ...body }); const a = await as(admin, 'patch', `/api/v1/leave/policies/${c.body.data.id}/activate`); if (a.status !== 200) throw new Error(JSON.stringify(a.body)); return c.body.data.id as string; };
  policyA = await mkPolicy({ name: 'Annual FT 10', organizationId: orgA, employmentType: 'FULL_TIME', annualUnits: 10, carryForwardMaxUnits: 5 });
  await mkPolicy({ name: 'Annual PT 5', organizationId: orgA, employmentType: 'PART_TIME', annualUnits: 5 });
  policyZero = await mkPolicy({ name: 'Unpaid 0', leaveTypeId: zeroType, annualUnits: 0 });
  policyNeg = await mkPolicy({ name: 'Advance negative ok', leaveTypeId: negType, annualUnits: 2, allowNegativeBalance: true });
});
afterAll(async () => { await resetDatabase(); await prisma.$disconnect(); });

// ------------------------------------------------------------------ entitlement generation
describe('entitlements', () => {
  let ent: string;
  it('1. unauthenticated → 401; 2. without permission → 403; 3. HR allowed', async () => {
    expect((await request(app).get('/api/v1/leave/entitlements')).status).toBe(401);
    expect((await as(emp, 'get', '/api/v1/leave/entitlements')).status).toBe(403);
    expect((await as(mgr, 'post', '/api/v1/leave/entitlements').send({})).status).toBe(403);
    expect((await as(hr, 'get', '/api/v1/leave/entitlements')).status).toBe(200);
  });
  it('4/8/9/10/11/12. generate: policy resolved at periodStart, client policyId ignored, units from policy, GRANT ledger, summary = ledger', async () => {
    const res = await gen(hr, { policyId: 'forged', annualUnits: 99, granted: 99 });
    expect(res.status).toBe(201);
    ent = res.body.data.id;
    expect(res.body.data).toMatchObject({ policy: { id: policyA, name: 'Annual FT 10' }, policyResolvedDate: '2026-01-01', periodStart: '2026-01-01', periodEnd: '2026-12-31', granted: 10, carriedForward: 0, adjustment: 0, reserved: 0, used: 0, available: 10, employee: { employeeCode: 'EMP' } });
    const ledger = await prisma.leaveLedger.findMany({ where: { entitlementId: ent } });
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ entryType: 'GRANT', units: 10, operationKey: `grant:${ent}` });
    await expectReconciled(ent); // 53
    const audit = await prisma.auditLog.findFirst({ where: { action: 'GENERATE_LEAVE_ENTITLEMENT', recordId: ent } });
    expect(JSON.parse(audit!.newValue!)).toMatchObject({ policyId: policyA, granted: 10 });
    // PART_TIME resolves the PT policy → 5 units
    const pt = await gen(hr, { employeeId: PT });
    expect(pt.body.data).toMatchObject({ policy: { name: 'Annual PT 5' }, granted: 5 });
  });
  it('5. inactive employee; 6. inactive leave type; 7. invalid period; unknown employee/type', async () => {
    expect((await gen(hr, { employeeId: INACTIVE })).body.error.code).toBe('EMPLOYEE_INACTIVE');
    await as(admin, 'patch', `/api/v1/leave/types/${sick}/deactivate`);
    expect((await gen(hr, { leaveTypeId: sick })).body.error.code).toBe('LEAVE_TYPE_INACTIVE');
    await as(admin, 'patch', `/api/v1/leave/types/${sick}/activate`);
    expect((await gen(hr, { periodStart: '2026-12-31', periodEnd: '2026-01-01' })).status).toBe(400);
    expect((await gen(hr, { periodStart: '2026-02-30' })).status).toBe(400);
    expect((await gen(hr, { employeeId: 'nope' })).status).toBe(404);
    expect((await gen(hr, { leaveTypeId: 'nope' })).status).toBe(404);
    expect((await gen(hr, { leaveTypeId: sick })).body.error.code).toBe('LEAVE_POLICY_NOT_FOUND'); // no policy for SICK
  });
  it('13. annualUnits = 0 → entitlement created with zero summary and NO ledger row', async () => {
    const res = await gen(hr, { leaveTypeId: zeroType });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ policy: { id: policyZero }, granted: 0, available: 0 });
    expect(await prisma.leaveLedger.count({ where: { entitlementId: res.body.data.id } })).toBe(0);
    await expectReconciled(res.body.data.id);
  });
  it('14. identical → ENTITLEMENT_ALREADY_EXISTS; 15. overlapping → ENTITLEMENT_PERIOD_OVERLAP; 16. next period allowed; no extra GRANT', async () => {
    const before = await prisma.leaveLedger.count({ where: { entryType: 'GRANT' } });
    expect((await gen(hr, {})).body.error.code).toBe('ENTITLEMENT_ALREADY_EXISTS');
    expect((await gen(hr, { periodStart: '2026-07-01', periodEnd: '2027-06-30' })).body.error.code).toBe('ENTITLEMENT_PERIOD_OVERLAP');
    expect((await gen(hr, { periodStart: '2025-06-01', periodEnd: '2026-01-01' })).body.error.code).toBe('ENTITLEMENT_PERIOD_OVERLAP'); // touches first day
    const next = await gen(hr, { periodStart: '2027-01-01', periodEnd: '2027-12-31' });
    expect(next.status).toBe(201);
    expect(await prisma.leaveLedger.count({ where: { entryType: 'GRANT' } })).toBe(before + 1);
  });
  it('list filters + detail + ledger read (newest first, actor minimal, no operationKey)', async () => {
    const list = await as(hr, 'get', `/api/v1/leave/entitlements?employeeId=${EMP}&year=2026&leaveTypeId=${annual}`);
    expect(list.body.meta.total).toBe(1);
    expect((await as(hr, 'get', `/api/v1/leave/entitlements?organizationId=${orgA}`)).body.meta.total).toBe(4);
    expect((await as(hr, 'get', `/api/v1/leave/entitlements?search=PT`)).body.data[0].employee.employeeCode).toBe('PT');
    const led = await as(hr, 'get', `/api/v1/leave/entitlements/${ent}/ledger`);
    expect(led.body.data[0]).toMatchObject({ entryType: 'GRANT', units: 10, actor: { email: 'hr@ent.local' } });
    expect(led.body.data[0]).not.toHaveProperty('operationKey');
    expect((await as(hr, 'get', '/api/v1/leave/entitlements/nope')).status).toBe(404);
  });

  describe('adjustment', () => {
    it('17. positive; 18. negative; 22/23. summary + available from ledger; 54. reconciled', async () => {
      const up = await adjust(ent, 1.5, 'bonus');
      expect(up.status).toBe(200);
      expect(up.body.data).toMatchObject({ adjustment: 1.5, available: 11.5 });
      const down = await adjust(ent, -2, 'correction');
      expect(down.body.data).toMatchObject({ adjustment: -0.5, available: 9.5 });
      const rows = await prisma.leaveLedger.findMany({ where: { entitlementId: ent, entryType: 'ADJUSTMENT' } });
      expect(rows.map((r) => r.units).sort()).toEqual([-2, 1.5]);
      await expectReconciled(ent);
      const audit = await prisma.auditLog.findFirst({ where: { action: 'ADJUST_LEAVE_ENTITLEMENT', recordId: ent }, orderBy: { createdAt: 'desc' } });
      expect(JSON.parse(audit!.newValue!)).toMatchObject({ units: -2, note: 'correction', available: 9.5 });
    });
    it('19. zero rejected; 20. .25 rejected; 21. note required', async () => {
      for (const [units, note] of [[0, 'x'], [0.25, 'x'], [1, null], [1, '']] as const) {
        const r = await adjust(ent, units, note);
        expect(r.status, `${units}/${note}`).toBe(400);
      }
    });
    it('24. negative available blocked when policy disallows; 25. allowed when policy allows (uses the referenced policy)', async () => {
      const blocked = await adjust(ent, -10, 'too much'); // available 9.5 → -0.5
      expect(blocked.status).toBe(409);
      expect(blocked.body.error.code).toBe('INSUFFICIENT_LEAVE_BALANCE');
      expect((await summaryOf(ent)).adjustment).toBe(-0.5); // untouched (52)
      await expectReconciled(ent);
      const neg = await gen(hr, { leaveTypeId: negType });
      const ok = await adjust(neg.body.data.id, -5, 'advance');
      expect(ok.status).toBe(200);
      expect(ok.body.data).toMatchObject({ policy: { id: policyNeg }, available: -3 });
    });
  });

  describe('carry-forward', () => {
    it('positive multiples only, capped cumulatively by policy.carryForwardMaxUnits, audited, reconciled', async () => {
      const cf = (units: number) => as(admin, 'post', `/api/v1/leave/entitlements/${ent}/carry-forward`).send({ units, note: 'from 2025' });
      expect((await cf(0)).status).toBe(400);
      expect((await cf(-1)).status).toBe(400);
      expect((await cf(3)).body.data).toMatchObject({ carriedForward: 3, available: 12.5 });
      const over = await cf(2.5); // 5.5 > cap 5
      expect(over.status).toBe(409);
      expect(over.body.error.code).toBe('CARRY_FORWARD_EXCEEDS_POLICY');
      expect((await cf(2)).body.data.carriedForward).toBe(5);
      expect(await prisma.auditLog.count({ where: { action: 'CARRY_FORWARD_LEAVE_ENTITLEMENT', recordId: ent } })).toBe(2);
      await expectReconciled(ent);
    });
  });
});

// ------------------------------------------------------------------ policy reference hardening
describe('policy reference hardening', () => {
  const patch = (body: object, id = policyA) => as(admin, 'patch', `/api/v1/leave/policies/${id}`).send(body);
  it('26–30. referenced policy rule/selector fields cannot change → LEAVE_POLICY_IN_USE', async () => {
    for (const body of [{ annualUnits: 12 }, { allowNegativeBalance: true }, { organizationId: null }, { employmentType: 'PART_TIME' }, { workflowDefinitionCode: 'OTHER' }, { effectiveFrom: '2026-02-01' }, { leaveTypeId: sick }, { carryForwardMaxUnits: 9 }]) {
      const r = await patch(body);
      expect(r.status, JSON.stringify(body)).toBe(409);
      expect(r.body.error.code).toBe('LEAVE_POLICY_IN_USE');
    }
    expect((await prisma.leavePolicy.findUniqueOrThrow({ where: { id: policyA } })).annualUnits).toBe(10);
  });
  it('32. metadata (name) editable; sending unchanged rule values is not a change', async () => {
    expect((await patch({ name: 'Annual FT 10 (2026)' })).status).toBe(200);
    expect((await patch({ annualUnits: 10, name: 'Annual FT 10' })).status).toBe(200);
  });
  it('33. effectiveTo on/after latest policyResolvedDate allowed; 34. before → rejected; 35. still checks overlap', async () => {
    // latest resolved date for policyA = 2027-01-01 (next-period entitlement)
    expect((await patch({ effectiveTo: '2026-12-31' })).body.error.code).toBe('LEAVE_POLICY_IN_USE');
    const ok = await patch({ effectiveTo: '2027-12-31' });
    expect(ok.status).toBe(200);
    expect(ok.body.data.effectiveTo).toBe('2027-12-31');
    // a successor with the same selector must start after 2027-12-31; overlapping start is rejected by the overlap rule
    const succ = await as(admin, 'post', '/api/v1/leave/policies').send({ name: 'Annual FT 12', leaveTypeId: annual, organizationId: orgA, employmentType: 'FULL_TIME', annualUnits: 12, effectiveFrom: '2027-06-01', workflowDefinitionCode: 'LEAVE_STD' });
    expect((await as(admin, 'patch', `/api/v1/leave/policies/${succ.body.data.id}/activate`)).body.error.code).toBe('LEAVE_POLICY_OVERLAP');
    expect((await as(admin, 'patch', `/api/v1/leave/policies/${succ.body.data.id}`).send({ effectiveFrom: '2028-01-01' })).status).toBe(200);
    expect((await as(admin, 'patch', `/api/v1/leave/policies/${succ.body.data.id}/activate`)).status).toBe(200);
    // and the referenced policy cannot then extend effectiveTo into the successor
    expect((await patch({ effectiveTo: '2028-06-30' })).body.error.code).toBe('LEAVE_POLICY_OVERLAP');
  });
  it('31. referenced policy can be deactivated; entitlement still readable with the historical policy', async () => {
    expect((await as(admin, 'patch', `/api/v1/leave/policies/${policyA}/deactivate`)).body.data.isActive).toBe(false);
    const e = await prisma.leaveEntitlement.findFirstOrThrow({ where: { policyId: policyA } });
    const res = await as(hr, 'get', `/api/v1/leave/entitlements/${e.id}`);
    expect(res.status).toBe(200);
    expect(res.body.data.policy).toMatchObject({ id: policyA, isActive: false });
    // negative-balance rule still comes from the referenced (now inactive) policy
    expect((await adjust(e.id, -100, 'x')).body.error.code).toBe('INSUFFICIENT_LEAVE_BALANCE');
    await as(admin, 'patch', `/api/v1/leave/policies/${policyA}/activate`);
  });
});

// ------------------------------------------------------------------ BalanceService foundation (service-level)
describe('BalanceService ledger summary + guards', () => {
  let id: string;
  const meta = (key: string, note = 'svc') => ({ operationKey: key, actorUserId: admin.user.id, note });
  const inTx = <T,>(fn: (tx: Parameters<typeof balanceService.grant>[0]) => Promise<T>) => prisma.$transaction(fn);
  beforeAll(async () => {
    const e = await prisma.leaveEntitlement.create({ data: { employeeId: EMP, leaveTypeId: sick, policyId: policyA, policyResolvedDate: '2026-01-01', periodStart: '2026-01-01', periodEnd: '2026-12-31', createdByUserId: admin.user.id } });
    id = e.id;
  });
  it('36–42. each entry type affects exactly its summary field; 46. available formula', async () => {
    await inTx((tx) => balanceService.grant(tx, id, 10, meta('t:grant')));
    await inTx((tx) => balanceService.carryForward(tx, id, 2, meta('t:cf')));
    await inTx((tx) => balanceService.adjust(tx, id, -1, meta('t:adj')));
    let s = await summaryOf(id);
    expect(s).toMatchObject({ granted: 10, carriedForward: 2, adjustment: -1, reserved: 0, used: 0 });
    const r1 = await inTx((tx) => balanceService.reserve(tx, id, 3, meta('t:reserve')));
    expect(r1.summary.reserved).toBe(3);
    expect(r1.available).toBe(8); // 10+2-1-3
    const r2 = await inTx((tx) => balanceService.release(tx, id, 1, meta('t:release')));
    expect(r2.summary.reserved).toBe(2);
    const u = await inTx((tx) => balanceService.use(tx, id, 2, meta('t:use')));
    expect(u.summary.used).toBe(2);
    const rf = await inTx((tx) => balanceService.refund(tx, id, 0.5, meta('t:refund')));
    expect(rf.summary.used).toBe(1.5);
    s = await summaryOf(id);
    expect(s).toMatchObject({ granted: 10, carriedForward: 2, adjustment: -1, reserved: 2, used: 1.5 });
    expect(rf.available).toBe(7.5); // 10 + 2 - 1 - 2 - 1.5
    const ledger = await prisma.leaveLedger.findMany({ where: { entitlementId: id }, orderBy: { createdAt: 'asc' } });
    expect(ledger.map((l) => [l.entryType, l.units])).toEqual([['GRANT', 10], ['CARRY_FORWARD', 2], ['ADJUSTMENT', -1], ['RESERVE', 3], ['RELEASE', -1], ['USE', 2], ['REFUND', -0.5]]);
    await expectReconciled(id); // 55
  });
  it('43. reserve beyond available rejected; 44. release beyond reserved rejected; 45. refund beyond used rejected; sign/precision guards', async () => {
    await expect(inTx((tx) => balanceService.reserve(tx, id, 8, meta('t:reserve-too-much')))).rejects.toMatchObject({ code: 'INSUFFICIENT_LEAVE_BALANCE' });
    await expect(inTx((tx) => balanceService.release(tx, id, 5, meta('t:release-too-much')))).rejects.toMatchObject({ code: 'LEDGER_RELEASE_EXCEEDS_RESERVED' });
    await expect(inTx((tx) => balanceService.refund(tx, id, 2, meta('t:refund-too-much')))).rejects.toMatchObject({ code: 'LEDGER_REFUND_EXCEEDS_USED' });
    await expect(inTx((tx) => balanceService.grant(tx, id, 0.25, meta('t:bad-unit')))).rejects.toMatchObject({ code: 'LEDGER_UNIT_INVALID' });
    await expect(inTx((tx) => balanceService.grant(tx, id, 0, meta('t:zero')))).rejects.toMatchObject({ code: 'LEDGER_UNIT_INVALID' });
    await expect(inTx((tx) => balanceService.grant(tx, id, -1, meta('t:neg-grant')))).rejects.toMatchObject({ code: 'LEDGER_SIGN_INVALID' });
    expect(await prisma.leaveLedger.count({ where: { entitlementId: id } })).toBe(7);
    await expectReconciled(id);
    // typical Task 11 approval: reserve 2 → release 2 + use 2 leaves reserved unchanged and used +2 (no double count)
    const before = await summaryOf(id);
    await inTx(async (tx) => { await balanceService.reserve(tx, id, 2, meta('leave:req1:reserve')); });
    await inTx(async (tx) => { await balanceService.release(tx, id, 2, meta('leave:req1:release')); await balanceService.use(tx, id, 2, meta('leave:req1:use')); });
    const after = await summaryOf(id);
    expect(after.reserved).toBe(before.reserved);
    expect(after.used).toBe(before.used + 2);
  });
  it('47. same operationKey + same payload → idempotent replay, no duplicate row; 48. different payload → LEDGER_OPERATION_CONFLICT', async () => {
    const count = await prisma.leaveLedger.count({ where: { entitlementId: id } });
    const replay = await inTx((tx) => balanceService.use(tx, id, 2, meta('leave:req1:use')));
    expect(replay.idempotentReplay).toBe(true);
    expect(await prisma.leaveLedger.count({ where: { entitlementId: id } })).toBe(count);
    await expect(inTx((tx) => balanceService.use(tx, id, 3, meta('leave:req1:use')))).rejects.toMatchObject({ code: 'LEDGER_OPERATION_CONFLICT' });
    await expect(inTx((tx) => balanceService.refund(tx, id, 2, meta('leave:req1:use')))).rejects.toMatchObject({ code: 'LEDGER_OPERATION_CONFLICT' });
    await expect(inTx((tx) => balanceService.use(tx, id, 2, { ...meta('leave:req1:use'), referenceType: 'LeaveRequest', referenceId: 'req1' }))).rejects.toMatchObject({ code: 'LEDGER_OPERATION_CONFLICT' });
    await expectReconciled(id);
  });
  it('49. ledger is append-only in application code (static check) and DB unique on operationKey', async () => {
    const files: string[] = [];
    const walk = (d: string) => { for (const f of readdirSync(d)) { const p = path.join(d, f); statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') && files.push(p); } };
    walk(path.join(__dirname, '../src'));
    const offenders = files.filter((f) => /leaveLedger\.(update|delete|upsert|updateMany|deleteMany)/.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
    await expect(prisma.leaveLedger.create({ data: { entitlementId: id, entryType: 'GRANT', units: 1, operationKey: 't:grant' } })).rejects.toThrow();
  });
});

// ------------------------------------------------------------------ transactions
describe('transactions', () => {
  it('50. audit failure during generation → no entitlement, no ledger', async () => {
    const spy = vi.spyOn(auditService, 'log').mockRejectedValueOnce(new Error('audit down'));
    const res = await gen(hr, { employeeId: PT, leaveTypeId: zeroType });
    spy.mockRestore();
    expect(res.status).toBe(500);
    expect(await prisma.leaveEntitlement.count({ where: { employeeId: PT, leaveTypeId: zeroType } })).toBe(0);
    const res2 = await gen(hr, { employeeId: PT, leaveTypeId: negType, periodStart: '2026-01-01', periodEnd: '2026-12-31' });
    const spy2 = vi.spyOn(auditService, 'log').mockRejectedValueOnce(new Error('audit down'));
    const gen2 = await gen(hr, { employeeId: PT, leaveTypeId: negType, periodStart: '2027-01-01', periodEnd: '2027-12-31' });
    spy2.mockRestore();
    expect(gen2.status).toBe(500);
    expect(await prisma.leaveLedger.count({ where: { entitlement: { employeeId: PT, leaveTypeId: negType } } })).toBe(1); // only res2's grant
    expect(res2.status).toBe(201);
  });
  it('51/52. adjustment audit failure → no ledger row, no cache drift', async () => {
    const e = await prisma.leaveEntitlement.findFirstOrThrow({ where: { employeeId: EMP, leaveTypeId: annual, periodStart: '2026-01-01' } });
    const before = await summaryOf(e.id);
    const count = await prisma.leaveLedger.count({ where: { entitlementId: e.id } });
    const spy = vi.spyOn(auditService, 'log').mockRejectedValueOnce(new Error('audit down'));
    expect((await adjust(e.id, 1, 'x')).status).toBe(500);
    spy.mockRestore();
    expect(await prisma.leaveLedger.count({ where: { entitlementId: e.id } })).toBe(count);
    expect(await summaryOf(e.id)).toMatchObject({ adjustment: before.adjustment, granted: before.granted });
    await expectReconciled(e.id);
  });
  it('reconcile reports drift when the cache is tampered (read-only check)', async () => {
    const e = await prisma.leaveEntitlement.findFirstOrThrow({ where: { employeeId: EMP, leaveTypeId: annual, periodStart: '2026-01-01' } });
    await prisma.leaveEntitlement.update({ where: { id: e.id }, data: { used: 99 } }); // simulate corruption
    const r = await balanceService.reconcile(prisma, e.id);
    expect(r.matches).toBe(false);
    expect(r.cached.used).toBe(99);
    expect(r.expected.used).toBe(0);
    await prisma.leaveEntitlement.update({ where: { id: e.id }, data: { used: r.expected.used } });
    await expectReconciled(e.id);
  });
});

// ------------------------------------------------------------------ options / security
describe('options endpoints', () => {
  it('56/57/58. leave admin without employees.view can use employee-options (active only, minimal); 59. type-options active only; 60. employee cannot', async () => {
    const perm = await prisma.permission.findUniqueOrThrow({ where: { code: 'leave.manage_entitlements' } });
    await prisma.role.create({ data: { code: 'ENT_ONLY', name: 'ent only', dataScope: 'SELF', rolePermissions: { create: [{ permissionId: perm.id }] } } });
    await createUser({ email: 'entonly@ent.local', password: PW, role: 'ENT_ONLY' });
    const s = await loginAs(app, 'entonly@ent.local', PW);
    expect((await as(s, 'get', '/api/v1/employees')).status).toBe(403);
    const opts = await as(s, 'get', `/api/v1/leave/employee-options?organizationId=${orgA}&limit=50`);
    expect(opts.status).toBe(200);
    const codes = opts.body.data.map((e: { employeeCode: string }) => e.employeeCode);
    expect(codes).toEqual(expect.arrayContaining(['EMP', 'PT']));
    expect(codes).not.toContain('OFF');
    expect(Object.keys(opts.body.data[0]).sort()).toEqual(['department', 'employeeCode', 'employmentType', 'firstName', 'id', 'lastName', 'organization']);
    expect((await as(s, 'get', '/api/v1/leave/employee-options?search=pt')).body.data.map((e: { employeeCode: string }) => e.employeeCode)).toEqual(['PT']);
    await as(admin, 'patch', `/api/v1/leave/types/${sick}/deactivate`).catch(() => undefined);
    const types = await as(s, 'get', '/api/v1/leave/type-options');
    expect(types.status).toBe(200);
    expect(types.body.data.map((t: { code: string }) => t.code)).not.toContain('SICK');
    expect(Object.keys(types.body.data[0]).sort()).toEqual(['code', 'id', 'name']);
    expect((await as(s, 'get', '/api/v1/leave/types')).status).toBe(403); // no leave.manage_types needed for options
    expect((await as(emp, 'get', '/api/v1/leave/employee-options')).status).toBe(403); // employee browser stays admin-only
    // type-options widened in Task 12: leave.view holders (every employee) need the active leave types to request leave.
    // The admin-only intent is unchanged — an EMPLOYEE still cannot reach any entitlement endpoint (tests 1–3).
    expect((await as(emp, 'get', '/api/v1/leave/type-options')).status).toBe(200);
    // preview endpoint resolves policy without letting the client pick it
    const prev = await as(s, 'get', `/api/v1/leave/entitlements/preview?employeeId=${PT}&leaveTypeId=${annual}&periodStart=2026-01-01`);
    expect(prev.body.data.policy).toMatchObject({ name: 'Annual PT 5', annualUnits: 5 });
  });
});
