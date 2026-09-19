const SENSITIVE_KEY = /password|passwd|secret|token|cookie|authorization|credential/i;

/**
 * Deep-copies `value`, replacing any property whose key looks sensitive
 * (password, passwordHash, token, tokenHash, csrfToken, cookie, secret, ...)
 * with "[REDACTED]". Applied to everything written to audit_logs.
 */
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
