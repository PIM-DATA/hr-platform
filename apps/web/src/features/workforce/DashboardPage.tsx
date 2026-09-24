import { Card } from '@/components/ui/Card';
import { Alert } from '@/components/ui/Alert';
import { LoadingBlock } from '@/components/ui/Spinner';
import { DataTable, type Column } from '@/components/ui/DataTable';
import type { WorkforceDashboardDto } from '@hr/shared';
import { useWorkforceDashboard } from './workforce.api';
import { CyclePicker, Delta, DeltaBadge, Stat, useSelectedCycle } from './workforce-ui';

/** Current vs planned at a glance. Counts, deltas, vacancies and recruitment demand — no recommendation. */
export function WorkforceDashboardPage() {
  const sel = useSelectedCycle();
  const d = useWorkforceDashboard(sel.selected);
  const data = d.data;
  const deptCols: Column<WorkforceDashboardDto['byDepartment'][number]>[] = [
    { key: 'dept', header: 'Department', render: (r) => <span className="font-medium text-slate-900">{r.departmentName}</span> },
    { key: 'cur', header: 'Current', render: (r) => <span className="tabular-nums">{r.current}</span> },
    { key: 'plan', header: 'Planned', render: (r) => <span className="tabular-nums">{r.planned}</span> },
    { key: 'delta', header: 'Delta', render: (r) => <Delta value={r.delta} /> },
    { key: 'class', header: 'Classification', hideBelow: 'sm', render: (r) => <DeltaBadge classification={r.classification} /> },
  ];
  const jobCols: Column<WorkforceDashboardDto['byJob'][number]>[] = [
    { key: 'job', header: 'Job', render: (r) => <span className="font-medium text-slate-900">{r.jobTitle}</span> },
    { key: 'cur', header: 'Current', render: (r) => <span className="tabular-nums">{r.current}</span> },
    { key: 'plan', header: 'Planned', render: (r) => <span className="tabular-nums">{r.planned}</span> },
    { key: 'delta', header: 'Delta', render: (r) => <Delta value={r.delta} /> },
  ];
  return (
    <>
      <Card className="mb-4"><div className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2"><CyclePicker value={sel.selected} onChange={sel.set} cycles={sel.cycles} /><p className="self-end text-xs text-slate-500">{data?.cycle ? `Current figures are the snapshot taken for ${data.cycle.name}${data.cycle.status === 'FINALIZED' || data.cycle.status === 'ARCHIVED' ? ' (frozen at finalization)' : ''}.` : 'No plan selected: figures are the live workforce today.'}</p></div></Card>
      {d.isLoading && <LoadingBlock />}
      {d.isError && <Alert>Could not load the dashboard.</Alert>}
      {data && (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="Current headcount" value={data.currentHeadcount} hint="active employees" />
            <Stat label="Planned headcount" value={data.plannedHeadcount} />
            <Stat label="Net delta" value={<Delta value={data.netDelta} />} />
            <Stat label="Expansion demand" value={`+${data.expansionDemand}`} hint="sum of positive deltas" />
            <Stat label="Planned reductions" value={data.plannedReductions} hint="sum of negative deltas — a number, not a list" />
            <Stat label="Vacant positions" value={data.vacantPositions} hint="active positions with no active employee" />
            <Stat label="Open recruitment demand" value={data.openRecruitmentDemand} hint="open openings not yet hired" />
            <Stat label="Remaining demand" value={data.remainingDemand} hint="expansion not covered by recruitment" />
          </div>
          {data.cycle && (
            <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
              <Card><div className="border-b border-slate-200 px-4 py-3 text-sm font-semibold text-slate-900">By department</div><DataTable columns={deptCols} rows={data.byDepartment} rowKey={(r) => r.departmentId} emptyTitle="No plan rows" emptyDescription="Initialize the plan from the current workforce on the Headcount plan tab." /></Card>
              <Card><div className="border-b border-slate-200 px-4 py-3 text-sm font-semibold text-slate-900">By job</div><DataTable columns={jobCols} rows={data.byJob} rowKey={(r) => r.jobId ?? '-'} emptyTitle="No plan rows" /></Card>
            </div>
          )}
          <p className="mt-3 text-xs text-slate-400">Generated {new Date(data.generatedAt).toLocaleString()}. Planning figures never change an employee, a position or a department; changes happen in their own modules.</p>
        </>
      )}
    </>
  );
}
