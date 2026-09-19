import { useState } from 'react';
import { Plus, KeyRound, Pencil, UserCheck, UserX } from 'lucide-react';
import { PERMISSIONS, type UserDto } from '@hr/shared';
import { PageHeader } from '@/components/layout/PageHeader';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { Pagination } from '@/components/ui/Pagination';
import { SearchInput } from '@/components/ui/SearchInput';
import { Select } from '@/components/ui/Select';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Alert } from '@/components/ui/Alert';
import { PermissionGuard } from '@/components/guards/PermissionGuard';
import { usePermission } from '@/hooks/usePermission';
import { useDebounce } from '@/hooks/useDebounce';
import { useAuth } from '@/hooks/useAuth';
import { ApiClientError } from '@/lib/api-client';
import { formatDateTime } from '@/lib/format';
import { useRoles } from '@/features/roles/roles.api';
import { useUserMutations, useUsers } from './users.api';
import { UserFormModal } from './UserFormModal';
import { ResetPasswordModal } from './ResetPasswordModal';

const PAGE_SIZE = 20;

export function UserListPage() {
  const { user: me } = useAuth();
  const canCreate = usePermission(PERMISSIONS.USERS_CREATE);
  const canUpdate = usePermission(PERMISSIONS.USERS_UPDATE);
  const canActivate = usePermission(PERMISSIONS.USERS_ACTIVATE);

  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [role, setRole] = useState('');
  const [page, setPage] = useState(1);
  const debouncedSearch = useDebounce(search);

  const users = useUsers({ search: debouncedSearch, status: (status || undefined) as 'active' | 'inactive' | undefined, role: role || undefined, page, pageSize: PAGE_SIZE });
  const roles = useRoles();
  const { activate, deactivate } = useUserMutations();

  const [form, setForm] = useState<{ open: boolean; user: UserDto | null }>({ open: false, user: null });
  const [reset, setReset] = useState<UserDto | null>(null);
  const [confirm, setConfirm] = useState<{ user: UserDto; action: 'activate' | 'deactivate' } | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);

  const onConfirm = async () => {
    if (!confirm) return;
    setConfirmError(null);
    try {
      await (confirm.action === 'activate' ? activate : deactivate).mutateAsync(confirm.user.id);
      setConfirm(null);
    } catch (err) {
      setConfirmError(err instanceof ApiClientError ? err.error.message : 'Something went wrong.');
    }
  };

  const columns: Column<UserDto>[] = [
    {
      key: 'email',
      header: 'Email',
      render: (u) => (
        <div>
          <div className="font-medium text-slate-900">{u.email}</div>
          {u.id === me?.id && <span className="text-xs text-brand-600">You</span>}
        </div>
      ),
    },
    {
      key: 'employee',
      header: 'Employee',
      hideBelow: 'md',
      render: (u) => (u.employee ? <span>{u.employee.firstName} {u.employee.lastName} <span className="text-xs text-slate-400">({u.employee.employeeCode})</span></span> : <span className="text-slate-400">—</span>),
    },
    {
      key: 'roles',
      header: 'Roles',
      hideBelow: 'sm',
      render: (u) => (
        <div className="flex flex-wrap gap-1">
          {u.roles.map((r) => (
            <span key={r.code} className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-700">{r.name}</span>
          ))}
        </div>
      ),
    },
    { key: 'status', header: 'Status', render: (u) => <StatusBadge status={u.isActive ? 'ACTIVE' : 'INACTIVE'} /> },
    { key: 'lastLogin', header: 'Last login', hideBelow: 'lg', render: (u) => <span className="text-slate-500">{formatDateTime(u.lastLoginAt)}</span> },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      className: 'text-right',
      render: (u) => (
        <div className="flex justify-end gap-1">
          {canUpdate && (
            <>
              <Button variant="ghost" size="sm" onClick={() => setForm({ open: true, user: u })} aria-label="Edit"><Pencil className="h-4 w-4" /></Button>
              <Button variant="ghost" size="sm" onClick={() => setReset(u)} aria-label="Reset password"><KeyRound className="h-4 w-4" /></Button>
            </>
          )}
          {canActivate && u.id !== me?.id && (
            u.isActive ? (
              <Button variant="ghost" size="sm" className="text-red-600 hover:bg-red-50" onClick={() => setConfirm({ user: u, action: 'deactivate' })} aria-label="Deactivate"><UserX className="h-4 w-4" /></Button>
            ) : (
              <Button variant="ghost" size="sm" className="text-emerald-600 hover:bg-emerald-50" onClick={() => setConfirm({ user: u, action: 'activate' })} aria-label="Activate"><UserCheck className="h-4 w-4" /></Button>
            )
          )}
        </div>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Users"
        description="Login accounts, roles and access status."
        actions={
          <PermissionGuard permission={PERMISSIONS.USERS_CREATE}>
            <Button onClick={() => setForm({ open: true, user: null })}><Plus className="h-4 w-4" /> Add user</Button>
          </PermissionGuard>
        }
      />

      <Card>
        <div className="flex flex-col gap-3 border-b border-slate-200 p-4 sm:flex-row sm:items-center">
          <SearchInput value={search} onChange={(v) => { setSearch(v); setPage(1); }} placeholder="Search email, employee name or code…" className="sm:w-80" />
          <div className="flex gap-3">
            <Select options={[{ value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' }]} placeholder="All statuses" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} className="w-40" />
            <Select options={(roles.data ?? []).map((r) => ({ value: r.code, label: r.name }))} placeholder="All roles" value={role} onChange={(e) => { setRole(e.target.value); setPage(1); }} className="w-44" />
          </div>
        </div>

        {users.isError && <Alert className="m-4">Could not load users.</Alert>}
        <DataTable columns={columns} rows={users.data?.data ?? []} rowKey={(u) => u.id} loading={users.isLoading} emptyTitle="No users found" emptyDescription="Try a different search or filter." />
        {users.data?.meta && <Pagination page={users.data.meta.page} pageSize={users.data.meta.pageSize} total={users.data.meta.total} onPageChange={setPage} />}
      </Card>

      {(canCreate || canUpdate) && <UserFormModal open={form.open} onClose={() => setForm({ open: false, user: null })} roles={roles.data ?? []} user={form.user} />}
      {canUpdate && <ResetPasswordModal open={!!reset} onClose={() => setReset(null)} user={reset} />}
      <ConfirmDialog
        open={!!confirm}
        title={confirm?.action === 'deactivate' ? 'Deactivate user' : 'Activate user'}
        message={
          confirm?.action === 'deactivate'
            ? `${confirm.user.email} will be signed out everywhere and can no longer log in.`
            : `${confirm?.user.email} will be able to log in again.`
        }
        confirmLabel={confirm?.action === 'deactivate' ? 'Deactivate' : 'Activate'}
        variant={confirm?.action === 'deactivate' ? 'danger' : 'primary'}
        loading={activate.isPending || deactivate.isPending}
        error={confirmError}
        onConfirm={onConfirm}
        onCancel={() => { setConfirm(null); setConfirmError(null); }}
      />
    </>
  );
}
