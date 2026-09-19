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
          { path: 'dashboard', element: <DashboardPage /> },

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
          // Task 4: organization   Task 5: employees   Task 6: audit-logs
          ...comingSoonRoutes,
          { path: '*', element: <ComingSoonPage title="Page not found" description="The page you are looking for does not exist." /> },
        ],
      },
    ],
  },
]);
