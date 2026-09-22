import { z } from 'zod';
import { LEAVE_REQUEST_STATUSES } from '../enums';
import { businessDateSchema } from './calendar';
import { paginationQuerySchema } from './common';
import type { BalanceSummary } from '../leave-ledger';

const startPartSchema = z.enum(['FULL', 'PM']).default('FULL');
const endPartSchema = z.enum(['FULL', 'AM']).default('FULL');
const reasonSchema = z.string().trim().max(1000).nullable().optional();
const attachmentRefSchema = z.string().trim().max(500).nullable().optional(); // opaque reference; no document service yet

/**
 * What a requester may send. STRICT: employeeId, units, policyId, entitlementId, calendarId, organization/department/
 * position, workflowInstanceId and status are derived by the server and rejected as unknown keys (400).
 */
export const leaveRequestBodySchema = z
  .object({ leaveTypeId: z.string().min(1, 'Leave type is required'), startDate: businessDateSchema, endDate: businessDateSchema, startPart: startPartSchema, endPart: endPartSchema, reason: reasonSchema, attachmentRef: attachmentRefSchema })
  .strict()
  .refine((v) => v.startDate <= v.endDate, { message: 'startDate must be on or before endDate', path: ['endDate'] });
export type LeaveRequestBody = z.infer<typeof leaveRequestBodySchema>;

export const updateLeaveRequestSchema = z
  .object({ leaveTypeId: z.string().min(1).optional(), startDate: businessDateSchema.optional(), endDate: businessDateSchema.optional(), startPart: z.enum(['FULL', 'PM']).optional(), endPart: z.enum(['FULL', 'AM']).optional(), reason: reasonSchema, attachmentRef: attachmentRefSchema })
  .strict();
export type UpdateLeaveRequestInput = z.infer<typeof updateLeaveRequestSchema>;

export const leaveRequestListQuerySchema = paginationQuerySchema.extend({
  status: z.enum(LEAVE_REQUEST_STATUSES as [string, ...string[]]).optional(),
  leaveTypeId: z.string().min(1).optional(),
  employeeId: z.string().min(1).optional(),
  organizationId: z.string().min(1).optional(),
  departmentId: z.string().min(1).optional(),
  from: businessDateSchema.optional(),
  to: businessDateSchema.optional(),
});
export type LeaveRequestListQuery = z.infer<typeof leaveRequestListQuerySchema>;

export const balancesMeQuerySchema = z.object({ asOfDate: businessDateSchema.optional() });

// ---------- DTOs ----------
export interface LeaveRequestDto {
  id: string;
  employee: { id: string; employeeCode: string; firstName: string; lastName: string };
  leaveType: { id: string; code: string; name: string };
  startDate: string;
  endDate: string;
  startPart: 'FULL' | 'PM';
  endPart: 'FULL' | 'AM';
  units: number;
  reason: string | null;
  attachmentRef: string | null;
  status: string;
  entitlementId: string | null;
  policy: { id: string; name: string } | null;
  calendarId: string | null;
  organizationId: string | null;
  departmentId: string | null;
  positionId: string | null;
  workflowInstanceId: string | null;
  submittedAt: string | null;
  approvedAt: string | null;
  rejectedAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LeaveWorkflowTimelineDto {
  id: string;
  status: string;
  currentStepOrder: number | null;
  steps: { stepOrder: number; name: string; approverType: string; approver: { id: string; email: string } | null; approverEmployee: { id: string; employeeCode: string; firstName: string; lastName: string } | null; status: string; skipReason: string | null; actedAt: string | null; comment: string | null }[];
  actions: { stepOrder: number | null; action: string; actor: { id: string; email: string } | null; comment: string | null; createdAt: string }[];
}

export interface LeaveRequestDetailDto extends LeaveRequestDto {
  /** Balance context of the snapshotted entitlement (null for drafts without one). */
  balance: (BalanceSummary & { available: number; periodStart: string; periodEnd: string }) | null;
  workflow: LeaveWorkflowTimelineDto | null;
}

export interface LeaveRequestPreviewDto {
  leaveType: { id: string; code: string; name: string };
  units: number;
  workingDays: string[];
  entitlement: { id: string; periodStart: string; periodEnd: string; available: number };
  policy: { id: string; name: string; allowHalfDay: boolean; allowNegativeBalance: boolean; requiresReason: boolean; requiresAttachment: boolean; minNoticeDays: number | null; maxConsecutiveDays: number | null; allowBackdate: boolean };
  calendar: { id: string; name: string };
  remainingAfter: number;
  workflow: { code: string; name: string };
}

export interface MyBalanceDto extends BalanceSummary {
  entitlementId: string;
  leaveType: { id: string; code: string; name: string };
  periodStart: string;
  periodEnd: string;
  available: number;
}
