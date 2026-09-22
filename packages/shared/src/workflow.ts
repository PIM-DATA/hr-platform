/**
 * Workflow engine constants (shared by API + web). Kept out of enums.ts so the
 * workflow vocabulary lives in one file.
 */
export const APPROVER_TYPES = {
  DIRECT_MANAGER: 'DIRECT_MANAGER',
  DEPARTMENT_HEAD: 'DEPARTMENT_HEAD',
  SPECIFIC_USER: 'SPECIFIC_USER',
  /** Reserved: business approver groups are not designed yet (RBAC roles are not organization-scoped approvers). */
  ROLE: 'ROLE',
} as const;
export type ApproverType = (typeof APPROVER_TYPES)[keyof typeof APPROVER_TYPES];
/** Approver types the engine can resolve today. */
export const SUPPORTED_APPROVER_TYPES: ApproverType[] = [APPROVER_TYPES.DIRECT_MANAGER, APPROVER_TYPES.DEPARTMENT_HEAD, APPROVER_TYPES.SPECIFIC_USER];

/** What to do when the resolved approver is the requester (default FAIL → 409 SELF_APPROVAL_NOT_ALLOWED). */
export const ON_SELF = ['FAIL', 'SKIP'] as const;
/** What to do when no valid approver can be resolved (default FAIL → 409 APPROVER_UNRESOLVED). */
export const ON_UNRESOLVED = ['FAIL', 'SKIP'] as const;

export const WORKFLOW_INSTANCE_STATUS = { PENDING: 'PENDING', APPROVED: 'APPROVED', REJECTED: 'REJECTED', CANCELLED: 'CANCELLED' } as const;
export type WorkflowInstanceStatus = (typeof WORKFLOW_INSTANCE_STATUS)[keyof typeof WORKFLOW_INSTANCE_STATUS];

export const WORKFLOW_STEP_STATUS = { WAITING: 'WAITING', PENDING: 'PENDING', APPROVED: 'APPROVED', REJECTED: 'REJECTED', SKIPPED: 'SKIPPED', CANCELLED: 'CANCELLED' } as const;
export type WorkflowStepStatus = (typeof WORKFLOW_STEP_STATUS)[keyof typeof WORKFLOW_STEP_STATUS];

/** History actions. SUBMIT/CANCEL are internal (business module); APPROVE/REJECT are approver HTTP actions. */
export const WORKFLOW_ACTIONS = { SUBMIT: 'SUBMIT', APPROVE: 'APPROVE', REJECT: 'REJECT', CANCEL: 'CANCEL' } as const;
export type WorkflowAction = (typeof WORKFLOW_ACTIONS)[keyof typeof WORKFLOW_ACTIONS];
/** Actions an approver may take through the generic endpoint. */
export const APPROVER_HTTP_ACTIONS = [WORKFLOW_ACTIONS.APPROVE, WORKFLOW_ACTIONS.REJECT] as const;

/** Reasons a step was skipped at submit time (stored on the snapshot for audit/debug). */
export const SKIP_REASONS = { SELF: 'SELF', UNRESOLVED: 'UNRESOLVED' } as const;

/** Why an approver could not be resolved (safe to return to clients). */
export const UNRESOLVED_REASONS = {
  NO_MANAGER: 'NO_MANAGER',
  NO_DEPARTMENT_HEAD: 'NO_DEPARTMENT_HEAD',
  EMPLOYEE_INACTIVE: 'EMPLOYEE_INACTIVE',
  NO_USER_ACCOUNT: 'NO_USER_ACCOUNT',
  USER_INACTIVE: 'USER_INACTIVE',
  USER_NOT_FOUND: 'USER_NOT_FOUND',
} as const;
