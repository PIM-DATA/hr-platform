import { z } from 'zod';
import {
  PAYROLL_ITEM_SOURCES, PAYROLL_PERIOD_STATUSES, PAYROLL_RUN_STATUSES, PAY_COMPONENT_CALCULATION_TYPES,
  PAY_COMPONENT_TYPES, PAY_FREQUENCIES, PRORATION_BASES,
} from '../enums';
import { isBusinessDate } from '../business-date';
import { paginationQuerySchema } from './common';

/**
 * Payroll contracts (Task 22).
 *
 * **Money crosses the wire as a decimal string**, never as a JSON number. `30000.00` stays `"30000.00"`: a float would
 * be an accurate-looking approximation, and payroll is the one place where that is not survivable. The database stores
 * `NUMERIC`, the API works in `Prisma.Decimal`, and the UI formats strings.
 *
 * This release does **not** calculate statutory amounts — withholding tax, social security and provident fund are
 * absent, not approximated.
 */
const businessDate = z.string().refine(isBusinessDate, 'Use a real date in YYYY-MM-DD format');
/** A positive decimal amount with at most two decimal places, as a string. */
const moneyField = z
  .string()
  .trim()
  .regex(/^\d{1,13}(\.\d{1,2})?$/, 'Use an amount like 30000 or 1250.50 (at most two decimal places)');
const currencyField = z.string().trim().length(3).regex(/^[A-Z]{3}$/, 'Use a three-letter currency code, e.g. THB').default('THB');
const codeField = z.string().trim().min(1).max(40).regex(/^[A-Z][A-Z0-9_]*$/, 'Use upper-case letters, digits and underscore, starting with a letter');

// ---------- compensation ----------
export const createCompensationSchema = z
  .object({
    employeeId: z.string().min(1),
    effectiveFrom: businessDate,
    effectiveTo: businessDate.nullable().optional(),
    salaryType: z.enum(PAY_FREQUENCIES).default('MONTHLY'),
    baseSalary: moneyField,
    currencyCode: currencyField,
    note: z.string().trim().max(300).nullable().optional(),
  })
  .refine((v) => !v.effectiveTo || v.effectiveTo >= v.effectiveFrom, { message: 'effectiveTo must be on or after effectiveFrom', path: ['effectiveTo'] });
export type CreateCompensationInput = z.infer<typeof createCompensationSchema>;

/**
 * A salary change is a **new record**, not an edit: the old one is closed with an end date. Only the end date and the
 * note can be changed here, so a payroll run that already used a salary can never be re-priced by editing it.
 */
export const updateCompensationSchema = z
  .object({
    effectiveTo: businessDate.nullable().optional(),
    note: z.string().trim().max(300).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type UpdateCompensationInput = z.infer<typeof updateCompensationSchema>;

export const compensationListQuerySchema = paginationQuerySchema.extend({
  employeeId: z.string().min(1).optional(),
  asOfDate: businessDate.optional(),
});
export type CompensationListQuery = z.infer<typeof compensationListQuerySchema>;

export interface CompensationDto {
  id: string;
  employee: { id: string; employeeCode: string; firstName: string; lastName: string; department: { id: string; name: string } | null };
  effectiveFrom: string;
  effectiveTo: string | null;
  salaryType: string;
  /** Decimal string. */
  baseSalary: string;
  currencyCode: string;
  note: string | null;
  /** True once a payroll result has been calculated from this record. */
  inUse: boolean;
  createdAt: string;
  createdBy: { id: string; email: string } | null;
}

// ---------- pay components ----------
export const createPayComponentSchema = z.object({
  code: codeField,
  name: z.string().trim().min(1).max(100),
  type: z.enum(PAY_COMPONENT_TYPES),
  calculationType: z.enum(PAY_COMPONENT_CALCULATION_TYPES).default('FIXED'),
  /** Metadata for a future statutory engine. Nothing in this release reads it to calculate anything. */
  taxable: z.boolean().default(true),
  recurringAllowed: z.boolean().default(true),
  description: z.string().trim().max(300).nullable().optional(),
});
export type CreatePayComponentInput = z.infer<typeof createPayComponentSchema>;

export const updatePayComponentSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    taxable: z.boolean().optional(),
    recurringAllowed: z.boolean().optional(),
    description: z.string().trim().max(300).nullable().optional(),
    isActive: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type UpdatePayComponentInput = z.infer<typeof updatePayComponentSchema>;

export const payComponentListQuerySchema = paginationQuerySchema.extend({
  type: z.enum(PAY_COMPONENT_TYPES).optional(),
  status: z.enum(['active', 'inactive']).optional(),
});
export type PayComponentListQuery = z.infer<typeof payComponentListQuerySchema>;

export interface PayComponentDto {
  id: string;
  code: string;
  name: string;
  type: (typeof PAY_COMPONENT_TYPES)[number];
  calculationType: (typeof PAY_COMPONENT_CALCULATION_TYPES)[number];
  taxable: boolean;
  recurringAllowed: boolean;
  description: string | null;
  /** System components are written by the engine: they cannot be deleted or have their meaning changed. */
  isSystem: boolean;
  isActive: boolean;
}

// ---------- recurring pay items ----------
export const createPayItemSchema = z
  .object({
    employeeId: z.string().min(1),
    componentId: z.string().min(1),
    amount: moneyField,
    effectiveFrom: businessDate,
    effectiveTo: businessDate.nullable().optional(),
    note: z.string().trim().max(300).nullable().optional(),
  })
  .refine((v) => !v.effectiveTo || v.effectiveTo >= v.effectiveFrom, { message: 'effectiveTo must be on or after effectiveFrom', path: ['effectiveTo'] });
export type CreatePayItemInput = z.infer<typeof createPayItemSchema>;

export const updatePayItemSchema = z
  .object({
    amount: moneyField.optional(),
    effectiveTo: businessDate.nullable().optional(),
    note: z.string().trim().max(300).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type UpdatePayItemInput = z.infer<typeof updatePayItemSchema>;

export const payItemListQuerySchema = paginationQuerySchema.extend({
  employeeId: z.string().min(1).optional(),
  componentId: z.string().min(1).optional(),
  asOfDate: businessDate.optional(),
});
export type PayItemListQuery = z.infer<typeof payItemListQuerySchema>;

export interface PayItemDto {
  id: string;
  employee: { id: string; employeeCode: string; firstName: string; lastName: string };
  component: { id: string; code: string; name: string; type: string };
  amount: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  note: string | null;
}

// ---------- payroll policy ----------
export const createPayrollPolicySchema = z
  .object({
    organizationId: z.string().min(1),
    name: z.string().trim().min(1).max(100),
    /** Days a monthly salary is divided by to get a daily rate. A customer decision — nothing assumes 30 or 26. */
    monthlyDivisorDays: z.number().positive().max(31),
    dailyWorkHours: z.number().positive().max(24),
    newHireProration: z.enum(PRORATION_BASES).default('CALENDAR_DAYS'),
    terminationProration: z.enum(PRORATION_BASES).default('CALENDAR_DAYS'),
    absenceDeductionEnabled: z.boolean().default(true),
    lateDeductionEnabled: z.boolean().default(false),
    workflowDefinitionCode: z.string().trim().min(1).max(50),
    effectiveFrom: businessDate,
    effectiveTo: businessDate.nullable().optional(),
    currencyCode: currencyField,
  })
  .refine((v) => !v.effectiveTo || v.effectiveTo >= v.effectiveFrom, { message: 'effectiveTo must be on or after effectiveFrom', path: ['effectiveTo'] });
export type CreatePayrollPolicyInput = z.infer<typeof createPayrollPolicySchema>;

export const updatePayrollPolicySchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    monthlyDivisorDays: z.number().positive().max(31).optional(),
    dailyWorkHours: z.number().positive().max(24).optional(),
    newHireProration: z.enum(PRORATION_BASES).optional(),
    terminationProration: z.enum(PRORATION_BASES).optional(),
    absenceDeductionEnabled: z.boolean().optional(),
    lateDeductionEnabled: z.boolean().optional(),
    workflowDefinitionCode: z.string().trim().min(1).max(50).optional(),
    effectiveTo: businessDate.nullable().optional(),
    isActive: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type UpdatePayrollPolicyInput = z.infer<typeof updatePayrollPolicySchema>;

export interface PayrollPolicyDto {
  id: string;
  organization: { id: string; code: string; name: string } | null;
  name: string;
  monthlyDivisorDays: string;
  dailyWorkHours: string;
  newHireProration: (typeof PRORATION_BASES)[number];
  terminationProration: (typeof PRORATION_BASES)[number];
  absenceDeductionEnabled: boolean;
  lateDeductionEnabled: boolean;
  workflowDefinitionCode: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  currencyCode: string;
  isActive: boolean;
}

// ---------- period ----------
export const createPayrollPeriodSchema = z
  .object({
    organizationId: z.string().min(1),
    year: z.number().int().min(2000).max(2100),
    month: z.number().int().min(1).max(12),
    periodStart: businessDate,
    periodEnd: businessDate,
    /** The attendance window, which need not be the salary month — a cut-off on the 20th is normal. */
    attendanceFrom: businessDate,
    attendanceTo: businessDate,
    paymentDate: businessDate.nullable().optional(),
  })
  .refine((v) => v.periodStart <= v.periodEnd, { message: 'periodEnd must be on or after periodStart', path: ['periodEnd'] })
  .refine((v) => v.attendanceFrom <= v.attendanceTo, { message: 'attendanceTo must be on or after attendanceFrom', path: ['attendanceTo'] });
export type CreatePayrollPeriodInput = z.infer<typeof createPayrollPeriodSchema>;

export const updatePayrollPeriodSchema = z
  .object({
    periodStart: businessDate.optional(),
    periodEnd: businessDate.optional(),
    attendanceFrom: businessDate.optional(),
    attendanceTo: businessDate.optional(),
    paymentDate: businessDate.nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type UpdatePayrollPeriodInput = z.infer<typeof updatePayrollPeriodSchema>;

export const payrollPeriodListQuerySchema = paginationQuerySchema.omit({ search: true }).extend({
  organizationId: z.string().min(1).optional(),
  year: z.coerce.number().int().min(2000).max(2100).optional(),
  status: z.enum(PAYROLL_PERIOD_STATUSES).optional(),
});
export type PayrollPeriodListQuery = z.infer<typeof payrollPeriodListQuerySchema>;

export interface PayrollPeriodDto {
  id: string;
  organization: { id: string; code: string; name: string } | null;
  year: number;
  month: number;
  label: string;
  periodStart: string;
  periodEnd: string;
  attendanceFrom: string;
  attendanceTo: string;
  paymentDate: string | null;
  status: (typeof PAYROLL_PERIOD_STATUSES)[number];
  currencyCode: string;
  run: PayrollRunSummaryDto | null;
}

// ---------- run ----------
export interface PayrollRunSummaryDto {
  id: string;
  periodId: string;
  version: number;
  status: (typeof PAYROLL_RUN_STATUSES)[number];
  employeeCount: number;
  grossTotal: string;
  deductionTotal: string;
  netTotal: string;
  currencyCode: string;
  calculatedAt: string | null;
  approvedAt: string | null;
  closedAt: string | null;
  workflowInstanceId: string | null;
  /** False when a source (attendance, leave, overtime, salary) changed after the run was calculated. */
  inputsCurrent: boolean;
}

export interface PayrollResultItemDto {
  id: string;
  componentCode: string;
  componentName: string;
  type: (typeof PAY_COMPONENT_TYPES)[number];
  source: (typeof PAYROLL_ITEM_SOURCES)[number];
  quantity: string | null;
  rate: string | null;
  multiplier: string | null;
  amount: string;
  description: string | null;
  /** What produced this line, so a payslip can explain itself: an overtime request, a leave request, a day, an item. */
  referenceType: string | null;
  referenceId: string | null;
  isManual: boolean;
  /** Task 48: a reimbursement handed over by benefits or expense — immutable in payroll (never removable here). */
  sourceLinked: boolean;
}

export interface PayrollResultDto {
  id: string;
  employee: { id: string; employeeCode: string; firstName: string; lastName: string; department: { id: string; name: string } | null };
  baseSalary: string;
  grossPay: string;
  totalDeductions: string;
  netPay: string;
  currencyCode: string;
  /** The attendance the money was derived from, frozen at calculation. */
  inputs: { absentDays: string; lateMinutes: number; unpaidLeaveUnits: string; approvedOtMinutes: number; proratedDays: string | null };
  items: PayrollResultItemDto[];
}

export const payrollResultListQuerySchema = paginationQuerySchema.extend({
  departmentId: z.string().min(1).optional(),
});
export type PayrollResultListQuery = z.infer<typeof payrollResultListQuerySchema>;

export const addPayrollAdjustmentSchema = z.object({
  componentId: z.string().min(1),
  amount: moneyField,
  /** Required: an adjustment without a reason is unexplainable three months later. */
  note: z.string().trim().min(3, 'Say why this adjustment exists').max(300),
});
export type AddPayrollAdjustmentInput = z.infer<typeof addPayrollAdjustmentSchema>;

/** The per-run arithmetic check that must pass before a run can be approved. */
export interface PayrollReconciliationDto {
  ok: boolean;
  runId: string;
  employeeCount: number;
  grossTotal: string;
  deductionTotal: string;
  netTotal: string;
  /** Every mismatch found, as plain sentences. Empty when the run reconciles. */
  problems: string[];
  negativeNetEmployees: { employeeCode: string; netPay: string }[];
  inputsCurrent: boolean;
}

// ---------- payslip ----------
export interface PayslipDto {
  id: string;
  period: { id: string; label: string; periodStart: string; periodEnd: string; paymentDate: string | null };
  employee: { employeeCode: string; firstName: string; lastName: string; department: string | null; position: string | null };
  baseSalary: string;
  grossPay: string;
  totalDeductions: string;
  netPay: string;
  currencyCode: string;
  earnings: PayrollResultItemDto[];
  deductions: PayrollResultItemDto[];
  /** Stated on every payslip: this release calculates no statutory amounts. */
  notice: string;
}

// ---------- reporting ----------
export interface PayrollSummaryDto {
  runId: string;
  periodLabel: string;
  currencyCode: string;
  employeeCount: number;
  grossTotal: string;
  deductionTotal: string;
  netTotal: string;
  byComponent: { componentCode: string; componentName: string; type: (typeof PAY_COMPONENT_TYPES)[number]; amount: string; employees: number }[];
  byDepartment: { departmentId: string | null; departmentName: string; employees: number; grossTotal: string; netTotal: string }[];
}
