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
  if (s.performance) section('Performance cycles', ['Cycle', 'Status', 'Assigned', 'Finalized', 'Average final score'], s.performance.cycles.map((c) => [c.cycle.name, c.cycle.status, c.completion.assigned, c.completion.finalized, c.suppression ? 'SUPPRESSED' : (c.averageFinalScore ?? '')]));
  if (s.competency) section('Competency', ['Metric', 'Value'], [['Assessments assigned', s.competency.coverage.assigned], ['Finalized', s.competency.coverage.finalized], ['Coverage %', s.competency.coverage.coveragePercent], ['Employees assessed', s.competency.totals.employeesAssessed], ['Employees with a gap', s.competency.totals.employeesWithGap ?? 'SUPPRESSED'], ['Gap items', s.competency.totals.gapItems ?? 'SUPPRESSED']]);
  if (s.training) section('Training', ['Metric', 'Value'], [['Enrolments', s.training.enrollments.total], ['Completed', s.training.enrollments.completed], ['No-show', s.training.enrollments.noShow], ['Completion rate %', s.training.completionRate ?? ''], ['Training hours', s.training.trainingHours], ['Open needs', s.training.needs.open], ['Fulfilled needs', s.training.needs.fulfilled], ['Active IDPs', s.training.idps.active]]);
  if (s.recruitment) {
    section('Recruitment funnel', ['Stage', 'Applications'], s.recruitment.funnel.map((f) => [f.stage, f.count]));
    section('Recruitment', ['Metric', 'Value'], [['Hires', s.recruitment.hires], ['Average time to hire (days)', s.recruitment.averageTimeToHireDays ?? ''], ['Offers accepted', s.recruitment.offers.accepted], ['Offers declined', s.recruitment.offers.declined]]);
  }
  // Task 47: a withheld small group exports as SUPPRESSED, never as a number.
  if (s.employeeRelations) section('Employee relations (aggregate)', ['Metric', 'Value'], s.employeeRelations.actions ? [['Actions issued', s.employeeRelations.actions.issued], ['Active', s.employeeRelations.actions.active], ['Awaiting acknowledgement', s.employeeRelations.actions.awaitingAcknowledgement]] : [['Result', 'SUPPRESSED (small group)']]);
  if (s.talent) {
    section('Succession coverage', ['Metric', 'Value'], [['Open plans', s.talent.succession.plans.total], ['With a successor', s.talent.succession.plans.withSuccessor], ['With a ready-now successor', s.talent.succession.plans.withReadyNow], ['Without a successor', s.talent.succession.plans.withoutSuccessor], ['Critical without successor', s.talent.succession.criticalWithoutSuccessor]]);
    section('9-box distribution', ['Cell', 'Count'], s.talent.talent.nineBox.map((c) => [c.cell, c.count]));
  }
  if (s.payroll) {
    // Task 48 (T44-P2-15): one line per currency; amounts in different currencies are never added.
    section('Payroll by currency (closed runs)', ['Currency', 'Runs', 'Employees paid', 'Gross', 'Deductions', 'Net'], s.payroll.byCurrency.map((c) => [c.currencyCode, c.runs, c.employeesPaid, c.grossTotal, c.deductionTotal, c.netTotal]));
    section('Payroll by period', ['Period', 'Organization', 'Currency', 'Employees paid', 'Gross', 'Net'], s.payroll.byPeriod.map((p) => [p.periodLabel, p.organizationName, p.currencyCode, p.employees, p.grossTotal, p.netTotal]));
    if (s.payroll.withheldRuns) section('Payroll', ['SUPPRESSED'], [[`${s.payroll.withheldRuns} run(s) of fewer than ${s.payroll.minimumGroupSize} employees withheld`]]);
  }
  if (s.benefits) {
    const b = s.benefits;
    section('Benefits (current, organization level)', ['Metric', 'Value'], [['Active plans', b.current.activePlans], ['Enrolled', b.current.enrolled], ['Coverage-only enrolments', b.current.coverageOnlyEnrolled], ['Claims pending approval', b.current.claims.pendingApproval], ['Claims ready for payment', b.current.claims.readyForPayment], ['Claims sent to payroll', b.current.claims.sentToPayroll], ['Claims paid', b.current.claims.paid]]);
    section('Benefits money (current)', ['Currency', 'Granted', 'Consumed', 'Available', 'Pending (claimed)', 'Ready for payment', 'Sent to payroll', 'Paid'], b.current.money.map((m) => [m.currency, m.granted, m.consumed, m.available, m.claimedPending, m.readyForPayment, m.sentToPayroll, m.paid]));
    section('Benefits approved and paid in range', ['Currency', 'Approved', 'Paid'], b.inRange.money.map((m) => [m.currency, m.approvedAmount, m.paidAmount]));
    section('Benefits by category (in range)', ['Category', 'Plans', 'Enrolled', 'Claims', 'Currency', 'Approved', 'Paid'], b.inRange.byCategory.flatMap((c) => (c.amounts.length ? c.amounts : [null]).map((m) => [c.category, c.plans, c.enrolled, c.claims, m?.currency ?? '', m?.approvedAmount ?? '', m?.paidAmount ?? ''])));
  }
  if (s.expense) {
    const x = s.expense;
    section('Expenses (current)', ['Metric', 'Value'], [['Reports pending approval', x.current.reports.pendingApproval], ['Ready for payment', x.current.reports.readyForPayment], ['Sent to payroll', x.current.reports.sentToPayroll], ['Paid', x.current.reports.paid], ['Travel requests pending', x.current.travel.pendingApproval]]);
    section('Expense money (current)', ['Currency', 'Pending', 'Ready for payment', 'Sent to payroll'], x.current.money.map((m) => [m.currency, m.pendingTotal, m.readyForPaymentTotal, m.sentToPayrollTotal]));
    section('Expenses submitted in range', ['Currency', 'Reports', 'Submitted', 'Approved', 'Paid'], x.inRange.money.map((m) => [m.currency, m.reports, m.submittedTotal, m.approvedTotal, m.paidTotal]));
    section('Expenses by category (in range)', ['Category', 'Currency', 'Items', 'Total'], x.inRange.byCategory.map((c) => [c.category, c.currency, c.items, c.total]));
    section('Travel requests (in range)', ['Currency', 'Requests', 'Estimated'], x.inRange.travel.estimated.map((t) => [t.currency, t.requests, t.estimatedTotal]));
  }
  if (s.employeeServices) {
    const v = s.employeeServices;
    section('Employee services', ['Metric', 'Value'], [['Open now', v.current.open], ['Overdue now', v.current.overdue], ['Submitted in range', v.inRange.totals.submitted], ['Fulfilled in range', v.inRange.totals.fulfilled], ['Rejected in range', v.inRange.totals.rejected], ['Average fulfilment days', v.inRange.totals.averageFulfillmentDays ?? ''], ['Letters issued', v.inRange.letters.issued], ['Letters voided', v.inRange.letters.voided]]);
    section('Service requests by category (in range)', ['Category', 'Submitted', 'Fulfilled'], v.inRange.byCategory.map((c) => [c.category, c.submitted, c.fulfilled]));
  }
  if (s.lifecycle) section('Lifecycle', ['Metric', 'Value'], [['Onboarding plans started', s.lifecycle.onboarding.plansStarted], ['Onboarding plans completed', s.lifecycle.onboarding.plansCompleted], ['Probation active', s.lifecycle.probation.active], ['Probation due within 14 days', s.lifecycle.probation.dueSoon], ['Probation passed', s.lifecycle.probation.passed], ['Offboarding active', s.lifecycle.offboarding.active], ['Upcoming departures', s.lifecycle.offboarding.upcomingDepartures], ['Completed separations', s.lifecycle.offboarding.completedSeparations]]);
  if (s.learning) section('OJT, learning paths, certifications', ['Metric', 'Value'], [['OJT plans', s.learning.ojt.plans], ['OJT active', s.learning.ojt.active], ['OJT completed', s.learning.ojt.completed], ['Path assignments', s.learning.paths.assigned], ['Paths completed', s.learning.paths.completed], ['Certifications active', s.learning.certifications.active], ['Expiring soon', s.learning.certifications.expiringSoon], ['Expired', s.learning.certifications.expired]]);
  if (s.workforcePlanning) section('Workforce planning', ['Metric', 'Value'], [['Cycle', s.workforcePlanning.cycle?.name ?? 'none'], ['Current headcount', s.workforcePlanning.currentHeadcount], ['Planned headcount', s.workforcePlanning.plannedHeadcount], ['Net delta', s.workforcePlanning.netDelta], ['Vacant positions', s.workforcePlanning.vacantPositions], ['Remaining demand', s.workforcePlanning.remainingDemand]]);
  if (s.engagement) section('Engagement', ['Metric', 'Value'], [['Open surveys', s.engagement.openSurveys], ['Open-survey response rate %', s.engagement.openResponseRate ?? ''], ['Latest eNPS', s.engagement.latestEnps ? (s.engagement.latestEnps.suppressed ? 'suppressed (below minimum group size)' : s.engagement.latestEnps.score ?? '') : 'none']]);
  return lines.join('\r\n');
}
