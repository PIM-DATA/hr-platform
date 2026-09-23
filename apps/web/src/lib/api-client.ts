import type { ApiError, ApiListMeta } from '@hr/shared';

export class ApiClientError extends Error {
  constructor(public readonly status: number, public readonly error: ApiError) {
    super(error.message);
    this.name = 'ApiClientError';
  }
}

/**
 * Same-origin by default: the reverse proxy serves the built frontend and forwards /api to the API, so cookies work
 * without CORS. Set VITE_API_BASE_URL at build time only when the API lives on a different origin — then that origin
 * must also be listed in the API's CORS_ORIGIN. Never hardcode a host here.
 */
const BASE = `${(import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '')}/api/v1`;
const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// CSRF token lives in module scope (memory only) — set by AuthProvider from /auth/me or /auth/login.
let csrfToken: string | null = null;
export function setCsrfToken(token: string | null) {
  csrfToken = token;
}
/** For requests that cannot go through `api` (multipart uploads build their own fetch). */
export function getCsrfToken(): string | null {
  return csrfToken;
}

// Centralized 401 handling. AuthProvider registers a handler that drops the auth state,
// which makes RequireAuth redirect to /login. Calls made during auth bootstrap / login
// pass `skipUnauthorizedHandler` so a 401 there does not trigger a redirect loop.
let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(handler: (() => void) | null) {
  onUnauthorized = handler;
}

export interface RequestOptions {
  skipUnauthorizedHandler?: boolean;
}

/**
 * Thin fetch wrapper: JSON in/out, cookies included (`credentials: 'include'`),
 * CSRF header on mutations, standard error envelope → ApiClientError.
 * The session token is never touched here — the browser sends the httpOnly cookie itself.
 */
async function request<T>(method: string, path: string, body?: unknown, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (UNSAFE.has(method) && csrfToken) headers['x-csrf-token'] = csrfToken;

  const res = await fetch(`${BASE}${path}`, {
    method,
    credentials: 'include',
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) {
    if (res.status === 401 && !options.skipUnauthorizedHandler) onUnauthorized?.();
    throw new ApiClientError(res.status, json.error ?? { code: 'UNKNOWN', message: res.statusText });
  }
  return json as T;
}

export const api = {
  get: <T>(path: string, options?: RequestOptions) => request<{ data: T; meta?: ApiListMeta }>('GET', path, undefined, options),
  post: <T>(path: string, body?: unknown, options?: RequestOptions) => request<{ data: T }>('POST', path, body, options),
  patch: <T>(path: string, body?: unknown, options?: RequestOptions) => request<{ data: T }>('PATCH', path, body, options),
  delete: <T>(path: string, options?: RequestOptions) => request<{ data: T }>('DELETE', path, undefined, options),
};
