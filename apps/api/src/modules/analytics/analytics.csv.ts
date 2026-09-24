import type { ExecutiveOverviewDto } from '@hr/shared';

/**
 * Aggregate tables as CSV. Every cell is quoted and any value that begins with a formula character is prefixed
 * with an apostrophe, so a spreadsheet never executes a department name. The input has no employee rows by
 * construction (see executive-analytics.service.ts), so nothing employee-level can appear here.
 */
const escape = (value: unknown): string => {
  const text = value === null || value === undefined ? '' : String(value);
  const guarded = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${guarded.replace(/"/g, '""')}"`;
};
const row = (cells: unknown[]) => cells.map(escape).join(',');

export function executiveOverviewCsv(o: ExecutiveOverviewDto): string {
  const lines: string[] = [];
  const section = (title: string, header: string[], rows: unknown[][]) => {
    lines.push(row([title]));
    lines.push(row(header));
    for (const r of rows) lines.push(row(r));
    lines.push('');
  };
  const s = o.sections;
  section('Filters', ['From', 'To', 'Organization', 'Department', 'Job'], [[o.filters.from, o.filters.to, o.filters.organizationName ?? 'All', o.filters.departmentName ?? 'All', o.filters.jobTitle ?? 'All']]);
  section('Workforce', ['Metric', 'Value'], [
    ['Active headcount', s.workforce.headcount.active], ['Inactive', s.workforce.headcount.inactive], ['Terminated', s.workforce.headcount.terminated],
    ['New hires in range', s.workforce.newHires], ['Position moves in range', s.workforce.positionMoves], ['Department moves in range', s.workforce.departmentMoves],
    ['Terminations in range', s.workforce.terminations ?? 'not available'],
  ]);
  section('Active headcount by department', ['Department', 'Active'], s.workforce.byDepartment.map((d) => [d.name, d.active]));
  section('Active headcount by job', ['Job', 'Active'], s.workforce.byJob.map((d) => [d.name, d.active]));
  section('New hires by month', ['Month', 'New hires'], s.workforce.newHiresByMonth.map((m) => [m.month, m.count]));
  if (s.leave) {
    section('Leave', ['Metric', 'Value'], [['Submitted requests', s.leave.summary.submittedRequests], ['Approved requests', s.leave.summary.approvedRequests], ['Pending requests', s.leave.summary.pendingRequests], ['Approved units', s.leave.summary.approvedUnits]]);
    section('Leave by type', ['Leave type', 'Approved requests', 'Approved units'], s.leave.byLeaveType.map((t) => [t.name, t.approvedRequests, t.approvedUnits]));
    section('Leave by department', ['Department', 'Approved requests', 'Approved units'], s.leave.byDepartment.map((d) => [d.departmentName, d.approvedRequests, d.approvedUnits]));
  }
  if (s.attendance) {
    const t = s.attendance.totals;
    section('Attendance', ['Metric', 'Value'], [['Employees', s.attendance.employees], ['Scheduled days', t.scheduledDays], ['Present days', t.presentDays], ['Late days', t.lateDays], ['Absent days', t.absentDays], ['Leave days', t.leaveDays], ['Incomplete days', t.incompleteDays], ['Work minutes', t.workMinutes]]);
    section('Attendance by department', ['Department', 'Scheduled', 'Present', 'Late', 'Absent', 'Leave', 'Incomplete'], s.attendance.byDepartment.map((d) => [d.departmentName, d.scheduledDays, d.presentDays, d.lateDays, d.absentDays, d.leaveDays, d.incompleteDays]));
  }
  if (s.overtime) section('Overtime (minutes only)', ['Metric', 'Value'], [['Requests', s.overtime.totals.requests], ['Approved requests', s.overtime.totals.approvedRequests], ['Approved minutes', s.overtime.totals.approvedMinutes], ['Workday minutes', s.overtime.totals.byDayType.WORKDAY], ['Off-day minutes', s.overtime.totals.byDayType.OFF_DAY], ['Holiday minutes', s.overtime.totals.byDayType.HOLIDAY]]);
  if (s.performance) section('Performance cycles', ['Cycle', 'Status', 'Assigned', 'Finalized', 'Average final score'], s.performance.cycles.map((c) => [c.cycle.name, c.cycle.status, c.completion.assigned, c.completion.finalized, c.averageFinalScore ?? '']));
  if (s.competency) section('Competency', ['Metric', 'Value'], [['Assessments assigned', s.competency.coverage.assigned], ['Finalized', s.competency.coverage.finalized], ['Coverage %', s.competency.coverage.coveragePercent], ['Employees assessed', s.competency.totals.employeesAssessed], ['Employees with a gap', s.competency.totals.employeesWithGap], ['Gap items', s.competency.totals.gapItems]]);
  if (s.training) section('Training', ['Metric', 'Value'], [['Enrolments', s.training.enrollments.total], ['Completed', s.training.enrollments.completed], ['No-show', s.training.enrollments.noShow], ['Completion rate %', s.training.completionRate ?? ''], ['Training hours', s.training.trainingHours], ['Open needs', s.training.needs.open], ['Fulfilled needs', s.training.needs.fulfilled], ['Active IDPs', s.training.idps.active]]);
  if (s.recruitment) {
    section('Recruitment funnel', ['Stage', 'Applications'], s.recruitment.funnel.map((f) => [f.stage, f.count]));
    section('Recruitment', ['Metric', 'Value'], [['Hires', s.recruitment.hires], ['Average time to hire (days)', s.recruitment.averageTimeToHireDays ?? ''], ['Offers accepted', s.recruitment.offers.accepted], ['Offers declined', s.recruitment.offers.declined]]);
  }
  if (s.employeeRelations) section('Employee relations (aggregate)', ['Metric', 'Value'], [['Actions issued', s.employeeRelations.actions.issued], ['Active', s.employeeRelations.actions.active], ['Awaiting acknowledgement', s.employeeRelations.actions.awaitingAcknowledgement]]);
  if (s.talent) {
    section('Succession coverage', ['Metric', 'Value'], [['Open plans', s.talent.succession.plans.total], ['With a successor', s.talent.succession.plans.withSuccessor], ['With a ready-now successor', s.talent.succession.plans.withReadyNow], ['Without a successor', s.talent.succession.plans.withoutSuccessor], ['Critical without successor', s.talent.succession.criticalWithoutSuccessor]]);
    section('9-box distribution', ['Cell', 'Count'], s.talent.talent.nineBox.map((c) => [c.cell, c.count]));
  }
  if (s.payroll) section('Payroll (organization-level totals)', ['Period', 'Employees paid', 'Gross', 'Net'], s.payroll.byPeriod.map((p) => [p.periodLabel, p.employees, p.grossTotal, p.netTotal]));
  return lines.join('\r\n');
}
