/**
 * Task 13 — notification foundation (checklist 1–39, 46).
 * The inbox is the signed-in user's own data: no permission code, no data scope, and nobody can read another user's
 * notifications. Publishing is idempotent per (userId, dedupeKey) and commits with the business transaction.
 */
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { NOTIFICATION_TYPES } from '@hr/shared';
import { prisma } from '../src/lib/prisma';
import { notificationService } from '../src/services/notification';
import { auditService } from '../src/services/audit/audit.service';
import { createTestServer } from './helpers';
import { setupLeaveFixture, type LeaveFixture, type Session } from './leave-fixture';

const app = createTestServer();
let f: LeaveFixture;
type Body = { leaveTypeId: string; startDate: string; endDate?: string; startPart?: 'FULL' | 'PM'; endPart?: 'FULL' | 'AM'; reason?: string | null; attachmentRef?: string | null };
const list = (s: Session, q = '') => f.as(s, 'get', `/api/v1/notifications${q}`);
const unread = (s: Session) => f.as(s, 'get', '/api/v1/notifications/unread-count');
const markRead = (s: Session, id: string) => f.as(s, 'post', `/api/v1/notifications/${id}/read`);
const readAll = (s: Session) => f.as(s, 'post', '/api/v1/notifications/read-all');
const act = (s: Session, wfId: string, action: 'APPROVE' | 'REJECT', comment?: string) => f.as(s, 'post', `/api/v1/workflow/instances/${wfId}/actions`).send({ action, comment });
const err = (r: request.Response) => `${r.status} ${r.body?.error?.code ?? ''}`.trim();
const types = (r: request.Response) => (r.body.data as { type: string }[]).map((n) => n.type);
async function submitted(s: Session, b: Body) {
  const d = await f.as(s, 'post', '/api/v1/leave/requests').send({ endDate: b.startDate, ...b });
  if (d.status !== 201) throw new Error(`draft ${d.status} ${JSON.stringify(d.body)}`);
  const r = await f.as(s, 'post', `/api/v1/leave/requests/${d.body.data.id}/submit`);
  if (r.status !== 200) throw new Error(`submit ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.data as { id: string; status: string; workflowInstanceId: string; units: number };
}
/** Notifications of one user for one leave request, from the database (not through the API). */
const forRequest = (userId: string, requestId: string) => prisma.notification.findMany({ where: { userId, sourceEntityId: requestId }, orderBy: { createdAt: 'asc' } });
const deliveries = (notificationId: string) => prisma.notificationDelivery.findMany({ where: { notificationId } });
const userOf = (s: Session) => s.user.id;
let day = 0;
const nextDay = () => f.wd(++day + 2);

beforeAll(async () => { f = await setupLeaveFixture(app); }, 60000);
afterAll(async () => { await prisma.$disconnect(); });

describe('inbox security (the caller\'s own data only)', () => {
  let empNotificationId: string;
  it('1. unauthenticated → 401; 2/3. a user sees only their own notifications', async () => {
    expect((await request(app).get('/api/v1/notifications')).status).toBe(401);
    const r = await submitted(f.s.emp, { leaveTypeId: f.types.ANNUAL, startDate: nextDay() });
    const emp = await list(f.s.emp);
    expect(emp.status).toBe(200);
    expect(types(emp)).toContain(NOTIFICATION_TYPES.LEAVE_SUBMITTED);
    expect(emp.body.data.every((n: { source: { entityId: string } }) => n.source.entityId === r.id)).toBe(true);
    empNotificationId = emp.body.data[0].id;
    // MGR got the approval-required notification for the same request; EMP2 got nothing
    expect(types(await list(f.s.mgr))).toContain(NOTIFICATION_TYPES.APPROVAL_REQUIRED);
    expect((await list(f.s.emp2)).body.data).toHaveLength(0);
    // an ALL-scope user (HR_ADMIN) sees only their own inbox, not EMP's
    const hradmin = await list(f.s.hradmin);
    expect(hradmin.body.data).toHaveLength(0);
  });
  it('4/5. SYSTEM_ADMIN cannot read another user\'s notification — 404, never 403 (no existence leak)', async () => {
    expect((await list(f.s.admin)).body.data).toHaveLength(0);
    expect(err(await markRead(f.s.admin, empNotificationId))).toBe('404 NOTIFICATION_NOT_FOUND');
    expect(err(await markRead(f.s.hradmin, empNotificationId))).toBe('404 NOTIFICATION_NOT_FOUND');
    expect(err(await markRead(f.s.emp, 'no-such-id'))).toBe('404 NOTIFICATION_NOT_FOUND');
    expect((await prisma.notification.findUniqueOrThrow({ where: { id: empNotificationId } })).readAt).toBeNull(); // untouched
  });
  it('6. unread count is per user; 7. newest first; 8. pagination; 9/10. unread and read filters', async () => {
    expect((await unread(f.s.admin)).body.data.count).toBe(0);
    const before = (await unread(f.s.emp)).body.data.count;
    expect(before).toBeGreaterThan(0);
    await submitted(f.s.emp, { leaveTypeId: f.types.ANNUAL, startDate: nextDay() });
    expect((await unread(f.s.emp)).body.data.count).toBe(before + 1);
    const all = await list(f.s.emp, '?pageSize=50');
    const dates = (all.body.data as { createdAt: string }[]).map((n) => n.createdAt);
    expect([...dates].sort().reverse()).toEqual(dates);
    const page = await list(f.s.emp, '?page=1&pageSize=1');
    expect(page.body.data).toHaveLength(1);
    expect(page.body.meta).toMatchObject({ page: 1, pageSize: 1, total: all.body.meta.total });
    expect((await list(f.s.emp, '?status=unread')).body.data.every((n: { readAt: null }) => n.readAt === null)).toBe(true);
    expect((await list(f.s.emp, '?status=read')).body.data).toHaveLength(0);
    expect(types(await list(f.s.emp, `?type=${NOTIFICATION_TYPES.LEAVE_SUBMITTED}`)).filter((t) => t !== NOTIFICATION_TYPES.LEAVE_SUBMITTED)).toHaveLength(0);
  });
});

describe('read state', () => {
  it('11/12/13. mark read is idempotent and keeps the first timestamp; 16. unread count follows', async () => {
    const target = (await list(f.s.emp, '?status=unread&pageSize=1')).body.data[0];
    const before = (await unread(f.s.emp)).body.data.count;
    const first = await markRead(f.s.emp, target.id);
    expect(first.status).toBe(200);
    expect(first.body.data.readAt).toEqual(expect.any(String));
    expect((await unread(f.s.emp)).body.data.count).toBe(before - 1);
    const again = await markRead(f.s.emp, target.id);
    expect(again.body.data.readAt).toBe(first.body.data.readAt); // first-read timestamp preserved
    expect((await unread(f.s.emp)).body.data.count).toBe(before - 1);
  });
  it('14/15. read-all touches only my unread notifications and preserves earlier timestamps', async () => {
    const alreadyRead = (await list(f.s.emp, '?status=read&pageSize=1')).body.data[0];
    const mgrUnreadBefore = (await unread(f.s.mgr)).body.data.count;
    expect(mgrUnreadBefore).toBeGreaterThan(0);
    const res = await readAll(f.s.emp);
    expect(res.status).toBe(200);
    expect(res.body.data.updated).toBeGreaterThan(0);
    expect((await unread(f.s.emp)).body.data.count).toBe(0);
    expect((await prisma.notification.findUniqueOrThrow({ where: { id: alreadyRead.id } })).readAt?.toISOString()).toBe(alreadyRead.readAt);
    expect((await unread(f.s.mgr)).body.data.count).toBe(mgrUnreadBefore); // another user's inbox untouched
    expect((await readAll(f.s.emp)).body.data.updated).toBe(0); // idempotent
  });
});

describe('idempotency and delivery outbox', () => {
  it('17. same dedupe key + same event → one notification; 37/38. exactly one IN_APP delivery, 39. no external channel rows', async () => {
    const userId = userOf(f.s.emp2);
    const input = { userId, type: NOTIFICATION_TYPES.LEAVE_APPROVED, source: { module: 'leave', entityType: 'LEAVE_REQUEST', entityId: 'req-dedupe' }, data: { leaveRequestId: 'req-dedupe' }, dedupeKey: 'leave:req-dedupe:approved' };
    const vars = { leaveType: 'Annual', dateRange: '2026-01-01' };
    const a = await prisma.$transaction((tx) => notificationService.publish(input, vars, tx));
    const b = await prisma.$transaction((tx) => notificationService.publish(input, vars, tx));
    expect(a).toBe(b);
    expect(await prisma.notification.count({ where: { userId, dedupeKey: input.dedupeKey } })).toBe(1);
    const rows = await deliveries(a!);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ channel: 'IN_APP', status: 'SENT', attempts: 1 });
    expect(rows[0].sentAt).toBeTruthy();
    expect(await prisma.notificationDelivery.count({ where: { channel: { not: 'IN_APP' } } })).toBe(0);
  });
  it('18. same key, different event → NOTIFICATION_DEDUPE_CONFLICT (never a silent replay)', async () => {
    const userId = userOf(f.s.emp2);
    const conflicting = { userId, type: NOTIFICATION_TYPES.LEAVE_REJECTED, source: { module: 'leave', entityType: 'LEAVE_REQUEST', entityId: 'other-request' }, dedupeKey: 'leave:req-dedupe:approved' };
    await expect(prisma.$transaction((tx) => notificationService.publish(conflicting, { leaveType: 'Annual' }, tx))).rejects.toMatchObject({ code: 'NOTIFICATION_DEDUPE_CONFLICT' });
    expect(await prisma.notification.count({ where: { userId, dedupeKey: 'leave:req-dedupe:approved' } })).toBe(1);
  });
  it('19. concurrent publish of the same key → exactly one notification and one delivery (PostgreSQL unique index)', async () => {
    const userId = userOf(f.s.other);
    const input = { userId, type: NOTIFICATION_TYPES.LEAVE_APPROVED, source: { module: 'leave', entityType: 'LEAVE_REQUEST', entityId: 'race-req' }, dedupeKey: 'leave:race-req:approved' };
    const vars = { leaveType: 'Annual', dateRange: '2026-02-02' };
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => prisma.$transaction((tx) => notificationService.publish(input, vars, tx))));
    const ok = results.filter((r) => r.status === 'fulfilled') as PromiseFulfilledResult<string | null>[];
    expect(ok.length).toBeGreaterThan(0);
    expect(new Set(ok.map((r) => r.value)).size).toBe(1);
    expect(await prisma.notification.count({ where: { userId, dedupeKey: input.dedupeKey } })).toBe(1);
    expect(await deliveries(ok[0].value!)).toHaveLength(1);
  });
  it('36. missing or inactive recipient → skipped, never an error', async () => {
    expect(await prisma.$transaction((tx) => notificationService.publish({ userId: null, type: NOTIFICATION_TYPES.LEAVE_APPROVED, dedupeKey: 'k1' }, {}, tx))).toBeNull();
    expect(await prisma.$transaction((tx) => notificationService.publish({ userId: 'ghost-user', type: NOTIFICATION_TYPES.LEAVE_APPROVED, dedupeKey: 'k2' }, {}, tx))).toBeNull();
    const inactive = await prisma.user.create({ data: { email: 'inactive@lv.local', passwordHash: 'x', isActive: false } });
    expect(await prisma.$transaction((tx) => notificationService.publish({ userId: inactive.id, type: NOTIFICATION_TYPES.LEAVE_APPROVED, dedupeKey: 'k3' }, {}, tx))).toBeNull();
    expect(await prisma.notification.count({ where: { userId: inactive.id } })).toBe(0);
  });
});

describe('leave event mapping', () => {
  it('20/21/22. submit → requester LEAVE_SUBMITTED + current approver APPROVAL_REQUIRED; a future WAITING approver gets nothing', async () => {
    const r = await submitted(f.s.emp, { leaveTypeId: f.types.LONG, startDate: nextDay() }); // two-step workflow: MGR then HEAD
    expect((await forRequest(userOf(f.s.emp), r.id)).map((n) => n.type)).toEqual([NOTIFICATION_TYPES.LEAVE_SUBMITTED]);
    expect((await forRequest(userOf(f.s.mgr), r.id)).map((n) => n.type)).toEqual([NOTIFICATION_TYPES.APPROVAL_REQUIRED]);
    expect(await forRequest(userOf(f.s.head), r.id)).toHaveLength(0); // step 2 is WAITING, not pending
  });
  it('23/24. intermediate approve notifies the NEXT approver only (no duplicate for the approver who acted, none for the requester)', async () => {
    const r = await submitted(f.s.emp, { leaveTypeId: f.types.LONG, startDate: nextDay() });
    const requesterBefore = (await forRequest(userOf(f.s.emp), r.id)).length;
    expect((await act(f.s.mgr, r.workflowInstanceId, 'APPROVE')).status).toBe(200);
    expect((await forRequest(userOf(f.s.head), r.id)).map((n) => n.type)).toEqual([NOTIFICATION_TYPES.APPROVAL_REQUIRED]);
    expect((await forRequest(userOf(f.s.mgr), r.id)).map((n) => n.type)).toEqual([NOTIFICATION_TYPES.APPROVAL_REQUIRED]); // still exactly one
    expect(await forRequest(userOf(f.s.emp), r.id)).toHaveLength(requesterBefore); // requester is not told about each step
    // 25. final approve → requester LEAVE_APPROVED
    expect((await act(f.s.head, r.workflowInstanceId, 'APPROVE')).status).toBe(200);
    expect((await forRequest(userOf(f.s.emp), r.id)).map((n) => n.type)).toEqual([NOTIFICATION_TYPES.LEAVE_SUBMITTED, NOTIFICATION_TYPES.LEAVE_APPROVED]);
    expect(await forRequest(userOf(f.s.head), r.id)).toHaveLength(1); // the approver is not notified about their own decision
  });
  it('26/27. reject → requester LEAVE_REJECTED and the comment is never copied into the notification', async () => {
    const r = await submitted(f.s.emp, { leaveTypeId: f.types.ANNUAL, startDate: nextDay() });
    expect((await act(f.s.mgr, r.workflowInstanceId, 'REJECT', 'Sensitive internal reason: headcount')).status).toBe(200);
    const notes = await forRequest(userOf(f.s.emp), r.id);
    expect(notes.map((n) => n.type)).toEqual([NOTIFICATION_TYPES.LEAVE_SUBMITTED, NOTIFICATION_TYPES.LEAVE_REJECTED]);
    expect(JSON.stringify(notes)).not.toMatch(/headcount|Sensitive/);
  });
  it('28. auto-approved submit → only the final outcome (no LEAVE_SUBMITTED, no APPROVAL_REQUIRED)', async () => {
    const r = await submitted(f.s.loner, { leaveTypeId: f.types.AUTO, startDate: nextDay() }); // every step skipped
    expect(r.status).toBe('APPROVED');
    expect((await forRequest(userOf(f.s.loner), r.id)).map((n) => n.type)).toEqual([NOTIFICATION_TYPES.LEAVE_APPROVED]);
    expect(await prisma.notification.count({ where: { sourceEntityId: r.id, type: NOTIFICATION_TYPES.APPROVAL_REQUIRED } })).toBe(0);
  });
  it('20b. cancelling my own request creates no notification for me (I performed the action)', async () => {
    const r = await submitted(f.s.emp2, { leaveTypeId: f.types.ANNUAL, startDate: nextDay() });
    const before = (await forRequest(userOf(f.s.emp2), r.id)).length;
    expect((await f.as(f.s.emp2, 'post', `/api/v1/leave/requests/${r.id}/cancel`)).status).toBe(200);
    expect(await forRequest(userOf(f.s.emp2), r.id)).toHaveLength(before);
    // the approver's earlier APPROVAL_REQUIRED stays as history — notifications are never deleted
    expect((await forRequest(userOf(f.s.mgr), r.id)).map((n) => n.type)).toEqual([NOTIFICATION_TYPES.APPROVAL_REQUIRED]);
  });
  it('29. the approver is the workflow SNAPSHOT approver even after the employee\'s manager changes', async () => {
    const r = await submitted(f.s.emp, { leaveTypeId: f.types.ANNUAL, startDate: nextDay() });
    expect((await forRequest(userOf(f.s.mgr), r.id)).map((n) => n.type)).toEqual([NOTIFICATION_TYPES.APPROVAL_REQUIRED]);
    await prisma.employee.update({ where: { id: f.employees.EMP }, data: { managerId: f.employees.HEAD } }); // manager changes afterwards
    try {
      expect((await act(f.s.mgr, r.workflowInstanceId, 'APPROVE')).status).toBe(200); // the snapshot approver still decides
      expect(await forRequest(userOf(f.s.head), r.id)).toHaveLength(0); // the new manager is never notified
    } finally {
      await prisma.employee.update({ where: { id: f.employees.EMP }, data: { managerId: f.employees.MGR } });
    }
  });
});

describe('privacy (30–33)', () => {
  it('notification title/body/data never contain reason, attachment, comment, policy or ledger details', async () => {
    const r = await submitted(f.s.emp, { leaveTypeId: f.types.SICK, startDate: nextDay(), reason: 'private medical detail', attachmentRef: 'MED-SECRET-123' });
    expect((await act(f.s.mgr, r.workflowInstanceId, 'REJECT', 'comment-with-secret')).status).toBe(200);
    const all = await prisma.notification.findMany({ where: { sourceEntityId: r.id } });
    expect(all.length).toBeGreaterThan(0);
    const json = JSON.stringify(all);
    for (const secret of ['private medical detail', 'MED-SECRET-123', 'comment-with-secret']) expect(json).not.toMatch(secret);
    expect(json).not.toMatch(/policyId|entitlementId|reserved|granted|carryForward|allowNegativeBalance/);
    for (const n of all) expect(Object.keys((n.data ?? {}) as object).sort()).toEqual(expect.arrayContaining([]));
    // data holds only ids used for deep-linking
    const keys = new Set(all.flatMap((n) => Object.keys((n.data ?? {}) as Record<string, string>)));
    expect([...keys].sort()).toEqual(['leaveRequestId', 'workflowInstanceId'].filter((k) => keys.has(k)));
  });
});

describe('transaction policy (34–36)', () => {
  it('34. a notification failure during submit rolls the whole submit back (no reservation, no workflow, still DRAFT)', async () => {
    const d = await f.as(f.s.emp, 'post', '/api/v1/leave/requests').send({ leaveTypeId: f.types.ANNUAL, startDate: nextDay(), endDate: f.wd(day + 2) });
    expect(d.status).toBe(201);
    const id = d.body.data.id as string;
    const spy = vi.spyOn(notificationService, 'publish').mockRejectedValueOnce(new Error('notification insert failed'));
    const res = await f.as(f.s.emp, 'post', `/api/v1/leave/requests/${id}/submit`);
    spy.mockRestore();
    expect(res.status).toBe(500);
    const after = await prisma.leaveRequest.findUniqueOrThrow({ where: { id } });
    expect(after).toMatchObject({ status: 'DRAFT', entitlementId: null, workflowInstanceId: null });
    expect(await prisma.leaveLedger.count({ where: { referenceId: id } })).toBe(0);
    expect(await prisma.workflowInstance.count({ where: { entityId: id } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { recordId: id, action: 'SUBMIT_LEAVE_REQUEST' } })).toBe(0);
    expect(await prisma.notification.count({ where: { sourceEntityId: id } })).toBe(0);
    expect((await f.as(f.s.emp, 'post', `/api/v1/leave/requests/${id}/submit`)).status).toBe(200); // works once publishing succeeds
    await f.as(f.s.emp, 'post', `/api/v1/leave/requests/${id}/cancel`);
  });
  it('35. a notification failure during final approval rolls the transition back (workflow, leave and ledger unchanged)', async () => {
    const r = await submitted(f.s.emp, { leaveTypeId: f.types.ANNUAL, startDate: nextDay() });
    const spy = vi.spyOn(notificationService, 'publish').mockRejectedValueOnce(new Error('notification insert failed'));
    expect((await act(f.s.mgr, r.workflowInstanceId, 'APPROVE')).status).toBe(500);
    spy.mockRestore();
    expect((await prisma.workflowInstance.findUniqueOrThrow({ where: { id: r.workflowInstanceId } })).status).toBe('PENDING');
    expect((await prisma.leaveRequest.findUniqueOrThrow({ where: { id: r.id } })).status).toBe('PENDING');
    expect(await prisma.leaveLedger.count({ where: { referenceId: r.id, entryType: 'USE' } })).toBe(0);
    expect(await prisma.notification.count({ where: { sourceEntityId: r.id, type: NOTIFICATION_TYPES.LEAVE_APPROVED } })).toBe(0);
    expect((await act(f.s.mgr, r.workflowInstanceId, 'APPROVE')).status).toBe(200);
    expect((await forRequest(userOf(f.s.emp), r.id)).map((n) => n.type)).toContain(NOTIFICATION_TYPES.LEAVE_APPROVED);
  });
  it('26b. marking read is not audited (UX state, not a business mutation)', async () => {
    const before = await prisma.auditLog.count();
    const n = (await list(f.s.mgr, '?status=unread&pageSize=1')).body.data[0];
    if (n) expect((await markRead(f.s.mgr, n.id)).status).toBe(200);
    await readAll(f.s.mgr);
    expect(await prisma.auditLog.count()).toBe(before);
    expect(auditService.log).toBeTruthy();
  });
});
