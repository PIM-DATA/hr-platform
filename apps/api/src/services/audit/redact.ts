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
 * Parses a stored audit JSON string without ever throwing and redacts it again
 * (defense in depth for rows written before the write-side redaction existed).
 */
export function parseAuditJson(text: string | null): unknown {
  if (text === null) return null;
  try {
    return redact(JSON.parse(text));
  } catch {
    return { _unparsed: true };
  }
}
