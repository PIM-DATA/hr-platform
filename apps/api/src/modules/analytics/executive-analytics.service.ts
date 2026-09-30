import { Prisma } from '@prisma/client';
import { MAX_REPORT_MONTHS, PERMISSIONS, monthsSpan, payrollPeriodLabel, type AnalyticsFilter, type AttendanceReportDto, type ExecutiveOverviewDto, type ExecutiveSectionKey, type ExecutiveSectionStatus, type OvertimeReportDto, type PayrollAggregateDto, type WorkforceAnalyticsDto } from '@hr/shared';
import { prisma } from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { hasPermission } from '../../services/authorization/authorization.service';
import type { AuthContext } from '../auth/auth.types';
import { leaveReportsService } from '../leave/leave-reports.service';
import { attendanceRecordsService } from '../attendance/attendance-records.service';
import { overtimeService } from '../attendance/overtime.service';
import { performanceCycleService } from '../performance/performance-master.service';
import { performanceReportService } from '../performance/performance-report.service';
import { skillGapService } from '../competency/skill-gap.service';
import { trainingReportService } from '../training/training-report.service';
import { recruitmentReportService } from '../recruitment/report.service';
import { erReportService } from '../employee-relations/er-report.service';
import { talentReportService } from '../talent/talent-report.service';
import { payrollRunService } from '../payroll/payroll-run.service';
import { domainRollups, mayRollup, type RollupKey } from './domain-rollups';

/**
 * Executive analytics — organization-level aggregates, composed from the domain report services.
 *
 * No calculation is reimplemented here: leave numbers are the leave report's, training completion is Task 25's
 * definition, time to hire is Task 27's. Each domain keeps its own attribution (a performance plan counts in the
 * department it was created in; headcount counts the department of today), and the metric dictionary says so.
 * Employee-level rows that a domain report returns are aggregated and discarded before anything leaves this
 * service — there is no name, code, id or comment in the payload, and a test walks the response to prove it.
 * Payroll totals need a second permission and are organization-level only.
 */
const log = logger.child({ module: 'analytics' });
type Sections = ExecutiveOverviewDto['sections'];

async function part<T>(name: string, run: () => Promise<T>): Promise<T | null> {
  try { return await run(); } catch (e) { log.warn({ section: name, error: e instanceof Error ? e.message : String(e) }, 'executive section failed'); return null; }
}

/**
 * A Task 42 roll-up: the source module's report permission first, then the filter (these domains are never split
 * by department or job — a small group would reveal a person), then the call. The status says which one applied.
 */
async function rollup<T>(auth: AuthContext, key: RollupKey, applicable: boolean, run: () => Promise<T>): Promise<[T | null, ExecutiveSectionStatus]> {
  if (!mayRollup(auth, key)) return [null, 'NOT_AUTHORIZED'];
  if (!applicable) return [null, 'NOT_APPLICABLE_TO_FILTER'];
  const v = await part(key, run);
  return [v, v === null ? 'UNAVAILABLE' : 'OK'];
}

const monthsIn = (from: string, to: string): string[] => {
  const out: string[] = [];
  const [fy, fm] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  for (let y = fy!, m = fm!; y < ty! || (y === ty && m <= tm!); m === 12 ? (y += 1, m = 1) : (m += 1)) out.push(`${y}-${String(m).padStart(2, '0')}`);
  return out;
};

/** The population filter on the employee master: current organization / department / job. */
const employeeWhere = (f: AnalyticsFilter): Prisma.EmployeeWhereInput => ({
  organizationId: f.organizationId,
  departmentId: f.departmentId,
  ...(f.jobId ? { position: { jobId: f.jobId } } : {}),
});

async function workforce(f: AnalyticsFilter): Promise<WorkforceAnalyticsDto> {
  const base = employeeWhere(f);
  const active: Prisma.EmployeeWhereInput = { ...base, employmentStatus: 'ACTIVE' };
  const from = new Date(`${f.from}T00:00:00.000Z`);
  const to = new Date(`${f.to}T23:59:59.999Z`);
  const [byStatus, byOrg, byDept, byJob, byType, newHireRows, moves, terminations] = await Promise.all([
    prisma.employee.groupBy({ by: ['employmentStatus'], where: base, _count: { _all: true }, orderBy: { employmentStatus: 'asc' } }),
    prisma.employee.groupBy({ by: ['organizationId'], where: active, _count: { _all: true }, orderBy: { organizationId: 'asc' } }),
    prisma.employee.groupBy({ by: ['departmentId'], where: active, _count: { _all: true }, orderBy: { departmentId: 'asc' } }),
    prisma.position.findMany({ where: { employees: { some: active } }, select: { jobId: true, job: { select: { title: true } }, _count: { select: { employees: { where: active } } } } }),
    prisma.employee.groupBy({ by: ['employmentType'], where: active, _count: { _all: true }, orderBy: { employmentType: 'asc' } }),
    prisma.employee.findMany({ where: { ...base, hireDate: { gte: from, lte: to } }, select: { hireDate: true } }),
    // Position-history rows that started in the range and were not the first assignment: a move, not a hire.
    prisma.employeePosition.findMany({ where: { employee: base, startDate: { gte: from, lte: to } }, select: { employeeId: true, departmentId: true, startDate: true } }),
    prisma.employee.count({ where: { ...base, terminationDate: { gte: from, lte: to } } }),
  ]);
  const orgNames = new Map((await prisma.organization.findMany({ where: { id: { in: byOrg.map((o) => o.organizationId) } }, select: { id: true, name: true } })).map((o) => [o.id, o.name]));
  const deptNames = new Map((await prisma.department.findMany({ where: { id: { in: byDept.map((d) => d.departmentId) } }, select: { id: true, name: true } })).map((d) => [d.id, d.name]));
  const count = (status: string) => byStatus.find((s) => s.employmentStatus === status)?._count._all ?? 0;
  const jobs = new Map<string, number>();
  for (const p of byJob) { const k = p.job?.title ?? 'No job'; jobs.set(k, (jobs.get(k) ?? 0) + p._count.employees); }
  // A move needs an earlier row for the same employee; the first row ever is the hire.
  let positionMoves = 0, departmentMoves = 0;
  if (moves.length) {
    const earlier = await prisma.employeePosition.findMany({ where: { employeeId: { in: [...new Set(moves.map((m) => m.employeeId))] } }, select: { employeeId: true, departmentId: true, startDate: true }, orderBy: { startDate: 'asc' } });
    for (const m of moves) {
      const prev = earlier.filter((e) => e.employeeId === m.employeeId && e.startDate < m.startDate).pop();
      if (!prev) continue;
      positionMoves += 1;
      if (prev.departmentId !== m.departmentId) departmentMoves += 1;
    }
  }
  const months = monthsIn(f.from, f.to);
  return {
    headcount: { active: count('ACTIVE'), inactive: count('INACTIVE'), terminated: count('TERMINATED'), total: byStatus.reduce((n, s) => n + s._count._all, 0) },
    byOrganization: byOrg.map((o) => ({ name: orgNames.get(o.organizationId) ?? 'Unknown', active: o._count._all })).sort((a, b) => b.active - a.active),
    byDepartment: byDept.map((d) => ({ name: deptNames.get(d.departmentId) ?? 'Unknown', active: d._count._all })).sort((a, b) => b.active - a.active),
    byJob: [...jobs.entries()].map(([name, active]) => ({ name, active })).sort((a, b) => b.active - a.active),
    byEmploymentType: byType.map((t) => ({ type: t.employmentType, active: t._count._all })),
    newHires: newHireRows.length,
    newHiresByMonth: months.map((month) => ({ month, count: newHireRows.filter((r) => r.hireDate.toISOString().slice(0, 7) === month).length })),
    positionMoves, departmentMoves,
    terminations: terminations,
    terminationsNote: 'Counted from terminationDate where it was recorded; there is no termination workflow, so this is a lower bound and no trend is inferred.',
  };
}

/** Per-department aggregation of an employee-row report, then the rows are dropped. */
async function departmentsFor(f: AnalyticsFilter) {
  return prisma.department.findMany({ where: { id: f.departmentId, organizationId: f.organizationId, isActive: true }, select: { id: true, name: true }, orderBy: { name: 'asc' } });
}

async function attendanceAggregate(auth: AuthContext, f: AnalyticsFilter): Promise<Sections['attendance']> {
  const departments = await departmentsFor(f);
  const zero = (): AttendanceReportDto['totals'] => ({ scheduledDays: 0, presentDays: 0, lateDays: 0, absentDays: 0, leaveDays: 0, incompleteDays: 0, workMinutes: 0, lateMinutes: 0 });
  const totals = zero();
  let employees = 0;
  const byDepartment: NonNullable<Sections['attendance']>['byDepartment'] = [];
  for (const d of departments) {
    // Task 48 (T44-P1-13): the full department from one SQL aggregate — no employee rows, no first-500 page.
    const r = await attendanceRecordsService.summary(auth, { from: f.from, to: f.to, departmentId: d.id });
    if (r.totalEmployees === 0) continue;
    employees += r.totalEmployees;
    for (const k of Object.keys(totals) as (keyof AttendanceReportDto['totals'])[]) totals[k] += r.totals[k];
    byDepartment.push({ departmentName: d.name, scheduledDays: r.totals.scheduledDays, presentDays: r.totals.presentDays, lateDays: r.totals.lateDays, absentDays: r.totals.absentDays, leaveDays: r.totals.leaveDays, incompleteDays: r.totals.incompleteDays });
  }
  return { totals, employees, byDepartment };
}

async function overtimeAggregate(auth: AuthContext, f: AnalyticsFilter): Promise<Sections['overtime']> {
  const departments = await departmentsFor(f);
  const totals: OvertimeReportDto['totals'] = { requests: 0, approvedRequests: 0, approvedMinutes: 0, byDayType: { WORKDAY: 0, OFF_DAY: 0, HOLIDAY: 0 } };
  const byDepartment: NonNullable<Sections['overtime']>['byDepartment'] = [];
  const note = 'Minutes and multipliers only — this release calculates no monetary overtime.';
  for (const d of departments) {
    const r = await overtimeService.summary(auth, { from: f.from, to: f.to, departmentId: d.id });
    if (r.totalEmployees === 0) continue;
    totals.requests += r.totals.requests; totals.approvedRequests += r.totals.approvedRequests; totals.approvedMinutes += r.totals.approvedMinutes;
    totals.byDayType.WORKDAY += r.totals.byDayType.WORKDAY; totals.byDayType.OFF_DAY += r.totals.byDayType.OFF_DAY; totals.byDayType.HOLIDAY += r.totals.byDayType.HOLIDAY;
    byDepartment.push({ departmentName: d.name, requests: r.totals.requests, approvedMinutes: r.totals.approvedMinutes });
  }
  return { totals, byDepartment, note };
}

async function performanceAggregate(f: AnalyticsFilter): Promise<Sections['performance']> {
  const cycles = (await performanceCycleService.list({ organizationId: f.organizationId, page: 1, pageSize: 100 })).data.filter((c) => c.periodStart <= f.to && c.periodEnd >= f.from);
  const reports = await Promise.all(cycles.map((c) => performanceReportService.cycleReport(c.id, f.departmentId)));
  return { cycles: reports.map((r) => ({ cycle: r.cycle, completion: r.completion, averageFinalScore: r.averageFinalScore, suppression: r.suppression, ratingDistribution: r.ratingDistribution, byDepartment: r.byDepartment })) };
}

async function payrollAggregate(f: AnalyticsFilter): Promise<PayrollAggregateDto> {
  // Task 48 (T44-P2-15): payroll's own currency-keyed source. Before, every closed run was added into one total and
  // labelled with a single run's currency (THB + USD shown as "USD").
  const [fy, fm] = f.from.split('-').map(Number);
  const [ty, tm] = f.to.split('-').map(Number);
  return payrollRunService.closedTotals({ organizationId: f.organizationId, from: { year: fy!, month: fm! }, to: { year: ty!, month: tm! } });
}

export const executiveAnalyticsService = {
  async options() {
    const [organizations, departments, jobs] = await Promise.all([
      prisma.organization.findMany({ where: { isActive: true }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
      prisma.department.findMany({ where: { isActive: true }, select: { id: true, name: true, organizationId: true }, orderBy: { name: 'asc' } }),
      prisma.job.findMany({ where: { isActive: true }, select: { id: true, title: true }, orderBy: { title: 'asc' } }),
    ]);
    return { organizations, departments, jobs };
  },

  async overview(auth: AuthContext, f: AnalyticsFilter): Promise<ExecutiveOverviewDto> {
    const started = Date.now();
    const [organization, department, job] = await Promise.all([
      f.organizationId ? prisma.organization.findUnique({ where: { id: f.organizationId }, select: { name: true } }) : null,
      f.departmentId ? prisma.department.findUnique({ where: { id: f.departmentId }, select: { name: true } }) : null,
      f.jobId ? prisma.job.findUnique({ where: { id: f.jobId }, select: { title: true } }) : null,
    ]);
    // The leave report has its own range limit; a longer dashboard range is clamped to its most recent months.
    const leaveFrom = monthsSpan(f.from, f.to) > MAX_REPORT_MONTHS ? `${monthsIn(f.from, f.to).slice(-MAX_REPORT_MONTHS)[0]}-01` : f.from;
    const payrollAllowed = hasPermission(auth, PERMISSIONS.ANALYTICS_VIEW_PAYROLL_AGGREGATE);

    const orgLevel = !f.departmentId && !f.jobId;
    const range = { from: f.from, to: f.to, organizationId: f.organizationId };
    // Started before the older sections are awaited so both batches run concurrently.
    const rollups = Promise.all([
      rollup(auth, 'benefits', orgLevel, () => domainRollups.benefits(range)),
      rollup(auth, 'expense', orgLevel, () => domainRollups.expense(range)),
      rollup(auth, 'employeeServices', orgLevel, () => domainRollups.employeeServices(range)),
      rollup(auth, 'lifecycle', orgLevel, () => domainRollups.lifecycle(auth, range)),
      rollup(auth, 'learning', orgLevel, () => domainRollups.learning(auth, range)),
      rollup(auth, 'workforcePlanning', orgLevel, () => domainRollups.workforcePlanning(auth, range)),
      // Engagement results have no organization dimension on the dashboard; any population filter hides the section.
      rollup(auth, 'engagement', orgLevel && !f.organizationId, () => domainRollups.engagement(auth)),
    ]);
    const [wf, leave, attendance, overtime, performance, competency, training, recruitment, employeeRelations, talent, payroll] = await Promise.all([
      workforce(f),
      part('leave', () => leaveReportsService.overview(auth, { from: leaveFrom, to: f.to, organizationId: f.organizationId, departmentId: f.departmentId })),
      part('attendance', () => attendanceAggregate(auth, f)),
      part('overtime', () => overtimeAggregate(auth, f)),
      part('performance', () => performanceAggregate(f)),
      part('competency', () => skillGapService.gapReport({ organizationId: f.organizationId, departmentId: f.departmentId, jobId: f.jobId })),
      part('training', () => trainingReportService.report({ from: f.from, to: f.to, departmentId: f.departmentId })),
      part('recruitment', () => recruitmentReportService.report({ from: f.from, to: f.to, organizationId: f.organizationId })),
      part('employeeRelations', () => erReportService.report({ from: f.from, to: f.to, departmentId: f.departmentId })),
      part('talent', async () => ({ talent: await talentReportService.talent(), succession: await talentReportService.succession() })),
      payrollAllowed ? part('payroll', () => payrollAggregate(f)) : Promise.resolve(null),
    ]);
    const [[benefits, sBenefits], [expense, sExpense], [employeeServices, sServices], [lifecycle, sLifecycle], [learning, sLearning], [workforcePlanning, sWorkforcePlanning], [engagement, sEngagement]] = await rollups;
    const loaded = (v: unknown): ExecutiveSectionStatus => (v === null ? 'UNAVAILABLE' : 'OK');
    const sectionStatus: Record<ExecutiveSectionKey, ExecutiveSectionStatus> = {
      workforce: 'OK', leave: loaded(leave), attendance: loaded(attendance), overtime: loaded(overtime), performance: loaded(performance), competency: loaded(competency), training: loaded(training), recruitment: loaded(recruitment), employeeRelations: loaded(employeeRelations), talent: loaded(talent),
      payroll: payrollAllowed ? loaded(payroll) : 'NOT_AUTHORIZED',
      benefits: sBenefits, expense: sExpense, employeeServices: sServices, lifecycle: sLifecycle, learning: sLearning, workforcePlanning: sWorkforcePlanning, engagement: sEngagement,
    };
    return {
      filters: { ...f, organizationName: organization?.name ?? null, departmentName: department?.name ?? null, jobTitle: job?.title ?? null },
      sections: { workforce: wf, leave, attendance, overtime, performance, competency, training, recruitment, employeeRelations, talent, payroll, benefits, expense, employeeServices, lifecycle, learning, workforcePlanning, engagement },
      sectionStatus,
      generatedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
    };
  },
};
