import { useState } from 'react';
import type { VacancyDto } from '@hr/shared';
import { Card } from '@/components/ui/Card';
import { Alert } from '@/components/ui/Alert';
import { Select } from '@/components/ui/Select';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { useVacancies, useWorkforceOptions } from './workforce.api';

/** Position projection: FILLED (≥1 active employee) or VACANT (none). A fact about today, not a hiring request. */
export function VacanciesPage() {
  const options = useWorkforceOptions();
  const [organizationId, setOrg] = useState('');
  const [only, setOnly] = useState('VACANT');
  const list = useVacancies(organizationId || undefined);
  const rows = (list.data ?? []).filter((v) => !only || v.status === only);
  const columns: Column<VacancyDto>[] = [
    { key: 'pos', header: 'Position', render: (v) => <div><div className="font-medium text-slate-900">{v.positionTitle}</div><div className="text-xs text-slate-400">{v.positionCode}</div></div> },
    { key: 'dept', header: 'Department', render: (v) => v.departmentName },
    { key: 'job', header: 'Job', hideBelow: 'sm', render: (v) => v.jobTitle ?? <span className="text-slate-400">—</span> },
    { key: 'n', header: 'Active employees', hideBelow: 'md', render: (v) => <span className="tabular-nums">{v.activeEmployees}</span> },
    { key: 'status', header: 'Status', render: (v) => <StatusBadge status={v.status === 'VACANT' ? 'Vacant' : 'Filled'} tone={v.status === 'VACANT' ? 'warning' : 'success'} /> },
  ];
  return (
    <Card>
      <div className="grid grid-cols-1 gap-3 border-b border-slate-200 p-4 sm:grid-cols-3">
        <Select options={(options.data?.organizations ?? []).map((o) => ({ value: o.id, label: o.name }))} placeholder="All organizations" value={organizationId} onChange={(e) => setOrg(e.target.value)} />
        <Select options={[{ value: 'VACANT', label: 'Vacant only' }, { value: 'FILLED', label: 'Filled only' }]} placeholder="All positions" value={only} onChange={(e) => setOnly(e.target.value)} />
        <p className="self-center text-xs text-slate-500">A position is vacant when no active employee holds it today. Positions are not single seats, so this is a projection, not a headcount gap.</p>
      </div>
      {list.isError && <Alert className="m-4">Could not load positions.</Alert>}
      <DataTable columns={columns} rows={rows} rowKey={(v) => v.positionId} loading={list.isLoading} emptyTitle="No positions" emptyDescription="Nothing matches this filter." />
    </Card>
  );
}
