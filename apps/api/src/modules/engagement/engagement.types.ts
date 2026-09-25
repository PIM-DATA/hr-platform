import type { Prisma } from '@prisma/client';
import { PERMISSIONS, type AuditAction, type AuditModule, type QuestionConfig, type SurveyQuestionDto } from '@hr/shared';
import { AppError } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { hasPermission } from '../../services/authorization/authorization.service';
import type { AuthContext } from '../auth/auth.types';

export type Tx = Prisma.TransactionClient;
export type Db = Prisma.TransactionClient | typeof prisma;
export type Actor = { auth: AuthContext; ipAddress: string | null; userAgent: string | null };

/**
 * Engagement audit entries record survey administration and participation metadata. Never an answer, never a
 * comment. For an anonymous submission the event is survey-level: it carries no response id, so the generic
 * actor column can only say "this person participated" — which the assignment row already says.
 */
export const engagementAudit = (actor: Actor, action: AuditAction, recordType: string, recordId: string, newValue: unknown, oldValue?: unknown) => ({
  userId: actor.auth.userId, ipAddress: actor.ipAddress, userAgent: actor.userAgent, action, module: 'engagement' as AuditModule, recordType, recordId, oldValue, newValue,
});
export const textAudit = (field: string, before: string | null | undefined, after: string | null | undefined) =>
  (before ?? null) === (after ?? null) ? {} : { [`${field}Changed`]: true, [`${field}Length`]: after?.length ?? 0 };
export const notFound = (what: string) => new AppError(404, `${what.toUpperCase().replace(/ /g, '_')}_NOT_FOUND`, `${what.charAt(0).toUpperCase()}${what.slice(1)} not found`);

export const canManage = (auth: AuthContext) => hasPermission(auth, PERMISSIONS.ENGAGEMENT_MANAGE);
export const canViewResults = (auth: AuthContext) => hasPermission(auth, PERMISSIONS.ENGAGEMENT_VIEW_RESULTS) || canManage(auth);

export const lockSurvey = (tx: Tx, id: string) => tx.$executeRaw`SELECT "id" FROM "engagement_surveys" WHERE "id" = ${id} FOR UPDATE`;
/** Submitters hold a share lock on the survey so a close (which takes the exclusive lock) is ordered before or after every whole submission, never in the middle. */
export const shareLockSurvey = (tx: Tx, id: string) => tx.$executeRaw`SELECT "id" FROM "engagement_surveys" WHERE "id" = ${id} FOR SHARE`;
export const lockAssignment = (tx: Tx, id: string) => tx.$executeRaw`SELECT "id" FROM "engagement_survey_assignments" WHERE "id" = ${id} FOR UPDATE`;

/**
 * Which departments a results reader may aggregate. ALL scope → everything. TEAM scope → the reader's own
 * department plus departments they head (the same rule as workforce planning). SELF → nothing.
 */
export async function visibleDepartmentIds(db: Db, auth: AuthContext): Promise<string[] | null> {
  if (auth.dataScope === 'ALL') return null;
  if (auth.dataScope !== 'TEAM' || !auth.employeeId) return [];
  const [me, headed] = await Promise.all([
    db.employee.findUnique({ where: { id: auth.employeeId }, select: { departmentId: true } }),
    db.department.findMany({ where: { headEmployeeId: auth.employeeId }, select: { id: true } }),
  ]);
  return [...new Set([me?.departmentId, ...headed.map((d) => d.id)].filter((x): x is string => !!x))];
}

type QuestionRow = { id: string; sourceQuestionId: string | null; questionTextSnapshot: string; themeSnapshot: string | null; questionType: string; required: boolean; scaleMin: number | null; scaleMax: number | null; isEnpsPrimary: boolean; displayOrder: number; configuration: unknown };
export function questionDto(q: QuestionRow): SurveyQuestionDto {
  const c = (q.configuration ?? {}) as QuestionConfig;
  return { id: q.id, sourceQuestionId: q.sourceQuestionId, text: q.questionTextSnapshot, theme: q.themeSnapshot, questionType: q.questionType as SurveyQuestionDto['questionType'], required: q.required, scaleMin: q.scaleMin, scaleMax: q.scaleMax, scaleLabels: c.scaleLabels ?? null, options: c.options ?? [], maxLength: c.maxLength ?? null, isEnpsPrimary: q.isEnpsPrimary, displayOrder: q.displayOrder };
}
/** Scale bounds implied by a type when the configuration does not set them. ENPS is fixed at 0–10. */
export function scaleFor(questionType: string, config: QuestionConfig): { scaleMin: number | null; scaleMax: number | null } {
  if (questionType === 'ENPS') return { scaleMin: 0, scaleMax: 10 };
  if (questionType === 'LIKERT') return { scaleMin: config.scaleMin ?? 1, scaleMax: config.scaleMax ?? 5 };
  if (questionType === 'SCALE') return { scaleMin: config.scaleMin ?? 1, scaleMax: config.scaleMax ?? 10 };
  return { scaleMin: null, scaleMax: null };
}
