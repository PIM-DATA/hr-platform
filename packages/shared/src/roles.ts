import { PERMISSIONS, type PermissionCode } from './permissions';

export const ROLES = {
  EMPLOYEE: 'EMPLOYEE',
  MANAGER: 'MANAGER',
  HR: 'HR',
  HR_ADMIN: 'HR_ADMIN',
  EXECUTIVE: 'EXECUTIVE',
  SYSTEM_ADMIN: 'SYSTEM_ADMIN',
} as const;

export type RoleCode = (typeof ROLES)[keyof typeof ROLES];

/**
 * Data scope controls WHICH employee records a role may see/act on.
 *  SELF = own record only, TEAM = own + direct reports, ALL = everyone.
 * A user with several roles gets the widest scope among them.
 */
export const DATA_SCOPES = { SELF: 'SELF', TEAM: 'TEAM', ALL: 'ALL' } as const;
export type DataScope = (typeof DATA_SCOPES)[keyof typeof DATA_SCOPES];

export interface RoleDefinition {
  code: RoleCode;
  name: string;
  description: string;
  dataScope: DataScope;
  permissions: PermissionCode[];
}

const P = PERMISSIONS;

/** Seed source for `roles` + `role_permissions`. Editable later via Roles page. */
export const ROLE_DEFINITIONS: RoleDefinition[] = [
  {
    code: ROLES.EMPLOYEE,
    name: 'Employee',
    description: 'Employee self service: own profile and organization view',
    dataScope: DATA_SCOPES.SELF,
    permissions: [P.DASHBOARD_VIEW, P.EMPLOYEES_VIEW, P.ORGANIZATION_VIEW, P.LEAVE_VIEW, P.LEAVE_REQUEST, P.ATTENDANCE_VIEW, P.ATTENDANCE_CLOCK, P.OT_VIEW, P.OT_REQUEST, P.PAYROLL_VIEW_OWN, P.PERFORMANCE_VIEW, P.COMPETENCY_VIEW],
  },
  {
    code: ROLES.MANAGER,
    name: 'Manager',
    description: 'Manager self service: own team',
    dataScope: DATA_SCOPES.TEAM,
    permissions: [P.DASHBOARD_VIEW, P.EMPLOYEES_VIEW, P.ORGANIZATION_VIEW, P.WORKFLOW_APPROVE, P.LEAVE_VIEW, P.LEAVE_REQUEST, P.ATTENDANCE_VIEW, P.ATTENDANCE_CLOCK, P.OT_VIEW, P.OT_REQUEST, P.PAYROLL_VIEW_OWN, P.PERFORMANCE_VIEW, P.PERFORMANCE_REVIEW, P.COMPETENCY_VIEW, P.COMPETENCY_ASSESS],
  },
  {
    code: ROLES.HR,
    name: 'HR',
    description: 'HR officer: manage employee master data',
    dataScope: DATA_SCOPES.ALL,
    permissions: [
      P.DASHBOARD_VIEW,
      P.EMPLOYEES_VIEW,
      P.EMPLOYEES_CREATE,
      P.EMPLOYEES_UPDATE,
      P.ORGANIZATION_VIEW,
      P.WORKFLOW_APPROVE,
      P.CALENDAR_VIEW,
      P.LEAVE_MANAGE_ENTITLEMENTS,
      P.LEAVE_VIEW,
      P.LEAVE_REQUEST,
      P.ATTENDANCE_VIEW,
      P.ATTENDANCE_CLOCK,
      P.ATTENDANCE_CORRECT,
      P.OT_VIEW,
      P.PAYROLL_VIEW_OWN,
      P.PAYROLL_MANAGE,
      P.PERFORMANCE_VIEW,
      P.COMPETENCY_VIEW,
    ],
  },
  {
    code: ROLES.HR_ADMIN,
    name: 'HR Admin',
    description: 'HR administrator: employees, organization, users and audit',
    dataScope: DATA_SCOPES.ALL,
    permissions: [
      P.DASHBOARD_VIEW,
      P.EMPLOYEES_VIEW,
      P.EMPLOYEES_CREATE,
      P.EMPLOYEES_UPDATE,
      P.EMPLOYEES_ACTIVATE,
      P.ORGANIZATION_VIEW,
      P.ORGANIZATION_MANAGE,
      P.USERS_VIEW,
      P.USERS_CREATE,
      P.USERS_UPDATE,
      P.USERS_ACTIVATE,
      P.ROLES_VIEW,
      P.AUDIT_VIEW,
      P.WORKFLOW_APPROVE,
      P.WORKFLOW_VIEW_ALL,
      P.WORKFLOW_MANAGE_DEFINITIONS,
      P.CALENDAR_VIEW,
      P.CALENDAR_MANAGE,
      P.LEAVE_MANAGE_TYPES,
      P.LEAVE_MANAGE_POLICIES,
      P.LEAVE_MANAGE_ENTITLEMENTS,
      P.LEAVE_VIEW,
      P.LEAVE_REQUEST,
      P.ONBOARDING_MANAGE,
      P.ACCOUNT_MANAGE_RECOVERY,
      P.PRIVACY_MANAGE_REQUESTS,
      P.PRIVACY_EXPORT_DATA,
      P.ATTENDANCE_VIEW,
      P.ATTENDANCE_CLOCK,
      P.ATTENDANCE_MANAGE,
      P.ATTENDANCE_CORRECT,
      P.ATTENDANCE_SCHEDULE_MANAGE,
      P.OT_VIEW,
      P.OT_REQUEST,
      P.OT_MANAGE_POLICY,
      P.PAYROLL_VIEW_OWN,
      P.PAYROLL_MANAGE,
      P.PAYROLL_RUN,
      P.PAYROLL_APPROVE,
      P.PERFORMANCE_VIEW,
      P.PERFORMANCE_REVIEW,
      P.PERFORMANCE_MANAGE_CYCLES,
      P.PERFORMANCE_MANAGE_KPIS,
      P.COMPETENCY_VIEW,
      P.COMPETENCY_ASSESS,
      P.COMPETENCY_MANAGE,
    ],
  },
  {
    code: ROLES.EXECUTIVE,
    name: 'Executive',
    description: 'Executive: read-only organization-wide view and dashboards',
    dataScope: DATA_SCOPES.ALL,
    // `performance.view` and `competency.view` show an executive their own record and the **aggregate** reports —
    // never an individual's scores, levels or comments, which need to be that employee, their snapshot reviewer, or
    // somebody who manages the cycle.
    permissions: [P.DASHBOARD_VIEW, P.EMPLOYEES_VIEW, P.ORGANIZATION_VIEW, P.WORKFLOW_APPROVE, P.LEAVE_VIEW, P.LEAVE_REQUEST, P.ATTENDANCE_VIEW, P.OT_VIEW, P.PERFORMANCE_VIEW, P.COMPETENCY_VIEW],
  },
  {
    code: ROLES.SYSTEM_ADMIN,
    name: 'System Admin',
    description: 'Full system access',
    dataScope: DATA_SCOPES.ALL,
    permissions: Object.values(P),
  },
];
