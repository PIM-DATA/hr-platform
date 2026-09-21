import { useState } from 'react';
import { Plus } from 'lucide-react';
import { PERMISSIONS, type JobDto } from '@hr/shared';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { Pagination } from '@/components/ui/Pagination';
import { SearchInput } from '@/components/ui/SearchInput';
import { Select } from '@/components/ui/Select';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { Alert } from '@/components/ui/Alert';
import { PermissionGuard } from '@/components/guards/PermissionGuard';
import { usePermission } from '@/hooks/usePermission';
import { useDebounce } from '@/hooks/useDebounce';
import { useJobs, useOrgMutations } from './organization.api';
import { JobFormModal } from './JobFormModal';
import { PAGE_SIZE, RowActions, STATUS_OPTIONS, useStatusConfirm } from './shared';

export function JobsPage() {
  const canManage = usePermission(PERMISSIONS.ORGANIZATION_MANAGE);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const list = useJobs({ search: useDebounce(search), status: (status || undefined) as 'active' | 'inactive' | undefined, page, pageSize: PAGE_SIZE });
  const m = useOrgMutations<JobDto>('jobs');
  const confirm = useStatusConfirm('job', m);
  const [form, setForm] = useState<{ open: boolean; row: JobDto | null }>({ open: false, row: null });

  const columns: Column<JobDto>[] = [
    { key: 'code', header: 'Code', render: (j) => <span className="font-mono text-xs text-slate-700">{j.code}</span> },
    { key: 'title', header: 'Title', render: (j) => <div><div className="font-medium text-slate-900">{j.title}</div>{j.description && <div className="max-w-md truncate text-xs text-slate-400">{j.description}</div>}</div> },
    { key: 'level', header: 'Level', hideBelow: 'sm', render: (j) => <span className="tabular-nums">L{j.level}</span> },
    { key: 'positions', header: 'Positions', hideBelow: 'md', render: (j) => <span className="tabular-nums">{j.positionCount}</span> },
    { key: 'status', header: 'Status', render: (j) => <StatusBadge status={j.isActive ? 'ACTIVE' : 'INACTIVE'} /> },
    ...(canManage ? [{ key: 'actions', header: <span className="sr-only">Actions</span>, className: 'text-right', render: (j: JobDto) => <RowActions isActive={j.isActive} onEdit={() => setForm({ open: true, row: j })} onToggle={() => confirm.ask({ id: j.id, label: j.title, isActive: j.isActive })} /> }] : []),
  ];

  return (
    <>
      <Card>
        <div className="flex flex-col gap-3 border-b border-slate-200 p-4 sm:flex-row sm:items-center">
          <SearchInput value={search} onChange={(v) => { setSearch(v); setPage(1); }} placeholder="Search code or title…" className="sm:w-72" />
          <Select options={STATUS_OPTIONS} placeholder="All statuses" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} className="w-40" />
          <div className="flex-1" />
          <PermissionGuard permission={PERMISSIONS.ORGANIZATION_MANAGE}>
            <Button onClick={() => setForm({ open: true, row: null })}><Plus className="h-4 w-4" /> New job</Button>
          </PermissionGuard>
        </div>
        {list.isError && <Alert className="m-4">Could not load jobs.</Alert>}
        <DataTable columns={columns} rows={list.data?.data ?? []} rowKey={(j) => j.id} loading={list.isLoading} emptyTitle="No jobs" emptyDescription="Jobs are reusable job definitions (e.g. Data Analyst) that positions refer to." />
        {list.data?.meta && <Pagination {...list.data.meta} onPageChange={setPage} />}
      </Card>
      {canManage && <JobFormModal open={form.open} onClose={() => setForm({ open: false, row: null })} job={form.row} />}
      {confirm.dialog}
    </>
  );
}
