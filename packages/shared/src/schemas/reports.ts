import { z } from 'zod';
import { REPORT_AGGREGATIONS, REPORT_FIELD_SENSITIVITIES, REPORT_FIELD_TYPES, REPORT_OPERATORS, REPORT_VISIBILITIES } from '../enums';
import { REPORT_LIMITS } from '../reports';

/**
 * Report center contracts (Task 30). A definition names fields of a server-owned dataset by id and never contains
 * a query: the schema is strict, so `sql`, `where`, `table`, `join` or anything unknown is rejected outright.
 */
const fieldId = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,60}$/);
const filterValue = z.union([z.string().max(500), z.number(), z.boolean(), z.array(z.string().max(200)).max(REPORT_LIMITS.inValues), z.null()]);

export const reportDefinitionSchema = z.object({
  columns: z.array(fieldId).min(1).max(REPORT_LIMITS.columns),
  filters: z.array(z.object({ fieldId, operator: z.enum(REPORT_OPERATORS), value: filterValue.optional() }).strict()).max(REPORT_LIMITS.filters).default([]),
  sort: z.array(z.object({ fieldId, direction: z.enum(['ASC', 'DESC']) }).strict()).max(REPORT_LIMITS.sort).default([]),
  groupBy: z.array(fieldId).max(REPORT_LIMITS.groupBy).default([]),
  aggregations: z.array(z.object({ fieldId, function: z.enum(REPORT_AGGREGATIONS), alias: z.string().trim().min(1).max(60).optional() }).strict()).max(REPORT_LIMITS.aggregations).default([]),
  pageSize: z.number().int().min(1).max(REPORT_LIMITS.maxPageSize).default(REPORT_LIMITS.previewPageSize),
}).strict();
export type ReportDefinition = z.infer<typeof reportDefinitionSchema>;

export const runReportSchema = z.object({ datasetId: z.string().min(1).max(60), definition: reportDefinitionSchema, page: z.number().int().min(1).max(10_000).default(1) }).strict();
export type RunReportInput = z.infer<typeof runReportSchema>;

export const createSavedReportSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1000).nullable().optional(),
  datasetId: z.string().min(1).max(60),
  visibility: z.enum(REPORT_VISIBILITIES).default('PRIVATE'),
  definition: reportDefinitionSchema,
}).strict();
export type CreateSavedReportInput = z.infer<typeof createSavedReportSchema>;
export const updateSavedReportSchema = createSavedReportSchema.omit({ datasetId: true }).partial().strict().refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type UpdateSavedReportInput = z.infer<typeof updateSavedReportSchema>;

export interface ReportFieldDto {
  id: string; label: string; type: (typeof REPORT_FIELD_TYPES)[number]; sensitivity: (typeof REPORT_FIELD_SENSITIVITIES)[number];
  selectable: boolean; filterable: boolean; sortable: boolean; groupable: boolean; aggregatable: boolean;
  options?: { value: string; label: string }[];
}
export interface ReportDatasetDto {
  id: string; name: string; description: string; aggregateOnly: boolean;
  /** For high-volume datasets: a date-range filter on this field is required and limited to this many months. */
  requiredDateRange: { fieldId: string; maxMonths: number } | null;
  fields: ReportFieldDto[];
}
export interface ReportRunResultDto {
  datasetId: string;
  columns: { id: string; label: string; type: string }[];
  rows: Record<string, string | number | boolean | null>[];
  meta: { page: number; pageSize: number; total: number; grouped: boolean };
}
export interface SavedReportDto {
  id: string; name: string; description: string | null; datasetId: string; datasetName: string;
  owner: { userId: string; name: string | null }; isOwner: boolean;
  visibility: (typeof REPORT_VISIBILITIES)[number]; definition: ReportDefinition;
  can: { edit: boolean; share: boolean; delete: boolean };
  createdAt: string; updatedAt: string;
}
export interface ReportTemplateDto { id: string; name: string; description: string; datasetId: string; definition: ReportDefinition }
