import { AUDIT_ACTIONS, NOTIFICATION_TYPES, ANONYMITY_GROUP_SIZE, responseRate, type AddSurveyQuestionInput, type AssignAudienceInput, type CreateQuestionBankInput, type CreateSurveyInput, type QuestionBankDto, type QuestionConfig, type SurveyDetailDto, type SurveyDto, type SurveyListQuery, type UpdateQuestionBankInput, type UpdateSurveyInput, type UpdateSurveyQuestionInput } from '@hr/shared';
import type { Prisma } from '@prisma/client';
import { AppError } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { auditService } from '../../services/audit/audit.service';
import { notificationService } from '../../services/notification/notification.service';
import type { AuthContext } from '../auth/auth.types';
import { canManage, engagementAudit, lockSurvey, notFound, questionDto, scaleFor, textAudit, type Actor, type Db } from './engagement.types';

/**
 * Surveys: the question bank, the survey with its frozen question snapshots, the audience, and the lifecycle
 * DRAFT → OPEN → CLOSED → ARCHIVED. Opening freezes everything (mode, threshold, questions, audience) and is the
 * one moment anonymity is checked against the audience size. HR opens and closes by hand; nothing is scheduled.
 */
const surveyInclude = { _count: { select: { questions: true, assignments: true } } } as const;
type SurveyRow = Prisma.EngagementSurveyGetPayload<{ include: typeof surveyInclude }>;

async function surveyDto(db: Db, row: SurveyRow, auth: AuthContext): Promise<SurveyDto> {
  const [org, completed] = await Promise.all([row.organizationId ? db.organization.findUnique({ where: { id: row.organizationId }, select: { name: true } }) : null, db.engagementSurveyAssignment.count({ where: { surveyId: row.id, completedAt: { not: null } } })]);
  const manage = canManage(auth);
  return {
    id: row.id, code: row.code, name: row.name, description: row.description, organizationId: row.organizationId, organizationName: org?.name ?? null, surveyType: row.surveyType as SurveyDto['surveyType'], responseMode: row.responseMode as SurveyDto['responseMode'],
    minimumAnonymousGroupSize: row.minimumAnonymousGroupSize, periodStart: row.periodStart, periodEnd: row.periodEnd, status: row.status as SurveyDto['status'], questionCount: row._count.questions, audienceCount: row._count.assignments, completedCount: completed, responseRate: responseRate(completed, row._count.assignments),
    openedAt: row.openedAt?.toISOString() ?? null, closedAt: row.closedAt?.toISOString() ?? null, archivedAt: row.archivedAt?.toISOString() ?? null, duplicatedFromId: row.duplicatedFromId, createdByUserId: row.createdByUserId, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
    can: { edit: manage && row.status === 'DRAFT', open: manage && row.status === 'DRAFT', close: manage && row.status === 'OPEN' },
  };
}
export async function loadSurvey(db: Db, id: string) {
  const row = await db.engagementSurvey.findUnique({ where: { id }, include: surveyInclude });
  if (!row) throw notFound('survey');
  return row;
}
const assertDraft = (row: { status: string }) => { if (row.status !== 'DRAFT') throw new AppError(409, 'ENGAGEMENT_SURVEY_NOT_DRAFT', `A ${row.status.toLowerCase()} survey can no longer be changed`); };

const bankDto = (q: Prisma.EngagementQuestionGetPayload<{ include: { _count: { select: { surveyQuestions: true } } } }>): QuestionBankDto => ({ id: q.id, code: q.code, theme: q.theme, text: q.text, questionType: q.questionType as QuestionBankDto['questionType'], defaultRequired: q.defaultRequired, config: (q.config ?? {}) as QuestionConfig, isActive: q.isActive, usedBySurveys: q._count.surveyQuestions, createdAt: q.createdAt.toISOString(), updatedAt: q.updatedAt.toISOString() });

export const questionBankService = {
  async list(q: { includeInactive?: boolean; theme?: string; search?: string }): Promise<QuestionBankDto[]> {
    const rows = await prisma.engagementQuestion.findMany({ where: { ...(q.includeInactive ? {} : { isActive: true }), theme: q.theme, ...(q.search ? { OR: [{ text: { contains: q.search, mode: 'insensitive' } }, { code: { contains: q.search, mode: 'insensitive' } }] } : {}) }, include: { _count: { select: { surveyQuestions: true } } }, orderBy: [{ theme: 'asc' }, { code: 'asc' }] });
    return rows.map(bankDto);
  },
  async create(input: CreateQuestionBankInput, actor: Actor): Promise<QuestionBankDto> {
    if (await prisma.engagementQuestion.findUnique({ where: { code: input.code.toUpperCase() } })) throw new AppError(409, 'ENGAGEMENT_QUESTION_CODE_EXISTS', 'A question with this code already exists');
    const row = await prisma.$transaction(async (tx) => {
      const created = await tx.engagementQuestion.create({ data: { code: input.code.toUpperCase(), theme: input.theme ?? null, text: input.text, questionType: input.questionType, defaultRequired: input.required ?? true, config: (input.config ?? {}) as Prisma.InputJsonValue }, include: { _count: { select: { surveyQuestions: true } } } });
      await auditService.log(engagementAudit(actor, AUDIT_ACTIONS.CREATE_ENGAGEMENT_QUESTION, 'EngagementQuestion', created.id, { code: created.code, questionType: created.questionType, theme: created.theme, textLength: created.text.length }), tx);
      return created;
    });
    return bankDto(row);
  },
  async update(id: string, input: UpdateQuestionBankInput, actor: Actor): Promise<QuestionBankDto> {
    const row = await prisma.$transaction(async (tx) => {
      const before = await tx.engagementQuestion.findUnique({ where: { id } });
      if (!before) throw notFound('question');
      const after = await tx.engagementQuestion.update({ where: { id }, data: { text: input.text, theme: input.theme === undefined ? undefined : input.theme, defaultRequired: input.required, config: input.config === undefined ? undefined : (input.config as Prisma.InputJsonValue), isActive: input.isActive }, include: { _count: { select: { surveyQuestions: true } } } });
      await auditService.log(engagementAudit(actor, AUDIT_ACTIONS.UPDATE_ENGAGEMENT_QUESTION, 'EngagementQuestion', id, { fields: Object.keys(input), isActive: after.isActive, theme: after.theme, textLength: after.text.length }, { isActive: before.isActive, textLength: before.text.length }), tx);
      return after;
    });
    return bankDto(row);
  },
};

export const surveyService = {
  async list(auth: AuthContext, q: SurveyListQuery) {
    const where: Prisma.EngagementSurveyWhereInput = { status: q.status, organizationId: q.organizationId, surveyType: q.surveyType };
    const [total, rows] = await prisma.$transaction([prisma.engagementSurvey.count({ where }), prisma.engagementSurvey.findMany({ where, include: surveyInclude, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize })]);
    return { data: await Promise.all(rows.map((r) => surveyDto(prisma, r, auth))), meta: { page: q.page, pageSize: q.pageSize, total } };
  },
  async get(auth: AuthContext, id: string): Promise<SurveyDetailDto> {
    const row = await loadSurvey(prisma, id);
    const questions = await prisma.engagementSurveyQuestion.findMany({ where: { surveyId: id }, orderBy: [{ displayOrder: 'asc' }, { createdAt: 'asc' }] });
    return { ...(await surveyDto(prisma, row, auth)), questions: questions.map(questionDto) };
  },

  async create(input: CreateSurveyInput, actor: Actor): Promise<SurveyDto> {
    if (await prisma.engagementSurvey.findUnique({ where: { code: input.code.toUpperCase() } })) throw new AppError(409, 'ENGAGEMENT_SURVEY_CODE_EXISTS', 'A survey with this code already exists');
    if (input.organizationId && !(await prisma.organization.findUnique({ where: { id: input.organizationId }, select: { id: true } }))) throw new AppError(422, 'VALIDATION_ERROR', 'Unknown organization', [{ field: 'organizationId', message: 'Unknown organization' }]);
    const row = await prisma.$transaction(async (tx) => {
      const created = await tx.engagementSurvey.create({ data: { code: input.code.toUpperCase(), name: input.name, description: input.description ?? null, organizationId: input.organizationId ?? null, surveyType: input.surveyType, responseMode: input.responseMode, minimumAnonymousGroupSize: input.minimumAnonymousGroupSize ?? ANONYMITY_GROUP_SIZE.default, periodStart: input.periodStart ?? null, periodEnd: input.periodEnd ?? null, createdByUserId: actor.auth.userId }, include: surveyInclude });
      await auditService.log(engagementAudit(actor, AUDIT_ACTIONS.CREATE_ENGAGEMENT_SURVEY, 'EngagementSurvey', created.id, { code: created.code, name: created.name, surveyType: created.surveyType, responseMode: created.responseMode, minimumAnonymousGroupSize: created.minimumAnonymousGroupSize, organizationId: created.organizationId, ...textAudit('description', null, created.description) }), tx);
      return created;
    });
    return surveyDto(prisma, row, actor.auth);
  },
  async update(id: string, input: UpdateSurveyInput, actor: Actor): Promise<SurveyDto> {
    const row = await prisma.$transaction(async (tx) => {
      await lockSurvey(tx, id);
      const before = await loadSurvey(tx, id);
      if (before.status === 'ARCHIVED') throw new AppError(409, 'ENGAGEMENT_SURVEY_NOT_DRAFT', 'An archived survey cannot be changed');
      // Mode, threshold and type are fixed from OPEN on; name, description and dates stay editable for bookkeeping.
      if (before.status !== 'DRAFT' && (input.responseMode !== undefined || input.minimumAnonymousGroupSize !== undefined || input.surveyType !== undefined)) throw new AppError(409, 'ENGAGEMENT_SURVEY_MODE_IMMUTABLE', 'Response mode, anonymity threshold and type are frozen once a survey is open');
      const periodStart = input.periodStart === undefined ? before.periodStart : input.periodStart; const periodEnd = input.periodEnd === undefined ? before.periodEnd : input.periodEnd;
      if (periodStart && periodEnd && periodStart > periodEnd) throw new AppError(422, 'VALIDATION_ERROR', 'periodEnd must not be before periodStart', [{ field: 'periodEnd', message: 'Before the start' }]);
      const after = await tx.engagementSurvey.update({ where: { id }, data: { name: input.name, description: input.description === undefined ? undefined : input.description, surveyType: input.surveyType, responseMode: input.responseMode, minimumAnonymousGroupSize: input.minimumAnonymousGroupSize, periodStart, periodEnd }, include: surveyInclude });
      await auditService.log(engagementAudit(actor, AUDIT_ACTIONS.UPDATE_ENGAGEMENT_SURVEY, 'EngagementSurvey', id, { fields: Object.keys(input).filter((k) => k !== 'description'), responseMode: after.responseMode, minimumAnonymousGroupSize: after.minimumAnonymousGroupSize, periodStart, periodEnd, ...textAudit('description', before.description, after.description) }, { responseMode: before.responseMode, minimumAnonymousGroupSize: before.minimumAnonymousGroupSize }), tx);
      return after;
    });
    return surveyDto(prisma, row, actor.auth);
  },

  // ---------- questions (DRAFT only) ----------
  async addQuestion(surveyId: string, input: AddSurveyQuestionInput, actor: Actor) {
    return prisma.$transaction(async (tx) => {
      await lockSurvey(tx, surveyId);
      assertDraft(await loadSurvey(tx, surveyId));
      const source = input.sourceQuestionId ? await tx.engagementQuestion.findUnique({ where: { id: input.sourceQuestionId } }) : null;
      if (input.sourceQuestionId && !source) throw notFound('question');
      if (source && !source.isActive) throw new AppError(409, 'ENGAGEMENT_QUESTION_INACTIVE', 'That bank question is inactive');
      const questionType = input.questionType ?? source!.questionType;
      const config = (input.config ?? (source?.config as QuestionConfig | undefined) ?? {}) as QuestionConfig;
      const text = input.text ?? source!.text;
      const isEnpsPrimary = questionType === 'ENPS' && (input.isEnpsPrimary ?? !(await tx.engagementSurveyQuestion.findFirst({ where: { surveyId, isEnpsPrimary: true }, select: { id: true } })));
      if (isEnpsPrimary && (await tx.engagementSurveyQuestion.findFirst({ where: { surveyId, isEnpsPrimary: true }, select: { id: true } }))) throw new AppError(409, 'ENGAGEMENT_ENPS_PRIMARY_EXISTS', 'A survey has at most one primary eNPS question');
      const order = input.displayOrder ?? (((await tx.engagementSurveyQuestion.aggregate({ where: { surveyId }, _max: { displayOrder: true } }))._max.displayOrder ?? 0) + 1);
      const created = await tx.engagementSurveyQuestion.create({ data: { surveyId, sourceQuestionId: source?.id ?? null, questionTextSnapshot: text, themeSnapshot: input.theme === undefined ? (source?.theme ?? null) : input.theme, questionType, required: input.required ?? source?.defaultRequired ?? true, ...scaleFor(questionType, config), isEnpsPrimary, displayOrder: order, configuration: { scaleLabels: config.scaleLabels, options: config.options, maxLength: config.maxLength } as Prisma.InputJsonValue } });
      await auditService.log(engagementAudit(actor, AUDIT_ACTIONS.UPDATE_ENGAGEMENT_SURVEY, 'EngagementSurvey', surveyId, { questionAdded: created.id, questionType, sourceQuestionId: source?.id ?? null, isEnpsPrimary }), tx);
      return questionDto(created);
    });
  },
  async updateQuestion(surveyId: string, questionId: string, input: UpdateSurveyQuestionInput, actor: Actor) {
    return prisma.$transaction(async (tx) => {
      await lockSurvey(tx, surveyId);
      assertDraft(await loadSurvey(tx, surveyId));
      const q = await tx.engagementSurveyQuestion.findFirst({ where: { id: questionId, surveyId } });
      if (!q) throw notFound('survey question');
      if (input.isEnpsPrimary) { if (q.questionType !== 'ENPS') throw new AppError(422, 'VALIDATION_ERROR', 'Only an ENPS question can be the primary eNPS question', [{ field: 'isEnpsPrimary', message: 'Not an ENPS question' }]); const other = await tx.engagementSurveyQuestion.findFirst({ where: { surveyId, isEnpsPrimary: true, id: { not: questionId } }, select: { id: true } }); if (other) throw new AppError(409, 'ENGAGEMENT_ENPS_PRIMARY_EXISTS', 'A survey has at most one primary eNPS question'); }
      const merged = { ...((q.configuration ?? {}) as QuestionConfig), ...(input.config ?? {}) } as QuestionConfig;
      const updated = await tx.engagementSurveyQuestion.update({ where: { id: questionId }, data: { questionTextSnapshot: input.text, themeSnapshot: input.theme === undefined ? undefined : input.theme, required: input.required, isEnpsPrimary: input.isEnpsPrimary, displayOrder: input.displayOrder, ...(input.config ? { ...scaleFor(q.questionType, merged), configuration: { scaleLabels: merged.scaleLabels, options: merged.options, maxLength: merged.maxLength } as Prisma.InputJsonValue } : {}) } });
      await auditService.log(engagementAudit(actor, AUDIT_ACTIONS.UPDATE_ENGAGEMENT_SURVEY, 'EngagementSurvey', surveyId, { questionUpdated: questionId, fields: Object.keys(input) }), tx);
      return questionDto(updated);
    });
  },
  async removeQuestion(surveyId: string, questionId: string, actor: Actor): Promise<void> {
    await prisma.$transaction(async (tx) => {
      await lockSurvey(tx, surveyId);
      assertDraft(await loadSurvey(tx, surveyId));
      const q = await tx.engagementSurveyQuestion.findFirst({ where: { id: questionId, surveyId }, select: { id: true } });
      if (!q) throw notFound('survey question');
      await tx.engagementSurveyQuestion.delete({ where: { id: questionId } });
      await auditService.log(engagementAudit(actor, AUDIT_ACTIONS.UPDATE_ENGAGEMENT_SURVEY, 'EngagementSurvey', surveyId, { questionRemoved: questionId }), tx);
    });
  },

  /**
   * Audience (DRAFT only): resolves the criteria to active employees now and replaces the assignment rows with
   * snapshots of each person's organization, department, job and position. Opening freezes the list.
   */
  async assignAudience(surveyId: string, input: AssignAudienceInput, actor: Actor): Promise<{ assigned: number }> {
    return prisma.$transaction(async (tx) => {
      await lockSurvey(tx, surveyId);
      const s = await loadSurvey(tx, surveyId);
      assertDraft(s);
      const or: Prisma.EmployeeWhereInput[] = [];
      if (input.organizationIds?.length) or.push({ organizationId: { in: input.organizationIds } });
      if (input.departmentIds?.length) or.push({ departmentId: { in: input.departmentIds } });
      if (input.jobIds?.length) or.push({ position: { jobId: { in: input.jobIds } } });
      if (input.positionIds?.length) or.push({ positionId: { in: input.positionIds } });
      if (input.employeeIds?.length) or.push({ id: { in: input.employeeIds } });
      const people = await tx.employee.findMany({ where: { employmentStatus: 'ACTIVE', ...(s.organizationId ? { organizationId: s.organizationId } : {}), OR: or }, select: { id: true, organizationId: true, departmentId: true, positionId: true, position: { select: { jobId: true } } } });
      await tx.engagementSurveyAssignment.deleteMany({ where: { surveyId } });
      if (people.length) await tx.engagementSurveyAssignment.createMany({ data: people.map((e) => ({ surveyId, employeeId: e.id, organizationIdSnapshot: e.organizationId, departmentIdSnapshot: e.departmentId, jobIdSnapshot: e.position.jobId, positionIdSnapshot: e.positionId })), skipDuplicates: true });
      await auditService.log(engagementAudit(actor, AUDIT_ACTIONS.ASSIGN_ENGAGEMENT_AUDIENCE, 'EngagementSurvey', surveyId, { assigned: people.length, criteria: { organizations: input.organizationIds?.length ?? 0, departments: input.departmentIds?.length ?? 0, jobs: input.jobIds?.length ?? 0, positions: input.positionIds?.length ?? 0, employees: input.employeeIds?.length ?? 0 } }), tx);
      return { assigned: people.length };
    });
  },

  /** OPEN: freezes questions and audience, checks the anonymity threshold against the audience, notifies. */
  async open(surveyId: string, actor: Actor): Promise<SurveyDto> {
    await prisma.$transaction(async (tx) => {
      await lockSurvey(tx, surveyId);
      const s = await loadSurvey(tx, surveyId);
      assertDraft(s);
      if (s._count.questions === 0) throw new AppError(409, 'ENGAGEMENT_SURVEY_NO_QUESTIONS', 'Add at least one question before opening');
      if (s._count.assignments === 0) throw new AppError(409, 'ENGAGEMENT_SURVEY_NO_AUDIENCE', 'Assign an audience before opening');
      if (s.responseMode === 'ANONYMOUS' && s._count.assignments < s.minimumAnonymousGroupSize) throw new AppError(409, 'ENGAGEMENT_AUDIENCE_BELOW_ANONYMITY_THRESHOLD', `An anonymous survey needs at least ${s.minimumAnonymousGroupSize} people in its audience`);
      // Re-snapshot dimensions from the employee master at the moment of opening, then never again.
      const assignments = await tx.engagementSurveyAssignment.findMany({ where: { surveyId }, select: { id: true, employeeId: true } });
      const people = await tx.employee.findMany({ where: { id: { in: assignments.map((a) => a.employeeId) } }, select: { id: true, organizationId: true, departmentId: true, positionId: true, position: { select: { jobId: true } }, user: { select: { id: true } } } });
      const byId = new Map(people.map((p) => [p.id, p]));
      for (const a of assignments) { const p = byId.get(a.employeeId); if (p) await tx.engagementSurveyAssignment.update({ where: { id: a.id }, data: { organizationIdSnapshot: p.organizationId, departmentIdSnapshot: p.departmentId, jobIdSnapshot: p.position.jobId, positionIdSnapshot: p.positionId, invitedAt: new Date() } }); }
      await tx.engagementSurvey.update({ where: { id: surveyId }, data: { status: 'OPEN', openedAt: new Date() } });
      for (const p of people) if (p.user) await notificationService.publish({ userId: p.user.id, type: NOTIFICATION_TYPES.ENGAGEMENT_SURVEY_OPENED, source: { module: 'engagement', entityType: 'ENGAGEMENT_SURVEY', entityId: surveyId }, data: { surveyId }, dedupeKey: `engagement:survey:${surveyId}:opened:${p.user.id}` }, { surveyName: s.name, closingDate: s.periodEnd ?? undefined }, tx);
      await auditService.log(engagementAudit(actor, AUDIT_ACTIONS.OPEN_ENGAGEMENT_SURVEY, 'EngagementSurvey', surveyId, { responseMode: s.responseMode, minimumAnonymousGroupSize: s.minimumAnonymousGroupSize, questions: s._count.questions, audience: assignments.length, notified: people.filter((p) => p.user).length }), tx);
    });
    return surveyDto(prisma, await loadSurvey(prisma, surveyId), actor.auth);
  },
  async close(surveyId: string, actor: Actor): Promise<SurveyDto> {
    await prisma.$transaction(async (tx) => {
      await lockSurvey(tx, surveyId); // exclusive: every in-flight submission (share lock) has finished or has not started
      const s = await loadSurvey(tx, surveyId);
      if (s.status !== 'OPEN') throw new AppError(409, 'ENGAGEMENT_SURVEY_NOT_OPEN', `A ${s.status.toLowerCase()} survey cannot be closed`);
      const completed = await tx.engagementSurveyAssignment.count({ where: { surveyId, completedAt: { not: null } } });
      await tx.engagementSurvey.update({ where: { id: surveyId }, data: { status: 'CLOSED', closedAt: new Date() } });
      await auditService.log(engagementAudit(actor, AUDIT_ACTIONS.CLOSE_ENGAGEMENT_SURVEY, 'EngagementSurvey', surveyId, { audience: s._count.assignments, completed }), tx);
    });
    return surveyDto(prisma, await loadSurvey(prisma, surveyId), actor.auth);
  },
  async archive(surveyId: string, actor: Actor): Promise<SurveyDto> {
    await prisma.$transaction(async (tx) => {
      await lockSurvey(tx, surveyId);
      const s = await loadSurvey(tx, surveyId);
      if (s.status !== 'CLOSED' && s.status !== 'DRAFT') throw new AppError(409, 'ENGAGEMENT_SURVEY_INVALID_TRANSITION', `A ${s.status.toLowerCase()} survey cannot be archived`);
      await tx.engagementSurvey.update({ where: { id: surveyId }, data: { status: 'ARCHIVED', archivedAt: new Date() } });
      await auditService.log(engagementAudit(actor, AUDIT_ACTIONS.ARCHIVE_ENGAGEMENT_SURVEY, 'EngagementSurvey', surveyId, { from: s.status }), tx);
    });
    return surveyDto(prisma, await loadSurvey(prisma, surveyId), actor.auth);
  },
  /** A DRAFT with no responses can be deleted; anything that was open is kept. */
  async deleteDraft(surveyId: string, actor: Actor): Promise<void> {
    await prisma.$transaction(async (tx) => {
      await lockSurvey(tx, surveyId);
      const s = await loadSurvey(tx, surveyId);
      assertDraft(s);
      await tx.engagementSurveyAssignment.deleteMany({ where: { surveyId } });
      await tx.engagementSurveyQuestion.deleteMany({ where: { surveyId } });
      await tx.engagementSurvey.delete({ where: { id: surveyId } });
      await auditService.log(engagementAudit(actor, AUDIT_ACTIONS.UPDATE_ENGAGEMENT_SURVEY, 'EngagementSurvey', surveyId, { deletedDraft: true, code: s.code }), tx);
    });
  },
  /** Copies the questionnaire (question snapshots and configuration) into a new DRAFT. Audience, responses and results are not copied. */
  async duplicate(surveyId: string, code: string, name: string, actor: Actor): Promise<SurveyDto> {
    if (await prisma.engagementSurvey.findUnique({ where: { code: code.toUpperCase() } })) throw new AppError(409, 'ENGAGEMENT_SURVEY_CODE_EXISTS', 'A survey with this code already exists');
    const id = await prisma.$transaction(async (tx) => {
      const src = await loadSurvey(tx, surveyId);
      const copy = await tx.engagementSurvey.create({ data: { code: code.toUpperCase(), name, description: src.description, organizationId: src.organizationId, surveyType: src.surveyType, responseMode: src.responseMode, minimumAnonymousGroupSize: src.minimumAnonymousGroupSize, duplicatedFromId: src.id, createdByUserId: actor.auth.userId } });
      const qs = await tx.engagementSurveyQuestion.findMany({ where: { surveyId }, orderBy: { displayOrder: 'asc' } });
      if (qs.length) await tx.engagementSurveyQuestion.createMany({ data: qs.map((q) => ({ surveyId: copy.id, sourceQuestionId: q.sourceQuestionId, questionTextSnapshot: q.questionTextSnapshot, themeSnapshot: q.themeSnapshot, questionType: q.questionType, required: q.required, scaleMin: q.scaleMin, scaleMax: q.scaleMax, isEnpsPrimary: q.isEnpsPrimary, displayOrder: q.displayOrder, configuration: q.configuration as Prisma.InputJsonValue })) });
      await auditService.log(engagementAudit(actor, AUDIT_ACTIONS.DUPLICATE_ENGAGEMENT_SURVEY, 'EngagementSurvey', copy.id, { duplicatedFromId: surveyId, questions: qs.length }), tx);
      return copy.id;
    });
    return surveyDto(prisma, await loadSurvey(prisma, id), actor.auth);
  },
};
