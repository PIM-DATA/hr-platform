import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Lock } from 'lucide-react';
import { CRITICAL_PERMISSIONS, PERMISSIONS, PERMISSION_ACTION_LABELS, ROLES } from '@hr/shared';
import { PageHeader } from '@/components/layout/PageHeader';
import { Card, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { Alert } from '@/components/ui/Alert';
import { LoadingBlock } from '@/components/ui/Spinner';
import { usePermission } from '@/hooks/usePermission';
import { ApiClientError } from '@/lib/api-client';
import { groupByModule, usePermissions, useRole, useUpdateRolePermissions } from './roles.api';

export function RoleDetailPage() {
  const { id } = useParams<{ id: string }>();
  const role = useRole(id);
  const permissions = usePermissions();
  const update = useUpdateRolePermissions();
  const canManage = usePermission(PERMISSIONS.ROLES_MANAGE);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);

  useEffect(() => {
    if (role.data) setSelected(new Set(role.data.permissionCodes));
  }, [role.data]);

  const groups = useMemo(() => groupByModule(permissions.data ?? []), [permissions.data]);
  const isSystemAdmin = role.data?.code === ROLES.SYSTEM_ADMIN;
  const locked = (code: string) => isSystemAdmin && (CRITICAL_PERMISSIONS as string[]).includes(code);
  const dirty = role.data ? [...selected].sort().join(',') !== [...role.data.permissionCodes].sort().join(',') : false;

  const toggle = (code: string, checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(code);
      else next.delete(code);
      return next;
    });
    setMessage(null);
  };

  const save = async () => {
    if (!id) return;
    setMessage(null);
    try {
      await update.mutateAsync({ id, input: { permissionCodes: [...selected] } });
      setMessage({ tone: 'success', text: 'Permissions saved. Changes apply to affected users on their next request.' });
    } catch (err) {
      setMessage({ tone: 'error', text: err instanceof ApiClientError ? err.error.message : 'Could not save permissions.' });
    }
  };

  if (role.isLoading || permissions.isLoading) return <LoadingBlock />;
  if (role.isError || !role.data) return <Alert>Role not found.</Alert>;
  const r = role.data;

  return (
    <>
      <Link to="/admin/roles" className="mb-3 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800">
        <ArrowLeft className="h-4 w-4" /> Roles
      </Link>
      <PageHeader
        title={r.name}
        description={r.description ?? undefined}
        actions={canManage ? <Button onClick={save} loading={update.isPending} disabled={!dirty}>Save permissions</Button> : undefined}
      />

      <div className="mb-4 flex flex-wrap items-center gap-2 text-sm text-slate-600">
        <span className="rounded bg-slate-100 px-2 py-0.5 font-mono text-xs">{r.code}</span>
        {r.isSystem && <StatusBadge status="SYSTEM ROLE" tone="neutral" />}
        <span>Data scope</span> <StatusBadge status={r.dataScope} tone="info" />
        <span>· {r.userCount} user{r.userCount === 1 ? '' : 's'}</span>
        {!canManage && <span className="text-slate-400">· read-only</span>}
      </div>

      {message && <Alert tone={message.tone} className="mb-4">{message.text}</Alert>}
      {isSystemAdmin && canManage && (
        <Alert tone="success" className="mb-4">
          Permissions marked with a lock are required for System Admin and cannot be removed.
        </Alert>
      )}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {groups.map((g) => (
          <Card key={g.module}>
            <CardHeader title={g.module.charAt(0).toUpperCase() + g.module.slice(1)} />
            <div className="space-y-3 px-5 py-4">
              {g.items.map((p) => (
                <Checkbox
                  key={p.code}
                  label={
                    <span className="inline-flex items-center gap-1.5">
                      {PERMISSION_ACTION_LABELS[p.action] ?? p.action}
                      {locked(p.code) && <Lock className="h-3 w-3 text-slate-400" aria-label="Required" />}
                    </span>
                  }
                  description={p.description ?? p.code}
                  checked={selected.has(p.code)}
                  disabled={!canManage || locked(p.code)}
                  onChange={(e) => toggle(p.code, e.target.checked)}
                />
              ))}
            </div>
          </Card>
        ))}
      </div>
    </>
  );
}
