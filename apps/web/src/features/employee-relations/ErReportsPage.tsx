import { useState } from 'react';
import { Card, CardHeader } from '@/components/ui/Card';
import { Alert } from '@/components/ui/Alert';
import { Select } from '@/components/ui/Select';
import { LoadingBlock } from '@/components/ui/Spinner';
import { useDepartmentOptions } from '@/features/organization/organization.api';
import { useErReport } from './er.api';

/** Counts by status, department, action type and month. Nobody is named and nobody is ranked. */
export function ErReportsPage() {
  const departments = useDepartmentOptions();
  const [departmentId, setDepartmentId] = useState('');
  const report = useErReport({ departmentId });
  const r = report.data;
  return (
    <div className="space-y-4">
      <Card><div className="p-4"><Select label="Department" options={(departments.data?.data ?? []).map((d) => ({ value: d.id, label: d.name }))} placeholder="All departments" value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} className="max-w-sm" /></div></Card>
      {report.isLoading && <LoadingBlock />}
      {report.isError && <Alert>Could not load the report.</Alert>}
      {r && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            {[['Actions issued', r.actions.issued], ['Active', r.actions.active], ['Expired', r.actions.expired], ['Awaiting acknowledgement', r.actions.awaitingAcknowledgement], ['Overdue acknowledgement', r.actions.overdueAcknowledgement]].map(([label, value]) => (
              <div key={label} className="rounded-lg border border-slate-200 bg-white p-3"><div className="text-xs text-slate-500">{label}</div><div className="mt-0.5 text-xl font-semibold tabular-nums text-slate-900">{value}</div></div>
            ))}
          </div>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Breakdown title="Cases by status" rows={r.casesByStatus.map((s) => ({ label: s.status.toLowerCase().replace('_', ' '), cells: [`${s.count}`] }))} />
            <Breakdown title="By action type" rows={r.byActionType.map((t) => ({ label: t.actionTypeName, cells: [`${t.issued} issued`, `${t.active} active`] }))} />
            <Breakdown title="By department" rows={r.byDepartment.map((d) => ({ label: d.departmentName, cells: [`${d.cases} cases`, `${d.issued} issued`, `${d.active} active`] }))} />
            <Breakdown title="By month" rows={r.byMonth.map((m) => ({ label: m.month, cells: [`${m.cases} cases`, `${m.issued} issued`] }))} />
          </div>
          <p className="text-xs text-slate-500">Aggregate only. This report names nobody and ranks nobody.</p>
        </>
      )}
    </div>
  );
}

const Breakdown = ({ title, rows }: { title: string; rows: { label: string; cells: string[] }[] }) => (
  <Card>
    <CardHeader title={title} />
    <ul className="divide-y divide-slate-100 px-5 py-2">
      {rows.length === 0 && <li className="py-2 text-sm text-slate-400">Nothing to show yet.</li>}
      {rows.map((row) => <li key={row.label} className="flex items-center justify-between py-2 text-sm"><span className="capitalize text-slate-700">{row.label}</span><span className="flex gap-3 text-slate-600">{row.cells.map((c) => <span key={c} className="tabular-nums">{c}</span>)}</span></li>)}
    </ul>
  </Card>
);
