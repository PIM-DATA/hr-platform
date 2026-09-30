import type { ReportDefinition, ReportFieldDto, ReportFieldType, ReportOperator } from '@hr/shared';
import { OPERATORS_BY_TYPE, REPORT_LIMITS } from '@hr/shared';
import { AppError } from '../../lib/errors';
import type { AuthContext } from '../auth/auth.types';

/**
 * The report dataset registry — server-owned, code-level, never editable through the API.
 *
 * A report names a dataset id and field ids from this registry; the dataset's own runner turns the validated
 * definition into a bounded query against the module it belongs to, applying that module's row scope. There is
 * no table name, column name, SQL fragment or join anywhere in a request, and nothing here can reach a model the
 * dataset did not choose.
 */
export interface FieldDef extends ReportFieldDto { requiredPermission?: string }
export type Row = Record<string, string | number | boolean | null>;
export interface RunContext { auth: AuthContext; definition: ReportDefinition; page: number; pageSize: number }
/** Rows withheld by the small-group rule (Task 47). Present only when something was withheld. */
export interface RunSuppression { suppressedGroups: number; minimumGroupSize: number; reason: string }
export interface RunResult { rows: Row[]; total: number; suppression?: RunSuppression | null }
/**
 * How an aggregate-only dataset relates to people (Task 47, T44-P1-07). Required for every `aggregateOnly` dataset:
 *  - PERSON_ROWS: each loaded row belongs to one person (a claim, a case, a plan…) and carries a hidden `__subject`.
 *    The report must aggregate (no row listing); a group describing fewer than K distinct people is withheld, the
 *    withheld groups are complemented until they describe none or ≥ K people, and a filter that leaves out fewer than
 *    K people withholds the whole result (otherwise "unfiltered − filtered" is those people).
 *  - PRE_AGGREGATED: each row already describes `populationField` people (a payroll run, a salary-review cycle); rows
 *    describing fewer than K people are withheld.
 *  - SOURCE_SUPPRESSED: the source module applies its own anonymity rule (engagement's survey threshold + differencing).
 *  - NON_PERSONAL: plans and structures, no outcome about a person (headcount plans, org-design scenarios, headcounts).
 */
export type DatasetPrivacy =
  | { kind: 'PERSON_ROWS' }
  | { kind: 'PRE_AGGREGATED'; populationField: string }
  | { kind: 'SOURCE_SUPPRESSED'; note: string }
  | { kind: 'NON_PERSONAL'; note: string };
export interface ReportDataset {
  id: string;
  name: string;
  description: string;
  /** Any of these opens the dataset; individual-row datasets also need reports.view_individual. */
  requiredPermissions: string[];
  /** Rows are pre-aggregated (no person in any row), so a viewer limited to aggregate datasets may use it. */
  aggregateOnly: boolean;
  requiredDateRange: { fieldId: string; maxMonths: number } | null;
  /** Required when aggregateOnly (checked by a test). */
  privacy?: DatasetPrivacy;
  fields: FieldDef[];
  run(ctx: RunContext): Promise<RunResult>;
  /** Export path: every row up to the cap, in definition order. */
  runAll(ctx: Omit<RunContext, 'page' | 'pageSize'>, cap: number): Promise<RunResult>;
}

const registry = new Map<string, ReportDataset>();
export const registerDataset = (d: ReportDataset) => { registry.set(d.id, d); return d; };
export const listDatasets = () => [...registry.values()];
export const getDataset = (id: string) => registry.get(id) ?? null;

/** Every reference in a definition must resolve to a field the dataset offers and the caller may see. */
export function validateDefinition(dataset: ReportDataset, def: ReportDefinition, visible: FieldDef[]): void {
  const byId = new Map(visible.map((f) => [f.id, f]));
  const field = (id: string, what: string) => { const f = byId.get(id); if (!f) throw new AppError(422, 'REPORT_FIELD_UNKNOWN', `Unknown ${what} field "${id}" for dataset ${dataset.id}`); return f; };
  // In a grouped report the columns are the group fields, which need not be selectable as plain row columns.
  for (const c of def.columns) { const f = field(c, 'column'); if (!f.selectable && !def.groupBy.includes(c)) throw new AppError(422, 'REPORT_FIELD_NOT_SELECTABLE', `"${f.label}" cannot be a column`); }
  for (const flt of def.filters) {
    const f = field(flt.fieldId, 'filter');
    if (!f.filterable) throw new AppError(422, 'REPORT_FILTER_NOT_ALLOWED', `"${f.label}" cannot be filtered`);
    if (!OPERATORS_BY_TYPE[f.type].includes(flt.operator)) throw new AppError(422, 'REPORT_OPERATOR_NOT_ALLOWED', `${flt.operator} is not valid for ${f.type.toLowerCase()} "${f.label}"`);
    validateFilterValue(f, flt.operator, flt.value);
  }
  for (const s of def.sort) { const f = field(s.fieldId, 'sort'); if (!f.sortable) throw new AppError(422, 'REPORT_SORT_NOT_ALLOWED', `"${f.label}" cannot be sorted`); }
  for (const g of def.groupBy) { const f = field(g, 'group'); if (!f.groupable) throw new AppError(422, 'REPORT_GROUP_NOT_ALLOWED', `"${f.label}" cannot be grouped`); }
  for (const a of def.aggregations) {
    const f = field(a.fieldId, 'aggregation');
    if (!f.aggregatable && !(a.function === 'COUNT' || a.function === 'COUNT_DISTINCT')) throw new AppError(422, 'REPORT_AGGREGATION_NOT_ALLOWED', `"${f.label}" cannot be aggregated with ${a.function}`);
    if ((a.function === 'SUM' || a.function === 'AVG') && !['NUMBER', 'DECIMAL'].includes(f.type)) throw new AppError(422, 'REPORT_AGGREGATION_NOT_ALLOWED', `${a.function} needs a numeric field`);
    // Money in several currencies is never added: the currency must be a group key, or the report filtered to one currency.
    if (f.currencyField && a.function !== 'COUNT' && a.function !== 'COUNT_DISTINCT' && !def.groupBy.includes(f.currencyField) && !def.filters.some((x) => x.fieldId === f.currencyField && x.operator === 'EQ')) {
      throw new AppError(422, 'REPORT_CURRENCY_GROUP_REQUIRED', `"${f.label}" is money: group by currency or filter to one currency before ${a.function}`);
    }
  }
  if (def.groupBy.length && def.aggregations.length === 0) throw new AppError(422, 'REPORT_AGGREGATION_REQUIRED', 'A grouped report needs at least one aggregation');
  if (dataset.privacy?.kind === 'PERSON_ROWS' && def.aggregations.length === 0) throw new AppError(422, 'REPORT_AGGREGATION_REQUIRED', `${dataset.name} is aggregate-only: group it and add at least one aggregation (rows about single people are not listed)`);
  if (def.groupBy.length && def.columns.some((c) => !def.groupBy.includes(c))) throw new AppError(422, 'REPORT_COLUMNS_MUST_BE_GROUPED', 'In a grouped report every column must be a group field; other values come from aggregations');
  if (def.aggregations.length && !def.groupBy.length && def.columns.length) throw new AppError(422, 'REPORT_COLUMNS_MUST_BE_GROUPED', 'An ungrouped aggregation cannot also list row columns');
  if (dataset.requiredDateRange) {
    const { fieldId, maxMonths } = dataset.requiredDateRange;
    const between = def.filters.find((x) => x.fieldId === fieldId && x.operator === 'BETWEEN');
    if (!between || !Array.isArray(between.value) || between.value.length !== 2) throw new AppError(422, 'REPORT_DATE_RANGE_REQUIRED', `${dataset.name} needs a BETWEEN filter on "${fieldId}" (at most ${maxMonths} months)`);
    const [from, to] = between.value as [string, string];
    const months = (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 + (Number(to.slice(5, 7)) - Number(from.slice(5, 7))) + 1;
    if (months > maxMonths) throw new AppError(422, 'REPORT_DATE_RANGE_TOO_LARGE', `${dataset.name} is limited to ${maxMonths} months per report`);
  }
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
function validateFilterValue(f: FieldDef, op: ReportOperator, value: unknown) {
  if (op === 'IS_NULL' || op === 'IS_NOT_NULL') return;
  const bad = (m: string) => { throw new AppError(422, 'REPORT_FILTER_VALUE_INVALID', `"${f.label}": ${m}`); };
  if (op === 'IN') { if (!Array.isArray(value) || !value.length) bad('IN needs a list of values'); if (f.options && (value as string[]).some((v) => !f.options!.some((o) => o.value === v))) bad('a value is not one of the allowed options'); return; }
  if (op === 'BETWEEN') { if (!Array.isArray(value) || value.length !== 2 || (value as unknown[]).some((v) => typeof v !== 'string' || !DATE.test(v))) bad('BETWEEN needs two dates'); return; }
  switch (f.type as ReportFieldType) {
    case 'STRING': if (typeof value !== 'string') bad('needs text'); break;
    case 'NUMBER': if (typeof value !== 'number' || !Number.isFinite(value)) bad('needs a number'); break;
    case 'DECIMAL': if (!(typeof value === 'number' && Number.isFinite(value)) && !(typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value))) bad('needs a decimal number'); break;
    case 'DATE': case 'DATETIME': if (typeof value !== 'string' || !DATE.test(value)) bad('needs a date YYYY-MM-DD'); break;
    case 'BOOLEAN': if (typeof value !== 'boolean') bad('needs true or false'); break;
    case 'ENUM': if (typeof value !== 'string') bad('needs a value'); if (f.options && !f.options.some((o) => o.value === value)) bad('not one of the allowed options'); break;
  }
}

export const LIMITS = REPORT_LIMITS;
