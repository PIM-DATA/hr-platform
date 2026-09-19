import { DATA_SCOPES, type DataScope } from '@hr/shared';
import type { AuthContext } from '../../modules/auth/auth.types';

/**
 * Single place that turns role assignments into an authorization context.
 * Used by the session resolver (→ req.auth, → /auth/me) so middleware and API
 * always agree. Nothing here looks at role names — only permission codes and data scopes.
 */

export interface RoleWithPermissions {
  code: string;
  dataScope: string;
  rolePermissions: { permission: { code: string } }[];
}

const SCOPE_RANK: Record<DataScope, number> = { SELF: 0, TEAM: 1, ALL: 2 };

/** Union of permission codes across all roles — sorted, no duplicates. */
export function computeEffectivePermissions(roles: RoleWithPermissions[]): string[] {
  const set = new Set<string>();
  for (const role of roles) for (const rp of role.rolePermissions) set.add(rp.permission.code);
  return [...set].sort();
}

/** Widest data scope across roles: ALL > TEAM > SELF. Unknown values count as SELF. */
export function resolveDataScope(roles: { dataScope: string }[]): DataScope {
  let best: DataScope = DATA_SCOPES.SELF;
  for (const role of roles) {
    const scope = (role.dataScope in SCOPE_RANK ? role.dataScope : DATA_SCOPES.SELF) as DataScope;
    if (SCOPE_RANK[scope] > SCOPE_RANK[best]) best = scope;
  }
  return best;
}

export function hasPermission(auth: Pick<AuthContext, 'permissions'>, permission: string): boolean {
  return auth.permissions.includes(permission);
}

export function buildAuthContext(input: {
  user: { id: string; email: string; employeeId: string | null };
  roles: RoleWithPermissions[];
  sessionId: string;
  csrfToken: string;
}): AuthContext {
  return {
    userId: input.user.id,
    email: input.user.email,
    employeeId: input.user.employeeId,
    roles: input.roles.map((r) => r.code),
    permissions: computeEffectivePermissions(input.roles),
    dataScope: resolveDataScope(input.roles),
    sessionId: input.sessionId,
    csrfToken: input.csrfToken,
  };
}
