import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Download, Info } from 'lucide-react';
import { PERMISSIONS, nineBoxLabel, type PermissionCode } from '@hr/shared';
import { PageHeader } from '@/components/layout/PageHeader';
import { Card, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Alert';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Modal } from '@/components/ui/Modal';
import { LoadingBlock } from '@/components/ui/Spinner';
import { useToast } from '@/components/ui/Toast';
import { useAuth } from '@/hooks/useAuth';
import { errorMessage } from '@/features/organization/shared';
import { downloadExecutiveCsv, useAnalyticsOptions, useExecutiveOverview, useMetricDefinitions } from './analytics.api';
import { BarList, Donut, TrendLine } from './charts';
import { BenefitsSection, EmployeeServicesSection, ExpenseSection, PeopleOperationsSection } from './ExecutiveDomainSections';

const titleCase = (s: string) => s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, ' ');
const n = (v: number | null | undefined) => (v === null || v === undefined ? '—' : new Intl.NumberFormat('en-US').format(v));
const hours = (minutes: number) => `${Math.round((minutes / 60) * 10) / 10} h`;

/**
 * The executive dashboard: organization-level aggregates from every domain's own report, with the definition of
 * each figure one click away. Cards link to the source module's report only when the viewer already has that
 * module's permission — there is no drill-down to a person from here.
 */
export function ExecutiveDashboardPage() {
  const { hasPermission } = useAuth();
  const toast = useToast();
  const year = new Date().getFullYear();
  const [from, setFrom] = useState(`${year}-01-01`);
  const [to, setTo] = useState(`${year}-12-31`);
  const [organizationId, setOrg] = useState('');
  const [departmentId, setDept] = useState('');
  const [jobId, setJob] = useState('');
  const [defs, setDefs] = useState(false);
  const [exporting, setExporting] = useState(false);
  const options = useAnalyticsOptions();
  const filters = { from, to, organizationId: organizationId || undefined, departmentId: departmentId || undefined, jobId: jobId || undefined };
  const ov = useExecutiveOverview(filters);
  const d = ov.data;
  const s = d?.sections;
  const link = (permission: PermissionCode | PermissionCode[], to: string, label: string) => ((Array.isArray(permission) ? permission.some((p) => hasPermission(p)) : hasPermission(permission)) ? <Link to={to} className="text-xs text-brand-700 underline">{label}</Link> : undefined);
  const href = (permissions: PermissionCode[], to: string) => (permissions.some((p) => hasPermission(p)) ? to : null);
  const exportCsv = async () => { setExporting(true); try { await downloadExecutiveCsv(filters); } catch (e) { toast.error(errorMessage(e)); } finally { setExporting(false); } };

  return (
    <>
      <PageHeader title="Executive HR dashboard" description="Organization-level figures composed from each module's own report. Counts, rates and distributions — no individual, no ranking, no prediction." actions={<><Button variant="secondary" onClick={() => setDefs(true)}><Info className="h-4 w-4" /> Definitions</Button><Button variant="secondary" onClick={exportCsv} loading={exporting}><Download className="h-4 w-4" /> Export CSV</Button></>} />
      <Card className="mb-4"><div className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2 xl:grid-cols-5">
        <Input label="From" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        <Input label="To" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        <Select label="Organization" options={(options.data?.organizations ?? []).map((o) => ({ value: o.id, label: o.name }))} placeholder="All organizations" value={organizationId} onChange={(e) => { setOrg(e.target.value); setDept(''); }} />
        <Select label="Department" options={(options.data?.departments ?? []).filter((x) => !organizationId || x.organizationId === organizationId).map((o) => ({ value: o.id, label: o.name }))} placeholder="All departments" value={departmentId} onChange={(e) => setDept(e.target.value)} />
        <Select label="Job" options={(options.data?.jobs ?? []).map((o) => ({ value: o.id, label: o.title }))} placeholder="All jobs" value={jobId} onChange={(e) => setJob(e.target.value)} />
      </div></Card>
      {ov.isLoading && <LoadingBlock />}
      {ov.isError && <Alert>Could not load the dashboard: {errorMessage(ov.error)}</Alert>}
      {d && s && (
        <div className="space-y-6">
          <section>
            <h2 className="mb-2 text-sm font-semibold text-slate-900">Workforce</h2>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
              <Stat label="Active headcount" value={n(s.workforce.headcount.active)} hint="as of today" />
              <Stat label="New hires" value={n(s.workforce.newHires)} hint="hire date in range" />
              <Stat label="Position moves" value={n(s.workforce.positionMoves)} hint={`${n(s.workforce.departmentMoves)} across departments`} />
              <Stat label="Terminations" value={s.workforce.terminations === null ? 'n/a' : n(s.workforce.terminations)} hint="recorded termination dates" />
              <Stat label="Active applications" value={s.recruitment ? n(s.recruitment.funnel.filter((f) => ['APPLIED', 'SCREENING', 'INTERVIEW', 'OFFER'].includes(f.stage)).reduce((a, f) => a + f.count, 0)) : '—'} hint="in the pipeline" />
              <Stat label="Succession coverage" value={s.talent ? `${n(s.talent.succession.plans.withSuccessor)} / ${n(s.talent.succession.plans.total)}` : '—'} hint="plans with a successor" />
            </div>
            <div className="mt-3 grid grid-cols-1 gap-4 lg:grid-cols-3">
              <Card><CardHeader title="Headcount by department" description="Current assignment" /><div className="p-4"><BarList rows={s.workforce.byDepartment.slice(0, 12).map((x) => ({ label: x.name, value: x.active }))} /></div></Card>
              <Card><CardHeader title="Headcount by job" /><div className="p-4"><BarList rows={s.workforce.byJob.slice(0, 12).map((x) => ({ label: x.name, value: x.active }))} /></div></Card>
              <Card><CardHeader title="New hires by month" /><div className="p-4"><TrendLine points={s.workforce.newHiresByMonth.map((m) => ({ x: m.month, y: m.count }))} label="New hires by month" /><Donut parts={s.workforce.byEmploymentType.map((t, i) => ({ label: titleCase(t.type), value: t.active, className: ['text-brand-600', 'text-sky-500', 'text-amber-500', 'text-slate-400'][i % 4]! }))} /></div></Card>
            </div>
          </section>

          <PeopleOperationsSection s={s} status={d.sectionStatus} links={{ lifecycle: href([PERMISSIONS.LIFECYCLE_VIEW_REPORTS, PERMISSIONS.ONBOARDING_MANAGE], '/hrm/lifecycle/reports'), workforce: href([PERMISSIONS.WORKFORCE_VIEW, PERMISSIONS.WORKFORCE_PLAN], '/hrod/workforce'), engagement: href([PERMISSIONS.ENGAGEMENT_VIEW_RESULTS, PERMISSIONS.ENGAGEMENT_MANAGE], '/hrod/engagement'), learning: href([PERMISSIONS.LEARNING_VIEW_REPORTS, PERMISSIONS.OJT_MANAGE], '/hrd/training/reports?view=learning') }} />

          <section>
            <div className="mb-2 flex items-center justify-between"><h2 className="text-sm font-semibold text-slate-900">Time & attendance</h2>{link([PERMISSIONS.ATTENDANCE_VIEW], '/hrm/attendance', 'Attendance reports')}</div>
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
              <Card><CardHeader title="Attendance" description={s.attendance ? `${n(s.attendance.employees)} employees with records` : 'not available'} /><div className="p-4">{s.attendance ? <Donut parts={[{ label: 'Present', value: s.attendance.totals.presentDays, className: 'text-emerald-500' }, { label: 'Late', value: s.attendance.totals.lateDays, className: 'text-amber-500' }, { label: 'Absent', value: s.attendance.totals.absentDays, className: 'text-red-500' }, { label: 'Leave', value: s.attendance.totals.leaveDays, className: 'text-sky-500' }, { label: 'Incomplete', value: s.attendance.totals.incompleteDays, className: 'text-slate-400' }]} /> : <p className="text-sm text-slate-400">Not available.</p>}</div></Card>
              <Card><CardHeader title="Leave" description={s.leave ? `${s.leave.period.from} → ${s.leave.period.to}` : 'not available'} /><div className="p-4">{s.leave ? <><div className="mb-3 grid grid-cols-3 gap-2 text-center"><Mini label="Approved" value={n(s.leave.summary.approvedRequests)} /><Mini label="Pending" value={n(s.leave.summary.pendingRequests)} /><Mini label="Approved units" value={n(s.leave.summary.approvedUnits)} /></div><BarList rows={s.leave.byLeaveType.slice(0, 6).map((t) => ({ label: t.name, value: t.approvedUnits }))} /></> : <p className="text-sm text-slate-400">Not available.</p>}</div></Card>
              <Card><CardHeader title="Overtime" description="Minutes only — never money" /><div className="p-4">{s.overtime ? <><div className="mb-3 grid grid-cols-3 gap-2 text-center"><Mini label="Requests" value={n(s.overtime.totals.requests)} /><Mini label="Approved" value={n(s.overtime.totals.approvedRequests)} /><Mini label="Approved" value={hours(s.overtime.totals.approvedMinutes)} /></div><BarList rows={[{ label: 'Workday', value: s.overtime.totals.byDayType.WORKDAY }, { label: 'Off day', value: s.overtime.totals.byDayType.OFF_DAY }, { label: 'Holiday', value: s.overtime.totals.byDayType.HOLIDAY }]} format={hours} /></> : <p className="text-sm text-slate-400">Not available.</p>}</div></Card>
            </div>
          </section>

          <section>
            <div className="mb-2 flex items-center justify-between"><h2 className="text-sm font-semibold text-slate-900">Performance</h2>{link(PERMISSIONS.PERFORMANCE_MANAGE_CYCLES, '/hrm/performance', 'Performance reports')}</div>
            {s.performance && s.performance.cycles.length > 0 ? (
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                {s.performance.cycles.map((c) => (
                  <Card key={c.cycle.id}><CardHeader title={c.cycle.name} description={`${titleCase(c.cycle.status)} · ${n(c.completion.finalized)} of ${n(c.completion.assigned)} finalized · average ${c.suppression ? 'withheld (small group)' : (c.averageFinalScore ?? '—')}`} /><div className="grid grid-cols-1 gap-4 p-4 sm:grid-cols-2">{c.suppression ? <p className="text-sm text-slate-500">Withheld — fewer than 5 people in this group (Task 47 small-group rule).</p> : <BarList rows={c.ratingDistribution.map((r) => ({ label: r.label, value: r.count ?? 0 }))} />}<BarList rows={c.byDepartment.slice(0, 8).map((r) => ({ label: r.departmentName, value: r.finalized, hint: r.suppression ? 'average withheld (small group)' : r.averageScore ? `avg ${r.averageScore}` : undefined }))} /></div></Card>
                ))}
              </div>
            ) : <Card><p className="p-4 text-sm text-slate-400">No performance cycle overlaps this range.</p></Card>}
          </section>

          <section>
            <div className="mb-2 flex items-center justify-between"><h2 className="text-sm font-semibold text-slate-900">Learning & development</h2>{link(PERMISSIONS.TRAINING_MANAGE, '/hrd/training/reports', 'Training reports')}</div>
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
              <Card><CardHeader title="Competency coverage" description="Latest levels vs current job profile" /><div className="p-4">{s.competency ? <><div className="mb-3 grid grid-cols-3 gap-2 text-center"><Mini label="Coverage" value={`${s.competency.coverage.coveragePercent}%`} /><Mini label="With a gap" value={s.competency.totals.employeesWithGap === null ? 'withheld' : n(s.competency.totals.employeesWithGap)} /><Mini label="Gap items" value={s.competency.totals.gapItems === null ? 'withheld' : n(s.competency.totals.gapItems)} /></div><BarList rows={s.competency.topGaps.filter((g) => g.belowRequirement !== null).slice(0, 6).map((g) => ({ label: g.competencyName, value: g.belowRequirement ?? 0 }))} /></> : <p className="text-sm text-slate-400">Not available.</p>}</div></Card>
              <Card><CardHeader title="Training" description="Task 25 definitions" /><div className="p-4">{s.training ? <><div className="mb-3 grid grid-cols-3 gap-2 text-center"><Mini label="Completion" value={s.training.completionRate === null ? '—' : `${s.training.completionRate}%`} /><Mini label="Hours" value={n(s.training.trainingHours)} /><Mini label="No-show" value={n(s.training.enrollments.noShow)} /></div><BarList rows={[{ label: 'Open needs', value: s.training.needs.open }, { label: 'In progress', value: s.training.needs.inProgress }, { label: 'Fulfilled', value: s.training.needs.fulfilled }, { label: 'Active IDPs', value: s.training.idps.active }, { label: 'Completed IDPs', value: s.training.idps.completed }]} /></> : <p className="text-sm text-slate-400">Not available.</p>}</div></Card>
              <Card><CardHeader title="Talent review" description="Counts per 9-box cell, all cycles" /><div className="p-4">{s.talent ? <BarList rows={s.talent.talent.nineBox.filter((c) => c.count > 0).map((c) => ({ label: nineBoxLabel(c.cell), value: c.count }))} /> : <p className="text-sm text-slate-400">Not available.</p>}</div></Card>
            </div>
          </section>

          <section>
            <div className="mb-2 flex items-center justify-between"><h2 className="text-sm font-semibold text-slate-900">Recruitment</h2>{link(PERMISSIONS.RECRUITMENT_MANAGE, '/hrm/recruitment/reports', 'Recruitment reports')}</div>
            {s.recruitment ? (
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
                <Card className="lg:col-span-2"><CardHeader title="Pipeline" description={`${n(s.recruitment.hires)} hires · average time to hire ${s.recruitment.averageTimeToHireDays ?? '—'} days`} /><div className="p-4"><BarList rows={s.recruitment.funnel.map((f) => ({ label: titleCase(f.stage), value: f.count }))} /></div></Card>
                <Card><CardHeader title="By source" /><div className="p-4"><BarList rows={s.recruitment.bySource.map((x) => ({ label: titleCase(x.source), value: x.applications, hint: `${x.hires} hired` }))} /></div></Card>
              </div>
            ) : <Card><p className="p-4 text-sm text-slate-400">Not available.</p></Card>}
          </section>

          <section>
            <div className="mb-2 flex items-center justify-between"><h2 className="text-sm font-semibold text-slate-900">Talent & succession</h2>{link(PERMISSIONS.TALENT_VIEW_REPORTS, '/hrd/career/reports', 'Talent reports')}</div>
            {s.talent ? (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
                <Stat label="Open plans" value={n(s.talent.succession.plans.total)} />
                <Stat label="With successor" value={n(s.talent.succession.plans.withSuccessor)} />
                <Stat label="Ready-now successor" value={n(s.talent.succession.plans.withReadyNow)} />
                <Stat label="Without successor" value={n(s.talent.succession.plans.withoutSuccessor)} />
                <Stat label="Critical, no successor" value={n(s.talent.succession.criticalWithoutSuccessor)} />
                <Stat label="Talent pools" value={n(s.talent.talent.pools.reduce((a, p) => a + p.activeMembers, 0))} hint="active members" />
              </div>
            ) : <Card><p className="p-4 text-sm text-slate-400">Not available.</p></Card>}
          </section>

          <section>
            <div className="mb-2 flex items-center justify-between"><h2 className="text-sm font-semibold text-slate-900">Employee relations (aggregate)</h2>{link([PERMISSIONS.EMPLOYEE_RELATIONS_VIEW, PERMISSIONS.EMPLOYEE_RELATIONS_MANAGE], '/hrm/employee-relations/reports', 'Employee relations reports')}</div>
            {s.employeeRelations && !s.employeeRelations.actions ? <Card><div className="p-4"><p className="text-sm text-slate-500">Withheld — fewer than 5 people in this group (Task 47 small-group rule).</p></div></Card> : s.employeeRelations?.actions ? <div className="grid grid-cols-2 gap-3 sm:grid-cols-4"><Stat label="Actions issued" value={n(s.employeeRelations.actions.issued)} /><Stat label="Active warnings" value={n(s.employeeRelations.actions.active)} /><Stat label="Awaiting acknowledgement" value={n(s.employeeRelations.actions.awaitingAcknowledgement)} /><Stat label="Overdue acknowledgement" value={n(s.employeeRelations.actions.overdueAcknowledgement)} /></div> : <Card><p className="p-4 text-sm text-slate-400">Not available.</p></Card>}
          </section>

          <BenefitsSection data={s.benefits} status={d.sectionStatus.benefits} reportLink={href([PERMISSIONS.BENEFITS_VIEW_REPORTS, PERMISSIONS.BENEFITS_MANAGE], '/hrm/benefits/reports')} />
          <ExpenseSection data={s.expense} status={d.sectionStatus.expense} reportLink={href([PERMISSIONS.EXPENSE_VIEW_REPORTS, PERMISSIONS.EXPENSE_MANAGE], '/hrm/expenses/analytics')} />
          <EmployeeServicesSection data={s.employeeServices} status={d.sectionStatus.employeeServices} reportLink={href([PERMISSIONS.HR_LETTER_VIEW_REPORTS, PERMISSIONS.SERVICE_REQUEST_MANAGE], '/hrm/services/reports')} />

          {s.payroll && (
            <section>
              <div className="mb-2 flex items-center justify-between"><h2 className="text-sm font-semibold text-slate-900">Payroll (organization totals)</h2>{link(PERMISSIONS.PAYROLL_MANAGE, '/hrm/payroll', 'Payroll')}</div>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4"><Stat label="Closed runs" value={n(s.payroll.runs)} /><Stat label="Employees paid" value={n(s.payroll.employeesPaid)} /></div>
              {/* Task 48: one row per currency — never a total across currencies, and no default currency. */}
              {s.payroll.byCurrency.length === 0 ? (
                <p className="mt-3 text-sm text-slate-500">No closed run in this range{s.payroll.withheldRuns ? ' that can be shown' : ''}.</p>
              ) : (
                <div className="mt-3 overflow-x-auto rounded-lg border border-slate-200 bg-white">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-50 text-left text-xs text-slate-500"><tr><th className="px-3 py-2 font-medium">Currency</th><th className="px-3 py-2 text-right font-medium">Runs</th><th className="px-3 py-2 text-right font-medium">Gross</th><th className="px-3 py-2 text-right font-medium">Deductions</th><th className="px-3 py-2 text-right font-medium">Net</th></tr></thead>
                    <tbody className="divide-y divide-slate-100">
                      {s.payroll.byCurrency.map((c) => (
                        <tr key={c.currencyCode}><td className="px-3 py-2 font-medium text-slate-900">{c.currencyCode}</td><td className="px-3 py-2 text-right tabular-nums">{n(c.runs)}</td><td className="px-3 py-2 text-right tabular-nums">{c.grossTotal}</td><td className="px-3 py-2 text-right tabular-nums">{c.deductionTotal}</td><td className="px-3 py-2 text-right tabular-nums">{c.netTotal}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {s.payroll.withheldRuns > 0 && <p className="mt-1 text-xs text-slate-500">Withheld: {s.payroll.withheldRuns} run(s) of fewer than {s.payroll.minimumGroupSize} employees.</p>}
              <p className="mt-1 text-xs text-slate-500">{s.payroll.note}</p>
            </section>
          )}
          <p className="text-xs text-slate-500">Generated {d.generatedAt.slice(0, 19).replace('T', ' ')} in {d.durationMs} ms. Historical domains keep their own attribution (a performance plan counts in the department it was created in; headcount is today's). See Definitions.</p>
        </div>
      )}
      <DefinitionsModal open={defs} onClose={() => setDefs(false)} />
    </>
  );
}

const Stat = ({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) => (
  <div className="rounded-lg border border-slate-200 bg-white p-3"><div className="text-xs text-slate-500">{label}</div><div className="mt-0.5 text-xl font-semibold tabular-nums text-slate-900">{value}</div>{hint && <div className="text-[11px] text-slate-400">{hint}</div>}</div>
);
const Mini = ({ label, value }: { label: string; value: React.ReactNode }) => <div><div className="text-lg font-semibold tabular-nums text-slate-900">{value}</div><div className="text-[11px] text-slate-500">{label}</div></div>;

function DefinitionsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const defs = useMetricDefinitions();
  return (
    <Modal open={open} onClose={onClose} title="Metric definitions" description="One definition per figure: what it counts, which module owns it, how it is attributed in time and to whom the filters apply." size="lg" footer={<Button variant="secondary" onClick={onClose}>Close</Button>}>
      {defs.isLoading && <LoadingBlock />}
      <ul className="divide-y divide-slate-100 text-sm">
        {(defs.data ?? []).map((m) => (
          <li key={m.key} className="py-2"><div className="font-medium text-slate-900">{m.name}</div><div className="text-slate-700">{m.definition}</div><div className="text-xs text-slate-500">Source: {m.source} · Attribution: {m.attribution} · Population: {m.population} · Filters: {m.filters}{m.currency ? ` · Currency: ${m.currency}` : ''}</div>{m.limitations && <div className="text-xs text-slate-500">Limitations: {m.limitations}</div>}</li>
        ))}
      </ul>
    </Modal>
  );
}
