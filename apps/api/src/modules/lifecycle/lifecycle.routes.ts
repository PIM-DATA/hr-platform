import { Router, type Request, type Response } from 'express';
import { PERMISSIONS, addPlanTaskSchema, completeSeparationSchema, createOffboardingCaseSchema, createOnboardingPlanSchema, createProbationCaseSchema, createProbationPolicySchema, createTemplateSchema, exitInterviewSchema, lifecycleReportQuerySchema, offboardingListQuerySchema, onboardingListQuerySchema, probationListQuerySchema, reassignProbationReviewerSchema, submitProbationReviewSchema, templateListQuerySchema, updateOffboardingCaseSchema, updateProbationPolicySchema, updateTaskSchema, updateTemplateSchema, type MyLifecycleDto } from '@hr/shared';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth';
import { requirePermission } from '../../middleware/permission';
import { validate } from '../../middleware/validate';
import { requestMeta } from '../../services/audit/audit.service';
import { prisma } from '../../lib/prisma';
import { templateService } from './template.service';
import { onboardingService } from './onboarding.service';
import { probationService } from './probation.service';
import { offboardingService } from './offboarding.service';
import { lifecycleReportService } from './lifecycle-report.service';
import { has, taskDtos } from './lifecycle.types';

/** Employee lifecycle (Task 34). Each family has its own view / manage pair; the separation has its own permission. */
const actor = (req: Request) => ({ auth: req.auth!, ...requestMeta(req) });
const P = PERMISSIONS;
const anyView = requirePermission(P.ONBOARDING_VIEW, P.PROBATION_VIEW, P.OFFBOARDING_VIEW, P.ONBOARDING_MANAGE, P.PROBATION_MANAGE, P.OFFBOARDING_MANAGE, P.LIFECYCLE_VIEW_REPORTS);
const onbView = requirePermission(P.ONBOARDING_VIEW, P.ONBOARDING_MANAGE); const onbManage = requirePermission(P.ONBOARDING_MANAGE); const onbAct = requirePermission(P.ONBOARDING_COMPLETE_TASKS, P.ONBOARDING_MANAGE);
const probView = requirePermission(P.PROBATION_VIEW, P.PROBATION_MANAGE); const probManage = requirePermission(P.PROBATION_MANAGE); const probReview = requirePermission(P.PROBATION_REVIEW, P.PROBATION_MANAGE);
const offView = requirePermission(P.OFFBOARDING_VIEW, P.OFFBOARDING_MANAGE); const offManage = requirePermission(P.OFFBOARDING_MANAGE); const offAct = requirePermission(P.OFFBOARDING_COMPLETE_TASKS, P.OFFBOARDING_MANAGE); const separation = requirePermission(P.OFFBOARDING_COMPLETE_SEPARATION);
const templateManage = requirePermission(P.ONBOARDING_MANAGE, P.OFFBOARDING_MANAGE);
const reports = requirePermission(P.LIFECYCLE_VIEW_REPORTS, P.ONBOARDING_MANAGE, P.PROBATION_MANAGE, P.OFFBOARDING_MANAGE);

export const lifecycleRouter = Router();
lifecycleRouter.use(requireAuth);

// ---------- my lifecycle (employee) ----------
lifecycleRouter.get('/my', anyView, async (req, res: Response) => {
  const auth = req.auth!;
  const [onboarding, probation, offboarding, onbTasks, offTasks] = await Promise.all([
    has(auth, P.ONBOARDING_VIEW) ? onboardingService.mine(auth) : null, has(auth, P.PROBATION_VIEW) ? probationService.mine(auth) : null, has(auth, P.OFFBOARDING_VIEW) ? offboardingService.mine(auth) : null,
    prisma.onboardingTask.findMany({ where: { assigneeUserId: auth.userId, status: { in: ['PENDING', 'IN_PROGRESS'] }, plan: { status: 'ACTIVE' } }, include: { plan: { select: { id: true, employeeNameSnapshot: true } } }, orderBy: { dueDate: 'asc' }, take: 100 }),
    prisma.offboardingTask.findMany({ where: { assigneeUserId: auth.userId, status: { in: ['PENDING', 'IN_PROGRESS'] }, case: { status: { in: ['ACTIVE', 'READY_TO_COMPLETE'] } } }, include: { case: { select: { id: true, employeeNameSnapshot: true } } }, orderBy: { dueDate: 'asc' }, take: 100 }),
  ]);
  const onb = await taskDtos(prisma, auth, onbTasks, has(auth, P.ONBOARDING_MANAGE), has(auth, P.ONBOARDING_COMPLETE_TASKS), true);
  const off = await taskDtos(prisma, auth, offTasks, has(auth, P.OFFBOARDING_MANAGE), has(auth, P.OFFBOARDING_COMPLETE_TASKS), true);
  const dto: MyLifecycleDto = { onboarding, probation, offboarding, myTasks: [...onbTasks.map((t, i) => ({ kind: 'ONBOARDING' as const, planId: t.plan.id, employeeName: t.plan.employeeNameSnapshot, task: onb[i] })), ...offTasks.map((t, i) => ({ kind: 'OFFBOARDING' as const, planId: t.case.id, employeeName: t.case.employeeNameSnapshot, task: off[i] }))].sort((a, b) => a.task.dueDate.localeCompare(b.task.dueDate)) };
  res.json({ data: dto });
});

// ---------- dashboard / reports ----------
lifecycleRouter.get('/dashboard', anyView, async (req, res: Response) => res.json({ data: await lifecycleReportService.dashboard(req.auth!, has(req.auth!, P.ONBOARDING_VIEW, P.PROBATION_VIEW, P.OFFBOARDING_VIEW, P.ONBOARDING_MANAGE, P.PROBATION_MANAGE, P.OFFBOARDING_MANAGE)) }));
lifecycleRouter.get('/reports', reports, validate(lifecycleReportQuerySchema, 'query'), async (req, res: Response) => res.json({ data: await lifecycleReportService.report(req.auth!, res.locals.query) }));
lifecycleRouter.get('/options', anyView, async (_req, res: Response) => {
  const [organizations, departments, documentCategories, users] = await Promise.all([
    prisma.organization.findMany({ where: { isActive: true }, select: { id: true, name: true }, orderBy: { name: 'asc' } }), prisma.department.findMany({ where: { isActive: true }, select: { id: true, name: true, organizationId: true }, orderBy: { name: 'asc' } }),
    prisma.documentCategory.findMany({ where: { isActive: true }, select: { id: true, name: true }, orderBy: { name: 'asc' } }), prisma.user.findMany({ where: { isActive: true }, select: { id: true, email: true, employee: { select: { firstName: true, lastName: true, employeeCode: true } } }, orderBy: { email: 'asc' }, take: 500 }),
  ]);
  res.json({ data: { organizations, departments, documentCategories, users: users.map((u) => ({ id: u.id, label: u.employee ? `${u.employee.firstName} ${u.employee.lastName} (${u.employee.employeeCode})` : u.email })) } });
});

// ---------- templates ----------
lifecycleRouter.get('/templates', anyView, validate(templateListQuerySchema, 'query'), async (_req, res: Response) => res.json({ data: await templateService.list(res.locals.query) }));
lifecycleRouter.post('/templates', templateManage, validate(createTemplateSchema), async (req, res: Response) => res.status(201).json({ data: await templateService.create(req.body, actor(req)) }));
lifecycleRouter.get('/templates/:id', anyView, async (req, res: Response) => res.json({ data: await templateService.get(req.params.id as string) }));
lifecycleRouter.patch('/templates/:id', templateManage, validate(updateTemplateSchema), async (req, res: Response) => res.json({ data: await templateService.update(req.params.id as string, req.body, actor(req)) }));

// ---------- onboarding ----------
lifecycleRouter.get('/onboarding', onbView, validate(onboardingListQuerySchema, 'query'), async (req, res: Response) => res.json(await onboardingService.list(req.auth!, res.locals.query)));
lifecycleRouter.post('/onboarding', onbManage, validate(createOnboardingPlanSchema), async (req, res: Response) => res.status(201).json({ data: await onboardingService.create(req.body, actor(req)) }));
lifecycleRouter.get('/onboarding/:id', onbView, async (req, res: Response) => res.json({ data: await onboardingService.get(req.auth!, req.params.id as string) }));
lifecycleRouter.post('/onboarding/:id/tasks', onbManage, validate(addPlanTaskSchema), async (req, res: Response) => res.status(201).json({ data: await onboardingService.addTask(req.params.id as string, req.body, actor(req)) }));
lifecycleRouter.post('/onboarding/:id/activate', onbManage, async (req, res: Response) => res.json({ data: await onboardingService.activate(req.params.id as string, actor(req)) }));
lifecycleRouter.post('/onboarding/:id/complete', onbManage, async (req, res: Response) => res.json({ data: await onboardingService.complete(req.params.id as string, actor(req)) }));
lifecycleRouter.post('/onboarding/:id/cancel', onbManage, async (req, res: Response) => res.json({ data: await onboardingService.cancel(req.params.id as string, actor(req)) }));
lifecycleRouter.patch('/onboarding-tasks/:id', onbAct, validate(updateTaskSchema), async (req, res: Response) => res.json({ data: await onboardingService.updateTask(req.params.id as string, req.body, actor(req)) }));

// ---------- probation ----------
lifecycleRouter.get('/probation/policies', probView, validate(z.object({ includeInactive: z.coerce.boolean().optional() }), 'query'), async (_req, res: Response) => res.json({ data: await probationService.policies(!!res.locals.query.includeInactive) }));
lifecycleRouter.post('/probation/policies', probManage, validate(createProbationPolicySchema), async (req, res: Response) => res.status(201).json({ data: await probationService.createPolicy(req.body, actor(req)) }));
lifecycleRouter.patch('/probation/policies/:id', probManage, validate(updateProbationPolicySchema), async (req, res: Response) => res.json({ data: await probationService.updatePolicy(req.params.id as string, req.body, actor(req)) }));
lifecycleRouter.get('/probation', probView, validate(probationListQuerySchema, 'query'), async (req, res: Response) => res.json(await probationService.list(req.auth!, res.locals.query)));
lifecycleRouter.post('/probation', probManage, validate(createProbationCaseSchema), async (req, res: Response) => res.status(201).json({ data: await probationService.create(req.body, actor(req)) }));
lifecycleRouter.get('/probation/:id', probView, async (req, res: Response) => res.json({ data: await probationService.get(req.auth!, req.params.id as string) }));
lifecycleRouter.post('/probation/:id/reviewer', probManage, validate(reassignProbationReviewerSchema), async (req, res: Response) => res.json({ data: await probationService.reassignReviewer(req.params.id as string, req.body.reviewerUserId, actor(req)) }));
lifecycleRouter.post('/probation/:id/reviews', probReview, validate(submitProbationReviewSchema), async (req, res: Response) => res.status(201).json({ data: await probationService.submitReview(req.params.id as string, req.body, actor(req)) }));
lifecycleRouter.post('/probation/:id/cancel', probManage, async (req, res: Response) => res.json({ data: await probationService.cancel(req.params.id as string, actor(req)) }));

// ---------- offboarding ----------
lifecycleRouter.get('/offboarding', offView, validate(offboardingListQuerySchema, 'query'), async (req, res: Response) => res.json(await offboardingService.list(req.auth!, res.locals.query)));
lifecycleRouter.post('/offboarding', offManage, validate(createOffboardingCaseSchema), async (req, res: Response) => res.status(201).json({ data: await offboardingService.create(req.body, actor(req)) }));
lifecycleRouter.get('/offboarding/:id', offView, async (req, res: Response) => res.json({ data: await offboardingService.get(req.auth!, req.params.id as string) }));
lifecycleRouter.patch('/offboarding/:id', offManage, validate(updateOffboardingCaseSchema), async (req, res: Response) => res.json({ data: await offboardingService.update(req.params.id as string, req.body, actor(req)) }));
lifecycleRouter.post('/offboarding/:id/tasks', offManage, validate(addPlanTaskSchema), async (req, res: Response) => res.status(201).json({ data: await offboardingService.addTask(req.params.id as string, req.body, actor(req)) }));
lifecycleRouter.post('/offboarding/:id/activate', offManage, async (req, res: Response) => res.json({ data: await offboardingService.activate(req.params.id as string, actor(req)) }));
lifecycleRouter.post('/offboarding/:id/cancel', offManage, async (req, res: Response) => res.json({ data: await offboardingService.cancel(req.params.id as string, actor(req)) }));
lifecycleRouter.post('/offboarding/:id/exit-interview', offManage, validate(exitInterviewSchema), async (req, res: Response) => res.json({ data: await offboardingService.recordExitInterview(req.params.id as string, req.body, actor(req)) }));
lifecycleRouter.post('/offboarding/:id/complete-separation', separation, validate(completeSeparationSchema), async (req, res: Response) => res.json({ data: await offboardingService.completeSeparation(req.params.id as string, req.body, actor(req)) }));
lifecycleRouter.patch('/offboarding-tasks/:id', offAct, validate(updateTaskSchema), async (req, res: Response) => res.json({ data: await offboardingService.updateTask(req.params.id as string, req.body, actor(req)) }));
