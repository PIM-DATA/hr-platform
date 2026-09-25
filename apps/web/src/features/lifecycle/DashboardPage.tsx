import { Link } from 'react-router-dom';
import { Card } from '@/components/ui/Card';
import { Alert } from '@/components/ui/Alert';
import { LoadingBlock } from '@/components/ui/Spinner';
import { useLifecycleDashboard } from './lifecycle.api';
import { Stat, titleCase } from './lifecycle-ui';

export function LifecycleDashboardPage() {
  const d = useLifecycleDashboard();
  if (d.isLoading) return <LoadingBlock />;
  if (d.isError || !d.data) return <Alert>Could not load the dashboard.</Alert>;
  const x = d.data;
  const link = (u: { kind: string; id: string }) => (u.kind === 'START' ? `/hrm/lifecycle/onboarding?open=${u.id}` : u.kind === 'PROBATION_END' ? `/hrm/lifecycle/probation?open=${u.id}` : `/hrm/lifecycle/offboarding?open=${u.id}`);
  return (
    <div className="space-y-4">
      <div><div className="mb-2 text-xs font-semibold uppercase text-slate-500">Onboarding</div><div className="grid grid-cols-2 gap-3 md:grid-cols-4"><Stat label="Active plans" value={x.onboarding.active} hint={`${x.onboarding.draft} in draft`} /><Stat label="Average progress" value={x.onboarding.avgProgressPct === null ? '—' : `${x.onboarding.avgProgressPct}%`} /><Stat label="Overdue tasks" value={x.onboarding.overdueTasks} /><Stat label="Unassigned tasks" value={x.onboarding.unassignedTasks} hint="new joiners without an account" /></div></div>
      <div><div className="mb-2 text-xs font-semibold uppercase text-slate-500">Probation</div><div className="grid grid-cols-2 gap-3 md:grid-cols-4"><Stat label="Active" value={x.probation.active} /><Stat label="Due within 14 days" value={x.probation.dueWithin14Days} /><Stat label="Passed (90 days)" value={x.probation.passedLast90Days} hint={`${x.probation.extendedLast90Days} extended`} /><Stat label="Not passed (90 days)" value={x.probation.notPassedLast90Days} /></div></div>
      <div><div className="mb-2 text-xs font-semibold uppercase text-slate-500">Offboarding</div><div className="grid grid-cols-2 gap-3 md:grid-cols-4"><Stat label="Active cases" value={x.offboarding.active} /><Stat label="Ready to complete" value={x.offboarding.readyToComplete} /><Stat label="Departures next 30 days" value={x.offboarding.departuresNext30Days} /><Stat label="Completed (90 days)" value={x.offboarding.completedLast90Days} hint={`${x.offboarding.overdueTasks} overdue tasks`} /></div></div>
      {x.upcoming.length > 0 && <Card><div className="border-b border-slate-200 px-4 py-3 text-sm font-semibold text-slate-900">Upcoming</div><ul className="divide-y divide-slate-100 text-sm">{x.upcoming.map((u) => <li key={`${u.kind}-${u.id}`} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2"><span><Link to={link(u)} className="font-medium text-brand-700 underline">{u.employeeName}</Link> <span className="text-xs text-slate-400">{u.employeeCode}{u.department && ` · ${u.department}`}</span></span><span className="text-xs text-slate-600">{titleCase(u.kind)} · {u.date}</span></li>)}</ul></Card>}
      <p className="text-xs text-slate-400">Counts and dates. No score, no ranking, no recommendation.</p>
    </div>
  );
}
