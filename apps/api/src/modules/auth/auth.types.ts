import type { DataScope, PermissionScopes } from '@hr/shared';

/** Attached to req.auth by the authenticate middleware for every valid session. */
export interface AuthContext {
  userId: string;
  email: string;
  employeeId: string | null;
  roles: string[];        // role codes, e.g. ['HR_ADMIN']
  permissions: string[];  // permission codes, e.g. ['employees.view']
  /** Task 50: permission → scope (widest among the roles that grant that permission). */
  permissionScopes: PermissionScopes;
  /**
   * Scope of the permission being exercised in this request: set by `requirePermission(...)` / `narrowAuth(...)`.
   * SELF until a guard names a permission — never the widest scope across unrelated roles (T44-P1-21).
   */
  dataScope: DataScope;
  sessionId: string;
  csrfToken: string;
}
