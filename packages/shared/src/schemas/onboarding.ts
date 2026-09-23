import { z } from 'zod';
import { EMPLOYMENT_TYPES } from '../enums';
import { paginationQuerySchema } from './common';

/**
 * Customer onboarding workbook contract — shared by the template generator, the parser and the UI so all three agree
 * on sheet names, headers and order. Bump TEMPLATE_VERSION whenever a column's meaning changes; the parser refuses a
 * workbook whose version it does not know rather than guessing what a column means.
 */
export const ONBOARDING_TEMPLATE_VERSION = 1;
export const ONBOARDING_META_SHEET = '_Onboarding';

export const ONBOARDING_LIMITS = {
  maxFileBytes: 10 * 1024 * 1024,
  maxTotalRows: 5000,
} as const;

export const ONBOARDING_SHEETS = {
  organizations: 'Organizations',
  departments: 'Departments',
  jobs: 'Jobs',
  positions: 'Positions',
  employees: 'Employees',
} as const;
export type OnboardingSheet = (typeof ONBOARDING_SHEETS)[keyof typeof ONBOARDING_SHEETS];
/** Import (and validation) order: a sheet may only reference sheets before it, or existing database rows. */
export const ONBOARDING_SHEET_ORDER: OnboardingSheet[] = [
  ONBOARDING_SHEETS.organizations, ONBOARDING_SHEETS.departments, ONBOARDING_SHEETS.jobs, ONBOARDING_SHEETS.positions, ONBOARDING_SHEETS.employees,
];

export interface ColumnSpec {
  header: string;
  required: boolean;
  /** Excel cell format: codes stay text so leading zeros survive; dates are typed as text in YYYY-MM-DD. */
  kind: 'code' | 'text' | 'date' | 'number' | 'enum';
  enumValues?: readonly string[];
  note: string;
}

export const ONBOARDING_COLUMNS: Record<OnboardingSheet, ColumnSpec[]> = {
  [ONBOARDING_SHEETS.organizations]: [
    { header: 'organizationCode', required: true, kind: 'code', note: 'Unique. Letters, numbers, dot, dash, underscore. Stored uppercase.' },
    { header: 'name', required: true, kind: 'text', note: 'Company or entity name.' },
    { header: 'timezone', required: false, kind: 'text', note: 'IANA name, e.g. Asia/Bangkok. Defaults to Asia/Bangkok.' },
  ],
  [ONBOARDING_SHEETS.departments]: [
    { header: 'organizationCode', required: true, kind: 'code', note: 'Must exist in this workbook or already in the system.' },
    { header: 'departmentCode', required: true, kind: 'code', note: 'Unique within its organization.' },
    { header: 'name', required: true, kind: 'text', note: 'Department name.' },
    { header: 'parentDepartmentCode', required: false, kind: 'code', note: 'Parent department in the SAME organization. May appear later in this sheet.' },
    { header: 'headEmployeeCode', required: false, kind: 'code', note: 'Employee who heads this department. Assigned after employees are created.' },
  ],
  [ONBOARDING_SHEETS.jobs]: [
    { header: 'jobCode', required: true, kind: 'code', note: 'Unique across the whole system.' },
    { header: 'title', required: true, kind: 'text', note: 'Job title.' },
    { header: 'level', required: false, kind: 'number', note: 'Whole number 1–99. Defaults to 1.' },
    { header: 'description', required: false, kind: 'text', note: 'Optional, up to 500 characters.' },
  ],
  [ONBOARDING_SHEETS.positions]: [
    { header: 'positionCode', required: true, kind: 'code', note: 'Unique across the whole system.' },
    { header: 'title', required: true, kind: 'text', note: 'Position title.' },
    { header: 'organizationCode', required: true, kind: 'code', note: 'Must match the department’s organization.' },
    { header: 'departmentCode', required: true, kind: 'code', note: 'Department this position belongs to.' },
    { header: 'jobCode', required: true, kind: 'code', note: 'Job this position is based on.' },
  ],
  [ONBOARDING_SHEETS.employees]: [
    { header: 'employeeCode', required: true, kind: 'code', note: 'Unique across the whole system.' },
    { header: 'firstName', required: true, kind: 'text', note: '' },
    { header: 'lastName', required: true, kind: 'text', note: '' },
    { header: 'nickname', required: false, kind: 'text', note: '' },
    { header: 'email', required: true, kind: 'text', note: 'Unique. Creating an employee does NOT create a login account.' },
    { header: 'phone', required: false, kind: 'text', note: '' },
    { header: 'hireDate', required: true, kind: 'date', note: 'YYYY-MM-DD. Also the start date of the first position/manager history.' },
    { header: 'employmentType', required: false, kind: 'enum', enumValues: EMPLOYMENT_TYPES, note: `One of ${EMPLOYMENT_TYPES.join(', ')}. Defaults to FULL_TIME.` },
    { header: 'positionCode', required: true, kind: 'code', note: 'Department and organization are derived from the position.' },
    { header: 'managerEmployeeCode', required: false, kind: 'code', note: 'May reference an employee later in this sheet, or an existing employee.' },
  ],
};

// ---------- API contract ----------
export interface OnboardingIssue {
  sheet: string;
  /** 1-based row as shown in Excel (header is row 1); 0 for whole-sheet or workbook issues. */
  row: number;
  field?: string;
  code: string;
  message: string;
}
export interface OnboardingCounts {
  organizations: number;
  departments: number;
  jobs: number;
  positions: number;
  employees: number;
}
export interface OnboardingPreviewDto {
  file: { name: string; sha256: string; sizeBytes: number; templateVersion: number };
  summary: OnboardingCounts;
  valid: boolean;
  errors: OnboardingIssue[];
  warnings: OnboardingIssue[];
}
export interface OnboardingImportRunDto {
  id: string;
  fileName: string;
  fileHash: string;
  templateVersion: number;
  counts: OnboardingCounts;
  createdBy: { id: string; email: string } | null;
  createdAt: string;
  /** True when this response replayed an earlier identical import instead of creating anything. */
  replayed?: boolean;
}

export const onboardingCommitSchema = z.object({ expectedSha256: z.string().regex(/^[0-9a-f]{64}$/, 'expectedSha256 must be a SHA-256 hex digest') });
export const onboardingImportListQuerySchema = paginationQuerySchema.omit({ search: true });
export type OnboardingImportListQuery = z.infer<typeof onboardingImportListQuerySchema>;
