import { Router, type Request, type Response } from 'express';
import { PERMISSIONS, adjustBenefitEntitlementSchema, benefitEnrollmentListQuerySchema, benefitEntitlementListQuerySchema, benefitPeriodListQuerySchema, benefitPlanListQuerySchema, benefitsReportQuerySchema, claimListQuerySchema, createBenefitCategorySchema, createBenefitClaimSchema, createBenefitPeriodSchema, createBenefitPlanSchema, eligibilityPreviewQuerySchema, endEnrollmentSchema, enrollBenefitSchema, generateEntitlementsSchema, recordBenefitPaymentSchema, selfEnrollBenefitSchema, sendClaimToPayrollSchema, setEligibilityOverrideSchema, updateBenefitCategorySchema, updateBenefitClaimSchema, updateBenefitPeriodSchema, updateBenefitPlanSchema } from '@hr/shared';
import { z } from 'zod';
import { AppError } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { requireAuth } from '../../middleware/auth';
import { requirePermission } from '../../middleware/permission';
import { validate } from '../../middleware/validate';
import { requestMeta } from '../../services/audit/audit.service';
import { hasPermission } from '../../services/authorization/authorization.service';
import { benefitCategoryService, benefitPeriodService, benefitPlanService } from './plan.service';
import { eligibilityService } from './eligibility.service';
import { enrollmentService, entitlementService } from './enrollment.service';
import { claimService } from './claim.service';
import { benefitsReportService } from './benefits-report.service';
import { adminScope, canSeeEmployee } from './benefits.types';

/**
 * Benefits (Task 36). `benefits.view_own` + `benefits.claim` are the employee's; the administrative permissions need
 * an organization-wide data scope to see anyone else (`adminScope`). A manager's TEAM scope never widens this module.
 */
const actor = (req: Request) => ({ auth: req.auth!, ...requestMeta(req) });
const P = PERMISSIONS;
const anyView = requirePermission(P.BENEFITS_VIEW_OWN, P.BENEFITS_VIEW, P.BENEFITS_MANAGE, P.BENEFITS_CLAIM, P.BENEFITS_REVIEW_CLAIMS, P.BENEFITS_RECORD_PAYMENT, P.BENEFITS_VIEW_REPORTS);
const own = requirePermission(P.BENEFITS_VIEW_OWN, P.BENEFITS_VIEW, P.BENEFITS_MANAGE);
const view = requirePermission(P.BENEFITS_VIEW, P.BENEFITS_MANAGE);
const manage = requirePermission(P.BENEFITS_MANAGE);
const claim = requirePermission(P.BENEFITS_CLAIM, P.BENEFITS_MANAGE);
const payment = requirePermission(P.BENEFITS_RECORD_PAYMENT);
const reports = requirePermission(P.BENEFITS_VIEW_REPORTS, P.BENEFITS_MANAGE);
const includeInactive = validate(z.object({ includeInactive: z.coerce.boolean().optional() }), 'query');
/** Administrative lists need the ALL data scope on top of the permission: a permission granted to a TEAM-scoped role still shows only the caller's own rows. */
const adminOnly = (req: Request, _res: Response, next: () => void) => { if (!adminScope(req.auth!)) throw AppError.forbidden('Benefits administration needs an organization-wide data scope'); next(); };

export const benefitsRouter = Router();
benefitsRouter.use(requireAuth);

// ---------- me ----------
benefitsRouter.get('/my', anyView, async (req, res: Response) => res.json({ data: await claimService.myBenefits(req.auth!) }));
benefitsRouter.get('/dashboard', reports, async (_req, res: Response) => res.json({ data: await benefitsReportService.dashboard() }));
benefitsRouter.get('/reports', reports, validate(benefitsReportQuerySchema, 'query'), async (_req, res: Response) => res.json({ data: await benefitsReportService.report(res.locals.query) }));
benefitsRouter.get('/options', anyView, async (_req, res: Response) => {
  const [organizations, departments, jobs, positions, workflows, payComponents] = await Promise.all([
    prisma.organization.findMany({ where: { isActive: true }, select: { id: true, name: true }, orderBy: { name: 'asc' } }), prisma.department.findMany({ where: { isActive: true }, select: { id: true, name: true, organizationId: true }, orderBy: { name: 'asc' } }),
    prisma.job.findMany({ where: { isActive: true }, select: { id: true, title: true }, orderBy: { title: 'asc' } }), prisma.position.findMany({ where: { isActive: true }, select: { id: true, title: true, departmentId: true }, orderBy: { title: 'asc' } }),
    prisma.workflowDefinition.findMany({ where: { isActive: true, module: 'benefits', entityType: 'BENEFIT_CLAIM' }, select: { code: true, name: true }, orderBy: { code: 'asc' } }), prisma.payComponent.findMany({ where: { isActive: true, type: 'EARNING' }, select: { id: true, code: true, name: true }, orderBy: { code: 'asc' } }),
  ]);
  res.json({ data: { organizations, departments, jobs, positions, workflows, payComponents } });
});

// ---------- categories and plans ----------
benefitsRouter.get('/categories', anyView, includeInactive, async (_req, res: Response) => res.json({ data: await benefitCategoryService.list(!!res.locals.query.includeInactive) }));
benefitsRouter.post('/categories', manage, validate(createBenefitCategorySchema), async (req, res: Response) => res.status(201).json({ data: await benefitCategoryService.create(req.body, actor(req)) }));
benefitsRouter.patch('/categories/:id', manage, validate(updateBenefitCategorySchema), async (req, res: Response) => res.json({ data: await benefitCategoryService.update(req.params.id as string, req.body, actor(req)) }));
benefitsRouter.get('/plans', view, validate(benefitPlanListQuerySchema, 'query'), async (_req, res: Response) => res.json({ data: await benefitPlanService.list(res.locals.query) }));
benefitsRouter.post('/plans', manage, validate(createBenefitPlanSchema), async (req, res: Response) => res.status(201).json({ data: await benefitPlanService.create(req.body, actor(req)) }));
benefitsRouter.get('/plans/:id', view, async (req, res: Response) => res.json({ data: await benefitPlanService.get(req.params.id as string) }));
benefitsRouter.patch('/plans/:id', manage, validate(updateBenefitPlanSchema), async (req, res: Response) => res.json({ data: await benefitPlanService.update(req.params.id as string, req.body, actor(req)) }));
benefitsRouter.get('/plans/:id/eligibility-preview', manage, validate(eligibilityPreviewQuerySchema, 'query'), async (req, res: Response) => res.json({ data: await eligibilityService.preview(req.params.id as string, res.locals.query) }));
benefitsRouter.get('/plans/:id/eligibility/:employeeId', anyView, async (req, res: Response) => {
  if (!canSeeEmployee(req.auth!, req.params.employeeId as string)) throw AppError.forbidden();
  res.json({ data: await eligibilityService.evaluate(prisma, req.params.employeeId as string, req.params.id as string) });
});
benefitsRouter.get('/plans/:id/overrides', manage, async (req, res: Response) => res.json({ data: await eligibilityService.overrides(req.params.id as string) }));
benefitsRouter.post('/plans/:id/overrides', manage, validate(setEligibilityOverrideSchema), async (req, res: Response) => res.status(201).json({ data: await eligibilityService.setOverride(req.params.id as string, req.body, actor(req)) }));
benefitsRouter.post('/plans/:id/enroll', manage, validate(enrollBenefitSchema), async (req, res: Response) => res.status(201).json({ data: await enrollmentService.enroll(req.params.id as string, req.body, actor(req)) }));
benefitsRouter.post('/plans/:id/self-enroll', claim, validate(selfEnrollBenefitSchema), async (req, res: Response) => res.status(201).json({ data: await enrollmentService.selfEnroll(req.params.id as string, req.body, actor(req)) }));
benefitsRouter.post('/plans/:id/waive', claim, async (req, res: Response) => res.json({ data: await enrollmentService.waive(req.params.id as string, actor(req)) }));

// ---------- periods ----------
benefitsRouter.get('/periods', own, validate(benefitPeriodListQuerySchema, 'query'), async (_req, res: Response) => res.json({ data: await benefitPeriodService.list(res.locals.query) }));
benefitsRouter.post('/periods', manage, validate(createBenefitPeriodSchema), async (req, res: Response) => res.status(201).json({ data: await benefitPeriodService.create(req.body, actor(req)) }));
benefitsRouter.get('/periods/:id', own, async (req, res: Response) => res.json({ data: await benefitPeriodService.get(req.params.id as string) }));
benefitsRouter.patch('/periods/:id', manage, validate(updateBenefitPeriodSchema), async (req, res: Response) => res.json({ data: await benefitPeriodService.update(req.params.id as string, req.body, actor(req)) }));
benefitsRouter.post('/periods/:id/open', manage, async (req, res: Response) => res.json({ data: await benefitPeriodService.open(req.params.id as string, actor(req)) }));
benefitsRouter.post('/periods/:id/close', manage, async (req, res: Response) => res.json({ data: await benefitPeriodService.close(req.params.id as string, actor(req)) }));

// ---------- enrollments and entitlements ----------
benefitsRouter.get('/enrollments', own, validate(benefitEnrollmentListQuerySchema, 'query'), async (req, res: Response) => res.json(await enrollmentService.list(req.auth!, res.locals.query)));
benefitsRouter.post('/enrollments/:id/end', manage, validate(endEnrollmentSchema), async (req, res: Response) => res.json({ data: await enrollmentService.end(req.params.id as string, req.body, actor(req)) }));
benefitsRouter.get('/entitlements', own, validate(benefitEntitlementListQuerySchema, 'query'), async (req, res: Response) => res.json(await entitlementService.list(req.auth!, res.locals.query)));
benefitsRouter.post('/entitlements/generate', manage, adminOnly, validate(generateEntitlementsSchema), async (req, res: Response) => res.json({ data: await entitlementService.generate(req.body, actor(req)) }));
benefitsRouter.get('/entitlements/:id', own, async (req, res: Response) => res.json({ data: await entitlementService.get(req.auth!, req.params.id as string) }));
benefitsRouter.post('/entitlements/:id/adjust', manage, adminOnly, validate(adjustBenefitEntitlementSchema), async (req, res: Response) => res.json({ data: await entitlementService.adjust(req.params.id as string, req.body, actor(req)) }));

// ---------- claims ----------
benefitsRouter.get('/claims', own, validate(claimListQuerySchema, 'query'), async (req, res: Response) => res.json(await claimService.list(req.auth!, res.locals.query)));
benefitsRouter.post('/claims', claim, validate(createBenefitClaimSchema), async (req, res: Response) => res.status(201).json({ data: await claimService.create(req.body, actor(req)) }));
benefitsRouter.get('/claims/:id', own, async (req, res: Response) => res.json({ data: await claimService.get(req.auth!, req.params.id as string) }));
benefitsRouter.get('/claims/:id/review', requirePermission(P.WORKFLOW_APPROVE, P.BENEFITS_REVIEW_CLAIMS, P.BENEFITS_MANAGE), async (req, res: Response) => res.json({ data: await claimService.review(req.auth!, req.params.id as string) }));
benefitsRouter.patch('/claims/:id', claim, validate(updateBenefitClaimSchema), async (req, res: Response) => res.json({ data: await claimService.update(req.params.id as string, req.body, actor(req)) }));
benefitsRouter.post('/claims/:id/documents', claim, validate(z.object({ documentId: z.string().min(1) }).strict()), async (req, res: Response) => res.status(201).json({ data: await claimService.attachDocument(req.params.id as string, req.body.documentId, actor(req)) }));
benefitsRouter.post('/claims/:id/submit', claim, async (req, res: Response) => res.json({ data: await claimService.submit(req.params.id as string, actor(req)) }));
benefitsRouter.post('/claims/:id/cancel', claim, async (req, res: Response) => res.json({ data: await claimService.cancel(req.params.id as string, actor(req)) }));
benefitsRouter.post('/claims/:id/payment', payment, adminOnly, validate(recordBenefitPaymentSchema), async (req, res: Response) => res.json({ data: await claimService.recordPayment(req.params.id as string, req.body, actor(req)) }));
benefitsRouter.post('/claims/:id/send-to-payroll', payment, adminOnly, validate(sendClaimToPayrollSchema), async (req, res: Response) => {
  if (!hasPermission(req.auth!, P.PAYROLL_MANAGE)) throw AppError.forbidden('Sending a reimbursement to payroll needs the payroll permission as well');
  res.json({ data: await claimService.sendToPayroll(req.params.id as string, req.body, actor(req)) });
});
