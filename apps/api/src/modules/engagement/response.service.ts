import { AUDIT_ACTIONS, validateAnswer, type MySurveyDto, type ParticipationRowDto, type SubmitResponseInput, type SurveyFormDto } from '@hr/shared';
import type { Prisma } from '@prisma/client';
import { AppError } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { auditService } from '../../services/audit/audit.service';
import type { AuthContext } from '../auth/auth.types';
import { engagementAudit, lockAssignment, notFound, questionDto, shareLockSurvey, type Actor } from './engagement.types';
import { loadSurvey } from './survey.service';

/**
 * The employee's side: which surveys are open for them, the form, and the single submission.
 *
 * Anonymous submissions write a response row that holds only survey-local cohort tokens and the date — no employee,
 * user, assignment, organization, department, job or position id; the assignment is marked completed separately. There is no partial save — the client keeps
 * the draft and submits once. One assignment yields at most one response, under the assignment's row lock.
 */
export const ANONYMOUS_NOTICE = 'คำตอบของแบบสำรวจนี้จะไม่ถูกจัดเก็บพร้อม employee/user identifier และผลของกลุ่มขนาดเล็กจะถูกซ่อนตามเกณฑ์ของแบบสำรวจ (Answers to this survey are not stored with employee or user identifiers, and results for small groups are hidden according to the survey\'s threshold.)';
export const IDENTIFIED_NOTICE = 'แบบสำรวจนี้ระบุตัวผู้ตอบได้ — คำตอบของคุณจะถูกจัดเก็บพร้อมชื่อของคุณ (This survey is identified: your answers are stored with your name.)';

const requireEmployee = (auth: AuthContext): string => { if (!auth.employeeId) throw new AppError(409, 'EMPLOYEE_PROFILE_REQUIRED', 'Your account is not linked to an employee record'); return auth.employeeId; };

export const responseService = {
  async mine(auth: AuthContext): Promise<MySurveyDto[]> {
    const employeeId = requireEmployee(auth);
    const rows = await prisma.engagementSurveyAssignment.findMany({ where: { employeeId, survey: { status: { in: ['OPEN', 'CLOSED'] } } }, include: { survey: { include: { _count: { select: { questions: true } } } } }, orderBy: { invitedAt: 'desc' } });
    return rows.map((a) => ({ surveyId: a.surveyId, code: a.survey.code, name: a.survey.name, description: a.survey.description, surveyType: a.survey.surveyType as MySurveyDto['surveyType'], responseMode: a.survey.responseMode as MySurveyDto['responseMode'], periodEnd: a.survey.periodEnd, status: a.survey.status as MySurveyDto['status'], completed: !!a.completedAt, completedAt: a.completedAt?.toISOString() ?? null, questionCount: a.survey._count.questions }));
  },
  async form(auth: AuthContext, surveyId: string): Promise<SurveyFormDto> {
    const employeeId = requireEmployee(auth);
    const a = await prisma.engagementSurveyAssignment.findUnique({ where: { surveyId_employeeId: { surveyId, employeeId } }, include: { survey: { include: { _count: { select: { questions: true } } } } } });
    if (!a || a.survey.status === 'DRAFT') throw notFound('survey');
    const questions = await prisma.engagementSurveyQuestion.findMany({ where: { surveyId }, orderBy: [{ displayOrder: 'asc' }, { createdAt: 'asc' }] });
    const s = a.survey;
    return { survey: { surveyId, code: s.code, name: s.name, description: s.description, surveyType: s.surveyType as MySurveyDto['surveyType'], responseMode: s.responseMode as MySurveyDto['responseMode'], periodEnd: s.periodEnd, status: s.status as MySurveyDto['status'], completed: !!a.completedAt, completedAt: a.completedAt?.toISOString() ?? null, questionCount: s._count.questions }, questions: questions.map(questionDto), notice: s.responseMode === 'ANONYMOUS' ? ANONYMOUS_NOTICE : IDENTIFIED_NOTICE };
  },

  async submit(surveyId: string, input: SubmitResponseInput, actor: Actor): Promise<{ completedAt: string }> {
    const employeeId = requireEmployee(actor.auth);
    const seen = new Set<string>();
    for (const a of input.answers) { if (seen.has(a.questionId)) throw new AppError(422, 'VALIDATION_ERROR', 'Duplicate answer for a question', [{ field: 'answers', message: `Question ${a.questionId} answered twice` }]); seen.add(a.questionId); }
    const result = await prisma.$transaction(async (tx) => {
      const a0 = await tx.engagementSurveyAssignment.findUnique({ where: { surveyId_employeeId: { surveyId, employeeId } }, select: { id: true } });
      if (!a0) throw notFound('survey');
      await shareLockSurvey(tx, surveyId);
      await lockAssignment(tx, a0.id);
      const survey = await loadSurvey(tx, surveyId);
      if (survey.status !== 'OPEN') throw new AppError(409, 'ENGAGEMENT_SURVEY_NOT_OPEN', 'This survey is not open for answers');
      const a = await tx.engagementSurveyAssignment.findUniqueOrThrow({ where: { id: a0.id } });
      if (a.completedAt) throw new AppError(409, 'ENGAGEMENT_ALREADY_RESPONDED', 'You have already answered this survey');
      const questions = await tx.engagementSurveyQuestion.findMany({ where: { surveyId } });
      const byId = new Map(questions.map((q) => [q.id, q]));
      const details: { field: string; message: string }[] = [];
      for (const ans of input.answers) if (!byId.has(ans.questionId)) details.push({ field: ans.questionId, message: 'Unknown question' });
      for (const q of questions) {
        const dto = questionDto(q);
        const msg = validateAnswer({ questionType: dto.questionType, required: dto.required, scaleMin: dto.scaleMin, scaleMax: dto.scaleMax, options: dto.options, maxLength: dto.maxLength }, input.answers.find((x) => x.questionId === q.id));
        if (msg) details.push({ field: q.id, message: msg });
      }
      if (details.length) throw new AppError(422, 'ENGAGEMENT_INVALID_ANSWERS', 'Some answers are missing or invalid', details);
      const anonymous = survey.responseMode === 'ANONYMOUS';
      const now = new Date();
      // The response row carries the survey, the day and the assignment's survey-local cohort tokens — nothing else.
      // Identity for an identified survey goes to its own table; an anonymous submission never writes that table.
      const response = await tx.engagementResponse.create({ data: { surveyId, responseMode: survey.responseMode, orgCohortId: a.orgCohortId, deptCohortId: a.deptCohortId, jobCohortId: a.jobCohortId, submittedDate: now.toISOString().slice(0, 10) } });
      if (!anonymous) await tx.engagementIdentifiedRespondent.create({ data: { responseId: response.id, assignmentId: a.id, employeeId, submittedAt: now } });
      const rows: Prisma.EngagementResponseAnswerCreateManyInput[] = [];
      for (const ans of input.answers) {
        const q = byId.get(ans.questionId)!;
        const empty = (ans.numericValue === null || ans.numericValue === undefined) && (ans.booleanValue === null || ans.booleanValue === undefined) && !ans.textValue?.trim() && !(ans.choiceValues && ans.choiceValues.length);
        if (empty) continue;
        rows.push({ responseId: response.id, questionId: q.id, numericValue: q.questionType === 'LIKERT' || q.questionType === 'SCALE' || q.questionType === 'ENPS' ? ans.numericValue ?? null : null, booleanValue: q.questionType === 'YES_NO' ? ans.booleanValue ?? null : null, textValue: q.questionType === 'TEXT' ? (ans.textValue?.trim() ?? null) : null, choiceValues: q.questionType === 'SINGLE_CHOICE' || q.questionType === 'MULTI_CHOICE' ? (ans.choiceValues as Prisma.InputJsonValue) : undefined });
      }
      if (rows.length) await tx.engagementResponseAnswer.createMany({ data: rows });
      await tx.engagementSurveyAssignment.update({ where: { id: a.id }, data: { completedAt: now } });
      // Audit is survey-level metadata. Anonymous: no response id, so the actor column maps only to participation.
      await auditService.log(engagementAudit(actor, AUDIT_ACTIONS.SUBMIT_ENGAGEMENT_RESPONSE, 'EngagementSurvey', surveyId, { mode: survey.responseMode, answerCount: rows.length, ...(anonymous ? {} : { responseId: response.id }) }), tx);
      return { completedAt: now.toISOString() };
    });
    return result;
  },

  /** Participation for HR: who was invited and whether they completed. No path to an answer for anonymous surveys. */
  async participation(surveyId: string, q: { page: number; pageSize: number; completed?: 'true' | 'false'; departmentId?: string }): Promise<{ data: ParticipationRowDto[]; meta: { page: number; pageSize: number; total: number } }> {
    await loadSurvey(prisma, surveyId);
    const where: Prisma.EngagementSurveyAssignmentWhereInput = { surveyId, departmentIdSnapshot: q.departmentId, ...(q.completed === 'true' ? { completedAt: { not: null } } : q.completed === 'false' ? { completedAt: null } : {}) };
    const [total, rows] = await prisma.$transaction([prisma.engagementSurveyAssignment.count({ where }), prisma.engagementSurveyAssignment.findMany({ where, orderBy: { invitedAt: 'asc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize })]);
    const ids = rows.map((r) => r.employeeId);
    const [emps, depts, jobs] = await Promise.all([
      prisma.employee.findMany({ where: { id: { in: ids } }, select: { id: true, employeeCode: true, firstName: true, lastName: true } }),
      prisma.department.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.departmentIdSnapshot))] } }, select: { id: true, name: true } }),
      prisma.job.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.jobIdSnapshot).filter((x): x is string => !!x))] } }, select: { id: true, title: true } }),
    ]);
    const e = new Map(emps.map((x) => [x.id, x])); const d = new Map(depts.map((x) => [x.id, x.name])); const j = new Map(jobs.map((x) => [x.id, x.title]));
    return { data: rows.map((r) => ({ assignmentId: r.id, employee: e.get(r.employeeId) ?? { id: r.employeeId, employeeCode: '?', firstName: '?', lastName: '' }, departmentName: d.get(r.departmentIdSnapshot) ?? null, jobTitle: r.jobIdSnapshot ? (j.get(r.jobIdSnapshot) ?? null) : null, invitedAt: r.invitedAt.toISOString(), completed: !!r.completedAt, completedAt: r.completedAt?.toISOString() ?? null })), meta: { page: q.page, pageSize: q.pageSize, total } };
  },
};
