/** Row of the before/after table shown in the audit detail. */
export interface DiffRow {
  field: string;
  before: unknown; // undefined = field absent on that side
  after: unknown;
  changed: boolean;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Field-level diff of two audit payloads. Works on the top-level keys of both objects
 * (nested values are compared as JSON and rendered as formatted JSON by the UI).
 * Non-object payloads (null, arrays, primitives) become a single "value" row.
 */
export function buildFieldDiff(before: unknown, after: unknown): DiffRow[] {
  if (!isPlainObject(before) && !isPlainObject(after)) {
    if (before === null && after === null) return [];
    return [{ field: 'value', before: before ?? undefined, after: after ?? undefined, changed: JSON.stringify(before) !== JSON.stringify(after) }];
  }
  const b = isPlainObject(before) ? before : {};
  const a = isPlainObject(after) ? after : {};
  const keys = [...new Set([...Object.keys(b), ...Object.keys(a)])].sort();
  return keys.map((field) => ({
    field,
    before: field in b ? b[field] : undefined,
    after: field in a ? a[field] : undefined,
    changed: JSON.stringify(b[field]) !== JSON.stringify(a[field]),
  }));
}

/** Human display of a single diff value (never HTML). */
export function formatDiffValue(v: unknown): string {
  if (v === undefined) return '—';
  if (v === null) return 'null';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v, null, 2);
}
