import { z } from 'zod';
import { EMPLOYMENT_TYPES } from '../enums';
import { isHalfDayUnit } from '../business-date';
import { businessDateSchema } from './calendar';
import { paginationQuerySchema } from './common';

/** Workflow compatibility contract for leave requests (Task 11 submits with this module/entityType). */
export const LEAVE_WORKFLOW = { module: 'leave', entityType: 'LEAVE_REQUEST' } as const;

/** Phase 2 unit precision = half day. */
export const unitsSchema = z.coerce.number().refine(isHalfDayUnit, { message: 'Units must be a multiple of 0.5 and not negative' });

const codeField = z.string().trim().toUpperCase().min(1, 'Code is required').max(30).regex(/^[A-Z0-9][A-Z0-9._-]*$/, 'Use letters, numbers, dot, dash or underscore');
const nameField = z.string().trim().min(1, 'Name is required').max(120);
const nonEmpty = <T extends z.ZodRawShape>(shape: T) => z.object(shape).refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });

// ---------- leave types (semantic master only) ----------
export const createLeaveTypeSchema = z.object({ code: codeField, name: nameField, description: z.string().trim().max(500).nullable().optional() });
export const updateLeaveTypeSchema = nonEmpty({ code: codeField.optional(), name: nameField.optional(), description: z.string().trim().max(500).nullable().optional() });
export const leaveTypeListQuerySchema = paginationQuerySchema.extend({ status: z.enum(['active', 'inactive']).optional() });
export type CreateLeaveTypeInput = z.infer<typeof createLeaveTypeSchema>;
export type UpdateLeaveTypeInput = z.infer<typeof updateLeaveTypeSchema>;

export interface LeaveTypeDto { id: string; code: string; name: string; description: string | null; isActive: boolean; activePolicyCount: number; createdAt: string; updatedAt: string }

// ---------- leave policies ----------
const policyFields = {
  name: nameField,
  leaveTypeId: z.string().min(1, 'Leave type is required'),
  organizationId: z.string().min(1).nullable().optional(),
  employmentType: z.enum(EMPLOYMENT_TYPES).nullable().optional(),
  annualUnits: unitsSchema,
  isPaid: z.boolean().default(true),
  requiresReason: z.boolean().default(false),
  requiresAttachment: z.boolean().default(false),
  allowHalfDay: z.boolean().default(true),
  allowNegativeBalance: z.boolean().default(false),
  maxConsecutiveDays: z.coerce.number().int().min(1).max(365).nullable().optional(),
  minNoticeDays: z.coerce.number().int().min(0).max(365).nullable().optional(),
  allowBackdate: z.boolean().default(false),
  carryForwardMaxUnits: unitsSchema.default(0),
  carryForwardExpiryMonths: z.coerce.number().int().min(1).max(24).nullable().optional(),
  workflowDefinitionCode: z.string().trim().toUpperCase().min(1).max(50).nullable().optional(),
  effectiveFrom: businessDateSchema,
  effectiveTo: businessDateSchema.nullable().optional(),
};
export const createLeavePolicySchema = z.object(policyFields);
export const updateLeavePolicySchema = nonEmpty(Object.fromEntries(Object.entries(policyFields).map(([k, v]) => [k, (v as z.ZodTypeAny).optional()])) as { [K in keyof typeof policyFields]: z.ZodOptional<(typeof policyFields)[K]> });
export const leavePolicyListQuerySchema = paginationQuerySchema.extend({
  leaveTypeId: z.string().min(1).optional(),
  organizationId: z.string().min(1).optional(),
  status: z.enum(['active', 'inactive']).optional(),
});
export const resolvePolicyQuerySchema = z.object({ employeeId: z.string().min(1), leaveTypeId: z.string().min(1), asOfDate: businessDateSchema.optional() });
export const workflowOptionsQuerySchema = z.object({ search: z.string().trim().max(50).optional() });

export type CreateLeavePolicyInput = z.infer<typeof createLeavePolicySchema>;
export type UpdateLeavePolicyInput = z.infer<typeof updateLeavePolicySchema>;
export type LeavePolicyListQuery = z.infer<typeof leavePolicyListQuerySchema>;

export interface LeavePolicyDto {
  id: string;
  name: string;
  leaveType: { id: string; code: string; name: string };
  organization: { id: string; code: string; name: string } | null;
  employmentType: string | null;
  annualUnits: number;
  isPaid: boolean;
  requiresReason: boolean;
  requiresAttachment: boolean;
  allowHalfDay: boolean;
  allowNegativeBalance: boolean;
  maxConsecutiveDays: number | null;
  minNoticeDays: number | null;
  allowBackdate: boolean;
  carryForwardMaxUnits: number;
  carryForwardExpiryMonths: number | null;
  workflowDefinitionCode: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Compatible workflow definitions for the policy picker (leave.manage_policies). */
export interface LeaveWorkflowOptionDto { code: string; name: string; version: number; steps: { stepOrder: number; name: string; approverType: string }[] }
