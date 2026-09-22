/**
 * Task 11 — leave request concurrency on PostgreSQL (checklist 77–81). Real concurrent HTTP requests, each running its
 * own interactive transaction on its own connection. Correctness comes only from the row locks
 * (leave_request → employee → entitlement on submit; workflow_instance → leave_request → entitlement on transitions).
 * No sleeps to hide races, no retries, no application mutex.
 */
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma';
import { balanceService } from '../src/modules/leave/balance.service';
import { createTestServer } from './helpers';
import { setupLeaveFixture, type LeaveFixture, type Session } from './leave-fixture';

const app = createTestServer();
let f: LeaveFixture;
type Body = { leaveTypeId: string; startDate: string; endDate?: string; startPart?: 'FULL' | 'PM'; endPart?: 'FULL' | 'AM'; reason?: string | null; attachmentRef?: string | null };
const draft = (s: Session, b: Body) => f.as(s, 'post', '/api/v1/leave/requests').send({ endDate: b.startDate, ...b });
const submit = (s: Session, id: string) => f.as(s, 'post', `/api/v1/leave/requests/${id}/submit`);
const cancel = (s: Session, id: string) => f.as(s, 'post', `/api/v1/leave/requests/${id}/cancel`);
const act = (s: Session, wfId: string, action: 'APPROVE' | 'REJECT') => f.as(s, 'post', `/api/v1/workflow/instances/${wfId}/actions`).send({ action });
const code = (r: request.Response) => (r.status < 300 ? 'OK' : (r.body?.error?.code ?? String(r.status)));
const statusOf = (id: string) => prisma.leaveRequest.findUniqueOrThrow({ where: { id }, select: { status: true, units: true, entitlementId: true, workflowInstanceId: true } });
const cached = (entId: string) => prisma.leaveEntitlement.findUniqueOrThrow({ where: { id: entId } });
const rows = (requestId: string, type?: string) => prisma.leaveLedger.findMany({ where: { referenceId: requestId, ...(type ? { entryType: type } : {}) } });
async function reconciled(entId: string) { const r = await balanceService.reconcile(prisma, entId); expect(r.matches, JSON.stringify(r)).toBe(true); }
async function newDraft(s: Session, b: Body) { const d = await draft(s, b); expect(d.status, JSON.stringify(d.body)).toBe(201); return d.body.data.id as string; }
async function submittedOne(s: Session, b: Body) { const id = await newDraft(s, b); const r = await submit(s, id); expect(r.status, JSON.stringify(r.body)).toBe(200); return r.body.data as { id: string; workflowInstanceId: string; units: number; entitlementId: string }; }
let day = 0;
const nextDay = () => f.wd(++day + 3);

beforeAll(async () => { f = await setupLeaveFixture(app); }, 60000);
afterAll(async () => { await prisma.$disconnect(); });

describe('leave request concurrency (PostgreSQL row locks)', () => {
  it('77. concurrent submit of the SAME draft → one reservation, one workflow instance, both callers see the same state (3 rounds)', async () => {
    for (let round = 0; round < 3; round++) {
      const entId = f.ent[`${f.employees.EMP}:ANNUAL`];
      const before = await cached(entId);
      const id = await newDraft(f.s.emp, { leaveTypeId: f.types.ANNUAL, startDate: nextDay() });
      const res = await Promise.all([submit(f.s.emp, id), submit(f.s.emp, id)]);
      expect(res.map(code), `round ${round}`).toEqual(['OK', 'OK']);
      expect(res.map((r) => r.body.data.status)).toEqual(['PENDING', 'PENDING']);
      expect(new Set(res.map((r) => r.body.data.workflowInstanceId)).size).toBe(1);
      expect(await rows(id, 'RESERVE')).toHaveLength(1);
      expect(await prisma.workflowInstance.count({ where: { entityId: id } })).toBe(1);
      expect(await prisma.auditLog.count({ where: { recordId: id, action: 'SUBMIT_LEAVE_REQUEST' } })).toBe(1);
      expect((await cached(entId)).reserved).toBe(before.reserved + 1);
      await reconciled(entId);
      expect((await cancel(f.s.emp, id)).status).toBe(200);
    }
  });

  it('78. concurrent overlapping submits of DIFFERENT leave types (different entitlement rows) → exactly one succeeds, thanks to the employee row lock (3 rounds)', async () => {
    for (let round = 0; round < 3; round++) {
      const date = nextDay();
      const annualEnt = f.ent[`${f.employees.EMP}:ANNUAL`], sickEnt = f.ent[`${f.employees.EMP}:SICK`];
      const a = await newDraft(f.s.emp, { leaveTypeId: f.types.ANNUAL, startDate: date });
      const b = await newDraft(f.s.emp, { leaveTypeId: f.types.SICK, startDate: date, attachmentRef: 'doc' });
      const res = await Promise.all([submit(f.s.emp, a), submit(f.s.emp, b)]);
      expect(res.map(code).sort(), `round ${round}: ${JSON.stringify(res.map((r) => r.body?.error ?? r.body.data.status))}`).toEqual(['LEAVE_REQUEST_OVERLAP', 'OK']);
      const [sa, sb] = await Promise.all([statusOf(a), statusOf(b)]);
      expect([sa.status, sb.status].filter((s) => s === 'PENDING')).toHaveLength(1);
      expect([sa.status, sb.status].filter((s) => s === 'DRAFT')).toHaveLength(1);
      expect((await rows(a, 'RESERVE')).length + (await rows(b, 'RESERVE')).length).toBe(1);
      await reconciled(annualEnt); await reconciled(sickEnt);
      for (const id of [a, b]) if ((await statusOf(id)).status === 'PENDING') expect((await cancel(f.s.emp, id)).status).toBe(200);
    }
  });

  it('79. final approve vs requester cancel → exactly one terminal outcome, ledger and audit agree (5 rounds)', async () => {
    const outcomes: string[] = [];
    for (let round = 0; round < 5; round++) {
      const entId = f.ent[`${f.employees.EMP}:ANNUAL`];
      const before = await cached(entId);
      const r = await submittedOne(f.s.emp, { leaveTypeId: f.types.ANNUAL, startDate: nextDay() });
      const [approve, cancelRes] = await Promise.all([act(f.s.mgr, r.workflowInstanceId, 'APPROVE'), cancel(f.s.emp, r.id)]);
      const approved = approve.status === 200, cancelled = cancelRes.status === 200;
      expect(approved !== cancelled, `round ${round}: approve=${code(approve)} cancel=${code(cancelRes)}`).toBe(true);
      const s = await statusOf(r.id);
      const after = await cached(entId);
      if (approved) {
        expect(s.status).toBe('APPROVED');
        expect(code(cancelRes)).toBe('LEAVE_REQUEST_NOT_CANCELLABLE');
        expect(after.reserved).toBe(before.reserved);
        expect(after.used).toBe(before.used + r.units);
        expect((await rows(r.id)).map((x) => x.entryType).sort()).toEqual(['RELEASE', 'RESERVE', 'USE']);
        expect(await prisma.auditLog.count({ where: { recordId: r.id, action: 'APPROVE_LEAVE_REQUEST' } })).toBe(1);
        expect(await prisma.auditLog.count({ where: { recordId: r.id, action: 'CANCEL_LEAVE_REQUEST' } })).toBe(0);
      } else {
        expect(s.status).toBe('CANCELLED');
        expect(code(approve)).toBe('WORKFLOW_NOT_PENDING');
        expect(after.reserved).toBe(before.reserved);
        expect(after.used).toBe(before.used);
        expect((await rows(r.id)).map((x) => x.entryType).sort()).toEqual(['RELEASE', 'RESERVE']);
        expect(await prisma.auditLog.count({ where: { recordId: r.id, action: 'CANCEL_LEAVE_REQUEST' } })).toBe(1);
        expect(await prisma.auditLog.count({ where: { recordId: r.id, action: 'APPROVE_LEAVE_REQUEST' } })).toBe(0);
      }
      const wf = await prisma.workflowInstance.findUniqueOrThrow({ where: { id: r.workflowInstanceId }, include: { actions: true } });
      expect(wf.status).toBe(approved ? 'APPROVED' : 'CANCELLED');
      expect(wf.actions.filter((x) => x.action !== 'SUBMIT')).toHaveLength(1);
      await reconciled(entId);
      outcomes.push(s.status);
    }
    expect(outcomes.length).toBe(5);
  });

  it('80. concurrent duplicate final approve → one transition, one RELEASE + one USE (3 rounds)', async () => {
    for (let round = 0; round < 3; round++) {
      const entId = f.ent[`${f.employees.EMP}:ANNUAL`];
      const before = await cached(entId);
      const r = await submittedOne(f.s.emp, { leaveTypeId: f.types.ANNUAL, startDate: nextDay() });
      const res = await Promise.all([act(f.s.mgr, r.workflowInstanceId, 'APPROVE'), act(f.s.mgr, r.workflowInstanceId, 'APPROVE')]);
      expect(res.map(code).sort(), `round ${round}`).toEqual(['OK', 'WORKFLOW_NOT_PENDING']);
      expect((await statusOf(r.id)).status).toBe('APPROVED');
      expect(await rows(r.id, 'RELEASE')).toHaveLength(1);
      expect(await rows(r.id, 'USE')).toHaveLength(1);
      expect(await prisma.auditLog.count({ where: { recordId: r.id, action: 'APPROVE_LEAVE_REQUEST' } })).toBe(1);
      const after = await cached(entId);
      expect(after).toMatchObject({ reserved: before.reserved, used: before.used + r.units });
      await reconciled(entId);
    }
  });

  it('80b. concurrent approve vs reject of the same step → one terminal outcome, balance matches it', async () => {
    const entId = f.ent[`${f.employees.EMP2}:ANNUAL`];
    const before = await cached(entId);
    const r = await submittedOne(f.s.emp2, { leaveTypeId: f.types.ANNUAL, startDate: nextDay() });
    const res = await Promise.all([act(f.s.mgr, r.workflowInstanceId, 'APPROVE'), act(f.s.mgr, r.workflowInstanceId, 'REJECT')]);
    expect(res.map(code).sort()).toEqual(['OK', 'WORKFLOW_NOT_PENDING']);
    const s = await statusOf(r.id);
    expect(['APPROVED', 'REJECTED']).toContain(s.status);
    const after = await cached(entId);
    expect(after.reserved).toBe(before.reserved);
    expect(after.used).toBe(s.status === 'APPROVED' ? before.used + r.units : before.used);
    expect(await rows(r.id, 'RELEASE')).toHaveLength(1);
    expect(await rows(r.id, 'USE')).toHaveLength(s.status === 'APPROVED' ? 1 : 0);
    await reconciled(entId);
  });

  it('81. different employees submit concurrently → both succeed (no global serialization)', async () => {
    const date = nextDay();
    const a = await newDraft(f.s.emp, { leaveTypeId: f.types.ANNUAL, startDate: date });
    const b = await newDraft(f.s.emp2, { leaveTypeId: f.types.ANNUAL, startDate: date });
    const res = await Promise.all([submit(f.s.emp, a), submit(f.s.emp2, b)]);
    expect(res.map(code)).toEqual(['OK', 'OK']);
    expect((await statusOf(a)).status).toBe('PENDING'); expect((await statusOf(b)).status).toBe('PENDING');
    await reconciled(f.ent[`${f.employees.EMP}:ANNUAL`]); await reconciled(f.ent[`${f.employees.EMP2}:ANNUAL`]);
    await Promise.all([cancel(f.s.emp, a), cancel(f.s.emp2, b)]);
  });

  it('81b. employee row lock does not block a DIFFERENT employee: 4 employees submit at once, all succeed', async () => {
    const date = nextDay();
    const specs: [Session, string][] = [[f.s.emp, f.types.ANNUAL], [f.s.emp2, f.types.ANNUAL], [f.s.other, f.types.ANNUAL], [f.s.trans, f.types.ANNUAL]];
    const ids = await Promise.all(specs.map(([s, t]) => newDraft(s, { leaveTypeId: t, startDate: date })));
    const res = await Promise.all(ids.map((id, i) => submit(specs[i][0], id)));
    expect(res.map(code)).toEqual(['OK', 'OK', 'OK', 'OK']);
    await Promise.all(ids.map((id, i) => cancel(specs[i][0], id)));
  });
});
