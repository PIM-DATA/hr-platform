import { Router, type Request, type Response } from 'express';
import { PERMISSIONS, addSurveyQuestionSchema, assignAudienceSchema, breakdownQuerySchema, createQuestionBankSchema, createSurveySchema, duplicateSurveySchema, participationQuerySchema, questionBankListQuerySchema, resultsFilterSchema, submitResponseSchema, surveyListQuerySchema, updateQuestionBankSchema, updateSurveyQuestionSchema, updateSurveySchema, reportFileName } from '@hr/shared';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth';
import { requirePermission } from '../../middleware/permission';
import { validate } from '../../middleware/validate';
import { requestMeta } from '../../services/audit/audit.service';
import { prisma } from '../../lib/prisma';
import { questionBankService, surveyService } from './survey.service';
import { responseService } from './response.service';
import { resultsService } from './results.service';

/**
 * Engagement (Task 33). respond → my surveys and one submission; view_results → aggregates in the data scope;
 * manage → everything administrative, participation, identified respondent detail and closed anonymous comments.
 */
const actor = (req: Request) => ({ auth: req.auth!, ...requestMeta(req) });
const respond = requirePermission(PERMISSIONS.ENGAGEMENT_RESPOND);
const view = requirePermission(PERMISSIONS.ENGAGEMENT_VIEW_RESULTS, PERMISSIONS.ENGAGEMENT_MANAGE);
const manage = requirePermission(PERMISSIONS.ENGAGEMENT_MANAGE);

export const engagementRouter = Router();
engagementRouter.use(requireAuth);

// ---------- employee ----------
engagementRouter.get('/my/surveys', respond, async (req, res: Response) => res.json({ data: await responseService.mine(req.auth!) }));
engagementRouter.get('/my/surveys/:id', respond, async (req, res: Response) => res.json({ data: await responseService.form(req.auth!, req.params.id as string) }));
engagementRouter.post('/my/surveys/:id/responses', respond, validate(submitResponseSchema), async (req, res: Response) => res.status(201).json({ data: await responseService.submit(req.params.id as string, req.body, actor(req)) }));

// ---------- question bank ----------
engagementRouter.get('/questions', manage, validate(questionBankListQuerySchema, 'query'), async (_req, res: Response) => res.json({ data: await questionBankService.list(res.locals.query) }));
engagementRouter.post('/questions', manage, validate(createQuestionBankSchema), async (req, res: Response) => res.status(201).json({ data: await questionBankService.create(req.body, actor(req)) }));
engagementRouter.patch('/questions/:id', manage, validate(updateQuestionBankSchema), async (req, res: Response) => res.json({ data: await questionBankService.update(req.params.id as string, req.body, actor(req)) }));

// ---------- reference data (names for filters; results readers need them too) ----------
engagementRouter.get('/options', view, async (_req, res: Response) => {
  const [organizations, departments, jobs, positions] = await Promise.all([
    prisma.organization.findMany({ where: { isActive: true }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
    prisma.department.findMany({ where: { isActive: true }, select: { id: true, name: true, organizationId: true }, orderBy: { name: 'asc' } }),
    prisma.job.findMany({ where: { isActive: true }, select: { id: true, title: true }, orderBy: { title: 'asc' } }),
    prisma.position.findMany({ where: { isActive: true }, select: { id: true, title: true, code: true, departmentId: true }, orderBy: { title: 'asc' }, take: 2000 }),
  ]);
  res.json({ data: { organizations, departments, jobs, positions } });
});

// ---------- dashboard and results (view_results, scope inside) ----------
engagementRouter.get('/dashboard', view, async (req, res: Response) => res.json({ data: await resultsService.dashboard(req.auth!) }));
engagementRouter.get('/surveys', view, validate(surveyListQuerySchema, 'query'), async (req, res: Response) => res.json(await surveyService.list(req.auth!, res.locals.query)));
engagementRouter.get('/surveys/:id', view, async (req, res: Response) => res.json({ data: await surveyService.get(req.auth!, req.params.id as string) }));
engagementRouter.get('/surveys/:id/results', view, validate(resultsFilterSchema, 'query'), async (req, res: Response) => res.json({ data: await resultsService.overview(req.auth!, req.params.id as string, res.locals.query) }));
engagementRouter.get('/surveys/:id/breakdown', view, validate(breakdownQuerySchema, 'query'), async (req, res: Response) => { const { by, ...filter } = res.locals.query as { by: 'department' | 'job' | 'organization' } & Record<string, string>; res.json({ data: await resultsService.breakdown(req.auth!, req.params.id as string, by, filter) }); });
engagementRouter.get('/surveys/:id/results.csv', view, validate(resultsFilterSchema, 'query'), async (req, res: Response) => {
  const csv = await resultsService.csv(req.auth!, req.params.id as string, res.locals.query);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8'); res.setHeader('Content-Disposition', `attachment; filename="${reportFileName('engagement-results')}"`); res.send(`﻿${csv}`);
});

// ---------- administration ----------
engagementRouter.post('/surveys', manage, validate(createSurveySchema), async (req, res: Response) => res.status(201).json({ data: await surveyService.create(req.body, actor(req)) }));
engagementRouter.patch('/surveys/:id', manage, validate(updateSurveySchema), async (req, res: Response) => res.json({ data: await surveyService.update(req.params.id as string, req.body, actor(req)) }));
engagementRouter.delete('/surveys/:id', manage, async (req, res: Response) => { await surveyService.deleteDraft(req.params.id as string, actor(req)); res.status(204).end(); });
engagementRouter.post('/surveys/:id/duplicate', manage, validate(duplicateSurveySchema), async (req, res: Response) => res.status(201).json({ data: await surveyService.duplicate(req.params.id as string, req.body.code, req.body.name, actor(req)) }));
engagementRouter.post('/surveys/:id/questions', manage, validate(addSurveyQuestionSchema), async (req, res: Response) => res.status(201).json({ data: await surveyService.addQuestion(req.params.id as string, req.body, actor(req)) }));
engagementRouter.patch('/surveys/:id/questions/:qid', manage, validate(updateSurveyQuestionSchema), async (req, res: Response) => res.json({ data: await surveyService.updateQuestion(req.params.id as string, req.params.qid as string, req.body, actor(req)) }));
engagementRouter.delete('/surveys/:id/questions/:qid', manage, async (req, res: Response) => { await surveyService.removeQuestion(req.params.id as string, req.params.qid as string, actor(req)); res.status(204).end(); });
engagementRouter.put('/surveys/:id/audience', manage, validate(assignAudienceSchema), async (req, res: Response) => res.json({ data: await surveyService.assignAudience(req.params.id as string, req.body, actor(req)) }));
engagementRouter.post('/surveys/:id/open', manage, async (req, res: Response) => res.json({ data: await surveyService.open(req.params.id as string, actor(req)) }));
engagementRouter.post('/surveys/:id/close', manage, async (req, res: Response) => res.json({ data: await surveyService.close(req.params.id as string, actor(req)) }));
engagementRouter.post('/surveys/:id/archive', manage, async (req, res: Response) => res.json({ data: await surveyService.archive(req.params.id as string, actor(req)) }));
engagementRouter.get('/surveys/:id/participation', manage, validate(participationQuerySchema, 'query'), async (req, res: Response) => res.json(await responseService.participation(req.params.id as string, res.locals.query)));
engagementRouter.get('/surveys/:id/comments', manage, validate(z.object({ questionId: z.string().min(1).optional() }), 'query'), async (req, res: Response) => res.json({ data: await resultsService.comments(actor(req), req.params.id as string, res.locals.query.questionId) }));
engagementRouter.get('/surveys/:id/responses', manage, async (req, res: Response) => res.json({ data: await resultsService.identifiedResponses(actor(req), req.params.id as string) }));
