import { useState } from 'react';
import type { DisciplinaryActionDto } from '@hr/shared';
import { Card } from '@/components/ui/Card';
import { Alert } from '@/components/ui/Alert';
import { Select } from '@/components/ui/Select';
import { Checkbox } from '@/components/ui/Checkbox';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { Pagination } from '@/components/ui/Pagination';
import { useDepartmentOptions } from '@/features/organization/organization.api';
import { useActionTypes, useActions } from './er.api';
import { localToday } from '@/lib/format';
import { ActionStatusBadge, ValidityBadge } from './er-ui';

/** Warnings and actions across cases: what is active, what has lapsed, who has not yet acknowledged. */
export function ActionsPage() {
  const departments = useDepartmentOptions();
  const types = useActionTypes(true);
  const [validity, setValidity] = useState('');
  const [actionTypeId, setTypeId] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [awaiting, setAwaiting] = useState(false);
  const [page, setPage] = useState(1);
  const actions = useActions({ validity, actionTypeId, departmentId, awaitingAcknowledgement: awaiting || undefined, page, pageSize: 20 });

  const columns: Column<DisciplinaryActionDto>[] = [
    { key: 'emp', header: 'Employee', render: (a) => <div><div className="font-medium text-slate-900">{a.employee.firstName} {a.employee.lastName}</div><div className="text-xs text-slate-400">{a.employee.employeeCode} · {a.caseNumber}</div></div> },
    { key: 'type', header: 'Action', render: (a) => a.actionType.name },
    { key: 'issued', header: 'Issued', hideBelow: 'sm', render: (a) => a.issuedDate ?? <span className="text-slate-400">—</span> },
    { key: 'until', header: 'On record until', hideBelow: 'md', render: (a) => a.validUntil ?? (a.issuedDate ? 'No end date' : <span className="text-slate-400">—</span>) },
    { key: 'validity', header: 'Validity', render: (a) => <ValidityBadge validity={a.validity} /> },
    { key: 'ack', header: 'Receipt', hideBelow: 'lg', render: (a) => (!a.requiresAcknowledgement ? <span className="text-slate-400">Not required</span> : a.acknowledgedAt ? `Acknowledged ${a.acknowledgedAt.slice(0, 10)}` : a.status === 'ISSUED' ? <span className="text-amber-700">Awaiting{a.acknowledgementDueDate && a.acknowledgementDueDate < localToday() ? ' · overdue' : ''}</span> : <span className="text-slate-400">—</span>) },
    { key: 'status', header: 'Status', render: (a) => <ActionStatusBadge status={a.status} /> },
  ];

  return (
    <Card>
      <div className="grid grid-cols-1 gap-3 border-b border-slate-200 p-4 sm:grid-cols-4">
        <Select options={[{ value: 'ACTIVE', label: 'Active' }, { value: 'EXPIRED', label: 'Expired' }]} placeholder="Any validity" value={validity} onChange={(e) => { setValidity(e.target.value); setPage(1); }} />
        <Select options={(types.data ?? []).map((t) => ({ value: t.id, label: t.name }))} placeholder="All action types" value={actionTypeId} onChange={(e) => { setTypeId(e.target.value); setPage(1); }} />
        <Select options={(departments.data?.data ?? []).map((d) => ({ value: d.id, label: d.name }))} placeholder="All departments" value={departmentId} onChange={(e) => { setDepartmentId(e.target.value); setPage(1); }} />
        <Checkbox label="Awaiting acknowledgement only" checked={awaiting} onChange={(e) => { setAwaiting(e.target.checked); setPage(1); }} />
      </div>
      {actions.isError && <Alert className="m-4">Could not load actions.</Alert>}
      <DataTable columns={columns} rows={actions.data?.data ?? []} rowKey={(a) => a.id} loading={actions.isLoading} emptyTitle="No actions" />
      {actions.data?.meta && <Pagination {...actions.data.meta} onPageChange={setPage} />}
    </Card>
  );
}
