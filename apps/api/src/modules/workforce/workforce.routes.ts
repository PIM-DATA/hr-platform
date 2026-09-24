import { Router, type Request, type Response } from 'express';
import {
  PERMISSIONS, addWorkforcePlanItemSchema, compareScenariosQuerySchema, createOrgDesignNodeSchema, createOrgDesignPositionSchema, createOrgDesignScenarioSchema, createPlannedMovementSchema, createWorkforceCycleSchema,
  duplicateOrgDesignScenarioSchema, orgDesignScenarioListQuerySchema, requisitionFromPlanSchema, transitionOrgDesignScenarioSchema, transitionWorkforceCycleSchema, updateOrgDesignNodeSchema, updateOrgDesignPositionSchema,
  updateOrgDesignScenarioSchema, updatePlannedMovementSchema, updateWorkforceCycleSchema, updateWorkforcePlanItemSchema, workforceCycleListQuerySchema, workforcePlanItemsQuerySchema,
} from '@hr/shared';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth';
import { requirePermission } from '../../middleware/permission';
import { validate } from '../../middleware/validate';
import { requestMeta } from '../../services/audit/audit.service';
import { prisma } from '../../lib/prisma';
import { workforceCycleService } from './cycle.service';
import { workforcePlanService } from './plan.service';
import { orgDesignService } from './org-design.service';
import { visibleDepartmentIds } from './workforce.types';

/**
 * Workforce planning (Task 32). Reading needs workforce.view (row scope inside the services), editing the plan
 * needs workforce.plan, freezing and the recruitment handoff need workforce.manage (the handoff also needs
 * recruitment.manage, checked in the service). Organization design has its own view/manage pair.
 */
const actor = (req: Request) => ({ auth: req.auth!, ...requestMeta(req) });
const view = requirePermission(PERMISSIONS.WORKFORCE_VIEW, PERMISSIONS.WORKFORCE_PLAN, PERMISSIONS.WORKFORCE_MANAGE);
const plan = requirePermission(PERMISSIONS.WORKFORCE_PLAN, PERMISSIONS.WORKFORCE_MANAGE);
const manage = requirePermission(PERMISSIONS.WORKFORCE_MANAGE);
const designView = requirePermission(PERMISSIONS.ORG_DESIGN_VIEW, PERMISSIONS.ORG_DESIGN_MANAGE);
const design = requirePermission(PERMISSIONS.ORG_DESIGN_MANAGE);
const cycleQuery = z.object({ cycleId: z.string().min(1).optional() });

export const workforceRouter = Router();
workforceRouter.use(requireAuth);

// ---------- reference data for the planning screens ----------
workforceRouter.get('/options', view, async (_req, res: Response) => {
  const [organizations, departments, jobs] = await Promise.all([
    prisma.organization.findMany({ where: { isActive: true }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
    prisma.department.findMany({ where: { isActive: true }, select: { id: true, name: true, organizationId: true, parentId: true }, orderBy: { name: 'asc' } }),
    prisma.job.findMany({ where: { isActive: true }, select: { id: true, title: true, code: true }, orderBy: { title: 'asc' } }),
  ]);
  res.json({ data: { organizations, departments, jobs } });
});

/** Employee lookup for the planned-movement form: active employees in the planner's visible departments, minimal fields. */
workforceRouter.get('/employee-options', plan, validate(z.object({ search: z.string().trim().max(100).optional(), limit: z.coerce.number().int().min(1).max(50).default(20) }), 'query'), async (req, res: Response) => {
  const visible = await visibleDepartmentIds(prisma, req.auth!);
  const q = res.locals.query as { search?: string; limit: number };
  const rows = await prisma.employee.findMany({
    where: { employmentStatus: 'ACTIVE', ...(visible ? { departmentId: { in: visible } } : {}), ...(q.search ? { OR: [{ employeeCode: { contains: q.search, mode: 'insensitive' } }, { firstName: { contains: q.search, mode: 'insensitive' } }, { lastName: { contains: q.search, mode: 'insensitive' } }] } : {}) },
    select: { id: true, employeeCode: true, firstName: true, lastName: true, organization: { select: { id: true, code: true, name: true } }, department: { select: { id: true, code: true, name: true } } }, orderBy: { employeeCode: 'asc' }, take: q.limit,
  });
  res.json({ data: rows });
});

// ---------- dashboard, vacancies ----------
workforceRouter.get('/dashboard', view, validate(cycleQuery, 'query'), async (req, res: Response) => res.json({ data: await workforcePlanService.dashboard(req.auth!, res.locals.query.cycleId ?? null) }));
workforceRouter.get('/vacancies', view, validate(z.object({ organizationId: z.string().min(1).optional() }), 'query'), async (req, res: Response) => res.json({ data: await workforcePlanService.vacancies(req.auth!, res.locals.query.organizationId ?? null) }));

// ---------- planning cycles ----------
workforceRouter.get('/cycles', view, validate(workforceCycleListQuerySchema, 'query'), async (req, res: Response) => res.json(await workforceCycleService.list(req.auth!, res.locals.query)));
workforceRouter.post('/cycles', plan, validate(createWorkforceCycleSchema), async (req, res: Response) => res.status(201).json({ data: await workforceCycleService.create(req.body, actor(req)) }));
workforceRouter.get('/cycles/:id', view, async (req, res: Response) => res.json({ data: await workforceCycleService.get(req.auth!, req.params.id as string) }));
workforceRouter.patch('/cycles/:id', plan, validate(updateWorkforceCycleSchema), async (req, res: Response) => res.json({ data: await workforceCycleService.update(req.params.id as string, req.body, actor(req)) }));
workforceRouter.post('/cycles/:id/transition', plan, validate(transitionWorkforceCycleSchema), async (req, res: Response) => res.json({ data: await workforceCycleService.transition(req.params.id as string, req.body.status, actor(req)) }));
workforceRouter.post('/cycles/:id/initialize', plan, async (req, res: Response) => res.json({ data: await workforcePlanService.initialize(req.params.id as string, actor(req)) }));

// ---------- plan items ----------
workforceRouter.get('/cycles/:id/items', view, validate(workforcePlanItemsQuerySchema, 'query'), async (req, res: Response) => res.json({ data: await workforcePlanService.items(req.auth!, req.params.id as string, res.locals.query) }));
workforceRouter.post('/cycles/:id/items', plan, validate(addWorkforcePlanItemSchema), async (req, res: Response) => res.status(201).json({ data: await workforcePlanService.addItem(req.params.id as string, req.body, actor(req)) }));
workforceRouter.patch('/items/:id', plan, validate(updateWorkforcePlanItemSchema), async (req, res: Response) => res.json({ data: await workforcePlanService.updateItem(req.params.id as string, req.body, actor(req)) }));
workforceRouter.delete('/items/:id', plan, async (req, res: Response) => { await workforcePlanService.removeItem(req.params.id as string, actor(req)); res.status(204).end(); });
/** Explicit handoff to recruitment: needs workforce.manage AND recruitment.manage (checked in the service). */
workforceRouter.post('/items/:id/requisition', manage, validate(requisitionFromPlanSchema), async (req, res: Response) => res.status(201).json({ data: await workforcePlanService.createRequisition(req.params.id as string, req.body, actor(req)) }));

// ---------- planned movements (records only) ----------
workforceRouter.get('/cycles/:id/movements', plan, async (req, res: Response) => res.json({ data: await workforcePlanService.movements(req.auth!, req.params.id as string) }));
workforceRouter.post('/cycles/:id/movements', plan, validate(createPlannedMovementSchema), async (req, res: Response) => res.status(201).json({ data: await workforcePlanService.createMovement(req.params.id as string, req.body, actor(req)) }));
workforceRouter.patch('/movements/:id', plan, validate(updatePlannedMovementSchema), async (req, res: Response) => res.json({ data: await workforcePlanService.updateMovement(req.params.id as string, req.body, actor(req)) }));

// ---------- organization design ----------
workforceRouter.get('/scenarios', designView, validate(orgDesignScenarioListQuerySchema, 'query'), async (req, res: Response) => res.json(await orgDesignService.list(req.auth!, res.locals.query)));
workforceRouter.post('/scenarios', design, validate(createOrgDesignScenarioSchema), async (req, res: Response) => res.status(201).json({ data: await orgDesignService.create(req.body, actor(req)) }));
workforceRouter.get('/scenarios/:id', designView, async (req, res: Response) => res.json({ data: await orgDesignService.tree(req.auth!, req.params.id as string) }));
workforceRouter.get('/scenarios/:id/comparison', designView, async (req, res: Response) => res.json({ data: await orgDesignService.compare(req.params.id as string) }));
workforceRouter.get('/scenarios/:id/compare', designView, validate(compareScenariosQuerySchema, 'query'), async (req, res: Response) => res.json({ data: await orgDesignService.compareScenarios(req.params.id as string, res.locals.query.with) }));
workforceRouter.patch('/scenarios/:id', design, validate(updateOrgDesignScenarioSchema), async (req, res: Response) => res.json({ data: await orgDesignService.update(req.params.id as string, req.body, actor(req)) }));
workforceRouter.post('/scenarios/:id/transition', design, validate(transitionOrgDesignScenarioSchema), async (req, res: Response) => res.json({ data: await orgDesignService.transition(req.params.id as string, req.body.status, actor(req)) }));
workforceRouter.post('/scenarios/:id/duplicate', design, validate(duplicateOrgDesignScenarioSchema), async (req, res: Response) => res.status(201).json({ data: await orgDesignService.duplicate(req.params.id as string, req.body.name, actor(req)) }));
workforceRouter.post('/scenarios/:id/import-current', design, async (req, res: Response) => res.json({ data: await orgDesignService.importCurrent(req.params.id as string, actor(req)) }));
workforceRouter.post('/scenarios/:id/nodes', design, validate(createOrgDesignNodeSchema), async (req, res: Response) => res.status(201).json({ data: await orgDesignService.createNode(req.params.id as string, req.body, actor(req)) }));
workforceRouter.patch('/scenarios/:id/nodes/:nodeId', design, validate(updateOrgDesignNodeSchema), async (req, res: Response) => { await orgDesignService.updateNode(req.params.id as string, req.params.nodeId as string, req.body, actor(req)); res.status(204).end(); });
workforceRouter.delete('/scenarios/:id/nodes/:nodeId', design, async (req, res: Response) => { await orgDesignService.deleteNode(req.params.id as string, req.params.nodeId as string, actor(req)); res.status(204).end(); });
workforceRouter.post('/scenarios/:id/positions', design, validate(createOrgDesignPositionSchema), async (req, res: Response) => res.status(201).json({ data: await orgDesignService.createPosition(req.params.id as string, req.body, actor(req)) }));
workforceRouter.patch('/scenarios/:id/positions/:positionId', design, validate(updateOrgDesignPositionSchema), async (req, res: Response) => { await orgDesignService.updatePosition(req.params.id as string, req.params.positionId as string, req.body, actor(req)); res.status(204).end(); });
workforceRouter.delete('/scenarios/:id/positions/:positionId', design, async (req, res: Response) => { await orgDesignService.deletePosition(req.params.id as string, req.params.positionId as string, actor(req)); res.status(204).end(); });
