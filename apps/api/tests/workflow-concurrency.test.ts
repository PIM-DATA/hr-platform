/**
 * Task 8.2 — workflow transition concurrency on PostgreSQL. Every scenario fires REAL concurrent transactions
 * (HTTP requests each run `prisma.$transaction(act)`; cancel runs in its own transaction) and relies only on the
 * instance row lock in loadWorkflowInstanceForMutation. No sleeps to hide races, no retries, no mutex.
 */
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma';
import { loadWorkflowInstanceForMutation, workflowEngine } from '../src/services/workflow';
import type { Actor } from '../src/services/workflow/workflow.types';
import { createTestServer, createUser, loginAs, resetDatabase, waitForBlockedSession } from './helpers';

const app = createTestServer();
const PW = 'Correct-Horse-1';
type Session = { cookie: string; csrf: string; user: { id: string; employee: { id: string } | null } };
const as = (s: Session, url: string) => request(app).post(url).set('Cookie', s.cookie).set('x-csrf-token', s.csrf);
let admin: Session, mgrS: Session, headS: Session, empS: Session;
let EMP: string, EMP2: string;
let n = 0;
const calls = { approved: 0, rejected: 0, cancelled: 0 };
let failNextApproved: (() => Promise<void>) | null = null;

const actorOf = (s: Session): Actor => ({ auth: { userId: s.user.id, email: '', employeeId: s.user.employee?.id ?? null, roles: [], permissions: [], dataScope: 'SELF', sessionId: 's', csrfToken: 'c' }, ipAddress: null, userAgent: null });
const submit = (code: string, requester = EMP) => prisma.$transaction((tx) => workflowEngine.submit({ definitionCode: code, module: 'ctest', entityType: 'TestRequest', entityId: `e-${++n}`, requesterEmployeeId: requester }, actorOf(empS), tx));
const act = (s: Session, id: string, action: 'APPROVE' | 'REJECT') => as(s, `/api/v1/workflow/instances/${id}/actions`).send({ action });
const cancel = (id: string) => prisma.$transaction((tx) => workflowEngine.cancel(id, actorOf(empS), tx));
const state = (id: string) => prisma.workflowInstance.findUniqueOrThrow({ where: { id }, include: { steps: { orderBy: { stepOrder: 'asc' } }, actions: true } });
const audits = (id: string, action: string) => prisma.auditLog.count({ where: { recordType: 'WorkflowInstance', recordId: id, action } });
const code = (r: request.Response) => (r.status === 200 ? 'OK' : r.body.error?.code);

beforeAll(async () => {
  await resetDatabase();
  const org = await prisma.organization.create({ data: { code: 'WC', name: 'Wf Concurrency' } });
  const dept = await prisma.department.create({ data: { organizationId: org.id, code: 'D', name: 'D' } });
  const mk = async (c: string, managerId: string | null) => { const pos = await prisma.position.create({ data: { departmentId: dept.id, code: `P-${c}`, title: c } }); return (await prisma.employee.create({ data: { employeeCode: c, firstName: c, lastName: 'W', email: `${c.toLowerCase()}@wc.local`, hireDate: new Date('2020-01-01'), organizationId: org.id, departmentId: dept.id, positionId: pos.id, managerId, employmentStatus: 'ACTIVE' } })).id; };
  const HEAD = await mk('HEAD', null); const MGR = await mk('MGR', HEAD); EMP = await mk('EMP', MGR); EMP2 = await mk('EMP2', MGR);
  await prisma.department.update({ where: { id: dept.id }, data: { headEmployeeId: HEAD } });
  await createUser({ email: 'admin@wc.local', password: PW, role: 'SYSTEM_ADMIN' });
  await createUser({ email: 'mgr@wc.local', password: PW, role: 'MANAGER', employeeId: MGR });
  await createUser({ email: 'head@wc.local', password: PW, role: 'MANAGER', employeeId: HEAD });
  await createUser({ email: 'emp@wc.local', password: PW, role: 'EMPLOYEE', employeeId: EMP });
  [admin, mgrS, headS, empS] = await Promise.all(['admin', 'mgr', 'head', 'emp'].map((u) => loginAs(app, `${u}@wc.local`, PW)));
  for (const [c, steps] of [['ONE', [{ name: 'Manager', approverType: 'DIRECT_MANAGER' }]], ['TWO', [{ name: 'Manager', approverType: 'DIRECT_MANAGER' }, { name: 'Head', approverType: 'DEPARTMENT_HEAD' }]]] as const) {
    const d = await as(admin, '/api/v1/workflow/definitions').send({ code: c, name: c, module: 'ctest', entityType: 'TestRequest', steps });
    expect(d.status, JSON.stringify(d.body)).toBe(201);
    expect((await as(admin, `/api/v1/workflow/definitions/${d.body.data.id}/activate`)).status).toBe(200);
  }
  workflowEngine.registerHandler('ctest', {
    onApproved: async () => { calls.approved++; if (failNextApproved) { const f = failNextApproved; failNextApproved = null; await f(); } },
    onRejected: async () => { calls.rejected++; },
    onCancelled: async () => { calls.cancelled++; },
  });
});
beforeEach(() => { calls.approved = 0; calls.rejected = 0; calls.cancelled = 0; });
afterAll(async () => { workflowEngine._clearHandlers(); await resetDatabase(); await prisma.$disconnect(); });

describe('workflow instance row lock', () => {
  it('3. concurrent APPROVE + APPROVE by the same approver → exactly one transition (5 rounds)', async () => {
    for (let round = 0; round < 5; round++) {
      calls.approved = 0;
      const inst = await submit('ONE');
      const res = await Promise.all([act(mgrS, inst.id, 'APPROVE'), act(mgrS, inst.id, 'APPROVE')]);
      expect(res.map(code).sort(), `round ${round}`).toEqual(['OK', 'WORKFLOW_NOT_PENDING']);
      const s = await state(inst.id);
      expect(s.status).toBe('APPROVED');
      expect(s.steps.map((x) => x.status)).toEqual(['APPROVED']);
      expect(s.actions.filter((a) => a.action === 'APPROVE')).toHaveLength(1);
      expect(calls.approved).toBe(1);
      expect(await audits(inst.id, 'WORKFLOW_APPROVE')).toBe(1);
    }
  });

  it('4. concurrent APPROVE + REJECT → one terminal outcome, consistent instance/step/actions, one handler callback (5 rounds)', async () => {
    for (let round = 0; round < 5; round++) {
      calls.approved = 0; calls.rejected = 0;
      const inst = await submit('ONE');
      const res = await Promise.all([act(mgrS, inst.id, 'APPROVE'), act(mgrS, inst.id, 'REJECT')]);
      expect(res.map(code).sort()).toEqual(['OK', 'WORKFLOW_NOT_PENDING']);
      const s = await state(inst.id);
      expect(['APPROVED', 'REJECTED']).toContain(s.status);
      expect(s.steps[0].status).toBe(s.status);
      const decisions = s.actions.filter((a) => a.action !== 'SUBMIT');
      expect(decisions).toHaveLength(1);
      expect(decisions[0].action).toBe(s.status === 'APPROVED' ? 'APPROVE' : 'REJECT');
      expect(calls.approved + calls.rejected).toBe(1);
      expect(calls.approved).toBe(s.status === 'APPROVED' ? 1 : 0);
    }
  });

  it('5. final APPROVE vs internal cancel() → exactly one terminal outcome; never both handlers (5 rounds)', async () => {
    const outcomes = new Set<string>();
    for (let round = 0; round < 5; round++) {
      calls.approved = 0; calls.cancelled = 0;
      const inst = await submit('ONE');
      const [a, c] = await Promise.allSettled([act(mgrS, inst.id, 'APPROVE'), cancel(inst.id)]);
      const approveOk = a.status === 'fulfilled' && a.value.status === 200;
      const cancelOk = c.status === 'fulfilled';
      expect(approveOk !== cancelOk, `round ${round}: approve=${approveOk} cancel=${cancelOk}`).toBe(true);
      if (!approveOk) expect((a as PromiseFulfilledResult<request.Response>).value.body.error.code).toBe('WORKFLOW_NOT_PENDING');
      if (!cancelOk) expect((c as PromiseRejectedResult).reason).toMatchObject({ code: 'WORKFLOW_NOT_PENDING' });
      const s = await state(inst.id);
      expect(s.status).toBe(approveOk ? 'APPROVED' : 'CANCELLED');
      outcomes.add(s.status);
      expect(s.actions.filter((x) => x.action !== 'SUBMIT')).toHaveLength(1);
      expect(calls.approved + calls.cancelled).toBe(1);
      expect(await audits(inst.id, 'WORKFLOW_APPROVE') + await audits(inst.id, 'WORKFLOW_CANCEL')).toBe(1);
    }
    expect(outcomes.size).toBeGreaterThanOrEqual(1);
  });

  it('6. multi-step: concurrent approve of step 1 → step 1 APPROVED once, step 2 PENDING once, currentStepOrder = 2', async () => {
    const inst = await submit('TWO');
    const res = await Promise.all([act(mgrS, inst.id, 'APPROVE'), act(mgrS, inst.id, 'APPROVE')]);
    expect(res.filter((r) => r.status === 200)).toHaveLength(1);
    let s = await state(inst.id);
    expect(s.status).toBe('PENDING');
    expect(s.currentStepOrder).toBe(2);
    expect(s.steps.map((x) => x.status)).toEqual(['APPROVED', 'PENDING']);
    expect(s.actions.filter((a) => a.action === 'APPROVE')).toHaveLength(1);
    expect(calls.approved).toBe(0);
    // the loser saw the instance still PENDING but step 1 no longer pending → WORKFLOW_STEP_NOT_PENDING or NOT_STEP_APPROVER
    const loser = res.find((r) => r.status !== 200)!;
    expect(['WORKFLOW_STEP_NOT_PENDING', 'NOT_STEP_APPROVER']).toContain(loser.body.error.code);
    expect((await act(headS, inst.id, 'APPROVE')).status).toBe(200);
    s = await state(inst.id);
    expect(s.status).toBe('APPROVED'); expect(s.steps.map((x) => x.status)).toEqual(['APPROVED', 'APPROVED']); expect(calls.approved).toBe(1);
  }, 20000);

  it('7. different instances: B transitions while A is locked (lock granularity = instance row, no global mutex)', async () => {
    const a = await submit('ONE'); const b = await submit('ONE', EMP2);
    let release!: () => void; const held = new Promise<void>((r) => { release = r; });
    let locked!: () => void; const aHoldsLock = new Promise<void>((r) => { locked = r; });
    const holdA = prisma.$transaction(async (tx) => { await loadWorkflowInstanceForMutation(tx, a.id); locked(); await held; }, { timeout: 10000 });
    await aHoldsLock;
    const rb = await Promise.race([act(mgrS, b.id, 'APPROVE'), new Promise<'blocked'>((r) => setTimeout(() => r('blocked'), 1500))]);
    expect(rb).not.toBe('blocked');
    expect((rb as request.Response).status).toBe(200);
    release(); await holdA;
    expect((await state(b.id)).status).toBe('APPROVED');
    expect((await act(mgrS, a.id, 'APPROVE')).status).toBe(200);
  });

  it('8. rollback: handler throws after the transition → instance/step/action/audit unchanged, lock released, B then succeeds', async () => {
    const inst = await submit('ONE');
    failNextApproved = async () => { await waitForBlockedSession(); throw new Error('handler failure'); };
    // Two concurrent approvals; whichever takes the lock FIRST runs the failing handler (while the other is provably
    // blocked on the row lock) and is rolled back; the other must then acquire the lock and complete the transition.
    // HTTP delivery order is not deterministic, so the assertions are order-independent.
    const [r1, r2] = await Promise.all([act(mgrS, inst.id, 'APPROVE'), act(mgrS, inst.id, 'APPROVE')]);
    const failed = [r1, r2].find((r) => r.status === 500)!, ok = [r1, r2].find((r) => r.status === 200)!;
    expect(failed && ok, `${r1.status}/${r2.status}`).toBeTruthy();
    expect(failed.body.error.code).toBe('INTERNAL_ERROR'); expect(JSON.stringify(failed.body)).not.toMatch(/SELECT|FOR UPDATE|prisma/i);
    const s = await state(inst.id);
    expect(s.status).toBe('APPROVED');
    expect(s.actions.filter((x) => x.action === 'APPROVE')).toHaveLength(1);
    expect(s.steps[0]).toMatchObject({ status: 'APPROVED', actedByUserId: mgrS.user.id });
    expect(await audits(inst.id, 'WORKFLOW_APPROVE')).toBe(1);
    expect(calls.approved).toBe(2); // called by A (rolled back) and by B (committed)
    const stale = await prisma.$queryRaw<{ c: bigint }[]>`SELECT count(*) AS c FROM pg_stat_activity WHERE datname = current_database() AND state = 'idle in transaction'`;
    expect(Number(stale[0].c)).toBe(0);
  });

  it('rollback without contention: failed handler leaves the instance PENDING and re-approvable', async () => {
    const inst = await submit('ONE');
    failNextApproved = async () => { throw new Error('handler failure'); };
    expect((await act(mgrS, inst.id, 'APPROVE')).status).toBe(500);
    const s = await state(inst.id);
    expect(s.status).toBe('PENDING'); expect(s.steps[0].status).toBe('PENDING'); expect(s.actions.filter((x) => x.action === 'APPROVE')).toHaveLength(0);
    expect(await audits(inst.id, 'WORKFLOW_APPROVE')).toBe(0);
    expect((await act(mgrS, inst.id, 'APPROVE')).status).toBe(200);
    expect((await state(inst.id)).status).toBe('APPROVED');
  });
});
