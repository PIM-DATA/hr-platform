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
    development: { summary: MyDevelopmentDto['summary']; activeIdp: { id: string; title: string; status: string; periodStart: string; periodEnd: string } | null; openNeeds: { id: string; title: string; status: string; priority: string; competencyName: string | null }[]; upcoming: { courseTitle: string; startAt: string; timezone: string }[]; recentCompleted: { courseTitle: string; completedAt: string | null }[]; learning: { ojt: { id: string; planNumber: string; program: string; status: string; startDate: string; completedAt: string | null; activitiesCompleted: number; activities: number }[]; learningPaths: { id: string; path: string; status: string; stepsFulfilled: number; steps: number }[]; certifications: { id: string; name: string; issuedDate: string; expiryDate: string | null; status: string }[] } } | null;
    /** Aggregate summary only — counts and a date. Narratives never travel here. */
    employeeRelations: EmployeeRelationsSummaryDto | null;
    /** HR-only hire origin: source, opening, dates. No feedback, no salary, no notes. */
    recruitment: { candidateNumber: string; source: string; openingTitle: string; applicationNumber: string; appliedAt: string; hiredAt: string | null } | null;
    career: MyCareerDto | null;
    talent: TalentSummaryDto | null;
    /** Lifecycle statuses and dates under each process's own view permission. Never a note, a comment or a reason note. */
    lifecycle: { onboarding: { id: string; status: string; startDate: string; progressPct: number; completedAt: string | null } | null; probation: { id: string; status: string; startDate: string; currentEndDate: string; finalOutcome: string | null } | null; offboarding: { id: string; status: string; plannedLastWorkingDate: string; actualLastWorkingDate: string | null } | null } | null;
    benefits: { enrollments: { plan: string; planType: string; status: string; coverageStart: string | null; coverageEnd: string | null }[]; balances: { plan: string; period: string; currency: string; granted: string; adjustment: string; reserved: string; consumed: string; available: string }[]; claims: { status: string; count: number }[] } | null;
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

/**
 * Closed payroll runs, organization level. Task 48 (T44-P2-15): money is keyed by currency — there is no total across
 * currencies, and no "default" currency. Runs of fewer than MIN_AGGREGATE_GROUP_SIZE employees are withheld (counted in
 * `withheldRuns`), as in the Report Center: a one-person run total is that person's salary.
 */
export interface PayrollCurrencyTotalsDto { currencyCode: string; runs: number; employeesPaid: number; grossTotal: string; deductionTotal: string; netTotal: string }
export interface PayrollAggregateDto {
  /** Counts across currencies (no money). */
  runs: number;
  employeesPaid: number;
  byCurrency: PayrollCurrencyTotalsDto[];
  byPeriod: { periodLabel: string; organizationName: string; currencyCode: string; employees: number; grossTotal: string; netTotal: string }[];
  withheldRuns: number;
  minimumGroupSize: number;
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
    performance: { cycles: { cycle: CycleReportDto['cycle']; completion: CycleReportDto['completion']; averageFinalScore: string | null; suppression: CycleReportDto['suppression']; ratingDistribution: CycleReportDto['ratingDistribution']; byDepartment: CycleReportDto['byDepartment'] }[] } | null;
    competency: GapReportDto | null;
    training: TrainingReportDto | null;
    recruitment: RecruitmentReportDto | null;
    employeeRelations: EmployeeRelationsReportDto | null;
    talent: { talent: TalentReportDto; succession: SuccessionReportDto } | null;
    /** Present only with `analytics.view_payroll_aggregate`; organization-level totals only. */
    payroll: PayrollAggregateDto | null;
    /** Task 42 roll-ups. Each needs the source module's own report permission; none is split by department or job. */
    benefits: BenefitsExecutiveDto | null;
    expense: ExpenseExecutiveDto | null;
    employeeServices: EmployeeServicesExecutiveDto | null;
    lifecycle: LifecycleExecutiveDto | null;
    learning: LearningExecutiveDto | null;
    workforcePlanning: WorkforcePlanningExecutiveDto | null;
    engagement: EngagementExecutiveDto | null;
  };
  /**
   * Why a section is null, so the UI never shows "0" for a section that did not load: OK (loaded, may be empty),
   * NOT_AUTHORIZED (the viewer lacks the source module's report permission), UNAVAILABLE (the source failed; logged),
   * NOT_APPLICABLE_TO_FILTER (the source is never split by the department/job filter in use).
   */
  sectionStatus: Record<ExecutiveSectionKey, ExecutiveSectionStatus>;
  generatedAt: string;
  durationMs: number;
}

export type ExecutiveSectionKey = keyof ExecutiveOverviewDto['sections'];
export const EXECUTIVE_SECTION_STATUSES = ['OK', 'NOT_AUTHORIZED', 'UNAVAILABLE', 'NOT_APPLICABLE_TO_FILTER'] as const;
export type ExecutiveSectionStatus = (typeof EXECUTIVE_SECTION_STATUSES)[number];

/**
 * Task 42 roll-ups. Money is always an exact decimal string per currency — never summed across currencies and never
 * a Number. `current` is the state right now (the date range does not apply); `inRange` is attributed as stated in
 * the metric dictionary. No employee, number, description, merchant, purpose, message, note, letter body, salary,
 * document or payment reference exists in these shapes.
 */
export interface BenefitsExecutiveDto {
  range: { from: string; to: string };
  current: {
    activePlans: number; enrolled: number; coverageOnlyEnrolled: number;
    claims: { pendingApproval: number; readyForPayment: number; sentToPayroll: number; paid: number; rejected: number };
    money: { currency: string; granted: string; consumed: string; available: string; claimedPending: string; readyForPayment: string; sentToPayroll: string; paid: string }[];
  };
  inRange: {
    claimsByStatus: { status: string; count: number }[];
    money: { currency: string; approvedAmount: string; paidAmount: string }[];
    byCategory: { category: string; plans: number; enrolled: number; claims: number; amounts: { currency: string; approvedAmount: string; paidAmount: string }[] }[];
  };
}
export interface ExpenseExecutiveDto {
  range: { from: string; to: string };
  current: {
    travel: { pendingApproval: number; approved: number };
    reports: { pendingApproval: number; readyForPayment: number; sentToPayroll: number; paid: number; rejected: number };
    money: { currency: string; pendingTotal: string; readyForPaymentTotal: string; sentToPayrollTotal: string }[];
  };
  inRange: {
    reports: number;
    money: { currency: string; reports: number; submittedTotal: string; approvedTotal: string; paidTotal: string }[];
    travel: { requests: number; approved: number; rejected: number; estimated: { currency: string; requests: number; estimatedTotal: string }[] };
    byCategory: { category: string; currency: string; items: number; total: string }[];
    byMonth: { month: string; currency: string; reports: number; total: string; paid: string }[];
  };
}
export interface EmployeeServicesExecutiveDto {
  range: { from: string; to: string };
  current: { open: number; submitted: number; inProgress: number; waitingEmployee: number; overdue: number };
  inRange: {
    totals: { submitted: number; fulfilled: number; rejected: number; open: number; averageFulfillmentDays: number | null };
    byCategory: { category: string; submitted: number; fulfilled: number }[];
    byMonth: { month: string; submitted: number; fulfilled: number }[];
    letters: { issued: number; voided: number; byType: { letterType: string; issued: number; voided: number }[] };
  };
}
export interface LifecycleExecutiveDto {
  range: { from: string; to: string };
  onboarding: { plansStarted: number; plansCompleted: number; completionRate: number | null; overdueTasks: number };
  probation: { active: number; dueSoon: number; passed: number; extended: number; notPassed: number };
  offboarding: { active: number; upcomingDepartures: number; completedSeparations: number };
}
export interface LearningExecutiveDto {
  range: { from: string; to: string };
  ojt: { plans: number; active: number; completed: number; avgCompletionDays: number | null };
  paths: { assigned: number; inProgress: number; completed: number };
  certifications: { active: number; expiringSoon: number; expired: number; revoked: number };
}
export interface WorkforcePlanningExecutiveDto {
  cycle: { name: string; status: string } | null;
  currentHeadcount: number; plannedHeadcount: number; netDelta: number; expansionDemand: number; plannedReductions: number; vacantPositions: number; remainingDemand: number;
}
export interface EngagementExecutiveDto {
  openSurveys: number; closedSurveys: number; openResponseRate: number | null;
  latestEnps: { surveyName: string; score: number | null; suppressed: boolean } | null;
}

/**
 * The metric dictionary: one definition per headline figure, naming the source domain, its time attribution and
 * population. Rendered in the UI and the docs so a number on the dashboard cannot drift from its source report.
 */
export interface MetricDefinition { key: string; name: string; definition: string; source: string; attribution: string; population: string; filters: string; currency?: string; limitations?: string }
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
  // ---------- Task 42 roll-ups ----------
  { key: 'benefits.enrolled', name: 'Benefit enrolments', definition: 'Enrolments in ENROLLED status right now; coverage-only = enrolments in COVERAGE_ONLY plans. Active plans = plans in ACTIVE status.', source: 'Benefits dashboard + report (benefitsReportService)', attribution: 'Current (as of now); the date range does not apply.', population: 'Enrolments whose organization snapshot matches the organization filter (all when none).', filters: 'organization', limitations: 'Never split by department or job: a small group would reveal an individual\'s welfare use.' },
  { key: 'benefits.claimsPending', name: 'Benefit claims by state', definition: 'Claims right now in PENDING_APPROVAL, READY_FOR_PAYMENT (approved, not paid), SENT_TO_PAYROLL and PAID. The states are disjoint and never added together.', source: 'Benefits dashboard (benefitsReportService.dashboard)', attribution: 'Current status.', population: 'Claims whose organization snapshot matches the organization filter.', filters: 'organization', limitations: 'No claimant, claim number, description, document or payment reference.' },
  { key: 'benefits.consumed', name: 'Benefit consumed / available', definition: 'Per currency: Σ CONSUME (approved claims) and granted + adjustment − reserved − consumed across entitlement ledgers. Consumed is not paid.', source: 'Benefits ledger via benefitsReportService.dashboard', attribution: 'Current ledger balance.', population: 'Entitlements whose organization snapshot matches the filter.', filters: 'organization', currency: 'Per currency, exact decimal; never summed across currencies.' },
  { key: 'benefits.approvedInRange', name: 'Benefit approved / paid in range', definition: 'Per currency: approved amounts of claims submitted in the range that are now READY_FOR_PAYMENT, SENT_TO_PAYROLL or PAID; paid = approved amounts of claims recorded PAID with a paid date in the range.', source: 'Benefits report (benefitsReportService.report)', attribution: 'Claim submitted date (approved); paid date (paid).', population: 'Claims whose organization snapshot matches the filter.', filters: 'date range, organization', currency: 'Per plan currency, exact decimal.' },
  { key: 'expense.pendingTotal', name: 'Expense pending / ready / sent to payroll', definition: 'Per currency, right now: Σ totals of reports in PENDING_APPROVAL; in READY_FOR_PAYMENT; in SENT_TO_PAYROLL. Disjoint states, never added together.', source: 'Expense dashboard (expenseAnalyticsService.dashboard)', attribution: 'Current status.', population: 'Reports whose organization snapshot matches the organization filter.', filters: 'organization', currency: 'Per currency, exact decimal.', limitations: 'No person, report number, merchant, description, purpose, receipt or reference.' },
  { key: 'expense.submittedInRange', name: 'Expense submitted / approved / paid in range', definition: 'Per currency, reports submitted in the range: submitted total; approved total (now READY_FOR_PAYMENT, SENT_TO_PAYROLL or PAID); paid total (now PAID).', source: 'Expense report (expenseAnalyticsService.report)', attribution: 'Report submitted date — a report submitted in March and paid in April counts in March.', population: 'Non-draft reports whose organization snapshot matches the filter.', filters: 'date range, organization', currency: 'Per currency, exact decimal.' },
  { key: 'expense.byCategory', name: 'Expense by category', definition: 'Per category and currency: Σ item amounts on reports submitted in the range.', source: 'Expense report (expenseAnalyticsService.report)', attribution: 'Report submitted date.', population: 'Items of non-draft reports in the organization filter.', filters: 'date range, organization', currency: 'Per currency, exact decimal.' },
  { key: 'expense.travel', name: 'Travel requests', definition: 'Travel requests submitted in the range: count, approved (APPROVED or COMPLETED), rejected, and the requested estimate per currency — an estimate is what was requested, never what was spent.', source: 'Expense report (expenseAnalyticsService.report)', attribution: 'Request submitted date.', population: 'Non-draft requests in the organization filter.', filters: 'date range, organization', currency: 'Per currency, exact decimal.', limitations: 'No purpose or destination.' },
  { key: 'services.open', name: 'Open / overdue service requests', definition: 'Right now: requests in SUBMITTED, IN_PROGRESS or WAITING_EMPLOYEE; overdue = open with a derived due date before today (calendar days from submission, nothing escalates).', source: 'Employee services dashboard (serviceAnalyticsService.dashboard)', attribution: 'Current status.', population: 'Requests whose organization snapshot matches the organization filter.', filters: 'organization', limitations: 'No requester, request number, subject, answers, messages or notes.' },
  { key: 'services.fulfilment', name: 'Service requests in range', definition: 'Requests submitted in the range: submitted, fulfilled, rejected, still open; average fulfilment = mean calendar days submission → fulfilment over the fulfilled ones.', source: 'Employee services report (serviceAnalyticsService.report)', attribution: 'Request submitted date.', population: 'Non-draft requests in the organization filter.', filters: 'date range, organization' },
  { key: 'services.letters', name: 'HR letters issued / voided', definition: 'Letters with an issue date in the range, by letter type; a voided letter keeps its row and is counted as voided.', source: 'Employee services report (serviceAnalyticsService.report)', attribution: 'Issue date.', population: 'Letters in the organization filter.', filters: 'date range, organization', limitations: 'Counts only — never a letter body, a letter number or a salary figure.' },
  { key: 'lifecycle.onboarding', name: 'Onboarding / probation / offboarding', definition: 'Task 34 lifecycle report: onboarding plans started in the range and completed; probation cases active, due within 14 days, and outcomes; offboarding cases active, upcoming departures and completed separations.', source: 'Lifecycle report (lifecycleReportService.report)', attribution: 'Plan start date; probation start or finalization date; planned last working day.', population: 'Cases in the viewer\'s lifecycle scope and organization filter.', filters: 'date range, organization', limitations: 'No names, reason notes or review comments.' },
  { key: 'learning.ojt', name: 'OJT, learning paths, certifications', definition: 'Task 35 learning report: OJT plans started in the range or active (completed, average completion days); learning-path assignments; certification status derived today (active, expiring within the window, expired, revoked).', source: 'Learning report (learningReportService.report)', attribution: 'OJT start date; assignment date; certifications as of today.', population: 'Records in the viewer\'s learning scope and organization filter (certifications: not organization-filtered).', filters: 'date range, organization' },
  { key: 'workforce.planned', name: 'Planned headcount', definition: 'Task 32: the latest ACTIVE or FINALIZED planning cycle — current headcount snapshot, planned headcount, net delta, expansion demand, planned reductions and remaining demand; vacant positions = active positions with no active employee today.', source: 'Workforce planning dashboard (workforcePlanService.dashboard)', attribution: 'The cycle\'s snapshot; vacancies are current.', population: 'Plan rows in the viewer\'s workforce scope; the cycle of the organization filter.', filters: 'organization (selects the cycle)', limitations: 'No planned movements and no employee.' },
  { key: 'engagement.enps', name: 'Engagement response rate and eNPS', definition: 'Task 33: open and closed surveys, response rate of open surveys, and the eNPS of the latest survey with an eNPS question — shown only when that survey\'s responses meet its anonymity threshold, otherwise suppressed.', source: 'Engagement dashboard (resultsService.dashboard)', attribution: 'Current survey state.', population: 'Assignments in the viewer\'s engagement scope.', filters: 'none (any organization/department/job filter hides this section)', limitations: 'No comments, no answers, no response below the minimum group size.' },
];
