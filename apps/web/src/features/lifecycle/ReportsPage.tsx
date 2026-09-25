import { useState } from 'react';
import { Link } from 'react-router-dom';
import { PERMISSIONS } from '@hr/shared';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Alert } from '@/components/ui/Alert';
import { LoadingBlock } from '@/components/ui/Spinner';
import { useAuth } from '@/hooks/useAuth';
import { useLifecycleReport } from './lifecycle.api';
import { Stat, titleCase } from './lifecycle-ui';

const Table = ({ head, rows }: { head: string[]; rows: React.ReactNode[][] }) => (
  <div className="overflow-x-auto"><table className="min-w-full text-sm"><thead className="bg-slate-50"><tr>{head.map((h) => <th key={h} className="px-4 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">{h}</th>)}</tr></thead><tbody className="divide-y divide-slate-100">{rows.length === 0 ? <tr><td colSpan={head.length} className="px-4 py-6 text-center text-slate-400">No rows</td></tr> : rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} className="px-4 py-2 tabular-nums">{c}</td>)}</tr>)}</tbody></table></div>
);
export function LifecycleReportsPage() {
  const { hasPermission } = useAuth();
  const year = new Date().getFullYear();
  const [from, setFrom] = useState(`${year}-01-01`); const [to, setTo] = useState(`${year}-12-31`);
  const r = useLifecycleReport({ from, to });
  if (r.isError) return <Alert>Could not load the report.</Alert>;
  const d = r.data;
  return (
    <div className="space-y-4">
      <Card><div className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-3"><Input label="From" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /><Input label="To" type="date" value={to} onChange={(e) => setTo(e.target.value)} /><p className="self-end text-xs text-slate-500">Counts by department, reason and month. No employee or manager ranking.</p></div></Card>
      {r.isLoading && <LoadingBlock />}
      {d && (<>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4"><Stat label="Onboarding started" value={d.onboarding.plansStarted} hint={`${d.onboarding.plansCompleted} completed · ${d.onboarding.completionRate ?? '—'}%`} /><Stat label="Probation outcomes" value={`${d.probation.passed} / ${d.probation.extended} / ${d.probation.notPassed}`} hint="passed / extended / not passed" /><Stat label="Upcoming departures" value={d.offboarding.upcomingDepartures} hint={`${d.offboarding.active} active cases`} /><Stat label="Completed separations" value={d.offboarding.completedSeparations} /></div>
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <Card><div className="border-b border-slate-200 px-4 py-3 text-sm font-semibold text-slate-900">Onboarding by department</div><Table head={['Department', 'Plans', 'Completed', 'Avg progress']} rows={d.onboarding.byDepartment.map((x) => [x.department, x.plans, x.completed, x.avgProgressPct === null ? '—' : `${x.avgProgressPct}%`])} /></Card>
          <Card><div className="border-b border-slate-200 px-4 py-3 text-sm font-semibold text-slate-900">Probation by department</div><Table head={['Department', 'Active', 'Passed', 'Extended', 'Not passed']} rows={d.probation.byDepartment.map((x) => [x.department, x.active, x.passed, x.extended, x.notPassed])} /></Card>
          <Card><div className="border-b border-slate-200 px-4 py-3 text-sm font-semibold text-slate-900">Departures by reason</div><Table head={['Reason', 'Cases']} rows={d.offboarding.byReason.map((x) => [titleCase(x.reason), x.count])} /></Card>
          <Card><div className="border-b border-slate-200 px-4 py-3 text-sm font-semibold text-slate-900">Completed separations by month</div><Table head={['Month', 'Completed']} rows={d.offboarding.byMonth.map((x) => [x.month, x.completed])} /></Card>
        </div>
      </>)}
      {hasPermission(PERMISSIONS.REPORTS_VIEW) && <p className="text-xs text-slate-500">Report Center datasets: <Link to="/hrm/reports/builder" className="text-brand-700 underline">Onboarding summary</Link>, <Link to="/hrm/reports/builder" className="text-brand-700 underline">Probation summary</Link>, <Link to="/hrm/reports/builder" className="text-brand-700 underline">Offboarding summary</Link> — departments, statuses and months only.</p>}
    </div>
  );
}
