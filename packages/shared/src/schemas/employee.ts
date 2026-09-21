import { z } from 'zod';
import { paginationQuerySchema } from './common';
import { EMPLOYMENT_STATUSES, EMPLOYMENT_TYPES } from '../enums';

const codeField = z.string().trim().toUpperCase().min(1, 'Employee code is required').max(30).regex(/^[A-Z0-9][A-Z0-9._-]*$/, 'Use letters, numbers, dot, dash or underscore');
const nameField = z.string().trim().min(1, 'Required').max(80);
const emailField = z.string().trim().toLowerCase().email('Enter a valid email address').max(254);
const phoneField = z.string().trim().max(30).nullable().optional();
const nicknameField = z.string().trim().max(40).nullable().optional();
/** Dates arrive as ISO strings (YYYY-MM-DD or full ISO); stored as DateTime. */
const dateField = z.coerce.date();
const nonEmpty = <T extends z.ZodRawShape>(shape: T) => z.object(shape).refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });

// ---------- create ----------
export const createEmployeeSchema = z.object({
  employeeCode: codeField,
  firstName: nameField,
  lastName: nameField,
  nickname: nicknameField,
  email: emailField,
  phone: phoneField,
  hireDate: dateField,
  employmentType: z.enum(EMPLOYMENT_TYPES).default('FULL_TIME'),
  /** Position is the source of truth: department and organization are derived server-side. */
  positionId: z.string().min(1, 'Position is required'),
  managerId: z.string().min(1).nullable().optional(),
});
export type CreateEmployeeInput = z.infer<typeof createEmployeeSchema>;

// ---------- profile update (assignment fields are NOT accepted here; unknown keys are stripped) ----------
export const updateEmployeeProfileSchema = nonEmpty({
  employeeCode: codeField.optional(),
  firstName: nameField.optional(),
  lastName: nameField.optional(),
  nickname: nicknameField,
  email: emailField.optional(),
  phone: phoneField,
  hireDate: dateField.optional(),
  employmentType: z.enum(EMPLOYMENT_TYPES).optional(),
});
export type UpdateEmployeeProfileInput = z.infer<typeof updateEmployeeProfileSchema>;

// ---------- assignment ----------
export const changeEmployeePositionSchema = z.object({
  positionId: z.string().min(1, 'Position is required'),
  /** Defaults to now. Closes the previous history row at this instant and opens the new one. */
  effectiveDate: dateField.optional(),
});
export type ChangeEmployeePositionInput = z.infer<typeof changeEmployeePositionSchema>;

export const changeEmployeeManagerSchema = z.object({
  managerId: z.string().min(1).nullable(),
  effectiveDate: dateField.optional(),
});
export type ChangeEmployeeManagerInput = z.infer<typeof changeEmployeeManagerSchema>;

export const updateDepartmentHeadSchema = z.object({ employeeId: z.string().min(1).nullable() });
export type UpdateDepartmentHeadInput = z.infer<typeof updateDepartmentHeadSchema>;

// ---------- queries ----------
export const EMPLOYEE_SORT_FIELDS = ['employeeCode', 'firstName', 'lastName', 'hireDate', 'createdAt'] as const;
export const employeeListQuerySchema = paginationQuerySchema.extend({
  organizationId: z.string().min(1).optional(),
  departmentId: z.string().min(1).optional(),
  positionId: z.string().min(1).optional(),
  managerId: z.string().min(1).optional(),
  employmentType: z.enum(EMPLOYMENT_TYPES).optional(),
  employmentStatus: z.enum(EMPLOYMENT_STATUSES).optional(),
  sortBy: z.enum(EMPLOYEE_SORT_FIELDS).default('employeeCode'),
  sortDir: z.enum(['asc', 'desc']).default('asc'),
});
export type EmployeeListQuery = z.infer<typeof employeeListQuerySchema>;

/** Lightweight selector search (manager / department head pickers). Active employees only, max 20. */
export const employeeSelectorQuerySchema = z.object({
  search: z.string().trim().max(100).optional(),
  departmentId: z.string().min(1).optional(),
  excludeId: z.string().min(1).optional(),
});
export type EmployeeSelectorQuery = z.infer<typeof employeeSelectorQuerySchema>;

// ---------- DTOs ----------
export interface EmployeeRef { id: string; employeeCode: string; firstName: string; lastName: string }
export interface NamedRef { id: string; code: string; name: string }

export interface EmployeeListItem {
  id: string;
  employeeCode: string;
  firstName: string;
  lastName: string;
  nickname: string | null;
  email: string;
  employmentType: string;
  employmentStatus: string;
  hireDate: string;
  organization: NamedRef;
  department: NamedRef;
  position: { id: string; code: string; title: string };
  manager: EmployeeRef | null;
}

export interface EmployeeDetail extends EmployeeListItem {
  phone: string | null;
  terminationDate: string | null;
  createdAt: string;
  updatedAt: string;
  job: { id: string; code: string; title: string; level: number } | null;
  directReportCount: number;
  headOfDepartments: NamedRef[];
  /** Present only when the caller has users.view. */
  account?: { id: string; email: string; isActive: boolean; lastLoginAt: string | null } | null;
}

export interface PositionHistoryItem {
  id: string;
  position: { id: string; code: string; title: string };
  department: NamedRef;
  organization: NamedRef;
  startDate: string;
  endDate: string | null; // null = current
}

export interface ManagerHistoryItem {
  id: string;
  manager: EmployeeRef & { position: { id: string; title: string } | null };
  startDate: string;
  endDate: string | null; // null = current
}

export interface EmployeeSelectorOption extends EmployeeRef {
  position: { id: string; title: string };
  department: NamedRef;
}
