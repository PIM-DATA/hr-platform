import { DATA_SCOPES, computePermissionScopes, scopeForPermissions, type DataScope, type PermissionScopes } from '@hr/shared';
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

/** Task 50: permission → widest scope among the roles that grant it (shared implementation, same as the web). */
export function resolvePermissionScopes(roles: RoleWithPermissions[]): PermissionScopes {
  return computePermissionScopes(roles.map((r) => ({ dataScope: r.dataScope, permissions: r.rolePermissions.map((rp) => rp.permission.code) })));
}

/** The caller's scope for an action guarded by any of `permissions` — `null` when they hold none of them. */
export function scopeFor(auth: Pick<AuthContext, 'permissionScopes'>, ...permissions: string[]): DataScope | null {
  return scopeForPermissions(auth.permissionScopes, permissions);
}

/**
 * The same caller, with `dataScope` set to the scope of the permission(s) being exercised. Every scope-aware helper
 * (`employeeScopeWhere`, module scope functions) reads `auth.dataScope`, so this is how a permission's own scope reaches
 * them. A permission the caller does not hold gives SELF (callers deny before that point; SELF fails safe).
 */
export function narrowAuth<T extends AuthContext>(auth: T, ...permissions: string[]): T {
  return { ...auth, dataScope: scopeFor(auth, ...permissions) ?? DATA_SCOPES.SELF };
}

/**
 * Widest data scope across roles: ALL > TEAM > SELF. Unknown values count as SELF.
 * Task 50: NOT an authorization input any more (it is what made a MANAGER+EXECUTIVE user read everything at ALL).
 * Kept for role administration, where a role's own scope is compared.
 */
export function resolveDataScope(roles: { dataScope: string }[]): DataScope {
  let best: DataScope = DATA_SCOPES.SELF;
  for (const role of roles) {
    const scope = (role.dataScope in SCOPE_RANK ? role.dataScope : DATA_SCOPES.SELF) as DataScope;
    if (SCOPE_RANK[scope] > SCOPE_RANK[best]) best = scope;
  }
  return best;
}

/** true when `candidate` is not wider than `limit` (SELF ≤ TEAM ≤ ALL). */
export function isScopeWithin(candidate: string, limit: DataScope): boolean {
  const c = (candidate in SCOPE_RANK ? candidate : DATA_SCOPES.SELF) as DataScope;
  return SCOPE_RANK[c] <= SCOPE_RANK[limit];
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
    permissionScopes: resolvePermissionScopes(input.roles),
    // Task 50: no user-wide scope. Until a permission guard narrows it to that permission's scope, a code path sees the
    // most restrictive scope — a path that forgot to name its permission under-exposes instead of over-exposing.
    dataScope: DATA_SCOPES.SELF,
    sessionId: input.sessionId,
    csrfToken: input.csrfToken,
  };
}
