import { Outlet } from 'react-router-dom';
import { PERMISSIONS } from '@hr/shared';
import { PageHeader } from '@/components/layout/PageHeader';
import { Tabs } from '@/components/ui/Tabs';
import { useAuth } from '@/hooks/useAuth';

export function LeaveSettingsLayout() {
  const { hasPermission } = useAuth();
  const tabs = [
    hasPermission(PERMISSIONS.LEAVE_MANAGE_TYPES) && { label: 'Leave types', to: '/admin/leave-settings', end: true },
    hasPermission(PERMISSIONS.LEAVE_MANAGE_POLICIES) && { label: 'Policies', to: '/admin/leave-settings/policies' },
    hasPermission(PERMISSIONS.CALENDAR_VIEW) && { label: 'Calendars & holidays', to: '/admin/leave-settings/calendars' },
  ].filter(Boolean) as { label: string; to: string; end?: boolean }[];
  return (
    <>
      <PageHeader title="Leave settings" description="Leave types (semantic master), policies (rules per organization / employment type) and the shared work calendars." />
      <div className="mb-5"><Tabs items={tabs} /></div>
      <Outlet />
    </>
  );
}
