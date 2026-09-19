import type { NextFunction, Request, Response } from 'express';
import type { PermissionCode } from '@hr/shared';
import { AppError } from '../lib/errors';
import { hasPermission } from '../services/authorization/authorization.service';

/**
 * Per-route authorization by permission code (never by role name).
 *   no session → 401, session without the permission → 403, otherwise next().
 * Permissions come from req.auth, which `authenticate` rebuilds from the DB on every request,
 * so role/permission changes take effect on the next request without re-login.
 */
export function requirePermission(...permissions: PermissionCode[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.auth) throw AppError.unauthorized();
    const ok = permissions.length === 0 || permissions.some((p) => hasPermission(req.auth!, p));
    if (!ok) throw AppError.forbidden();
    next();
  };
}
