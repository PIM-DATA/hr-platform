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

  OT_VIEW: 'ot.view',
  OT_REQUEST: 'ot.request',
  OT_MANAGE_POLICY: 'ot.manage_policy',

  PAYROLL_VIEW_OWN: 'payroll.view_own',
  PAYROLL_MANAGE: 'payroll.manage',
  PAYROLL_RUN: 'payroll.run',
  PAYROLL_APPROVE: 'payroll.approve',

  PERFORMANCE_VIEW: 'performance.view',
  PERFORMANCE_REVIEW: 'performance.review',
  PERFORMANCE_MANAGE_CYCLES: 'performance.manage_cycles',
  PERFORMANCE_MANAGE_KPIS: 'performance.manage_kpis',

  COMPETENCY_VIEW: 'competency.view',
  COMPETENCY_ASSESS: 'competency.assess',
  COMPETENCY_MANAGE: 'competency.manage',

  TRAINING_VIEW: 'training.view',
  TRAINING_MANAGE: 'training.manage',
  TRAINING_ENROLL: 'training.enroll',
  TRAINING_RECORD_RESULT: 'training.record_result',
  IDP_VIEW: 'idp.view',
  IDP_MANAGE: 'idp.manage',

  EMPLOYEE_RELATIONS_VIEW: 'employee_relations.view',
  EMPLOYEE_RELATIONS_MANAGE: 'employee_relations.manage',
  EMPLOYEE_RELATIONS_ISSUE: 'employee_relations.issue',
  EMPLOYEE_RELATIONS_ACKNOWLEDGE: 'employee_relations.acknowledge',

  RECRUITMENT_VIEW: 'recruitment.view',
  RECRUITMENT_MANAGE: 'recruitment.manage',
  RECRUITMENT_INTERVIEW: 'recruitment.interview',
  RECRUITMENT_MANAGE_OFFERS: 'recruitment.manage_offers',
  RECRUITMENT_HIRE: 'recruitment.hire',
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

  { code: PERMISSIONS.OT_VIEW, module: 'ot', description: 'View overtime requests (scope depends on role data scope)' },
  { code: PERMISSIONS.OT_REQUEST, module: 'ot', description: 'Claim overtime for yourself' },
  { code: PERMISSIONS.OT_MANAGE_POLICY, module: 'ot', description: 'Manage overtime policies' },

  { code: PERMISSIONS.PAYROLL_VIEW_OWN, module: 'payroll', description: 'View your own payslips' },
  { code: PERMISSIONS.PAYROLL_MANAGE, module: 'payroll', description: 'Manage compensation, pay components and payroll configuration' },
  { code: PERMISSIONS.PAYROLL_RUN, module: 'payroll', description: 'Calculate and close payroll runs' },
  { code: PERMISSIONS.PAYROLL_APPROVE, module: 'payroll', description: 'Decide payroll runs' },

  { code: PERMISSIONS.PERFORMANCE_VIEW, module: 'performance', description: 'View your own performance plan and aggregate performance reports' },
  { code: PERMISSIONS.PERFORMANCE_REVIEW, module: 'performance', description: 'Review the performance plans you are the assigned reviewer for' },
  { code: PERMISSIONS.PERFORMANCE_MANAGE_CYCLES, module: 'performance', description: 'Manage performance cycles and the plans inside them' },
  { code: PERMISSIONS.PERFORMANCE_MANAGE_KPIS, module: 'performance', description: 'Manage the KPI library' },

  { code: PERMISSIONS.COMPETENCY_VIEW, module: 'competency', description: 'View your own competency profile and aggregate competency reports' },
  { code: PERMISSIONS.COMPETENCY_ASSESS, module: 'competency', description: 'Assess the competency assessments you are the assigned reviewer for' },
  { code: PERMISSIONS.COMPETENCY_MANAGE, module: 'competency', description: 'Manage the competency framework, job profiles and assessment cycles' },

  { code: PERMISSIONS.TRAINING_VIEW, module: 'training', description: 'View the course catalogue and your own training record' },
  { code: PERMISSIONS.TRAINING_MANAGE, module: 'training', description: 'Manage training needs, courses and sessions' },
  { code: PERMISSIONS.TRAINING_ENROLL, module: 'training', description: 'Enrol employees on training sessions' },
  { code: PERMISSIONS.TRAINING_RECORD_RESULT, module: 'training', description: 'Record training attendance and results' },
  { code: PERMISSIONS.IDP_VIEW, module: 'training', description: 'View your own development plan' },
  { code: PERMISSIONS.IDP_MANAGE, module: 'training', description: 'Create and manage individual development plans' },

  { code: PERMISSIONS.EMPLOYEE_RELATIONS_VIEW, module: 'employee_relations', description: 'View employee relations cases and disciplinary history' },
  { code: PERMISSIONS.EMPLOYEE_RELATIONS_MANAGE, module: 'employee_relations', description: 'Manage employee relations cases, actions and configuration' },
  { code: PERMISSIONS.EMPLOYEE_RELATIONS_ISSUE, module: 'employee_relations', description: 'Submit disciplinary actions for approval and issue warning letters' },
  { code: PERMISSIONS.EMPLOYEE_RELATIONS_ACKNOWLEDGE, module: 'employee_relations', description: 'Acknowledge receipt of a disciplinary document issued to you' },

  { code: PERMISSIONS.RECRUITMENT_VIEW, module: 'recruitment', description: 'View the requisitions, openings and applications you are the hiring manager or an interviewer for' },
  { code: PERMISSIONS.RECRUITMENT_MANAGE, module: 'recruitment', description: 'Manage requisitions, openings, candidates, applications and interviews' },
  { code: PERMISSIONS.RECRUITMENT_INTERVIEW, module: 'recruitment', description: 'Give feedback on interviews you are assigned to' },
  { code: PERMISSIONS.RECRUITMENT_MANAGE_OFFERS, module: 'recruitment', description: 'Draft, submit and record the outcome of job offers, including compensation proposals' },
  { code: PERMISSIONS.RECRUITMENT_HIRE, module: 'recruitment', description: 'Convert an accepted candidate into an employee record' },
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
  request: 'Request',
  manage_policy: 'Manage policies',
  view_own: 'View own',
  run: 'Run',
  approve: 'Approve',
  correct: 'Correct',
  schedule_manage: 'Manage schedules',
};
