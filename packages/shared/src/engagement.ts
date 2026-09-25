/**
 * Employee engagement surveys and eNPS — pure domain helpers (Task 33).
 *
 * Feedback is collected, aggregated and reported. Nothing here scores a person, ranks a team or feeds another
 * domain. Anonymity is a storage and reporting discipline, not a cryptographic guarantee, and the helpers say so.
 */
export const SURVEY_TYPES = ['ENGAGEMENT', 'ENPS', 'PULSE', 'CUSTOM'] as const;
export type SurveyType = (typeof SURVEY_TYPES)[number];
export const RESPONSE_MODES = ['ANONYMOUS', 'IDENTIFIED'] as const;
export type ResponseMode = (typeof RESPONSE_MODES)[number];
export const SURVEY_STATUSES = ['DRAFT', 'OPEN', 'CLOSED', 'ARCHIVED'] as const;
export type SurveyStatus = (typeof SURVEY_STATUSES)[number];
export const QUESTION_TYPES = ['LIKERT', 'SCALE', 'SINGLE_CHOICE', 'MULTI_CHOICE', 'YES_NO', 'TEXT', 'ENPS'] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];

/** Minimum reporting group for anonymous surveys: configurable per survey inside this range; never hardcoded in a calculation. */
export const ANONYMITY_GROUP_SIZE = { min: 3, max: 20, default: 5 } as const;
export const TEXT_ANSWER_MAX_CHARS = 2000;
export const ENPS_RANGE = { min: 0, max: 10 } as const;

/**
 * eNPS from the valid answers to the primary ENPS question. Promoters 9–10, passives 7–8, detractors 0–6.
 * score = promoter% − detractor%, rounded half-up to one decimal, in [−100, 100]. Unanswered assignments are not
 * part of the denominator — only valid ENPS answers are.
 */
export function enpsScore(values: number[]): { valid: number; promoters: number; passives: number; detractors: number; promoterPct: number; detractorPct: number; score: number | null } {
  const valid = values.filter((v) => Number.isInteger(v) && v >= ENPS_RANGE.min && v <= ENPS_RANGE.max);
  const promoters = valid.filter((v) => v >= 9).length;
  const detractors = valid.filter((v) => v <= 6).length;
  const passives = valid.length - promoters - detractors;
  const pct = (n: number) => (valid.length ? round1((n / valid.length) * 100) : 0);
  return { valid: valid.length, promoters, passives, detractors, promoterPct: pct(promoters), detractorPct: pct(detractors), score: valid.length ? round1(((promoters - detractors) / valid.length) * 100) : null };
}
export const round1 = (n: number): number => Math.round((n + Number.EPSILON) * 10) / 10;
/** Response rate = completed assignments ÷ assigned employees (the frozen audience), as a percentage with one decimal. */
export const responseRate = (completed: number, assigned: number): number | null => (assigned ? round1((completed / assigned) * 100) : null);

/** Whether an anonymous subgroup may be reported. Applied after every filter, to every actor, with the survey's own threshold. */
export const meetsThreshold = (responseCount: number, mode: ResponseMode, minimumGroupSize: number): boolean => mode === 'IDENTIFIED' || responseCount >= minimumGroupSize;

export interface QuestionShape { questionType: QuestionType; required: boolean; scaleMin: number | null; scaleMax: number | null; options: { code: string; label: string }[]; maxLength: number | null }
export interface AnswerInput { questionId: string; numericValue?: number | null; booleanValue?: boolean | null; textValue?: string | null; choiceValues?: string[] | null }

/** Validates one answer against its question. Returns an error message or null. Server-side only rule. */
export function validateAnswer(q: QuestionShape, a: AnswerInput | undefined): string | null {
  const empty = !a || ((a.numericValue === null || a.numericValue === undefined) && (a.booleanValue === null || a.booleanValue === undefined) && !a.textValue?.trim() && !(a.choiceValues && a.choiceValues.length));
  if (empty) return q.required ? 'This question is required' : null;
  const only = (keys: (keyof AnswerInput)[]) => { for (const k of ['numericValue', 'booleanValue', 'textValue', 'choiceValues'] as const) if (!keys.includes(k) && a![k] !== undefined && a![k] !== null && !(k === 'choiceValues' && Array.isArray(a![k]) && (a![k] as string[]).length === 0) && !(k === 'textValue' && a![k] === '')) return `Unexpected ${k} for a ${q.questionType} question`; return null; };
  switch (q.questionType) {
    case 'LIKERT': case 'SCALE': case 'ENPS': {
      const bad = only(['numericValue']); if (bad) return bad;
      const v = a!.numericValue; const min = q.scaleMin ?? 1; const max = q.scaleMax ?? 5;
      if (typeof v !== 'number' || !Number.isInteger(v)) return 'Answer must be a whole number';
      if (v < min || v > max) return `Answer must be between ${min} and ${max}`;
      return null;
    }
    case 'YES_NO': { const bad = only(['booleanValue']); if (bad) return bad; return typeof a!.booleanValue === 'boolean' ? null : 'Answer must be yes or no'; }
    case 'TEXT': { const bad = only(['textValue']); if (bad) return bad; const t = a!.textValue ?? ''; return t.length > (q.maxLength ?? TEXT_ANSWER_MAX_CHARS) ? `Answer must be at most ${q.maxLength ?? TEXT_ANSWER_MAX_CHARS} characters` : null; }
    case 'SINGLE_CHOICE': case 'MULTI_CHOICE': {
      const bad = only(['choiceValues']); if (bad) return bad;
      const c = a!.choiceValues ?? [];
      if (q.questionType === 'SINGLE_CHOICE' && c.length !== 1) return 'Choose exactly one option';
      if (new Set(c).size !== c.length) return 'Duplicate option';
      const codes = new Set(q.options.map((o) => o.code));
      for (const x of c) if (!codes.has(x)) return 'Unknown option';
      return null;
    }
  }
}
/** Questions whose numeric scale is identical can be averaged together under a theme; others are never mixed. */
export const scaleKey = (q: { questionType: QuestionType; scaleMin: number | null; scaleMax: number | null }): string | null => (q.questionType === 'LIKERT' || q.questionType === 'SCALE' ? `${q.questionType}:${q.scaleMin}-${q.scaleMax}` : null);
