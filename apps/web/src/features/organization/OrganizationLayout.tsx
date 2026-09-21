import { Outlet } from 'react-router-dom';
import { PageHeader } from '@/components/layout/PageHeader';
import { Tabs } from '@/components/ui/Tabs';

const TABS = [
  { label: 'Structure', to: '/organization', end: true },
  { label: 'Organizations', to: '/organization/organizations' },
  { label: 'Departments', to: '/organization/departments' },
  { label: 'Jobs', to: '/organization/jobs' },
  { label: 'Positions', to: '/organization/positions' },
];

export function OrganizationLayout() {
  return (
    <>
      <PageHeader title="Organization" description="Companies, departments, jobs and positions — the structure every employee record refers to." />
      <div className="mb-5">
        <Tabs items={TABS} />
      </div>
      <Outlet />
    </>
  );
}
