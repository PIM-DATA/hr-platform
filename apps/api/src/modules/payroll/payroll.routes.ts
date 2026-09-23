import { Router, type Request, type Response } from 'express';
import {
  PERMISSIONS, addPayrollAdjustmentSchema, compensationListQuerySchema, createCompensationSchema,
  createPayComponentSchema, createPayItemSchema, createPayrollPeriodSchema, createPayrollPolicySchema,
  payComponentListQuerySchema, payItemListQuerySchema, payrollPeriodListQuerySchema, payrollResultListQuerySchema,
  updateCompensationSchema, updatePayComponentSchema, updatePayItemSchema, updatePayrollPeriodSchema,
  updatePayrollPolicySchema,
} from '@hr/shared';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth';
import { requirePermission } from '../../middleware/permission';
import { validate } from '../../middleware/validate';
import { requestMeta } from '../../services/audit/audit.service';
import { prisma } from '../../lib/prisma';
import { compensationService, payComponentService, payItemService, payrollEmployeeOptions, payrollPolicyService } from './payroll-master.service';
import { payrollRunService } from './payroll-run.service';
import { payrollResultsCsv, payslipService } from './payslip.service';
import './payroll.handlers'; // registers the workflow callbacks for module 'payroll'

/**
 * Payroll (Task 22).
 *
 * Payroll permissions are **their own**: `payroll.view_own` for a payslip, `payroll.manage` for configuration,
 * `payroll.run` for calculating and closing, and the workflow's snapshot approver for deciding. None of them is
 * derived from the employee data scope — a manager who can see a report's attendance has no business seeing their
 * salary, and this is where that line is drawn.
 */
const actor = (req: Request) => ({ auth: req.auth!, ...requestMeta(req) });
const id = (req: Request) => req.params.id as string;
const manage = requirePermission(PERMISSIONS.PAYROLL_MANAGE);
const run = requirePermission(PERMISSIONS.PAYROLL_RUN);
const viewOwn = requirePermission(PERMISSIONS.PAYROLL_VIEW_OWN);
/** Reading payroll data at all needs a payroll permission — manage or run, never a data scope. */
const viewPayroll = requirePermission(PERMISSIONS.PAYROLL_MANAGE, PERMISSIONS.PAYROLL_RUN, PERMISSIONS.PAYROLL_APPROVE);

export const payrollRouter = Router();
payrollRouter.use(requireAuth);

// ---------- employee self service ----------
payrollRouter.get('/payslips/me', viewOwn, async (req, res) => res.json({ data: await payslipService.listMine(req.auth!) }));
payrollRouter.get('/payslips/me/:id', viewOwn, async (req, res) => res.json({ data: await payslipService.getMine(req.auth!, id(req)) }));

// ---------- pickers ----------
payrollRouter.get(
  '/employee-options',
  manage,
  validate(z.object({ search: z.string().trim().max(100).optional(), organizationId: z.string().min(1).optional(), limit: z.coerce.number().int().min(1).max(50).default(20) }), 'query'),
  async (_req, res: Response) => res.json({ data: await payrollEmployeeOptions(res.locals.query) }),
);

// ---------- compensation ----------
payrollRouter.get('/compensations', manage, validate(compensationListQuerySchema, 'query'), async (_req, res: Response) => res.json(await compensationService.list(res.locals.query)));
payrollRouter.post('/compensations', manage, validate(createCompensationSchema), async (req, res) => res.status(201).json({ data: await compensationService.create(req.body, actor(req)) }));
payrollRouter.patch('/compensations/:id', manage, validate(updateCompensationSchema), async (req, res) => res.json({ data: await compensationService.update(id(req), req.body, actor(req)) }));

// ---------- pay components and recurring items ----------
payrollRouter.get('/components', viewPayroll, validate(payComponentListQuerySchema, 'query'), async (_req, res: Response) => res.json(await payComponentService.list(res.locals.query)));
payrollRouter.post('/components', manage, validate(createPayComponentSchema), async (req, res) => res.status(201).json({ data: await payComponentService.create(req.body, actor(req)) }));
payrollRouter.patch('/components/:id', manage, validate(updatePayComponentSchema), async (req, res) => res.json({ data: await payComponentService.update(id(req), req.body, actor(req)) }));

payrollRouter.get('/pay-items', manage, validate(payItemListQuerySchema, 'query'), async (_req, res: Response) => res.json(await payItemService.list(res.locals.query)));
payrollRouter.post('/pay-items', manage, validate(createPayItemSchema), async (req, res) => res.status(201).json({ data: await payItemService.create(req.body, actor(req)) }));
payrollRouter.patch('/pay-items/:id', manage, validate(updatePayItemSchema), async (req, res) => res.json({ data: await payItemService.update(id(req), req.body, actor(req)) }));

// ---------- policy ----------
payrollRouter.get('/policies', viewPayroll, validate(z.object({ organizationId: z.string().min(1).optional() }), 'query'), async (_req, res: Response) =>
  res.json({ data: await payrollPolicyService.list(res.locals.query.organizationId) }));
payrollRouter.post('/policies', manage, validate(createPayrollPolicySchema), async (req, res) => res.status(201).json({ data: await payrollPolicyService.create(req.body, actor(req)) }));
payrollRouter.patch('/policies/:id', manage, validate(updatePayrollPolicySchema), async (req, res) => res.json({ data: await payrollPolicyService.update(id(req), req.body, actor(req)) }));

// ---------- periods and runs ----------
payrollRouter.get('/periods', viewPayroll, validate(payrollPeriodListQuerySchema, 'query'), async (_req, res: Response) => res.json(await payrollRunService.listPeriods(res.locals.query)));
payrollRouter.post('/periods', manage, validate(createPayrollPeriodSchema), async (req, res) => res.status(201).json({ data: await payrollRunService.createPeriod(req.body, actor(req)) }));
payrollRouter.get('/periods/:id', viewPayroll, async (req, res) => res.json({ data: await payrollRunService.getPeriod(id(req)) }));
payrollRouter.patch('/periods/:id', manage, validate(updatePayrollPeriodSchema), async (req, res) => res.json({ data: await payrollRunService.updatePeriod(id(req), req.body, actor(req)) }));
payrollRouter.post('/periods/:id/calculate', run, async (req, res) => res.json({ data: await payrollRunService.calculate(id(req), actor(req)) }));

payrollRouter.get('/runs/:id/results', viewPayroll, validate(payrollResultListQuerySchema, 'query'), async (req, res: Response) => res.json(await payrollRunService.listResults(id(req), res.locals.query)));
payrollRouter.get('/runs/:id/reconciliation', viewPayroll, async (req, res) => res.json({ data: await payrollRunService.reconcile(prisma, id(req)) }));
payrollRouter.get('/runs/:id/summary', viewPayroll, async (req, res) => res.json({ data: await payrollRunService.summary(id(req)) }));
payrollRouter.post('/runs/:id/submit', run, async (req, res) => res.json({ data: await payrollRunService.submitForApproval(id(req), actor(req)) }));
payrollRouter.post('/runs/:id/close', run, async (req, res) => res.json({ data: await payrollRunService.close(id(req), actor(req)) }));
// Approving and rejecting go through the generic workflow endpoint, which checks the snapshot approver.

payrollRouter.get('/runs/:id/export', manage, async (req, res) => {
  const results = await prisma.payrollResult.findMany({
    where: { runId: id(req) },
    select: { employeeCode: true, employeeName: true, departmentName: true, baseSalary: true, grossPay: true, totalDeductions: true, netPay: true, currencyCode: true },
    orderBy: { employeeCode: 'asc' },
  });
  const csv = payrollResultsCsv(results);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="payroll-${id(req).slice(0, 8)}.csv"`);
  res.setHeader('Cache-Control', 'no-store');
  res.end(`﻿${csv}`);
});

// ---------- results and adjustments ----------
payrollRouter.get('/results/:id', viewPayroll, async (req, res) => res.json({ data: await payrollRunService.getResult(id(req)) }));
payrollRouter.post('/results/:id/adjustments', manage, validate(addPayrollAdjustmentSchema), async (req, res) =>
  res.status(201).json({ data: await payrollRunService.addAdjustment(id(req), req.body, actor(req)) }));
payrollRouter.delete('/adjustments/:id', manage, async (req, res) => res.json({ data: await payrollRunService.removeAdjustment(id(req), actor(req)) }));
