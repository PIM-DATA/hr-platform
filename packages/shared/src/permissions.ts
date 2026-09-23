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

  WORKFLOW_APPROVE: 'workflow.approve',
  WORKFLOW_VIEW_ALL: 'workflow.view_all',
  WORKFLOW_MANAGE_DEFINITIONS: 'workflow.manage_definitions',

  CALENDAR_VIEW: 'calendar.view',
  CALENDAR_MANAGE: 'calendar.manage',
  LEAVE_MANAGE_TYPES: 'leave.manage_types',
  LEAVE_MANAGE_POLICIES: 'leave.manage_policies',
  LEAVE_MANAGE_ENTITLEMENTS: 'leave.manage_entitlements',
  LEAVE_VIEW: 'leave.view',
  LEAVE_REQUEST: 'leave.request',
  ONBOARDING_MANAGE: 'onboarding.manage',
  ACCOUNT_MANAGE_RECOVERY: 'account.manage_recovery',
  PRIVACY_MANAGE_REQUESTS: 'privacy.manage_requests',
  PRIVACY_EXPORT_DATA: 'privacy.export_data',

  ATTENDANCE_VIEW: 'attendance.view',
  ATTENDANCE_CLOCK: 'attendance.clock',
  ATTENDANCE_MANAGE: 'attendance.manage',
  ATTENDANCE_CORRECT: 'attendance.correct',
  ATTENDANCE_SCHEDULE_MANAGE: 'attendance.schedule_manage',
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

  { code: PERMISSIONS.WORKFLOW_APPROVE, module: 'workflow', description: 'Act on approval steps assigned to me' },
  { code: PERMISSIONS.WORKFLOW_VIEW_ALL, module: 'workflow', description: 'View every workflow instance' },
  { code: PERMISSIONS.WORKFLOW_MANAGE_DEFINITIONS, module: 'workflow', description: 'Create and activate workflow definition versions' },

  { code: PERMISSIONS.CALENDAR_VIEW, module: 'calendar', description: 'View work calendars and holidays' },
  { code: PERMISSIONS.CALENDAR_MANAGE, module: 'calendar', description: 'Manage work calendars, holidays and organization default calendar' },
  { code: PERMISSIONS.LEAVE_MANAGE_TYPES, module: 'leave', description: 'Manage leave types' },
  { code: PERMISSIONS.LEAVE_MANAGE_POLICIES, module: 'leave', description: 'Manage leave policies' },
  { code: PERMISSIONS.LEAVE_MANAGE_ENTITLEMENTS, module: 'leave', description: 'Generate and adjust leave entitlements, view ledgers' },
  { code: PERMISSIONS.LEAVE_VIEW, module: 'leave', description: 'View leave requests and balances within my data scope' },
  { code: PERMISSIONS.LEAVE_REQUEST, module: 'leave', description: 'Create, submit and cancel my own leave requests' },
  { code: PERMISSIONS.ONBOARDING_MANAGE, module: 'onboarding', description: 'Import a customer onboarding workbook (creates organizations, departments, jobs, positions and employees)' },
  { code: PERMISSIONS.ACCOUNT_MANAGE_RECOVERY, module: 'account', description: 'Issue one-time password reset links and revoke other users\' sessions' },
  { code: PERMISSIONS.PRIVACY_MANAGE_REQUESTS, module: 'privacy', description: 'Record and track privacy requests from data subjects' },
  { code: PERMISSIONS.PRIVACY_EXPORT_DATA, module: 'privacy', description: 'Export an employee\'s personal data' },

  { code: PERMISSIONS.ATTENDANCE_VIEW, module: 'attendance', description: 'View attendance (scope depends on role data scope)' },
  { code: PERMISSIONS.ATTENDANCE_CLOCK, module: 'attendance', description: 'Clock in and out for yourself' },
  { code: PERMISSIONS.ATTENDANCE_MANAGE, module: 'attendance', description: 'Manage shifts and recalculate attendance' },
  { code: PERMISSIONS.ATTENDANCE_CORRECT, module: 'attendance', description: 'Decide attendance correction requests' },
  { code: PERMISSIONS.ATTENDANCE_SCHEDULE_MANAGE, module: 'attendance', description: 'Assign work schedules' },
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
  clock: 'Clock in / out',
  correct: 'Correct',
  schedule_manage: 'Manage schedules',
};
