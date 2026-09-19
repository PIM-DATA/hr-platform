import type { Request, Response } from 'express';
import { env } from '../../config/env';
import { SESSION_TTL_MS } from './session.service';

export const SESSION_COOKIE = 'hr_session';

const baseOptions = {
  httpOnly: true,
  secure: env.cookieSecure, // always true in production (see env.ts)
  sameSite: 'lax' as const, // browser talks to one origin (dev proxy / prod reverse proxy); lax also blocks cross-site POSTs
  path: '/',
};

export function setSessionCookie(res: Response, rawToken: string) {
  res.cookie(SESSION_COOKIE, rawToken, { ...baseOptions, maxAge: SESSION_TTL_MS });
}

export function clearSessionCookie(res: Response) {
  res.clearCookie(SESSION_COOKIE, baseOptions);
}

export function readSessionCookie(req: Request): string | undefined {
  const value = (req.cookies as Record<string, string> | undefined)?.[SESSION_COOKIE];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
