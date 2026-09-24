import { z } from 'zod';
import { ANALYTICS_METRICS, COPILOT_LIMITS, PERMISSIONS, reportDefinitionSchema, type CopilotSourceDto } from '@hr/shared';
import { prisma } from '../../lib/prisma';
import { AppError } from '../../lib/errors';
import { hasPermission } from '../../services/authorization/authorization.service';
import type { AuthContext } from '../auth/auth.types';
import { employee360Service } from '../analytics/employee360.service';
import { executiveAnalyticsService } from '../analytics/executive-analytics.service';
import { reportsService } from '../reports/reports.service';
import { getDataset } from '../reports/registry';
import { documentService } from '../documents/documents.service';
import { leaveRequestsService } from '../leave/leave-requests.service';
import { attendanceRecordsService } from '../attendance/attendance-records.service';
import { trainingReportService } from '../training/training-report.service';
import { recruitmentReportService } from '../recruitment/report.service';
import { talentReportService } from '../talent/talent-report.service';
import { skillGapService } from '../competency/skill-gap.service';
import { employeesService } from '../employees/employees.service';

/**
 * The copilot tool registry — server-owned, allow-listed, read-only.
 *
 * A tool is a thin adapter over an existing service, called with the authenticated actor and nothing else: no
 * scope, employee or permission can arrive in the arguments (schemas are strict). Each result is minimized before
 * it goes anywhere near the model — codes rather than names where a name is not needed, small bounded slices,
 * counts instead of lists — and carries the source metadata the answer will cite. There is no tool that writes.
 */
export interface ToolContext { auth: AuthContext; actor: { auth: AuthContext; ipAddress: string | null; userAgent: string | null }; requestId: string }
export interface ToolResult { data: unknown; sources: CopilotSourceDto[]; consulted: string; reportDraft?: { datasetId: string; datasetName: string; definition: z.infer<typeof reportDefinitionSchema>; rowCount: number; truncated: boolean } }
export interface CopilotTool {
  id: string;
  description: string;
  /** Shown to the user while the tool runs, e.g. "กำลังตรวจข้อมูลวันลา…". Never the tool id. */
  statusLabel: string;
  inputSchema: z.ZodTypeAny;
  /** Any of these opens the tool; the handler then re-applies the source module's scope. */
  requiredPermissions: string[];
  /**
   * PERSON tools answer about one employee (the actor by default) and are offered only to accounts linked to an
   * employee record or holding an HR operational permission — an executive with read permissions for aggregate
   * dashboards is not handed per-person lookups. TEAM tools need a linked employee. ORG tools are aggregate.
   */
  audience: 'PERSON' | 'TEAM' | 'ORG';
  sensitivity: 'NORMAL' | 'PERSONAL' | 'SENSITIVE' | 'AGGREGATE';
  maxRows: number;
  sourceLabel: string;
  handler(args: unknown, ctx: ToolContext): Promise<ToolResult>;
}

const today = () => new Date().toISOString().slice(0, 10);
const asOfNow = () => new Date().toISOString();
const src = (label: string, module: string, asOf: string | null, deepLink: string | null, metricDefinition?: string): CopilotSourceDto => ({ label, module, asOf, deepLink, ...(metricDefinition ? { metricDefinition } : {}) });
const link = (auth: AuthContext, permission: string | string[], to: string) => ((Array.isArray(permission) ? permission : [permission]).some((p) => hasPermission(auth, p)) ? to : null);

/** The employee the question is about: the actor unless a lookup is given, and only if the actor may open them. */
async function resolveEmployee(ctx: ToolContext, lookup?: { employeeId?: string; employeeCode?: string }): Promise<{ id: string; employeeCode: string; self: boolean }> {
  if (!lookup?.employeeId && !lookup?.employeeCode) {
    if (!ctx.auth.employeeId) throw new AppError(409, 'EMPLOYEE_PROFILE_REQUIRED', 'Your account is not linked to an employee record');
    const me = await prisma.employee.findUniqueOrThrow({ where: { id: ctx.auth.employeeId }, select: { id: true, employeeCode: true } });
    return { ...me, self: true };
  }
  const found = lookup.employeeId ? await prisma.employee.findUnique({ where: { id: lookup.employeeId }, select: { id: true } }) : await prisma.employee.findUnique({ where: { employeeCode: lookup.employeeCode!.toUpperCase() }, select: { id: true } });
  if (!found) throw new AppError(404, 'EMPLOYEE_NOT_FOUND', 'Employee not found');
  // The employee module decides whether this actor may see that person at all (scope → 404).
  const detail = await employeesService.getById(ctx.auth, found.id);
  return { id: detail.id, employeeCode: detail.employeeCode, self: detail.id === ctx.auth.employeeId };
}
const lookupSchema = z.object({ employeeId: z.string().min(1).optional(), employeeCode: z.string().min(1).max(30).optional() }).strict();
async function section(ctx: ToolContext, lookup: { employeeId?: string; employeeCode?: string } | undefined) {
  const who = await resolveEmployee(ctx, lookup);
  const d = await employee360Service.getOverview({ employeeId: who.id, actor: ctx.actor });
  return { who, d };
}

const tools: CopilotTool[] = [
  {
    id: 'employee_self_summary', description: 'The signed-in employee\'s own record: current job, department, manager, hire date, and their own closed payslip periods (net amount only). Use for "my profile" and "my latest payslip" questions. Never for another person.',
    statusLabel: 'กำลังดูข้อมูลส่วนตัวของคุณ…', inputSchema: z.object({}).strict(), requiredPermissions: [PERMISSIONS.EMPLOYEE360_VIEW], sensitivity: 'PERSONAL', audience: 'PERSON', maxRows: 6, sourceLabel: 'Employee record',
    async handler(_args, ctx) {
      const { who, d } = await section(ctx, undefined);
      const p = d.profile;
      return {
        data: { employeeCode: who.employeeCode, position: p.position.title, department: p.department.name, organization: p.organization.name, manager: p.manager ? p.manager.employeeCode : null, hireDate: p.hireDate.slice(0, 10), employmentStatus: p.employmentStatus, payslips: d.sections.payroll?.mode === 'SELF' ? d.sections.payroll.payslips.map((x) => ({ period: x.periodLabel, netPay: x.netPay, currency: x.currencyCode })) : null },
        sources: [src('Employee record', 'employees', asOfNow(), `/employees/${who.id}`), ...(d.sections.payroll?.mode === 'SELF' ? [src('My payslips (closed runs)', 'payroll', asOfNow(), link(ctx.auth, PERMISSIONS.PAYROLL_VIEW_OWN, '/hrm/payroll'))] : [])],
        consulted: 'ข้อมูลพนักงาน',
      };
    },
  },
  {
    id: 'employee360_summary', description: 'A summary of one employee the user is allowed to open (default: themselves): job, department, and which sections of their Employee 360 are available. Use employeeCode for a colleague only when the user manages them or holds HR permissions; the tool refuses otherwise.',
    statusLabel: 'กำลังดู Employee 360…', inputSchema: lookupSchema, requiredPermissions: [PERMISSIONS.EMPLOYEE360_VIEW], sensitivity: 'PERSONAL', audience: 'PERSON', maxRows: 1, sourceLabel: 'Employee 360',
    async handler(args, ctx) {
      const { who, d } = await section(ctx, args as { employeeId?: string; employeeCode?: string });
      return {
        data: { employeeCode: who.employeeCode, position: d.profile.position.title, department: d.profile.department.name, hireDate: d.profile.hireDate.slice(0, 10), availableSections: d.visibleSections.filter((s) => !['employeeRelations', 'talent', 'recruitment', 'payroll'].includes(s)), recentActivity: d.activity.slice(0, 5).map((a) => ({ date: a.date, domain: a.domain, title: a.title })) },
        sources: [src('Employee 360', 'employee360', d.generatedAt, `/employees/${who.id}`)], consulted: 'Employee 360',
      };
    },
  },
  {
    id: 'leave_balance_and_recent', description: 'Leave balances for this year (available, used per leave type), request counts and the most recent requests for the employee (default: the user).',
    statusLabel: 'กำลังตรวจข้อมูลวันลา…', inputSchema: lookupSchema, requiredPermissions: [PERMISSIONS.LEAVE_VIEW, PERMISSIONS.LEAVE_REQUEST], sensitivity: 'PERSONAL', audience: 'PERSON', maxRows: 10, sourceLabel: 'Leave',
    async handler(args, ctx) {
      const { who, d } = await section(ctx, args as { employeeId?: string; employeeCode?: string });
      const l = d.sections.leave;
      if (!l) return { data: null, sources: [], consulted: 'วันลา' };
      return {
        data: { employeeCode: who.employeeCode, year: l.year, balances: l.balances.map((b) => ({ leaveType: b.leaveType.name, available: b.available, used: b.used, periodEnd: b.periodEnd })), summary: l.summary, recent: l.recent.slice(0, 5).map((r) => ({ leaveType: r.leaveType.name, startDate: r.startDate, endDate: r.endDate, units: r.units, status: r.status })) },
        sources: [src(`Leave balance · ${l.year}`, 'leave', asOfNow(), link(ctx.auth, [PERMISSIONS.LEAVE_VIEW, PERMISSIONS.LEAVE_REQUEST], '/hrm/leave'))], consulted: 'วันลา',
      };
    },
  },
  {
    id: 'attendance_summary', description: 'This month\'s attendance totals (present, late, absent, leave, incomplete days, worked minutes) and the last ten days for the employee (default: the user).',
    statusLabel: 'กำลังดูข้อมูล Attendance…', inputSchema: lookupSchema, requiredPermissions: [PERMISSIONS.ATTENDANCE_VIEW, PERMISSIONS.ATTENDANCE_CLOCK], sensitivity: 'PERSONAL', audience: 'PERSON', maxRows: 10, sourceLabel: 'Attendance',
    async handler(args, ctx) {
      const { who, d } = await section(ctx, args as { employeeId?: string; employeeCode?: string });
      const a = d.sections.attendance;
      if (!a) return { data: null, sources: [], consulted: 'Attendance' };
      return { data: { employeeCode: who.employeeCode, period: { from: a.from, to: a.to }, totals: a.totals, recent: a.recent }, sources: [src(`Attendance · ${a.from.slice(0, 7)}`, 'attendance', asOfNow(), link(ctx.auth, [PERMISSIONS.ATTENDANCE_VIEW, PERMISSIONS.ATTENDANCE_CLOCK], '/hrm/attendance'))], consulted: 'Attendance' };
    },
  },
  {
    id: 'overtime_summary', description: 'This year\'s overtime claims and approved minutes for the employee (default: the user). Minutes only — never money.',
    statusLabel: 'กำลังดูข้อมูลโอที…', inputSchema: lookupSchema, requiredPermissions: [PERMISSIONS.OT_VIEW, PERMISSIONS.OT_REQUEST], sensitivity: 'PERSONAL', audience: 'PERSON', maxRows: 5, sourceLabel: 'Overtime',
    async handler(args, ctx) {
      const { who, d } = await section(ctx, args as { employeeId?: string; employeeCode?: string });
      const o = d.sections.overtime;
      if (!o) return { data: null, sources: [], consulted: 'โอที' };
      return { data: { employeeCode: who.employeeCode, period: { from: o.from, to: o.to }, requests: o.requests, approvedRequests: o.approvedRequests, approvedMinutes: o.approvedMinutes, note: o.note }, sources: [src(`Overtime · ${o.from.slice(0, 4)}`, 'overtime', asOfNow(), link(ctx.auth, [PERMISSIONS.OT_VIEW, PERMISSIONS.OT_REQUEST], '/hrm/attendance'))], consulted: 'โอที' };
    },
  },
  {
    id: 'performance_summary', description: 'The latest finalized performance review (cycle, weighted score, rating, department at the time of the plan) and review history for the employee (default: the user). No comments.',
    statusLabel: 'กำลังดูผลการประเมิน…', inputSchema: lookupSchema, requiredPermissions: [PERMISSIONS.PERFORMANCE_VIEW], sensitivity: 'SENSITIVE', audience: 'PERSON', maxRows: 10, sourceLabel: 'Performance',
    async handler(args, ctx) {
      const { who, d } = await section(ctx, args as { employeeId?: string; employeeCode?: string });
      const p = d.sections.performance;
      if (!p) return { data: null, sources: [], consulted: 'ผลการประเมิน' };
      const brief = (h: NonNullable<typeof p.latest>) => ({ cycle: h.cycle.name, status: h.status, weightedScore: h.weightedScore, maxScore: h.cycle.maxScore, rating: h.ratingLabel, departmentAtPlan: h.snapshot.departmentName, finalizedAt: h.finalizedAt?.slice(0, 10) ?? null });
      return { data: { employeeCode: who.employeeCode, latestFinalized: p.latest ? brief(p.latest) : null, history: p.history.slice(0, 10).map(brief), note: 'departmentAtPlan is the department when the plan was created (historical snapshot), not necessarily the current department.' }, sources: [src(p.latest ? `Performance · ${p.latest.cycle.name}` : 'Performance', 'performance', p.latest?.finalizedAt ?? asOfNow(), link(ctx.auth, PERMISSIONS.PERFORMANCE_VIEW, '/hrm/performance'))], consulted: 'ผลการประเมิน' };
    },
  },
  {
    id: 'competency_skill_gap', description: 'The employee\'s current skill profile against their job: each required competency with current level, required level, gap and status (UNASSESSED means not assessed, not zero). Default: the user.',
    statusLabel: 'กำลังดู skill gap…', inputSchema: lookupSchema, requiredPermissions: [PERMISSIONS.COMPETENCY_VIEW], sensitivity: 'PERSONAL', audience: 'PERSON', maxRows: 30, sourceLabel: 'Competency',
    async handler(args, ctx) {
      const { who, d } = await section(ctx, args as { employeeId?: string; employeeCode?: string });
      const c = d.sections.competency;
      if (!c) return { data: null, sources: [], consulted: 'สมรรถนะ' };
      return { data: { employeeCode: who.employeeCode, job: c.job?.title ?? null, summary: c.summary, competencies: c.entries.slice(0, 30).map((e) => ({ competency: e.competencyName, currentLevel: e.currentLevel, requiredLevel: e.requiredLevel, gapNeeded: e.gapNeeded, status: e.gapStatus })) }, sources: [src('Competency profile (current job)', 'competency', asOfNow(), link(ctx.auth, PERMISSIONS.COMPETENCY_VIEW, '/hrd/competency'))], consulted: 'สมรรถนะ' };
    },
  },
  {
    id: 'training_development_summary', description: 'Training and development for the employee (default: the user): open development needs, active development plan, upcoming training, recently completed courses, training hours.',
    statusLabel: 'กำลังดูข้อมูลการอบรม…', inputSchema: lookupSchema, requiredPermissions: [PERMISSIONS.TRAINING_VIEW], sensitivity: 'PERSONAL', audience: 'PERSON', maxRows: 15, sourceLabel: 'Training',
    async handler(args, ctx) {
      const { who, d } = await section(ctx, args as { employeeId?: string; employeeCode?: string });
      const t = d.sections.development;
      if (!t) return { data: null, sources: [], consulted: 'การอบรม' };
      return { data: { employeeCode: who.employeeCode, summary: t.summary, activeIdp: t.activeIdp ? { title: t.activeIdp.title, periodStart: t.activeIdp.periodStart, periodEnd: t.activeIdp.periodEnd } : null, openNeeds: t.openNeeds.slice(0, 10).map((n) => ({ title: n.title, status: n.status, priority: n.priority, competency: n.competencyName })), upcoming: t.upcoming.slice(0, 5), recentCompleted: t.recentCompleted.slice(0, 5) }, sources: [src('Training & development', 'training', asOfNow(), link(ctx.auth, PERMISSIONS.TRAINING_VIEW, '/hrd/training'))], consulted: 'การอบรม' };
    },
  },
  {
    id: 'career_readiness', description: 'Career paths from the employee\'s job and readiness against each next job: which competency requirements are met, which have gaps, which are not assessed. Facts only — never a promotion recommendation. Default: the user.',
    statusLabel: 'กำลังดูเส้นทางอาชีพ…', inputSchema: lookupSchema, requiredPermissions: [PERMISSIONS.CAREER_VIEW], sensitivity: 'PERSONAL', audience: 'PERSON', maxRows: 10, sourceLabel: 'Career',
    async handler(args, ctx) {
      const { who, d } = await section(ctx, args as { employeeId?: string; employeeCode?: string });
      const c = d.sections.career;
      if (!c) return { data: null, sources: [], consulted: 'เส้นทางอาชีพ' };
      return { data: { employeeCode: who.employeeCode, currentJob: c.currentJob?.title ?? null, paths: c.paths.map((p) => ({ name: p.name, steps: p.steps.map((s) => `${s.fromJob.title} → ${s.toJob.title}`) })), nextJobs: c.nextJobs.slice(0, 5).map((n) => ({ targetJob: n.targetJob.title, status: n.status, summary: n.summary, gaps: n.competencies.filter((x) => x.status === 'GAP').map((x) => ({ competency: x.competencyName, currentLevel: x.currentLevel, requiredLevel: x.requiredLevel, gapNeeded: x.gapNeeded })), notAssessed: n.competencies.filter((x) => x.status === 'UNASSESSED').map((x) => x.competencyName) })), note: 'READY_REQUIREMENTS_MET describes competency requirements only; it is not a promotion decision.' }, sources: [src('Career readiness', 'talent', asOfNow(), link(ctx.auth, PERMISSIONS.CAREER_VIEW, '/hrd/career'))], consulted: 'เส้นทางอาชีพ' };
    },
  },
  {
    id: 'team_summary', description: 'For a manager: today\'s picture of their direct reports — who is on approved leave today, today\'s attendance status counts and anyone absent or incomplete, pending performance reviews they must complete, and team training/development counts. Team scope only.',
    statusLabel: 'กำลังดูข้อมูลทีม…', inputSchema: z.object({}).strict(), requiredPermissions: [PERMISSIONS.LEAVE_VIEW, PERMISSIONS.ATTENDANCE_VIEW, PERMISSIONS.TRAINING_VIEW, PERMISSIONS.PERFORMANCE_VIEW], sensitivity: 'PERSONAL', audience: 'TEAM', maxRows: 30, sourceLabel: 'Team',
    async handler(_args, ctx) {
      const { auth } = ctx;
      if (!auth.employeeId) throw new AppError(409, 'EMPLOYEE_PROFILE_REQUIRED', 'Your account is not linked to an employee record');
      const t = today();
      const team = await prisma.employee.findMany({ where: { managerId: auth.employeeId, employmentStatus: 'ACTIVE' }, select: { id: true, employeeCode: true, firstName: true }, orderBy: { employeeCode: 'asc' }, take: 100 });
      const ids = new Set(team.map((e) => e.id));
      const sources: CopilotSourceDto[] = [];
      const data: Record<string, unknown> = { teamSize: team.length, date: t };
      if (hasPermission(auth, PERMISSIONS.LEAVE_VIEW)) {
        const leave = await leaveRequestsService.list(auth, { status: 'APPROVED', from: t, to: t, page: 1, pageSize: 100 });
        data.onLeaveToday = leave.data.filter((r) => ids.has(r.employee.id)).map((r) => ({ employeeCode: r.employee.employeeCode, firstName: r.employee.firstName, leaveType: r.leaveType.name, until: r.endDate }));
        sources.push(src(`Team leave · ${t}`, 'leave', asOfNow(), link(auth, PERMISSIONS.LEAVE_VIEW, '/hrm/leave')));
      }
      if (hasPermission(auth, PERMISSIONS.ATTENDANCE_VIEW)) {
        const att = await attendanceRecordsService.report(auth, { from: t, to: t });
        const rows = att.rows.filter((r) => ids.has(r.employee.id));
        data.attendanceToday = { present: rows.reduce((n, r) => n + r.presentDays, 0), late: rows.filter((r) => r.lateDays > 0).map((r) => r.employee.employeeCode), absent: rows.filter((r) => r.absentDays > 0).map((r) => r.employee.employeeCode), incomplete: rows.filter((r) => r.incompleteDays > 0).map((r) => r.employee.employeeCode), noRecordYet: team.length - rows.length };
        sources.push(src(`Team attendance · ${t}`, 'attendance', asOfNow(), link(auth, PERMISSIONS.ATTENDANCE_VIEW, '/hrm/attendance')));
      }
      if (hasPermission(auth, PERMISSIONS.PERFORMANCE_VIEW)) {
        const pending = await prisma.performancePlan.count({ where: { reviewerUserId: auth.userId, status: { in: ['ACTIVE', 'SELF_REVIEW', 'MANAGER_REVIEW'] } } });
        data.performanceReviewsPendingForMe = pending;
        sources.push(src('Performance reviews awaiting you', 'performance', asOfNow(), link(auth, PERMISSIONS.PERFORMANCE_VIEW, '/hrm/performance')));
      }
      if (hasPermission(auth, PERMISSIONS.TRAINING_VIEW)) {
        const td = await trainingReportService.teamDevelopment(auth);
        data.training = { openNeeds: td.openNeeds, activeIdps: td.activeIdps, upcomingSessions: td.upcomingSessions, completedTraining: td.completedTraining };
        sources.push(src('Team development', 'training', asOfNow(), link(auth, PERMISSIONS.TRAINING_VIEW, '/hrd/training/team')));
      }
      return { data, sources, consulted: 'ข้อมูลทีม' };
    },
  },
  {
    id: 'executive_hr_overview', description: 'Organization-level HR aggregates for a date range (default: this year): headcount and movements, leave, attendance, overtime, performance completion, competency coverage, training completion, recruitment funnel and time to hire, employee-relations counts, succession coverage. Counts only — no individual. Optional organizationId / departmentId filters.',
    statusLabel: 'กำลังสรุปภาพรวม HR…', inputSchema: z.object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), organizationId: z.string().min(1).optional(), departmentId: z.string().min(1).optional() }).strict(), requiredPermissions: [PERMISSIONS.ANALYTICS_VIEW_EXECUTIVE], sensitivity: 'AGGREGATE', audience: 'ORG', maxRows: 40, sourceLabel: 'Executive analytics',
    async handler(args, ctx) {
      const a = args as { from?: string; to?: string; organizationId?: string; departmentId?: string };
      const year = new Date().getUTCFullYear();
      const from = a.from ?? `${year}-01-01`; const to = a.to ?? today();
      const o = await executiveAnalyticsService.overview(ctx.auth, { from, to, organizationId: a.organizationId, departmentId: a.departmentId });
      const s = o.sections;
      const data = {
        range: { from, to }, filters: { organization: o.filters.organizationName, department: o.filters.departmentName },
        workforce: { headcount: s.workforce.headcount, newHires: s.workforce.newHires, positionMoves: s.workforce.positionMoves, terminations: s.workforce.terminations, byDepartment: s.workforce.byDepartment.slice(0, 15) },
        leave: s.leave ? s.leave.summary : null,
        attendance: s.attendance ? { employees: s.attendance.employees, ...s.attendance.totals } : null,
        overtime: s.overtime ? s.overtime.totals : null,
        performance: s.performance ? s.performance.cycles.map((c) => ({ cycle: c.cycle.name, status: c.cycle.status, ...c.completion, averageFinalScore: c.averageFinalScore })) : null,
        competency: s.competency ? { coverage: s.competency.coverage, totals: s.competency.totals, topGaps: s.competency.topGaps.slice(0, 5).map((g) => ({ competency: g.competencyName, belowRequirement: g.belowRequirement })) } : null,
        training: s.training ? { enrollments: s.training.enrollments, completionRate: s.training.completionRate, trainingHours: s.training.trainingHours, needs: s.training.needs, idps: s.training.idps } : null,
        recruitment: s.recruitment ? { funnel: s.recruitment.funnel, hires: s.recruitment.hires, averageTimeToHireDays: s.recruitment.averageTimeToHireDays, offers: s.recruitment.offers } : null,
        employeeRelations: s.employeeRelations ? s.employeeRelations.actions : null,
        talent: s.talent ? { succession: s.talent.succession.plans, criticalWithoutSuccessor: s.talent.succession.criticalWithoutSuccessor, nineBox: s.talent.talent.nineBox.filter((c) => c.count > 0) } : null,
        payroll: s.payroll ? { runs: s.payroll.runs, employeesPaid: s.payroll.employeesPaid, grossTotal: s.payroll.grossTotal, netTotal: s.payroll.netTotal, currency: s.payroll.currencyCode, note: s.payroll.note } : null,
      };
      const sources = [src(`Executive HR dashboard · ${from} → ${to}`, 'analytics', o.generatedAt, '/analytics/executive')];
      if (s.payroll) sources.push(src('Payroll totals (organization level)', 'payroll', o.generatedAt, link(ctx.auth, PERMISSIONS.PAYROLL_MANAGE, '/hrm/payroll')));
      return { data, sources, consulted: 'ภาพรวม HR' };
    },
  },
  {
    id: 'recruitment_summary', description: 'Recruitment aggregates for a date range (default: this year): funnel by stage, applications by source, interviews, offers, hires and average time to hire. Counts only, no candidate names.',
    statusLabel: 'กำลังดู recruitment funnel…', inputSchema: z.object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).strict(), requiredPermissions: [PERMISSIONS.RECRUITMENT_MANAGE], sensitivity: 'AGGREGATE', audience: 'ORG', maxRows: 20, sourceLabel: 'Recruitment',
    async handler(args, ctx) {
      const a = args as { from?: string; to?: string };
      const year = new Date().getUTCFullYear();
      const from = a.from ?? `${year}-01-01`; const to = a.to ?? today();
      const r = await recruitmentReportService.report({ from, to });
      return { data: { range: { from, to }, funnel: r.funnel, bySource: r.bySource, interviews: r.interviews, offers: r.offers, hires: r.hires, averageTimeToHireDays: r.averageTimeToHireDays, rejectionsByReason: r.rejectionsByReason }, sources: [src(`Recruitment report · ${from} → ${to}`, 'recruitment', asOfNow(), link(ctx.auth, PERMISSIONS.RECRUITMENT_MANAGE, '/hrm/recruitment/reports'), 'Time to hire = days from application to hire, averaged over hires in the range.')], consulted: 'Recruitment' };
    },
  },
  {
    id: 'succession_coverage', description: 'Succession and talent aggregates: open plans with / without a successor, ready-now coverage, critical positions without a successor, talent review completion and 9-box distribution. Counts only — no nominee, no comment.',
    statusLabel: 'กำลังดู succession coverage…', inputSchema: z.object({}).strict(), requiredPermissions: [PERMISSIONS.TALENT_VIEW_REPORTS], sensitivity: 'AGGREGATE', audience: 'ORG', maxRows: 20, sourceLabel: 'Talent reports',
    async handler(_args, ctx) {
      const [t, s] = await Promise.all([talentReportService.talent(), talentReportService.succession()]);
      return { data: { succession: s, talent: { cycles: t.cycles, nineBox: t.nineBox.filter((c) => c.count > 0), potentialDistribution: t.potentialDistribution } }, sources: [src('Succession coverage', 'talent', asOfNow(), link(ctx.auth, PERMISSIONS.TALENT_VIEW_REPORTS, '/hrd/career/reports'))], consulted: 'Succession' };
    },
  },
  {
    id: 'skill_gap_report', description: 'Organization-wide competency coverage and top gaps (counts per competency, department and job) from the competency module\'s report. Optional organizationId / departmentId / jobId filters. No individual.',
    statusLabel: 'กำลังดูรายงาน skill gap…', inputSchema: z.object({ organizationId: z.string().min(1).optional(), departmentId: z.string().min(1).optional(), jobId: z.string().min(1).optional() }).strict(), requiredPermissions: [PERMISSIONS.COMPETENCY_VIEW], sensitivity: 'AGGREGATE', audience: 'ORG', maxRows: 20, sourceLabel: 'Competency report',
    async handler(args, ctx) {
      const r = await skillGapService.gapReport(args as { organizationId?: string; departmentId?: string; jobId?: string });
      return { data: { coverage: r.coverage, totals: r.totals, topGaps: r.topGaps.slice(0, 10), byDepartment: r.byDepartment.slice(0, 15) }, sources: [src('Skill gap report', 'competency', asOfNow(), link(ctx.auth, PERMISSIONS.COMPETENCY_VIEW, '/hrd/competency/reports'))], consulted: 'รายงาน skill gap' };
    },
  },
  {
    id: 'analytics_metric_definition', description: 'How a dashboard metric is defined: name, definition, source module, time attribution and population. Use when the user asks how a number is calculated. Optional search text to narrow.',
    statusLabel: 'กำลังดูนิยามตัวชี้วัด…', inputSchema: z.object({ search: z.string().max(120).optional() }).strict(), requiredPermissions: [PERMISSIONS.COPILOT_USE], sensitivity: 'NORMAL', audience: 'ORG', maxRows: 20, sourceLabel: 'Metric dictionary',
    async handler(args, ctx) {
      const q = ((args as { search?: string }).search ?? '').toLowerCase();
      const words = q.split(/[^a-z0-9]+/).filter((w) => w.length > 2);
      const score = (m: (typeof ANALYTICS_METRICS)[number]) => words.filter((w) => `${m.key} ${m.name}`.toLowerCase().includes(w)).length * 2 + words.filter((w) => m.definition.toLowerCase().includes(w)).length;
      const hits = words.length ? ANALYTICS_METRICS.map((m) => ({ m, s: score(m) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).map((x) => x.m) : ANALYTICS_METRICS;
      const list = (hits.length ? hits : ANALYTICS_METRICS).slice(0, 20);
      return { data: { metrics: list }, sources: list.slice(0, 5).map((m) => src(`Metric definition · ${m.name}`, 'analytics', null, link(ctx.auth, PERMISSIONS.ANALYTICS_VIEW_EXECUTIVE, '/analytics/executive'), m.definition)), consulted: 'นิยามตัวชี้วัด' };
    },
  },
  {
    id: 'report_query', description: `Run a Report Center query. Give a datasetId from the list the tool returns on an empty call, and a definition {columns, filters, sort, groupBy, aggregations, pageSize}. The registry validates every field; the result is capped at ${COPILOT_LIMITS.maxToolRows} rows (larger results return a count and a draft the user can open in the Report Center). Never SQL.`,
    statusLabel: 'กำลังสร้างรายงาน…', inputSchema: z.object({ datasetId: z.string().min(1).max(60).optional(), definition: reportDefinitionSchema.optional() }).strict(), requiredPermissions: [PERMISSIONS.REPORTS_VIEW], sensitivity: 'SENSITIVE', audience: 'ORG', maxRows: COPILOT_LIMITS.maxToolRows, sourceLabel: 'Report Center',
    async handler(args, ctx) {
      const a = args as { datasetId?: string; definition?: z.infer<typeof reportDefinitionSchema> };
      if (!a.datasetId || !a.definition) {
        const datasets = reportsService.datasets(ctx.auth).map((d) => ({ id: d.id, name: d.name, aggregateOnly: d.aggregateOnly, requiredDateRange: d.requiredDateRange, fields: d.fields.map((f) => ({ id: f.id, type: f.type, groupable: f.groupable, aggregatable: f.aggregatable, options: f.options?.map((o) => o.value) })) }));
        return { data: { datasets }, sources: [], consulted: 'รายการ dataset' };
      }
      const definition = { ...a.definition, pageSize: Math.min(a.definition.pageSize ?? COPILOT_LIMITS.maxToolRows, COPILOT_LIMITS.maxToolRows) };
      const result = await reportsService.run(ctx.auth, a.datasetId, definition, 1);
      const truncated = result.meta.total > result.rows.length;
      const name = getDataset(a.datasetId)?.name ?? a.datasetId;
      return {
        data: { dataset: name, columns: result.columns.map((c) => c.label), rows: result.rows, total: result.meta.total, truncated, note: truncated ? `Only the first ${result.rows.length} of ${result.meta.total} rows are included; open the Report Center for the full report.` : undefined },
        sources: [src(`Report · ${name}`, 'reports', asOfNow(), '/hrm/reports/builder')], consulted: 'รายงาน',
        reportDraft: { datasetId: a.datasetId, datasetName: name, definition, rowCount: result.meta.total, truncated },
      };
    },
  },
  {
    id: 'document_metadata_search', description: 'Search document metadata the user may see: title, document number, category, classification, issued and expiry dates, version count. Metadata only — never file contents. Optional search text and employeeCode.',
    statusLabel: 'กำลังค้นหาเอกสาร…', inputSchema: z.object({ search: z.string().max(120).optional(), employeeCode: z.string().max(30).optional(), expiry: z.enum(['VALID', 'EXPIRING_SOON', 'EXPIRED']).optional() }).strict(), requiredPermissions: [PERMISSIONS.DOCUMENTS_VIEW_OWN, PERMISSIONS.DOCUMENTS_VIEW, PERMISSIONS.DOCUMENTS_MANAGE], sensitivity: 'PERSONAL', audience: 'PERSON', maxRows: 20, sourceLabel: 'Documents',
    async handler(args, ctx) {
      const a = args as { search?: string; employeeCode?: string; expiry?: 'VALID' | 'EXPIRING_SOON' | 'EXPIRED' };
      const ownerEmployeeId = a.employeeCode ? (await resolveEmployee(ctx, { employeeCode: a.employeeCode })).id : undefined;
      const canBrowse = hasPermission(ctx.auth, PERMISSIONS.DOCUMENTS_VIEW) || hasPermission(ctx.auth, PERMISSIONS.DOCUMENTS_MANAGE);
      const docs = canBrowse ? (await documentService.list(ctx.auth, { page: 1, pageSize: 20, search: a.search, ownerEmployeeId, expiry: a.expiry })).data : (await documentService.mine(ctx.auth)).filter((d) => !a.search || d.title.toLowerCase().includes(a.search.toLowerCase())).slice(0, 20);
      return { data: { documents: docs.map((d) => ({ documentNumber: d.documentNumber, title: d.title, category: d.category.name, classification: d.classification, owner: d.owner?.employeeCode ?? null, issuedDate: d.issuedDate, expiryDate: d.expiryDate, expiryState: d.expiryState, versions: d.versionCount, status: d.status })) }, sources: [src('Document center (metadata)', 'documents', asOfNow(), canBrowse ? '/hrm/documents/center' : '/hrm/documents')], consulted: 'เอกสาร' };
    },
  },
];

export const COPILOT_TOOLS: ReadonlyMap<string, CopilotTool> = new Map(tools.map((t) => [t.id, t]));
const audienceAllows = (auth: AuthContext, t: CopilotTool) =>
  t.audience === 'ORG' || (t.audience === 'TEAM' ? !!auth.employeeId : !!auth.employeeId || hasPermission(auth, PERMISSIONS.EMPLOYEES_UPDATE));
export const toolsFor = (auth: AuthContext): CopilotTool[] => tools.filter((t) => audienceAllows(auth, t) && t.requiredPermissions.some((p) => hasPermission(auth, p)));
