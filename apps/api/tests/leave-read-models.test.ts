/**
 * Task 12 — backend read models behind the Leave UI (checklist 1–16):
 *   GET /leave/requests/me   always the caller's own requests (data scope never widens it)
 *   GET /leave/approvals     pending steps where the caller IS the snapshot approver (never data-scope based)
 *   GET /leave/calendar      summary projection of who is away, inside the caller's data scope
 */
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma';
import { createTestServer } from './helpers';
import { setupLeaveFixture, type LeaveFixture, type Session } from './leave-fixture';

const app = createTestServer();
let f: LeaveFixture;
type Body = { leaveTypeId: string; startDate: string; endDate?: string; startPart?: 'FULL' | 'PM'; endPart?: 'FULL' | 'AM'; reason?: string | null; attachmentRef?: string | null };
const err = (r: request.Response) => `${r.status} ${r.body?.error?.code ?? ''}`.trim();
const listMine = (s: Session, q = '') => f.as(s, 'get', `/api/v1/leave/requests/me${q}`);
const approvals = (s: Session, q = '') => f.as(s, 'get', `/api/v1/leave/approvals${q}`);
const calendar = (s: Session, q: string) => f.as(s, 'get', `/api/v1/leave/calendar?${q}`);
const act = (s: Session, wfId: string, action: 'APPROVE' | 'REJECT') => f.as(s, 'post', `/api/v1/workflow/instances/${wfId}/actions`).send({ action });
async function submitted(s: Session, b: Body) {
  const d = await f.as(s, 'post', '/api/v1/leave/requests').send({ endDate: b.startDate, ...b });
  if (d.status !== 201) throw new Error(`draft ${d.status} ${JSON.stringify(d.body)}`);
  const r = await f.as(s, 'post', `/api/v1/leave/requests/${d.body.data.id}/submit`);
  if (r.status !== 200) throw new Error(`submit ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.data as { id: string; workflowInstanceId: string; units: number; startDate: string };
}
const codes = (res: request.Response) => (res.body.data as { employee: { employeeCode: string } }[]).map((x) => x.employee.employeeCode);
const reqCodes = (res: request.Response) => (res.body.data as { request: { employee: { employeeCode: string } } }[]).map((x) => x.request.employee.employeeCode);
let empReq: Awaited<ReturnType<typeof submitted>>, emp2Req: Awaited<ReturnType<typeof submitted>>, otherReq: Awaited<ReturnType<typeof submitted>>, hraReq: Awaited<ReturnType<typeof submitted>>;

beforeAll(async () => {
  f = await setupLeaveFixture(app);
  // EMP (MGR's report), EMP2 (MGR's report), OTHER (HEAD's report, not MGR's), HRA (ALL scope, HEAD's report)
  empReq = await submitted(f.s.emp, { leaveTypeId: f.types.ANNUAL, startDate: f.wd(5), reason: 'private reason', attachmentRef: 'secret-ref' });
  emp2Req = await submitted(f.s.emp2, { leaveTypeId: f.types.ANNUAL, startDate: f.wd(6) });
  otherReq = await submitted(f.s.other, { leaveTypeId: f.types.ANNUAL, startDate: f.wd(7) });
  hraReq = await submitted(f.s.hradmin, { leaveTypeId: f.types.ANNUAL, startDate: f.wd(9) });
  await f.as(f.s.emp, 'post', '/api/v1/leave/requests').send({ leaveTypeId: f.types.ANNUAL, startDate: f.wd(12), endDate: f.wd(12) }); // a draft too
}, 60000);
afterAll(async () => { await prisma.$disconnect(); });

describe('GET /leave/requests/me', () => {
  it('1. SELF, TEAM and ALL callers all see only their own requests', async () => {
    expect([...new Set(codes(await listMine(f.s.emp)))]).toEqual(['EMP']); // SELF
    expect([...new Set(codes(await listMine(f.s.mgr)))]).toEqual([]); // TEAM, no own requests
    const all = await listMine(f.s.hradmin); // ALL scope must NOT widen this endpoint
    expect([...new Set(codes(all))]).toEqual(['HRA']);
    expect(all.body.data.every((r: { employee: { id: string } }) => r.employee.id === f.employees.HRA)).toBe(true);
    expect((await f.as(f.s.noleave, 'get', '/api/v1/leave/requests/me')).status).toBe(403); // needs leave.view
    expect((await request(app).get('/api/v1/leave/requests/me')).status).toBe(401);
  });
  it('2. a caller without an employee profile gets an empty list (mutations still require the profile)', async () => {
    const r = await listMine(f.s.hr); // HR user has leave.view + leave.request but no employee
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ data: [], meta: { total: 0 } });
    expect(err(await f.as(f.s.hr, 'post', '/api/v1/leave/requests').send({ leaveTypeId: f.types.ANNUAL, startDate: f.wd(5), endDate: f.wd(5) }))).toBe('403 EMPLOYEE_PROFILE_REQUIRED');
  });
  it('3. filters (status, leaveType, from/to) and pagination', async () => {
    const pending = await listMine(f.s.emp, '?status=PENDING');
    expect(pending.body.data.every((r: { status: string }) => r.status === 'PENDING')).toBe(true);
    expect((await listMine(f.s.emp, '?status=DRAFT')).body.data.every((r: { status: string }) => r.status === 'DRAFT')).toBe(true);
    expect((await listMine(f.s.emp, `?leaveTypeId=${f.types.SICK}`)).body.data).toHaveLength(0);
    expect((await listMine(f.s.emp, `?from=${f.wd(11)}`)).body.data.map((r: { startDate: string }) => r.startDate)).toEqual([f.wd(12)]);
    expect((await listMine(f.s.emp, `?to=${f.wd(5)}`)).body.data.map((r: { startDate: string }) => r.startDate)).toEqual([f.wd(5)]);
    const page = await listMine(f.s.emp, '?page=1&pageSize=1');
    expect(page.body.data).toHaveLength(1);
    expect(page.body.meta).toMatchObject({ page: 1, pageSize: 1, total: 2 });
  });
});

describe('GET /leave/approvals', () => {
  it('4. only the current snapshot approver sees a step; 6. participant data is complete (single batched query)', async () => {
    const mine = await approvals(f.s.mgr);
    expect(mine.status).toBe(200);
    expect(reqCodes(mine).sort()).toEqual(['EMP', 'EMP2']); // MGR is DIRECT_MANAGER of both
    const item = mine.body.data.find((i: { request: { id: string } }) => i.request.id === empReq.id);
    expect(item).toMatchObject({ workflowInstanceId: empReq.workflowInstanceId, stepOrder: 1, stepName: 'Manager', submittedAt: expect.any(String) });
    expect(item.request).toMatchObject({ units: 1, status: 'PENDING', startDate: f.wd(5), startPart: 'FULL', endPart: 'FULL', leaveType: { code: 'ANNUAL' }, employee: { employeeCode: 'EMP', department: { name: 'Ops' }, position: { title: expect.any(String) } } });
    expect(Object.keys(item.request)).not.toContain('reason'); // decision data only, no free-text payload in the inbox list
    expect(JSON.stringify(item)).not.toMatch(/secret-ref|private reason/);
    expect((await approvals(f.s.emp)).status).toBe(403); // no workflow.approve
    expect((await request(app).get('/api/v1/leave/approvals')).status).toBe(401);
  });
  it('5. ALL data scope / workflow.view_all do not turn the inbox into everyone\'s approvals', async () => {
    const hradmin = await approvals(f.s.hradmin); // ALL scope + workflow.approve + workflow.view_all
    expect(hradmin.status).toBe(200);
    expect(hradmin.body.data).toHaveLength(0); // HRA is nobody's snapshot approver
    const head = await approvals(f.s.head); // HEAD is DIRECT_MANAGER of OTHER and HRA only
    expect(reqCodes(head).sort()).toEqual(['HRA', 'OTHER']);
    expect(head.body.data.map((i: { request: { id: string } }) => i.request.id)).not.toContain(empReq.id);
  });
  it('7. pagination + filters; 8. a completed step disappears from the inbox', async () => {
    const page = await approvals(f.s.mgr, '?page=1&pageSize=1');
    expect(page.body.data).toHaveLength(1); expect(page.body.meta).toMatchObject({ page: 1, pageSize: 1, total: 2 });
    expect((await approvals(f.s.mgr, `?leaveTypeId=${f.types.SICK}`)).body.data).toHaveLength(0);
    expect((await approvals(f.s.mgr, `?from=${f.wd(6)}`)).body.data.map((i: { request: { id: string } }) => i.request.id)).toEqual([emp2Req.id]);
    expect((await act(f.s.mgr, empReq.workflowInstanceId, 'APPROVE')).status).toBe(200);
    const after = await approvals(f.s.mgr);
    expect(after.body.data.map((i: { request: { id: string } }) => i.request.id)).toEqual([emp2Req.id]);
    expect(after.body.meta.total).toBe(1);
    // a cancelled request also leaves the inbox
    expect((await f.as(f.s.emp2, 'post', `/api/v1/leave/requests/${emp2Req.id}/cancel`)).status).toBe(200);
    expect((await approvals(f.s.mgr)).body.data).toHaveLength(0);
  });
  it('8b. a two-step workflow only shows the step that is currently pending for me', async () => {
    const two = await submitted(f.s.emp, { leaveTypeId: f.types.LONG, startDate: f.wd(14) });
    expect((await approvals(f.s.mgr)).body.data.map((i: { request: { id: string } }) => i.request.id)).toEqual([two.id]);
    expect((await approvals(f.s.head)).body.data.map((i: { request: { id: string } }) => i.request.id)).not.toContain(two.id); // step 2 is WAITING
    expect((await act(f.s.mgr, two.workflowInstanceId, 'APPROVE')).status).toBe(200);
    expect((await approvals(f.s.mgr)).body.data).toHaveLength(0);
    expect((await approvals(f.s.head)).body.data.map((i: { request: { id: string } }) => i.request.id)).toContain(two.id); // now pending for HEAD
    await f.as(f.s.emp, 'post', `/api/v1/leave/requests/${two.id}/cancel`);
  });
});

describe('GET /leave/calendar', () => {
  it('9/10/11/12. scope: SELF sees own, TEAM sees self + direct reports only, ALL sees everyone', async () => {
    const q = `from=${f.wd(1)}&to=${f.wd(30)}`;
    expect([...new Set(codes(await calendar(f.s.emp, q)))]).toEqual(['EMP']); // SELF
    const team = [...new Set(codes(await calendar(f.s.mgr, q)))].sort(); // TEAM: EMP + EMP2 are direct reports; OTHER/HRA are not
    expect(team).toEqual(expect.arrayContaining(['EMP']));
    expect(team).not.toContain('OTHER'); expect(team).not.toContain('HRA'); expect(team).not.toContain('LONER');
    const all = [...new Set(codes(await calendar(f.s.hradmin, q)))];
    expect(all).toEqual(expect.arrayContaining(['EMP', 'OTHER', 'HRA']));
    expect((await request(app).get(`/api/v1/leave/calendar?${q}`)).status).toBe(401);
    expect((await calendar(f.s.noleave, q)).status).toBe(403);
  });
  it('13. date range is required and filters; 16. no out-of-range records', async () => {
    expect((await f.as(f.s.emp, 'get', '/api/v1/leave/calendar')).status).toBe(400); // from/to required
    expect((await calendar(f.s.emp, `from=${f.wd(30)}&to=${f.wd(1)}`)).status).toBe(400); // from must be <= to
    const narrow = await calendar(f.s.hradmin, `from=${f.wd(7)}&to=${f.wd(7)}`);
    expect(narrow.body.data.map((e: { requestId: string }) => e.requestId)).toEqual([otherReq.id]);
    const all = await calendar(f.s.hradmin, `from=${f.wd(1)}&to=${f.wd(30)}`);
    expect(all.body.data.every((e: { startDate: string; endDate: string }) => e.startDate <= f.wd(30) && e.endDate >= f.wd(1))).toBe(true);
  });
  it('14. status filter (default = PENDING + APPROVED, drafts never appear); department/leaveType/search filters', async () => {
    const q = `from=${f.wd(1)}&to=${f.wd(30)}`;
    const def = await calendar(f.s.hradmin, q);
    expect([...new Set(def.body.data.map((e: { status: string }) => e.status))].sort()).toEqual(['APPROVED', 'PENDING']);
    expect(def.body.data.map((e: { requestId: string }) => e.requestId)).toContain(empReq.id); // approved in the test above
    expect((await calendar(f.s.hradmin, `${q}&status=APPROVED`)).body.data.every((e: { status: string }) => e.status === 'APPROVED')).toBe(true);
    expect((await calendar(f.s.hradmin, `${q}&status=DRAFT`)).status).toBe(400); // drafts are not absences and are never exposed to the team calendar
    expect((await calendar(f.s.hradmin, `${q}&leaveTypeId=${f.types.SICK}`)).body.data).toHaveLength(0);
    expect([...new Set(codes(await calendar(f.s.hradmin, `${q}&departmentId=${f.deptA.id}`)))]).not.toContain('HRA'); // HRA sits in Finance
    expect([...new Set(codes(await calendar(f.s.hradmin, `${q}&search=other`)))]).toEqual(['OTHER']);
  });
  it('15. summary DTO only: no reason, attachmentRef, policy, ledger or workflow comments', async () => {
    const r = await calendar(f.s.hradmin, `from=${f.wd(1)}&to=${f.wd(30)}`);
    const entry = r.body.data.find((e: { requestId: string }) => e.requestId === empReq.id);
    expect(Object.keys(entry).sort()).toEqual(['employee', 'endDate', 'endPart', 'leaveType', 'requestId', 'startDate', 'startPart', 'status', 'units']);
    expect(Object.keys(entry.employee).sort()).toEqual(['department', 'employeeCode', 'firstName', 'id', 'lastName']);
    expect(JSON.stringify(r.body)).not.toMatch(/secret-ref|private reason|policyId|entitlementId|workflowInstanceId|reserved|granted/);
    expect(hraReq.id).toBeTruthy();
  });
});
