import { z } from 'zod';
import { ANONYMITY_GROUP_SIZE, QUESTION_TYPES, RESPONSE_MODES, SURVEY_STATUSES, SURVEY_TYPES, TEXT_ANSWER_MAX_CHARS } from '../engagement';
import { paginationQuerySchema } from './common';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');
const text = (max: number) => z.string().trim().max(max).nullable().optional();
const optionSchema = z.object({ code: z.string().trim().min(1).max(40), label: z.string().trim().min(1).max(200) }).strict();
/** The validated configuration for every type. Unknown keys are rejected so nothing else can ride along. */
export const questionConfigSchema = z.object({
  scaleMin: z.number().int().min(0).max(100).optional(),
  scaleMax: z.number().int().min(1).max(100).optional(),
  scaleLabels: z.record(z.string(), z.string().trim().max(80)).optional(),
  options: z.array(optionSchema).max(20).optional(),
  maxLength: z.number().int().min(10).max(TEXT_ANSWER_MAX_CHARS).optional(),
}).strict();
export type QuestionConfig = z.infer<typeof questionConfigSchema>;

const questionBase = { text: z.string().trim().min(3).max(500), theme: text(80), questionType: z.enum(QUESTION_TYPES), required: z.boolean().optional(), config: questionConfigSchema.optional() };
/** Type-specific rules shared by the bank and by survey questions. */
export function refineQuestion<T extends { questionType: (typeof QUESTION_TYPES)[number]; config?: QuestionConfig }>(v: T, ctx: z.RefinementCtx) {
  const c = v.config ?? {};
  const scaled = v.questionType === 'LIKERT' || v.questionType === 'SCALE';
  if (scaled) { const min = c.scaleMin ?? 1; const max = c.scaleMax ?? (v.questionType === 'LIKERT' ? 5 : 10); if (min >= max) ctx.addIssue({ code: 'custom', path: ['config', 'scaleMax'], message: 'scaleMax must be greater than scaleMin' }); if (max - min > 20) ctx.addIssue({ code: 'custom', path: ['config', 'scaleMax'], message: 'At most 21 points on a scale' }); }
  if (v.questionType === 'ENPS' && (c.scaleMin !== undefined || c.scaleMax !== undefined)) ctx.addIssue({ code: 'custom', path: ['config'], message: 'ENPS is always 0–10' });
  if ((v.questionType === 'SINGLE_CHOICE' || v.questionType === 'MULTI_CHOICE') && (!c.options || c.options.length < 2)) ctx.addIssue({ code: 'custom', path: ['config', 'options'], message: 'Choice questions need at least two options' });
  if (c.options && new Set(c.options.map((o) => o.code)).size !== c.options.length) ctx.addIssue({ code: 'custom', path: ['config', 'options'], message: 'Option codes must be unique' });
}
export const createQuestionBankSchema = z.object({ code: z.string().trim().min(2).max(40).regex(/^[A-Z0-9_-]+$/i), ...questionBase }).strict().superRefine(refineQuestion);
export type CreateQuestionBankInput = z.infer<typeof createQuestionBankSchema>;
export const updateQuestionBankSchema = z.object({ text: z.string().trim().min(3).max(500).optional(), theme: text(80), required: z.boolean().optional(), config: questionConfigSchema.optional(), isActive: z.boolean().optional() }).strict();
export type UpdateQuestionBankInput = z.infer<typeof updateQuestionBankSchema>;
export const questionBankListQuerySchema = z.object({ includeInactive: z.coerce.boolean().optional(), theme: z.string().trim().max(80).optional(), search: z.string().trim().max(120).optional() });

// ---------- surveys ----------
export const createSurveySchema = z.object({
  code: z.string().trim().min(2).max(40).regex(/^[A-Z0-9_-]+$/i),
  name: z.string().trim().min(2).max(160),
  description: text(2000),
  organizationId: z.string().min(1).nullable().optional(),
  surveyType: z.enum(SURVEY_TYPES),
  responseMode: z.enum(RESPONSE_MODES),
  minimumAnonymousGroupSize: z.number().int().min(ANONYMITY_GROUP_SIZE.min).max(ANONYMITY_GROUP_SIZE.max).optional(),
  periodStart: date.nullable().optional(),
  periodEnd: date.nullable().optional(),
}).strict().refine((v) => !v.periodStart || !v.periodEnd || v.periodStart <= v.periodEnd, { message: 'periodEnd must not be before periodStart', path: ['periodEnd'] });
export type CreateSurveyInput = z.infer<typeof createSurveySchema>;
export const updateSurveySchema = z.object({
  name: z.string().trim().min(2).max(160).optional(), description: text(2000), surveyType: z.enum(SURVEY_TYPES).optional(), responseMode: z.enum(RESPONSE_MODES).optional(),
  minimumAnonymousGroupSize: z.number().int().min(ANONYMITY_GROUP_SIZE.min).max(ANONYMITY_GROUP_SIZE.max).optional(), periodStart: date.nullable().optional(), periodEnd: date.nullable().optional(),
}).strict();
export type UpdateSurveyInput = z.infer<typeof updateSurveySchema>;
export const surveyListQuerySchema = paginationQuerySchema.extend({ status: z.enum(SURVEY_STATUSES).optional(), organizationId: z.string().min(1).optional(), surveyType: z.enum(SURVEY_TYPES).optional() });
export type SurveyListQuery = z.infer<typeof surveyListQuerySchema>;
export const duplicateSurveySchema = z.object({ code: z.string().trim().min(2).max(40).regex(/^[A-Z0-9_-]+$/i), name: z.string().trim().min(2).max(160) }).strict();

export const addSurveyQuestionSchema = z.object({ sourceQuestionId: z.string().min(1).optional(), ...questionBase, text: z.string().trim().min(3).max(500).optional(), questionType: z.enum(QUESTION_TYPES).optional(), isEnpsPrimary: z.boolean().optional(), displayOrder: z.number().int().min(0).max(1000).optional() }).strict()
  .superRefine((v, ctx) => { if (!v.sourceQuestionId && (!v.text || !v.questionType)) ctx.addIssue({ code: 'custom', path: ['text'], message: 'Give a bank question or a text and a type' }); if (v.questionType) refineQuestion({ questionType: v.questionType, config: v.config }, ctx); });
export type AddSurveyQuestionInput = z.infer<typeof addSurveyQuestionSchema>;
export const updateSurveyQuestionSchema = z.object({ text: z.string().trim().min(3).max(500).optional(), theme: text(80), required: z.boolean().optional(), config: questionConfigSchema.optional(), isEnpsPrimary: z.boolean().optional(), displayOrder: z.number().int().min(0).max(1000).optional() }).strict().refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type UpdateSurveyQuestionInput = z.infer<typeof updateSurveyQuestionSchema>;

export const assignAudienceSchema = z.object({
  organizationIds: z.array(z.string().min(1)).max(50).optional(),
  departmentIds: z.array(z.string().min(1)).max(200).optional(),
  jobIds: z.array(z.string().min(1)).max(200).optional(),
  positionIds: z.array(z.string().min(1)).max(500).optional(),
  employeeIds: z.array(z.string().min(1)).max(5000).optional(),
}).strict().refine((v) => Object.values(v).some((x) => x && x.length), { message: 'Choose at least one audience criterion' });
export type AssignAudienceInput = z.infer<typeof assignAudienceSchema>;

export const submitResponseSchema = z.object({
  answers: z.array(z.object({ questionId: z.string().min(1), numericValue: z.number().int().nullable().optional(), booleanValue: z.boolean().nullable().optional(), textValue: z.string().max(TEXT_ANSWER_MAX_CHARS).nullable().optional(), choiceValues: z.array(z.string().min(1).max(40)).max(20).nullable().optional() }).strict()).max(200),
}).strict();
export type SubmitResponseInput = z.infer<typeof submitResponseSchema>;

/** Result filters. The threshold is applied after all of them, so stacking filters can only make a group suppressed. */
export const resultsFilterSchema = z.object({ organizationId: z.string().min(1).optional(), departmentId: z.string().min(1).optional(), jobId: z.string().min(1).optional(), positionId: z.string().min(1).optional() });
export type ResultsFilter = z.infer<typeof resultsFilterSchema>;
export const breakdownQuerySchema = resultsFilterSchema.extend({ by: z.enum(['department', 'job', 'organization']).default('department') });
export const participationQuerySchema = paginationQuerySchema.extend({ completed: z.enum(['true', 'false']).optional(), departmentId: z.string().min(1).optional() });

// ---------- DTOs ----------
export interface QuestionBankDto { id: string; code: string; theme: string | null; text: string; questionType: (typeof QUESTION_TYPES)[number]; defaultRequired: boolean; config: QuestionConfig; isActive: boolean; usedBySurveys: number; createdAt: string; updatedAt: string }
export interface SurveyQuestionDto { id: string; sourceQuestionId: string | null; text: string; theme: string | null; questionType: (typeof QUESTION_TYPES)[number]; required: boolean; scaleMin: number | null; scaleMax: number | null; scaleLabels: Record<string, string> | null; options: { code: string; label: string }[]; maxLength: number | null; isEnpsPrimary: boolean; displayOrder: number }
export interface SurveyDto {
  id: string; code: string; name: string; description: string | null; organizationId: string | null; organizationName: string | null; surveyType: (typeof SURVEY_TYPES)[number]; responseMode: (typeof RESPONSE_MODES)[number];
  minimumAnonymousGroupSize: number; periodStart: string | null; periodEnd: string | null; status: (typeof SURVEY_STATUSES)[number]; questionCount: number; audienceCount: number; completedCount: number; responseRate: number | null;
  openedAt: string | null; closedAt: string | null; archivedAt: string | null; duplicatedFromId: string | null; createdByUserId: string; createdAt: string; updatedAt: string; can: { edit: boolean; open: boolean; close: boolean };
}
export interface SurveyDetailDto extends SurveyDto { questions: SurveyQuestionDto[] }
/** What an employee sees before answering. Never another person's answer. */
export interface MySurveyDto { surveyId: string; code: string; name: string; description: string | null; surveyType: (typeof SURVEY_TYPES)[number]; responseMode: (typeof RESPONSE_MODES)[number]; periodEnd: string | null; status: (typeof SURVEY_STATUSES)[number]; completed: boolean; completedAt: string | null; questionCount: number }
export interface SurveyFormDto { survey: MySurveyDto; questions: SurveyQuestionDto[]; notice: string }
/**
 * `completed` is null (with `completionHidden`) for an anonymous survey when the person's department is a suppressed
 * group: knowing exactly who answered in a group whose results are hidden is the other half of a differencing attack
 * (Task 47). Anonymous surveys never show an exact completion time.
 */
export interface ParticipationRowDto { assignmentId: string; employee: { id: string; employeeCode: string; firstName: string; lastName: string }; departmentName: string | null; jobTitle: string | null; invitedAt: string; completed: boolean | null; completionHidden: boolean; completedAt: string | null }

export interface QuestionResultDto {
  questionId: string; text: string; theme: string | null; questionType: (typeof QUESTION_TYPES)[number]; scaleMin: number | null; scaleMax: number | null; isEnpsPrimary: boolean;
  responseCount: number; average: number | null; distribution: { value: string; label: string | null; count: number; pct: number }[]; yes: number | null; no: number | null; commentCount: number | null;
}
export interface EnpsResultDto { questionId: string; valid: number; promoters: number; passives: number; detractors: number; promoterPct: number; detractorPct: number; score: number | null }
export interface ThemeResultDto { theme: string; scale: string; questionCount: number; average: number | null; responseCount: number }
export interface SuppressedResultDto { suppressed: true; minimumGroupSize: number; reason: string }
export interface VisibleResultDto { suppressed: false; responseCount: number; questions: QuestionResultDto[]; themes: ThemeResultDto[]; enps: EnpsResultDto | null }
export interface SurveyResultsDto {
  survey: { id: string; code: string; name: string; responseMode: (typeof RESPONSE_MODES)[number]; status: (typeof SURVEY_STATUSES)[number]; minimumAnonymousGroupSize: number; openedAt: string | null; closedAt: string | null };
  scope: { filtered: boolean; teamScoped: boolean };
  participation: { assigned: number; completed: number; responseRate: number | null };
  result: VisibleResultDto | SuppressedResultDto;
  generatedAt: string;
}
export interface BreakdownRowDto { key: string; name: string; assigned: number; completed: number; responseRate: number | null; result: VisibleResultDto | SuppressedResultDto }
export interface CommentDto { questionId: string; text: string; respondent: { employeeCode: string; firstName: string; lastName: string } | null }
export interface IdentifiedResponseDto { responseId: string; employee: { id: string; employeeCode: string; firstName: string; lastName: string }; submittedAt: string; answers: { questionId: string; numericValue: number | null; booleanValue: boolean | null; textValue: string | null; choiceValues: string[] | null }[] }
export interface EngagementDashboardDto { openSurveys: number; closedSurveys: number; draftSurveys: number; assignedOpen: number; completedOpen: number; openResponseRate: number | null; latestEnps: { surveyId: string; surveyName: string; score: number | null; suppressed: boolean } | null; recent: { id: string; code: string; name: string; status: string; responseMode: string; responseRate: number | null; closedAt: string | null }[] }
