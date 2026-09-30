import { Router, type Request, type Response } from 'express';
import {
  PERMISSIONS, approveCompProposalsSchema, compBudgetSchema, compCycleEmployeesQuerySchema, compCycleListQuerySchema, compPopulationQuerySchema, createCompCycleSchema,
  overrideCompProposalSchema, reassignCompPlannerSchema, returnCompProposalSchema, setCompExclusionSchema, updateCompCycleSchema, updateCompProposalSchema,
} from '@hr/shared';
import { prisma } from '../../lib/prisma';
import { requireAuth } from '../../middleware/auth';
import { requirePermission } from '../../middleware/permission';
import { validate } from '../../middleware/validate';
import { requestMeta } from '../../services/audit/audit.service';
import { requireHr } from './comp.types';
import { compApplyService } from './apply.service';
import { compCycleService } from './cycle.service';
import { compProposalService } from './proposal.service';
import { compReportService } from './report.service';

/**
 * Compensation planning / salary review (Task 43). A high-impact domain: every number is entered by a person;
 * the system never recommends, ranks or infers. HR routes need an organization-wide data scope plus a
 * compensation HR permission (checked again in the services); planner routes see only the rows assigned to the
 * caller; Apply additionally needs payroll.manage. No employee self-service exists in this release.
 */
const actor = (req: Request) => ({ auth: req.auth!, ...requestMeta(req) });
const P = PERMISSIONS;
const id = (req: Request) => req.params.id as string;
const hrAny = requirePermission(P.COMP_PLAN_REVIEW, P.COMP_PLAN_MANAGE_CYCLES, P.COMP_PLAN_MANAGE_BUDGET, P.COMP_PLAN_FINALIZE, P.COMP_PLAN_APPLY);
const manageCycles = requirePermission(P.COMP_PLAN_MANAGE_CYCLES);
const manageBudget = requirePermission(P.COMP_PLAN_MANAGE_BUDGET);
const review = requirePermission(P.COMP_PLAN_REVIEW);
const startReview = requirePermission(P.COMP_PLAN_MANAGE_CYCLES, P.COMP_PLAN_REVIEW);
const finalize = requirePermission(P.COMP_PLAN_FINALIZE);
const apply = requirePermission(P.COMP_PLAN_APPLY);
const planner = requirePermission(P.COMP_PLAN_VIEW_TEAM, P.COMP_PLAN_PLAN);
const plan = requirePermission(P.COMP_PLAN_PLAN);
const history = requirePermission(P.COMP_PLAN_REVIEW, P.COMP_PLAN_MANAGE_CYCLES, P.COMP_PLAN_VIEW_TEAM, P.COMP_PLAN_PLAN);
const reports = requirePermission(P.COMP_PLAN_VIEW_REPORTS, P.COMP_PLAN_REVIEW, P.COMP_PLAN_MANAGE_CYCLES);

export const compensationPlanningRouter = Router();
compensationPlanningRouter.use(requireAuth);

// ---------- HR: cycles ----------
compensationPlanningRouter.get('/options', hrAny, async (req, res: Response) => {
  requireHr(req.auth!);
  const [organizations, departments] = await Promise.all([
    prisma.organization.findMany({ where: { isActive: true }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
    prisma.department.findMany({ where: { isActive: true }, select: { id: true, name: true, organizationId: true }, orderBy: { name: 'asc' } }),
  ]);
  res.json({ data: { organizations, departments, planners: await compCycleService.plannerOptions(req.auth!) } });
});
compensationPlanningRouter.get('/cycles', hrAny, validate(compCycleListQuerySchema, 'query'), async (req, res: Response) => res.json({ data: await compCycleService.list(req.auth!, res.locals.query) }));
compensationPlanningRouter.post('/cycles', manageCycles, validate(createCompCycleSchema), async (req, res) => res.status(201).json({ data: await compCycleService.create(req.body, actor(req)) }));
compensationPlanningRouter.get('/cycles/:id', hrAny, async (req, res) => res.json({ data: await compCycleService.get(req.auth!, id(req)) }));
compensationPlanningRouter.patch('/cycles/:id', manageCycles, validate(updateCompCycleSchema), async (req, res) => res.json({ data: await compCycleService.update(id(req), req.body, actor(req)) }));
compensationPlanningRouter.get('/cycles/:id/population', manageCycles, validate(compPopulationQuerySchema, 'query'), async (req, res: Response) => res.json({ data: await compCycleService.populationPreview(req.auth!, id(req), res.locals.query) }));
compensationPlanningRouter.post('/cycles/:id/exclusions', manageCycles, validate(setCompExclusionSchema), async (req, res) => res.json({ data: await compCycleService.setExclusion(id(req), req.body, actor(req)) }));
compensationPlanningRouter.put('/cycles/:id/budget', manageBudget, validate(compBudgetSchema), async (req, res) => res.json({ data: await compCycleService.setBudget(id(req), req.body, actor(req)) }));
compensationPlanningRouter.post('/cycles/:id/activate', manageCycles, async (req, res) => res.json({ data: await compCycleService.activate(id(req), actor(req)) }));
compensationPlanningRouter.post('/cycles/:id/start-review', startReview, async (req, res) => res.json({ data: await compCycleService.startReview(id(req), actor(req)) }));
compensationPlanningRouter.post('/cycles/:id/finalize', finalize, async (req, res) => res.json({ data: await compCycleService.finalize(id(req), actor(req)) }));
compensationPlanningRouter.post('/cycles/:id/archive', manageCycles, async (req, res) => res.json({ data: await compCycleService.archive(id(req), actor(req)) }));
compensationPlanningRouter.get('/cycles/:id/apply-preview', apply, async (req, res) => res.json({ data: await compApplyService.preview(req.auth!, id(req)) }));
compensationPlanningRouter.post('/cycles/:id/apply', apply, async (req, res) => res.json({ data: await compApplyService.apply(id(req), actor(req)) }));

// ---------- HR: review ----------
compensationPlanningRouter.get('/cycles/:id/employees', hrAny, validate(compCycleEmployeesQuerySchema, 'query'), async (req, res: Response) => res.json(await compProposalService.hrRows(req.auth!, id(req), res.locals.query)));
compensationPlanningRouter.post('/cycles/:id/approve', review, validate(approveCompProposalsSchema), async (req, res) => res.json({ data: await compProposalService.approveMany(id(req), req.body, actor(req)) }));
compensationPlanningRouter.post('/cycle-employees/:id/planner', manageCycles, validate(reassignCompPlannerSchema), async (req, res) => res.json({ data: await compCycleService.reassignPlanner(id(req), req.body, actor(req)) }));
compensationPlanningRouter.post('/proposals/:id/return', review, validate(returnCompProposalSchema), async (req, res) => res.json({ data: await compProposalService.returnToPlanner(id(req), req.body, actor(req)) }));
compensationPlanningRouter.post('/proposals/:id/override', review, validate(overrideCompProposalSchema), async (req, res) => res.json({ data: await compProposalService.override(id(req), req.body, actor(req)) }));
compensationPlanningRouter.post('/proposals/:id/approve', review, async (req, res) => res.json({ data: await compProposalService.approve(id(req), actor(req)) }));
compensationPlanningRouter.get('/proposals/:id/history', history, async (req, res) => res.json({ data: await compProposalService.history(req.auth!, id(req)) }));

// ---------- planner ----------
compensationPlanningRouter.get('/my/cycles', planner, async (req, res) => res.json({ data: await compProposalService.myCycles(req.auth!) }));
compensationPlanningRouter.get('/my/cycles/:id', planner, async (req, res) => res.json({ data: await compProposalService.myPlan(req.auth!, id(req)) }));
compensationPlanningRouter.post('/my/cycles/:id/submit', plan, async (req, res) => res.json({ data: await compProposalService.submit(id(req), actor(req)) }));
compensationPlanningRouter.patch('/proposals/:id', plan, validate(updateCompProposalSchema), async (req, res) => res.json({ data: await compProposalService.update(id(req), req.body, actor(req)) }));

// ---------- reports (aggregate only) ----------
compensationPlanningRouter.get('/reports/cycles', reports, async (req, res) => res.json({ data: await compReportService.cycles(req.auth!) }));
compensationPlanningRouter.get('/reports/cycles/:id', reports, async (req, res) => res.json({ data: await compReportService.report(req.auth!, id(req)) }));
