import { Router, type Request, type Response } from 'express';
import { PERMISSIONS, assignLearningPathSchema, certificationListQuerySchema, competencyEvidenceSchema, createCertificationDefinitionSchema, createLearningPathSchema, createOjtPlanSchema, createOjtProgramSchema, fulfilStepSchema, issueCertificationSchema, learningReportQuerySchema, ojtPlanListQuerySchema, pathAssignmentListQuerySchema, renewCertificationSchema, revokeCertificationSchema, submitObservationSchema, submitOjtAssessmentSchema, updateCertificationDefinitionSchema, updateLearningPathSchema, updateOjtActivitySchema, updateOjtPlanSchema, updateOjtProgramSchema, type MyLearningDto } from '@hr/shared';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth';
import { requirePermission } from '../../middleware/permission';
import { validate } from '../../middleware/validate';
import { requestMeta } from '../../services/audit/audit.service';
import { prisma } from '../../lib/prisma';
import { ojtPlanService, ojtProgramService } from './ojt.service';
import { learningPathService, pathAssignmentService } from './learning-path.service';
import { certificationService } from './certification.service';
import { learningReportService } from './learning-report.service';
import { has } from './learning.types';

/** OJT, learning paths and certifications (Task 35). View / manage per family; trainer authority is per plan. */
const actor = (req: Request) => ({ auth: req.auth!, ...requestMeta(req) });
const P = PERMISSIONS;
const anyView = requirePermission(P.OJT_VIEW, P.LEARNING_PATH_VIEW, P.CERTIFICATION_VIEW, P.OJT_MANAGE, P.LEARNING_PATH_MANAGE, P.CERTIFICATION_MANAGE, P.LEARNING_VIEW_REPORTS);
const ojtView = requirePermission(P.OJT_VIEW, P.OJT_MANAGE, P.OJT_TRAIN); const ojtManage = requirePermission(P.OJT_MANAGE); const ojtWork = requirePermission(P.OJT_VIEW, P.OJT_TRAIN, P.OJT_MANAGE); const ojtTrain = requirePermission(P.OJT_TRAIN, P.OJT_MANAGE); const ojtAssess = requirePermission(P.OJT_ASSESS, P.OJT_MANAGE);
const pathView = requirePermission(P.LEARNING_PATH_VIEW, P.LEARNING_PATH_MANAGE); const pathManage = requirePermission(P.LEARNING_PATH_MANAGE);
const certView = requirePermission(P.CERTIFICATION_VIEW, P.CERTIFICATION_MANAGE); const certManage = requirePermission(P.CERTIFICATION_MANAGE);
const reports = requirePermission(P.LEARNING_VIEW_REPORTS, P.OJT_MANAGE, P.LEARNING_PATH_MANAGE, P.CERTIFICATION_MANAGE);
const includeInactive = validate(z.object({ includeInactive: z.coerce.boolean().optional() }), 'query');

export const learningRouter = Router();
learningRouter.use(requireAuth);

// ---------- my learning (employee and trainer) ----------
learningRouter.get('/my', anyView, async (req, res: Response) => {
  const auth = req.auth!;
  const [ojt, trainerQueue, paths, certifications, evidence] = await Promise.all([
    auth.employeeId && has(auth, P.OJT_VIEW) ? ojtPlanService.list(auth, { page: 1, pageSize: 50, mine: 'trainee' }).then((r) => Promise.all(r.data.map((p) => ojtPlanService.get(auth, p.id)))) : [],
    has(auth, P.OJT_TRAIN) ? ojtPlanService.list(auth, { page: 1, pageSize: 50, mine: 'trainer', status: 'ACTIVE' }).then((r) => r.data) : [],
    auth.employeeId && has(auth, P.LEARNING_PATH_VIEW) ? pathAssignmentService.forEmployee(auth, auth.employeeId) : [],
    auth.employeeId && has(auth, P.CERTIFICATION_VIEW) ? certificationService.forEmployee(auth.employeeId) : [],
    auth.employeeId ? ojtPlanService.evidenceFor(auth, auth.employeeId) : [],
  ]);
  const dto: MyLearningDto = { ojt, trainerQueue, paths, certifications, evidence };
  res.json({ data: dto });
});
learningRouter.get('/dashboard', anyView, async (req, res: Response) => res.json({ data: await learningReportService.dashboard(req.auth!) }));
learningRouter.get('/reports', reports, validate(learningReportQuerySchema, 'query'), async (req, res: Response) => res.json({ data: await learningReportService.report(req.auth!, res.locals.query) }));
learningRouter.get('/options', anyView, async (_req, res: Response) => {
  const [organizations, jobs, competencies, courses] = await Promise.all([
    prisma.organization.findMany({ where: { isActive: true }, select: { id: true, name: true }, orderBy: { name: 'asc' } }), prisma.job.findMany({ where: { isActive: true }, select: { id: true, title: true }, orderBy: { title: 'asc' } }),
    prisma.competency.findMany({ where: { isActive: true }, select: { id: true, code: true, name: true }, orderBy: { name: 'asc' } }), prisma.trainingCourse.findMany({ where: { isActive: true }, select: { id: true, code: true, title: true }, orderBy: { title: 'asc' } }),
  ]);
  res.json({ data: { organizations, jobs, competencies, courses } });
});

// ---------- OJT programs ----------
learningRouter.get('/ojt/programs', ojtView, includeInactive, async (_req, res: Response) => res.json({ data: await ojtProgramService.list(res.locals.query) }));
learningRouter.post('/ojt/programs', ojtManage, validate(createOjtProgramSchema), async (req, res: Response) => res.status(201).json({ data: await ojtProgramService.create(req.body, actor(req)) }));
learningRouter.get('/ojt/programs/:id', ojtView, async (req, res: Response) => res.json({ data: await ojtProgramService.get(req.params.id as string) }));
learningRouter.patch('/ojt/programs/:id', ojtManage, validate(updateOjtProgramSchema), async (req, res: Response) => res.json({ data: await ojtProgramService.update(req.params.id as string, req.body, actor(req)) }));

// ---------- OJT plans ----------
learningRouter.get('/ojt/plans', ojtView, validate(ojtPlanListQuerySchema, 'query'), async (req, res: Response) => res.json(await ojtPlanService.list(req.auth!, res.locals.query)));
learningRouter.post('/ojt/plans', ojtManage, validate(createOjtPlanSchema), async (req, res: Response) => res.status(201).json({ data: await ojtPlanService.create(req.body, actor(req)) }));
learningRouter.get('/ojt/plans/:id', ojtView, async (req, res: Response) => res.json({ data: await ojtPlanService.get(req.auth!, req.params.id as string) }));
learningRouter.patch('/ojt/plans/:id', ojtManage, validate(updateOjtPlanSchema), async (req, res: Response) => res.json({ data: await ojtPlanService.update(req.params.id as string, req.body, actor(req)) }));
learningRouter.post('/ojt/plans/:id/activate', ojtManage, async (req, res: Response) => res.json({ data: await ojtPlanService.activate(req.params.id as string, actor(req)) }));
learningRouter.post('/ojt/plans/:id/complete', ojtManage, async (req, res: Response) => res.json({ data: await ojtPlanService.complete(req.params.id as string, actor(req)) }));
learningRouter.post('/ojt/plans/:id/cancel', ojtManage, async (req, res: Response) => res.json({ data: await ojtPlanService.cancel(req.params.id as string, actor(req)) }));
learningRouter.post('/ojt/plans/:id/assessments', ojtAssess, validate(submitOjtAssessmentSchema), async (req, res: Response) => res.status(201).json({ data: await ojtPlanService.assess(req.params.id as string, req.body, actor(req)) }));
learningRouter.post('/ojt/plans/:id/competency-evidence', ojtManage, validate(competencyEvidenceSchema), async (req, res: Response) => res.status(201).json({ data: await ojtPlanService.handoffEvidence(req.params.id as string, req.body, actor(req)) }));
learningRouter.patch('/ojt/activities/:id', ojtWork, validate(updateOjtActivitySchema), async (req, res: Response) => res.json({ data: await ojtPlanService.updateActivity(req.params.id as string, req.body, actor(req)) }));
learningRouter.post('/ojt/activities/:id/observations', ojtTrain, validate(submitObservationSchema), async (req, res: Response) => res.status(201).json({ data: await ojtPlanService.observe(req.params.id as string, req.body, actor(req)) }));
learningRouter.get('/competency-evidence/:employeeId', requirePermission(P.COMPETENCY_VIEW, P.COMPETENCY_ASSESS, P.COMPETENCY_MANAGE, P.OJT_VIEW), async (req, res: Response) => res.json({ data: await ojtPlanService.evidenceFor(req.auth!, req.params.employeeId as string) }));

// ---------- learning paths ----------
learningRouter.get('/paths', pathView, includeInactive, async (_req, res: Response) => res.json({ data: await learningPathService.list(res.locals.query) }));
learningRouter.post('/paths', pathManage, validate(createLearningPathSchema), async (req, res: Response) => res.status(201).json({ data: await learningPathService.create(req.body, actor(req)) }));
learningRouter.get('/paths/:id', pathView, async (req, res: Response) => res.json({ data: await learningPathService.get(req.params.id as string) }));
learningRouter.patch('/paths/:id', pathManage, validate(updateLearningPathSchema), async (req, res: Response) => res.json({ data: await learningPathService.update(req.params.id as string, req.body, actor(req)) }));
learningRouter.post('/paths/:id/assignments', pathManage, validate(assignLearningPathSchema), async (req, res: Response) => res.status(201).json({ data: await pathAssignmentService.assign(req.params.id as string, req.body, actor(req)) }));
learningRouter.get('/path-assignments', pathView, validate(pathAssignmentListQuerySchema, 'query'), async (req, res: Response) => res.json(await pathAssignmentService.list(req.auth!, res.locals.query)));
learningRouter.get('/path-assignments/:id', pathView, async (req, res: Response) => res.json({ data: await pathAssignmentService.get(req.auth!, req.params.id as string) }));
learningRouter.post('/path-assignments/:id/steps/:stepId/fulfil', pathManage, validate(fulfilStepSchema), async (req, res: Response) => res.json({ data: await pathAssignmentService.fulfilStep(req.params.id as string, req.params.stepId as string, req.body, actor(req)) }));
learningRouter.post('/path-assignments/:id/cancel', pathManage, async (req, res: Response) => res.json({ data: await pathAssignmentService.cancel(req.params.id as string, actor(req)) }));

// ---------- certifications ----------
learningRouter.get('/certifications/definitions', certView, includeInactive, async (_req, res: Response) => res.json({ data: await certificationService.definitions(!!res.locals.query.includeInactive) }));
learningRouter.post('/certifications/definitions', certManage, validate(createCertificationDefinitionSchema), async (req, res: Response) => res.status(201).json({ data: await certificationService.createDefinition(req.body, actor(req)) }));
learningRouter.patch('/certifications/definitions/:id', certManage, validate(updateCertificationDefinitionSchema), async (req, res: Response) => res.json({ data: await certificationService.updateDefinition(req.params.id as string, req.body, actor(req)) }));
learningRouter.get('/certifications', certView, validate(certificationListQuerySchema, 'query'), async (req, res: Response) => res.json(await certificationService.list(req.auth!, res.locals.query)));
learningRouter.post('/certifications', certManage, validate(issueCertificationSchema), async (req, res: Response) => res.status(201).json({ data: await certificationService.issue(req.body, actor(req)) }));
learningRouter.get('/certifications/:id', certView, async (req, res: Response) => res.json({ data: await certificationService.get(req.auth!, req.params.id as string) }));
learningRouter.post('/certifications/:id/renew', certManage, validate(renewCertificationSchema), async (req, res: Response) => res.status(201).json({ data: await certificationService.renew(req.params.id as string, req.body, actor(req)) }));
learningRouter.post('/certifications/:id/revoke', certManage, validate(revokeCertificationSchema), async (req, res: Response) => res.json({ data: await certificationService.revoke(req.params.id as string, req.body.reason, actor(req)) }));
