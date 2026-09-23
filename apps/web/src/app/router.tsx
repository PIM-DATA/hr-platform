import { createBrowserRouter, Navigate } from 'react-router-dom';
import { PERMISSIONS } from '@hr/shared';
import { AppShell } from '@/components/layout/AppShell';
import { RequireAuth } from '@/components/guards/RequireAuth';
import { RequirePermission } from '@/components/guards/PermissionGuard';
import { LoginPage } from '@/features/auth/LoginPage';
import { DashboardPage } from '@/features/dashboard/DashboardPage';
import { ComingSoonPage } from '@/features/coming-soon/ComingSoonPage';
import { UserListPage } from '@/features/users/UserListPage';
import { RoleListPage } from '@/features/roles/RoleListPage';
import { RoleDetailPage } from '@/features/roles/RoleDetailPage';
import { PermissionMatrixPage } from '@/features/roles/PermissionMatrixPage';
import { OrganizationLayout } from '@/features/organization/OrganizationLayout';
import { OrgTreePage } from '@/features/organization/OrgTreePage';
import { OrganizationsPage } from '@/features/organization/OrganizationsPage';
import { DepartmentsPage } from '@/features/organization/DepartmentsPage';
import { JobsPage } from '@/features/organization/JobsPage';
import { PositionsPage } from '@/features/organization/PositionsPage';
import { EmployeeListPage } from '@/features/employees/EmployeeListPage';
import { EmployeeDetailPage } from '@/features/employees/EmployeeDetailPage';
import { AuditLogPage } from '@/features/audit/AuditLogPage';
import { WorkflowDefinitionsPage } from '@/features/workflow/WorkflowDefinitionsPage';
import { LeaveSettingsLayout } from '@/features/leave-settings/LeaveSettingsLayout';
import { LeaveTypesPage } from '@/features/leave-settings/LeaveTypesPage';
import { PoliciesPage } from '@/features/leave-settings/PoliciesPage';
import { CalendarsPage } from '@/features/leave-settings/CalendarsPage';
import { EntitlementsPage } from '@/features/leave-settings/EntitlementsPage';
import { LeaveLayout } from '@/features/leave/LeaveLayout';
import { MyLeavePage } from '@/features/leave/MyLeavePage';
import { ApprovalsPage } from '@/features/leave/ApprovalsPage';
import { TeamLeavePage } from '@/features/leave/TeamLeavePage';
import { AllRequestsPage } from '@/features/leave/AllRequestsPage';
import { ReportsPage } from '@/features/leave/ReportsPage';
import { NotificationsPage } from '@/features/notifications/NotificationsPage';
import { MENU } from '@/config/menu';

// Every menu item that is not implemented yet renders ComingSoonPage — behind its permission when it has one.
const comingSoonRoutes = MENU.flatMap((group) => group.items)
  .filter((item) => item.comingSoon)
  .map((item) => {
    const page = <ComingSoonPage title={item.label} />;
    return item.permission
      ? { element: <RequirePermission permission={item.permission} />, children: [{ path: item.path.replace(/^\//, ''), element: page }] }
      : { path: item.path.replace(/^\//, ''), element: page };
  });

export const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  {
    element: <RequireAuth />, // everything below requires a valid session
    children: [
      {
        path: '/',
        element: <AppShell />,
        children: [
          { index: true, element: <Navigate to="/dashboard" replace /> },
          { element: <RequirePermission permission={PERMISSIONS.DASHBOARD_VIEW} />, children: [{ path: 'dashboard', element: <DashboardPage /> }] },

          // Administration — route guards show a 403 page; the API enforces the same permissions.
          { element: <RequirePermission permission={PERMISSIONS.USERS_VIEW} />, children: [{ path: 'admin/users', element: <UserListPage /> }] },
          {
            element: <RequirePermission permission={PERMISSIONS.ROLES_VIEW} />,
            children: [
              { path: 'admin/roles', element: <RoleListPage /> },
              { path: 'admin/roles/:id', element: <RoleDetailPage /> },
              { path: 'admin/permissions', element: <PermissionMatrixPage /> },
            ],
          },
          // People
          {
            element: <RequirePermission permission={PERMISSIONS.EMPLOYEES_VIEW} />,
            children: [
              { path: 'employees', element: <EmployeeListPage /> },
              { path: 'employees/:id', element: <EmployeeDetailPage /> },
            ],
          },
          // Organization — tabbed sub-pages under one guard
          {
            element: <RequirePermission permission={PERMISSIONS.ORGANIZATION_VIEW} />,
            children: [
              {
                path: 'organization',
                element: <OrganizationLayout />,
                children: [
                  { index: true, element: <OrgTreePage /> },
                  { path: 'organizations', element: <OrganizationsPage /> },
                  { path: 'departments', element: <DepartmentsPage /> },
                  { path: 'jobs', element: <JobsPage /> },
                  { path: 'positions', element: <PositionsPage /> },
                ],
              },
            ],
          },
          { element: <RequirePermission permission={PERMISSIONS.AUDIT_VIEW} />, children: [{ path: 'admin/audit-logs', element: <AuditLogPage /> }] },
          { element: <RequirePermission permission={PERMISSIONS.WORKFLOW_MANAGE_DEFINITIONS} />, children: [{ path: 'admin/workflows', element: <WorkflowDefinitionsPage /> }] },
          {
            element: <RequirePermission permission={[PERMISSIONS.LEAVE_MANAGE_TYPES, PERMISSIONS.LEAVE_MANAGE_POLICIES, PERMISSIONS.LEAVE_MANAGE_ENTITLEMENTS, PERMISSIONS.CALENDAR_VIEW]} />,
            children: [{
              path: 'admin/leave-settings', element: <LeaveSettingsLayout />,
              children: [
                { element: <RequirePermission permission={PERMISSIONS.LEAVE_MANAGE_TYPES} />, children: [{ index: true, element: <LeaveTypesPage /> }] },
                { element: <RequirePermission permission={PERMISSIONS.LEAVE_MANAGE_POLICIES} />, children: [{ path: 'policies', element: <PoliciesPage /> }] },
                { element: <RequirePermission permission={PERMISSIONS.LEAVE_MANAGE_ENTITLEMENTS} />, children: [{ path: 'entitlements', element: <EntitlementsPage /> }] },
                { element: <RequirePermission permission={PERMISSIONS.CALENDAR_VIEW} />, children: [{ path: 'calendars', element: <CalendarsPage /> }] },
              ],
            }],
          },
          {
            // Leave (Task 12). Tab visibility is capability-based inside the layout; each page's API enforces the same rules.
            element: <RequirePermission permission={[PERMISSIONS.LEAVE_VIEW, PERMISSIONS.WORKFLOW_APPROVE]} />,
            children: [{
              path: 'hrm/leave', element: <LeaveLayout />,
              children: [
                { element: <RequirePermission permission={PERMISSIONS.LEAVE_VIEW} />, children: [{ index: true, element: <MyLeavePage /> }] },
                { element: <RequirePermission permission={PERMISSIONS.WORKFLOW_APPROVE} />, children: [{ path: 'approvals', element: <ApprovalsPage /> }] },
                { element: <RequirePermission permission={PERMISSIONS.LEAVE_VIEW} />, children: [{ path: 'team', element: <TeamLeavePage /> }, { path: 'requests', element: <AllRequestsPage /> }, { path: 'reports', element: <ReportsPage /> }] },
              ],
            }],
          },
          { path: 'notifications', element: <NotificationsPage /> }, // the caller's own inbox: authentication only, no permission
          ...comingSoonRoutes,
          { path: '*', element: <ComingSoonPage title="Page not found" description="The page you are looking for does not exist." /> },
        ],
      },
    ],
  },
]);
