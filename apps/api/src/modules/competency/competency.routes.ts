import { Router, type Request, type Response } from 'express';
import {
  PERMISSIONS, assessmentListQuerySchema, assignAssessmentsSchema, competencyCycleListQuerySchema,
  competencyListQuerySchema, createCompetencyCategorySchema, createCompetencyCycleSchema, createCompetencySchema,
  createCompetencyScaleSchema, gapReportQuerySchema, managerAssessmentItemSchema, reassignReviewerSchema,
  selfAssessmentItemSchema, setJobRequirementSchema, skillGapQuerySchema, updateCompetencyCategorySchema,
  updateCompetencyCycleSchema, updateCompetencySchema, updateCompetencyScaleSchema,
} from '@hr/shared';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth';
import { requirePermission } from '../../middleware/permission';
import { validate } from '../../middleware/validate';
import { AppError } from '../../lib/errors';
import { requestMeta } from '../../services/audit/audit.service';
import { hasPermission } from '../../services/authorization/authorization.service';
import { competencyCategoryService, competencyScaleService, competencyService } from './competency-framework.service';
import { jobProfileService } from './job-profile.service';
import { competencyAssessmentService, competencyCycleService } from './competency-assessment.service';
import { skillGapService } from './skill-gap.service';

/**
 * Competency (Task 24).
 *
 * `competency.view` opens your own record and the aggregate reports; `competency.assess` lets you fill in the
 * assessments **assigned to you**; `competency.manage` owns the framework, the job profiles and the cycles. Reading
 * one person's assessment requires being that person, their snapshot reviewer, or managing the framework — a data
 * scope grants nothing, because what a reviewer wrote about somebody is not team data.
 */
const actor = (req: Request) => ({ auth: req.auth!, ...requestMeta(req) });
const id = (req: Request) => req.params.id as string;
const view = requirePermission(PERMISSIONS.COMPETENCY_VIEW);
const manage = requirePermission(PERMISSIONS.COMPETENCY_MANAGE);
const assess = requirePermission(PERMISSIONS.COMPETENCY_ASSESS);
/** Reading the framework is open to anybody who can see competency at all; changing it is not. */
const readFramework = requirePermission(PERMISSIONS.COMPETENCY_VIEW, PERMISSIONS.COMPETENCY_ASSESS, PERMISSIONS.COMPETENCY_MANAGE);

export const competencyRouter = Router();
competencyRouter.use(requireAuth);

// ---------- framework ----------
competencyRouter.get('/categories', readFramework, async (req, res) => res.json({ data: await competencyCategoryService.list(req.query.includeInactive === 'true') }));
competencyRouter.post('/categories', manage, validate(createCompetencyCategorySchema), async (req, res) => res.status(201).json({ data: await competencyCategoryService.create(req.body, actor(req)) }));
competencyRouter.patch('/categories/:id', manage, validate(updateCompetencyCategorySchema), async (req, res) => res.json({ data: await competencyCategoryService.update(id(req), req.body, actor(req)) }));

competencyRouter.get('/scales', readFramework, async (req, res) => res.json({ data: await competencyScaleService.list(req.query.includeInactive === 'true') }));
competencyRouter.post('/scales', manage, validate(createCompetencyScaleSchema), async (req, res) => res.status(201).json({ data: await competencyScaleService.create(req.body, actor(req)) }));
competencyRouter.patch('/scales/:id', manage, validate(updateCompetencyScaleSchema), async (req, res) => res.json({ data: await competencyScaleService.update(id(req), req.body, actor(req)) }));

competencyRouter.get('/competencies', readFramework, validate(competencyListQuerySchema, 'query'), async (_req, res: Response) => res.json(await competencyService.list(res.locals.query)));
competencyRouter.get('/competencies/:id', readFramework, async (req, res) => res.json({ data: await competencyService.get(id(req)) }));
competencyRouter.post('/competencies', manage, validate(createCompetencySchema), async (req, res) => res.status(201).json({ data: await competencyService.create(req.body, actor(req)) }));
competencyRouter.patch('/competencies/:id', manage, validate(updateCompetencySchema), async (req, res) => res.json({ data: await competencyService.update(id(req), req.body, actor(req)) }));

// ---------- job competency profiles ----------
competencyRouter.get('/jobs/:id/profile', readFramework, async (req, res) => res.json({ data: await jobProfileService.get(id(req)) }));
competencyRouter.put('/jobs/:id/profile', manage, validate(setJobRequirementSchema), async (req, res) => res.json({ data: await jobProfileService.setRequirement(id(req), req.body, actor(req)) }));
competencyRouter.delete('/jobs/:id/profile/:competencyId', manage, async (req, res) =>
  res.json({ data: await jobProfileService.removeRequirement(id(req), req.params.competencyId as string, actor(req)) }));

// ---------- assessment cycles ----------
competencyRouter.get('/cycles', readFramework, validate(competencyCycleListQuerySchema, 'query'), async (_req, res: Response) => res.json(await competencyCycleService.list(res.locals.query)));
competencyRouter.get('/cycles/:id', readFramework, async (req, res) => res.json({ data: await competencyCycleService.get(id(req)) }));
competencyRouter.post('/cycles', manage, validate(createCompetencyCycleSchema), async (req, res) => res.status(201).json({ data: await competencyCycleService.create(req.body, actor(req)) }));
competencyRouter.patch('/cycles/:id', manage, validate(updateCompetencyCycleSchema), async (req, res) => res.json({ data: await competencyCycleService.update(id(req), req.body, actor(req)) }));
competencyRouter.post('/cycles/:id/activate', manage, async (req, res) => res.json({ data: await competencyCycleService.transition(id(req), 'ACTIVE', actor(req)) }));
competencyRouter.post('/cycles/:id/open-review', manage, async (req, res) => res.json({ data: await competencyCycleService.transition(id(req), 'REVIEW', actor(req)) }));
competencyRouter.post('/cycles/:id/close', manage, async (req, res) => res.json({ data: await competencyCycleService.transition(id(req), 'CLOSED', actor(req)) }));
competencyRouter.post('/cycles/:id/assign', manage, validate(assignAssessmentsSchema), async (req, res) =>
  res.status(201).json({ data: await competencyAssessmentService.assign(id(req), req.body, actor(req)) }));

// ---------- assessments ----------
competencyRouter.get('/assessments', view, validate(assessmentListQuerySchema, 'query'), async (req, res: Response) => res.json(await competencyAssessmentService.list(req.auth!, res.locals.query)));
competencyRouter.get('/assessments/:id', view, async (req, res) => res.json({ data: await competencyAssessmentService.get(req.auth!, id(req)) }));
competencyRouter.patch('/assessments/:id/reviewer', manage, validate(reassignReviewerSchema), async (req, res) =>
  res.json({ data: await competencyAssessmentService.reassignReviewer(id(req), req.body, actor(req)) }));

competencyRouter.patch('/items/:id/self', view, validate(selfAssessmentItemSchema), async (req, res) => res.json({ data: await competencyAssessmentService.selfAssess(req.auth!, id(req), req.body) }));
competencyRouter.post('/assessments/:id/submit-self', view, async (req, res) => res.json({ data: await competencyAssessmentService.submitSelf(req.auth!, id(req), actor(req)) }));
competencyRouter.patch('/items/:id/manager', assess, validate(managerAssessmentItemSchema), async (req, res) => res.json({ data: await competencyAssessmentService.managerAssess(req.auth!, id(req), req.body) }));
competencyRouter.post('/assessments/:id/submit-manager', assess, async (req, res) => res.json({ data: await competencyAssessmentService.submitManager(req.auth!, id(req), actor(req)) }));

// ---------- skill profile and gaps ----------
/** An employee's own profile needs nothing; somebody else's needs `competency.manage`. */
competencyRouter.get('/profile/me', view, async (req, res) => {
  if (!req.auth!.employeeId) throw new AppError(409, 'EMPLOYEE_PROFILE_REQUIRED', 'This account is not linked to an employee record');
  res.json({ data: await skillGapService.profileFor(req.auth!.employeeId) });
});
competencyRouter.get('/profile/:employeeId', view, async (req, res) => {
  const employeeId = req.params.employeeId as string;
  if (employeeId !== req.auth!.employeeId && !hasPermission(req.auth!, PERMISSIONS.COMPETENCY_MANAGE)) throw AppError.forbidden();
  res.json({ data: await skillGapService.profileFor(employeeId) });
});

/**
 * Organization gap report (Task 47, T44-P1-05): a reporting authority with an organization-wide scope — an aggregate over a
 * small department is somebody's assessment, so `competency.view` (every employee) no longer opens it. Small groups are
 * suppressed in the service.
 */
competencyRouter.get('/reports/gaps', requirePermission(PERMISSIONS.COMPETENCY_VIEW_REPORTS), validate(gapReportQuerySchema, 'query'), async (req, res: Response) => {
  if (req.auth!.dataScope !== 'ALL') throw AppError.forbidden('Organization competency reports need an organization-wide scope');
  res.json({ data: await skillGapService.gapReport(res.locals.query) });
});

/**
 * The development hand-off. Task 25 reads gaps from here rather than recalculating them, so there is one definition
 * of a gap in the system.
 */
competencyRouter.get('/skill-gaps', manage, validate(skillGapQuerySchema, 'query'), async (_req, res: Response) =>
  res.json({ data: await skillGapService.getSkillGapsForDevelopment(res.locals.query) }));

/** Employees for a competency picker — behind `competency.manage`, for the same reason payroll has its own. */
competencyRouter.get(
  '/employee-options',
  manage,
  validate(z.object({ search: z.string().trim().max(100).optional(), limit: z.coerce.number().int().min(1).max(50).default(20) }), 'query'),
  async (_req, res: Response) => {
    const terms = (res.locals.query.search ?? '').split(/\s+/).filter(Boolean);
    const { prisma } = await import('../../lib/prisma');
    const rows = await prisma.employee.findMany({
      where: {
        employmentStatus: 'ACTIVE',
        AND: terms.map((t: string) => ({
          OR: [
            { employeeCode: { contains: t, mode: 'insensitive' as const } },
            { firstName: { contains: t, mode: 'insensitive' as const } },
            { lastName: { contains: t, mode: 'insensitive' as const } },
          ],
        })),
      },
      select: { id: true, employeeCode: true, firstName: true, lastName: true, position: { select: { title: true, job: { select: { title: true } } } } },
      orderBy: { employeeCode: 'asc' },
      take: res.locals.query.limit,
    });
    res.json({ data: rows });
  },
);
