import type { ReportFieldType, ReportOperator } from './enums';

/**
 * Pure report rules (Task 30). Which operators a field type accepts and the resource caps — nothing that runs a
 * query. The registry that says which fields exist lives in the API and is never user-editable.
 */
export const REPORT_LIMITS = { columns: 30, filters: 20, groupBy: 3, aggregations: 10, sort: 3, previewPageSize: 50, maxPageSize: 200, exportRows: 50_000, inValues: 50 } as const;

export const OPERATORS_BY_TYPE: Record<ReportFieldType, ReportOperator[]> = {
  STRING: ['EQ', 'NE', 'CONTAINS', 'STARTS_WITH', 'IS_NULL', 'IS_NOT_NULL'],
  NUMBER: ['EQ', 'NE', 'GT', 'GTE', 'LT', 'LTE', 'IS_NULL', 'IS_NOT_NULL'],
  DECIMAL: ['EQ', 'NE', 'GT', 'GTE', 'LT', 'LTE', 'IS_NULL', 'IS_NOT_NULL'],
  DATE: ['EQ', 'BEFORE', 'AFTER', 'BETWEEN', 'IS_NULL', 'IS_NOT_NULL'],
  DATETIME: ['BEFORE', 'AFTER', 'BETWEEN', 'IS_NULL', 'IS_NOT_NULL'],
  BOOLEAN: ['EQ', 'IS_NULL', 'IS_NOT_NULL'],
  ENUM: ['EQ', 'NE', 'IN', 'IS_NULL', 'IS_NOT_NULL'],
};

/** Every cell quoted; a leading formula character gets an apostrophe so a spreadsheet never executes a value. */
export function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  const guarded = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${guarded.replace(/"/g, '""')}"`;
}
export const csvLine = (cells: unknown[]) => cells.map(csvCell).join(',');

/** A saved report's file name: letters, digits, dash, underscore, bounded. */
export const reportFileName = (name: string) => `${(name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'report').slice(0, 60)}.csv`;
