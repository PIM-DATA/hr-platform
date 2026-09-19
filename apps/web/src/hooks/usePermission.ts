import type { PermissionCode } from '@hr/shared';
import { useAuth } from './useAuth';

/** UX helper only — the API enforces permissions on every endpoint. */
export function usePermission(permission: PermissionCode): boolean {
  return useAuth().hasPermission(permission);
}

export function useAnyPermission(...permissions: PermissionCode[]): boolean {
  const { hasPermission } = useAuth();
  return permissions.some(hasPermission);
}
