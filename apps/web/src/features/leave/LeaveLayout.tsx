import { Outlet } from 'react-router-dom';
import { PERMISSIONS } from '@hr/shared';
import { PageHeader } from '@/components/layout/PageHeader';
import { Tabs } from '@/components/ui/Tabs';
import { useAuth } from '@/hooks/useAuth';

/**
 * Tab visibility follows capability, never a role name: `leave.view` + an employee profile for My Leave,
 * `workflow.approve` for Approvals, and the caller's data scope (TEAM/ALL, ALL) for Team leave and All requests.
 * These are UX hints only — every endpoint enforces the same rules server-side.
 */
export function useLeaveTabs() {
  const { user, hasPermission, scopeOf } = useAuth();
  const canView = hasPermission(PERMISSIONS.LEAVE_VIEW);
  const scope = scopeOf(PERMISSIONS.LEAVE_VIEW);
  return [
    canView && !!user?.employee && { label: 'My leave', to: '/hrm/leave', end: true },
    hasPermission(PERMISSIONS.WORKFLOW_APPROVE) && { label: 'Approvals', to: '/hrm/leave/approvals' },
    canView && (scope === 'TEAM' || scope === 'ALL') && { label: 'Team leave', to: '/hrm/leave/team' },
    canView && scope === 'ALL' && { label: 'All requests', to: '/hrm/leave/requests' },
    canView && (scope === 'TEAM' || scope === 'ALL') && { label: 'Reports', to: '/hrm/leave/reports' },
  ].filter(Boolean) as { label: string; to: string; end?: boolean }[];
}

export function LeaveLayout() {
  const tabs = useLeaveTabs();
  return (
    <>
      <PageHeader title="Leave" description="Request leave, track approvals and see who is away. Balances, policies and approval routing come from the server." />
      {tabs.length > 1 && <div className="mb-5"><Tabs items={tabs} /></div>}
      <Outlet />
    </>
  );
}
