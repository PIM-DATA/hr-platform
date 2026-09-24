import { Router, type Request, type Response } from 'express';
import {
  PERMISSIONS, addIdpItemSchema, courseListQuerySchema, createCourseSchema, createIdpSchema, createSessionSchema,
  createTrainingNeedSchema, enrollSchema, enrollmentListQuerySchema, generateTnaSchema, idpListQuerySchema,
  recordAttendanceSchema, recordResultSchema, sessionListQuerySchema, trainingNeedListQuerySchema,
  trainingReportQuerySchema, updateCourseSchema, updateIdpItemSchema, updateIdpProgressSchema, updateIdpSchema,
  updateSessionSchema, updateTrainingNeedSchema,
} from '@hr/shared';
import { requireAuth } from '../../middleware/auth';
import { requirePermission } from '../../middleware/permission';
import { validate } from '../../middleware/validate';
import { z } from 'zod';
import { AppError } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { requestMeta } from '../../services/audit/audit.service';
import { trainingNeedService } from './training-need.service';
import { courseService, sessionService } from './training-catalog.service';
import { enrollmentService, sessionLifecycleService } from './enrollment.service';
import { idpService } from './idp.service';
import { trainingReportService } from './training-report.service';

/**
 * Training and development (Task 25).
 *
 * A training administrator's authority comes from `training.manage`, `training.enroll` and `training.record_result`,
 * never from a data scope — HR books people across the company. An employee's authority is over their own record. A
 * manager's team scope gives a *summary* of their team's development and nothing more.
 */
const actor = (req: Request) => ({ auth: req.auth!, ...requestMeta(req) });
const id = (req: Request) => req.params.id as string;
const view = requirePermission(PERMISSIONS.TRAINING_VIEW);
const manage = requirePermission(PERMISSIONS.TRAINING_MANAGE);
const enroll = requirePermission(PERMISSIONS.TRAINING_ENROLL);
const record = requirePermission(PERMISSIONS.TRAINING_RECORD_RESULT);
const idpView = requirePermission(PERMISSIONS.IDP_VIEW);
const idpManage = requirePermission(PERMISSIONS.IDP_MANAGE);

export const trainingRouter = Router();
trainingRouter.use(requireAuth);

// ---------- training needs (TNA) ----------
trainingRouter.post('/needs/generate', manage, validate(generateTnaSchema), async (req, res) => res.status(201).json({ data: await trainingNeedService.generate(req.body, actor(req)) }));
trainingRouter.get('/needs', view, validate(trainingNeedListQuerySchema, 'query'), async (req, res: Response) => res.json(await trainingNeedService.list(req.auth!, res.locals.query)));
trainingRouter.get('/needs/:id', view, async (req, res) => res.json({ data: await trainingNeedService.get(req.auth!, id(req)) }));
trainingRouter.post('/needs', manage, validate(createTrainingNeedSchema), async (req, res) => res.status(201).json({ data: await trainingNeedService.create(req.body, actor(req)) }));
trainingRouter.patch('/needs/:id', manage, validate(updateTrainingNeedSchema), async (req, res) => res.json({ data: await trainingNeedService.update(id(req), req.body, actor(req)) }));
/** Courses relevant to a need's competency. Deterministic filtering, never a recommendation engine. */
trainingRouter.get('/needs/:id/suggested-courses', view, async (req, res) => {
  const need = await trainingNeedService.get(req.auth!, id(req));
  res.json({ data: need.competency ? await courseService.suggestionsFor(need.competency.id) : [] });
});

// ---------- catalogue ----------
trainingRouter.get('/courses', view, validate(courseListQuerySchema, 'query'), async (_req, res: Response) => res.json(await courseService.list(res.locals.query)));
trainingRouter.get('/courses/:id', view, async (req, res) => res.json({ data: await courseService.get(id(req)) }));
trainingRouter.post('/courses', manage, validate(createCourseSchema), async (req, res) => res.status(201).json({ data: await courseService.create(req.body, actor(req)) }));
trainingRouter.patch('/courses/:id', manage, validate(updateCourseSchema), async (req, res) => res.json({ data: await courseService.update(id(req), req.body, actor(req)) }));

trainingRouter.get('/sessions', view, validate(sessionListQuerySchema, 'query'), async (_req, res: Response) => res.json(await sessionService.list(res.locals.query)));
trainingRouter.get('/sessions/:id', view, async (req, res) => res.json({ data: await sessionService.get(id(req)) }));
trainingRouter.post('/sessions', manage, validate(createSessionSchema), async (req, res) => res.status(201).json({ data: await sessionService.create(req.body, actor(req)) }));
trainingRouter.patch('/sessions/:id', manage, validate(updateSessionSchema), async (req, res) => res.json({ data: await sessionService.update(id(req), req.body, actor(req)) }));
for (const [action, to] of [['open', 'OPEN'], ['start', 'IN_PROGRESS'], ['complete', 'COMPLETED'], ['cancel', 'CANCELLED']] as const) {
  trainingRouter.post(`/sessions/:id/${action}`, manage, async (req, res) => res.json({ data: await sessionLifecycleService.transition(id(req), to, actor(req)) }));
}

// ---------- enrolment ----------
trainingRouter.post('/sessions/:id/enroll', enroll, validate(enrollSchema), async (req, res) => res.status(201).json({ data: await enrollmentService.enroll(id(req), req.body, actor(req)) }));
trainingRouter.get('/enrollments', view, validate(enrollmentListQuerySchema, 'query'), async (req, res: Response) => res.json(await enrollmentService.list(req.auth!, res.locals.query)));
trainingRouter.post('/enrollments/:id/attendance', record, validate(recordAttendanceSchema), async (req, res) => res.json({ data: await enrollmentService.recordAttendance(id(req), req.body, actor(req)) }));
trainingRouter.post('/enrollments/:id/result', record, validate(recordResultSchema), async (req, res) => res.json({ data: await enrollmentService.recordResult(id(req), req.body, actor(req)) }));
trainingRouter.post('/enrollments/:id/cancel', enroll, async (req, res) => res.json({ data: await enrollmentService.cancel(id(req), actor(req)) }));

// ---------- development plans ----------
trainingRouter.get('/idps', idpView, validate(idpListQuerySchema, 'query'), async (req, res: Response) => res.json(await idpService.list(req.auth!, res.locals.query)));
trainingRouter.get('/idps/:id', idpView, async (req, res) => res.json({ data: await idpService.get(req.auth!, id(req)) }));
trainingRouter.post('/idps', idpManage, validate(createIdpSchema), async (req, res) => res.status(201).json({ data: await idpService.create(req.body, actor(req)) }));
trainingRouter.patch('/idps/:id', idpManage, validate(updateIdpSchema), async (req, res) => res.json({ data: await idpService.update(id(req), req.body, actor(req)) }));
trainingRouter.post('/idps/:id/activate', idpManage, async (req, res) => res.json({ data: await idpService.activate(id(req), actor(req)) }));
trainingRouter.post('/idps/:id/complete', idpManage, async (req, res) => res.json({ data: await idpService.complete(id(req), actor(req)) }));
trainingRouter.post('/idps/:id/items', idpManage, validate(addIdpItemSchema), async (req, res) => res.status(201).json({ data: await idpService.addItem(id(req), req.body, actor(req)) }));
trainingRouter.patch('/idp-items/:id', idpManage, validate(updateIdpItemSchema), async (req, res) => res.json({ data: await idpService.updateItem(id(req), req.body, actor(req)) }));
trainingRouter.patch('/idp-items/:id/progress', idpView, validate(updateIdpProgressSchema), async (req, res) => res.json({ data: await idpService.updateProgress(req.auth!, id(req), req.body) }));

// ---------- views and reports ----------
trainingRouter.get('/me', view, async (req, res) => {
  if (!req.auth!.employeeId) throw new AppError(409, 'EMPLOYEE_PROFILE_REQUIRED', 'This account is not linked to an employee record');
  res.json({ data: await trainingReportService.myDevelopment(req.auth!.employeeId) });
});
trainingRouter.get('/team', view, async (req, res) => res.json({ data: await trainingReportService.teamDevelopment(req.auth!) }));
trainingRouter.get('/reports/overview', manage, validate(trainingReportQuerySchema, 'query'), async (_req, res: Response) => res.json({ data: await trainingReportService.report(res.locals.query) }));

/** Employees for a training picker — behind `training.manage`, so a training administrator needs no other module's permission. */
trainingRouter.get(
  '/employee-options',
  manage,
  validate(z.object({ search: z.string().trim().max(100).optional(), limit: z.coerce.number().int().min(1).max(50).default(20) }), 'query'),
  async (_req, res: Response) => {
    const terms = ((res.locals.query.search as string | undefined) ?? '').split(/\s+/).filter(Boolean);
    const rows = await prisma.employee.findMany({
      where: {
        employmentStatus: 'ACTIVE',
        AND: terms.map((t) => ({ OR: [{ employeeCode: { contains: t, mode: 'insensitive' as const } }, { firstName: { contains: t, mode: 'insensitive' as const } }, { lastName: { contains: t, mode: 'insensitive' as const } }] })),
      },
      select: { id: true, employeeCode: true, firstName: true, lastName: true, organization: { select: { id: true, code: true, name: true } }, department: { select: { id: true, code: true, name: true } } },
      orderBy: { employeeCode: 'asc' },
      take: res.locals.query.limit,
    });
    res.json({ data: rows });
  },
);
