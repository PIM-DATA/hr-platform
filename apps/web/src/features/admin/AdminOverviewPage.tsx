import { Link } from 'react-router-dom';
import { PageHeader } from '@/components/layout/PageHeader';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { MENU } from '@/config/menu';
import { useAuth } from '@/hooks/useAuth';
import { useCopilotStatus } from '@/features/copilot/copilot.api';

/**
 * The Administration landing page: a truthful index of the administrative tools that exist today, each shown only
 * when the caller may open it. It replaces the former "Settings — coming soon" placeholder and adds no control of
 * its own: there is no central settings subsystem yet, and this page does not pretend otherwise.
 */
const DESCRIPTIONS: Record<string, string> = {
  '/admin/users': 'Accounts, roles per user, activation and password resets.',
  '/admin/roles': 'Roles and the permissions each one grants.',
  '/admin/permissions': 'The permission matrix by module.',
  '/admin/audit-logs': 'Who changed what, and when.',
  '/admin/workflows': 'Approval workflow definitions and versions.',
  '/admin/leave-settings': 'Leave types, policies, entitlements, calendars and holidays.',
  '/admin/onboarding': 'Import a new customer\'s organization and employees from an Excel workbook.',
  '/admin/privacy': 'Privacy requests and personal-data export.',
  '/organization': 'Organizations, departments, jobs and positions.',
  '/employees': 'The employee master.',
};
export function AdminOverviewPage() {
  const { hasPermission } = useAuth();
  const copilot = useCopilotStatus();
  const allowed = (p?: Parameters<typeof hasPermission>[0] | Parameters<typeof hasPermission>[0][]) => !p || (Array.isArray(p) ? p.some(hasPermission) : hasPermission(p));
  const groups = MENU.filter((g) => g.label === 'Administration' || g.label === 'People').map((g) => ({ label: g.label!, items: g.items.filter((i) => i.path !== '/admin/settings' && allowed(i.permission) && (!i.feature || (i.feature === 'copilot' && copilot.data?.enabled === true))) })).filter((g) => g.items.length > 0);
  return (
    <>
      <PageHeader title="Administration" description="Every administrative tool that exists in this installation, in one place. Module-specific configuration (payroll policies, shift and overtime policies, benefit plans, survey question banks, lifecycle templates) lives inside its module." />
      {groups.length === 0 ? <Card><EmptyState title="No administrative tools" description="Your account holds no administrative permission." /></Card> : groups.map((g) => (
        <section key={g.label} className="mb-6">
          <h2 className="mb-3 text-sm font-semibold text-slate-900">{g.label}</h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {g.items.map(({ label, path, icon: Icon }) => (
              <Link key={path} to={path} className="flex items-start gap-3 rounded-lg border border-slate-200 bg-white p-4 transition-colors hover:bg-slate-50">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-slate-100 text-slate-600"><Icon className="h-5 w-5" /></span>
                <span className="min-w-0"><span className="block text-sm font-medium text-slate-900">{label}</span><span className="block text-xs text-slate-500">{DESCRIPTIONS[path] ?? ''}</span></span>
              </Link>
            ))}
          </div>
        </section>
      ))}
      <p className="text-xs text-slate-400">Not available yet: a central settings page, a workflow instance monitor, editing payroll components and policies after creation. These are tracked in docs/product-gap-audit.md.</p>
    </>
  );
}
