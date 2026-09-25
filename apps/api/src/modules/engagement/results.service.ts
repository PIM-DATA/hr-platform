import { csvCell, enpsScore, meetsThreshold, responseRate, round1, scaleKey, type BreakdownRowDto, type CommentDto, type EngagementDashboardDto, type EnpsResultDto, type IdentifiedResponseDto, type QuestionResultDto, type ResultsFilter, type SuppressedResultDto, type SurveyResultsDto, type ThemeResultDto, type VisibleResultDto } from '@hr/shared';
import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { AppError } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { auditService } from '../../services/audit/audit.service';
import type { AuthContext } from '../auth/auth.types';
import { canManage, engagementAudit, notFound, questionDto, visibleDepartmentIds, type Actor, type Db } from './engagement.types';
import { loadSurvey } from './survey.service';
import { AUDIT_ACTIONS } from '@hr/shared';

/**
 * Aggregation over survey-local cohort tokens, with one rule applied everywhere: for an anonymous survey, a group of responses smaller than the
 * survey's minimum is suppressed — after every filter, for every actor, with no privileged path. Aggregates are
 * computed in the database (grouped counts per question and value); choice answers are counted in memory over
 * the group's rows. Participation (assigned / completed) comes from assignments; answers never join to them.
 */
type Survey = Awaited<ReturnType<typeof loadSurvey>>;
type Q = ReturnType<typeof questionDto>;
const SUPPRESSED = (min: number): SuppressedResultDto => ({ suppressed: true, minimumGroupSize: min, reason: `Fewer than ${min} responses in this group; results are hidden to protect respondents.` });

/** Resolves a master id to this survey's cohort token, or to an impossible token when the audience never had it. */
async function cohortFor(db: Db, surveyId: string, dimensionType: 'ORGANIZATION' | 'DEPARTMENT' | 'JOB', sourceId: string): Promise<string> {
  const c = await db.engagementSurveyCohort.findUnique({ where: { surveyId_dimensionType_sourceId: { surveyId, dimensionType, sourceId } }, select: { id: true } });
  return c?.id ?? '__no_such_cohort__';
}
async function scopedFilter(db: Db, auth: AuthContext, surveyId: string, mode: string, filter: ResultsFilter): Promise<{ where: Prisma.EngagementResponseWhereInput; assignWhere: Prisma.EngagementSurveyAssignmentWhereInput; teamScoped: boolean; visible: string[] | null; positionUnsupported: boolean }> {
  const visible = await visibleDepartmentIds(db, auth);
  const teamScoped = visible !== null;
  if (teamScoped && filter.departmentId && !visible.includes(filter.departmentId)) throw AppError.forbidden('That department is outside your scope');
  const deptCohorts = teamScoped && !filter.departmentId ? (await db.engagementSurveyCohort.findMany({ where: { surveyId, dimensionType: 'DEPARTMENT', sourceId: { in: visible } }, select: { id: true } })).map((c) => c.id) : null;
  const where: Prisma.EngagementResponseWhereInput = {
    ...(filter.departmentId ? { deptCohortId: await cohortFor(db, surveyId, 'DEPARTMENT', filter.departmentId) } : deptCohorts ? { deptCohortId: { in: deptCohorts } } : {}),
    ...(filter.organizationId ? { orgCohortId: await cohortFor(db, surveyId, 'ORGANIZATION', filter.organizationId) } : {}),
    ...(filter.jobId ? { jobCohortId: await cohortFor(db, surveyId, 'JOB', filter.jobId) } : {}),
    // Position exists only for identified surveys, through the respondent table; anonymous answers carry no position.
    ...(filter.positionId && mode === 'IDENTIFIED' ? { respondent: { assignment: { positionIdSnapshot: filter.positionId } } } : {}),
  };
  const assignWhere: Prisma.EngagementSurveyAssignmentWhereInput = {
    ...(filter.departmentId ? { departmentIdSnapshot: filter.departmentId } : teamScoped ? { departmentIdSnapshot: { in: visible } } : {}),
    ...(filter.organizationId ? { organizationIdSnapshot: filter.organizationId } : {}), ...(filter.jobId ? { jobIdSnapshot: filter.jobId } : {}), ...(filter.positionId ? { positionIdSnapshot: filter.positionId } : {}),
  };
  return { where, assignWhere, teamScoped, visible, positionUnsupported: !!filter.positionId };
}

/** Aggregates one group of responses. Applies the threshold before touching an answer. */
async function aggregate(db: Db, survey: Survey, questions: Q[], where: Prisma.EngagementResponseWhereInput, positionUnsupported: boolean): Promise<VisibleResultDto | SuppressedResultDto> {
  const anonymous = survey.responseMode === 'ANONYMOUS';
  // Anonymous responses carry no position, so a position filter cannot be answered — it is reported as suppressed, never estimated.
  if (anonymous && positionUnsupported) return SUPPRESSED(survey.minimumAnonymousGroupSize);
  const responseWhere: Prisma.EngagementResponseWhereInput = { surveyId: survey.id, ...where };
  const responseCount = await db.engagementResponse.count({ where: responseWhere });
  if (!meetsThreshold(responseCount, survey.responseMode as 'ANONYMOUS' | 'IDENTIFIED', survey.minimumAnonymousGroupSize)) return SUPPRESSED(survey.minimumAnonymousGroupSize);
  const numeric = await db.engagementResponseAnswer.groupBy({ by: ['questionId', 'numericValue'], where: { response: responseWhere, numericValue: { not: null } }, _count: { _all: true } });
  const bools = await db.engagementResponseAnswer.groupBy({ by: ['questionId', 'booleanValue'], where: { response: responseWhere, booleanValue: { not: null } }, _count: { _all: true } });
  const texts = await db.engagementResponseAnswer.groupBy({ by: ['questionId'], where: { response: responseWhere, textValue: { not: null } }, _count: { _all: true } });
  const choiceQs = questions.filter((q) => q.questionType === 'SINGLE_CHOICE' || q.questionType === 'MULTI_CHOICE').map((q) => q.id);
  const choices = choiceQs.length ? await db.engagementResponseAnswer.findMany({ where: { response: responseWhere, questionId: { in: choiceQs } }, select: { questionId: true, choiceValues: true } }) : [];
  const results: QuestionResultDto[] = questions.map((q) => {
    const base = { questionId: q.id, text: q.text, theme: q.theme, questionType: q.questionType, scaleMin: q.scaleMin, scaleMax: q.scaleMax, isEnpsPrimary: q.isEnpsPrimary, average: null as number | null, distribution: [] as QuestionResultDto['distribution'], yes: null as number | null, no: null as number | null, commentCount: null as number | null, responseCount: 0 };
    if (q.questionType === 'LIKERT' || q.questionType === 'SCALE' || q.questionType === 'ENPS') {
      const rows = numeric.filter((n) => n.questionId === q.id);
      const n = rows.reduce((s, r) => s + r._count._all, 0);
      const sum = rows.reduce((s, r) => s + (r.numericValue ?? 0) * r._count._all, 0);
      const dist: QuestionResultDto['distribution'] = [];
      for (let v = q.scaleMin ?? 0; v <= (q.scaleMax ?? 0); v += 1) { const c = rows.find((r) => r.numericValue === v)?._count._all ?? 0; dist.push({ value: String(v), label: q.scaleLabels?.[String(v)] ?? null, count: c, pct: n ? round1((c / n) * 100) : 0 }); }
      return { ...base, responseCount: n, average: n ? round1(sum / n) : null, distribution: dist };
    }
    if (q.questionType === 'YES_NO') { const yes = bools.find((b) => b.questionId === q.id && b.booleanValue === true)?._count._all ?? 0; const no = bools.find((b) => b.questionId === q.id && b.booleanValue === false)?._count._all ?? 0; const n = yes + no; return { ...base, responseCount: n, yes, no, distribution: [{ value: 'yes', label: 'Yes', count: yes, pct: n ? round1((yes / n) * 100) : 0 }, { value: 'no', label: 'No', count: no, pct: n ? round1((no / n) * 100) : 0 }] }; }
    if (q.questionType === 'TEXT') return { ...base, responseCount: texts.find((t) => t.questionId === q.id)?._count._all ?? 0, commentCount: texts.find((t) => t.questionId === q.id)?._count._all ?? 0 };
    const rows = choices.filter((c) => c.questionId === q.id);
    const counts = new Map<string, number>();
    for (const r of rows) for (const v of (r.choiceValues as string[] | null) ?? []) counts.set(v, (counts.get(v) ?? 0) + 1);
    return { ...base, responseCount: rows.length, distribution: q.options.map((o) => ({ value: o.code, label: o.label, count: counts.get(o.code) ?? 0, pct: rows.length ? round1(((counts.get(o.code) ?? 0) / rows.length) * 100) : 0 })) };
  });
  // Themes: only questions sharing an identical scale are averaged together; Likert 1–5 and eNPS 0–10 never mix.
  const themeMap = new Map<string, { theme: string; scale: string; sum: number; n: number; qs: number }>();
  for (const q of questions) { const k = scaleKey(q); if (!q.theme || !k) continue; const r = results.find((x) => x.questionId === q.id)!; if (!r.responseCount) continue; const key = `${q.theme}|${k}`; const t = themeMap.get(key) ?? { theme: q.theme, scale: k, sum: 0, n: 0, qs: 0 }; t.sum += (r.average ?? 0) * r.responseCount; t.n += r.responseCount; t.qs += 1; themeMap.set(key, t); }
  const themes: ThemeResultDto[] = [...themeMap.values()].map((t) => ({ theme: t.theme, scale: t.scale, questionCount: t.qs, average: t.n ? round1(t.sum / t.n) : null, responseCount: t.n }));
  const primary = questions.find((q) => q.isEnpsPrimary);
  let enps: EnpsResultDto | null = null;
  if (primary) { const values: number[] = []; for (const r of numeric.filter((n) => n.questionId === primary.id)) for (let i = 0; i < r._count._all; i += 1) values.push(r.numericValue ?? 0); enps = { questionId: primary.id, ...enpsScore(values) }; }
  return { suppressed: false, responseCount, questions: results, themes, enps };
}

async function loadQuestions(db: Db, surveyId: string): Promise<Q[]> {
  return (await db.engagementSurveyQuestion.findMany({ where: { surveyId }, orderBy: [{ displayOrder: 'asc' }, { createdAt: 'asc' }] })).map(questionDto);
}
const surveyHead = (s: Survey) => ({ id: s.id, code: s.code, name: s.name, responseMode: s.responseMode as 'ANONYMOUS' | 'IDENTIFIED', status: s.status as SurveyResultsDto['survey']['status'], minimumAnonymousGroupSize: s.minimumAnonymousGroupSize, openedAt: s.openedAt?.toISOString() ?? null, closedAt: s.closedAt?.toISOString() ?? null });
const assertReportable = (s: Survey) => { if (s.status === 'DRAFT') throw new AppError(409, 'ENGAGEMENT_SURVEY_NOT_OPEN', 'A draft survey has no results'); };

export const resultsService = {
  async overview(auth: AuthContext, surveyId: string, filter: ResultsFilter): Promise<SurveyResultsDto> {
    const survey = await loadSurvey(prisma, surveyId);
    assertReportable(survey);
    const scope = await scopedFilter(prisma, auth, surveyId, survey.responseMode, filter);
    const questions = await loadQuestions(prisma, surveyId);
    const [assigned, completed] = await Promise.all([prisma.engagementSurveyAssignment.count({ where: { surveyId, ...scope.assignWhere } }), prisma.engagementSurveyAssignment.count({ where: { surveyId, ...scope.assignWhere, completedAt: { not: null } } })]);
    const result = await aggregate(prisma, survey, questions, scope.where, scope.positionUnsupported);
    // A suppressed subgroup shows no participation counts either — a completed count is a response count.
    const filtered = !!(filter.departmentId || filter.jobId || filter.organizationId || filter.positionId);
    const participation = result.suppressed && (filtered || scope.teamScoped) ? { assigned: 0, completed: 0, responseRate: null } : { assigned, completed, responseRate: responseRate(completed, assigned) };
    return { survey: surveyHead(survey), scope: { filtered, teamScoped: scope.teamScoped }, participation, result, generatedAt: new Date().toISOString() };
  },

  async breakdown(auth: AuthContext, surveyId: string, by: 'department' | 'job' | 'organization', filter: ResultsFilter): Promise<BreakdownRowDto[]> {
    const survey = await loadSurvey(prisma, surveyId);
    assertReportable(survey);
    const scope = await scopedFilter(prisma, auth, surveyId, survey.responseMode, filter);
    const questions = await loadQuestions(prisma, surveyId);
    const dim = by === 'department' ? 'deptCohortId' : by === 'job' ? 'jobCohortId' : 'orgCohortId';
    // Groups come from the frozen audience; their names from the survey's own cohort rows. Answers are never joined to people.
    const groups = await prisma.engagementSurveyAssignment.groupBy({ by: [dim], where: { surveyId, ...scope.assignWhere }, _count: { _all: true } });
    const cohorts = new Map((await prisma.engagementSurveyCohort.findMany({ where: { surveyId }, select: { id: true, label: true } })).map((c) => [c.id, c.label]));
    const rows: BreakdownRowDto[] = [];
    for (const g of groups) {
      const key = g[dim] as string | null;
      const groupWhere = { ...scope.where, [dim]: key };
      const completed = await prisma.engagementSurveyAssignment.count({ where: { surveyId, ...scope.assignWhere, [dim]: key, completedAt: { not: null } } });
      const result = await aggregate(prisma, survey, questions, groupWhere, scope.positionUnsupported);
      rows.push({ key: key ?? '-', name: key ? (cohorts.get(key) ?? '?') : 'Not set', assigned: result.suppressed ? 0 : g._count._all, completed: result.suppressed ? 0 : completed, responseRate: result.suppressed ? null : responseRate(completed, g._count._all), result });
    }
    return rows.sort((a, b) => a.name.localeCompare(b.name));
  },

  /**
   * Free-text answers. Anonymous: engagement.manage only, survey CLOSED, overall responses at or above the
   * threshold; text only, no dimension, no timestamp, in an order unrelated to submission. Identified: manage,
   * with the respondent.
   */
  async comments(actor: Actor, surveyId: string, questionId?: string): Promise<CommentDto[]> {
    if (!canManage(actor.auth)) throw AppError.forbidden();
    const survey = await loadSurvey(prisma, surveyId);
    assertReportable(survey);
    const anonymous = survey.responseMode === 'ANONYMOUS';
    if (anonymous) {
      if (survey.status !== 'CLOSED' && survey.status !== 'ARCHIVED') throw new AppError(409, 'ENGAGEMENT_COMMENTS_NOT_AVAILABLE', 'Anonymous comments can be read once the survey is closed');
      const total = await prisma.engagementResponse.count({ where: { surveyId } });
      if (total < survey.minimumAnonymousGroupSize) throw new AppError(409, 'ENGAGEMENT_COMMENTS_SUPPRESSED', `Fewer than ${survey.minimumAnonymousGroupSize} responses; comments are hidden`);
    }
    // The respondent relation is empty for every anonymous response (that table is never written for them).
    const rows = await prisma.engagementResponseAnswer.findMany({ where: { response: { surveyId }, textValue: { not: null }, questionId, question: { questionType: 'TEXT' } }, select: { id: true, questionId: true, textValue: true, response: { select: { respondent: { select: { employeeId: true } } } } } });
    const empIds = anonymous ? [] : [...new Set(rows.map((r) => r.response.respondent?.employeeId).filter((x): x is string => !!x))];
    const emps = new Map((empIds.length ? await prisma.employee.findMany({ where: { id: { in: empIds } }, select: { id: true, employeeCode: true, firstName: true, lastName: true } }) : []).map((e) => [e.id, e]));
    const out = rows.map((r) => { const eid = anonymous ? null : (r.response.respondent?.employeeId ?? null); return { questionId: r.questionId, text: r.textValue ?? '', respondent: eid ? (emps.get(eid) ?? null) : null, sort: createHash('sha256').update(r.id).digest('hex') }; });
    out.sort((a, b) => (anonymous ? a.sort.localeCompare(b.sort) : 0));
    await auditService.log(engagementAudit(actor, AUDIT_ACTIONS.VIEW_ENGAGEMENT_COMMENTS, 'EngagementSurvey', surveyId, { mode: survey.responseMode, comments: out.length, questionId: questionId ?? null }));
    return out.map(({ sort: _s, ...c }) => c);
  },

  /** IDENTIFIED surveys only, engagement.manage only: who answered what. Never available for an anonymous survey. */
  async identifiedResponses(actor: Actor, surveyId: string): Promise<IdentifiedResponseDto[]> {
    if (!canManage(actor.auth)) throw AppError.forbidden();
    const survey = await loadSurvey(prisma, surveyId);
    if (survey.responseMode !== 'IDENTIFIED') throw new AppError(409, 'ENGAGEMENT_SURVEY_ANONYMOUS', 'An anonymous survey has no respondent detail');
    const rows = await prisma.engagementIdentifiedRespondent.findMany({ where: { response: { surveyId } }, include: { response: { include: { answers: true } } }, orderBy: { submittedAt: 'asc' } });
    const emps = new Map((await prisma.employee.findMany({ where: { id: { in: rows.map((r) => r.employeeId) } }, select: { id: true, employeeCode: true, firstName: true, lastName: true } })).map((e) => [e.id, e]));
    await auditService.log(engagementAudit(actor, AUDIT_ACTIONS.VIEW_ENGAGEMENT_RESPONDENT_DETAIL, 'EngagementSurvey', surveyId, { responses: rows.length }));
    return rows.map((r) => ({ responseId: r.responseId, employee: emps.get(r.employeeId) ?? { id: r.employeeId, employeeCode: '?', firstName: '?', lastName: '' }, submittedAt: r.submittedAt.toISOString(), answers: r.response.answers.map((a) => ({ questionId: a.questionId, numericValue: a.numericValue, booleanValue: a.booleanValue, textValue: a.textValue, choiceValues: (a.choiceValues as string[] | null) ?? null })) }));
  },

  async dashboard(auth: AuthContext): Promise<EngagementDashboardDto> {
    const visible = await visibleDepartmentIds(prisma, auth);
    const assignWhere = visible ? { departmentIdSnapshot: { in: visible } } : {};
    const [open, closed, draft] = await Promise.all([prisma.engagementSurvey.count({ where: { status: 'OPEN' } }), prisma.engagementSurvey.count({ where: { status: 'CLOSED' } }), prisma.engagementSurvey.count({ where: { status: 'DRAFT' } })]);
    const [assignedOpen, completedOpen] = await Promise.all([prisma.engagementSurveyAssignment.count({ where: { survey: { status: 'OPEN' }, ...assignWhere } }), prisma.engagementSurveyAssignment.count({ where: { survey: { status: 'OPEN' }, completedAt: { not: null }, ...assignWhere } })]);
    const recentRows = await prisma.engagementSurvey.findMany({ where: { status: { in: ['OPEN', 'CLOSED'] } }, orderBy: [{ closedAt: 'desc' }, { openedAt: 'desc' }], take: 8, select: { id: true, code: true, name: true, status: true, responseMode: true, closedAt: true } });
    const recent = [] as EngagementDashboardDto['recent'];
    for (const s of recentRows) { const [a, c] = await Promise.all([prisma.engagementSurveyAssignment.count({ where: { surveyId: s.id, ...assignWhere } }), prisma.engagementSurveyAssignment.count({ where: { surveyId: s.id, completedAt: { not: null }, ...assignWhere } })]); recent.push({ id: s.id, code: s.code, name: s.name, status: s.status, responseMode: s.responseMode, responseRate: responseRate(c, a), closedAt: s.closedAt?.toISOString() ?? null }); }
    const latest = await prisma.engagementSurvey.findFirst({ where: { status: { in: ['OPEN', 'CLOSED'] }, questions: { some: { isEnpsPrimary: true } } }, orderBy: [{ closedAt: 'desc' }, { openedAt: 'desc' }], select: { id: true } });
    let latestEnps: EngagementDashboardDto['latestEnps'] = null;
    if (latest) { const r = await this.overview(auth, latest.id, {}); const s = await loadSurvey(prisma, latest.id); latestEnps = { surveyId: latest.id, surveyName: s.name, score: r.result.suppressed ? null : (r.result.enps?.score ?? null), suppressed: r.result.suppressed }; }
    return { openSurveys: open, closedSurveys: closed, draftSurveys: draft, assignedOpen, completedOpen, openResponseRate: responseRate(completedOpen, assignedOpen), latestEnps, recent };
  },

  /** Aggregate CSV: one block per question with distribution, plus themes and eNPS. Suppressed groups export as a single suppressed line. */
  async csv(auth: AuthContext, surveyId: string, filter: ResultsFilter): Promise<string> {
    const o = await this.overview(auth, surveyId, filter);
    const lines: string[] = [[ 'Survey', o.survey.name ].map(csvCell).join(','), ['Mode', o.survey.responseMode].map(csvCell).join(','), ['Assigned', String(o.participation.assigned)].map(csvCell).join(','), ['Completed', String(o.participation.completed)].map(csvCell).join(','), ['Response rate', o.participation.responseRate === null ? '' : String(o.participation.responseRate)].map(csvCell).join(','), ''];
    if (o.result.suppressed) { lines.push(['Result', 'SUPPRESSED', `minimum group size ${o.result.minimumGroupSize}`].map(csvCell).join(',')); return lines.join('\r\n'); }
    lines.push(['Question', 'Theme', 'Type', 'Responses', 'Average', 'Value', 'Label', 'Count', 'Percent'].map(csvCell).join(','));
    for (const q of o.result.questions) { if (q.distribution.length === 0) lines.push([q.text, q.theme ?? '', q.questionType, String(q.responseCount), q.average === null ? '' : String(q.average), '', '', '', ''].map(csvCell).join(',')); for (const d of q.distribution) lines.push([q.text, q.theme ?? '', q.questionType, String(q.responseCount), q.average === null ? '' : String(q.average), d.value, d.label ?? '', String(d.count), String(d.pct)].map(csvCell).join(',')); }
    lines.push('', ['Theme', 'Scale', 'Questions', 'Responses', 'Average'].map(csvCell).join(','));
    for (const t of o.result.themes) lines.push([t.theme, t.scale, String(t.questionCount), String(t.responseCount), t.average === null ? '' : String(t.average)].map(csvCell).join(','));
    if (o.result.enps) lines.push('', ['eNPS', String(o.result.enps.score ?? ''), `promoters ${o.result.enps.promoters}`, `passives ${o.result.enps.passives}`, `detractors ${o.result.enps.detractors}`, `valid ${o.result.enps.valid}`].map(csvCell).join(','));
    return lines.join('\r\n');
  },
};
export { aggregate as aggregateEngagement, loadQuestions as loadSurveyQuestions };
