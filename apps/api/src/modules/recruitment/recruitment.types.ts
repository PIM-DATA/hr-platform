import type { Prisma } from '@prisma/client';
import { PERMISSIONS, formatRecruitmentNumber, type AuditAction, type AuditModule, type RecruitmentNumberKind } from '@hr/shared';
import { AppError } from '../../lib/errors';
import { hasPermission } from '../../services/authorization/authorization.service';
import { businessYear } from '../../services/business-time/business-time';
import type { AuthContext } from '../auth/auth.types';

export type Tx = Prisma.TransactionClient;
export type Db = Prisma.TransactionClient | typeof import('../../lib/prisma').prisma;
export type Actor = { auth: AuthContext; ipAddress: string | null; userAgent: string | null };

/**
 * Audit entries for recruitment. A candidate is a person outside the company who has agreed to nothing yet, so the
 * audit log records that a profile was created or changed and by whom — never the profile itself, never interview
 * feedback, never an offer figure. Those stay behind their own authorization.
 */
export const recruitmentAudit = (actor: Actor, action: AuditAction, recordType: string, recordId: string, newValue: unknown, oldValue?: unknown) => ({
  userId: actor.auth.userId,
  ipAddress: actor.ipAddress,
  userAgent: actor.userAgent,
  action,
  module: 'recruitment' as AuditModule,
  recordType,
  recordId,
  oldValue,
  newValue,
});

/** What an audit entry may say about free text: that it changed and how long it is. Never the text. */
export const textAudit = (field: string, before: string | null | undefined, after: string | null | undefined) =>
  (before ?? null) === (after ?? null) ? {} : { [`${field}Changed`]: true, [`${field}Length`]: after?.length ?? 0 };

/**
 * Who sees what.
 *
 * `recruitment.manage` is the administrative view: every requisition, opening, candidate and application. Plain
 * `recruitment.view` is purpose-specific: a hiring manager sees the requisitions and openings they are named on and
 * the applications to those openings; an interviewer sees the interviews they are assigned to and those applications.
 * Nobody's data scope, team or seniority opens anything here — an executive with every dashboard has no candidates.
 */
export const isRecruitmentAdmin = (auth: AuthContext) => hasPermission(auth, PERMISSIONS.RECRUITMENT_MANAGE);
export const canSeeCompensation = (auth: AuthContext) => hasPermission(auth, PERMISSIONS.RECRUITMENT_MANAGE_OFFERS);

/** Applications a non-admin may read: as the opening's hiring manager, or as an interviewer on one of its interviews. */
export const applicationScopeWhere = (auth: AuthContext): Prisma.RecruitmentApplicationWhereInput =>
  isRecruitmentAdmin(auth) ? {} : { OR: [{ hiringManagerUserId: auth.userId }, { interviews: { some: { interviewers: { some: { userId: auth.userId } } } } }] };

export const notFound = (what: string) => new AppError(404, `${what.toUpperCase()}_NOT_FOUND`, `${what.charAt(0).toUpperCase()}${what.slice(1).toLowerCase().replace(/_/g, ' ')} not found`);

/**
 * The next document number of a kind, for this year, under a row lock. Two recruiters creating candidates in the same
 * instant queue on the counter row rather than getting the same number.
 */
export async function nextNumber(tx: Tx, kind: RecruitmentNumberKind): Promise<string> {
  const year = await businessYear(tx); // Task 53: the reference organization's business year (was UTC)
  await tx.recruitmentSequence.upsert({ where: { kind_year: { kind, year } }, create: { kind, year, next: 1 }, update: {} });
  await tx.$executeRaw`SELECT "next" FROM "recruitment_sequences" WHERE "kind" = ${kind} AND "year" = ${year} FOR UPDATE`;
  const row = await tx.recruitmentSequence.findUniqueOrThrow({ where: { kind_year: { kind, year } } });
  await tx.recruitmentSequence.update({ where: { kind_year: { kind, year } }, data: { next: row.next + 1 } });
  return formatRecruitmentNumber(kind, year, row.next);
}

export const lockRow = (tx: Tx, table: 'recruitment_requisitions' | 'recruitment_openings' | 'recruitment_candidates' | 'recruitment_applications' | 'recruitment_interviews' | 'recruitment_offers', id: string) => {
  switch (table) {
    case 'recruitment_requisitions': return tx.$executeRaw`SELECT "id" FROM "recruitment_requisitions" WHERE "id" = ${id} FOR UPDATE`;
    case 'recruitment_openings': return tx.$executeRaw`SELECT "id" FROM "recruitment_openings" WHERE "id" = ${id} FOR UPDATE`;
    case 'recruitment_candidates': return tx.$executeRaw`SELECT "id" FROM "recruitment_candidates" WHERE "id" = ${id} FOR UPDATE`;
    case 'recruitment_applications': return tx.$executeRaw`SELECT "id" FROM "recruitment_applications" WHERE "id" = ${id} FOR UPDATE`;
    case 'recruitment_interviews': return tx.$executeRaw`SELECT "id" FROM "recruitment_interviews" WHERE "id" = ${id} FOR UPDATE`;
    case 'recruitment_offers': return tx.$executeRaw`SELECT "id" FROM "recruitment_offers" WHERE "id" = ${id} FOR UPDATE`;
  }
};

/** The employee record behind a user, for a workflow requester. */
export async function requesterEmployeeId(db: Db, userId: string): Promise<string> {
  const employee = await db.employee.findFirst({ where: { user: { id: userId } }, select: { id: true } });
  if (!employee) throw new AppError(409, 'EMPLOYEE_PROFILE_REQUIRED', 'Submitting for approval needs an account linked to an employee record');
  return employee.id;
}

export const fullName = (e: { firstName: string; lastName: string } | null | undefined) => (e ? `${e.firstName} ${e.lastName}`.trim() : null);
