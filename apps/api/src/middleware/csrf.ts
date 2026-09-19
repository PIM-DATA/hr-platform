import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../lib/errors';
import { env } from '../config/env';

export const CSRF_HEADER = 'x-csrf-token';
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Paths (relative to /api/v1) that may be called without a CSRF token. */
const EXEMPT_PATHS = new Set([
  '/auth/login', // no session exists yet; credentials are the proof of intent (sameSite=lax also blocks cross-site POST)
]);

function safeEqual(a: string, b: string) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * Global CSRF guard (synchronizer token). Mounted after `authenticate`, before routers,
 * so every state-changing route is covered without per-route opt-in.
 *
 *  - Safe methods (GET/HEAD/OPTIONS) pass.
 *  - Unsafe methods with a session must send `x-csrf-token` equal to the session's csrfToken.
 *  - Unsafe methods without a session pass here (requireAuth will 401) — an attacker without
 *    the victim's cookie gains nothing.
 *  - Defense-in-depth: when an Origin header is present it must match an allowed origin.
 */
export function csrfGuard(req: Request, _res: Response, next: NextFunction) {
  if (!UNSAFE_METHODS.has(req.method) || EXEMPT_PATHS.has(req.path)) return next();

  const origin = req.get('origin');
  if (origin && !allowedOrigins(req).has(origin)) {
    throw new AppError(403, 'CSRF_ORIGIN_MISMATCH', 'Request origin is not allowed');
  }

  if (!req.auth) return next();

  const header = req.get(CSRF_HEADER);
  if (!header) throw new AppError(403, 'CSRF_TOKEN_MISSING', 'Missing CSRF token');
  if (!safeEqual(header, req.auth.csrfToken)) throw new AppError(403, 'CSRF_TOKEN_INVALID', 'Invalid CSRF token');
  next();
}

function allowedOrigins(req: Request): Set<string> {
  const set = new Set(env.CORS_ORIGIN.split(',').map((o) => o.trim()).filter(Boolean));
  set.add(`${req.protocol}://${req.get('host')}`); // same-origin (reverse proxy / dev proxy)
  return set;
}
