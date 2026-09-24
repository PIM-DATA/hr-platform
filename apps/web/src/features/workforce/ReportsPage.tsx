import { useState } from 'react';
import { Link } from 'react-router-dom';
import { PERMISSIONS } from '@hr/shared';
import { Card } from '@/components/ui/Card';
import { Alert } from '@/components/ui/Alert';
import { Select } from '@/components/ui/Select';
import { LoadingBlock } from '@/components/ui/Spinner';
import { useAuth } from '@/hooks/useAuth';
import { useCompareScenarios, useScenarioComparison, useScenarios, useWorkforceDashboard } from './workforce.api';
import { CyclePicker, Delta, useSelectedCycle } from './workforce-ui';

const Table = ({ head, rows }: { head: string[]; rows: (React.ReactNode)[][] }) => (
  <div className="overflow-x-auto"><table className="min-w-full text-sm"><thead className="bg-slate-50"><tr>{head.map((h) => <th key={h} className="px-4 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">{h}</th>)}</tr></thead><tbody className="divide-y divide-slate-100">{rows.length === 0 ? <tr><td colSpan={head.length} className="px-4 py-6 text-center text-slate-400">No rows</td></tr> : rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} className="px-4 py-2 tabular-nums">{c}</td>)}</tr>)}</tbody></table></div>
);

/** Current vs planned by department and job, scenario comparison, and the Report Center datasets. Facts, no verdict. */
export function WorkforceReportsPage() {
  const { hasPermission } = useAuth();
  const view = hasPermission(PERMISSIONS.WORKFORCE_VIEW) || hasPermission(PERMISSIONS.WORKFORCE_PLAN) || hasPermission(PERMISSIONS.WORKFORCE_MANAGE);
  const design = hasPermission(PERMISSIONS.ORG_DESIGN_VIEW) || hasPermission(PERMISSIONS.ORG_DESIGN_MANAGE);
  const sel = useSelectedCycle();
  const dash = useWorkforceDashboard(view ? sel.selected : null);
  const scenarios = useScenarios({ page: 1, pageSize: 100 });
  const [a, setA] = useState(''); const [b, setB] = useState('');
  const single = useScenarioComparison(design && a && !b ? a : null);
  const pair = useCompareScenarios(design && a && b ? a : null, design && a && b ? b : null);
  const opts = (scenarios.data?.data ?? []).map((s) => ({ value: s.id, label: `${s.name} · ${s.status.toLowerCase()}` }));
  return (
    <div className="space-y-4">
      {view && (
        <Card>
          <div className="grid grid-cols-1 gap-3 border-b border-slate-200 p-4 sm:grid-cols-2"><CyclePicker value={sel.selected} onChange={sel.set} cycles={sel.cycles} /><div className="self-end text-sm text-slate-600">{dash.data && <>Current <b className="tabular-nums">{dash.data.currentHeadcount}</b> · planned <b className="tabular-nums">{dash.data.plannedHeadcount}</b> · delta <Delta value={dash.data.netDelta} /> · vacant positions <b className="tabular-nums">{dash.data.vacantPositions}</b> · open recruitment demand <b className="tabular-nums">{dash.data.openRecruitmentDemand}</b></>}</div></div>
          {dash.isLoading && <LoadingBlock />}
          {dash.data && dash.data.cycle && (
            <div className="grid grid-cols-1 xl:grid-cols-2">
              <div><div className="px-4 py-2 text-xs font-semibold uppercase text-slate-500">Headcount delta by department</div><Table head={['Department', 'Current', 'Planned', 'Delta']} rows={dash.data.byDepartment.map((r) => [r.departmentName, r.current, r.planned, <Delta key="d" value={r.delta} />])} /></div>
              <div><div className="px-4 py-2 text-xs font-semibold uppercase text-slate-500">Headcount delta by job</div><Table head={['Job', 'Current', 'Planned', 'Delta']} rows={dash.data.byJob.map((r) => [r.jobTitle, r.current, r.planned, <Delta key="d" value={r.delta} />])} /></div>
            </div>
          )}
          {dash.data && !dash.data.cycle && <p className="px-4 py-4 text-sm text-slate-400">Pick a planning cycle to see current vs planned.</p>}
        </Card>
      )}
      {design && (
        <Card>
          <div className="grid grid-cols-1 gap-3 border-b border-slate-200 p-4 sm:grid-cols-2"><Select label="Scenario" options={opts} placeholder="Choose a scenario" value={a} onChange={(e) => setA(e.target.value)} /><Select label="Compare with (optional)" options={opts.filter((o) => o.value !== a)} placeholder="Current organization" value={b} onChange={(e) => setB(e.target.value)} /></div>
          {(single.isError || pair.isError) && <Alert className="m-4">Could not load the comparison.</Alert>}
          {single.data && !b && (
            <div className="grid grid-cols-1 xl:grid-cols-2">
              <div><div className="px-4 py-2 text-xs font-semibold uppercase text-slate-500">Units — current vs planned (total {single.data.totals.current} → {single.data.totals.planned}, <Delta value={single.data.totals.delta} />)</div><Table head={['Unit', 'Current', 'Planned', 'Delta']} rows={single.data.byDepartment.map((r) => [<span key="n">{r.name}{r.plannedOnly && <span className="ml-1 rounded bg-brand-50 px-1 text-[10px] text-brand-700">planned only</span>}</span>, r.current, r.planned, <Delta key="d" value={r.delta} />])} /></div>
              <div><div className="px-4 py-2 text-xs font-semibold uppercase text-slate-500">Jobs — current vs planned</div><Table head={['Job', 'Current', 'Planned', 'Delta']} rows={single.data.byJob.map((r) => [r.jobTitle, r.current, r.planned, <Delta key="d" value={r.delta} />])} /></div>
            </div>
          )}
          {pair.data && (
            <div className="grid grid-cols-1 xl:grid-cols-2">
              <div><div className="px-4 py-2 text-xs font-semibold uppercase text-slate-500">Units — {pair.data.a.name} ({pair.data.a.planned}) vs {pair.data.b.name} ({pair.data.b.planned}), difference <Delta value={pair.data.delta} /></div><Table head={['Unit', pair.data.a.name, pair.data.b.name, 'Difference']} rows={pair.data.byDepartment.map((r) => [r.name, r.a, r.b, <Delta key="d" value={r.delta} />])} /></div>
              <div><div className="px-4 py-2 text-xs font-semibold uppercase text-slate-500">Jobs</div><Table head={['Job', pair.data.a.name, pair.data.b.name, 'Difference']} rows={pair.data.byJob.map((r) => [r.jobTitle, r.a, r.b, <Delta key="d" value={r.delta} />])} /></div>
            </div>
          )}
          <p className="px-4 py-3 text-xs text-slate-400">Scenarios are compared as numbers. The system does not rank them or name a best one.</p>
        </Card>
      )}
      {hasPermission(PERMISSIONS.REPORTS_VIEW) && <p className="text-xs text-slate-500">Build your own: the Report Center has the aggregate datasets <Link to="/hrm/reports/builder" className="text-brand-700 underline">Workforce plan summary</Link> and <Link to="/hrm/reports/builder" className="text-brand-700 underline">Organization design summary</Link>.</p>}
    </div>
  );
}
