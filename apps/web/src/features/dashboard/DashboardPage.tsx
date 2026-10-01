import { Link } from 'react-router-dom';
import type { LucideIcon } from 'lucide-react';
import { Building2, Network, RefreshCw, ScrollText, UserCog, UserPlus, Users, UserCheck, Eye } from 'lucide-react';
import { MENU } from '@/config/menu';
import { useCopilotStatus } from '@/features/copilot/copilot.api';
import { DATA_SCOPE_LABELS, PERMISSIONS, type PermissionCode } from '@hr/shared';
import { PageHeader } from '@/components/layout/PageHeader';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Alert';
import { displayName, useAuth } from '@/hooks/useAuth';
import { formatNumber, greeting } from '@/lib/format';
import { useDashboardSummary } from './dashboard.api';

/** Quick actions are shown only when the caller holds the permission; every target is an existing route. */
const QUICK_ACTIONS: { label: string; description: string; to: string; icon: LucideIcon; permission: PermissionCode; primary?: boolean }[] = [
  { label: 'Add employee', description: 'Create a new employee record', to: '/employees?new=1', icon: UserPlus, permission: PERMISSIONS.EMPLOYEES_CREATE, primary: true },
  { label: 'View employees', description: 'Employee master within your scope', to: '/employees', icon: Users, permission: PERMISSIONS.EMPLOYEES_VIEW },
  { label: 'View organization', description: 'Departments, jobs and positions', to: '/organization', icon: Network, permission: PERMISSIONS.ORGANIZATION_VIEW },
  { label: 'Manage users', description: 'Accounts, roles and access', to: '/admin/users', icon: UserCog, permission: PERMISSIONS.USERS_VIEW },
  { label: 'Audit logs', description: 'Who changed what, and when', to: '/admin/audit-logs', icon: ScrollText, permission: PERMISSIONS.AUDIT_VIEW },
];


export function DashboardPage() {
  const { user, hasPermission, scopeOf } = useAuth();
  const summary = useDashboardSummary();
  const actions = QUICK_ACTIONS.filter((a) => hasPermission(a.permission));
  const copilot = useCopilotStatus();
  // Every module the caller may open, from the same definition as the sidebar: no card leads anywhere its reader cannot go.
  const allowed = (p?: PermissionCode | PermissionCode[]) => !p || (Array.isArray(p) ? p.some(hasPermission) : hasPermission(p));
  const modules = MENU.filter((g) => g.label && g.label !== 'Administration').map((g) => ({ label: g.label!, items: g.items.filter((i) => allowed(i.permission) && (!i.feature || (i.feature === 'copilot' && copilot.data?.enabled === true))) })).filter((g) => g.items.length > 0);
  const scopeLabel = DATA_SCOPE_LABELS[summary.data?.scope ?? scopeOf(PERMISSIONS.EMPLOYEES_VIEW) ?? ''] ?? '';

  const stats: { label: string; value: number | undefined; icon: LucideIcon; hint: string; title: string }[] = [
    { label: 'Total employees', value: summary.data?.employees.total, icon: Users, hint: 'Visible in your access scope', title: 'Employee records within your data scope, any employment status' },
    { label: 'Active employees', value: summary.data?.employees.active, icon: UserCheck, hint: 'Currently active', title: 'Visible employees with employment status ACTIVE' },
    { label: 'Departments', value: summary.data?.departments.represented, icon: Building2, hint: 'Represented in your visible employees', title: 'Distinct departments of the visible employees (not the department master count)' },
    { label: 'New employees', value: summary.data?.employees.newLast30Days, icon: UserPlus, hint: 'Joined in the last 30 days', title: 'Visible employees whose hire date is within the last 30 days including today' },
  ];

  return (
    <>
      <PageHeader
        title={`${greeting()}, ${displayName(user).split(' ')[0] || 'there'}`}
        description={`Welcome back to HR Enterprise Platform.${scopeLabel ? ` Viewing: ${scopeLabel}.` : ''}`}
      />

      {summary.isError ? (
        <Alert className="mb-6">
          <span className="flex flex-wrap items-center gap-3">
            Could not load the dashboard summary.
            <Button size="sm" variant="secondary" onClick={() => summary.refetch()} loading={summary.isFetching}><RefreshCw className="h-4 w-4" /> Retry</Button>
          </span>
        </Alert>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {stats.map(({ label, value, icon: Icon, hint, title }) => (
            <Card key={label} className="p-5" title={title}>
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-slate-500">{label}</span>
                <span className="flex h-9 w-9 items-center justify-center rounded-md bg-brand-50 text-brand-600"><Icon className="h-5 w-5" /></span>
              </div>
              <div className="mt-3 text-3xl font-semibold tabular-nums tracking-tight text-slate-900" aria-busy={summary.isLoading}>
                {summary.isLoading ? <span className="inline-block h-8 w-16 animate-pulse rounded bg-slate-200" aria-label="Loading" /> : formatNumber(value)}
              </div>
              <div className="mt-1 text-xs text-slate-400">{hint}</div>
            </Card>
          ))}
        </div>
      )}

      {actions.length > 0 && (
        <section className="mt-8">
          <h2 className="mb-3 text-sm font-semibold text-slate-900">Quick actions</h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5">
            {actions.map(({ label, description, to, icon: Icon, primary }) => (
              <Link key={to} to={to} className={`flex items-start gap-3 rounded-lg border p-4 transition-colors ${primary ? 'border-brand-200 bg-brand-50 hover:bg-brand-100' : 'border-slate-200 bg-white hover:bg-slate-50'}`}>
                <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-md ${primary ? 'bg-brand-600 text-white' : 'bg-slate-100 text-slate-600'}`}><Icon className="h-5 w-5" /></span>
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-slate-900">{label}</span>
                  <span className="block text-xs text-slate-500">{description}</span>
                </span>
              </Link>
            ))}
          </div>
        </section>
      )}

      {modules.map((g) => (
        <section key={g.label} className="mt-8">
          <h2 className="mb-3 text-sm font-semibold text-slate-900">{g.label}</h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
            {g.items.map(({ label, path, icon: Icon }) => (
              <Link key={path} to={path} className="flex items-center gap-3 rounded-lg border border-slate-200 bg-white p-4 text-sm font-medium text-slate-900 transition-colors hover:bg-slate-50">
                <Icon className="h-5 w-5 shrink-0 text-brand-600" /><span className="truncate">{label}</span>
              </Link>
            ))}
          </div>
        </section>
      ))}

      <p className="mt-6 flex items-center gap-1 text-xs text-slate-400"><Eye className="h-3.5 w-3.5" /> Numbers are computed on the same population as your Employees list.</p>
    </>
  );
}
