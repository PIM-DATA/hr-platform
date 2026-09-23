/**
 * String enums stored as TEXT columns (SQLite has no native enum; this keeps
 * the schema portable to PostgreSQL where they can become real enums later).
 */
export const EMPLOYMENT_TYPES = ['FULL_TIME', 'PART_TIME', 'CONTRACT', 'INTERN'] as const;
export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number];

export const NOTIFICATION_TYPES = {
  APPROVAL_REQUIRED: 'APPROVAL_REQUIRED',
  LEAVE_SUBMITTED: 'LEAVE_SUBMITTED',
  LEAVE_APPROVED: 'LEAVE_APPROVED',
  LEAVE_REJECTED: 'LEAVE_REJECTED',
  /** Reserved: a requester cancelling their own request needs no notification (they performed the action). */
  LEAVE_CANCELLED: 'LEAVE_CANCELLED',
} as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[keyof typeof NOTIFICATION_TYPES];

export const NOTIFICATION_CHANNELS = { IN_APP: 'IN_APP', EMAIL: 'EMAIL', LINE: 'LINE', LARK: 'LARK', PUSH: 'PUSH' } as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[keyof typeof NOTIFICATION_CHANNELS];
export const NOTIFICATION_DELIVERY_STATUS = { PENDING: 'PENDING', SENT: 'SENT', FAILED: 'FAILED' } as const;

export const LEAVE_REQUEST_STATUS = { DRAFT: 'DRAFT', PENDING: 'PENDING', APPROVED: 'APPROVED', REJECTED: 'REJECTED', CANCELLED: 'CANCELLED' } as const;
export type LeaveRequestStatus = (typeof LEAVE_REQUEST_STATUS)[keyof typeof LEAVE_REQUEST_STATUS];
export const LEAVE_REQUEST_STATUSES = Object.values(LEAVE_REQUEST_STATUS);
/** Statuses that occupy the dates (overlap check) and hold a reservation. */
export const LEAVE_BLOCKING_STATUSES = [LEAVE_REQUEST_STATUS.PENDING, LEAVE_REQUEST_STATUS.APPROVED] as const;

export const EMPLOYMENT_STATUSES = ['ACTIVE', 'INACTIVE', 'TERMINATED'] as const;
export type EmploymentStatus = (typeof EMPLOYMENT_STATUSES)[number];

/** Known audit modules (audit_logs.module). Used to validate the module filter. */
export const AUDIT_MODULES = ['auth', 'users', 'roles', 'organization', 'employees', 'workflow', 'calendar', 'leave'] as const;
export type AuditModule = (typeof AUDIT_MODULES)[number];

/** Audit action codes. Convention: <VERB>_<ENTITY>. */
export const AUDIT_ACTIONS = {
  LOGIN_SUCCESS: 'LOGIN_SUCCESS',
  LOGIN_FAILED: 'LOGIN_FAILED',
  LOGOUT: 'LOGOUT',
  CREATE_USER: 'CREATE_USER',
  UPDATE_USER: 'UPDATE_USER',
  ACTIVATE_USER: 'ACTIVATE_USER',
  DEACTIVATE_USER: 'DEACTIVATE_USER',
  UPDATE_USER_ROLES: 'UPDATE_USER_ROLES',
  RESET_USER_PASSWORD: 'RESET_USER_PASSWORD',
  UPDATE_ROLE_PERMISSIONS: 'UPDATE_ROLE_PERMISSIONS',
  CREATE_ORGANIZATION: 'CREATE_ORGANIZATION',
  UPDATE_ORGANIZATION: 'UPDATE_ORGANIZATION',
  ACTIVATE_ORGANIZATION: 'ACTIVATE_ORGANIZATION',
  DEACTIVATE_ORGANIZATION: 'DEACTIVATE_ORGANIZATION',
  CREATE_DEPARTMENT: 'CREATE_DEPARTMENT',
  UPDATE_DEPARTMENT: 'UPDATE_DEPARTMENT',
  ACTIVATE_DEPARTMENT: 'ACTIVATE_DEPARTMENT',
  DEACTIVATE_DEPARTMENT: 'DEACTIVATE_DEPARTMENT',
  CREATE_JOB: 'CREATE_JOB',
  UPDATE_JOB: 'UPDATE_JOB',
  ACTIVATE_JOB: 'ACTIVATE_JOB',
  DEACTIVATE_JOB: 'DEACTIVATE_JOB',
  CREATE_POSITION: 'CREATE_POSITION',
  UPDATE_POSITION: 'UPDATE_POSITION',
  ACTIVATE_POSITION: 'ACTIVATE_POSITION',
  DEACTIVATE_POSITION: 'DEACTIVATE_POSITION',
  // settings.* actions are added when the Settings module is built (no orphan codes: every code here has a writer)
  CREATE_EMPLOYEE: 'CREATE_EMPLOYEE',
  UPDATE_EMPLOYEE: 'UPDATE_EMPLOYEE',
  ACTIVATE_EMPLOYEE: 'ACTIVATE_EMPLOYEE',
  DEACTIVATE_EMPLOYEE: 'DEACTIVATE_EMPLOYEE',
  CHANGE_EMPLOYEE_POSITION: 'CHANGE_EMPLOYEE_POSITION',
  CHANGE_EMPLOYEE_MANAGER: 'CHANGE_EMPLOYEE_MANAGER',
  UPDATE_DEPARTMENT_HEAD: 'UPDATE_DEPARTMENT_HEAD',
  CREATE_WORKFLOW_DEFINITION: 'CREATE_WORKFLOW_DEFINITION',
  ACTIVATE_WORKFLOW_DEFINITION: 'ACTIVATE_WORKFLOW_DEFINITION',
  DEACTIVATE_WORKFLOW_DEFINITION: 'DEACTIVATE_WORKFLOW_DEFINITION',
  WORKFLOW_SUBMIT: 'WORKFLOW_SUBMIT',
  WORKFLOW_APPROVE: 'WORKFLOW_APPROVE',
  WORKFLOW_REJECT: 'WORKFLOW_REJECT',
  WORKFLOW_CANCEL: 'WORKFLOW_CANCEL',
  CREATE_CALENDAR: 'CREATE_CALENDAR',
  UPDATE_CALENDAR: 'UPDATE_CALENDAR',
  ACTIVATE_CALENDAR: 'ACTIVATE_CALENDAR',
  DEACTIVATE_CALENDAR: 'DEACTIVATE_CALENDAR',
  SET_DEFAULT_CALENDAR: 'SET_DEFAULT_CALENDAR',
  CREATE_HOLIDAY: 'CREATE_HOLIDAY',
  UPDATE_HOLIDAY: 'UPDATE_HOLIDAY',
  ACTIVATE_HOLIDAY: 'ACTIVATE_HOLIDAY',
  DEACTIVATE_HOLIDAY: 'DEACTIVATE_HOLIDAY',
  CREATE_LEAVE_TYPE: 'CREATE_LEAVE_TYPE',
  UPDATE_LEAVE_TYPE: 'UPDATE_LEAVE_TYPE',
  ACTIVATE_LEAVE_TYPE: 'ACTIVATE_LEAVE_TYPE',
  DEACTIVATE_LEAVE_TYPE: 'DEACTIVATE_LEAVE_TYPE',
  CREATE_LEAVE_POLICY: 'CREATE_LEAVE_POLICY',
  UPDATE_LEAVE_POLICY: 'UPDATE_LEAVE_POLICY',
  ACTIVATE_LEAVE_POLICY: 'ACTIVATE_LEAVE_POLICY',
  DEACTIVATE_LEAVE_POLICY: 'DEACTIVATE_LEAVE_POLICY',
  GENERATE_LEAVE_ENTITLEMENT: 'GENERATE_LEAVE_ENTITLEMENT',
  ADJUST_LEAVE_ENTITLEMENT: 'ADJUST_LEAVE_ENTITLEMENT',
  CARRY_FORWARD_LEAVE_ENTITLEMENT: 'CARRY_FORWARD_LEAVE_ENTITLEMENT',
  CREATE_LEAVE_REQUEST: 'CREATE_LEAVE_REQUEST',
  UPDATE_LEAVE_REQUEST: 'UPDATE_LEAVE_REQUEST',
  SUBMIT_LEAVE_REQUEST: 'SUBMIT_LEAVE_REQUEST',
  APPROVE_LEAVE_REQUEST: 'APPROVE_LEAVE_REQUEST',
  REJECT_LEAVE_REQUEST: 'REJECT_LEAVE_REQUEST',
  CANCEL_LEAVE_REQUEST: 'CANCEL_LEAVE_REQUEST',
} as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

/** Human-readable label for an audit action; unknown codes fall back to the raw code. */
export function auditActionLabel(action: string): string {
  const known: Record<string, string> = {
    LOGIN_SUCCESS: 'Login success',
    LOGIN_FAILED: 'Login failed',
    LOGOUT: 'Logout',
    RESET_USER_PASSWORD: 'Reset user password',
    UPDATE_USER_ROLES: 'Update user roles',
    UPDATE_ROLE_PERMISSIONS: 'Update role permissions',
    UPDATE_DEPARTMENT_HEAD: 'Update department head',
    CHANGE_EMPLOYEE_POSITION: 'Change employee position',
    CHANGE_EMPLOYEE_MANAGER: 'Change employee manager',
    WORKFLOW_SUBMIT: 'Workflow submitted',
    WORKFLOW_APPROVE: 'Workflow step approved',
    WORKFLOW_REJECT: 'Workflow step rejected',
    WORKFLOW_CANCEL: 'Workflow cancelled',
  };
  if (known[action]) return known[action];
  // generic <VERB>_<ENTITY> → "Verb entity"
  const [verb, ...rest] = action.split('_');
  if (!verb || rest.length === 0) return action;
  const text = `${verb} ${rest.join(' ')}`.toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export const AUDIT_MODULE_LABELS: Record<string, string> = {
  auth: 'Authentication',
  users: 'Users',
  roles: 'Roles',
  organization: 'Organization',
  employees: 'Employees',
  workflow: 'Workflow',
  calendar: 'Calendar',
  leave: 'Leave',
};
