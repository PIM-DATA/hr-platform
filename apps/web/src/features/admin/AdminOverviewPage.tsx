import { Link } from 'react-router-dom';
import { AlertTriangle, Check, Lock, Server } from 'lucide-react';
import type { AdminCapability, AdminSettingsAreaDto, PermissionCode } from '@hr/shared';
import { Card, CardHeader } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingBlock } from '@/components/ui/Spinner';
import { Alert } from '@/components/ui/Alert';
import { PageHeader } from '@/components/layout/PageHeader';
import { useAuth } from '@/hooks/useAuth';
import { useAdminAreas, useAdminDiagnostics } from './admin.api';

/**
 * Administration.
 *
 * The hub answers one question honestly: what can actually be administered in this installation, and by this
 * account. Each area states whether it is configured in the app, shown but not changed here, set by the deployment,
 * or not implemented at all. There are no placeholder cards, no disabled switches and no "coming soon": an area
 * that cannot be configured says who does configure it instead.
 *
 * The list comes from the server, so a capability cannot drift away from the code that implements it.
 */
const GROUPS: { title: string; description: string; keys: string[] }[] = [
  { title: 'People and access', description: 'Who may sign in and what each of them may do.', keys: ['users', 'roles', 'employees'] },
  { title: 'Organization', description: 'The structure every other module reads.', keys: ['organization'] },
  { title: 'Processes', description: 'How approvals are defined, and what they are doing right now.', keys: ['workflow-definitions', 'workflow-monitor'] },
  { title: 'Payroll configuration', description: 'The master data payroll calculates from. Visible only with payroll authority.', keys: ['payroll-components', 'payroll-recurring', 'payroll-policies', 'payroll-periods'] },
  { title: 'Modules', description: 'Configuration that belongs to one module.', keys: ['leave-settings'] },
  { title: 'System', description: 'Data handling and how this installation is running.', keys: ['data-import', 'privacy', 'audit', 'diagnostics', 'notifications', 'security', 'storage', 'copilot'] },
];

const BADGE: Record<AdminCapability, { label: string; className: string; icon: typeof Check }> = {
  CONFIGURABLE: { label: 'Configurable', className: 'border-emerald-200 bg-emerald-50 text-emerald-800', icon: Check },
  READ_ONLY: { label: 'Read only', className: 'border-sky-200 bg-sky-50 text-sky-800', icon: Server },
  DEPLOYMENT_MANAGED: { label: 'Deployment managed', className: 'border-slate-200 bg-slate-100 text-slate-700', icon: Lock },
  NOT_AVAILABLE: { label: 'Not implemented', className: 'border-amber-200 bg-amber-50 text-amber-800', icon: AlertTriangle },
};

function Badge({ capability }: { capability: AdminCapability }) {
  const b = BADGE[capability];
  const Icon = b.icon;
  return <span className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] font-medium ${b.className}`}><Icon className="h-3 w-3" aria-hidden />{b.label}</span>;
}

function AreaCard({ area, canOpen }: { area: AdminSettingsAreaDto; canOpen: boolean }) {
  const body = (
    <>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <span className="font-medium text-slate-900">{area.name}</span>
        <Badge capability={area.capability} />
      </div>
      <p className="mt-1 text-sm text-slate-600">{area.description}</p>
      {area.note && <p className="mt-1 text-xs text-slate-500">{area.note}</p>}
    </>
  );
  if (area.path && canOpen) {
    return <Link to={area.path} className="block rounded-lg border border-slate-200 bg-white p-4 transition hover:border-brand-300 hover:bg-brand-50/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">{body}</Link>;
  }
  return <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">{body}{area.path && !canOpen && <p className="mt-1 text-xs text-slate-500">Your account does not hold a permission for this area.</p>}</div>;
}

export function AdminOverviewPage() {
  const { hasPermission } = useAuth();
  const areas = useAdminAreas();
  const diagnostics = useAdminDiagnostics();
  const canOpen = (a: AdminSettingsAreaDto) => a.permissions.length > 0 && a.permissions.some((p) => hasPermission(p as PermissionCode));

  if (areas.isLoading) return <LoadingBlock />;
  if (areas.isError || !areas.data) return <Alert>Could not load the administration areas.</Alert>;
  const byKey = new Map(areas.data.map((a) => [a.key, a]));
  // An area with a screen this account cannot open is hidden; one that nobody configures here is always shown,
  // because "there is nothing to set" is the useful answer.
  const groups = GROUPS.map((g) => ({ ...g, items: g.keys.map((k) => byKey.get(k)).filter((a): a is AdminSettingsAreaDto => !!a && (a.permissions.length === 0 || canOpen(a))) })).filter((g) => g.items.length > 0);

  return (
    <>
      <PageHeader title="Administration" description="What this installation can be configured to do, and by whom. Module-specific configuration lives inside its module; anything set by the deployment is reported here, not edited." />
      {groups.length === 0 ? (
        <Card><EmptyState title="No administrative tools" description="Your account holds no administrative permission." /></Card>
      ) : (
        <div className="space-y-5">
          {groups.map((g) => (
            <section key={g.title} aria-label={g.title}>
              <h2 className="text-sm font-semibold text-slate-900">{g.title}</h2>
              <p className="mb-2 text-xs text-slate-500">{g.description}</p>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">{g.items.map((a) => <AreaCard key={a.key} area={a} canOpen={canOpen(a)} />)}</div>
            </section>
          ))}
        </div>
      )}
      {diagnostics.data && (
        <Card className="mt-5">
          <CardHeader title="Service status" description="How this installation is running. Operational facts only: no address, no path and no credential appears here, and this is not monitoring." />
          <dl className="grid grid-cols-2 gap-3 p-4 text-sm md:grid-cols-4">
            {[
              ['Environment', diagnostics.data.environment],
              ['Version', diagnostics.data.version ?? 'not set'],
              ['Database', diagnostics.data.database === 'ok' ? 'Reachable' : 'Unavailable'],
              ['Secure cookies', diagnostics.data.secureCookies ? 'On' : 'Off'],
              ['Session lifetime', `${diagnostics.data.sessionTtlHours} hours`],
              ['Documents', diagnostics.data.documents.enabled ? `On · storage ${diagnostics.data.documents.storage}` : 'Off'],
              ['HR copilot', diagnostics.data.copilot.enabled ? `On · ${diagnostics.data.copilot.model}` : diagnostics.data.copilot.configured ? 'Off (credential present)' : 'Off'],
              ['Notifications', 'In-app only'],
            ].map(([label, value]) => (
              <div key={label}><dt className="text-xs uppercase tracking-wide text-slate-500">{label}</dt><dd className="mt-0.5 font-medium text-slate-900">{value}</dd></div>
            ))}
          </dl>
          <p className="px-4 pb-4 text-xs text-slate-400">Sign-in security, storage and the copilot credential are set through the environment by whoever runs the service. They are reported here and cannot be changed from the application.</p>
        </Card>
      )}
    </>
  );
}
