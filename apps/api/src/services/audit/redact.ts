// password, passwordHash, password_hash, secret, token, tokenHash, csrf, csrfToken, cookie, authorization,
// credential, apiKey, accessToken, refreshToken … (case-insensitive substring match on the key)
const SENSITIVE_KEY = /password|passwd|secret|token|csrf|cookie|authorization|credential|apikey|api_key/i;

/**
 * Deep-copies `value`, replacing any property whose key looks sensitive
 * (password, passwordHash, token, tokenHash, csrfToken, cookie, secret, ...)
 * with "[REDACTED]". Applied to everything written to audit_logs.
 */
export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key);
}

export function redact<T>(value: T): T {
  if (Array.isArray(value)) return value.map(redact) as T;
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY.test(k) ? '[REDACTED]' : redact(v);
    }
    return out as T;
  }
  return value;
}

/**
 * Narrative free text never lives in the append-only audit log (Task 47, T44-P1-18): a leave reason can be a diagnosis,
 * an ER comment a disciplinary judgement, a termination reason the story of a dismissal — readable by every `audit.view`
 * holder and impossible to purge. Domain code logs lengths / "changed" flags / reason codes instead; this registry is
 * the second line of defence. Explicit keys per audit module (not a blanket regex: `reasonCode`, `name`, `title` of a
 * job are facts, not narratives). A string at one of these keys is replaced by `{ redacted: true, length }` when the
 * row is written AND when it is read, so rows written before this rule are masked too.
 */
export const AUDIT_FREE_TEXT_KEYS: Readonly<Record<string, readonly string[]>> = {
  leave: ['reason', 'comment', 'note'],
  attendance: ['reason', 'comment', 'note'],
  employee_relations: ['title', 'comment', 'reason', 'narrative', 'description', 'letterBody', 'note', 'explanation'],
  employees: ['reason', 'terminationReason'],
  payroll: ['note', 'comment'],
  workforce: ['note', 'comment'], // `reason` is a code (NEW_HEADCOUNT, REPLACEMENT…), not a narrative
  workflow: ['comment'],
};

export function redactFreeText<T>(module: string, value: T): T {
  const keys = AUDIT_FREE_TEXT_KEYS[module];
  if (!keys) return value;
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = keys.includes(k) && typeof x === 'string' ? { redacted: true, length: x.length } : walk(x);
      return out;
    }
    return v;
  };
  return walk(value) as T;
}

/**
 * Parses a stored audit JSON string without ever throwing and redacts it again
 * (defense in depth for rows written before the write-side redaction existed).
 */
export function parseAuditJson(text: string | null, module?: string): unknown {
  if (text === null) return null;
  try {
    const parsed = redact(JSON.parse(text));
    return module ? redactFreeText(module, parsed) : parsed;
  } catch {
    return { _unparsed: true };
  }
}
