import { useNavigate } from 'react-router-dom';
import type { RoleDto } from '@hr/shared';
import { PageHeader } from '@/components/layout/PageHeader';
import { Card } from '@/components/ui/Card';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { useRoles } from './roles.api';

export function RoleListPage() {
  const roles = useRoles();
  const navigate = useNavigate();

  const columns: Column<RoleDto>[] = [
    {
      key: 'name',
      header: 'Role',
      render: (r) => (
        <div>
          <div className="font-medium text-slate-900">{r.name}</div>
          <div className="text-xs text-slate-400">{r.code}</div>
        </div>
      ),
    },
    { key: 'description', header: 'Description', hideBelow: 'md', render: (r) => <span className="text-slate-600">{r.description ?? '—'}</span> },
    { key: 'scope', header: 'Data scope', hideBelow: 'sm', render: (r) => <StatusBadge status={r.dataScope} tone="info" /> },
    { key: 'permissions', header: 'Permissions', render: (r) => <span className="tabular-nums">{r.permissionCodes.length}</span> },
    { key: 'users', header: 'Users', hideBelow: 'sm', render: (r) => <span className="tabular-nums">{r.userCount}</span> },
    { key: 'system', header: 'Type', hideBelow: 'lg', render: (r) => (r.isSystem ? <StatusBadge status="SYSTEM" tone="neutral" /> : <StatusBadge status="CUSTOM" tone="info" />) },
  ];

  return (
    <>
      <PageHeader title="Roles" description="Roles group permissions. Click a role to view or edit its permissions." />
      <Card>
        <DataTable columns={columns} rows={roles.data ?? []} rowKey={(r) => r.id} loading={roles.isLoading} onRowClick={(r) => navigate(`/admin/roles/${r.id}`)} />
      </Card>
    </>
  );
}
