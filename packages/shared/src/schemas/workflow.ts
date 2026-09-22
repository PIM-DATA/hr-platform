import { z } from 'zod';
import { APPROVER_HTTP_ACTIONS, APPROVER_TYPES, ON_SELF, ON_UNRESOLVED, SUPPORTED_APPROVER_TYPES } from '../workflow';

const codeField = z.string().trim().toUpperCase().min(1).max(50).regex(/^[A-Z0-9][A-Z0-9._-]*$/, 'Use letters, numbers, dot, dash or underscore');

export const workflowStepInputSchema = z
  .object({
    name: z.string().trim().min(1, 'Step name is required').max(80),
    approverType: z.enum(Object.values(APPROVER_TYPES) as [string, ...string[]]),
    approverUserId: z.string().min(1).nullable().optional(),
    onSelf: z.enum(ON_SELF).default('FAIL'),
    onUnresolved: z.enum(ON_UNRESOLVED).default('FAIL'),
  })
  .superRefine((s, ctx) => {
    if (!(SUPPORTED_APPROVER_TYPES as string[]).includes(s.approverType)) {
      ctx.addIssue({ code: 'custom', path: ['approverType'], message: `Approver type ${s.approverType} is not supported yet` });
    }
    if (s.approverType === APPROVER_TYPES.SPECIFIC_USER && !s.approverUserId) {
      ctx.addIssue({ code: 'custom', path: ['approverUserId'], message: 'SPECIFIC_USER steps need an approver user' });
    }
    if (s.approverType !== APPROVER_TYPES.SPECIFIC_USER && s.approverUserId) {
      ctx.addIssue({ code: 'custom', path: ['approverUserId'], message: `${s.approverType} steps must not set an approver user` });
    }
  });
export type WorkflowStepInput = z.infer<typeof workflowStepInputSchema>;

/** Creates a new definition version (version number is assigned by the server: max(code)+1, inactive). */
export const createWorkflowDefinitionSchema = z.object({
  code: codeField,
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).nullable().optional(),
  module: z.string().trim().min(1).max(40).regex(/^[a-z][a-z0-9_]*$/, 'lowercase module key'),
  entityType: z.string().trim().min(1).max(60).regex(/^[A-Za-z][A-Za-z0-9_]*$/, 'Entity type: letters, digits, underscore'),
  /** Order is the array order (1..n). */
  steps: z.array(workflowStepInputSchema).min(1, 'At least one step is required').max(20),
});
export type CreateWorkflowDefinitionInput = z.infer<typeof createWorkflowDefinitionSchema>;

export const workflowActionSchema = z.object({
  action: z.enum(APPROVER_HTTP_ACTIONS),
  comment: z.string().trim().max(1000).nullable().optional(),
});
export type WorkflowActionInput = z.infer<typeof workflowActionSchema>;

export const workflowInboxQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  module: z.string().trim().max(40).optional(),
});
export const workflowInstanceListQuerySchema = workflowInboxQuerySchema.extend({
  status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED']).optional(),
  entityType: z.string().trim().max(60).optional(),
  requesterEmployeeId: z.string().min(1).optional(),
});

export const approverOptionsQuerySchema = z.object({
  search: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
/** Minimal picker row for SPECIFIC_USER steps — never roles/permissions or account internals. */
export interface ApproverOptionDto {
  id: string;
  email: string;
  employee: { id: string; employeeCode: string; firstName: string; lastName: string; employmentStatus: string } | null;
}

// ---------- DTOs ----------
export interface WorkflowDefinitionStepDto {
  id: string;
  stepOrder: number;
  name: string;
  approverType: string;
  approverUser: { id: string; email: string } | null;
  onSelf: string;
  onUnresolved: string;
}
export interface WorkflowDefinitionDto {
  id: string;
  code: string;
  version: number;
  name: string;
  description: string | null;
  module: string;
  entityType: string;
  isActive: boolean;
  instanceCount: number;
  steps: WorkflowDefinitionStepDto[];
  createdAt: string;
  activatedAt: string | null;
}

export interface WorkflowInstanceStepDto {
  stepOrder: number;
  name: string;
  approverType: string;
  approverEmployee: { id: string; employeeCode: string; firstName: string; lastName: string } | null;
  approverUser: { id: string; email: string } | null;
  status: string;
  skipReason: string | null;
  actedBy: { id: string; email: string } | null;
  actedAt: string | null;
  comment: string | null;
}
export interface WorkflowActionDto {
  id: string;
  stepOrder: number | null;
  action: string;
  actor: { id: string; email: string } | null;
  comment: string | null;
  createdAt: string;
}
export interface WorkflowInstanceDto {
  id: string;
  definition: { id: string; code: string; version: number; name: string };
  module: string;
  entityType: string;
  entityId: string;
  requesterEmployee: { id: string; employeeCode: string; firstName: string; lastName: string };
  status: string;
  currentStepOrder: number | null;
  submittedAt: string;
  completedAt: string | null;
  steps: WorkflowInstanceStepDto[];
  actions: WorkflowActionDto[];
}
/** Inbox row = one step waiting for the caller. */
export interface WorkflowInboxItemDto {
  instanceId: string;
  stepOrder: number;
  stepName: string;
  module: string;
  entityType: string;
  entityId: string;
  definitionName: string;
  requesterEmployee: { id: string; employeeCode: string; firstName: string; lastName: string };
  submittedAt: string;
}
