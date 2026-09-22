/**
 * Task 11 — leave request lifecycle (DRAFT → PENDING → APPROVED | REJECTED | CANCELLED) over HTTP on PostgreSQL.
 * Numbers in test names follow the approved checklist (1–76, 82–85). Concurrency (77–81) lives in leave-concurrency.test.ts.
 */
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { addDays, weekdayOf } from '@hr/shared';
import { prisma } from '../src/lib/prisma';
import { auditService } from '../src/services/audit/audit.service';
import { workflowEngine } from '../src/services/workflow';
import { balanceService } from '../src/modules/leave/balance.service';
import { leaveWorkflowHandlers } from '../src/modules/leave/leave-request.handlers';
import { createTestServer, createUser, loginAs } from './helpers';
import { PW, setupLeaveFixture, type LeaveFixture, type Session } from './leave-fixture';

const app = createTestServer();
let f: LeaveFixture;
type Body = { leaveTypeId: string; startDate: string; endDate?: string; startPart?: 'FULL' | 'PM'; endPart?: 'FULL' | 'AM'; reason?: string | null; attachmentRef?: string | null };
const body = (b: Body) => ({ endDate: b.startDate, ...b });
const draft = (s: Session, b: Body) => f.as(s, 'post', '/api/v1/leave/requests').send(body(b));
const preview = (s: Session, b: Body) => f.as(s, 'post', '/api/v1/leave/requests/preview').send(body(b));
const submit = (s: Session, id: string) => f.as(s, 'post', `/api/v1/leave/requests/${id}/submit`);
const cancel = (s: Session, id: string) => f.as(s, 'post', `/api/v1/leave/requests/${id}/cancel`);
const get = (s: Session, id: string) => f.as(s, 'get', `/api/v1/leave/requests/${id}`);
const act = (s: Session, wfId: string, action: string, comment?: string) => f.as(s, 'post', `/api/v1/workflow/instances/${wfId}/actions`).send({ action, comment });
/** draft + submit; throws on unexpected status. */
async function submitted(s: Session, b: Body) {
  const d = await draft(s, b); if (d.status !== 201) throw new Error(`draft ${d.status} ${JSON.stringify(d.body)}`);
  const r = await submit(s, d.body.data.id); if (r.status !== 200) throw new Error(`submit ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.data as { id: string; status: string; units: number; workflowInstanceId: string; entitlementId: string; policy: { id: string } };
}
const ledger = (entId: string, type?: string) => prisma.leaveLedger.findMany({ where: { entitlementId: entId, ...(type ? { entryType: type } : {}) }, orderBy: { createdAt: 'asc' } });
const cached = (entId: string) => prisma.leaveEntitlement.findUniqueOrThrow({ where: { id: entId } });
const available = async (entId: string) => { const c = await cached(entId); return c.granted + c.carriedForward + c.adjustment - c.reserved - c.used; };
async function reconciled(entId: string) { const r = await balanceService.reconcile(prisma, entId); expect(r.matches, JSON.stringify(r)).toBe(true); }
const audits = (recordId: string, action: string) => prisma.auditLog.count({ where: { recordType: 'LeaveRequest', recordId, action } });
const err = (r: request.Response) => `${r.status} ${r.body?.error?.code ?? ''}`;
/** working days strictly before today (for backdate tests) */
const pastWorkingDay = () => { let d = f.today; do d = addDays(d, -1); while (['SAT', 'SUN'].includes(weekdayOf(d))); return d; };
let E: LeaveFixture['ent'];

beforeAll(async () => { f = await setupLeaveFixture(app); E = f.ent; }, 60000);
afterAll(async () => { await prisma.$disconnect(); });

describe('A. security / ownership', () => {
  it('1. unauthenticated → 401', async () => { expect((await request(app).get('/api/v1/leave/requests')).status).toBe(401); });
  it('2. without leave.view → read 403; 3. without leave.request → create 403', async () => {
    expect(err(await f.as(f.s.noleave, 'get', '/api/v1/leave/requests'))).toBe('403 FORBIDDEN');
    expect(err(await draft(f.s.noleave, { leaveTypeId: f.types.ANNUAL, startDate: f.wd(10) }))).toBe('403 FORBIDDEN');
  });
  it('4. user without employee profile cannot request (EMPLOYEE_PROFILE_REQUIRED) — create, preview, balances', async () => {
    expect(err(await draft(f.s.hr, { leaveTypeId: f.types.ANNUAL, startDate: f.wd(10) }))).toBe('403 EMPLOYEE_PROFILE_REQUIRED');
    expect(err(await preview(f.s.hr, { leaveTypeId: f.types.ANNUAL, startDate: f.wd(10) }))).toBe('403 EMPLOYEE_PROFILE_REQUIRED');
    expect(err(await f.as(f.s.hr, 'get', '/api/v1/leave/balances/me'))).toBe('403 EMPLOYEE_PROFILE_REQUIRED');
  });
  it('5. employee creates own draft; 6. cannot forge employeeId / units / status / snapshot fields (strict schema → 400)', async () => {
    const r = await draft(f.s.emp, { leaveTypeId: f.types.ANNUAL, startDate: f.wd(10) });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data).toMatchObject({ status: 'DRAFT', units: 1, employee: { id: f.employees.EMP }, entitlementId: null, policy: null, workflowInstanceId: null });
    for (const forged of [{ employeeId: f.employees.EMP2 }, { units: 99 }, { status: 'APPROVED' }, { policyId: 'x' }, { entitlementId: 'x' }, { calendarId: 'x' }, { organizationId: 'x' }, { workflowInstanceId: 'x' }, { submittedAt: new Date().toISOString() }]) {
      const bad = await f.as(f.s.emp, 'post', '/api/v1/leave/requests').send({ leaveTypeId: f.types.ANNUAL, startDate: f.wd(10), endDate: f.wd(10), ...forged });
      expect(bad.status, JSON.stringify(forged)).toBe(400);
      const badPatch = await f.as(f.s.emp, 'patch', `/api/v1/leave/requests/${r.body.data.id}`).send(forged);
      expect(badPatch.status, `patch ${JSON.stringify(forged)}`).toBe(400);
    }
    await cancel(f.s.emp, r.body.data.id);
  });
  it('7. ALL-scope user (HR_ADMIN) cannot create a request for another employee — a draft is always the caller\'s own', async () => {
    expect((await f.as(f.s.hradmin, 'post', '/api/v1/leave/requests').send({ leaveTypeId: f.types.ANNUAL, startDate: f.wd(10), endDate: f.wd(10), employeeId: f.employees.EMP })).status).toBe(400);
    const own = await draft(f.s.hradmin, { leaveTypeId: f.types.ANNUAL, startDate: f.wd(10) });
    expect(own.status).toBe(201); expect(own.body.data.employee.id).toBe(f.employees.HRA);
    await cancel(f.s.hradmin, own.body.data.id);
  });
});

describe('B. draft / preview', () => {
  it('8. preview calculates units (3 working days; PM start → 2.5); 9. no ledger write; 10. no workflow instance', async () => {
    const ledgerBefore = await prisma.leaveLedger.count(); const wfBefore = await prisma.workflowInstance.count();
    const p = await preview(f.s.emp, { leaveTypeId: f.types.ANNUAL, startDate: f.wd(20), endDate: f.wd(22) });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    expect(p.body.data).toMatchObject({ units: 3, entitlement: { id: E[`${f.employees.EMP}:ANNUAL`], available: 10 }, policy: { id: f.policies.annualA, allowNegativeBalance: false }, calendar: { id: f.calA }, remainingAfter: 7, workflow: { code: 'LEAVE_STD' } });
    expect(p.body.data.workingDays).toHaveLength(3);
    expect((await preview(f.s.emp, { leaveTypeId: f.types.ANNUAL, startDate: f.wd(20), endDate: f.wd(22), startPart: 'PM' })).body.data.units).toBe(2.5);
    expect(await prisma.leaveLedger.count()).toBe(ledgerBefore); expect(await prisma.workflowInstance.count()).toBe(wfBefore);
    expect(await prisma.auditLog.count({ where: { module: 'leave', recordType: 'LeaveRequest', action: { in: ['SUBMIT_LEAVE_REQUEST'] } } })).toBe(0);
  });
  it('11. create draft (audit in tx); 12. update draft recalculates units server-side (15); 13. only the owner updates', async () => {
    const d = await draft(f.s.emp, { leaveTypeId: f.types.ANNUAL, startDate: f.wd(20), endDate: f.wd(21), reason: 'trip' });
    expect(d.status).toBe(201); expect(d.body.data.units).toBe(2);
    expect(await audits(d.body.data.id, 'CREATE_LEAVE_REQUEST')).toBe(1);
    const u = await f.as(f.s.emp, 'patch', `/api/v1/leave/requests/${d.body.data.id}`).send({ endDate: f.wd(23), endPart: 'AM' });
    expect(u.status, JSON.stringify(u.body)).toBe(200);
    expect(u.body.data).toMatchObject({ units: 3.5, reason: 'trip', startDate: f.wd(20), endDate: f.wd(23), endPart: 'AM' }); // omitted fields keep their values (no PATCH defaults)
    expect(await audits(d.body.data.id, 'UPDATE_LEAVE_REQUEST')).toBe(1);
    expect(err(await f.as(f.s.emp2, 'patch', `/api/v1/leave/requests/${d.body.data.id}`).send({ reason: 'hijack' }))).toBe('404 LEAVE_REQUEST_NOT_FOUND');
    expect(err(await f.as(f.s.emp2, 'get', `/api/v1/leave/requests/${d.body.data.id}`))).toBe('404 LEAVE_REQUEST_NOT_FOUND');
    await cancel(f.s.emp, d.body.data.id);
  });
});

describe('C. policy rules (request policy = resolved at submit from the employee\'s CURRENT org/type)', () => {
  it('16. request resolves the current organization policy; 17. it may differ from the entitlement grant policy after a transfer', async () => {
    expect((await preview(f.s.trans, { leaveTypeId: f.types.ANNUAL, startDate: f.wd(30) })).body.data.policy.id).toBe(f.policies.annualA);
    const pos = await prisma.position.create({ data: { departmentId: f.deptB.id, code: 'P-TRANS-B', title: 'Trans B' } });
    await prisma.employee.update({ where: { id: f.employees.TRANS }, data: { organizationId: f.orgB.id, departmentId: f.deptB.id, positionId: pos.id } });
    const p = await preview(f.s.trans, { leaveTypeId: f.types.ANNUAL, startDate: f.wd(30) });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    expect(p.body.data.policy).toMatchObject({ id: f.policies.annualB, allowNegativeBalance: true }); expect(p.body.data.calendar.id).toBe(f.calB);
    const r = await submitted(f.s.trans, { leaveTypeId: f.types.ANNUAL, startDate: f.wd(30) });
    expect(r.policy.id).toBe(f.policies.annualB);
    expect((await cached(r.entitlementId)).policyId).toBe(f.policies.annualA); // grant policy untouched
    const detail = await get(f.s.trans, r.id); expect(detail.body.data).toMatchObject({ organizationId: f.orgB.id, calendarId: f.calB });
    await cancel(f.s.trans, r.id);
  });
  it('19. requires reason; 20. requires attachment; 21. half-day disallowed; 22. backdate; 23. minimum notice; 24. max consecutive; 25. zero units', async () => {
    const strict = (b: Partial<Body>) => draft(f.s.emp, { leaveTypeId: f.types.STRICT, startDate: f.wd(5), reason: 'ok', ...b });
    const fail = async (d: request.Response, code: string) => { expect(d.status, JSON.stringify(d.body)).toBe(201); const r = await submit(f.s.emp, d.body.data.id); expect(err(r)).toBe(`409 ${code}`); expect((await get(f.s.emp, d.body.data.id)).body.data.status).toBe('DRAFT'); await cancel(f.s.emp, d.body.data.id); };
    await fail(await strict({ reason: null }), 'LEAVE_REASON_REQUIRED');
    await fail(await draft(f.s.emp, { leaveTypeId: f.types.SICK, startDate: f.wd(5) }), 'LEAVE_ATTACHMENT_REQUIRED');
    await fail(await strict({ startPart: 'PM' }), 'LEAVE_HALF_DAY_NOT_ALLOWED');
    await fail(await strict({ startDate: pastWorkingDay(), endDate: pastWorkingDay() }), 'LEAVE_BACKDATE_NOT_ALLOWED');
    await fail(await strict({ startDate: f.wd(1), endDate: f.wd(1) }), 'LEAVE_NOTICE_NOT_MET');
    await fail(await strict({ startDate: f.wd(5), endDate: f.wd(7) }), 'LEAVE_MAX_CONSECUTIVE_EXCEEDED');
    let sat = f.wd(5); while (weekdayOf(sat) !== 'SAT') sat = addDays(sat, 1);
    const zero = await draft(f.s.emp, { leaveTypeId: f.types.ANNUAL, startDate: sat }); expect(zero.body.data.units).toBe(0);
    expect(err(await submit(f.s.emp, zero.body.data.id))).toBe('409 LEAVE_UNITS_ZERO');
    // the same rules are reported by preview (read-only)
    expect(err(await preview(f.s.emp, { leaveTypeId: f.types.STRICT, startDate: f.wd(1), reason: 'x' }))).toBe('409 LEAVE_NOTICE_NOT_MET');
  });
  it('18. start/end resolving to different policies → LEAVE_CROSSES_POLICY_PERIOD', async () => {
    const X = f.wd(60);
    expect((await f.as(f.s.admin, 'patch', `/api/v1/leave/policies/${f.policies.annualA}`).send({ effectiveTo: X })).status).toBe(200);
    const v2 = await f.as(f.s.admin, 'post', '/api/v1/leave/policies').send({ name: 'Annual A v2', leaveTypeId: f.types.ANNUAL, organizationId: f.orgA.id, annualUnits: 10, effectiveFrom: addDays(X, 1), workflowDefinitionCode: 'LEAVE_STD', allowBackdate: true });
    expect((await f.as(f.s.admin, 'patch', `/api/v1/leave/policies/${v2.body.data.id}/activate`)).status).toBe(200);
    expect(err(await preview(f.s.emp, { leaveTypeId: f.types.ANNUAL, startDate: X, endDate: f.wd(61) }))).toBe('409 LEAVE_CROSSES_POLICY_PERIOD');
    expect((await preview(f.s.emp, { leaveTypeId: f.types.ANNUAL, startDate: f.wd(61), endDate: f.wd(62) })).body.data.policy.id).toBe(v2.body.data.id);
  });
});

describe('D. calendar', () => {
  it('26. default calendar required (WORK_CALENDAR_NOT_CONFIGURED)', async () => {
    const orgC = await prisma.organization.create({ data: { code: 'LC', name: 'No calendar Co' } });
    const dept = await prisma.department.create({ data: { organizationId: orgC.id, code: 'D', name: 'D' } });
    const pos = await prisma.position.create({ data: { departmentId: dept.id, code: 'P-C', title: 'C' } });
    const emp = await prisma.employee.create({ data: { employeeCode: 'NOCAL', firstName: 'No', lastName: 'Cal', email: 'nocal@lv.local', hireDate: new Date('2020-01-01'), organizationId: orgC.id, departmentId: dept.id, positionId: pos.id, employmentType: 'FULL_TIME', employmentStatus: 'ACTIVE' } });
    await createUser({ email: 'nocal@lv.local', password: PW, role: 'EMPLOYEE', employeeId: emp.id });
    const s = await loginAs(app, 'nocal@lv.local', PW);
    expect(err(await draft(s, { leaveTypeId: f.types.ANNUAL, startDate: f.wd(10) }))).toBe('409 WORK_CALENDAR_NOT_CONFIGURED');
  });
  it('27. holiday excluded; 28. non-working days excluded', async () => {
    const from = f.wdRaw(7), to = f.wdRaw(9); // spans the fixture holiday (8th raw working day)
    const expected = (() => { let n = 0; for (let d = from; d <= to; d = addDays(d, 1)) if (!['SAT', 'SUN'].includes(weekdayOf(d)) && d !== f.HOLIDAY) n++; return n; })();
    const p = await preview(f.s.emp, { leaveTypeId: f.types.ANNUAL, startDate: from, endDate: to });
    expect(p.body.data.units).toBe(expected); expect(p.body.data.units).toBe(2); expect(p.body.data.workingDays).not.toContain(f.HOLIDAY);
    let fri = f.wd(10); while (weekdayOf(fri) !== 'FRI') fri = addDays(fri, 1);
    const weekend = await preview(f.s.emp, { leaveTypeId: f.types.ANNUAL, startDate: fri, endDate: addDays(fri, 3) }); // Fri → Mon
    expect(weekend.body.data.units).toBe(2);
  });
  it('29. snapshot calendar stored; 30. later calendar/holiday/assignment changes do not alter stored units (approval uses stored values)', async () => {
    const day = f.wd(24);
    const r = await submitted(f.s.emp2, { leaveTypeId: f.types.ANNUAL, startDate: day });
    expect(r.units).toBe(1); expect((await get(f.s.emp2, r.id)).body.data.calendarId).toBe(f.calA);
    const beforeDept = (await prisma.employee.findUniqueOrThrow({ where: { id: f.employees.EMP2 } })).departmentId;
    try {
      // holiday on that day + a weekend-only default calendar: both only affect NEW requests
      expect((await f.as(f.s.admin, 'post', `/api/v1/calendars/${f.calA}/holidays`).send({ date: day, name: 'Surprise holiday' })).status).toBe(201);
      const cal2 = await f.as(f.s.admin, 'post', '/api/v1/calendars').send({ organizationId: f.orgA.id, code: 'STD-A2', name: 'Weekend-only', workingDays: ['SAT', 'SUN'] });
      expect((await f.as(f.s.admin, 'patch', `/api/v1/calendars/organizations/${f.orgA.id}/default`).send({ calendarId: cal2.body.data.id })).status).toBe(200);
      expect(err(await preview(f.s.emp2, { leaveTypeId: f.types.ANNUAL, startDate: f.wd(25) }))).toBe('409 LEAVE_UNITS_ZERO'); // weekday is no longer a working day for NEW requests
      expect((await get(f.s.emp2, r.id)).body.data).toMatchObject({ units: 1, calendarId: f.calA, departmentId: beforeDept }); // stored request untouched
      expect((await act(f.s.mgr, r.workflowInstanceId, 'APPROVE')).status).toBe(200); // approval uses the stored units
      expect((await get(f.s.emp2, r.id)).body.data).toMatchObject({ status: 'APPROVED', units: 1 });
      expect((await ledger(E[`${f.employees.EMP2}:ANNUAL`], 'USE')).map((l) => l.units)).toEqual([1]);
    } finally {
      // restore shared fixture state even if an assertion above fails, so later tests are not affected
      await f.as(f.s.admin, 'patch', `/api/v1/calendars/organizations/${f.orgA.id}/default`).send({ calendarId: f.calA });
      const h = await prisma.holiday.findFirst({ where: { calendarId: f.calA, date: day } });
      if (h) await f.as(f.s.admin, 'patch', `/api/v1/holidays/${h.id}/deactivate`);
    }
  });
});

describe('E. entitlement selection', () => {
  it('31. entitlement containing the full range is selected', async () => {
    const p = await preview(f.s.emp, { leaveTypeId: f.types.ANNUAL, startDate: f.wd(20), endDate: f.wd(21) });
    expect(p.body.data.entitlement).toMatchObject({ id: E[`${f.employees.EMP}:ANNUAL`], periodStart: f.period.periodStart, periodEnd: f.period.periodEnd });
  });
  it('32. missing entitlement → LEAVE_ENTITLEMENT_NOT_FOUND (draft allowed, submit refused)', async () => {
    const d = await draft(f.s.emp, { leaveTypeId: f.types.NOWF, startDate: f.wd(20) });
    expect(d.status).toBe(201);
    expect(err(await submit(f.s.emp, d.body.data.id))).toBe('409 LEAVE_ENTITLEMENT_NOT_FOUND');
    expect(err(await preview(f.s.emp, { leaveTypeId: f.types.NOWF, startDate: f.wd(20) }))).toBe('409 LEAVE_ENTITLEMENT_NOT_FOUND');
  });
  it('33. request crossing two entitlement periods → LEAVE_CROSSES_ENTITLEMENT_PERIOD', async () => {
    const next = `${f.year + 2}-01-01`;
    expect((await f.as(f.s.admin, 'post', '/api/v1/leave/entitlements').send({ employeeId: f.employees.LONER, leaveTypeId: f.types.ANNUAL, periodStart: next, periodEnd: `${f.year + 2}-12-31` })).status).toBe(201);
    let last = `${f.year + 1}-12-31`; while (['SAT', 'SUN'].includes(weekdayOf(last))) last = addDays(last, -1);
    let first = next; while (['SAT', 'SUN'].includes(weekdayOf(first))) first = addDays(first, 1);
    expect(err(await preview(f.s.loner, { leaveTypeId: f.types.ANNUAL, startDate: last, endDate: first }))).toBe('409 LEAVE_CROSSES_ENTITLEMENT_PERIOD');
  });
  it('34. request policy decides the negative-balance rule (TRANS on org B policy may go negative on the org-A-granted entitlement)', async () => {
    const r = await submitted(f.s.trans, { leaveTypeId: f.types.ANNUAL, startDate: f.wd(30), endDate: f.wd(41) }); // 12 days > 10 available
    expect(r.units).toBe(12);
    expect(await available(E[`${f.employees.TRANS}:ANNUAL`])).toBe(-2);
    await reconciled(E[`${f.employees.TRANS}:ANNUAL`]);
    expect((await cancel(f.s.trans, r.id)).status).toBe(200);
    expect(await available(E[`${f.employees.TRANS}:ANNUAL`])).toBe(10);
  });
  it('35. insufficient balance → INSUFFICIENT_LEAVE_BALANCE (draft stays, nothing reserved)', async () => {
    const d = await draft(f.s.emp2, { leaveTypeId: f.types.ANNUAL, startDate: f.wd(30), endDate: f.wd(40) }); // 11 > 9 available
    expect(err(await submit(f.s.emp2, d.body.data.id))).toBe('409 INSUFFICIENT_LEAVE_BALANCE');
    expect((await get(f.s.emp2, d.body.data.id)).body.data).toMatchObject({ status: 'DRAFT', workflowInstanceId: null, entitlementId: null });
    await reconciled(E[`${f.employees.EMP2}:ANNUAL`]);
  });
  it('36. negative-allowed policy (ADV: 1 granted, request 2) → PENDING with available −1', async () => {
    const r = await submitted(f.s.emp, { leaveTypeId: f.types.ADV, startDate: f.wd(20), endDate: f.wd(21) });
    expect(r.units).toBe(2); expect(await available(E[`${f.employees.EMP}:ADV`])).toBe(-1);
    await cancel(f.s.emp, r.id);
  });
});

describe('F. overlap (half-day aware; PENDING and APPROVED block, DRAFT / REJECTED / CANCELLED do not)', () => {
  const ov = (b: Body) => draft(f.s.emp2, b).then(async (d) => { expect(d.status).toBe(201); const r = await submit(f.s.emp2, d.body.data.id); if (r.status === 200) return r.body.data; return { error: r.body.error.code, id: d.body.data.id }; });
  it('37/47. full vs full (pending) → overlap; 38. full vs AM; 39. full vs PM', async () => {
    const base = await ov({ leaveTypeId: f.types.ANNUAL, startDate: f.wd(12) });
    expect(base.status).toBe('PENDING');
    for (const parts of [{}, { endPart: 'AM' as const }, { startPart: 'PM' as const }]) {
      const r = await ov({ leaveTypeId: f.types.SICK, startDate: f.wd(12), attachmentRef: 'doc-1', ...parts });
      expect(r.error, JSON.stringify(parts)).toBe('LEAVE_REQUEST_OVERLAP');
    }
  });
  it('40. AM vs AM → overlap; 41. PM vs PM → overlap; 42. AM vs PM same day → allowed', async () => {
    const am = await ov({ leaveTypeId: f.types.ANNUAL, startDate: f.wd(13), endPart: 'AM' }); expect(am.status).toBe('PENDING'); expect(am.units).toBe(0.5);
    expect((await ov({ leaveTypeId: f.types.SICK, startDate: f.wd(13), endPart: 'AM', attachmentRef: 'd' })).error).toBe('LEAVE_REQUEST_OVERLAP');
    const pm = await ov({ leaveTypeId: f.types.SICK, startDate: f.wd(13), startPart: 'PM', attachmentRef: 'd' }); expect(pm.status).toBe('PENDING'); expect(pm.units).toBe(0.5);
    expect((await ov({ leaveTypeId: f.types.ANNUAL, startDate: f.wd(13), startPart: 'PM' })).error).toBe('LEAVE_REQUEST_OVERLAP');
    // multi-day: PM start on wd(13) vs a request ending AM on wd(13)... covered; a range touching only via the shared day's other half is fine
  });
  it('43. rejected does not block; 44. cancelled does not block; 45. draft does not block; 46. approved blocks', async () => {
    const rej = await ov({ leaveTypeId: f.types.ANNUAL, startDate: f.wd(15) }); expect((await act(f.s.mgr, rej.workflowInstanceId, 'REJECT', 'no')).status).toBe(200);
    const after = await ov({ leaveTypeId: f.types.ANNUAL, startDate: f.wd(15) }); expect(after.status).toBe('PENDING'); await cancel(f.s.emp2, after.id);
    const can = await ov({ leaveTypeId: f.types.ANNUAL, startDate: f.wd(16) }); expect((await cancel(f.s.emp2, can.id)).status).toBe(200);
    const after2 = await ov({ leaveTypeId: f.types.ANNUAL, startDate: f.wd(16) }); expect(after2.status).toBe('PENDING'); await cancel(f.s.emp2, after2.id);
    expect((await draft(f.s.emp2, { leaveTypeId: f.types.ANNUAL, startDate: f.wd(17) })).status).toBe(201); // stays DRAFT
    const after3 = await ov({ leaveTypeId: f.types.ANNUAL, startDate: f.wd(17) }); expect(after3.status).toBe('PENDING'); await cancel(f.s.emp2, after3.id);
    const app1 = await ov({ leaveTypeId: f.types.ANNUAL, startDate: f.wd(18) }); expect((await act(f.s.mgr, app1.workflowInstanceId, 'APPROVE')).status).toBe(200);
    expect((await ov({ leaveTypeId: f.types.ANNUAL, startDate: f.wd(18) })).error).toBe('LEAVE_REQUEST_OVERLAP');
    await reconciled(E[`${f.employees.EMP2}:ANNUAL`]);
  });
});

describe('G. submit + workflow', () => {
  let r: Awaited<ReturnType<typeof submitted>>;
  it('48. submit → PENDING with snapshots; 49. reservation; 50. deterministic operationKey; 51. workflow instance; 52. approver snapshot', async () => {
    const entId = E[`${f.employees.EMP}:ANNUAL`];
    const before = await cached(entId);
    r = await submitted(f.s.emp, { leaveTypeId: f.types.ANNUAL, startDate: f.wd(20), endDate: f.wd(21), reason: 'holiday' });
    expect(r).toMatchObject({ status: 'PENDING', units: 2, entitlementId: entId, policy: { id: f.policies.annualA } });
    const d = (await get(f.s.emp, r.id)).body.data;
    expect(d).toMatchObject({ calendarId: f.calA, organizationId: f.orgA.id, departmentId: f.deptA.id, submittedAt: expect.any(String) });
    expect(d.positionId).toBeTruthy();
    const res = await ledger(entId, 'RESERVE');
    expect(res.at(-1)).toMatchObject({ units: 2, operationKey: `leave:${r.id}:reserve`, referenceType: 'LeaveRequest', referenceId: r.id });
    expect((await cached(entId)).reserved).toBe(before.reserved + 2);
    const wf = await prisma.workflowInstance.findUniqueOrThrow({ where: { id: r.workflowInstanceId }, include: { steps: true } });
    expect(wf).toMatchObject({ module: 'leave', entityType: 'LEAVE_REQUEST', entityId: r.id, status: 'PENDING', requesterEmployeeId: f.employees.EMP });
    expect(wf.steps[0]).toMatchObject({ approverType: 'DIRECT_MANAGER', approverUserId: f.s.mgr.user.id, status: 'PENDING' });
    expect(await audits(r.id, 'SUBMIT_LEAVE_REQUEST')).toBe(1);
    expect(d.workflow.steps[0].approver.id).toBe(f.s.mgr.user.id); // timeline for the requester/approver view
  });
  it('14. pending request is immutable; 48b. submit retry is idempotent (no second reserve / workflow)', async () => {
    expect(err(await f.as(f.s.emp, 'patch', `/api/v1/leave/requests/${r.id}`).send({ reason: 'edit' }))).toBe('409 LEAVE_REQUEST_NOT_DRAFT');
    const again = await submit(f.s.emp, r.id);
    expect(again.status).toBe(200); expect(again.body.data).toMatchObject({ status: 'PENDING', workflowInstanceId: r.workflowInstanceId });
    expect(await prisma.leaveLedger.count({ where: { referenceId: r.id, entryType: 'RESERVE' } })).toBe(1);
    expect(await prisma.workflowInstance.count({ where: { entityId: r.id } })).toBe(1);
    expect(await audits(r.id, 'SUBMIT_LEAVE_REQUEST')).toBe(1);
    await cancel(f.s.emp, r.id);
    expect(err(await submit(f.s.emp, r.id))).toBe('409 LEAVE_REQUEST_NOT_DRAFT');
  });
  it('53. workflow submit failure → transaction rolled back: no reservation, request remains DRAFT, no instance', async () => {
    const entId = E[`${f.employees.EMP}:ANNUAL`];
    const d = await draft(f.s.emp, { leaveTypeId: f.types.ANNUAL, startDate: f.wd(22) });
    const before = await cached(entId);
    vi.spyOn(workflowEngine, 'submit').mockRejectedValueOnce(new Error('workflow engine failure'));
    const res = await submit(f.s.emp, d.body.data.id);
    expect(res.status).toBe(500); expect(JSON.stringify(res.body)).not.toMatch(/prisma|SELECT/i);
    expect((await get(f.s.emp, d.body.data.id)).body.data).toMatchObject({ status: 'DRAFT', entitlementId: null, policy: null, calendarId: null, workflowInstanceId: null, submittedAt: null });
    expect(await prisma.leaveLedger.count({ where: { referenceId: d.body.data.id } })).toBe(0);
    expect(await prisma.workflowInstance.count({ where: { entityId: d.body.data.id } })).toBe(0);
    expect(await cached(entId)).toMatchObject({ reserved: before.reserved });
    expect(await audits(d.body.data.id, 'SUBMIT_LEAVE_REQUEST')).toBe(0);
    await reconciled(entId);
    expect((await submit(f.s.emp, d.body.data.id)).status).toBe(200); // works once the failure is gone
    await cancel(f.s.emp, d.body.data.id);
  });
  it('54. auto-approved workflow (all steps skipped) → APPROVED in the submit transaction, reserved 0, used = units, status not overwritten to PENDING', async () => {
    const entId = E[`${f.employees.LONER}:AUTO`];
    const r2 = await submitted(f.s.loner, { leaveTypeId: f.types.AUTO, startDate: f.wd(20), endDate: f.wd(21) });
    expect(r2).toMatchObject({ status: 'APPROVED', units: 2 });
    expect(r2.workflowInstanceId).toBeTruthy();
    const d = (await get(f.s.loner, r2.id)).body.data;
    expect(d).toMatchObject({ status: 'APPROVED', approvedAt: expect.any(String), workflow: { status: 'APPROVED' } });
    expect(d.workflow.steps[0]).toMatchObject({ status: 'SKIPPED', skipReason: 'UNRESOLVED' });
    expect((await ledger(entId)).map((l) => l.entryType)).toEqual(['GRANT', 'RESERVE', 'RELEASE', 'USE']);
    expect(await cached(entId)).toMatchObject({ reserved: 0, used: 2, granted: 5 });
    expect(await audits(r2.id, 'APPROVE_LEAVE_REQUEST')).toBe(1);
    const approveAudit = await prisma.auditLog.findFirst({ where: { recordId: r2.id, action: 'APPROVE_LEAVE_REQUEST' } });
    expect(approveAudit!.userId).toBe(f.s.loner.user.id); // deterministic actor = requester for auto-approval
    await reconciled(entId);
  });
});

describe('H. approval / rejection (generic workflow action endpoint, workflow.approve + snapshot approver)', () => {
  let two: Awaited<ReturnType<typeof submitted>>;
  const entId = () => E[`${f.employees.EMP}:LONG`];
  it('55. approve intermediate step → request remains PENDING; 56. approve final → APPROVED, release + use', async () => {
    two = await submitted(f.s.emp, { leaveTypeId: f.types.LONG, startDate: f.wd(25) });
    expect((await act(f.s.mgr, two.workflowInstanceId, 'APPROVE', 'ok')).status).toBe(200);
    let d = (await get(f.s.emp, two.id)).body.data;
    expect(d).toMatchObject({ status: 'PENDING', approvedAt: null, workflow: { status: 'PENDING', currentStepOrder: 2 } });
    expect(await cached(entId())).toMatchObject({ reserved: 1, used: 0 });
    expect((await act(f.s.head, two.workflowInstanceId, 'APPROVE')).status).toBe(200);
    d = (await get(f.s.emp, two.id)).body.data;
    expect(d).toMatchObject({ status: 'APPROVED', approvedAt: expect.any(String), workflow: { status: 'APPROVED' } });
    const rows = await ledger(entId());
    expect(rows.map((l) => `${l.entryType}:${l.units}`)).toEqual(['GRANT:10', 'RESERVE:1', 'RELEASE:-1', 'USE:1']);
    expect(rows.filter((l) => l.referenceId === two.id).map((l) => l.operationKey)).toEqual([`leave:${two.id}:reserve`, `leave:${two.id}:release`, `leave:${two.id}:use`]);
    expect(await cached(entId())).toMatchObject({ reserved: 0, used: 1 });
    expect(await audits(two.id, 'APPROVE_LEAVE_REQUEST')).toBe(1);
    await reconciled(entId());
  });
  it('57. reject → REJECTED, reservation released, available restored', async () => {
    const r = await submitted(f.s.emp, { leaveTypeId: f.types.LONG, startDate: f.wd(26) });
    expect(await available(entId())).toBe(8);
    expect((await act(f.s.mgr, r.workflowInstanceId, 'REJECT', 'busy week')).status).toBe(200);
    expect((await get(f.s.emp, r.id)).body.data).toMatchObject({ status: 'REJECTED', rejectedAt: expect.any(String) });
    expect((await ledger(entId(), 'RELEASE')).filter((l) => l.referenceId === r.id)).toHaveLength(1);
    expect(await available(entId())).toBe(9);
    expect(await audits(r.id, 'REJECT_LEAVE_REQUEST')).toBe(1);
    await reconciled(entId());
  });
  it('58. wrong approver denied; 59. data scope (ALL) does not grant approval rights', async () => {
    const r = await submitted(f.s.emp, { leaveTypeId: f.types.LONG, startDate: f.wd(27) });
    expect(err(await act(f.s.head, r.workflowInstanceId, 'APPROVE'))).toBe('403 NOT_STEP_APPROVER'); // step 2 approver acting on step 1
    expect(err(await act(f.s.hradmin, r.workflowInstanceId, 'APPROVE'))).toBe('403 NOT_STEP_APPROVER'); // ALL scope + workflow.approve, not snapshot approver
    expect(err(await act(f.s.emp, r.workflowInstanceId, 'APPROVE'))).toBe('403 FORBIDDEN'); // no workflow.approve
    expect((await get(f.s.emp, r.id)).body.data.status).toBe('PENDING');
    await cancel(f.s.emp, r.id);
  });
});

describe('I. cancellation', () => {
  it('60. draft cancel → CANCELLED (audit, no ledger)', async () => {
    const d = await draft(f.s.emp, { leaveTypeId: f.types.ANNUAL, startDate: f.wd(28) });
    const c = await cancel(f.s.emp, d.body.data.id);
    expect(c.body.data).toMatchObject({ status: 'CANCELLED', cancelledAt: expect.any(String), workflowInstanceId: null });
    expect(await audits(d.body.data.id, 'CANCEL_LEAVE_REQUEST')).toBe(1);
    expect(await prisma.leaveLedger.count({ where: { referenceId: d.body.data.id } })).toBe(0);
    expect(err(await cancel(f.s.emp, d.body.data.id))).toBe('409 LEAVE_REQUEST_NOT_CANCELLABLE');
  });
  it('61/64. pending cancel → CANCELLED via internal workflow cancel, reservation released; 62. partially approved but still pending → cancellable', async () => {
    const entId = E[`${f.employees.EMP}:LONG`];
    const r = await submitted(f.s.emp, { leaveTypeId: f.types.LONG, startDate: f.wd(28) });
    const c = await cancel(f.s.emp, r.id);
    expect(c.status).toBe(200); expect(c.body.data).toMatchObject({ status: 'CANCELLED', cancelledAt: expect.any(String) });
    expect((await prisma.workflowInstance.findUniqueOrThrow({ where: { id: r.workflowInstanceId } })).status).toBe('CANCELLED');
    expect((await ledger(entId, 'RELEASE')).filter((l) => l.referenceId === r.id)).toHaveLength(1);
    expect(await audits(r.id, 'CANCEL_LEAVE_REQUEST')).toBe(1);
    const part = await submitted(f.s.emp, { leaveTypeId: f.types.LONG, startDate: f.wd(29) });
    expect((await act(f.s.mgr, part.workflowInstanceId, 'APPROVE')).status).toBe(200);
    expect((await cancel(f.s.emp, part.id)).body.data.status).toBe('CANCELLED');
    expect(await cached(entId)).toMatchObject({ reserved: 0, used: 1 });
    await reconciled(entId);
  });
  it('63. approved cancel rejected (LEAVE_REQUEST_NOT_CANCELLABLE); 65. generic workflow CANCEL action unavailable', async () => {
    const approved = await prisma.leaveRequest.findFirstOrThrow({ where: { employeeId: f.employees.EMP, status: 'APPROVED' } });
    expect(err(await cancel(f.s.emp, approved.id))).toBe('409 LEAVE_REQUEST_NOT_CANCELLABLE');
    const pending = await submitted(f.s.emp, { leaveTypeId: f.types.LONG, startDate: f.wd(31) });
    expect((await act(f.s.mgr, pending.workflowInstanceId, 'CANCEL')).status).toBe(400);
    expect((await get(f.s.emp, pending.id)).body.data.status).toBe('PENDING');
    // other employee cannot cancel it
    expect(err(await cancel(f.s.emp2, pending.id))).toBe('404 LEAVE_REQUEST_NOT_FOUND');
    await cancel(f.s.emp, pending.id);
  });
});

describe('J. data scope', () => {
  const codes = async (s: Session, q = '') => { const r = await f.as(s, 'get', `/api/v1/leave/requests?pageSize=100${q}`); expect(r.status).toBe(200); return [...new Set((r.body.data as { employee: { employeeCode: string } }[]).map((x) => x.employee.employeeCode))].sort(); };
  it('66. SELF sees own only; 67/68. TEAM = self + direct reports, excludes unrelated; 69. ALL sees all', async () => {
    expect(await codes(f.s.emp)).toEqual(['EMP']);
    const team = await codes(f.s.mgr);
    expect(team).toEqual(expect.arrayContaining(['EMP', 'EMP2'])); expect(team).not.toContain('OTHER'); expect(team).not.toContain('LONER'); expect(team).not.toContain('HRA');
    const all = await codes(f.s.hradmin);
    expect(all).toEqual(expect.arrayContaining(['EMP', 'EMP2', 'LONER', 'TRANS']));
    expect((await f.as(f.s.hradmin, 'get', `/api/v1/leave/requests?status=APPROVED&leaveTypeId=${f.types.LONG}`)).body.data.every((x: { status: string; leaveType: { id: string } }) => x.status === 'APPROVED' && x.leaveType.id === f.types.LONG)).toBe(true);
    expect((await f.as(f.s.hradmin, 'get', `/api/v1/leave/requests?employeeId=${f.employees.EMP2}`)).body.data.every((x: { employee: { id: string } }) => x.employee.id === f.employees.EMP2)).toBe(true);
    expect((await f.as(f.s.emp, 'get', `/api/v1/leave/requests?employeeId=${f.employees.EMP2}`)).body.data).toHaveLength(0); // filter cannot widen scope
  });
  it('70. approver outside data scope can read the request detail; 71. unrelated user gets 404', async () => {
    const two = await prisma.leaveRequest.findFirstOrThrow({ where: { employeeId: f.employees.EMP, leaveTypeId: f.types.LONG, status: 'APPROVED' } });
    expect(await codes(f.s.head)).not.toContain('EMP'); // EMP is not HEAD's direct report
    const d = await get(f.s.head, two.id);
    expect(d.status).toBe(200);
    expect(d.body.data).toMatchObject({ employee: { employeeCode: 'EMP' }, units: 1, balance: { periodStart: f.period.periodStart }, workflow: { status: 'APPROVED' } });
    expect(Object.keys(d.body.data.employee).sort()).toEqual(['employeeCode', 'firstName', 'id', 'lastName']); // no unrelated employee/admin data
    expect(err(await get(f.s.other, two.id))).toBe('404 LEAVE_REQUEST_NOT_FOUND');
    expect(err(await get(f.s.noleave, two.id))).toBe('404 LEAVE_REQUEST_NOT_FOUND');
  });
});

describe('K. balances/me', () => {
  it('72. balances/me lists my entitlements covering asOfDate; 73. reserve reflected; 74. approve moved reserved → used; 75/76. reject/cancel restored', async () => {
    const me = await f.as(f.s.emp, 'get', '/api/v1/leave/balances/me');
    expect(me.status).toBe(200); expect(me.body.asOfDate).toBe(f.today);
    const byType = Object.fromEntries((me.body.data as { leaveType: { code: string }; granted: number; reserved: number; used: number; available: number }[]).map((b) => [b.leaveType.code, b]));
    expect(byType.LONG).toMatchObject({ granted: 10, reserved: 0, used: 1, available: 9 }); // 56 approved (1), 57 rejected, 61/62/58 cancelled
    expect(byType.ANNUAL).toMatchObject({ granted: 10, reserved: 0, used: 0, available: 10 });
    const r = await submitted(f.s.emp, { leaveTypeId: f.types.ANNUAL, startDate: f.wd(33), endDate: f.wd(34) });
    const after = (await f.as(f.s.emp, 'get', '/api/v1/leave/balances/me')).body.data.find((b: { leaveType: { code: string } }) => b.leaveType.code === 'ANNUAL');
    expect(after).toMatchObject({ reserved: 2, available: 8 });
    await cancel(f.s.emp, r.id);
    expect((await f.as(f.s.emp, 'get', '/api/v1/leave/balances/me')).body.data.find((b: { leaveType: { code: string } }) => b.leaveType.code === 'ANNUAL')).toMatchObject({ reserved: 0, available: 10 });
    expect((await f.as(f.s.emp, 'get', `/api/v1/leave/balances/me?asOfDate=${f.year + 5}-01-01`)).body.data).toHaveLength(0);
    expect(err(await f.as(f.s.noleave, 'get', '/api/v1/leave/balances/me'))).toBe('403 FORBIDDEN');
  });
});

describe('L. transactional rollback', () => {
  const entId = () => E[`${f.employees.EMP}:ANNUAL`];
  it('82. leave handler failure → final approval rolled back (workflow + ledger + request unchanged); retry succeeds', async () => {
    const r = await submitted(f.s.emp, { leaveTypeId: f.types.ANNUAL, startDate: f.wd(36) });
    vi.spyOn(leaveWorkflowHandlers, 'onApproved').mockRejectedValueOnce(new Error('handler failure'));
    expect((await act(f.s.mgr, r.workflowInstanceId, 'APPROVE')).status).toBe(500);
    expect((await prisma.workflowInstance.findUniqueOrThrow({ where: { id: r.workflowInstanceId }, include: { steps: true, actions: true } })).status).toBe('PENDING');
    expect(await prisma.workflowAction.count({ where: { instanceId: r.workflowInstanceId, action: 'APPROVE' } })).toBe(0);
    expect((await get(f.s.emp, r.id)).body.data.status).toBe('PENDING');
    expect((await ledger(entId())).filter((l) => l.referenceId === r.id).map((l) => l.entryType)).toEqual(['RESERVE']);
    expect(await audits(r.id, 'APPROVE_LEAVE_REQUEST')).toBe(0);
    expect((await act(f.s.mgr, r.workflowInstanceId, 'APPROVE')).status).toBe(200);
    expect((await get(f.s.emp, r.id)).body.data.status).toBe('APPROVED');
    await reconciled(entId());
  });
  it('83. ledger failure → workflow transition rolled back', async () => {
    const r = await submitted(f.s.emp, { leaveTypeId: f.types.ANNUAL, startDate: f.wd(37) });
    vi.spyOn(balanceService, 'use').mockRejectedValueOnce(new Error('ledger failure'));
    expect((await act(f.s.mgr, r.workflowInstanceId, 'APPROVE')).status).toBe(500);
    expect((await prisma.workflowInstance.findUniqueOrThrow({ where: { id: r.workflowInstanceId } })).status).toBe('PENDING');
    expect((await ledger(entId())).filter((l) => l.referenceId === r.id).map((l) => l.entryType)).toEqual(['RESERVE']); // RELEASE rolled back too
    expect((await get(f.s.emp, r.id)).body.data.status).toBe('PENDING');
    await reconciled(entId());
    await cancel(f.s.emp, r.id);
  });
  it('84/85. audit failure → leave + workflow + ledger rolled back; no partial snapshot or status', async () => {
    const d = await draft(f.s.emp, { leaveTypeId: f.types.ANNUAL, startDate: f.wd(38) });
    const before = await cached(entId());
    const real = auditService.log.bind(auditService);
    vi.spyOn(auditService, 'log').mockImplementation(async (entry, tx) => { if (entry.action === 'SUBMIT_LEAVE_REQUEST') throw new Error('audit failure'); return real(entry, tx); });
    expect((await submit(f.s.emp, d.body.data.id)).status).toBe(500);
    vi.restoreAllMocks();
    expect((await get(f.s.emp, d.body.data.id)).body.data).toMatchObject({ status: 'DRAFT', entitlementId: null, policy: null, calendarId: null, organizationId: null, workflowInstanceId: null, submittedAt: null });
    expect(await prisma.workflowInstance.count({ where: { entityId: d.body.data.id } })).toBe(0);
    expect(await prisma.leaveLedger.count({ where: { referenceId: d.body.data.id } })).toBe(0);
    expect(await cached(entId())).toMatchObject({ reserved: before.reserved, used: before.used });
    await reconciled(entId());
  });
});
