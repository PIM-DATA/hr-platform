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
import { OnboardingPage } from '@/features/onboarding/OnboardingPage';
import { AccountSecurityPage } from '@/features/account/AccountSecurityPage';
import { ResetPasswordPage } from '@/features/account/ResetPasswordPage';
import { PrivacyLayout } from '@/features/privacy/PrivacyLayout';
import { PrivacyRequestsPage } from '@/features/privacy/PrivacyRequestsPage';
import { DataExportPage } from '@/features/privacy/DataExportPage';
import { AttendanceLayout } from '@/features/attendance/attendance-ui';
import { MyAttendancePage } from '@/features/attendance/MyAttendancePage';
import { DailyAttendancePage } from '@/features/attendance/DailyAttendancePage';
import { SchedulePage } from '@/features/attendance/SchedulePage';
import { ShiftsPage } from '@/features/attendance/ShiftsPage';
import { CorrectionsPage } from '@/features/attendance/CorrectionsPage';
import { AttendanceReportsPage } from '@/features/attendance/AttendanceReportsPage';
import { OvertimePage } from '@/features/attendance/OvertimePage';
import { OvertimePoliciesPage } from '@/features/attendance/OvertimePoliciesPage';
import { PayrollLayout } from '@/features/payroll/payroll-ui';
import { MyPayslipsPage } from '@/features/payroll/MyPayslipsPage';
import { PeriodsPage } from '@/features/payroll/PeriodsPage';
import { CompensationPage } from '@/features/payroll/CompensationPage';
import { PayComponentsPage } from '@/features/payroll/PayComponentsPage';
import { RecurringItemsPage } from '@/features/payroll/RecurringItemsPage';
import { PayrollPoliciesPage } from '@/features/payroll/PayrollPoliciesPage';
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
  // Public: whoever follows a reset link cannot sign in yet, so this page must live outside RequireAuth.
  { path: '/reset-password', element: <ResetPasswordPage /> },
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
          {
            // Time & attendance (Task 20). Tab visibility is capability-based inside the layout; each page's API
            // enforces the same permission and the caller's data scope.
            element: <RequirePermission permission={[PERMISSIONS.ATTENDANCE_VIEW, PERMISSIONS.ATTENDANCE_CLOCK, PERMISSIONS.OT_VIEW]} />,
            children: [{
              path: 'hrm/attendance', element: <AttendanceLayout />,
              children: [
                { element: <RequirePermission permission={PERMISSIONS.ATTENDANCE_CLOCK} />, children: [{ index: true, element: <MyAttendancePage /> }] },
                {
                  element: <RequirePermission permission={PERMISSIONS.ATTENDANCE_VIEW} />,
                  children: [
                    { path: 'team', element: <DailyAttendancePage scope="team" /> },
                    { path: 'daily', element: <DailyAttendancePage scope="all" /> },
                    { path: 'schedule', element: <SchedulePage /> },
                    { path: 'corrections', element: <CorrectionsPage /> },
                    { path: 'reports', element: <AttendanceReportsPage /> },
                  ],
                },
                { element: <RequirePermission permission={PERMISSIONS.ATTENDANCE_MANAGE} />, children: [{ path: 'shifts', element: <ShiftsPage /> }] },
                {
                  // Overtime (Task 21): claims need `ot.request`, reading needs `ot.view`, policies `ot.manage_policy`.
                  element: <RequirePermission permission={PERMISSIONS.OT_VIEW} />,
                  children: [
                    { path: 'overtime', element: <OvertimePage /> },
                    { path: 'overtime-policies', element: <OvertimePoliciesPage /> },
                  ],
                },
              ],
            }],
          },
          {
            // Payroll (Task 22). Payroll permissions are their own — never derived from a data scope, because a
            // manager who can see a report's attendance has no business seeing their salary.
            element: <RequirePermission permission={[PERMISSIONS.PAYROLL_VIEW_OWN, PERMISSIONS.PAYROLL_MANAGE, PERMISSIONS.PAYROLL_RUN, PERMISSIONS.PAYROLL_APPROVE]} />,
            children: [{
              path: 'hrm/payroll', element: <PayrollLayout />,
              children: [
                { element: <RequirePermission permission={PERMISSIONS.PAYROLL_VIEW_OWN} />, children: [{ index: true, element: <MyPayslipsPage /> }] },
                {
                  element: <RequirePermission permission={[PERMISSIONS.PAYROLL_MANAGE, PERMISSIONS.PAYROLL_RUN, PERMISSIONS.PAYROLL_APPROVE]} />,
                  children: [
                    { path: 'periods', element: <PeriodsPage /> },
                    { path: 'components', element: <PayComponentsPage /> },
                    { path: 'policies', element: <PayrollPoliciesPage /> },
                  ],
                },
                {
                  element: <RequirePermission permission={PERMISSIONS.PAYROLL_MANAGE} />,
                  children: [
                    { path: 'compensation', element: <CompensationPage /> },
                    { path: 'recurring', element: <RecurringItemsPage /> },
                  ],
                },
              ],
            }],
          },
          { element: <RequirePermission permission={PERMISSIONS.ONBOARDING_MANAGE} />, children: [{ path: 'admin/onboarding', element: <OnboardingPage /> }] },
          {
            // Privacy operations (Task 18). Each tab is guarded on its own permission, as the API is.
            element: <RequirePermission permission={[PERMISSIONS.PRIVACY_MANAGE_REQUESTS, PERMISSIONS.PRIVACY_EXPORT_DATA]} />,
            children: [{
              path: 'admin/privacy', element: <PrivacyLayout />,
              children: [
                { element: <RequirePermission permission={PERMISSIONS.PRIVACY_MANAGE_REQUESTS} />, children: [{ index: true, element: <PrivacyRequestsPage /> }] },
                { element: <RequirePermission permission={PERMISSIONS.PRIVACY_EXPORT_DATA} />, children: [{ path: 'export', element: <DataExportPage /> }] },
              ],
            }],
          },
          { path: 'account/security', element: <AccountSecurityPage /> }, // your own account: authentication only
          { path: 'notifications', element: <NotificationsPage /> }, // the caller's own inbox: authentication only, no permission
          ...comingSoonRoutes,
          { path: '*', element: <ComingSoonPage title="Page not found" description="The page you are looking for does not exist." /> },
        ],
      },
    ],
  },
]);
