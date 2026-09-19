import type { ReactNode } from 'react';
import { Outlet } from 'react-router-dom';
import type { PermissionCode } from '@hr/shared';
import { useAuth } from '@/hooks/useAuth';
import { ForbiddenPage } from '@/features/errors/ForbiddenPage';

interface PermissionGuardProps {
  permission: PermissionCode | PermissionCode[]; // any of
  children: ReactNode;
  fallback?: ReactNode;
}

/** Renders children only when the user has (any of) the permission(s). UX only — API still enforces. */
export function PermissionGuard({ permission, children, fallback = null }: PermissionGuardProps) {
  const { hasPermission } = useAuth();
  const list = Array.isArray(permission) ? permission : [permission];
  return <>{list.some(hasPermission) ? children : fallback}</>;
}

/** Route-level variant: shows a 403 page instead of silently redirecting. */
export function RequirePermission({ permission }: { permission: PermissionCode | PermissionCode[] }) {
  const { hasPermission } = useAuth();
  const list = Array.isArray(permission) ? permission : [permission];
  return list.some(hasPermission) ? <Outlet /> : <ForbiddenPage />;
}
