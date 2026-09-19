import type { Request, Response } from 'express';
import type { LoginInput } from '@hr/shared';
import { requestMeta } from '../../services/audit/audit.service';
import { loginRateLimiter } from '../../middleware/login-rate-limit';
import { AppError } from '../../lib/errors';
import { authService } from './auth.service';
import { sessionService } from './session.service';
import { clearSessionCookie, readSessionCookie, setSessionCookie } from './auth.cookie';

export const authController = {
  async login(req: Request, res: Response) {
    const meta = requestMeta(req);
    const ip = req.ip ?? 'unknown';

    // Session fixation: a session presented at login time is never reused.
    const existing = readSessionCookie(req);
    if (existing) await sessionService.revokeByRawToken(existing);

    let rawToken: string;
    try {
      ({ rawToken } = await authService.login(req.body as LoginInput, meta));
    } catch (err) {
      if (err instanceof AppError && err.statusCode === 401) loginRateLimiter.recordFailure(ip);
      throw err;
    }
    loginRateLimiter.reset(ip);

    setSessionCookie(res, rawToken);
    const auth = await sessionService.resolve(rawToken);
    if (!auth) throw AppError.unauthorized();
    res.status(200).json({ data: await authService.getMe(auth) });
  },

  /** Idempotent: clears the cookie even if the session was already gone. */
  async logout(req: Request, res: Response) {
    const rawToken = readSessionCookie(req);
    if (rawToken) await authService.logout(rawToken, req.auth, requestMeta(req));
    clearSessionCookie(res);
    res.status(204).end();
  },

  async me(req: Request, res: Response) {
    res.json({ data: await authService.getMe(req.auth!) });
  },
};
