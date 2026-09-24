import { Router, type Request, type Response } from 'express';
import {
  PERMISSIONS, addPlanItemSchema, assignPlansSchema, createKpiSchema, createPerformanceCycleSchema,
  cycleReportQuerySchema, kpiListQuerySchema, managerAssessmentSchema, performanceCycleListQuerySchema,
  planListQuerySchema, selfAssessmentSchema, updateKpiSchema, updatePerformanceCycleSchema, updatePlanItemSchema,
  updatePlanSchema, updateProgressSchema,
} from '@hr/shared';
import { requireAuth } from '../../middleware/auth';
import { requirePermission } from '../../middleware/permission';
import { validate } from '../../middleware/validate';
import { requestMeta } from '../../services/audit/audit.service';
import { kpiService, performanceCycleService } from './performance-master.service';
import { performancePlanService } from './performance-plan.service';
import { performanceReportService } from './performance-report.service';

/**
 * Performance (Task 23).
 *
 * The permission decides which *door* is open; the plan itself decides who may walk through it. Reading one person's
 * review needs to be that person, their snapshot reviewer, or somebody who manages cycles — a data scope grants
 * nothing here, because seeing a report's attendance is not the same as reading what their manager wrote about them.
 *
 * Reports are aggregate-only for everybody, which is what makes `performance.view` safe to give an executive.
 */
const actor = (req: Request) => ({ auth: req.auth!, ...requestMeta(req) });
const id = (req: Request) => req.params.id as string;
const view = requirePermission(PERMISSIONS.PERFORMANCE_VIEW);
const manageCycles = requirePermission(PERMISSIONS.PERFORMANCE_MANAGE_CYCLES);
const manageKpis = requirePermission(PERMISSIONS.PERFORMANCE_MANAGE_KPIS);
/** Reading the configuration is open to anybody who can see performance at all; changing it is not. */
const readConfig = requirePermission(PERMISSIONS.PERFORMANCE_VIEW, PERMISSIONS.PERFORMANCE_MANAGE_CYCLES, PERMISSIONS.PERFORMANCE_MANAGE_KPIS);

export const performanceRouter = Router();
performanceRouter.use(requireAuth);

// ---------- cycles ----------
performanceRouter.get('/cycles', readConfig, validate(performanceCycleListQuerySchema, 'query'), async (_req, res: Response) => res.json(await performanceCycleService.list(res.locals.query)));
performanceRouter.get('/cycles/:id', readConfig, async (req, res) => res.json({ data: await performanceCycleService.get(id(req)) }));
performanceRouter.post('/cycles', manageCycles, validate(createPerformanceCycleSchema), async (req, res) => res.status(201).json({ data: await performanceCycleService.create(req.body, actor(req)) }));
performanceRouter.patch('/cycles/:id', manageCycles, validate(updatePerformanceCycleSchema), async (req, res) => res.json({ data: await performanceCycleService.update(id(req), req.body, actor(req)) }));
performanceRouter.post('/cycles/:id/activate', manageCycles, async (req, res) => res.json({ data: await performanceCycleService.transition(id(req), 'ACTIVE', actor(req)) }));
performanceRouter.post('/cycles/:id/open-review', manageCycles, async (req, res) => res.json({ data: await performanceCycleService.transition(id(req), 'REVIEW', actor(req)) }));
performanceRouter.post('/cycles/:id/close', manageCycles, async (req, res) => res.json({ data: await performanceCycleService.transition(id(req), 'CLOSED', actor(req)) }));

// ---------- KPI library ----------
performanceRouter.get('/kpis', readConfig, validate(kpiListQuerySchema, 'query'), async (_req, res: Response) => res.json(await kpiService.list(res.locals.query)));
performanceRouter.post('/kpis', manageKpis, validate(createKpiSchema), async (req, res) => res.status(201).json({ data: await kpiService.create(req.body, actor(req)) }));
performanceRouter.patch('/kpis/:id', manageKpis, validate(updateKpiSchema), async (req, res) => res.json({ data: await kpiService.update(id(req), req.body, actor(req)) }));

// ---------- plans ----------
performanceRouter.post('/cycles/:id/assign', manageCycles, validate(assignPlansSchema), async (req, res) =>
  res.status(201).json({ data: await performancePlanService.assign(id(req), req.body, actor(req)) }));
performanceRouter.get('/plans', view, validate(planListQuerySchema, 'query'), async (req, res: Response) => res.json(await performancePlanService.list(req.auth!, res.locals.query)));
performanceRouter.get('/plans/:id', view, async (req, res) => res.json({ data: await performancePlanService.get(req.auth!, id(req)) }));
performanceRouter.patch('/plans/:id', manageCycles, validate(updatePlanSchema), async (req, res) => res.json({ data: await performancePlanService.update(id(req), req.body, actor(req)) }));

// KPI structure on a plan — HR's, and only until the review starts.
performanceRouter.post('/plans/:id/items', manageCycles, validate(addPlanItemSchema), async (req, res) =>
  res.status(201).json({ data: await performancePlanService.addItem(id(req), req.body, actor(req)) }));
performanceRouter.patch('/items/:id', manageCycles, validate(updatePlanItemSchema), async (req, res) => res.json({ data: await performancePlanService.updateItem(id(req), req.body, actor(req)) }));
performanceRouter.delete('/items/:id', manageCycles, async (req, res) => res.json({ data: await performancePlanService.removeItem(id(req), actor(req)) }));

// The employee's own plan: progress while the cycle runs, then the self assessment.
performanceRouter.patch('/items/:id/progress', view, validate(updateProgressSchema), async (req, res) => res.json({ data: await performancePlanService.updateProgress(req.auth!, id(req), req.body) }));
performanceRouter.patch('/items/:id/self', view, validate(selfAssessmentSchema), async (req, res) => res.json({ data: await performancePlanService.selfAssess(req.auth!, id(req), req.body) }));
performanceRouter.post('/plans/:id/submit-self', view, async (req, res) => res.json({ data: await performancePlanService.submitSelf(req.auth!, id(req), actor(req)) }));

// The reviewer's side. `performance.review` opens the door; the snapshot reviewer check decides who walks through it.
const review = requirePermission(PERMISSIONS.PERFORMANCE_REVIEW);
performanceRouter.patch('/items/:id/manager', review, validate(managerAssessmentSchema), async (req, res) => res.json({ data: await performancePlanService.managerAssess(req.auth!, id(req), req.body) }));
performanceRouter.post('/plans/:id/submit-manager', review, async (req, res) => res.json({ data: await performancePlanService.submitManager(req.auth!, id(req), actor(req)) }));

// ---------- reporting (aggregate only) ----------
performanceRouter.get('/cycles/:id/report', view, validate(cycleReportQuerySchema, 'query'), async (req, res: Response) =>
  res.json({ data: await performanceReportService.cycleReport(id(req), res.locals.query.departmentId) }));
