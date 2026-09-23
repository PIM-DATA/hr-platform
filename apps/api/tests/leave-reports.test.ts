/**
 * Task 14 — leave reporting (checklist 1–35). Reports are aggregates of the requests the caller can already read:
 * `leave.view` + employeeScopeWhere, attribution by request START DATE, DRAFT excluded, snapshot dimensions.
 */
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays } from '@hr/shared';
import { prisma } from '../src/lib/prisma';
import { createTestServer } from './helpers';
import { setupLeaveFixture, type LeaveFixture, type Session } from './leave-fixture';

const app = createTestServer();
let f: LeaveFixture;
type Overview = {
  period: { from: string; to: string; attribution: string };
  summary: { submittedRequests: number; approvedRequests: number; pendingRequests: number; rejectedRequests: number; cancelledRequests: number; approvedUnits: number; pendingUnits: number };
  byLeaveType: { leaveTypeId: string; code: string; approvedUnits: number; pendingUnits: number; submittedRequests: number }[];
  trend: { month: string; submittedRequests: number; approvedUnits: number; pendingUnits: number }[];
  byDepartment: { departmentId: string | null; departmentName: string; submittedRequests: number; approvedUnits: number; pendingUnits: number }[];
  pendingAging: { bucket: string; count: number }[];
};
const overview = (s: Session, q: string) => f.as(s, 'get', `/api/v1/leave/reports/overview?${q}`);
const options = (s: Session) => f.as(s, 'get', '/api/v1/leave/reports/options');
const err = (r: request.Response) => `${r.status} ${r.body?.error?.code ?? ''}`.trim();
const YEAR = () => f.year;
const range = () => `from=${YEAR()}-01-01&to=${YEAR() + 1}-12-31`;

/** Creates a request directly in the state the report should see (the lifecycle itself is covered by Task 11 tests). */
async function seedRequest(opts: { employeeId: string; leaveTypeId: string; startDate: string; endDate?: string; units: number; status: string; departmentId?: string | null; organizationId?: string | null; submittedAt?: Date | null; reason?: string; attachmentRef?: string }) {
  const emp = await prisma.employee.findUniqueOrThrow({ where: { id: opts.employeeId }, select: { departmentId: true, organizationId: true, positionId: true } });
  return prisma.leaveRequest.create({
    data: {
      employeeId: opts.employeeId, leaveTypeId: opts.leaveTypeId, startDate: opts.startDate, endDate: opts.endDate ?? opts.startDate,
      units: opts.units, status: opts.status, reason: opts.reason ?? null, attachmentRef: opts.attachmentRef ?? null,
      departmentId: opts.departmentId === undefined ? emp.departmentId : opts.departmentId,
      organizationId: opts.organizationId === undefined ? emp.organizationId : opts.organizationId,
      positionId: emp.positionId,
      submittedAt: opts.submittedAt === undefined ? new Date() : opts.submittedAt,
      createdByUserId: f.s.admin.user.id,
    },
  });
}

beforeAll(async () => {
  f = await setupLeaveFixture(app);
  const y = f.year;
  const E = f.employees;
  // EMP (MGR's report, dept Ops): approved 3 + pending 2 + rejected 1 + cancelled 1 + a draft that must be ignored
  await seedRequest({ employeeId: E.EMP, leaveTypeId: f.types.ANNUAL, startDate: `${y}-03-02`, endDate: `${y}-03-04`, units: 3, status: 'APPROVED', reason: 'secret-reason', attachmentRef: 'secret-attachment' });
  await seedRequest({ employeeId: E.EMP, leaveTypeId: f.types.ANNUAL, startDate: `${y}-04-06`, units: 2, status: 'PENDING', submittedAt: new Date(Date.now() - 1 * 86_400_000) });
  await seedRequest({ employeeId: E.EMP, leaveTypeId: f.types.SICK, startDate: `${y}-05-04`, units: 1, status: 'REJECTED' });
  await seedRequest({ employeeId: E.EMP, leaveTypeId: f.types.ANNUAL, startDate: `${y}-06-01`, units: 1, status: 'CANCELLED' });
  await seedRequest({ employeeId: E.EMP, leaveTypeId: f.types.ANNUAL, startDate: `${y}-07-01`, units: 5, status: 'DRAFT', submittedAt: null });
  // cross-month request: attributed entirely to its start month (January)
  await seedRequest({ employeeId: E.EMP, leaveTypeId: f.types.ANNUAL, startDate: `${y}-01-29`, endDate: `${y}-02-03`, units: 4, status: 'APPROVED' });
  // EMP2 (MGR's report): pending, aged 5 days
  await seedRequest({ employeeId: E.EMP2, leaveTypeId: f.types.ANNUAL, startDate: `${y}-03-10`, units: 1, status: 'PENDING', submittedAt: new Date(Date.now() - 5 * 86_400_000) });
  // OTHER (HEAD's report, dept Finance — not MGR's team): approved, aged pending
  await seedRequest({ employeeId: E.OTHER, leaveTypeId: f.types.ANNUAL, startDate: `${y}-03-11`, units: 2, status: 'APPROVED' });
  await seedRequest({ employeeId: E.OTHER, leaveTypeId: f.types.SICK, startDate: `${y}-03-12`, units: 1, status: 'PENDING', submittedAt: new Date(Date.now() - 10 * 86_400_000) });
  // HRA: request snapshotted with NO department (must be grouped as "Unassigned", never dropped)
  await seedRequest({ employeeId: E.HRA, leaveTypeId: f.types.ANNUAL, startDate: `${y}-03-13`, units: 1, status: 'APPROVED', departmentId: null });
  // out of range: previous year
  await seedRequest({ employeeId: E.EMP, leaveTypeId: f.types.ANNUAL, startDate: `${y - 1}-12-15`, units: 9, status: 'APPROVED' });
}, 60000);
afterAll(async () => { await prisma.$disconnect(); });

describe('report security and scope (1–8)', () => {
  it('1. unauthenticated → 401; 2. without leave.view → 403', async () => {
    expect((await request(app).get(`/api/v1/leave/reports/overview?${range()}`)).status).toBe(401);
    expect((await f.as(f.s.noleave, 'get', `/api/v1/leave/reports/overview?${range()}`)).status).toBe(403);
    expect((await options(f.s.noleave)).status).toBe(403);
  });
  it('3/4/5/6. SELF sees only itself; TEAM sees self + direct reports and excludes unrelated employees', async () => {
    const self = (await overview(f.s.emp, range())).body.data as Overview;
    expect(self.summary.approvedUnits).toBe(7); // EMP: 3 + 4 (cross-month), no one else
    const team = (await overview(f.s.mgr, range())).body.data as Overview;
    expect(team.summary.pendingRequests).toBe(2); // EMP (2 units) + EMP2 (1 unit), not OTHER's
    expect(team.summary.pendingUnits).toBe(3);
    expect(team.summary.approvedUnits).toBe(7); // OTHER's and HRA's approvals are outside MGR's team
    expect(team.byDepartment.map((d) => d.departmentName)).not.toContain('Unassigned'); // HRA is not in MGR's team
  });
  it('7. ALL sees every accessible employee; 8. a filter cannot widen scope', async () => {
    const all = (await overview(f.s.hradmin, range())).body.data as Overview;
    expect(all.summary.approvedUnits).toBe(10); // 7 (EMP) + 2 (OTHER) + 1 (HRA)
    expect(all.summary.pendingUnits).toBe(4); // 2 + 1 + 1
    // a TEAM caller passing another department's id still only sees their own team (here: nothing)
    const finance = await prisma.department.findFirstOrThrow({ where: { code: 'FIN' } });
    const narrowed = (await overview(f.s.mgr, `${range()}&departmentId=${finance.id}`)).body.data as Overview;
    expect(narrowed.summary.submittedRequests).toBe(0);
    expect((await overview(f.s.hradmin, `${range()}&departmentId=${finance.id}`)).body.data.summary.submittedRequests).toBeGreaterThan(0);
  });
});

describe('reporting semantics (9–18)', () => {
  it('9. DRAFT excluded; 10–13. every submitted status counted; 14/15. unit sums', async () => {
    const r = (await overview(f.s.hradmin, range())).body.data as Overview;
    expect(r.period.attribution).toBe('START_DATE');
    expect(r.summary).toMatchObject({ approvedRequests: 4, pendingRequests: 3, rejectedRequests: 1, cancelledRequests: 1, approvedUnits: 10, pendingUnits: 4 });
    expect(r.summary.submittedRequests).toBe(9); // 4 + 3 + 1 + 1, the DRAFT is not counted
    expect(await prisma.leaveRequest.count({ where: { status: 'DRAFT' } })).toBeGreaterThan(0); // the draft exists but never appears
  });
  it('16. a request outside the range is excluded; 17. a cross-month request belongs to its start month; 18. no recalculation against the current calendar', async () => {
    const y = YEAR();
    const inRange = (await overview(f.s.hradmin, range())).body.data as Overview;
    expect(inRange.summary.approvedUnits).toBe(10); // the previous-year request (9 units) is out of range
    const prevYear = (await overview(f.s.hradmin, `from=${y - 1}-01-01&to=${y - 1}-12-31`)).body.data as Overview;
    expect(prevYear.summary.approvedUnits).toBe(9);
    const jan = inRange.trend.find((t) => t.month === `${y}-01`)!;
    const feb = inRange.trend.find((t) => t.month === `${y}-02`)!;
    expect(jan).toMatchObject({ submittedRequests: 1, approvedUnits: 4 }); // the 29 Jan → 3 Feb request, whole units
    expect(feb).toMatchObject({ submittedRequests: 0, approvedUnits: 0 });
    // adding a holiday now must not change historical figures (units come from the stored snapshot)
    await f.as(f.s.admin, 'post', `/api/v1/calendars/${f.calA}/holidays`).send({ date: `${y}-03-03`, name: 'Report-time holiday' });
    const after = (await overview(f.s.hradmin, range())).body.data as Overview;
    expect(after.summary.approvedUnits).toBe(10);
  });
});

describe('breakdowns (19–22)', () => {
  it('19. leave type grouping; 22. a null department is grouped as "Unassigned", never dropped', async () => {
    const r = (await overview(f.s.hradmin, range())).body.data as Overview;
    const annual = r.byLeaveType.find((t) => t.code === 'ANNUAL')!;
    const sick = r.byLeaveType.find((t) => t.code === 'SICK')!;
    expect(annual).toMatchObject({ approvedUnits: 10, pendingUnits: 3 });
    expect(sick).toMatchObject({ approvedUnits: 0, pendingUnits: 1, submittedRequests: 2 }); // one rejected + one pending
    expect(r.byLeaveType[0].approvedUnits).toBeGreaterThanOrEqual(r.byLeaveType[r.byLeaveType.length - 1].approvedUnits); // sorted desc
    const unassigned = r.byDepartment.find((d) => d.departmentName === 'Unassigned');
    expect(unassigned).toMatchObject({ departmentId: null, submittedRequests: 1, approvedUnits: 1 });
    expect(r.byDepartment.reduce((sum, d) => sum + d.submittedRequests, 0)).toBe(r.summary.submittedRequests); // nothing lost
  });
  it('20. the department comes from the request snapshot — a later transfer does not rewrite history', async () => {
    const before = (await overview(f.s.hradmin, range())).body.data as Overview;
    const ops = before.byDepartment.find((d) => d.departmentName === 'Ops')!;
    expect(ops.approvedUnits).toBe(7);
    const finance = await prisma.department.findFirstOrThrow({ where: { code: 'FIN' } });
    await prisma.employee.update({ where: { id: f.employees.EMP }, data: { departmentId: finance.id } });
    try {
      const after = (await overview(f.s.hradmin, range())).body.data as Overview;
      expect(after.byDepartment.find((d) => d.departmentName === 'Ops')!.approvedUnits).toBe(7); // unchanged
    } finally {
      await prisma.employee.update({ where: { id: f.employees.EMP }, data: { departmentId: f.deptA.id } });
    }
  });
  it('21. the organization filter uses the request snapshot', async () => {
    const orgA = (await overview(f.s.hradmin, `${range()}&organizationId=${f.orgA.id}`)).body.data as Overview;
    expect(orgA.summary.submittedRequests).toBeGreaterThan(0);
    const orgB = (await overview(f.s.hradmin, `${range()}&organizationId=${f.orgB.id}`)).body.data as Overview;
    expect(orgB.summary.submittedRequests).toBe(0);
  });
});

describe('trend and range validation (23–27)', () => {
  it('23. monthly grouping; 24. missing months are zero-filled', async () => {
    const y = YEAR();
    const r = (await overview(f.s.hradmin, `from=${y}-01-01&to=${y}-12-31`)).body.data as Overview;
    expect(r.trend).toHaveLength(12);
    expect(r.trend.map((t) => t.month)).toEqual(Array.from({ length: 12 }, (_, i) => `${y}-${String(i + 1).padStart(2, '0')}`));
    // March: EMP 3/02 approved(3), EMP2 3/10 pending, OTHER 3/11 approved(2), OTHER 3/12 pending, HRA 3/13 approved(1)
    expect(r.trend.find((t) => t.month === `${y}-03`)).toMatchObject({ submittedRequests: 5, approvedUnits: 6 });
    expect(r.trend.find((t) => t.month === `${y}-08`)).toMatchObject({ submittedRequests: 0, approvedUnits: 0, pendingUnits: 0 });
  });
  it('25. a 24-month range is allowed; 26. beyond it → REPORT_RANGE_TOO_LARGE; 27. invalid dates rejected', async () => {
    const y = YEAR();
    expect((await overview(f.s.hradmin, `from=${y}-01-01&to=${y + 1}-12-31`)).status).toBe(200); // exactly 24 months
    expect(err(await overview(f.s.hradmin, `from=${y}-01-01&to=${y + 2}-01-01`))).toBe('400 REPORT_RANGE_TOO_LARGE');
    expect((await overview(f.s.hradmin, `from=${y}-13-01&to=${y}-12-31`)).status).toBe(400);
    expect((await overview(f.s.hradmin, `from=${y}-12-31&to=${y}-01-01`)).status).toBe(400); // from after to
    expect((await overview(f.s.hradmin, 'from=2026-01-01')).status).toBe(400); // to is required
  });
});

describe('pending aging (28–31)', () => {
  it('28/29/30. buckets by elapsed days since submission; 31. terminal requests are excluded', async () => {
    const r = (await overview(f.s.hradmin, range())).body.data as Overview;
    const bucket = (name: string) => r.pendingAging.find((b) => b.bucket === name)!.count;
    expect(r.pendingAging.map((b) => b.bucket)).toEqual(['0-2', '3-7', '8+']);
    expect(bucket('0-2')).toBe(1); // EMP, submitted 1 day ago
    expect(bucket('3-7')).toBe(1); // EMP2, 5 days ago
    expect(bucket('8+')).toBe(1); // OTHER, 10 days ago
    expect(bucket('0-2') + bucket('3-7') + bucket('8+')).toBe(r.summary.pendingRequests); // only PENDING requests age
  });
});

describe('privacy and options (32–35)', () => {
  it('32. the aggregate response carries no reason, attachment, comment, policy or ledger details', async () => {
    const raw = JSON.stringify((await overview(f.s.hradmin, range())).body);
    for (const secret of ['secret-reason', 'secret-attachment']) expect(raw).not.toMatch(secret);
    expect(raw).not.toMatch(/reason|attachmentRef|policyId|entitlementId|reserved|granted|employeeCode|@/i);
  });
  it('33/34/35. report options need no organization-admin permission, are scoped, and stay minimal', async () => {
    // Options are served on leave.view alone (no organization.manage / calendar / policy permission needed) and return
    // a minimal DTO — never the organization admin shape (code, timezone, defaultCalendar, counts…).
    const mgr = await options(f.s.mgr);
    expect(mgr.status).toBe(200);
    expect(Object.keys(mgr.body.data).sort()).toEqual(['departments', 'leaveTypes', 'organizations']);
    expect(Object.keys(mgr.body.data.leaveTypes[0]).sort()).toEqual(['code', 'id', 'name']);
    expect(Object.keys(mgr.body.data.organizations[0] ?? { id: '', name: '' }).sort()).toEqual(['id', 'name']);
    expect(JSON.stringify(mgr.body.data)).not.toMatch(/timezone|defaultCalendar|isActive|parentId|headEmployee/);
    expect(mgr.body.data.departments.map((d: { name: string }) => d.name)).toEqual(['Ops']); // only what MGR's team has used
    const all = await options(f.s.hradmin);
    expect(all.body.data.departments.length).toBeGreaterThanOrEqual(mgr.body.data.departments.length);
  });
  it('25b. an empty period returns zeroed summary, empty breakdowns and zero-filled months (not an error)', async () => {
    const r = (await overview(f.s.hradmin, `from=${YEAR() + 1}-01-01&to=${YEAR() + 1}-03-31`)).body.data as Overview;
    expect(r.summary).toMatchObject({ submittedRequests: 0, approvedUnits: 0, pendingUnits: 0 });
    expect(r.byLeaveType).toEqual([]);
    expect(r.byDepartment).toEqual([]);
    expect(r.trend.map((t) => t.month)).toEqual([`${YEAR() + 1}-01`, `${YEAR() + 1}-02`, `${YEAR() + 1}-03`]);
    expect(r.trend.every((t) => t.submittedRequests === 0)).toBe(true);
    expect(addDays(`${YEAR()}-01-01`, 1)).toBe(`${YEAR()}-01-02`);
  });
});
