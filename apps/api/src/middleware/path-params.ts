import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../lib/errors';

/**
 * Rejects a request URL that cannot possibly address a record, before routing turns it into a database query.
 *
 * Two shapes matter. A NUL byte (`%00`) reaches PostgreSQL as an invalid UTF-8 sequence and comes back as a
 * driver-level error, which the error handler can only report as a 500 — an unhelpful answer to what is really a bad
 * request, and a stack trace in the log for anyone who cares to send one. A percent sequence that is not valid UTF-8
 * is the same story. Identifiers here are cuids, codes and dates; none is anywhere near the length limit.
 *
 * This runs before authentication on purpose: a malformed URL is malformed whether or not the caller has a session.
 */
const MAX_SEGMENT_LENGTH = 200;
const INVALID = () => new AppError(400, 'VALIDATION_ERROR', 'The request URL contains an invalid value');

function assertUsable(raw: string): void {
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    throw INVALID(); // a malformed percent-escape, e.g. `%zz`
  }
  if (decoded.includes('\0') || decoded.length > MAX_SEGMENT_LENGTH) throw INVALID();
}

export function validateRequestUrl(req: Request, _res: Response, next: NextFunction) {
  for (const segment of req.path.split('/')) if (segment) assertUsable(segment);
  for (const value of Object.values(req.query)) {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (typeof item === 'string' && item.includes('\0')) throw INVALID();
    }
  }
  next();
}
