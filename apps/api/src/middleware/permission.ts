import type { NextFunction, Request, Response } from 'express';
import type { PermissionCode } from '@hr/shared';
import { AppError } from '../lib/errors';
import { hasPermission, narrowAuth } from '../services/authorization/authorization.service';

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
    // Task 50 (T44-P1-21): from here on, the request's data scope is the scope of THESE permissions (the widest among
    // the roles that grant them), never of an unrelated role. A later, more specific guard narrows again from the full
    // permission → scope map.
    if (permissions.length > 0) req.auth = narrowAuth(req.auth, ...permissions);
    next();
  };
}
