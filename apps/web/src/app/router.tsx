import { createBrowserRouter, Navigate } from 'react-router-dom';
import { AppShell } from '@/components/layout/AppShell';
import { DashboardPage } from '@/features/dashboard/DashboardPage';
import { ComingSoonPage } from '@/features/coming-soon/ComingSoonPage';
import { MENU } from '@/config/menu';

// Every menu item that is not implemented yet renders ComingSoonPage automatically.
const comingSoonRoutes = MENU.flatMap((group) => group.items)
  .filter((item) => item.comingSoon)
  .map((item) => ({ path: item.path.replace(/^\//, ''), element: <ComingSoonPage title={item.label} /> }));

export const router = createBrowserRouter([
  {
    path: '/',
    element: <AppShell />, // Task 2 wraps this in <RequireAuth>
    children: [
      { index: true, element: <Navigate to="/dashboard" replace /> },
      { path: 'dashboard', element: <DashboardPage /> },
      // Task 3: users, roles, permissions   Task 4: organization   Task 5: employees   Task 6: audit-logs
      ...comingSoonRoutes,
      { path: '*', element: <ComingSoonPage title="Page not found" description="The page you are looking for does not exist." /> },
    ],
  },
]);
