/**
 * Permission codes — the single list used by BOTH backend (requirePermission)
 * and frontend (PermissionGuard / menu). Format: `<module>.<action>`.
 *
 * Adding a module in the future = add its codes here + seed them.
 */
export const PERMISSIONS = {
  DASHBOARD_VIEW: 'dashboard.view',

  EMPLOYEES_VIEW: 'employees.view',
  EMPLOYEES_CREATE: 'employees.create',
  EMPLOYEES_UPDATE: 'employees.update',
  EMPLOYEES_ACTIVATE: 'employees.activate',

  ORGANIZATION_VIEW: 'organization.view',
  ORGANIZATION_MANAGE: 'organization.manage',

  USERS_VIEW: 'users.view',
  USERS_CREATE: 'users.create',
  USERS_UPDATE: 'users.update',
  USERS_ACTIVATE: 'users.activate',

  ROLES_VIEW: 'roles.view',
  ROLES_MANAGE: 'roles.manage',

  AUDIT_VIEW: 'audit.view',

  SETTINGS_MANAGE: 'settings.manage',
} as const;

export type PermissionCode = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export interface PermissionDefinition {
  code: PermissionCode;
  module: string;
  description: string;
}

/** Seed source for the `permissions` table. */
export const PERMISSION_DEFINITIONS: PermissionDefinition[] = [
  { code: PERMISSIONS.DASHBOARD_VIEW, module: 'dashboard', description: 'View dashboard' },

  { code: PERMISSIONS.EMPLOYEES_VIEW, module: 'employees', description: 'View employees (scope depends on role data scope)' },
  { code: PERMISSIONS.EMPLOYEES_CREATE, module: 'employees', description: 'Create employees' },
  { code: PERMISSIONS.EMPLOYEES_UPDATE, module: 'employees', description: 'Edit employees' },
  { code: PERMISSIONS.EMPLOYEES_ACTIVATE, module: 'employees', description: 'Activate / inactivate employees' },

  { code: PERMISSIONS.ORGANIZATION_VIEW, module: 'organization', description: 'View organization structure' },
  { code: PERMISSIONS.ORGANIZATION_MANAGE, module: 'organization', description: 'Manage organizations, departments, jobs and positions' },

  { code: PERMISSIONS.USERS_VIEW, module: 'users', description: 'View user accounts' },
  { code: PERMISSIONS.USERS_CREATE, module: 'users', description: 'Create user accounts' },
  { code: PERMISSIONS.USERS_UPDATE, module: 'users', description: 'Edit user accounts and assign roles' },
  { code: PERMISSIONS.USERS_ACTIVATE, module: 'users', description: 'Activate / deactivate user accounts' },

  { code: PERMISSIONS.ROLES_VIEW, module: 'roles', description: 'View roles and permissions' },
  { code: PERMISSIONS.ROLES_MANAGE, module: 'roles', description: 'Change role ↔ permission mapping' },

  { code: PERMISSIONS.AUDIT_VIEW, module: 'audit', description: 'View audit logs' },

  { code: PERMISSIONS.SETTINGS_MANAGE, module: 'settings', description: 'Manage system settings' },
];

/**
 * Permissions the SYSTEM_ADMIN role can never lose (guards against locking every admin out).
 * Enforced by PATCH /roles/:id/permissions; the UI locks these checkboxes for SYSTEM_ADMIN.
 */
export const CRITICAL_PERMISSIONS: PermissionCode[] = [
  PERMISSIONS.USERS_VIEW,
  PERMISSIONS.USERS_CREATE,
  PERMISSIONS.USERS_UPDATE,
  PERMISSIONS.USERS_ACTIVATE,
  PERMISSIONS.ROLES_VIEW,
  PERMISSIONS.ROLES_MANAGE,
];

/** Human labels for the action part of a permission code, used by the Roles UI. */
export const PERMISSION_ACTION_LABELS: Record<string, string> = {
  view: 'View',
  create: 'Create',
  update: 'Update',
  activate: 'Activate / Deactivate',
  manage: 'Manage',
};
