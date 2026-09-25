import type { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { UserX } from 'lucide-react';
import type { PermissionCode } from '@hr/shared';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { useAuth } from '@/hooks/useAuth';

/**
 * A module's landing page. The "My …" self-service page needs an employee record; an account without one (an HR
 * officer, an executive, a system administrator) is sent to the first administrative tab it may open instead of a
 * page that fails to load. When there is nothing else to show, the reason is stated plainly. Nothing here grants
 * anything: every fallback is a route the router already guards with the same permission.
 */
export function ModuleIndex({ own, ownPermission, fallbacks, employeeRequired = true }: { own: ReactNode; ownPermission?: PermissionCode | PermissionCode[]; fallbacks: { to: string; permission: PermissionCode | PermissionCode[] }[]; employeeRequired?: boolean }) {
  const { user, hasPermission } = useAuth();
  const allowed = (p?: PermissionCode | PermissionCode[]) => !p || (Array.isArray(p) ? p.some(hasPermission) : hasPermission(p));
  if ((user?.employee || !employeeRequired) && allowed(ownPermission)) return <>{own}</>;
  const next = fallbacks.find((f) => allowed(f.permission));
  if (next) return <Navigate to={next.to} replace />;
  return <NoEmployeeProfile />;
}

/** The truthful empty state for a self-service page opened by an account that has no employee record. */
export function NoEmployeeProfile({ what = 'this page' }: { what?: string }) {
  return (
    <Card>
      <EmptyState icon={<UserX className="h-6 w-6" />} title="This account is not linked to an employee profile" description={`Self-service content on ${what} belongs to an employee record. Administrative accounts see the administration tabs instead; an administrator can link this account to an employee under Users.`} />
    </Card>
  );
}
