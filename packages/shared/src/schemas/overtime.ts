import { z } from 'zod';
import { OVERTIME_DAY_TYPES, OVERTIME_STATUSES } from '../enums';
import { isBusinessDate } from '../business-date';
import { paginationQuerySchema, reportPage, reportPageSize, type ApiListMeta } from './common';

/**
 * Overtime contracts (Task 21).
 *
 * Two rules shape every schema here. **Minutes are the unit** — a claim of 150 minutes is 150, never 2.5 hours, so no
 * precision is lost before payroll decides how to round. And **the client supplies almost nothing**: the date, the
 * minutes and a reason. Who the employee is, which day type it was, which policy applied and which multiplier it
 * earns are all derived on the server, because every one of them affects what somebody is eventually paid.
 */
const businessDate = z.string().refine(isBusinessDate, 'Use a real date in YYYY-MM-DD format');
/** Ratios, not money: above zero, and capped well above any real rate so a typo (15 instead of 1.5) is caught. */
const multiplier = z.number().positive('A multiplier must be greater than zero').max(10, 'A multiplier above 10 is almost certainly a typo');
const minutesField = z.number().int('Overtime is claimed in whole minutes').positive().max(24 * 60);

// ---------- policy ----------
export const createOvertimePolicySchema = z
  .object({
    organizationId: z.string().min(1),
    name: z.string().trim().min(1).max(100),
    effectiveFrom: businessDate,
    effectiveTo: businessDate.nullable().optional(),
    workdayMultiplier: multiplier,
    offDayMultiplier: multiplier,
    holidayMultiplier: multiplier,
    /** A claim below this is not overtime at all. It is a threshold, never a rounding rule. */
    minimumEligibleMinutes: z.number().int().min(0).max(24 * 60).nullable().optional(),
    maximumApprovedMinutesPerDay: z.number().int().positive().max(24 * 60).nullable().optional(),
    workflowDefinitionCode: z.string().trim().min(1).max(50),
  })
  .refine((v) => !v.effectiveTo || v.effectiveTo >= v.effectiveFrom, { message: 'effectiveTo must be on or after effectiveFrom', path: ['effectiveTo'] });
export type CreateOvertimePolicyInput = z.infer<typeof createOvertimePolicySchema>;

/**
 * What may change on a policy that requests already reference is decided by the service (rate fields are frozen once
 * a request has snapshotted them); the schema only describes what can be asked for.
 */
export const updateOvertimePolicySchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    effectiveTo: businessDate.nullable().optional(),
    workdayMultiplier: multiplier.optional(),
    offDayMultiplier: multiplier.optional(),
    holidayMultiplier: multiplier.optional(),
    minimumEligibleMinutes: z.number().int().min(0).max(24 * 60).nullable().optional(),
    maximumApprovedMinutesPerDay: z.number().int().positive().max(24 * 60).nullable().optional(),
    workflowDefinitionCode: z.string().trim().min(1).max(50).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type UpdateOvertimePolicyInput = z.infer<typeof updateOvertimePolicySchema>;

export const overtimePolicyListQuerySchema = paginationQuerySchema.extend({
  organizationId: z.string().min(1).optional(),
  status: z.enum(['active', 'inactive']).optional(),
});
export type OvertimePolicyListQuery = z.infer<typeof overtimePolicyListQuerySchema>;

export interface OvertimePolicyDto {
  id: string;
  organization: { id: string; code: string; name: string } | null;
  name: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  workdayMultiplier: number;
  offDayMultiplier: number;
  holidayMultiplier: number;
  minimumEligibleMinutes: number | null;
  maximumApprovedMinutesPerDay: number | null;
  workflowDefinitionCode: string;
  isActive: boolean;
  /** True once an overtime request has snapshotted this policy: its rate fields are frozen from then on. */
  inUse: boolean;
  createdAt: string;
  updatedAt: string;
}

// ---------- preview ----------
export const overtimePreviewSchema = z.object({ attendanceDate: businessDate });
export type OvertimePreviewInput = z.infer<typeof overtimePreviewSchema>;

export interface OvertimePreviewDto {
  attendanceDate: string;
  dayType: (typeof OVERTIME_DAY_TYPES)[number];
  attendanceStatus: string;
  scheduledStart: string | null;
  scheduledEnd: string | null;
  firstClockIn: string | null;
  lastClockOut: string | null;
  workedMinutes: number;
  requiredMinutes: number;
  preShiftMinutes: number;
  postShiftMinutes: number;
  eligibleMinutes: number;
  maximumClaimableMinutes: number;
  /** Why nothing can be claimed, when that is the case (e.g. the extra time only made up a late arrival). */
  reason: string;
  policy: {
    id: string;
    name: string;
    multiplier: number;
    minimumEligibleMinutes: number | null;
    maximumApprovedMinutesPerDay: number | null;
  } | null;
  /** A day that is not finished, or has half a clock, cannot be claimed yet. */
  claimable: boolean;
}

// ---------- request ----------
export const createOvertimeRequestSchema = z.object({
  attendanceDate: businessDate,
  claimedMinutes: minutesField,
  reason: z.string().trim().max(500).nullable().optional(),
});
export type CreateOvertimeRequestInput = z.infer<typeof createOvertimeRequestSchema>;

export const updateOvertimeRequestSchema = z
  .object({
    attendanceDate: businessDate.optional(),
    claimedMinutes: minutesField.optional(),
    reason: z.string().trim().max(500).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type UpdateOvertimeRequestInput = z.infer<typeof updateOvertimeRequestSchema>;

export const overtimeListQuerySchema = paginationQuerySchema.extend({
  status: z.enum(OVERTIME_STATUSES).optional(),
  dayType: z.enum(OVERTIME_DAY_TYPES).optional(),
  employeeId: z.string().min(1).optional(),
  departmentId: z.string().min(1).optional(),
  from: businessDate.optional(),
  to: businessDate.optional(),
  /** `mine` = my claims; `inbox` = claims waiting for my decision; `all` = everyone in my data scope. */
  view: z.enum(['mine', 'inbox', 'all']).default('mine'),
});
export type OvertimeListQuery = z.infer<typeof overtimeListQuerySchema>;

export interface OvertimeRequestDto {
  id: string;
  employee: { id: string; employeeCode: string; firstName: string; lastName: string; department: { id: string; name: string } | null };
  attendanceDate: string;
  dayType: (typeof OVERTIME_DAY_TYPES)[number];
  claimedMinutes: number;
  /** What the day allowed when the claim was submitted — frozen, so a later change is visible as a difference. */
  eligibleMinutesSnapshot: number | null;
  approvedMinutes: number | null;
  /** The rate this day earns. Snapshotted at submit and never re-resolved, so a policy change cannot rewrite history. */
  rateMultiplierSnapshot: number | null;
  policy: { id: string; name: string } | null;
  reason: string | null;
  status: (typeof OVERTIME_STATUSES)[number];
  workflowInstanceId: string | null;
  submittedAt: string | null;
  approvedAt: string | null;
  rejectedAt: string | null;
  cancelledAt: string | null;
  createdBy: { id: string; email: string } | null;
  createdAt: string;
}

// ---------- reporting ----------
export const overtimeReportQuerySchema = z
  .object({
    from: businessDate,
    to: businessDate,
    departmentId: z.string().min(1).optional(),
    employeeId: z.string().min(1).optional(),
    // Task 48 (T44-P1-13): rows are paged; totals always cover every employee in scope.
    page: reportPage,
    pageSize: reportPageSize,
  })
  .refine((v) => v.from <= v.to, { message: 'The end date cannot be before the start date', path: ['to'] });
/** Internal callers (executive, Employee 360) may omit paging: page 1, 50 rows. */
export type OvertimeReportQuery = Omit<z.infer<typeof overtimeReportQuerySchema>, 'page' | 'pageSize'> & { page?: number; pageSize?: number };

export interface OvertimeReportRowDto {
  employee: { id: string; employeeCode: string; firstName: string; lastName: string; department: { id: string; name: string } | null };
  requests: number;
  approvedRequests: number;
  approvedMinutes: number;
  byDayType: { WORKDAY: number; OFF_DAY: number; HOLIDAY: number };
}

export interface OvertimeReportDto {
  from: string;
  to: string;
  /** One page of employees (`meta`). */
  rows: OvertimeReportRowDto[];
  /** Every employee in scope, aggregated in SQL — never the sum of the visible page (Task 48, T44-P1-13). */
  totals: { requests: number; approvedRequests: number; approvedMinutes: number; byDayType: { WORKDAY: number; OFF_DAY: number; HOLIDAY: number } };
  totalEmployees: number;
  meta: ApiListMeta;
  /** Stated in the payload so no reader mistakes this for a payroll figure. */
  note: 'Minutes and multipliers only — this release calculates no monetary overtime.';
}

/** What payroll (Task 22) will read. Deliberately minimal: no workflow, no history, no money. */
export interface ApprovedOvertimeForPayrollDto {
  requestId: string;
  employeeId: string;
  attendanceDate: string;
  approvedMinutes: number;
  dayType: (typeof OVERTIME_DAY_TYPES)[number];
  rateMultiplierSnapshot: number;
  policyId: string | null;
}
