import { useEffect, useState } from 'react';
import { Card, CardHeader } from '@/components/ui/Card';
import { Alert } from '@/components/ui/Alert';
import { Select } from '@/components/ui/Select';
import { LoadingBlock } from '@/components/ui/Spinner';
import { EmptyState } from '@/components/ui/EmptyState';
import { useDepartmentOptions } from '@/features/organization/organization.api';
import { useCycleReport, usePerformanceCycles } from './performance.api';
import { Score } from './performance-ui';

/**
 * Cycle reporting — aggregates only.
 *
 * Nobody's individual score, rating or comment appears here, which is what makes this screen safe for a wider
 * audience than the people entitled to read one person's review. Every figure is counted in the database against the
 * plan **snapshots**, so a transfer never moves somebody's finished result into another department's average.
 */
export function PerformanceReportsPage() {
  const cycles = usePerformanceCycles({ pageSize: 50 });
  const [cycleId, setCycleId] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const departments = useDepartmentOptions();
  const report = useCycleReport(cycleId || null, departmentId || undefined);

  useEffect(() => {
    if (!cycleId && cycles.data?.data.length) setCycleId(cycles.data.data[0].id);
  }, [cycles.data, cycleId]);

  const r = report.data;
  const completionPercent = r && r.completion.assigned > 0 ? Math.round((r.completion.finalized / r.completion.assigned) * 100) : 0;

  return (
    <div className="space-y-4">
      <Card>
        <div className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2">
          <Select
            label="Cycle"
            options={(cycles.data?.data ?? []).map((c) => ({ value: c.id, label: `${c.name} (${c.status.toLowerCase()})` }))}
            placeholder="Select a cycle"
            value={cycleId}
            onChange={(e) => setCycleId(e.target.value)}
          />
          <Select
            label="Department"
            options={(departments.data?.data ?? []).map((d) => ({ value: d.id, label: d.name }))}
            placeholder="All departments"
            value={departmentId}
            onChange={(e) => setDepartmentId(e.target.value)}
          />
        </div>
      </Card>

      {!cycleId && <Card><EmptyState title="Choose a cycle" description="Reports are per cycle." /></Card>}
      {report.isLoading && cycleId && <LoadingBlock />}
      {report.isError && <Alert>Could not load this report.</Alert>}

      {r && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Figure label="Assigned" value={r.completion.assigned} />
            <Figure label="Self reviews in" value={r.completion.selfSubmitted} />
            <Figure label="Reviews in" value={r.completion.managerSubmitted} />
            <Figure label="Complete" value={`${r.completion.finalized} · ${completionPercent}%`} />
          </div>

          <Card>
            <CardHeader title="Average final score" description="Across the plans that have been completed." />
            <div className="px-5 py-4 text-2xl font-semibold text-slate-900">
              {r.averageFinalScore ? <Score value={r.averageFinalScore} /> : <span className="text-base font-normal text-slate-400">No completed reviews yet</span>}
            </div>
          </Card>

          <Card>
            <CardHeader title="Rating distribution" />
            <ul className="divide-y divide-slate-100 px-5 py-2">
              {r.ratingDistribution.map((band) => (
                <li key={band.code} className="flex items-center justify-between py-2 text-sm">
                  <span className="text-slate-700">{band.label}</span>
                  <span className="flex items-center gap-3">
                    <span className="h-1.5 w-32 overflow-hidden rounded-full bg-slate-200" aria-hidden>
                      <span className="block h-full rounded-full bg-brand-500" style={{ width: `${r.completion.finalized ? (band.count / r.completion.finalized) * 100 : 0}%` }} />
                    </span>
                    <span className="w-8 text-right tabular-nums text-slate-900">{band.count}</span>
                  </span>
                </li>
              ))}
            </ul>
          </Card>

          <Card>
            <CardHeader title="By department" description="Counted where each plan was written, not where the employee sits today." />
            <ul className="divide-y divide-slate-100 px-5 py-2">
              {r.byDepartment.map((row) => (
                <li key={row.departmentName} className="flex items-center justify-between py-2 text-sm">
                  <span className="text-slate-700">{row.departmentName}</span>
                  <span className="flex items-center gap-4 text-slate-600">
                    <span className="tabular-nums">{row.finalized}/{row.assigned} complete</span>
                    <Score value={row.averageScore} className="w-12 text-right font-medium text-slate-900" />
                  </span>
                </li>
              ))}
            </ul>
          </Card>

          <Card>
            <CardHeader title="By KPI" description="The average score reviewers gave, across the plans that used each KPI." />
            <ul className="divide-y divide-slate-100 px-5 py-2">
              {r.byKpi.length === 0 && <li className="py-2 text-sm text-slate-400">No scored KPIs yet.</li>}
              {r.byKpi.map((row) => (
                <li key={row.kpiCode} className="flex items-center justify-between py-2 text-sm">
                  <span className="text-slate-700">{row.kpiName} <span className="text-xs text-slate-400">· {row.plans} plan{row.plans === 1 ? '' : 's'}</span></span>
                  <Score value={row.averageManagerScore} className="font-medium text-slate-900" />
                </li>
              ))}
            </ul>
          </Card>
        </>
      )}
    </div>
  );
}

const Figure = ({ label, value }: { label: string; value: React.ReactNode }) => (
  <div className="rounded-lg border border-slate-200 bg-white p-3">
    <div className="text-xs text-slate-500">{label}</div>
    <div className="mt-0.5 text-lg font-semibold tabular-nums text-slate-900">{value}</div>
  </div>
);
