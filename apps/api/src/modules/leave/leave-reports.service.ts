import type { Prisma } from '@prisma/client';
import {
  LEAVE_REPORT_ATTRIBUTION, LEAVE_REQUEST_STATUS as ST, MAX_REPORT_MONTHS, halfRound,
  type LeaveReportAgingBucketDto, type LeaveReportDepartmentRowDto, type LeaveReportOptionsDto, type LeaveReportOverviewDto, type LeaveReportQuery, type LeaveReportSummaryDto, type LeaveReportTrendPointDto, type LeaveReportTypeRowDto,
} from '@hr/shared';
import { prisma } from '../../lib/prisma';
import { AppError } from '../../lib/errors';
import type { AuthContext } from '../auth/auth.types';
import { employeeScopeWhere } from '../employees/employees.scope';

/**
 * Leave operational reporting: aggregates of the leave REQUESTS the caller can already read (`leave.view` +
 * `employeeScopeWhere`), so no separate report permission exists. Scope always lives in the SQL, never in a
 * post-filter.
 *
 * Attribution (`START_DATE`): a request counts in the period that contains its `startDate`, with its whole snapshotted
 * `units`. A request spanning a month boundary therefore belongs entirely to its start month — requests store a total,
 * not a per-day ledger, and historical requests are never re-prorated against the current calendar or holidays.
 *
 * Population: everything except DRAFT (a draft has not been submitted, so it is not leave activity).
 * Dimensions (organization / department) come from the request SNAPSHOT, so a later transfer never rewrites history —
 * which is a different concept from authorization, which always uses the employee's CURRENT scope.
 *
 * Figures come from the request snapshots, not from the ledger: this is a leave-request report, while the ledger stays
 * the source of truth for balances and accounting.
 */
const REPORTED_STATUSES = [ST.PENDING, ST.APPROVED, ST.REJECTED, ST.CANCELLED];

function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  let [y, m] = from.split('-').map(Number);
  const [ey, em] = to.split('-').map(Number);
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

/** Scope + period + snapshot-dimension filters, AND-ed so no filter can replace the scope clause. */
function reportWhere(auth: AuthContext, q: LeaveReportQuery): Prisma.LeaveRequestWhereInput {
  const and: Prisma.LeaveRequestWhereInput[] = [
    { employee: employeeScopeWhere(auth) },
    { status: { in: REPORTED_STATUSES } },
    { startDate: { gte: q.from, lte: q.to } },
  ];
  if (q.leaveTypeId) and.push({ leaveTypeId: q.leaveTypeId });
  if (q.organizationId) and.push({ organizationId: q.organizationId });
  if (q.departmentId) and.push({ departmentId: q.departmentId });
  return { AND: and };
}

const zeroSummary = (): LeaveReportSummaryDto => ({ submittedRequests: 0, approvedRequests: 0, pendingRequests: 0, rejectedRequests: 0, cancelledRequests: 0, approvedUnits: 0, pendingUnits: 0 });
const unitsOf = (status: string, s: { _sum: { units: number | null } }) => halfRound(s._sum.units ?? 0);

export const leaveReportsService = {
  async overview(auth: AuthContext, q: LeaveReportQuery): Promise<LeaveReportOverviewDto> {
    const months = monthsBetween(q.from.slice(0, 7), q.to.slice(0, 7));
    if (months.length > MAX_REPORT_MONTHS) throw new AppError(400, 'REPORT_RANGE_TOO_LARGE', `The report range may not exceed ${MAX_REPORT_MONTHS} months`);
    const where = reportWhere(auth, q);

    // All aggregation happens in PostgreSQL; only small grouped result sets are shaped in Node.
    // Pending aging is counted in the database (three COUNTs against the submittedAt index) rather than by loading
    // every pending row into Node. Buckets use elapsed calendar time since submission, not business days.
    const now = Date.now();
    const daysAgo = (n: number) => new Date(now - n * 86_400_000);
    const pendingWhere = (extra: Prisma.LeaveRequestWhereInput) => ({ AND: [where, { status: ST.PENDING }, extra] });
    const [byStatus, byTypeStatus, byDeptStatus, aging0to2, aging3to7, aging8plus] = await Promise.all([
      prisma.leaveRequest.groupBy({ by: ['status'], where, _count: { _all: true }, _sum: { units: true } }),
      prisma.leaveRequest.groupBy({ by: ['leaveTypeId', 'status'], where, _count: { _all: true }, _sum: { units: true } }),
      prisma.leaveRequest.groupBy({ by: ['departmentId', 'status'], where, _count: { _all: true }, _sum: { units: true } }),
      // 0–2 days: submitted after the 3-day cutoff (a request with no submittedAt counts as brand new)
      prisma.leaveRequest.count({ where: pendingWhere({ OR: [{ submittedAt: { gt: daysAgo(3) } }, { submittedAt: null }] }) }),
      prisma.leaveRequest.count({ where: pendingWhere({ submittedAt: { lte: daysAgo(3), gt: daysAgo(8) } }) }),
      prisma.leaveRequest.count({ where: pendingWhere({ submittedAt: { lte: daysAgo(8) } }) }),
    ]);

    const summary = zeroSummary();
    for (const row of byStatus) {
      const count = row._count._all;
      summary.submittedRequests += count;
      if (row.status === ST.APPROVED) { summary.approvedRequests = count; summary.approvedUnits = unitsOf(row.status, row); }
      if (row.status === ST.PENDING) { summary.pendingRequests = count; summary.pendingUnits = unitsOf(row.status, row); }
      if (row.status === ST.REJECTED) summary.rejectedRequests = count;
      if (row.status === ST.CANCELLED) summary.cancelledRequests = count;
    }

    // ---- leave type breakdown (names batch-loaded, never per row) ----
    const typeIds = [...new Set(byTypeStatus.map((r) => r.leaveTypeId))];
    const typeNames = new Map((await prisma.leaveType.findMany({ where: { id: { in: typeIds } }, select: { id: true, code: true, name: true } })).map((t) => [t.id, t]));
    const byLeaveType = new Map<string, LeaveReportTypeRowDto>();
    for (const row of byTypeStatus) {
      const t = typeNames.get(row.leaveTypeId);
      const entry = byLeaveType.get(row.leaveTypeId) ?? { leaveTypeId: row.leaveTypeId, code: t?.code ?? '—', name: t?.name ?? 'Unknown', submittedRequests: 0, approvedRequests: 0, pendingRequests: 0, approvedUnits: 0, pendingUnits: 0 };
      entry.submittedRequests += row._count._all;
      if (row.status === ST.APPROVED) { entry.approvedRequests += row._count._all; entry.approvedUnits = halfRound(entry.approvedUnits + (row._sum.units ?? 0)); }
      if (row.status === ST.PENDING) { entry.pendingRequests += row._count._all; entry.pendingUnits = halfRound(entry.pendingUnits + (row._sum.units ?? 0)); }
      byLeaveType.set(row.leaveTypeId, entry);
    }

    // ---- department breakdown (request snapshot; null → "Unassigned", never dropped) ----
    const deptIds = byDeptStatus.map((r) => r.departmentId).filter((d): d is string => !!d);
    const deptNames = new Map((await prisma.department.findMany({ where: { id: { in: [...new Set(deptIds)] } }, select: { id: true, name: true } })).map((d) => [d.id, d.name]));
    const byDepartment = new Map<string, LeaveReportDepartmentRowDto>();
    for (const row of byDeptStatus) {
      const key = row.departmentId ?? '__unassigned__';
      const entry = byDepartment.get(key) ?? { departmentId: row.departmentId, departmentName: row.departmentId ? (deptNames.get(row.departmentId) ?? 'Unknown') : 'Unassigned', submittedRequests: 0, approvedRequests: 0, approvedUnits: 0, pendingUnits: 0 };
      entry.submittedRequests += row._count._all;
      if (row.status === ST.APPROVED) { entry.approvedRequests += row._count._all; entry.approvedUnits = halfRound(entry.approvedUnits + (row._sum.units ?? 0)); }
      if (row.status === ST.PENDING) entry.pendingUnits = halfRound(entry.pendingUnits + (row._sum.units ?? 0));
      byDepartment.set(key, entry);
    }

    // ---- monthly trend, zero-filled across the (bounded) range so charts stay continuous ----
    // Grouped by (startDate, status) in PostgreSQL: at most ~730 dates × 4 statuses for the 24-month cap, so the
    // month bucketing below works on a small grouped set, never on raw request rows.
    const byDateStatus = await prisma.leaveRequest.groupBy({ by: ['startDate', 'status'], where, _count: { _all: true }, _sum: { units: true } });
    const trendMap = new Map<string, LeaveReportTrendPointDto>(months.map((m) => [m, { month: m, submittedRequests: 0, approvedRequests: 0, approvedUnits: 0, pendingUnits: 0 }]));
    for (const row of byDateStatus) {
      const point = trendMap.get(row.startDate.slice(0, 7));
      if (!point) continue;
      point.submittedRequests += row._count._all;
      if (row.status === ST.APPROVED) { point.approvedRequests += row._count._all; point.approvedUnits = halfRound(point.approvedUnits + (row._sum.units ?? 0)); }
      if (row.status === ST.PENDING) point.pendingUnits = halfRound(point.pendingUnits + (row._sum.units ?? 0));
    }

    const buckets: LeaveReportAgingBucketDto[] = [
      { bucket: '0-2', label: '0–2 days', count: aging0to2 },
      { bucket: '3-7', label: '3–7 days', count: aging3to7 },
      { bucket: '8+', label: '8+ days', count: aging8plus },
    ];

    return {
      period: { from: q.from, to: q.to, attribution: LEAVE_REPORT_ATTRIBUTION },
      summary,
      byLeaveType: [...byLeaveType.values()].sort((a, b) => b.approvedUnits - a.approvedUnits || a.name.localeCompare(b.name)),
      trend: [...trendMap.values()],
      byDepartment: [...byDepartment.values()].sort((a, b) => b.approvedUnits - a.approvedUnits || a.departmentName.localeCompare(b.departmentName)),
      pendingAging: buckets,
    };
  },

  /**
   * Filter options for the reports screen, derived from the leave requests the caller can see plus the active leave
   * types — so a manager needs no organization-admin permission to filter their own report.
   */
  async options(auth: AuthContext): Promise<LeaveReportOptionsDto> {
    const scoped: Prisma.LeaveRequestWhereInput = { AND: [{ employee: employeeScopeWhere(auth) }, { status: { in: REPORTED_STATUSES } }] };
    const [leaveTypes, orgRows, deptRows] = await Promise.all([
      prisma.leaveType.findMany({ where: { isActive: true }, select: { id: true, code: true, name: true }, orderBy: { code: 'asc' } }),
      prisma.leaveRequest.findMany({ where: scoped, select: { organizationId: true }, distinct: ['organizationId'] }),
      prisma.leaveRequest.findMany({ where: scoped, select: { departmentId: true }, distinct: ['departmentId'] }),
    ]);
    const orgIds = orgRows.map((r) => r.organizationId).filter((v): v is string => !!v);
    const deptIds = deptRows.map((r) => r.departmentId).filter((v): v is string => !!v);
    const [organizations, departments] = await Promise.all([
      orgIds.length ? prisma.organization.findMany({ where: { id: { in: orgIds } }, select: { id: true, name: true }, orderBy: { name: 'asc' } }) : [],
      deptIds.length ? prisma.department.findMany({ where: { id: { in: deptIds } }, select: { id: true, name: true }, orderBy: { name: 'asc' } }) : [],
    ]);
    return { leaveTypes, organizations, departments };
  },
};
