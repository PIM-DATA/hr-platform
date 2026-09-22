import { Router, type Request, type Response } from 'express';
import { PERMISSIONS, calendarListQuerySchema, createCalendarSchema, createHolidaySchema, holidayListQuerySchema, setDefaultCalendarSchema, updateCalendarSchema, updateHolidaySchema } from '@hr/shared';
import { requireAuth } from '../../middleware/auth';
import { requirePermission } from '../../middleware/permission';
import { validate } from '../../middleware/validate';
import { requestMeta } from '../../services/audit/audit.service';
import { calendarsService } from './calendars.service';
import { holidaysService } from './holidays.service';

const view = requirePermission(PERMISSIONS.CALENDAR_VIEW);
const manage = requirePermission(PERMISSIONS.CALENDAR_MANAGE);
const actor = (req: Request) => ({ auth: req.auth!, ...requestMeta(req) });
const id = (req: Request) => req.params.id as string;

export const calendarsRouter = Router();
calendarsRouter.use(requireAuth);
calendarsRouter.get('/', view, validate(calendarListQuerySchema, 'query'), async (_req, res: Response) => res.json(await calendarsService.list(res.locals.query)));
calendarsRouter.get('/:id', view, async (req, res) => res.json({ data: await calendarsService.getById(id(req)) }));
calendarsRouter.post('/', manage, validate(createCalendarSchema), async (req, res) => res.status(201).json({ data: await calendarsService.create(req.body, actor(req)) }));
calendarsRouter.patch('/:id', manage, validate(updateCalendarSchema), async (req, res) => res.json({ data: await calendarsService.update(id(req), req.body, actor(req)) }));
calendarsRouter.patch('/:id/activate', manage, async (req, res) => res.json({ data: await calendarsService.activate(id(req), actor(req)) }));
calendarsRouter.patch('/:id/deactivate', manage, async (req, res) => res.json({ data: await calendarsService.deactivate(id(req), actor(req)) }));
calendarsRouter.get('/:id/holidays', view, validate(holidayListQuerySchema, 'query'), async (req, res) => res.json({ data: await holidaysService.list(id(req), res.locals.query) }));
calendarsRouter.post('/:id/holidays', manage, validate(createHolidaySchema), async (req, res) => res.status(201).json({ data: await holidaysService.create(id(req), req.body, actor(req)) }));
/** Organization default calendar (set with calendarId, clear with null). */
calendarsRouter.patch('/organizations/:organizationId/default', manage, validate(setDefaultCalendarSchema), async (req, res) =>
  res.json({ data: await calendarsService.setOrganizationDefault(req.params.organizationId as string, req.body.calendarId, actor(req)) }));

export const holidaysRouter = Router();
holidaysRouter.use(requireAuth);
holidaysRouter.patch('/:id', manage, validate(updateHolidaySchema), async (req, res) => res.json({ data: await holidaysService.update(id(req), req.body, actor(req)) }));
holidaysRouter.patch('/:id/activate', manage, async (req, res) => res.json({ data: await holidaysService.setActive(id(req), true, actor(req)) }));
holidaysRouter.patch('/:id/deactivate', manage, async (req, res) => res.json({ data: await holidaysService.setActive(id(req), false, actor(req)) }));
