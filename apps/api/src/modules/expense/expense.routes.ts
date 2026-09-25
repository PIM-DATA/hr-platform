import { Router, type Request, type Response } from 'express';
import { EXPENSE_WORKFLOW, PERMISSIONS, createExpenseCategorySchema, createExpensePolicySchema, createExpenseReportSchema, createTravelPolicySchema, createTravelRequestSchema, expenseItemSchema, expenseListQuerySchema, expenseReportQuerySchema, recordExpensePaymentSchema, sendExpenseToPayrollSchema, travelListQuerySchema, updateExpenseCategorySchema, updateExpenseItemSchema, updateExpensePolicySchema, updateExpenseReportSchema, updateTravelPolicySchema, updateTravelRequestSchema } from '@hr/shared';
import { z } from 'zod';
import { AppError } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { requireAuth } from '../../middleware/auth';
import { requirePermission } from '../../middleware/permission';
import { validate } from '../../middleware/validate';
import { requestMeta } from '../../services/audit/audit.service';
import { hasPermission } from '../../services/authorization/authorization.service';
import { workflowEngine, type WorkflowCallbackContext, type WorkflowStepPendingContext } from '../../services/workflow';
import { expenseCategoryService, expensePolicyService, travelPolicyService } from './policy.service';
import { travelService, travelWorkflowHandlers } from './travel.service';
import { expenseReportService, reportWorkflowHandlers } from './report.service';
import { expenseAnalyticsService } from './expense-analytics.service';
import { adminScope } from './expense.types';

/** Expense and travel (Task 39). Own records need expense.view_own / submit; administration needs an ALL data scope plus an expense permission. */
const actor = (req: Request) => ({ auth: req.auth!, ...requestMeta(req) });
const P = PERMISSIONS;
const anyView = requirePermission(P.EXPENSE_VIEW_OWN, P.EXPENSE_SUBMIT, P.EXPENSE_VIEW, P.EXPENSE_MANAGE, P.EXPENSE_REVIEW, P.EXPENSE_RECORD_PAYMENT, P.EXPENSE_VIEW_REPORTS);
const own = requirePermission(P.EXPENSE_VIEW_OWN, P.EXPENSE_VIEW, P.EXPENSE_MANAGE);
const submit = requirePermission(P.EXPENSE_SUBMIT, P.EXPENSE_MANAGE);
const view = requirePermission(P.EXPENSE_VIEW, P.EXPENSE_MANAGE);
const manage = requirePermission(P.EXPENSE_MANAGE);
const payment = requirePermission(P.EXPENSE_RECORD_PAYMENT);
const reports = requirePermission(P.EXPENSE_VIEW_REPORTS, P.EXPENSE_MANAGE);
const reviewers = requirePermission(P.WORKFLOW_APPROVE, P.EXPENSE_REVIEW, P.EXPENSE_MANAGE);
const includeInactive = validate(z.object({ includeInactive: z.coerce.boolean().optional() }), 'query');
const adminOnly = (req: Request, _res: Response, next: () => void) => { if (!adminScope(req.auth!)) throw AppError.forbidden('Expense administration needs an organization-wide data scope'); next(); };

/** One workflow module, two entity types: the engine calls one handler set; we dispatch on the entity type. */
const isTravel = (ctx: { entityType: string }) => ctx.entityType === EXPENSE_WORKFLOW.travel;
export function registerExpenseWorkflowHandlers() {
  workflowEngine.registerHandler(EXPENSE_WORKFLOW.module, {
    onApproved: (ctx: WorkflowCallbackContext, tx) => (isTravel(ctx) ? travelWorkflowHandlers.onApproved(ctx, tx) : reportWorkflowHandlers.onApproved(ctx, tx)),
    onRejected: (ctx: WorkflowCallbackContext, tx) => (isTravel(ctx) ? travelWorkflowHandlers.onRejected(ctx, tx) : reportWorkflowHandlers.onRejected(ctx, tx)),
    onCancelled: (ctx: WorkflowCallbackContext, tx) => (isTravel(ctx) ? travelWorkflowHandlers.onCancelled(ctx, tx) : reportWorkflowHandlers.onCancelled(ctx, tx)),
    onStepPending: (ctx: WorkflowStepPendingContext, tx) => (isTravel(ctx) ? travelWorkflowHandlers.notifyApprover(ctx, tx) : reportWorkflowHandlers.notifyApprover(ctx, tx)),
  });
}

export const expenseRouter = Router();
expenseRouter.use(requireAuth);

// ---------- me, dashboard, options ----------
expenseRouter.get('/my', anyView, async (req, res: Response) => res.json({ data: await expenseReportService.myExpenses(req.auth!) }));
expenseRouter.get('/dashboard', reports, async (_req, res: Response) => res.json({ data: await expenseAnalyticsService.dashboard() }));
expenseRouter.get('/reports', reports, validate(expenseReportQuerySchema, 'query'), async (_req, res: Response) => res.json({ data: await expenseAnalyticsService.report(res.locals.query) }));
expenseRouter.get('/options', anyView, async (_req, res: Response) => {
  const [organizations, departments, jobs, positions, reportWorkflows, travelWorkflows, payComponents] = await Promise.all([
    prisma.organization.findMany({ where: { isActive: true }, select: { id: true, name: true }, orderBy: { name: 'asc' } }), prisma.department.findMany({ where: { isActive: true }, select: { id: true, name: true, organizationId: true }, orderBy: { name: 'asc' } }),
    prisma.job.findMany({ where: { isActive: true }, select: { id: true, title: true }, orderBy: { title: 'asc' } }), prisma.position.findMany({ where: { isActive: true }, select: { id: true, title: true, departmentId: true }, orderBy: { title: 'asc' } }),
    prisma.workflowDefinition.findMany({ where: { isActive: true, module: 'expense', entityType: EXPENSE_WORKFLOW.report }, select: { code: true, name: true }, orderBy: { code: 'asc' } }), prisma.workflowDefinition.findMany({ where: { isActive: true, module: 'expense', entityType: EXPENSE_WORKFLOW.travel }, select: { code: true, name: true }, orderBy: { code: 'asc' } }),
    prisma.payComponent.findMany({ where: { isActive: true, type: 'EARNING' }, select: { id: true, code: true, name: true }, orderBy: { code: 'asc' } }),
  ]);
  res.json({ data: { organizations, departments, jobs, positions, reportWorkflows, travelWorkflows, payComponents } });
});

// ---------- categories and policies ----------
expenseRouter.get('/categories', anyView, includeInactive, async (_req, res: Response) => res.json({ data: await expenseCategoryService.list(!!res.locals.query.includeInactive) }));
expenseRouter.post('/categories', manage, validate(createExpenseCategorySchema), async (req, res: Response) => res.status(201).json({ data: await expenseCategoryService.create(req.body, actor(req)) }));
expenseRouter.patch('/categories/:id', manage, validate(updateExpenseCategorySchema), async (req, res: Response) => res.json({ data: await expenseCategoryService.update(req.params.id as string, req.body, actor(req)) }));
expenseRouter.get('/policies', view, includeInactive, async (_req, res: Response) => res.json({ data: await expensePolicyService.list(res.locals.query) }));
expenseRouter.post('/policies', manage, validate(createExpensePolicySchema), async (req, res: Response) => res.status(201).json({ data: await expensePolicyService.create(req.body, actor(req)) }));
expenseRouter.get('/policies/conflicts', view, async (_req, res: Response) => res.json({ data: await expensePolicyService.conflicts(prisma) }));
expenseRouter.get('/policies/:id', anyView, async (req, res: Response) => res.json({ data: await expensePolicyService.get(req.params.id as string) }));
expenseRouter.patch('/policies/:id', manage, validate(updateExpensePolicySchema), async (req, res: Response) => res.json({ data: await expensePolicyService.update(req.params.id as string, req.body, actor(req)) }));
expenseRouter.get('/travel-policies', anyView, includeInactive, async (_req, res: Response) => res.json({ data: await travelPolicyService.list(res.locals.query) }));
expenseRouter.post('/travel-policies', manage, validate(createTravelPolicySchema), async (req, res: Response) => res.status(201).json({ data: await travelPolicyService.create(req.body, actor(req)) }));
expenseRouter.patch('/travel-policies/:id', manage, validate(updateTravelPolicySchema), async (req, res: Response) => res.json({ data: await travelPolicyService.update(req.params.id as string, req.body, actor(req)) }));

// ---------- travel requests ----------
expenseRouter.get('/travel', own, validate(travelListQuerySchema, 'query'), async (req, res: Response) => res.json(await travelService.list(req.auth!, res.locals.query)));
expenseRouter.post('/travel', submit, validate(createTravelRequestSchema), async (req, res: Response) => res.status(201).json({ data: await travelService.create(req.body, actor(req)) }));
expenseRouter.get('/travel/:id', own, async (req, res: Response) => res.json({ data: await travelService.get(req.auth!, req.params.id as string) }));
expenseRouter.get('/travel/:id/review', reviewers, async (req, res: Response) => res.json({ data: await expenseReportService.review(req.auth!, 'travel', req.params.id as string) }));
expenseRouter.patch('/travel/:id', submit, validate(updateTravelRequestSchema), async (req, res: Response) => res.json({ data: await travelService.update(req.params.id as string, req.body, actor(req)) }));
expenseRouter.post('/travel/:id/submit', submit, async (req, res: Response) => res.json({ data: await travelService.submit(req.params.id as string, actor(req)) }));
expenseRouter.post('/travel/:id/cancel', submit, async (req, res: Response) => res.json({ data: await travelService.cancel(req.params.id as string, actor(req)) }));
expenseRouter.post('/travel/:id/complete', submit, async (req, res: Response) => res.json({ data: await travelService.complete(req.params.id as string, actor(req)) }));

// ---------- expense reports ----------
expenseRouter.post('/expense-reports', submit, validate(createExpenseReportSchema), async (req, res: Response) => res.status(201).json({ data: await expenseReportService.create(req.body, actor(req)) }));
expenseRouter.get('/expense-reports', own, validate(expenseListQuerySchema, 'query'), async (req, res: Response) => res.json(await expenseReportService.list(req.auth!, res.locals.query)));
expenseRouter.get('/expense-reports/:id', own, async (req, res: Response) => res.json({ data: await expenseReportService.get(req.auth!, req.params.id as string) }));
expenseRouter.get('/expense-reports/:id/review', reviewers, async (req, res: Response) => res.json({ data: await expenseReportService.review(req.auth!, 'report', req.params.id as string) }));
expenseRouter.patch('/expense-reports/:id', submit, validate(updateExpenseReportSchema), async (req, res: Response) => res.json({ data: await expenseReportService.update(req.params.id as string, req.body, actor(req)) }));
expenseRouter.post('/expense-reports/:id/items', submit, validate(expenseItemSchema), async (req, res: Response) => res.status(201).json({ data: await expenseReportService.addItem(req.params.id as string, req.body, actor(req)) }));
expenseRouter.patch('/expense-reports/:id/items/:itemId', submit, validate(updateExpenseItemSchema), async (req, res: Response) => res.json({ data: await expenseReportService.updateItem(req.params.id as string, req.params.itemId as string, req.body, actor(req)) }));
expenseRouter.delete('/expense-reports/:id/items/:itemId', submit, async (req, res: Response) => res.json({ data: await expenseReportService.removeItem(req.params.id as string, req.params.itemId as string, actor(req)) }));
expenseRouter.post('/expense-reports/:id/items/:itemId/receipts', submit, validate(z.object({ documentId: z.string().min(1) }).strict()), async (req, res: Response) => res.status(201).json({ data: await expenseReportService.attachReceipt(req.params.id as string, req.params.itemId as string, req.body.documentId, actor(req)) }));
expenseRouter.post('/expense-reports/:id/submit', submit, async (req, res: Response) => res.json({ data: await expenseReportService.submit(req.params.id as string, actor(req)) }));
expenseRouter.post('/expense-reports/:id/cancel', submit, async (req, res: Response) => res.json({ data: await expenseReportService.cancel(req.params.id as string, actor(req)) }));
expenseRouter.post('/expense-reports/:id/payment', payment, adminOnly, validate(recordExpensePaymentSchema), async (req, res: Response) => res.json({ data: await expenseReportService.recordPayment(req.params.id as string, req.body, actor(req)) }));
expenseRouter.post('/expense-reports/:id/send-to-payroll', payment, adminOnly, validate(sendExpenseToPayrollSchema), async (req, res: Response) => {
  if (!hasPermission(req.auth!, P.PAYROLL_MANAGE)) throw AppError.forbidden('Sending a reimbursement to payroll needs the payroll permission as well');
  res.json({ data: await expenseReportService.sendToPayroll(req.params.id as string, req.body, actor(req)) });
});
