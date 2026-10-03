import { Prisma } from '@prisma/client';
import { MIN_AGGREGATE_GROUP_SIZE, addDays, businessDateOf, businessDayStart, partitionSuppression } from '@hr/shared';
import type { ReportDefinition } from '@hr/shared';
import { AppError } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { referenceZone } from '../../services/business-time/business-time';
import type { FieldDef, ReportDataset, Row, RunContext, RunResult } from './registry';

/**
 * A bounded runner for datasets that map onto one Prisma model.
 *
 * The dataset gives it a delegate (`prisma.employee`), a base `where` (the module's row scope, computed per caller),
 * and for each field a `column` path on that model. Filters, sorts and groups are built from those paths only;
 * a field without a path cannot be used. Grouping runs in the database (`groupBy` on scalar columns); nested
 * fields group by their scalar key and resolve labels afterwards. Decimals stay decimal strings end to end.
 */
export interface ColumnDef extends FieldDef {
  /** Dot path on the model, e.g. `department.name`. */
  column: string;
  /**
   * Task 53: a DATETIME column that stores a calendar date as UTC midnight (e.g. `hireDate`). Its filters keep UTC day
   * boundaries. Every other DATETIME column is an instant, filtered by business days in the report's zone.
   */
  calendarDate?: boolean;
  /** For groupable nested fields: the scalar column to group by and how to label its values. */
  groupKey?: { column: string; labels: (keys: string[]) => Promise<Map<string, string>> };
}
/* eslint-disable @typescript-eslint/no-explicit-any -- the delegate is chosen by the registry, never by a request; its args are built from allow-listed columns */
type Delegate = { findMany: (args: any) => Promise<any[]>; count: (args: any) => Promise<number>; groupBy: (args: any) => Promise<any[]> };
/* eslint-enable @typescript-eslint/no-explicit-any */

const setPath = (obj: Record<string, unknown>, path: string, value: unknown) => {
  const parts = path.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) { cur[parts[i]!] = (cur[parts[i]!] as Record<string, unknown>) ?? {}; cur = cur[parts[i]!] as Record<string, unknown>; }
  cur[parts[parts.length - 1]!] = value;
};
const getPath = (obj: unknown, path: string): unknown => path.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), obj);
const plain = (v: unknown): string | number | boolean | null => {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (v instanceof Prisma.Decimal) return v.toString();
  if (typeof v === 'object') return JSON.stringify(v);
  return v as string | number | boolean;
};

function filterClause(f: ColumnDef, op: string, value: unknown, timezone: string): unknown {
  const isDate = f.type === 'DATETIME';
  // A business date selects the instants from its local 00:00 to the next local 00:00 (23 or 25 hours on a DST day).
  const zone = f.calendarDate ? 'UTC' : timezone;
  const dayStart = (d: string) => businessDayStart(d, zone);
  const nextDay = (d: string) => businessDayStart(addDays(d, 1), zone);
  const v = isDate && typeof value === 'string' ? dayStart(value) : f.type === 'DECIMAL' ? new Prisma.Decimal(String(value)) : value;
  switch (op) {
    case 'EQ': return f.type === 'DATETIME' ? { gte: v, lt: nextDay(String(value)) } : { equals: v };
    case 'NE': return { not: v };
    case 'CONTAINS': return { contains: v, mode: 'insensitive' };
    case 'STARTS_WITH': return { startsWith: v, mode: 'insensitive' };
    case 'GT': case 'AFTER': return isDate ? { gte: nextDay(String(value)) } : { gt: v };
    case 'GTE': return { gte: v };
    case 'LT': case 'BEFORE': return { lt: v };
    case 'LTE': return isDate ? { lt: nextDay(String(value)) } : { lte: v };
    case 'BETWEEN': { const [a, b] = value as [string, string]; return isDate ? { gte: dayStart(a), lt: nextDay(b) } : { gte: a, lte: b }; }
    case 'IN': return { in: value };
    case 'IS_NULL': return null;
    case 'IS_NOT_NULL': return { not: null };
    default: throw new AppError(422, 'REPORT_OPERATOR_NOT_ALLOWED', `Unsupported operator ${op}`);
  }
}

export function buildWhere(fields: ColumnDef[], def: ReportDefinition, base: unknown, timezone = 'UTC'): unknown {
  const and: unknown[] = [base];
  for (const flt of def.filters) {
    const f = fields.find((x) => x.id === flt.fieldId)!;
    const clause: Record<string, unknown> = {};
    setPath(clause, f.column, filterClause(f, flt.operator, flt.value, timezone));
    and.push(clause);
  }
  return { AND: and };
}

export function buildOrderBy(fields: ColumnDef[], def: ReportDefinition, fallback: unknown): unknown[] {
  if (!def.sort.length) return [fallback];
  return def.sort.map((s) => { const f = fields.find((x) => x.id === s.fieldId)!; const o: Record<string, unknown> = {}; setPath(o, f.column, s.direction.toLowerCase()); return o; });
}

function buildSelect(fields: ColumnDef[], def: ReportDefinition): Record<string, unknown> {
  const select: Record<string, unknown> = {};
  for (const c of def.columns) { const f = fields.find((x) => x.id === c)!; const parts = f.column.split('.'); let cur = select; for (let i = 0; i < parts.length - 1; i++) { const node = (cur[parts[i]!] as { select: Record<string, unknown> }) ?? { select: {} }; cur[parts[i]!] = node; cur = node.select; } cur[parts[parts.length - 1]!] = true; }
  return select;
}

export function prismaDataset(spec: Omit<ReportDataset, 'run' | 'runAll' | 'fields'> & { fields: ColumnDef[]; delegate: Delegate; scope: (auth: RunContext['auth']) => unknown | Promise<unknown>; defaultOrder: unknown }): ReportDataset {
  const { delegate, scope: baseScope, defaultOrder, ...rest } = spec;
  const fields = spec.fields;
  // PRE_AGGREGATED (Task 47): a source row describing fewer than K people (e.g. a payroll run paying two) is withheld.
  const population = rest.privacy?.kind === 'PRE_AGGREGATED' ? rest.privacy.populationField : null;
  const K = MIN_AGGREGATE_GROUP_SIZE;
  const scope = async (auth: RunContext['auth']) => { const base = await baseScope(auth); return population ? { AND: [base ?? {}, { [population]: { gte: K } }] } : base; };
  const withheld = async (ctx: RunContext): Promise<RunResult['suppression']> => {
    if (!population) return null;
    const n = await delegate.count({ where: buildWhere(fields, ctx.definition, { AND: [(await baseScope(ctx.auth)) ?? {}, { [population]: { lt: K } }] }, await referenceZone(prisma)) });
    return n ? { suppressedGroups: n, minimumGroupSize: K, reason: `${n} source row(s) describe fewer than ${K} people and are withheld` } : null;
  };

  async function runRows(ctx: RunContext, skip: number, take: number): Promise<RunResult> {
    const where = buildWhere(fields, ctx.definition, await scope(ctx.auth), await referenceZone(prisma));
    const [total, rows, suppression] = await Promise.all([delegate.count({ where }), delegate.findMany({ where, select: buildSelect(fields, ctx.definition), orderBy: buildOrderBy(fields, ctx.definition, defaultOrder), skip, take }), withheld(ctx)]);
    return { total, suppression, rows: rows.map((r) => Object.fromEntries(ctx.definition.columns.map((c) => [c, plain(getPath(r, fields.find((x) => x.id === c)!.column))]))) };
  }

  async function runGrouped(ctx: RunContext, skip: number, take: number): Promise<RunResult> {
    const def = ctx.definition;
    const suppression = await withheld(ctx);
    const where = buildWhere(fields, def, await scope(ctx.auth), await referenceZone(prisma));
    const groupFields = def.groupBy.map((g) => fields.find((x) => x.id === g)!);
    const by = groupFields.map((f) => f.groupKey?.column ?? f.column);
    if (by.some((c) => c.includes('.'))) throw new AppError(422, 'REPORT_GROUP_NOT_ALLOWED', 'This field cannot be grouped in the database');
    const agg: Record<string, Record<string, boolean>> = {};
    const distinct: { alias: string; column: string }[] = [];
    for (const a of def.aggregations) {
      const f = fields.find((x) => x.id === a.fieldId)!;
      if (a.function === 'COUNT') { agg._count = { ...(agg._count ?? {}), _all: true }; continue; }
      if (a.function === 'COUNT_DISTINCT') { if (f.column.includes('.')) throw new AppError(422, 'REPORT_AGGREGATION_NOT_ALLOWED', 'COUNT_DISTINCT needs a scalar field'); distinct.push({ alias: a.alias ?? `${a.fieldId}_count_distinct`, column: f.column }); continue; }
      if (f.column.includes('.')) throw new AppError(422, 'REPORT_AGGREGATION_NOT_ALLOWED', `"${f.label}" cannot be aggregated in the database`);
      const key = `_${a.function.toLowerCase()}`;
      agg[key] = { ...(agg[key] ?? {}), [f.column]: true };
    }
    const groups = (await delegate.groupBy({ by, where, ...agg, orderBy: by.map((c) => ({ [c]: 'asc' })) })) as Record<string, unknown>[];
    // Labels for nested group keys (e.g. departmentId → department name), one lookup per field.
    const labels = new Map<string, Map<string, string>>();
    for (const f of groupFields) if (f.groupKey) labels.set(f.id, await f.groupKey.labels([...new Set(groups.map((g) => String(g[f.groupKey!.column] ?? '')).filter(Boolean))]));
    // COUNT_DISTINCT: distinct (group keys + field) combinations, bounded by the export cap.
    const distinctCounts = new Map<string, Map<string, number>>();
    for (const d of distinct) {
      const rows = (await delegate.findMany({ where, distinct: [...by, d.column], select: Object.fromEntries([...by, d.column].map((c) => [c, true])), take: 50_000 })) as Record<string, unknown>[];
      const m = new Map<string, number>();
      for (const r of rows) { const k = by.map((c) => String(r[c] ?? '')).join('\u0001'); m.set(k, (m.get(k) ?? 0) + (r[d.column] === null ? 0 : 1)); }
      distinctCounts.set(d.alias, m);
    }
    const rows: Row[] = groups.map((g) => {
      const row: Row = {};
      for (const f of groupFields) { const raw = g[f.groupKey?.column ?? f.column]; row[f.id] = f.groupKey ? labels.get(f.id)?.get(String(raw)) ?? (raw === null ? null : String(raw)) : plain(raw); }
      for (const a of def.aggregations) {
        const f = fields.find((x) => x.id === a.fieldId)!;
        const alias = a.alias ?? `${a.fieldId}_${a.function.toLowerCase()}`;
        if (a.function === 'COUNT') row[alias] = Number((g._count as Record<string, number>)?._all ?? 0);
        else if (a.function === 'COUNT_DISTINCT') row[alias] = distinctCounts.get(alias)?.get(by.map((c) => String(g[c] ?? '')).join('\u0001')) ?? 0;
        else row[alias] = plain((g[`_${a.function.toLowerCase()}`] as Record<string, unknown>)?.[f.column]);
      }
      return row;
    });
    return { total: rows.length, rows: rows.slice(skip, skip + take), suppression };
  }

  return {
    ...rest, fields,
    run: (ctx) => (ctx.definition.groupBy.length || ctx.definition.aggregations.length ? runGrouped(ctx, (ctx.page - 1) * ctx.pageSize, ctx.pageSize) : runRows(ctx, (ctx.page - 1) * ctx.pageSize, ctx.pageSize)),
    runAll: (ctx, cap) => (ctx.definition.groupBy.length || ctx.definition.aggregations.length ? runGrouped({ ...ctx, page: 1, pageSize: cap }, 0, cap) : runRows({ ...ctx, page: 1, pageSize: cap }, 0, cap)),
  };
}

/** For datasets that wrap a domain service returning rows in memory: filter/sort/group the bounded array. */
export function memoryDataset(spec: Omit<ReportDataset, 'run' | 'runAll'> & { load: (auth: RunContext['auth'], def: ReportDefinition) => Promise<Row[]> }): ReportDataset {
  const { load, ...rest } = spec;
  const fields = spec.fields;
  const matches = (row: Row, flt: ReportDefinition['filters'][number], timezone: string) => {
    const f = fields.find((x) => x.id === flt.fieldId)!;
    const v = row[flt.fieldId];
    const num = (x: unknown) => (typeof x === 'string' ? Number(x) : (x as number));
    // Task 48: DECIMAL (money) compares exactly; NUMBER (counts, minutes) as numbers. NaN = not comparable → no match.
    const cmp = (x: unknown, y: unknown): number => {
      if (f.type === 'DECIMAL') { try { return new Prisma.Decimal(String(x)).comparedTo(new Prisma.Decimal(String(y))); } catch { return NaN; } }
      const a = num(x); const b = num(y);
      return a > b ? 1 : a < b ? -1 : a === b ? 0 : NaN;
    };
    switch (flt.operator) {
      case 'IS_NULL': return v === null; case 'IS_NOT_NULL': return v !== null;
      case 'EQ': return f.type === 'DECIMAL' || f.type === 'NUMBER' ? cmp(v, flt.value) === 0 : v === flt.value;
      case 'NE': return f.type === 'DECIMAL' || f.type === 'NUMBER' ? cmp(v, flt.value) !== 0 : v !== flt.value;
      case 'CONTAINS': return typeof v === 'string' && v.toLowerCase().includes(String(flt.value).toLowerCase());
      case 'STARTS_WITH': return typeof v === 'string' && v.toLowerCase().startsWith(String(flt.value).toLowerCase());
      case 'GT': case 'AFTER': return v !== null && (f.type === 'DATE' ? String(v) > String(flt.value) : cmp(v, flt.value) > 0);
      case 'GTE': return v !== null && cmp(v, flt.value) >= 0;
      case 'LT': case 'BEFORE': return v !== null && (f.type === 'DATE' ? String(v) < String(flt.value) : cmp(v, flt.value) < 0);
      case 'LTE': return v !== null && cmp(v, flt.value) <= 0;
      // Task 53: an instant's business date in the report's zone (was its UTC date).
      case 'BETWEEN': { const [a, b] = flt.value as [string, string]; if (v === null) return false; const d = f.type === 'DATETIME' && !(f as ColumnDef).calendarDate ? businessDateOf(new Date(String(v)), timezone) : String(v).slice(0, 10); return d >= a && d <= b; }
      case 'IN': return (flt.value as string[]).includes(String(v));
      default: return false;
    }
  };
  const privacy = rest.privacy;
  const K = MIN_AGGREGATE_GROUP_SIZE;
  async function all(ctx: Omit<RunContext, 'page' | 'pageSize'>): Promise<{ rows: Row[]; suppression: RunResult['suppression'] }> {
    const def = ctx.definition;
    let source = await load(ctx.auth, def);
    let withheldRows = 0;
    if (privacy?.kind === 'PRE_AGGREGATED') {
      const kept = source.filter((r) => Number(r[privacy.populationField] ?? 0) >= K);
      withheldRows = source.length - kept.length;
      source = kept;
    }
    const zone = await referenceZone(prisma);
    let rows = source.filter((r) => def.filters.every((flt) => matches(r, flt, zone)));
    const personRows = privacy?.kind === 'PERSON_ROWS';
    // "Unfiltered − filtered" must not describe fewer than K people either.
    const excludedPeople = personRows && def.filters.length ? new Set(source.filter((r) => !rows.includes(r)).map((r) => String(r.__subject ?? ''))).size : 0;
    let suppressedGroups = withheldRows;
    let reason = withheldRows ? `${withheldRows} source row(s) describe fewer than ${K} people and are withheld` : '';
    if (def.groupBy.length || def.aggregations.length) {
      const groups = new Map<string, Row[]>();
      for (const r of rows) { const k = def.groupBy.map((g) => String(r[g] ?? '')).join('\u0001'); groups.set(k, [...(groups.get(k) ?? []), r]); }
      if (personRows) {
        if (excludedPeople > 0 && excludedPeople < K) {
          suppressedGroups = groups.size;
          reason = `The filters leave out fewer than ${K} people, so the result would describe them by subtraction; it is withheld`;
          groups.clear();
        } else {
          const hidden = partitionSuppression([...groups.entries()].map(([key, members]) => ({ key, count: new Set(members.map((m) => String(m.__subject ?? ''))).size })), K);
          for (const key of hidden.keys()) groups.delete(key);
          if (hidden.size) { suppressedGroups = hidden.size; reason = `${hidden.size} group(s) describe fewer than ${K} people (or would reveal one by subtraction) and are withheld`; }
        }
      }
      rows = [...groups.values()].map((members) => {
        const out: Row = {};
        for (const g of def.groupBy) out[g] = members[0]![g] ?? null;
        for (const a of def.aggregations) {
          const alias = a.alias ?? `${a.fieldId}_${a.function.toLowerCase()}`;
          const vals = members.map((m) => m[a.fieldId]).filter((v) => v !== null);
          // Decimal only for SUM / AVG: COUNT of a text field must not try to parse "First aid" as a number.
          const nums = () => vals.map((v) => new Prisma.Decimal(String(v)));
          const total = () => nums().reduce((acc, n) => acc.plus(n), new Prisma.Decimal(0));
          switch (a.function) {
            case 'COUNT': out[alias] = members.length; break;
            case 'COUNT_DISTINCT': out[alias] = new Set(vals.map(String)).size; break;
            case 'SUM': out[alias] = total().toFixed(2); break;
            case 'AVG': out[alias] = vals.length ? total().div(vals.length).toFixed(2) : null; break;
            case 'MIN': out[alias] = vals.length ? (vals.map(String).sort()[0] ?? null) : null; break;
            case 'MAX': out[alias] = vals.length ? (vals.map(String).sort().pop() ?? null) : null; break;
          }
        }
        return out;
      });
    } else rows = rows.map((r) => Object.fromEntries(def.columns.map((c) => [c, r[c] ?? null])));
    for (const s of [...def.sort].reverse()) rows.sort((a, b) => { const x = a[s.fieldId], y = b[s.fieldId]; const c = x === y ? 0 : x === null ? -1 : y === null ? 1 : x < y ? -1 : 1; return s.direction === 'ASC' ? c : -c; });
    return { rows, suppression: suppressedGroups ? { suppressedGroups, minimumGroupSize: K, reason } : null };
  }
  return {
    ...rest,
    run: async (ctx) => { const { rows, suppression } = await all(ctx); return { total: rows.length, rows: rows.slice((ctx.page - 1) * ctx.pageSize, ctx.page * ctx.pageSize), suppression }; },
    runAll: async (ctx, cap) => { const { rows, suppression } = await all(ctx); return { total: rows.length, rows: rows.slice(0, cap), suppression }; },
  };
}
