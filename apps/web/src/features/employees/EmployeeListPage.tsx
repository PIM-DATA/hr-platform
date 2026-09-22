import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { EMPLOYMENT_STATUSES, EMPLOYMENT_TYPES, PERMISSIONS, type EmployeeListItem, type EmploymentStatus, type EmploymentType } from '@hr/shared';
import { PageHeader } from '@/components/layout/PageHeader';
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
import { formatDate } from '@/lib/format';
import { useDepartmentOptions, useOrganizationOptions, usePositions } from '@/features/organization/organization.api';
import { useEmployees } from './employees.api';
import { EmployeeFormModal } from './EmployeeFormModal';

const PAGE_SIZE = 20;

export function EmployeeListPage() {
  const navigate = useNavigate();
  const canCreate = usePermission(PERMISSIONS.EMPLOYEES_CREATE);
  const [search, setSearch] = useState('');
  const [organizationId, setOrganizationId] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [positionId, setPositionId] = useState('');
  const [employmentType, setEmploymentType] = useState('');
  const [employmentStatus, setEmploymentStatus] = useState('');
  const [page, setPage] = useState(1);
  const [params, setParams] = useSearchParams();
  // /employees?new=1 (dashboard quick action) opens the create modal directly
  const [createOpen, setCreateOpen] = useState(params.get('new') === '1');
  const closeCreate = () => { setCreateOpen(false); if (params.has('new')) { const p = new URLSearchParams(params); p.delete('new'); setParams(p, { replace: true }); } };

  const organizations = useOrganizationOptions();
  const departments = useDepartmentOptions(organizationId || undefined);
  const positions = usePositions({ departmentId: departmentId || undefined, organizationId: organizationId || undefined, pageSize: 100 });
  const list = useEmployees({
    search: useDebounce(search), organizationId: organizationId || undefined, departmentId: departmentId || undefined, positionId: positionId || undefined,
    employmentType: (employmentType || undefined) as EmploymentType | undefined, employmentStatus: (employmentStatus || undefined) as EmploymentStatus | undefined, page, pageSize: PAGE_SIZE,
  });

  const reset = () => setPage(1);
  const columns: Column<EmployeeListItem>[] = [
    { key: 'code', header: 'Code', render: (e) => <span className="font-mono text-xs text-slate-700">{e.employeeCode}</span> },
    { key: 'name', header: 'Employee', render: (e) => <div><div className="font-medium text-slate-900">{e.firstName} {e.lastName}{e.nickname && <span className="ml-1 text-xs text-slate-400">({e.nickname})</span>}</div><div className="text-xs text-slate-400">{e.email}</div></div> },
    { key: 'position', header: 'Position', hideBelow: 'sm', render: (e) => e.position.title },
    { key: 'department', header: 'Department', hideBelow: 'md', render: (e) => e.department.name },
    { key: 'org', header: 'Organization', hideBelow: 'lg', render: (e) => e.organization.name },
    { key: 'manager', header: 'Manager', hideBelow: 'lg', render: (e) => (e.manager ? `${e.manager.firstName} ${e.manager.lastName}` : <span className="text-slate-400">—</span>) },
    { key: 'type', header: 'Type', hideBelow: 'lg', render: (e) => <span className="text-xs text-slate-600">{e.employmentType.replace('_', ' ')}</span> },
    { key: 'status', header: 'Status', render: (e) => <StatusBadge status={e.employmentStatus} /> },
    { key: 'hire', header: 'Hire date', hideBelow: 'md', render: (e) => <span className="text-slate-500">{formatDate(e.hireDate)}</span> },
  ];

  return (
    <>
      <PageHeader title="Employees" description="Employee master — the single source of truth every module refers to."
        actions={<PermissionGuard permission={PERMISSIONS.EMPLOYEES_CREATE}><Button onClick={() => setCreateOpen(true)}><Plus className="h-4 w-4" /> Add employee</Button></PermissionGuard>} />
      <Card>
        <div className="grid grid-cols-1 gap-3 border-b border-slate-200 p-4 sm:grid-cols-2 xl:grid-cols-7">
          <SearchInput value={search} onChange={(v) => { setSearch(v); reset(); }} placeholder="Search code, name, email…" className="xl:col-span-2" />
          <Select options={(organizations.data?.data ?? []).map((o) => ({ value: o.id, label: o.name }))} placeholder="All organizations" value={organizationId} onChange={(e) => { setOrganizationId(e.target.value); setDepartmentId(''); setPositionId(''); reset(); }} />
          <Select options={(departments.data?.data ?? []).map((d) => ({ value: d.id, label: d.name }))} placeholder="All departments" value={departmentId} onChange={(e) => { setDepartmentId(e.target.value); setPositionId(''); reset(); }} />
          <Select options={(positions.data?.data ?? []).map((p) => ({ value: p.id, label: p.title }))} placeholder="All positions" value={positionId} onChange={(e) => { setPositionId(e.target.value); reset(); }} />
          <div className="flex gap-3 xl:col-span-2">
            <Select options={EMPLOYMENT_TYPES.map((t) => ({ value: t, label: t.replace('_', ' ') }))} placeholder="All types" value={employmentType} onChange={(e) => { setEmploymentType(e.target.value); reset(); }} className="flex-1" />
            <Select options={EMPLOYMENT_STATUSES.map((s) => ({ value: s, label: s }))} placeholder="All statuses" value={employmentStatus} onChange={(e) => { setEmploymentStatus(e.target.value); reset(); }} className="flex-1" />
          </div>
        </div>
        {list.isError && <Alert className="m-4">Could not load employees.</Alert>}
        <DataTable columns={columns} rows={list.data?.data ?? []} rowKey={(e) => e.id} loading={list.isLoading} onRowClick={(e) => navigate(`/employees/${e.id}`)} emptyTitle="No employees found" emptyDescription="You only see employees within your data scope. Adjust the filters or add an employee." />
        {list.data?.meta && <Pagination {...list.data.meta} onPageChange={setPage} />}
      </Card>
      {canCreate && <EmployeeFormModal open={createOpen} onClose={closeCreate} onCreated={(id) => navigate(`/employees/${id}`)} />}
    </>
  );
}
