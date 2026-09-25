import { z } from 'zod';
import { isBusinessDate } from '../business-date';
import type { EmployeeDetail, ManagerHistoryItem, PositionHistoryItem } from './employee';
import type { EntitlementDto } from './leave-entitlement';
import type { LeaveRequestDto } from './leave-request';
import type { AttendanceReportRowDto } from './attendance';
import type { OvertimeRequestDto } from './overtime';
import type { SkillProfileDto } from './competency';
import type { MyDevelopmentDto } from './training';
import type { EmployeeRelationsSummaryDto, EmployeeRelationsReportDto } from './employee-relations';
import type { MyCareerDto, TalentSummaryDto, TalentReportDto, SuccessionReportDto } from './talent';
import type { RecruitmentReportDto } from './recruitment';
import type { LeaveReportOverviewDto } from './leave-report';
import type { AttendanceReportDto } from './attendance';
import type { OvertimeReportDto } from './overtime';
import type { CycleReportDto } from './performance';
import type { GapReportDto } from './competency';
import type { TrainingReportDto } from './training';

/**
 * Employee 360 and executive analytics (Task 29) — a projection layer.
 *
 * Nothing here is a new source of truth: every section is the source module's own projection, returned only when
 * the caller holds that module's permission for that employee. An unauthorized section is **absent** (null), never
 * present-but-hidden. The executive overview is organization-level aggregates from the domain report services,
 * with no employee-level rows anywhere in it.
 */

// ---------- Employee 360 ----------
export interface EmploymentTimelineEventDto {
  date: string;
  /** JOINED | POSITION_CHANGED | MANAGER_CHANGED | DEPARTMENT_MOVED | DEACTIVATED */
  type: string;
  title: string;
  detail: string | null;
}

/** A finalized or in-flight performance plan, as much as the 360 shows: score, rating, cycle. No comments. */
export interface PerformancePlanBriefDto {
  id: string;
  cycle: { id: string; code: string; name: string; status: string; minScore: string; maxScore: string };
  snapshot: { departmentName: string | null; positionTitle: string | null; jobTitle: string | null };
  reviewer: { employeeId: string | null; name: string | null };
  status: string;
  finalizedAt: string | null;
  weightedScore: string | null;
  ratingCode: string | null;
  ratingLabel: string | null;
}

export interface Employee360Dto {
  profile: EmployeeDetail;
  /** Which sections the caller may see; a section absent here is absent below too. */
  visibleSections: string[];
  sections: {
    employment: { positions: PositionHistoryItem[]; managers: ManagerHistoryItem[]; timeline: EmploymentTimelineEventDto[] } | null;
    leave: { year: number; balances: EntitlementDto[]; summary: { requests: number; approved: number; pending: number; approvedUnits: number }; recent: LeaveRequestDto[] } | null;
    attendance: { from: string; to: string; totals: Omit<AttendanceReportRowDto, 'employee'> | null; recent: { date: string; dayType: string; status: string; workMinutes: number; lateMinutes: number }[] } | null;
    overtime: { from: string; to: string; requests: number; approvedRequests: number; approvedMinutes: number; recent: OvertimeRequestDto[]; note: string } | null;
    /** Self: own closed payslips (no amounts beyond what payroll self-service already shows). HR with payroll.manage: closed results. Never for a team scope. */
    payroll: { mode: 'SELF' | 'ADMIN'; payslips: { id: string; periodLabel: string; paymentDate: string | null; netPay: string; currencyCode: string }[] } | null;
    performance: { latest: PerformancePlanBriefDto | null; history: PerformancePlanBriefDto[] } | null;
    competency: SkillProfileDto | null;
    development: { summary: MyDevelopmentDto['summary']; activeIdp: { id: string; title: string; status: string; periodStart: string; periodEnd: string } | null; openNeeds: { id: string; title: string; status: string; priority: string; competencyName: string | null }[]; upcoming: { courseTitle: string; startAt: string; timezone: string }[]; recentCompleted: { courseTitle: string; completedAt: string | null }[] } | null;
    /** Aggregate summary only — counts and a date. Narratives never travel here. */
    employeeRelations: EmployeeRelationsSummaryDto | null;
    /** HR-only hire origin: source, opening, dates. No feedback, no salary, no notes. */
    recruitment: { candidateNumber: string; source: string; openingTitle: string; applicationNumber: string; appliedAt: string; hiredAt: string | null } | null;
    career: MyCareerDto | null;
    talent: TalentSummaryDto | null;
    /** Lifecycle statuses and dates under each process's own view permission. Never a note, a comment or a reason note. */
    lifecycle: { onboarding: { id: string; status: string; startDate: string; progressPct: number; completedAt: string | null } | null; probation: { id: string; status: string; startDate: string; currentEndDate: string; finalOutcome: string | null } | null; offboarding: { id: string; status: string; plannedLastWorkingDate: string; actualLastWorkingDate: string | null } | null } | null;
  };
  /** Curated cross-domain events the caller is allowed to see. Never the audit table. */
  activity: { date: string; domain: string; title: string; detail: string | null }[];
  generatedAt: string;
}

// ---------- executive analytics ----------
const businessDate = z.string().refine(isBusinessDate, 'Use a real date in YYYY-MM-DD format');
export const ANALYTICS_MAX_MONTHS = 36;
export const analyticsFilterSchema = z
  .object({
    from: businessDate,
    to: businessDate,
    organizationId: z.string().min(1).optional(),
    departmentId: z.string().min(1).optional(),
    jobId: z.string().min(1).optional(),
  })
  .refine((v) => v.from <= v.to, { message: 'The end date cannot be before the start date', path: ['to'] })
  .refine((v) => monthsSpan(v.from, v.to) <= ANALYTICS_MAX_MONTHS, { message: `Analytics ranges are limited to ${ANALYTICS_MAX_MONTHS} months`, path: ['to'] });
export type AnalyticsFilter = z.infer<typeof analyticsFilterSchema>;

export function monthsSpan(from: string, to: string): number {
  const [fy, fm] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  return (ty! - fy!) * 12 + (tm! - fm!) + 1;
}

export interface WorkforceAnalyticsDto {
  headcount: { active: number; inactive: number; terminated: number; total: number };
  byOrganization: { name: string; active: number }[];
  byDepartment: { name: string; active: number }[];
  byJob: { name: string; active: number }[];
  byEmploymentType: { type: string; active: number }[];
  /** Hire-date based: employees whose hireDate falls in the range (any current status). */
  newHires: number;
  newHiresByMonth: { month: string; count: number }[];
  /** From the employee position history: rows that started in the range with a previous row (moves, not first assignments). */
  positionMoves: number;
  departmentMoves: number;
  /** Employees deactivated/terminated in the range, from `terminationDate` when set — stated, not inferred. */
  terminations: number | null;
  terminationsNote: string;
}

export interface PayrollAggregateDto {
  currencyCode: string | null;
  runs: number;
  employeesPaid: number;
  grossTotal: string;
  deductionTotal: string;
  netTotal: string;
  byPeriod: { periodLabel: string; employees: number; grossTotal: string; netTotal: string }[];
  note: string;
}

export interface ExecutiveOverviewDto {
  filters: AnalyticsFilter & { organizationName: string | null; departmentName: string | null; jobTitle: string | null };
  /** Which filters each section actually applied — see the metric dictionary. */
  sections: {
    workforce: WorkforceAnalyticsDto;
    leave: LeaveReportOverviewDto | null;
    attendance: { totals: AttendanceReportDto['totals']; employees: number; byDepartment: { departmentName: string; scheduledDays: number; presentDays: number; lateDays: number; absentDays: number; leaveDays: number; incompleteDays: number }[] } | null;
    overtime: { totals: OvertimeReportDto['totals']; byDepartment: { departmentName: string; requests: number; approvedMinutes: number }[]; note: string } | null;
    performance: { cycles: { cycle: CycleReportDto['cycle']; completion: CycleReportDto['completion']; averageFinalScore: string | null; ratingDistribution: CycleReportDto['ratingDistribution']; byDepartment: CycleReportDto['byDepartment'] }[] } | null;
    competency: GapReportDto | null;
    training: TrainingReportDto | null;
    recruitment: RecruitmentReportDto | null;
    employeeRelations: EmployeeRelationsReportDto | null;
    talent: { talent: TalentReportDto; succession: SuccessionReportDto } | null;
    /** Present only with `analytics.view_payroll_aggregate`; organization-level totals only. */
    payroll: PayrollAggregateDto | null;
  };
  generatedAt: string;
  durationMs: number;
}

/**
 * The metric dictionary: one definition per headline figure, naming the source domain, its time attribution and
 * population. Rendered in the UI and the docs so a number on the dashboard cannot drift from its source report.
 */
export interface MetricDefinition { key: string; name: string; definition: string; source: string; attribution: string; population: string; filters: string }
export const ANALYTICS_METRICS: MetricDefinition[] = [
  { key: 'headcount.active', name: 'Active headcount', definition: 'Employee records with employment status ACTIVE right now.', source: 'Employee master', attribution: 'Current (as of now); the date range does not apply.', population: 'All employees in the organization/department/job filter, by their current assignment.', filters: 'organization, department, job' },
  { key: 'workforce.newHires', name: 'New hires', definition: 'Employees whose hire date falls in the range, whatever their status today.', source: 'Employee master (hireDate)', attribution: 'Hire date.', population: 'Employees matching the organization/department/job filter by current assignment.', filters: 'date range, organization, department, job' },
  { key: 'workforce.positionMoves', name: 'Position moves', definition: 'Position-history rows that started in the range and were not the employee\'s first assignment.', source: 'Employee position history', attribution: 'Start date of the new assignment.', population: 'Employees matching the filter by current assignment.', filters: 'date range, organization, department, job' },
  { key: 'leave.approvedUnits', name: 'Approved leave units', definition: 'Task 14 leave report: units of approved requests overlapping the range.', source: 'Leave report (leaveReportsService.overview)', attribution: 'Request dates, department as recorded on the request.', population: 'Requests in the caller\'s scope and filter.', filters: 'date range, organization, department' },
  { key: 'attendance.presentDays', name: 'Attendance days', definition: 'Task 20 attendance report totals: scheduled / present / late / absent / leave / incomplete days.', source: 'Attendance report (attendanceRecordsService.report)', attribution: 'Attendance date; department = the employee\'s current department.', population: 'Employees with attendance records in the range.', filters: 'date range, department' },
  { key: 'overtime.approvedMinutes', name: 'Approved overtime minutes', definition: 'Task 21 overtime report: approved minutes by day type. Minutes only, never money.', source: 'Overtime report (overtimeService.report)', attribution: 'Attendance date of the claim.', population: 'Claims in the range.', filters: 'date range, department' },
  { key: 'performance.finalized', name: 'Performance reviews finalized', definition: 'Task 23 cycle report completion counts for cycles whose period overlaps the range.', source: 'Performance cycle report (performanceReportService.cycleReport)', attribution: 'Cycle period; department = the plan\'s snapshot department at creation.', population: 'Plans in those cycles.', filters: 'date range (cycle overlap), organization (cycle), department (snapshot)' },
  { key: 'performance.averageScore', name: 'Average final score', definition: 'Task 23: average weighted score of finalized plans in the cycle.', source: 'Performance cycle report', attribution: 'Cycle period.', population: 'Finalized plans.', filters: 'as above' },
  { key: 'competency.coverage', name: 'Competency assessment coverage', definition: 'Task 24 gap report: assigned / finalized assessments and employees with a gap on their current job profile.', source: 'Skill-gap report (skillGapService.gapReport)', attribution: 'Latest finalized levels vs current job requirements (no date range).', population: 'Active employees in the organization/department/job filter.', filters: 'organization, department, job' },
  { key: 'training.completionRate', name: 'Training completion rate', definition: 'Task 25: completed ÷ (completed + failed + no-show); cancelled and still-enrolled excluded.', source: 'Training report (trainingReportService.report)', attribution: 'Session date.', population: 'Enrolments in sessions in the range.', filters: 'date range, department' },
  { key: 'recruitment.hires', name: 'Hires', definition: 'Task 27: applications HIRED, with average time to hire = applied → hired days.', source: 'Recruitment report (recruitmentReportService.report)', attribution: 'Application applied date; department = the opening\'s snapshot.', population: 'Applications applied in the range.', filters: 'date range, organization' },
  { key: 'employeeRelations.issued', name: 'Employee relations actions issued', definition: 'Task 26 report: cases and issued actions, active warnings and pending acknowledgements. Aggregate only.', source: 'Employee relations report (erReportService.report)', attribution: 'Incident / issue date; department = case snapshot.', population: 'Cases in the range.', filters: 'date range, department' },
  { key: 'talent.successionCoverage', name: 'Succession coverage', definition: 'Task 28: open plans with at least one active successor / with a ready-now successor / without any.', source: 'Talent reports (talentReportService)', attribution: 'Current state; the date range does not apply.', population: 'All open succession plans.', filters: 'none' },
  { key: 'payroll.netTotal', name: 'Payroll net total', definition: 'Sum of net pay across CLOSED payroll runs whose period falls in the range. Organization-level only — no department split, to prevent small-group salary inference.', source: 'Payroll run summaries (payrollRunService.summary)', attribution: 'Payroll period.', population: 'Closed runs of the organization filter.', filters: 'date range, organization' },
];
