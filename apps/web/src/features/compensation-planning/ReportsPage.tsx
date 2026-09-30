import { useEffect, useState } from 'react';
import { Card, CardHeader } from '@/components/ui/Card';
import { Alert } from '@/components/ui/Alert';
import { Select } from '@/components/ui/Select';
import { LoadingBlock } from '@/components/ui/Spinner';
import { errorMessage } from '@/features/organization/shared';
import { useCompReport, useReportCycles } from './comp.api';
import { CompBadge, Stat, money } from './comp-ui';

/**
 * Aggregate salary-review reporting: counts and exact totals per cycle, organization level. The department split
 * appears only for compensation-authorized HR (the API omits it for anyone else, an executive included). No person,
 * no individual salary, no comment.
 */
export function CompReportsPage() {
  const cycles = useReportCycles();
  const [id, setId] = useState<string>();
  useEffect(() => { if (!id && cycles.data?.length) setId(cycles.data[0]!.id); }, [cycles.data, id]);
  const r = useCompReport(id);
  const d = r.data;
  if (cycles.isLoading) return <LoadingBlock />;
  if (!cycles.data?.length) return <p className="text-sm text-slate-500">No salary review has been activated yet.</p>;
  const cur = d?.cycle.currency;
  return (
    <div className="space-y-4">
      <div className="max-w-sm"><Select label="Salary review" value={id ?? ''} onChange={(e) => setId(e.target.value)} options={cycles.data.map((c) => ({ value: c.id, label: `${c.name} · ${c.effectiveDate}` }))} /></div>
      {r.isLoading && <LoadingBlock />}
      {r.isError && <Alert>{errorMessage(r.error)}</Alert>}
      {d && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Status" value={<CompBadge status={d.cycle.status} />} hint={d.cycle.applied ? 'Applied to salary history' : `Effective ${d.cycle.effectiveDate}`} />
            <Stat label="Population" value={d.population.eligible} hint={`${d.population.total} in scope · ${d.population.notPlannable} not plannable`} />
            <Stat label="With a proposal" value={d.completion.addressedPercent === null ? '—' : `${d.completion.addressedPercent}%`} hint={`${d.completion.approved} approved · ${d.completion.returned} returned`} />
            <Stat label="Average increase" value={d.averageIncreasePercent === null ? '—' : `${d.averageIncreasePercent}%`} hint="Σ increase ÷ Σ current salary of rows with a proposal" />
            <Stat label="Current base total" value={money(d.totals.currentBase)} hint={cur} />
            <Stat label="Proposed increase" value={money(d.totals.increase)} hint={`Approved ${money(d.totals.approvedIncrease)} ${cur}`} />
            <Stat label="Base after plan" value={money(d.totals.proposedBase)} hint={cur} />
            <Stat label="Budget remaining" value={d.budget ? money(d.budget.remaining) : '—'} tone={d.budget?.overBudget ? 'danger' : undefined} hint={d.budget ? `of ${money(d.budget.amount)} ${cur}` : 'No budget set'} />
          </div>
          {d.byDepartment && (
            <Card>
              <CardHeader title="By department (department at activation)" description="Compensation HR only. Not shown to aggregate-only readers: in a small department a total could reveal one person's salary." />
              <div className="overflow-x-auto"><table className="min-w-full text-sm">
                <thead className="bg-slate-50"><tr>{['Department', 'People', 'With a proposal', 'Current base', 'Increase', 'Base after plan'].map((h) => <th key={h} scope="col" className="px-4 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">{h}</th>)}</tr></thead>
                <tbody className="divide-y divide-slate-100">{d.byDepartment.map((x) => <tr key={x.department}><td className="px-4 py-2">{x.department}</td><td className="px-4 py-2 tabular-nums">{x.rows}</td><td className="px-4 py-2 tabular-nums">{x.addressed}</td><td className="px-4 py-2 tabular-nums">{money(x.currentBase)}</td><td className="px-4 py-2 tabular-nums">{money(x.increase)}</td><td className="px-4 py-2 tabular-nums">{money(x.proposedBase)}</td></tr>)}</tbody>
              </table></div>
            </Card>
          )}
          <p className="text-xs text-slate-500">Base salary only: no bonus, tax, social security or total-cost modelling. One currency per review; nothing is converted.</p>
        </>
      )}
    </div>
  );
}
