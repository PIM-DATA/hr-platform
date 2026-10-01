import { Router, type Request, type Response } from 'express';
import {
  PERMISSIONS, addCareerStepSchema, addPoolMemberSchema, assignTalentReviewsSchema, createCareerPathSchema, createDevelopmentActionSchema, createSuccessionPlanSchema,
  createTalentCycleSchema, createTalentPoolSchema, nominateSuccessorSchema, reassignTalentReviewerSchema, removePoolMemberSchema, removeSuccessorSchema, setBucketRulesSchema,
  submitPotentialSchema, successionListQuerySchema, talentCycleListQuerySchema, talentReviewListQuerySchema, updateCareerPathSchema, updateSuccessionPlanSchema,
  updateSuccessorSchema, updateTalentCycleSchema, updateTalentPoolSchema,
} from '@hr/shared';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth';
import { requirePermission } from '../../middleware/permission';
import { validate } from '../../middleware/validate';
import { requestMeta } from '../../services/audit/audit.service';
import { AppError } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { hasPermission, scopeFor } from '../../services/authorization/authorization.service';
import { careerService } from './career.service';
import { talentCycleService } from './talent-cycle.service';
import { talentPoolService } from './talent-pool.service';
import { successionService } from './succession.service';
import { developmentService } from './development.service';
import { talentReportService } from './talent-report.service';

/**
 * Career, talent and succession (Task 28).
 *
 * `career.view` opens the caller's OWN career page and nothing about anybody else. `talent.view` + TEAM scope shows a
 * manager their team's cells; writing a potential assessment needs `talent.assess` AND being the assigned reviewer.
 * `talent.manage` / `succession.manage` are the administrative desks. `talent.view_reports` is aggregate-only.
 * No data scope grants succession administration, and an employee never sees a 9-box, a nomination or a comment.
 */
const actor = (req: Request) => ({ auth: req.auth!, ...requestMeta(req) });
const id = (req: Request) => req.params.id as string;
const careerView = requirePermission(PERMISSIONS.CAREER_VIEW, PERMISSIONS.CAREER_MANAGE);
const careerManage = requirePermission(PERMISSIONS.CAREER_MANAGE);
const talentView = requirePermission(PERMISSIONS.TALENT_VIEW, PERMISSIONS.TALENT_MANAGE);
const talentAssess = requirePermission(PERMISSIONS.TALENT_ASSESS, PERMISSIONS.TALENT_MANAGE);
const talentManage = requirePermission(PERMISSIONS.TALENT_MANAGE);
const reports = requirePermission(PERMISSIONS.TALENT_VIEW_REPORTS);
const successionView = requirePermission(PERMISSIONS.SUCCESSION_VIEW, PERMISSIONS.SUCCESSION_MANAGE);
const successionManage = requirePermission(PERMISSIONS.SUCCESSION_MANAGE);

const requireEmployee = (req: Request) => {
  if (!req.auth!.employeeId) throw new AppError(409, 'EMPLOYEE_PROFILE_REQUIRED', 'This account is not linked to an employee record');
  return req.auth!.employeeId;
};
/** Somebody else's readiness needs an administrative permission; a manager gets their direct reports. */
async function assertMayReadEmployee(req: Request, employeeId: string) {
  const auth = req.auth!;
  if (employeeId === auth.employeeId) return;
  if (hasPermission(auth, PERMISSIONS.TALENT_MANAGE) || hasPermission(auth, PERMISSIONS.SUCCESSION_MANAGE) || hasPermission(auth, PERMISSIONS.CAREER_MANAGE)) return;
  if (auth.employeeId && ['TEAM', 'ALL'].includes(scopeFor(auth, PERMISSIONS.TALENT_VIEW) ?? '')) { // Task 50: talent.view's own scope
    const report = await prisma.employee.findFirst({ where: { id: employeeId, managerId: auth.employeeId }, select: { id: true } });
    if (report) return;
  }
  throw new AppError(404, 'EMPLOYEE_NOT_FOUND', 'Employee not found');
}

export const talentRouter = Router();
talentRouter.use(requireAuth);

// ---------- career ----------
talentRouter.get('/career/me', careerView, async (req, res) => res.json({ data: await careerService.myCareer(requireEmployee(req)) }));
talentRouter.get('/career/readiness', careerView, validate(z.object({ employeeId: z.string().min(1).optional(), targetJobId: z.string().min(1) }), 'query'), async (req, res: Response) => {
  const employeeId = (res.locals.query.employeeId as string | undefined) ?? requireEmployee(req);
  await assertMayReadEmployee(req, employeeId);
  res.json({ data: await careerService.getCareerReadiness({ employeeId, targetJobId: res.locals.query.targetJobId }) });
});
talentRouter.get('/career/team', talentView, async (req, res) => res.json({ data: await careerService.teamSummary(req.auth!) }));
talentRouter.get('/career/paths', careerView, async (req, res) => res.json({ data: await careerService.listPaths(req.query.includeInactive === 'true' && hasPermission(req.auth!, PERMISSIONS.CAREER_MANAGE), typeof req.query.organizationId === 'string' ? req.query.organizationId : undefined) }));
talentRouter.post('/career/paths', careerManage, validate(createCareerPathSchema), async (req, res) => res.status(201).json({ data: await careerService.createPath(req.body, actor(req)) }));
talentRouter.get('/career/paths/:id', careerView, async (req, res) => res.json({ data: await careerService.getPath(id(req)) }));
talentRouter.patch('/career/paths/:id', careerManage, validate(updateCareerPathSchema), async (req, res) => res.json({ data: await careerService.updatePath(id(req), req.body, actor(req)) }));
talentRouter.post('/career/paths/:id/steps', careerManage, validate(addCareerStepSchema), async (req, res) => res.status(201).json({ data: await careerService.addStep(id(req), req.body, actor(req)) }));
talentRouter.delete('/career/paths/:id/steps/:stepId', careerManage, async (req, res) => res.json({ data: await careerService.removeStep(id(req), req.params.stepId as string, actor(req)) }));
talentRouter.get('/career/job-options', careerView, async (_req, res) => res.json({ data: await prisma.job.findMany({ where: { isActive: true }, select: { id: true, code: true, title: true }, orderBy: { title: 'asc' } }) }));

// ---------- talent cycles and reviews ----------
talentRouter.get('/cycles', talentView, validate(talentCycleListQuerySchema, 'query'), async (_req, res: Response) => res.json(await talentCycleService.list(res.locals.query)));
talentRouter.post('/cycles', talentManage, validate(createTalentCycleSchema), async (req, res) => res.status(201).json({ data: await talentCycleService.create(req.body, actor(req)) }));
talentRouter.get('/cycles/:id', talentView, async (req, res) => res.json({ data: await talentCycleService.get(id(req)) }));
talentRouter.patch('/cycles/:id', talentManage, validate(updateTalentCycleSchema), async (req, res) => res.json({ data: await talentCycleService.update(id(req), req.body, actor(req)) }));
talentRouter.put('/cycles/:id/bucket-rules', talentManage, validate(setBucketRulesSchema), async (req, res) => res.json({ data: await talentCycleService.setBucketRules(id(req), req.body, actor(req)) }));
talentRouter.post('/cycles/:id/activate', talentManage, async (req, res) => res.json({ data: await talentCycleService.activate(id(req), actor(req)) }));
talentRouter.post('/cycles/:id/open-review', talentManage, async (req, res) => res.json({ data: await talentCycleService.openReview(id(req), actor(req)) }));
talentRouter.post('/cycles/:id/close', talentManage, async (req, res) => res.json({ data: await talentCycleService.close(id(req), actor(req)) }));
talentRouter.post('/cycles/:id/assign', talentManage, validate(assignTalentReviewsSchema), async (req, res) => res.json({ data: await talentCycleService.assign(id(req), req.body, actor(req)) }));
/** The 9-box: counts per cell for managers of the cycle; the same counts, and nothing else, for report readers. */
talentRouter.get('/cycles/:id/nine-box', requirePermission(PERMISSIONS.TALENT_VIEW, PERMISSIONS.TALENT_MANAGE, PERMISSIONS.TALENT_VIEW_REPORTS), async (req, res) => res.json({ data: await talentCycleService.nineBox(id(req)) }));
talentRouter.get('/reviews', talentView, validate(talentReviewListQuerySchema, 'query'), async (req, res: Response) => res.json(await talentCycleService.listReviews(req.auth!, res.locals.query)));
talentRouter.get('/reviews/:id', talentView, async (req, res) => res.json({ data: await talentCycleService.getReview(req.auth!, id(req)) }));
talentRouter.get('/reviews/:id/context', talentView, async (req, res) => res.json({ data: await talentCycleService.reviewContext(req.auth!, id(req)) }));
talentRouter.post('/reviews/:id/reassign', talentManage, validate(reassignTalentReviewerSchema), async (req, res) => res.json({ data: await talentCycleService.reassignReviewer(id(req), req.body.reviewerEmployeeId, actor(req)) }));
talentRouter.post('/reviews/:id/potential', talentAssess, validate(submitPotentialSchema), async (req, res) => res.json({ data: await talentCycleService.submitPotential(id(req), req.body, actor(req)) }));

// ---------- talent pools ----------
talentRouter.get('/pools', talentView, async (req, res) => res.json({ data: await talentPoolService.list(req.query.includeInactive === 'true') }));
talentRouter.post('/pools', talentManage, validate(createTalentPoolSchema), async (req, res) => res.status(201).json({ data: await talentPoolService.create(req.body, actor(req)) }));
talentRouter.get('/pools/:id', talentView, async (req, res) => res.json({ data: await talentPoolService.get(id(req)) }));
talentRouter.patch('/pools/:id', talentManage, validate(updateTalentPoolSchema), async (req, res) => res.json({ data: await talentPoolService.update(id(req), req.body, actor(req)) }));
talentRouter.get('/pools/:id/members', talentManage, async (req, res) => res.json({ data: await talentPoolService.members(id(req), req.query.includeRemoved === 'true') }));
talentRouter.post('/pools/:id/members', talentManage, validate(addPoolMemberSchema), async (req, res) => res.status(201).json({ data: await talentPoolService.addMember(id(req), req.body, actor(req)) }));
talentRouter.post('/pools/:id/members/:memberId/remove', talentManage, validate(removePoolMemberSchema), async (req, res) => res.json({ data: await talentPoolService.removeMember(id(req), req.params.memberId as string, req.body, actor(req)) }));

// ---------- succession ----------
talentRouter.get('/succession/plans', successionView, validate(successionListQuerySchema, 'query'), async (req, res: Response) => res.json(await successionService.list(req.auth!, res.locals.query)));
talentRouter.post('/succession/plans', successionManage, validate(createSuccessionPlanSchema), async (req, res) => res.status(201).json({ data: await successionService.create(req.body, actor(req)) }));
talentRouter.get('/succession/plans/:id', successionView, async (req, res) => res.json({ data: await successionService.get(req.auth!, id(req)) }));
talentRouter.patch('/succession/plans/:id', successionManage, validate(updateSuccessionPlanSchema), async (req, res) => res.json({ data: await successionService.update(id(req), req.body, actor(req)) }));
talentRouter.post('/succession/plans/:id/candidates', successionManage, validate(nominateSuccessorSchema), async (req, res) => res.status(201).json({ data: await successionService.nominate(id(req), req.body, actor(req)) }));
talentRouter.patch('/succession/candidates/:id', successionManage, validate(updateSuccessorSchema), async (req, res) => res.json({ data: await successionService.updateCandidate(id(req), req.body, actor(req)) }));
talentRouter.post('/succession/candidates/:id/remove', successionManage, validate(removeSuccessorSchema), async (req, res) => res.json({ data: await successionService.removeCandidate(id(req), req.body, actor(req)) }));
talentRouter.get('/succession/candidates/:id/context', successionView, async (req, res) => res.json({ data: await successionService.candidateContext(req.auth!, id(req)) }));
talentRouter.get('/succession/position-options', successionManage, validate(z.object({ search: z.string().trim().max(100).optional() }), 'query'), async (_req, res: Response) => {
  const term = (res.locals.query.search as string | undefined) ?? '';
  res.json({ data: await prisma.position.findMany({ where: { isActive: true, ...(term ? { OR: [{ code: { contains: term, mode: 'insensitive' } }, { title: { contains: term, mode: 'insensitive' } }] } : {}) }, select: { id: true, code: true, title: true, department: { select: { name: true } }, job: { select: { title: true } } }, orderBy: { title: 'asc' }, take: 30 }) });
});
talentRouter.get('/employee-options', requirePermission(PERMISSIONS.TALENT_MANAGE, PERMISSIONS.SUCCESSION_MANAGE), validate(z.object({ search: z.string().trim().max(100).optional(), limit: z.coerce.number().int().min(1).max(50).default(20) }), 'query'), async (_req, res: Response) => {
  const terms = ((res.locals.query.search as string | undefined) ?? '').split(/\s+/).filter(Boolean);
  res.json({ data: await prisma.employee.findMany({ where: { employmentStatus: 'ACTIVE', AND: terms.map((t) => ({ OR: [{ employeeCode: { contains: t, mode: 'insensitive' as const } }, { firstName: { contains: t, mode: 'insensitive' as const } }, { lastName: { contains: t, mode: 'insensitive' as const } }] })) }, select: { id: true, employeeCode: true, firstName: true, lastName: true, organization: { select: { id: true, code: true, name: true } }, department: { select: { id: true, code: true, name: true } } }, orderBy: { employeeCode: 'asc' }, take: res.locals.query.limit }) });
});

// ---------- development handoff and summary ----------
talentRouter.post('/development-actions', requirePermission(PERMISSIONS.TALENT_MANAGE, PERMISSIONS.SUCCESSION_MANAGE), validate(createDevelopmentActionSchema), async (req, res) => res.status(201).json({ data: await developmentService.createAction(req.body, actor(req)) }));
talentRouter.get('/summary/:employeeId', talentView, async (req, res) => { await assertMayReadEmployee(req, req.params.employeeId as string); res.json({ data: await developmentService.getTalentSummary(req.params.employeeId as string) }); });

// ---------- aggregate reports ----------
talentRouter.get('/reports/talent', reports, async (_req, res) => res.json({ data: await talentReportService.talent() }));
talentRouter.get('/reports/succession', reports, async (_req, res) => res.json({ data: await talentReportService.succession() }));
