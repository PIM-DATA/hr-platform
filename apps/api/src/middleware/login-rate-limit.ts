import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../lib/errors';
import { env } from '../config/env';

/**
 * Minimal in-memory limiter for failed login attempts per IP.
 *   > LOGIN_MAX_ATTEMPTS failures within LOGIN_WINDOW_MINUTES → 429 until the window ends.
 * Successful logins reset the counter, so normal users are never blocked.
 *
 * LIMITATION: state lives in this process. With several API instances each one counts
 * separately — move the counter to a shared store (e.g. Redis) before scaling out.
 */
interface Bucket { failures: number; windowStart: number }
const buckets = new Map<string, Bucket>();
const windowMs = () => env.LOGIN_WINDOW_MINUTES * 60 * 1000;

function bucketFor(ip: string): Bucket | undefined {
  const b = buckets.get(ip);
  if (b && Date.now() - b.windowStart > windowMs()) {
    buckets.delete(ip);
    return undefined;
  }
  return b;
}

export const loginRateLimiter = {
  /** Express middleware: rejects when the IP is currently blocked. */
  check(req: Request, res: Response, next: NextFunction) {
    const b = bucketFor(req.ip ?? 'unknown');
    if (b && b.failures >= env.LOGIN_MAX_ATTEMPTS) {
      const retryAfterSec = Math.ceil((b.windowStart + windowMs() - Date.now()) / 1000);
      res.setHeader('Retry-After', String(retryAfterSec));
      throw new AppError(429, 'TOO_MANY_ATTEMPTS', 'Too many failed login attempts. Please try again later.');
    }
    next();
  },
  recordFailure(ip: string) {
    const b = bucketFor(ip);
    if (b) b.failures += 1;
    else buckets.set(ip, { failures: 1, windowStart: Date.now() });
    if (buckets.size > 10_000) sweep(); // keep memory bounded
  },
  reset(ip: string) {
    buckets.delete(ip);
  },
  /** Test helper. */
  clearAll() {
    buckets.clear();
  },
};

function sweep() {
  const now = Date.now();
  for (const [ip, b] of buckets) if (now - b.windowStart > windowMs()) buckets.delete(ip);
}
