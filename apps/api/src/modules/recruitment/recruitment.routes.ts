import { Router, type Request, type Response } from 'express';
import {
  PERMISSIONS, applicationListQuerySchema, candidateListQuerySchema, createApplicationSchema, createCandidateSchema, createOfferSchema, createOpeningSchema,
  createRequisitionSchema, hireCandidateSchema, interviewListQuerySchema, moveStageSchema, offerListQuerySchema, openingListQuerySchema, recruitmentReportQuerySchema,
  rejectApplicationSchema, requisitionListQuerySchema, scheduleInterviewSchema, submitFeedbackSchema, updateCandidateSchema, updateInterviewSchema, updateOfferSchema,
  updateOpeningSchema, updateRequisitionSchema, upsertRecruitmentPolicySchema, withdrawApplicationSchema,
} from '@hr/shared';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth';
import { requirePermission } from '../../middleware/permission';
import { validate } from '../../middleware/validate';
import { requestMeta } from '../../services/audit/audit.service';
import { prisma } from '../../lib/prisma';
import { recruitmentPolicyService } from './policy.service';
import { requisitionService } from './requisition.service';
import { openingService } from './opening.service';
import { candidateService } from './candidate.service';
import { applicationService } from './application.service';
import { interviewService } from './interview.service';
import { offerService } from './offer.service';
import { hireService } from './hire.service';
import { recruitmentReportService } from './report.service';
import './recruitment.handlers'; // registers the workflow callbacks for module 'recruitment'

/**
 * Recruitment / ATS (Task 27).
 *
 * `recruitment.view` opens purpose-scoped reads (the hiring manager's own requisitions, openings and applications;
 * an interviewer's own interviews). `recruitment.manage` is the recruiter's desk. `recruitment.manage_offers` is
 * the only way to see a salary figure, `recruitment.hire` the only way to make an employee, and `privacy.export_data`
 * (on the privacy router) the only way to export a candidate. No data scope, team or seniority reaches a candidate.
 */
const actor = (req: Request) => ({ auth: req.auth!, ...requestMeta(req) });
const id = (req: Request) => req.params.id as string;
const view = requirePermission(PERMISSIONS.RECRUITMENT_VIEW, PERMISSIONS.RECRUITMENT_MANAGE);
const manage = requirePermission(PERMISSIONS.RECRUITMENT_MANAGE);
const interview = requirePermission(PERMISSIONS.RECRUITMENT_INTERVIEW, PERMISSIONS.RECRUITMENT_MANAGE);
const manageOffers = requirePermission(PERMISSIONS.RECRUITMENT_MANAGE_OFFERS);
const hire = requirePermission(PERMISSIONS.RECRUITMENT_HIRE);
const optionsQuery = z.object({ search: z.string().trim().max(100).optional(), limit: z.coerce.number().int().min(1).max(50).default(20) });

export const recruitmentRouter = Router();
recruitmentRouter.use(requireAuth);

// ---------- policy and reference data ----------
recruitmentRouter.get('/policies', view, async (_req, res) => res.json({ data: await recruitmentPolicyService.list() }));
recruitmentRouter.put('/policies', manage, validate(upsertRecruitmentPolicySchema), async (req, res) => res.json({ data: await recruitmentPolicyService.upsert(req.body, actor(req)) }));

/** Masters for the forms — needs no organization permission: a recruiter picks a job without being an org admin. */
recruitmentRouter.get('/options', view, async (_req, res) => {
  const [organizations, departments, jobs, positions] = await Promise.all([
    prisma.organization.findMany({ where: { isActive: true }, select: { id: true, code: true, name: true, timezone: true }, orderBy: { name: 'asc' } }),
    prisma.department.findMany({ where: { isActive: true }, select: { id: true, code: true, name: true, organizationId: true }, orderBy: { name: 'asc' } }),
    prisma.job.findMany({ where: { isActive: true }, select: { id: true, code: true, title: true }, orderBy: { title: 'asc' } }),
    prisma.position.findMany({ where: { isActive: true }, select: { id: true, code: true, title: true, departmentId: true, jobId: true }, orderBy: { title: 'asc' } }),
  ]);
  res.json({ data: { organizations, departments, jobs, positions } });
});

recruitmentRouter.get('/employee-options', manage, validate(optionsQuery, 'query'), async (_req, res: Response) => {
  const terms = ((res.locals.query.search as string | undefined) ?? '').split(/\s+/).filter(Boolean);
  const rows = await prisma.employee.findMany({
    where: { employmentStatus: 'ACTIVE', AND: terms.map((t) => ({ OR: [{ employeeCode: { contains: t, mode: 'insensitive' as const } }, { firstName: { contains: t, mode: 'insensitive' as const } }, { lastName: { contains: t, mode: 'insensitive' as const } }] })) },
    select: { id: true, employeeCode: true, firstName: true, lastName: true, organization: { select: { id: true, code: true, name: true } }, department: { select: { id: true, code: true, name: true } } },
    orderBy: { employeeCode: 'asc' },
    take: res.locals.query.limit,
  });
  res.json({ data: rows });
});

/** Interviewers are users (they must be able to sign in and write feedback). Active accounts with an employee record. */
recruitmentRouter.get('/interviewer-options', manage, validate(optionsQuery, 'query'), async (_req, res: Response) => {
  const terms = ((res.locals.query.search as string | undefined) ?? '').split(/\s+/).filter(Boolean);
  const rows = await prisma.user.findMany({
    where: { isActive: true, employee: { is: { employmentStatus: 'ACTIVE', AND: terms.map((t) => ({ OR: [{ employeeCode: { contains: t, mode: 'insensitive' as const } }, { firstName: { contains: t, mode: 'insensitive' as const } }, { lastName: { contains: t, mode: 'insensitive' as const } }] })) } } },
    select: { id: true, email: true, employee: { select: { employeeCode: true, firstName: true, lastName: true, department: { select: { name: true } } } } },
    orderBy: { email: 'asc' },
    take: res.locals.query.limit,
  });
  res.json({ data: rows.map((u) => ({ userId: u.id, employeeCode: u.employee?.employeeCode ?? null, name: u.employee ? `${u.employee.firstName} ${u.employee.lastName}` : u.email, departmentName: u.employee?.department?.name ?? null })) });
});

// ---------- dashboard and reports ----------
recruitmentRouter.get('/dashboard', view, async (req, res) => res.json({ data: await recruitmentReportService.dashboard(req.auth!) }));
recruitmentRouter.get('/reports/summary', manage, validate(recruitmentReportQuerySchema, 'query'), async (_req, res: Response) => res.json({ data: await recruitmentReportService.report(res.locals.query) }));

// ---------- requisitions ----------
recruitmentRouter.get('/requisitions', view, validate(requisitionListQuerySchema, 'query'), async (req, res: Response) => res.json(await requisitionService.list(req.auth!, res.locals.query)));
recruitmentRouter.post('/requisitions', manage, validate(createRequisitionSchema), async (req, res) => res.status(201).json({ data: await requisitionService.create(req.body, actor(req)) }));
recruitmentRouter.get('/requisitions/:id', view, async (req, res) => res.json({ data: await requisitionService.get(req.auth!, id(req)) }));
recruitmentRouter.patch('/requisitions/:id', manage, validate(updateRequisitionSchema), async (req, res) => res.json({ data: await requisitionService.update(id(req), req.body, actor(req)) }));
recruitmentRouter.post('/requisitions/:id/submit', manage, async (req, res) => res.json({ data: await requisitionService.submit(id(req), actor(req)) }));
recruitmentRouter.post('/requisitions/:id/cancel', manage, async (req, res) => res.json({ data: await requisitionService.cancel(id(req), actor(req)) }));
recruitmentRouter.post('/requisitions/:id/close', manage, async (req, res) => res.json({ data: await requisitionService.close(id(req), actor(req)) }));

// ---------- openings ----------
recruitmentRouter.get('/openings', view, validate(openingListQuerySchema, 'query'), async (req, res: Response) => res.json(await openingService.list(req.auth!, res.locals.query)));
recruitmentRouter.post('/openings', manage, validate(createOpeningSchema), async (req, res) => res.status(201).json({ data: await openingService.create(req.body, actor(req)) }));
recruitmentRouter.get('/openings/:id', view, async (req, res) => res.json({ data: await openingService.get(req.auth!, id(req)) }));
recruitmentRouter.patch('/openings/:id', manage, validate(updateOpeningSchema), async (req, res) => res.json({ data: await openingService.update(id(req), req.body, actor(req)) }));
recruitmentRouter.post('/openings/:id/open', manage, async (req, res) => res.json({ data: await openingService.open(id(req), actor(req)) }));
recruitmentRouter.post('/openings/:id/hold', manage, async (req, res) => res.json({ data: await openingService.hold(id(req), actor(req)) }));
recruitmentRouter.post('/openings/:id/close', manage, async (req, res) => res.json({ data: await openingService.close(id(req), actor(req)) }));

// ---------- candidates (no delete endpoint, by design) ----------
recruitmentRouter.get('/candidates', view, validate(candidateListQuerySchema, 'query'), async (req, res: Response) => res.json(await candidateService.list(req.auth!, res.locals.query)));
recruitmentRouter.get('/candidates/duplicates', manage, validate(z.object({ email: z.string().trim().optional(), phone: z.string().trim().optional(), excludeId: z.string().optional() }), 'query'), async (_req, res: Response) =>
  res.json({ data: await candidateService.duplicates(res.locals.query.email, res.locals.query.phone, res.locals.query.excludeId ?? null) }));
recruitmentRouter.post('/candidates', manage, validate(createCandidateSchema), async (req, res) => {
  const result = await candidateService.create(req.body, actor(req));
  res.status(201).json({ data: result.candidate, meta: { duplicates: result.duplicates } });
});
recruitmentRouter.get('/candidates/:id', view, async (req, res) => res.json({ data: await candidateService.get(req.auth!, id(req)) }));
recruitmentRouter.patch('/candidates/:id', manage, validate(updateCandidateSchema), async (req, res) => res.json({ data: await candidateService.update(id(req), req.body, actor(req)) }));

// ---------- applications ----------
recruitmentRouter.get('/applications', view, validate(applicationListQuerySchema, 'query'), async (req, res: Response) => res.json(await applicationService.list(req.auth!, res.locals.query)));
recruitmentRouter.post('/applications', manage, validate(createApplicationSchema), async (req, res) => res.status(201).json({ data: await applicationService.create(req.body, actor(req)) }));
recruitmentRouter.get('/applications/:id', view, async (req, res) => res.json({ data: await applicationService.get(req.auth!, id(req)) }));
recruitmentRouter.post('/applications/:id/move-stage', manage, validate(moveStageSchema), async (req, res) => res.json({ data: await applicationService.moveStage(id(req), req.body, actor(req)) }));
recruitmentRouter.post('/applications/:id/reject', manage, validate(rejectApplicationSchema), async (req, res) => res.json({ data: await applicationService.reject(id(req), req.body, actor(req)) }));
recruitmentRouter.post('/applications/:id/withdraw', manage, validate(withdrawApplicationSchema), async (req, res) => res.json({ data: await applicationService.withdraw(id(req), req.body, actor(req)) }));
recruitmentRouter.post('/applications/:id/interviews', manage, validate(scheduleInterviewSchema), async (req, res) => res.status(201).json({ data: await interviewService.schedule(id(req), req.body, actor(req)) }));
/** The bridge to the employee master. `recruitment.hire` only — not manage, not offers. */
recruitmentRouter.post('/applications/:id/hire', hire, validate(hireCandidateSchema), async (req, res) => res.status(201).json({ data: await hireService.hire(id(req), req.body, actor(req)) }));

// ---------- interviews and feedback ----------
recruitmentRouter.get('/interviews', interview, validate(interviewListQuerySchema, 'query'), async (req, res: Response) => res.json(await interviewService.list(req.auth!, res.locals.query)));
recruitmentRouter.get('/interviews/:id', interview, async (req, res) => res.json({ data: await interviewService.get(req.auth!, id(req)) }));
recruitmentRouter.patch('/interviews/:id', manage, validate(updateInterviewSchema), async (req, res) => res.json({ data: await interviewService.update(id(req), req.body, actor(req)) }));
recruitmentRouter.post('/interviews/:id/feedback', interview, validate(submitFeedbackSchema), async (req, res) => res.status(201).json({ data: await interviewService.submitFeedback(id(req), req.body, actor(req)) }));

// ---------- offers ----------
recruitmentRouter.get('/offers', view, validate(offerListQuerySchema, 'query'), async (req, res: Response) => res.json(await offerService.list(req.auth!, res.locals.query)));
recruitmentRouter.post('/offers', manageOffers, validate(createOfferSchema), async (req, res) => res.status(201).json({ data: await offerService.create(req.body, actor(req)) }));
recruitmentRouter.get('/offers/:id', view, async (req, res) => res.json({ data: await offerService.get(req.auth!, id(req)) }));
recruitmentRouter.patch('/offers/:id', manageOffers, validate(updateOfferSchema), async (req, res) => res.json({ data: await offerService.update(id(req), req.body, actor(req)) }));
recruitmentRouter.post('/offers/:id/submit', manageOffers, async (req, res) => res.json({ data: await offerService.submit(id(req), actor(req)) }));
recruitmentRouter.post('/offers/:id/mark-sent', manageOffers, async (req, res) => res.json({ data: await offerService.markSent(id(req), actor(req)) }));
recruitmentRouter.post('/offers/:id/record-accepted', manageOffers, async (req, res) => res.json({ data: await offerService.recordOutcome(id(req), 'ACCEPTED', actor(req)) }));
recruitmentRouter.post('/offers/:id/record-declined', manageOffers, async (req, res) => res.json({ data: await offerService.recordOutcome(id(req), 'DECLINED', actor(req)) }));
recruitmentRouter.post('/offers/:id/withdraw', manageOffers, async (req, res) => res.json({ data: await offerService.withdraw(id(req), actor(req)) }));
