import { useState } from 'react';
import { Plus } from 'lucide-react';
import { PERMISSIONS, type PositionDto } from '@hr/shared';
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
import { useDepartmentOptions, useJobOptions, useOrgMutations, useOrganizationOptions, usePositions } from './organization.api';
import { PositionFormModal } from './PositionFormModal';
import { PAGE_SIZE, RowActions, STATUS_OPTIONS, useStatusConfirm } from './shared';

export function PositionsPage() {
  const canManage = usePermission(PERMISSIONS.ORGANIZATION_MANAGE);
  const [search, setSearch] = useState('');
  const [organizationId, setOrganizationId] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [jobId, setJobId] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const organizations = useOrganizationOptions();
  const departments = useDepartmentOptions(organizationId || undefined);
  const jobs = useJobOptions();
  const list = usePositions({ search: useDebounce(search), organizationId: organizationId || undefined, departmentId: departmentId || undefined, jobId: jobId || undefined, status: (status || undefined) as 'active' | 'inactive' | undefined, page, pageSize: PAGE_SIZE });
  const m = useOrgMutations<PositionDto>('positions');
  const confirm = useStatusConfirm('position', m);
  const [form, setForm] = useState<{ open: boolean; row: PositionDto | null }>({ open: false, row: null });

  const columns: Column<PositionDto>[] = [
    { key: 'code', header: 'Code', render: (p) => <span className="font-mono text-xs text-slate-700">{p.code}</span> },
    { key: 'title', header: 'Position', render: (p) => <div><div className="font-medium text-slate-900">{p.title}</div><div className="text-xs text-slate-400 md:hidden">{p.department.name}</div></div> },
    { key: 'job', header: 'Job', hideBelow: 'sm', render: (p) => (p.job ? <span>{p.job.title} <span className="text-xs text-slate-400">L{p.job.level}</span></span> : <span className="text-slate-400">—</span>) },
    { key: 'dept', header: 'Department', hideBelow: 'md', render: (p) => p.department.name },
    { key: 'org', header: 'Organization', hideBelow: 'lg', render: (p) => p.department.organization.name },
    { key: 'emp', header: 'Emp', hideBelow: 'lg', render: (p) => <span className="tabular-nums text-slate-500">{p.employeeCount}</span> },
    { key: 'status', header: 'Status', render: (p) => <StatusBadge status={p.isActive ? 'ACTIVE' : 'INACTIVE'} /> },
    ...(canManage ? [{ key: 'actions', header: <span className="sr-only">Actions</span>, className: 'text-right', render: (p: PositionDto) => <RowActions isActive={p.isActive} onEdit={() => setForm({ open: true, row: p })} onToggle={() => confirm.ask({ id: p.id, label: p.title, isActive: p.isActive })} /> }] : []),
  ];

  const reset = () => setPage(1);
  return (
    <>
      <Card>
        <div className="grid grid-cols-1 gap-3 border-b border-slate-200 p-4 sm:grid-cols-2 xl:flex xl:items-center">
          <SearchInput value={search} onChange={(v) => { setSearch(v); reset(); }} placeholder="Search code or title…" className="xl:w-56" />
          <Select options={(organizations.data?.data ?? []).map((o) => ({ value: o.id, label: o.name }))} placeholder="All organizations" value={organizationId} onChange={(e) => { setOrganizationId(e.target.value); setDepartmentId(''); reset(); }} className="xl:w-48" />
          <Select options={(departments.data?.data ?? []).map((d) => ({ value: d.id, label: d.name }))} placeholder="All departments" value={departmentId} onChange={(e) => { setDepartmentId(e.target.value); reset(); }} className="xl:w-48" />
          <Select options={(jobs.data?.data ?? []).map((j) => ({ value: j.id, label: j.title }))} placeholder="All jobs" value={jobId} onChange={(e) => { setJobId(e.target.value); reset(); }} className="xl:w-44" />
          <Select options={STATUS_OPTIONS} placeholder="All statuses" value={status} onChange={(e) => { setStatus(e.target.value); reset(); }} className="xl:w-36" />
          <div className="hidden flex-1 xl:block" />
          <PermissionGuard permission={PERMISSIONS.ORGANIZATION_MANAGE}>
            <Button onClick={() => setForm({ open: true, row: null })}><Plus className="h-4 w-4" /> New position</Button>
          </PermissionGuard>
        </div>
        {list.isError && <Alert className="m-4">Could not load positions.</Alert>}
        <DataTable columns={columns} rows={list.data?.data ?? []} rowKey={(p) => p.id} loading={list.isLoading} emptyTitle="No positions" emptyDescription="A position is a concrete seat in a department that uses a job definition." />
        {list.data?.meta && <Pagination {...list.data.meta} onPageChange={setPage} />}
      </Card>
      {canManage && <PositionFormModal open={form.open} onClose={() => setForm({ open: false, row: null })} position={form.row} />}
      {confirm.dialog}
    </>
  );
}
