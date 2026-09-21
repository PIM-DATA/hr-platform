import { useState } from 'react';
import { Plus } from 'lucide-react';
import { PERMISSIONS, type OrganizationDto } from '@hr/shared';
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
import { useOrgMutations, useOrganizations } from './organization.api';
import { OrganizationFormModal } from './OrganizationFormModal';
import { PAGE_SIZE, RowActions, STATUS_OPTIONS, useStatusConfirm } from './shared';

export function OrganizationsPage() {
  const canManage = usePermission(PERMISSIONS.ORGANIZATION_MANAGE);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const list = useOrganizations({ search: useDebounce(search), status: (status || undefined) as 'active' | 'inactive' | undefined, page, pageSize: PAGE_SIZE });
  const m = useOrgMutations<OrganizationDto>('organizations');
  const confirm = useStatusConfirm('organization', m);
  const [form, setForm] = useState<{ open: boolean; row: OrganizationDto | null }>({ open: false, row: null });

  const columns: Column<OrganizationDto>[] = [
    { key: 'code', header: 'Code', render: (o) => <span className="font-mono text-xs text-slate-700">{o.code}</span> },
    { key: 'name', header: 'Name', render: (o) => <span className="font-medium text-slate-900">{o.name}</span> },
    { key: 'departments', header: 'Departments', hideBelow: 'sm', render: (o) => <span className="tabular-nums">{o.departmentCount}</span> },
    { key: 'employees', header: 'Employees', hideBelow: 'md', render: (o) => <span className="tabular-nums">{o.employeeCount}</span> },
    { key: 'status', header: 'Status', render: (o) => <StatusBadge status={o.isActive ? 'ACTIVE' : 'INACTIVE'} /> },
    ...(canManage ? [{ key: 'actions', header: <span className="sr-only">Actions</span>, className: 'text-right', render: (o: OrganizationDto) => <RowActions isActive={o.isActive} onEdit={() => setForm({ open: true, row: o })} onToggle={() => confirm.ask({ id: o.id, label: o.name, isActive: o.isActive })} /> }] : []),
  ];

  return (
    <>
      <Card>
        <div className="flex flex-col gap-3 border-b border-slate-200 p-4 sm:flex-row sm:items-center">
          <SearchInput value={search} onChange={(v) => { setSearch(v); setPage(1); }} placeholder="Search code or name…" className="sm:w-72" />
          <Select options={STATUS_OPTIONS} placeholder="All statuses" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} className="w-40" />
          <div className="flex-1" />
          <PermissionGuard permission={PERMISSIONS.ORGANIZATION_MANAGE}>
            <Button onClick={() => setForm({ open: true, row: null })}><Plus className="h-4 w-4" /> New organization</Button>
          </PermissionGuard>
        </div>
        {list.isError && <Alert className="m-4">Could not load organizations.</Alert>}
        <DataTable columns={columns} rows={list.data?.data ?? []} rowKey={(o) => o.id} loading={list.isLoading} emptyTitle="No organizations" emptyDescription="Create the first organization to start building the structure." />
        {list.data?.meta && <Pagination {...list.data.meta} onPageChange={setPage} />}
      </Card>
      {canManage && <OrganizationFormModal open={form.open} onClose={() => setForm({ open: false, row: null })} organization={form.row} />}
      {confirm.dialog}
    </>
  );
}
