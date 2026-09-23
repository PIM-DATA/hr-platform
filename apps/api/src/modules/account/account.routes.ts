import { Router, type Request, type Response } from 'express';
import { PERMISSIONS, changeOwnPasswordSchema, consumePasswordResetSchema } from '@hr/shared';
import { requireAuth } from '../../middleware/auth';
import { requirePermission } from '../../middleware/permission';
import { validate } from '../../middleware/validate';
import { passwordResetRateLimiter } from '../../middleware/rate-limit';
import { requestMeta } from '../../services/audit/audit.service';
import { accountService } from './account.service';

/**
 * Self-service account security (`/account`) and administrator-assisted recovery (`/admin/users/...`).
 *
 * `POST /account/reset-password` is the only unauthenticated route here — it has to be, since the person using it
 * cannot sign in. It is behind a strict rate limiter and answers with one generic error for every failure mode.
 */
const actor = (req: Request) => ({ auth: req.auth!, ...requestMeta(req) });

export const accountRouter = Router();

// Public: consuming a reset link. Strictly limited; no authentication, no account enumeration.
accountRouter.post('/reset-password', passwordResetRateLimiter, validate(consumePasswordResetSchema), async (req, res) => {
  await accountService.consumePasswordReset(req.body.token, req.body.newPassword, { ...requestMeta(req) });
  res.status(204).end();
});

accountRouter.use(requireAuth);
accountRouter.post('/change-password', validate(changeOwnPasswordSchema), async (req, res) => {
  await accountService.changeOwnPassword(req.auth!, req.body, actor(req));
  res.status(204).end();
});
accountRouter.get('/sessions', async (req, res) => res.json({ data: await accountService.listOwnSessions(req.auth!) }));
accountRouter.post('/sessions/revoke-others', async (req, res) => res.json({ data: await accountService.revokeOtherSessions(req.auth!, actor(req)) }));

/** Administrator recovery actions, mounted under /admin/users. */
export const accountAdminRouter = Router();
accountAdminRouter.use(requireAuth, requirePermission(PERMISSIONS.ACCOUNT_MANAGE_RECOVERY));
accountAdminRouter.post('/:userId/password-reset', async (req, res: Response) => res.status(201).json({ data: await accountService.issuePasswordReset(req.params.userId as string, actor(req)) }));
accountAdminRouter.post('/:userId/revoke-sessions', async (req, res: Response) => res.json({ data: await accountService.revokeUserSessions(req.params.userId as string, actor(req)) }));
