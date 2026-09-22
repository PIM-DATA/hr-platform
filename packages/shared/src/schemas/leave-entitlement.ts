import { z } from 'zod';
import { isHalfDayUnit } from '../business-date';
import { businessDateSchema } from './calendar';
import { paginationQuerySchema } from './common';
import type { BalanceSummary } from '../leave-ledger';

/** Signed, non-zero, half-day multiple. */
export const signedLedgerUnitsSchema = z.coerce.number().refine((n) => n !== 0 && isHalfDayUnit(Math.abs(n)), { message: 'Units must be a non-zero multiple of 0.5' });
/** Positive, half-day multiple. */
export const positiveLedgerUnitsSchema = z.coerce.number().refine((n) => n > 0 && isHalfDayUnit(n), { message: 'Units must be a positive multiple of 0.5' });

export const createEntitlementSchema = z
  .object({ employeeId: z.string().min(1, 'Employee is required'), leaveTypeId: z.string().min(1, 'Leave type is required'), periodStart: businessDateSchema, periodEnd: businessDateSchema })
  .refine((v) => v.periodStart <= v.periodEnd, { message: 'periodStart must be on or before periodEnd', path: ['periodEnd'] });
export type CreateEntitlementInput = z.infer<typeof createEntitlementSchema>;

export const adjustEntitlementSchema = z.object({ units: signedLedgerUnitsSchema, note: z.string().trim().min(1, 'A note is required').max(500) });
export type AdjustEntitlementInput = z.infer<typeof adjustEntitlementSchema>;

export const carryForwardSchema = z.object({ units: positiveLedgerUnitsSchema, note: z.string().trim().max(500).nullable().optional() });
export type CarryForwardInput = z.infer<typeof carryForwardSchema>;

export const entitlementListQuerySchema = paginationQuerySchema.extend({
  employeeId: z.string().min(1).optional(),
  leaveTypeId: z.string().min(1).optional(),
  organizationId: z.string().min(1).optional(),
  year: z.coerce.number().int().min(1970).max(2200).optional(),
  periodStart: businessDateSchema.optional(),
});
export type EntitlementListQuery = z.infer<typeof entitlementListQuerySchema>;
export const ledgerListQuerySchema = z.object({ page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25) });
export const entitlementPreviewQuerySchema = z.object({ employeeId: z.string().min(1), leaveTypeId: z.string().min(1), periodStart: businessDateSchema });
export const leaveEmployeeOptionsQuerySchema = z.object({ search: z.string().trim().max(100).optional(), organizationId: z.string().min(1).optional(), limit: z.coerce.number().int().min(1).max(50).default(20) });

// ---------- DTOs ----------
export interface EntitlementDto extends BalanceSummary {
  id: string;
  employee: { id: string; employeeCode: string; firstName: string; lastName: string; organization: { id: string; code: string; name: string } };
  leaveType: { id: string; code: string; name: string };
  policy: { id: string; name: string; allowNegativeBalance: boolean; carryForwardMaxUnits: number; isActive: boolean };
  policyResolvedDate: string;
  periodStart: string;
  periodEnd: string;
  available: number;
  createdAt: string;
  updatedAt: string;
}
export interface LedgerEntryDto {
  id: string;
  entryType: string;
  units: number;
  referenceType: string | null;
  referenceId: string | null;
  note: string | null;
  actor: { id: string; email: string } | null;
  createdAt: string;
}
export interface EntitlementPreviewDto {
  policy: { id: string; name: string; annualUnits: number; allowNegativeBalance: boolean; carryForwardMaxUnits: number; effectiveFrom: string; effectiveTo: string | null };
  employee: { id: string; employeeCode: string; firstName: string; lastName: string; employmentType: string; organization: { id: string; name: string } };
  periodStart: string;
}
export interface LeaveEmployeeOptionDto {
  id: string;
  employeeCode: string;
  firstName: string;
  lastName: string;
  employmentType: string;
  organization: { id: string; code: string; name: string };
  department: { id: string; code: string; name: string };
}
export interface LeaveTypeOptionDto { id: string; code: string; name: string }
