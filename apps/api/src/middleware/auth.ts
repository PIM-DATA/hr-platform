import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../lib/errors';
import { clearSessionCookie, readSessionCookie } from '../modules/auth/auth.cookie';
import { sessionService } from '../modules/auth/session.service';

/**
 * Global: resolves the session cookie (if any) into req.auth.
 * Never rejects — routes decide with requireAuth. An invalid/expired cookie is cleared.
 */
export async function authenticate(req: Request, res: Response, next: NextFunction) {
  const rawToken = readSessionCookie(req);
  if (!rawToken) return next();

  const auth = await sessionService.resolve(rawToken);
  if (!auth) {
    clearSessionCookie(res);
    return next();
  }
  req.auth = auth;
  res.locals.user = { id: auth.userId }; // used by request logger
  next();
}

/** Per-route: 401 unless the request has a valid session. */
export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  if (!req.auth) throw AppError.unauthorized();
  next();
}
