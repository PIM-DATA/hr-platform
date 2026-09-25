import { Router, type Request, type Response } from 'express';
import {
  PERMISSIONS, SERVICE_WORKFLOW, assignServiceRequestSchema, createHrLetterTemplateSchema, createServiceRequestSchema, createServiceRequestTypeSchema, fulfillServiceRequestSchema, hrLetterListQuerySchema,
  issueHrLetterSchema, linkServiceDocumentSchema, rejectServiceRequestSchema, serviceMessageSchema, serviceReportQuerySchema, serviceRequestListQuerySchema, updateHrLetterTemplateSchema, updateServiceRequestSchema, updateServiceRequestTypeSchema, voidHrLetterSchema,
} from '@hr/shared';
import { z } from 'zod';
import { AppError } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { requireAuth } from '../../middleware/auth';
import { requirePermission } from '../../middleware/permission';
import { validate } from '../../middleware/validate';
import { requestMeta } from '../../services/audit/audit.service';
import { hasPermission } from '../../services/authorization/authorization.service';
import { workflowEngine, type WorkflowCallbackContext, type WorkflowStepPendingContext } from '../../services/workflow';
import { serviceCatalogService } from './catalog.service';
import { serviceRequestService, serviceWorkflowHandlers } from './request.service';
import { hrLetterService, hrLetterTemplateService } from './letter.service';
import { serviceAnalyticsService } from './services-analytics.service';
import { fulfillerScope } from './services.types';

/**
 * Employee services (Task 40). Own records need the own permissions; the queue and the catalogue need an
 * organization-wide data scope plus a service permission. A salary-bearing letter additionally needs the payroll
 * authority, which the letter service checks against the same permission that guards compensation itself.
 */
const actor = (req: Request) => ({ auth: req.auth!, ...requestMeta(req) });
const P = PERMISSIONS;
const anyView = requirePermission(P.SERVICE_REQUEST_VIEW_OWN, P.SERVICE_REQUEST_CREATE, P.SERVICE_REQUEST_VIEW, P.SERVICE_REQUEST_FULFILL, P.SERVICE_REQUEST_MANAGE, P.HR_LETTER_VIEW_OWN, P.HR_LETTER_ISSUE, P.HR_LETTER_MANAGE_TEMPLATES, P.HR_LETTER_VIEW_REPORTS);
const own = requirePermission(P.SERVICE_REQUEST_VIEW_OWN, P.SERVICE_REQUEST_VIEW, P.SERVICE_REQUEST_FULFILL, P.SERVICE_REQUEST_MANAGE);
const create = requirePermission(P.SERVICE_REQUEST_CREATE, P.SERVICE_REQUEST_MANAGE);
const fulfill = requirePermission(P.SERVICE_REQUEST_FULFILL, P.SERVICE_REQUEST_MANAGE);
const manageCatalog = requirePermission(P.SERVICE_REQUEST_MANAGE);
const letterOwn = requirePermission(P.HR_LETTER_VIEW_OWN, P.HR_LETTER_ISSUE, P.HR_LETTER_MANAGE_TEMPLATES);
const letterIssue = requirePermission(P.HR_LETTER_ISSUE);
const letterTemplates = requirePermission(P.HR_LETTER_MANAGE_TEMPLATES, P.HR_LETTER_ISSUE);
const manageTemplates = requirePermission(P.HR_LETTER_MANAGE_TEMPLATES);
const reports = requirePermission(P.HR_LETTER_VIEW_REPORTS, P.SERVICE_REQUEST_MANAGE);
const includeInactive = validate(z.object({ includeInactive: z.coerce.boolean().optional() }), 'query');
const queueOnly = (req: Request, _res: Response, next: () => void) => { if (!fulfillerScope(req.auth!)) throw AppError.forbidden('The service queue needs an organization-wide data scope'); next(); };

/** One module, one entity type: the generic engine calls these; no second approval engine exists. */
export function registerServiceWorkflowHandlers() {
  workflowEngine.registerHandler(SERVICE_WORKFLOW.module, {
    onApproved: (ctx: WorkflowCallbackContext, tx) => serviceWorkflowHandlers.onApproved(ctx, tx),
    onRejected: (ctx: WorkflowCallbackContext, tx) => serviceWorkflowHandlers.onRejected(ctx, tx),
    onCancelled: (ctx: WorkflowCallbackContext, tx) => serviceWorkflowHandlers.onCancelled(ctx, tx),
    onStepPending: (ctx: WorkflowStepPendingContext, tx) => serviceWorkflowHandlers.notifyApprover(ctx, tx),
  });
}

export const employeeServicesRouter = Router();
employeeServicesRouter.use(requireAuth);

// ---------- self-service, dashboard, options ----------
employeeServicesRouter.get('/my', anyView, async (req, res: Response) => res.json({ data: await serviceRequestService.myServices(req.auth!) }));
employeeServicesRouter.get('/dashboard', reports, async (_req, res: Response) => res.json({ data: await serviceAnalyticsService.dashboard() }));
employeeServicesRouter.get('/reports', reports, validate(serviceReportQuerySchema, 'query'), async (_req, res: Response) => res.json({ data: await serviceAnalyticsService.report(res.locals.query) }));
/** Lookups for the module's own forms. Each part is filled only for a caller who may see it. */
employeeServicesRouter.get('/options', anyView, async (req, res: Response) => {
  const auth = req.auth!;
  const canQueue = hasPermission(auth, P.SERVICE_REQUEST_FULFILL) || hasPermission(auth, P.SERVICE_REQUEST_MANAGE);
  const canTemplates = hasPermission(auth, P.HR_LETTER_MANAGE_TEMPLATES) || hasPermission(auth, P.HR_LETTER_ISSUE);
  const [organizations, workflows, fulfillers] = await Promise.all([
    prisma.organization.findMany({ where: { isActive: true }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
    canQueue ? prisma.workflowDefinition.findMany({ where: { isActive: true, module: SERVICE_WORKFLOW.module, entityType: SERVICE_WORKFLOW.entityType }, select: { code: true, name: true }, orderBy: { code: 'asc' } }) : Promise.resolve([]),
    canQueue
      ? prisma.user.findMany({
        where: { isActive: true, userRoles: { some: { role: { rolePermissions: { some: { permission: { code: { in: [P.SERVICE_REQUEST_FULFILL, P.SERVICE_REQUEST_MANAGE] } } } } } } } },
        select: { id: true, email: true, employee: { select: { firstName: true, lastName: true } } }, orderBy: { email: 'asc' }, take: 200,
      })
      : Promise.resolve([]),
  ]);
  res.json({ data: { organizations, workflows, letterTokens: canTemplates ? hrLetterService.tokens(auth) : [], fulfillers: fulfillers.map((u) => ({ id: u.id, name: u.employee ? `${u.employee.firstName} ${u.employee.lastName}` : u.email })) } });
});

// ---------- service catalogue ----------
employeeServicesRouter.get('/request-types', anyView, includeInactive, async (_req, res: Response) => res.json({ data: await serviceCatalogService.list(prisma, !!res.locals.query.includeInactive) }));
employeeServicesRouter.post('/request-types', manageCatalog, validate(createServiceRequestTypeSchema), async (req, res: Response) => res.status(201).json({ data: await serviceCatalogService.create(req.body, actor(req)) }));
employeeServicesRouter.get('/request-types/:id', anyView, async (req, res: Response) => res.json({ data: await serviceCatalogService.get(req.params.id as string) }));
employeeServicesRouter.patch('/request-types/:id', manageCatalog, validate(updateServiceRequestTypeSchema), async (req, res: Response) => res.json({ data: await serviceCatalogService.update(req.params.id as string, req.body, actor(req)) }));

// ---------- service requests ----------
employeeServicesRouter.post('/requests', create, validate(createServiceRequestSchema), async (req, res: Response) => res.status(201).json({ data: await serviceRequestService.create(req.body, actor(req)) }));
employeeServicesRouter.get('/requests', own, validate(serviceRequestListQuerySchema, 'query'), async (req, res: Response) => res.json(await serviceRequestService.list(req.auth!, res.locals.query)));
employeeServicesRouter.get('/requests/:id', own, async (req, res: Response) => res.json({ data: await serviceRequestService.get(req.auth!, req.params.id as string) }));
employeeServicesRouter.get('/requests/:id/review', requirePermission(P.WORKFLOW_APPROVE, P.SERVICE_REQUEST_VIEW, P.SERVICE_REQUEST_FULFILL), async (req, res: Response) => res.json({ data: await serviceRequestService.review(req.auth!, req.params.id as string) }));
employeeServicesRouter.patch('/requests/:id', create, validate(updateServiceRequestSchema), async (req, res: Response) => res.json({ data: await serviceRequestService.update(req.params.id as string, req.body, actor(req)) }));
employeeServicesRouter.post('/requests/:id/submit', create, async (req, res: Response) => res.json({ data: await serviceRequestService.submit(req.params.id as string, actor(req)) }));
employeeServicesRouter.post('/requests/:id/cancel', create, async (req, res: Response) => res.json({ data: await serviceRequestService.cancel(req.params.id as string, actor(req)) }));
employeeServicesRouter.post('/requests/:id/documents', own, validate(linkServiceDocumentSchema), async (req, res: Response) => res.status(201).json({ data: await serviceRequestService.attachDocument(req.params.id as string, req.body.documentId, actor(req)) }));
employeeServicesRouter.post('/requests/:id/messages', own, validate(serviceMessageSchema), async (req, res: Response) => res.status(201).json({ data: await serviceRequestService.addMessage(req.params.id as string, req.body, actor(req)) }));
employeeServicesRouter.post('/requests/:id/assign', fulfill, queueOnly, validate(assignServiceRequestSchema), async (req, res: Response) => res.json({ data: await serviceRequestService.assign(req.params.id as string, req.body, actor(req)) }));
employeeServicesRouter.post('/requests/:id/status', fulfill, queueOnly, validate(z.object({ status: z.enum(['IN_PROGRESS', 'WAITING_EMPLOYEE']) }).strict()), async (req, res: Response) => res.json({ data: await serviceRequestService.setStatus(req.params.id as string, req.body.status, actor(req)) }));
employeeServicesRouter.post('/requests/:id/fulfill', fulfill, queueOnly, validate(fulfillServiceRequestSchema), async (req, res: Response) => res.json({ data: await serviceRequestService.fulfill(req.params.id as string, req.body, actor(req)) }));
employeeServicesRouter.post('/requests/:id/reject', fulfill, queueOnly, validate(rejectServiceRequestSchema), async (req, res: Response) => res.json({ data: await serviceRequestService.reject(req.params.id as string, req.body, actor(req)) }));

// ---------- HR letter templates ----------
employeeServicesRouter.get('/letter-templates', letterTemplates, includeInactive, async (_req, res: Response) => res.json({ data: await hrLetterTemplateService.list(prisma, !!res.locals.query.includeInactive) }));
employeeServicesRouter.post('/letter-templates', manageTemplates, validate(createHrLetterTemplateSchema), async (req, res: Response) => res.status(201).json({ data: await hrLetterTemplateService.create(req.body, actor(req)) }));
employeeServicesRouter.get('/letter-templates/:id', letterTemplates, async (req, res: Response) => res.json({ data: await hrLetterTemplateService.get(req.params.id as string) }));
employeeServicesRouter.patch('/letter-templates/:id', manageTemplates, validate(updateHrLetterTemplateSchema), async (req, res: Response) => res.json({ data: await hrLetterTemplateService.update(req.params.id as string, req.body, actor(req)) }));

// ---------- issued HR letters ----------
employeeServicesRouter.get('/letters', letterOwn, validate(hrLetterListQuerySchema, 'query'), async (req, res: Response) => res.json(await hrLetterService.list(req.auth!, res.locals.query)));
employeeServicesRouter.post('/letters', letterIssue, validate(issueHrLetterSchema), async (req, res: Response) => res.status(201).json({ data: await hrLetterService.issue(req.body, actor(req)) }));
employeeServicesRouter.get('/letters/:id', letterOwn, async (req, res: Response) => res.json({ data: await hrLetterService.get(req.auth!, req.params.id as string) }));
employeeServicesRouter.post('/letters/:id/void', letterIssue, validate(voidHrLetterSchema), async (req, res: Response) => res.json({ data: await hrLetterService.void(req.params.id as string, req.body, actor(req)) }));
