import { Router, type Request, type Response } from 'express';
import {
  PERMISSIONS, actionListQuerySchema, caseListQuerySchema, createActionSchema, createActionTypeSchema,
  createCaseCategorySchema, createCaseSchema, declineAcknowledgementSchema, erReportQuerySchema,
  updateActionSchema, updateActionTypeSchema, updateCaseSchema, upsertLetterTemplateSchema, upsertPolicySchema,
} from '@hr/shared';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth';
import { requirePermission } from '../../middleware/permission';
import { validate } from '../../middleware/validate';
import { requestMeta } from '../../services/audit/audit.service';
import { prisma } from '../../lib/prisma';
import { actionTypeService, caseCategoryService, disciplinaryPolicyService, letterTemplateService } from './er-config.service';
import { erCaseService } from './er-case.service';
import { erReportService } from './er-report.service';
import './er.handlers'; // registers the workflow callbacks for module 'employee_relations'

/**
 * Employee relations (Task 26).
 *
 * The most confidential data in the system. `employee_relations.view` and `.manage` open the case screens and
 * nothing else does — not a data scope, not being somebody's manager. An employee reaches only what was **issued to
 * them**, through endpoints keyed on their own identity. An approver sees a projection of the one proposal waiting
 * for their decision. Nobody else sees anything.
 */
const actor = (req: Request) => ({ auth: req.auth!, ...requestMeta(req) });
const id = (req: Request) => req.params.id as string;
const view = requirePermission(PERMISSIONS.EMPLOYEE_RELATIONS_VIEW, PERMISSIONS.EMPLOYEE_RELATIONS_MANAGE);
const manage = requirePermission(PERMISSIONS.EMPLOYEE_RELATIONS_MANAGE);
const issue = requirePermission(PERMISSIONS.EMPLOYEE_RELATIONS_ISSUE);
const acknowledge = requirePermission(PERMISSIONS.EMPLOYEE_RELATIONS_ACKNOWLEDGE);

export const employeeRelationsRouter = Router();
employeeRelationsRouter.use(requireAuth);

// ---------- the employee's own record ----------
employeeRelationsRouter.get('/my/records', acknowledge, async (req, res) => res.json({ data: await erCaseService.myRecords(req.auth!) }));
employeeRelationsRouter.get('/my/records/:id', acknowledge, async (req, res) => res.json({ data: await erCaseService.myRecord(req.auth!, id(req)) }));
/** The employee is whoever is signed in. There is no body and no target — nothing to forge. */
employeeRelationsRouter.post('/my/records/:id/acknowledge', acknowledge, async (req, res) => res.json({ data: await (await erCaseService.acknowledge(actor(req)))(id(req)) }));

// ---------- configuration ----------
employeeRelationsRouter.get('/action-types', view, async (req, res) => res.json({ data: await actionTypeService.list(req.query.includeInactive === 'true') }));
employeeRelationsRouter.post('/action-types', manage, validate(createActionTypeSchema), async (req, res) => res.status(201).json({ data: await actionTypeService.create(req.body, actor(req)) }));
employeeRelationsRouter.patch('/action-types/:id', manage, validate(updateActionTypeSchema), async (req, res) => res.json({ data: await actionTypeService.update(id(req), req.body, actor(req)) }));
employeeRelationsRouter.get('/categories', view, async (_req, res) => res.json({ data: await caseCategoryService.list() }));
employeeRelationsRouter.post('/categories', manage, validate(createCaseCategorySchema), async (req, res) => res.status(201).json({ data: await caseCategoryService.create(req.body) }));
employeeRelationsRouter.get('/policies', view, async (_req, res) => res.json({ data: await disciplinaryPolicyService.list() }));
employeeRelationsRouter.put('/policies', manage, validate(upsertPolicySchema), async (req, res) => res.json({ data: await disciplinaryPolicyService.upsert(req.body, actor(req)) }));
employeeRelationsRouter.get('/letter-templates', view, async (_req, res) => res.json({ data: await letterTemplateService.list() }));
employeeRelationsRouter.put('/letter-templates', manage, validate(upsertLetterTemplateSchema), async (req, res) => res.json({ data: await letterTemplateService.upsert(req.body) }));

// ---------- cases ----------
employeeRelationsRouter.get('/cases', view, validate(caseListQuerySchema, 'query'), async (req, res: Response) => res.json(await erCaseService.list(req.auth!, res.locals.query)));
employeeRelationsRouter.get('/cases/:id', view, async (req, res) => res.json({ data: await erCaseService.get(req.auth!, id(req)) }));
employeeRelationsRouter.post('/cases', manage, validate(createCaseSchema), async (req, res) => res.status(201).json({ data: await erCaseService.create(req.body, actor(req)) }));
employeeRelationsRouter.patch('/cases/:id', manage, validate(updateCaseSchema), async (req, res) => res.json({ data: await erCaseService.update(id(req), req.body, actor(req)) }));
employeeRelationsRouter.post('/cases/:id/close', manage, async (req, res) => res.json({ data: await erCaseService.close(id(req), actor(req)) }));
employeeRelationsRouter.post('/cases/:id/cancel', manage, async (req, res) => res.json({ data: await erCaseService.cancel(id(req), actor(req)) }));
employeeRelationsRouter.post('/cases/:id/actions', manage, validate(createActionSchema), async (req, res) => res.status(201).json({ data: await erCaseService.createAction(id(req), req.body, actor(req)) }));

// ---------- actions ----------
employeeRelationsRouter.get('/actions', view, validate(actionListQuerySchema, 'query'), async (req, res: Response) => res.json(await erCaseService.listActions(req.auth!, res.locals.query)));
employeeRelationsRouter.patch('/actions/:id', manage, validate(updateActionSchema), async (req, res) => res.json({ data: await erCaseService.updateAction(id(req), req.body, actor(req)) }));
employeeRelationsRouter.post('/actions/:id/cancel', manage, async (req, res) => res.json({ data: await erCaseService.cancelAction(id(req), actor(req)) }));
employeeRelationsRouter.post('/actions/:id/submit', issue, async (req, res) => res.json({ data: await erCaseService.submit(id(req), actor(req)) }));
employeeRelationsRouter.post('/actions/:id/declined', manage, validate(declineAcknowledgementSchema), async (req, res) => res.json({ data: await erCaseService.recordDeclined(id(req), req.body, actor(req)) }));
/** For the snapshot approver of the pending step. Approve/reject go through the generic workflow endpoint. */
employeeRelationsRouter.get('/actions/:id/approval', requirePermission(PERMISSIONS.WORKFLOW_APPROVE, PERMISSIONS.EMPLOYEE_RELATIONS_MANAGE), async (req, res) =>
  res.json({ data: await erCaseService.approvalProjection(req.auth!, id(req)) }));

// ---------- summary and reporting ----------
/** The Employee 360 hand-off. Counts only, and only for people who may see the cases. */
employeeRelationsRouter.get('/summary/:employeeId', view, async (req, res) => res.json({ data: await erCaseService.summaryFor(req.auth!, req.params.employeeId as string) }));
employeeRelationsRouter.get('/reports/overview', view, validate(erReportQuerySchema, 'query'), async (_req, res: Response) => res.json({ data: await erReportService.report(res.locals.query) }));

employeeRelationsRouter.get(
  '/employee-options',
  manage,
  validate(z.object({ search: z.string().trim().max(100).optional(), limit: z.coerce.number().int().min(1).max(50).default(20) }), 'query'),
  async (_req, res: Response) => {
    const terms = ((res.locals.query.search as string | undefined) ?? '').split(/\s+/).filter(Boolean);
    const rows = await prisma.employee.findMany({
      where: { employmentStatus: 'ACTIVE', AND: terms.map((t) => ({ OR: [{ employeeCode: { contains: t, mode: 'insensitive' as const } }, { firstName: { contains: t, mode: 'insensitive' as const } }, { lastName: { contains: t, mode: 'insensitive' as const } }] })) },
      select: { id: true, employeeCode: true, firstName: true, lastName: true, organization: { select: { id: true, code: true, name: true } }, department: { select: { id: true, code: true, name: true } } },
      orderBy: { employeeCode: 'asc' },
      take: res.locals.query.limit,
    });
    res.json({ data: rows });
  },
);
