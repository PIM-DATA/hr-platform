import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../lib/errors';
import { env } from '../config/env';

/**
 * Modest per-IP request ceiling, sized so a busy HR dashboard never notices it (600/min by default) while a runaway
 * script or accidental loop is stopped. Authentication endpoints have their own, far stricter limiter
 * (login-rate-limit.ts); health checks are exempt so a platform probe can never be throttled.
 *
 * Deliberately in-memory: the commercial model is one deployment (single API instance) per customer, so a process-local
 * counter IS the whole system. Horizontal scaling would need a shared store — documented, not built here.
 * `req.ip` is only trustworthy when TRUST_PROXY matches the real topology.
 */
interface Window { count: number; resetAt: number }
const windows = new Map<string, Window>();
const WINDOW_MS = 60_000;
/** Keeps the map from growing without bound on a long-running process. */
function sweep(now: number) {
  if (windows.size < 10_000) return;
  for (const [key, w] of windows) if (w.resetAt <= now) windows.delete(key);
}

export function apiRateLimiter(req: Request, res: Response, next: NextFunction) {
  const limit = env.API_RATE_LIMIT_PER_MINUTE;
  if (limit <= 0) return next();
  const now = Date.now();
  sweep(now);
  const key = req.ip ?? 'unknown';
  const current = windows.get(key);
  const window = current && current.resetAt > now ? current : { count: 0, resetAt: now + WINDOW_MS };
  window.count += 1;
  windows.set(key, window);

  res.setHeader('RateLimit-Limit', String(limit));
  res.setHeader('RateLimit-Remaining', String(Math.max(0, limit - window.count)));
  res.setHeader('RateLimit-Reset', String(Math.ceil((window.resetAt - now) / 1000)));
  if (window.count > limit) {
    res.setHeader('Retry-After', String(Math.ceil((window.resetAt - now) / 1000)));
    throw new AppError(429, 'TOO_MANY_REQUESTS', 'Too many requests. Please slow down and try again shortly.');
  }
  next();
}

/** Tests only: clears the counters so one test cannot exhaust another's budget. */
export function resetApiRateLimiter() {
  windows.clear();
}
