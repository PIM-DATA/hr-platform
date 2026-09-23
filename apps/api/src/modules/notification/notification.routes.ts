import { Router, type Response } from 'express';
import { notificationListQuerySchema } from '@hr/shared';
import { requireAuth } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { notificationService } from '../../services/notification';

/**
 * The notification inbox is the signed-in user's own data, so there is no permission code and no data scope:
 * `requireAuth` plus a userId filter on every query. Not even SYSTEM_ADMIN or an ALL-scope role can read someone
 * else's notifications (another user's id returns 404, never 403, so existence is not leaked).
 * Read state is UX state, so marking read is not audited; the underlying business events already are.
 */
export const notificationsRouter = Router();
notificationsRouter.use(requireAuth);

notificationsRouter.get('/', validate(notificationListQuerySchema, 'query'), async (req, res: Response) => res.json(await notificationService.list(req.auth!.userId, res.locals.query)));
notificationsRouter.get('/latest', async (req, res) => res.json({ data: await notificationService.latest(req.auth!.userId) }));
notificationsRouter.get('/unread-count', async (req, res) => res.json({ data: { count: await notificationService.unreadCount(req.auth!.userId) } }));
notificationsRouter.post('/read-all', async (req, res) => res.json({ data: await notificationService.markAllRead(req.auth!.userId) }));
notificationsRouter.post('/:id/read', async (req, res) => res.json({ data: await notificationService.markRead(req.auth!.userId, req.params.id as string) }));
