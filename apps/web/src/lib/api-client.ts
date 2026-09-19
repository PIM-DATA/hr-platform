import type { ApiError, ApiListMeta } from '@hr/shared';

export class ApiClientError extends Error {
  constructor(public readonly status: number, public readonly error: ApiError) {
    super(error.message);
    this.name = 'ApiClientError';
  }
}

const BASE = '/api/v1';

/**
 * Thin fetch wrapper: JSON in/out, cookies included, standard error envelope → ApiClientError.
 * Task 2 adds the CSRF header for state-changing requests here (single place).
 */
async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    credentials: 'include',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) {
    throw new ApiClientError(res.status, json.error ?? { code: 'UNKNOWN', message: res.statusText });
  }
  return json as T;
}

export const api = {
  get: <T>(path: string) => request<{ data: T; meta?: ApiListMeta }>('GET', path),
  post: <T>(path: string, body?: unknown) => request<{ data: T }>('POST', path, body),
  patch: <T>(path: string, body?: unknown) => request<{ data: T }>('PATCH', path, body),
  delete: <T>(path: string) => request<{ data: T }>('DELETE', path),
};
