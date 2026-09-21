import { useState } from 'react';
import { Plus } from 'lucide-react';
import { PERMISSIONS, type DepartmentDto } from '@hr/shared';
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
import { useDepartments, useOrgMutations, useOrganizationOptions } from './organization.api';
import { DepartmentFormModal } from './DepartmentFormModal';
import { PAGE_SIZE, RowActions, STATUS_OPTIONS, useStatusConfirm } from './shared';

export function DepartmentsPage() {
  const canManage = usePermission(PERMISSIONS.ORGANIZATION_MANAGE);
  const [search, setSearch] = useState('');
  const [organizationId, setOrganizationId] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const organizations = useOrganizationOptions();
  const list = useDepartments({ search: useDebounce(search), organizationId: organizationId || undefined, status: (status || undefined) as 'active' | 'inactive' | undefined, page, pageSize: PAGE_SIZE });
  const m = useOrgMutations<DepartmentDto>('departments');
  const confirm = useStatusConfirm('department', m);
  const [form, setForm] = useState<{ open: boolean; row: DepartmentDto | null }>({ open: false, row: null });

  const columns: Column<DepartmentDto>[] = [
    { key: 'code', header: 'Code', render: (d) => <span className="font-mono text-xs text-slate-700">{d.code}</span> },
    { key: 'name', header: 'Name', render: (d) => <div><div className="font-medium text-slate-900">{d.name}</div><div className="text-xs text-slate-400 sm:hidden">{d.organization.name}</div></div> },
    { key: 'org', header: 'Organization', hideBelow: 'sm', render: (d) => d.organization.name },
    { key: 'parent', header: 'Parent', hideBelow: 'md', render: (d) => (d.parent ? d.parent.name : <span className="text-slate-400">— top level —</span>) },
    { key: 'counts', header: 'Sub / Pos / Emp', hideBelow: 'lg', render: (d) => <span className="tabular-nums text-slate-500">{d.childCount} / {d.positionCount} / {d.employeeCount}</span> },
    { key: 'status', header: 'Status', render: (d) => <StatusBadge status={d.isActive ? 'ACTIVE' : 'INACTIVE'} /> },
    ...(canManage ? [{ key: 'actions', header: <span className="sr-only">Actions</span>, className: 'text-right', render: (d: DepartmentDto) => <RowActions isActive={d.isActive} onEdit={() => setForm({ open: true, row: d })} onToggle={() => confirm.ask({ id: d.id, label: d.name, isActive: d.isActive })} /> }] : []),
  ];

  return (
    <>
      <Card>
        <div className="flex flex-col gap-3 border-b border-slate-200 p-4 lg:flex-row lg:items-center">
          <SearchInput value={search} onChange={(v) => { setSearch(v); setPage(1); }} placeholder="Search code or name…" className="lg:w-64" />
          <Select options={(organizations.data?.data ?? []).map((o) => ({ value: o.id, label: o.name }))} placeholder="All organizations" value={organizationId} onChange={(e) => { setOrganizationId(e.target.value); setPage(1); }} className="lg:w-52" />
          <Select options={STATUS_OPTIONS} placeholder="All statuses" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} className="lg:w-40" />
          <div className="flex-1" />
          <PermissionGuard permission={PERMISSIONS.ORGANIZATION_MANAGE}>
            <Button onClick={() => setForm({ open: true, row: null })}><Plus className="h-4 w-4" /> New department</Button>
          </PermissionGuard>
        </div>
        {list.isError && <Alert className="m-4">Could not load departments.</Alert>}
        <DataTable columns={columns} rows={list.data?.data ?? []} rowKey={(d) => d.id} loading={list.isLoading} emptyTitle="No departments" emptyDescription="Add a department to an active organization." />
        {list.data?.meta && <Pagination {...list.data.meta} onPageChange={setPage} />}
      </Card>
      {canManage && <DepartmentFormModal open={form.open} onClose={() => setForm({ open: false, row: null })} department={form.row} />}
      {confirm.dialog}
    </>
  );
}
