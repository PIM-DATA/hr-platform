import { Outlet } from 'react-router-dom';
import { PERMISSIONS } from '@hr/shared';
import { PageHeader } from '@/components/layout/PageHeader';
import { Tabs, type TabItem } from '@/components/ui/Tabs';
import { usePermission } from '@/hooks/usePermission';

/** Administration → Privacy: the request register and the personal-data export tool. */
export function PrivacyLayout() {
  const canManage = usePermission(PERMISSIONS.PRIVACY_MANAGE_REQUESTS);
  const canExport = usePermission(PERMISSIONS.PRIVACY_EXPORT_DATA);
  const tabs: TabItem[] = [
    ...(canManage ? [{ label: 'Requests', to: '/admin/privacy', end: true }] : []),
    ...(canExport ? [{ label: 'Data export', to: '/admin/privacy/export' }] : []),
  ];

  return (
    <>
      <PageHeader
        title="Privacy"
        description="Record what data subjects ask for, and assemble one person's data when they ask to see it."
      />
      <Tabs items={tabs} />
      <div className="pt-6">
        <Outlet />
      </div>
    </>
  );
}
