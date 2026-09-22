import { z } from 'zod';
import { paginationQuerySchema } from './common';
import { timezoneSchema } from './calendar';

/** Codes are trimmed + upper-cased; letters, digits, dash, underscore, dot. */
const codeField = z.string().trim().toUpperCase().min(1, 'Code is required').max(30).regex(/^[A-Z0-9][A-Z0-9._-]*$/, 'Use letters, numbers, dot, dash or underscore');
const nameField = z.string().trim().min(1, 'Name is required').max(120);
const statusFilter = z.enum(['active', 'inactive']).optional();
const sortDir = z.enum(['asc', 'desc']).default('asc');
const nonEmpty = <T extends z.ZodRawShape>(shape: T) => z.object(shape).refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });

// ---------- Organizations ----------
export const createOrganizationSchema = z.object({ code: codeField, name: nameField });
export const updateOrganizationSchema = nonEmpty({ code: codeField.optional(), name: nameField.optional(), timezone: timezoneSchema.optional() });
export const organizationListQuerySchema = paginationQuerySchema.extend({
  status: statusFilter,
  sortBy: z.enum(['code', 'name', 'createdAt']).default('code'),
  sortDir,
});
export type CreateOrganizationInput = z.infer<typeof createOrganizationSchema>;
export type UpdateOrganizationInput = z.infer<typeof updateOrganizationSchema>;
export type OrganizationListQuery = z.infer<typeof organizationListQuerySchema>;

export interface OrganizationDto {
  id: string;
  code: string;
  name: string;
  /** IANA timezone — the source of truth for "today" in this organization (Phase 2 calendars). */
  timezone: string;
  defaultCalendar: { id: string; code: string; name: string } | null;
  isActive: boolean;
  departmentCount: number;
  employeeCount: number;
  createdAt: string;
  updatedAt: string;
}

// ---------- Departments ----------
export const createDepartmentSchema = z.object({
  organizationId: z.string().min(1, 'Organization is required'),
  parentId: z.string().min(1).nullable().optional(),
  code: codeField,
  name: nameField,
});
/** organizationId is immutable (positions/employees reference it); move departments via parentId. */
export const updateDepartmentSchema = nonEmpty({
  parentId: z.string().min(1).nullable().optional(),
  code: codeField.optional(),
  name: nameField.optional(),
});
export const departmentListQuerySchema = paginationQuerySchema.extend({
  organizationId: z.string().min(1).optional(),
  parentId: z.string().min(1).optional(),
  status: statusFilter,
  sortBy: z.enum(['code', 'name', 'createdAt']).default('code'),
  sortDir,
});
export type CreateDepartmentInput = z.infer<typeof createDepartmentSchema>;
export type UpdateDepartmentInput = z.infer<typeof updateDepartmentSchema>;
export type DepartmentListQuery = z.infer<typeof departmentListQuerySchema>;

export interface DepartmentDto {
  id: string;
  organizationId: string;
  organization: { id: string; code: string; name: string };
  parentId: string | null;
  parent: { id: string; code: string; name: string } | null;
  code: string;
  name: string;
  isActive: boolean;
  headEmployee: { id: string; employeeCode: string; firstName: string; lastName: string } | null;
  childCount: number;
  positionCount: number;
  employeeCount: number;
  createdAt: string;
  updatedAt: string;
}

// ---------- Jobs ----------
export const createJobSchema = z.object({
  code: codeField,
  title: nameField,
  level: z.coerce.number().int().min(1).max(99).default(1),
  description: z.string().trim().max(500).nullable().optional(),
});
export const updateJobSchema = nonEmpty({
  code: codeField.optional(),
  title: nameField.optional(),
  level: z.coerce.number().int().min(1).max(99).optional(),
  description: z.string().trim().max(500).nullable().optional(),
});
export const jobListQuerySchema = paginationQuerySchema.extend({
  status: statusFilter,
  sortBy: z.enum(['code', 'title', 'level', 'createdAt']).default('code'),
  sortDir,
});
export type CreateJobInput = z.infer<typeof createJobSchema>;
export type UpdateJobInput = z.infer<typeof updateJobSchema>;
export type JobListQuery = z.infer<typeof jobListQuerySchema>;

export interface JobDto {
  id: string;
  code: string;
  title: string;
  level: number;
  description: string | null;
  isActive: boolean;
  positionCount: number;
  createdAt: string;
  updatedAt: string;
}

// ---------- Positions ----------
export const createPositionSchema = z.object({
  departmentId: z.string().min(1, 'Department is required'),
  jobId: z.string().min(1, 'Job is required'),
  code: codeField,
  title: nameField,
});
export const updatePositionSchema = nonEmpty({
  departmentId: z.string().min(1).optional(),
  jobId: z.string().min(1).optional(),
  code: codeField.optional(),
  title: nameField.optional(),
});
export const positionListQuerySchema = paginationQuerySchema.extend({
  organizationId: z.string().min(1).optional(),
  departmentId: z.string().min(1).optional(),
  jobId: z.string().min(1).optional(),
  status: statusFilter,
  sortBy: z.enum(['code', 'title', 'createdAt']).default('code'),
  sortDir,
});
export type CreatePositionInput = z.infer<typeof createPositionSchema>;
export type UpdatePositionInput = z.infer<typeof updatePositionSchema>;
export type PositionListQuery = z.infer<typeof positionListQuerySchema>;

export interface PositionDto {
  id: string;
  code: string;
  title: string;
  isActive: boolean;
  department: { id: string; code: string; name: string; organization: { id: string; code: string; name: string } };
  job: { id: string; code: string; title: string; level: number } | null;
  employeeCount: number;
  createdAt: string;
  updatedAt: string;
}

// ---------- Tree ----------
export const organizationTreeQuerySchema = z.object({
  organizationId: z.string().min(1).optional(),
  /** Default: active nodes only. `true` includes inactive organizations/departments/positions (flagged by isActive). */
  includeInactive: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
});

export interface TreePosition {
  id: string;
  code: string;
  title: string;
  isActive: boolean;
  job: { id: string; code: string; title: string } | null;
}
export interface TreeDepartment {
  id: string;
  code: string;
  name: string;
  isActive: boolean;
  parentId: string | null;
  children: TreeDepartment[];
  positions: TreePosition[];
}
export interface TreeOrganization {
  id: string;
  code: string;
  name: string;
  isActive: boolean;
  departments: TreeDepartment[];
}
