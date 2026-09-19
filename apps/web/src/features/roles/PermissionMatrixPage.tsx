import { Fragment, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { Check } from 'lucide-react';
import { PageHeader } from '@/components/layout/PageHeader';
import { Card } from '@/components/ui/Card';
import { LoadingBlock } from '@/components/ui/Spinner';
import { groupByModule, usePermissions, useRoles } from './roles.api';

/** Read-only roles × permissions matrix. Editing happens on the role detail page. */
export function PermissionMatrixPage() {
  const roles = useRoles();
  const permissions = usePermissions();
  const groups = useMemo(() => groupByModule(permissions.data ?? []), [permissions.data]);

  if (roles.isLoading || permissions.isLoading) return <LoadingBlock />;
  const roleList = roles.data ?? [];

  return (
    <>
      <PageHeader title="Permissions" description="Which roles hold each permission. Edit a role to change its permissions." />
      <Card className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50">
            <tr>
              <th className="sticky left-0 bg-slate-50 px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">Permission</th>
              {roleList.map((r) => (
                <th key={r.id} className="px-3 py-2.5 text-center text-xs font-semibold uppercase tracking-wide text-slate-500">
                  <Link to={`/admin/roles/${r.id}`} className="hover:text-brand-600">{r.name}</Link>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {groups.map((g) => (
              <Fragment key={g.module}>
                <tr className="bg-slate-50/60">
                  <td colSpan={roleList.length + 1} className="px-4 py-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">{g.module}</td>
                </tr>
                {g.items.map((p) => (
                  <tr key={p.code}>
                    <td className="sticky left-0 bg-white px-4 py-2">
                      <div className="font-mono text-xs text-slate-800">{p.code}</div>
                      <div className="text-xs text-slate-500">{p.description}</div>
                    </td>
                    {roleList.map((r) => (
                      <td key={r.id} className="px-3 py-2 text-center">
                        {r.permissionCodes.includes(p.code) ? <Check className="mx-auto h-4 w-4 text-emerald-600" /> : <span className="text-slate-200">·</span>}
                      </td>
                    ))}
                  </tr>
                ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      </Card>
    </>
  );
}
