import type { Prisma } from '@prisma/client';
import { PERMISSIONS, type AuditAction, type AuditModule } from '@hr/shared';
import { AppError } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { hasPermission } from '../../services/authorization/authorization.service';
import type { AuthContext } from '../auth/auth.types';

export type Tx = Prisma.TransactionClient;
export type Db = Prisma.TransactionClient | typeof prisma;
export type Actor = { auth: AuthContext; ipAddress: string | null; userAgent: string | null };

/**
 * Audit entries for career, talent and succession. A potential comment and a succession note are among the most
 * sensitive words HR writes about somebody: the log records that they changed and how long they are, never the text.
 * A potential level, a cell or a readiness is a person's decision and is logged as a code with the actor's name.
 */
export const talentAudit = (actor: Actor, action: AuditAction, recordType: string, recordId: string, newValue: unknown, oldValue?: unknown) => ({
  userId: actor.auth.userId, ipAddress: actor.ipAddress, userAgent: actor.userAgent, action, module: 'talent' as AuditModule, recordType, recordId, oldValue, newValue,
});
export const textAudit = (field: string, before: string | null | undefined, after: string | null | undefined) =>
  (before ?? null) === (after ?? null) ? {} : { [`${field}Changed`]: true, [`${field}Length`]: after?.length ?? 0 };

export const canManageTalent = (auth: AuthContext) => hasPermission(auth, PERMISSIONS.TALENT_MANAGE);
export const canManageSuccession = (auth: AuthContext) => hasPermission(auth, PERMISSIONS.SUCCESSION_MANAGE);
export const notFound = (what: string) => new AppError(404, `${what.toUpperCase().replace(/ /g, '_')}_NOT_FOUND`, `${what.charAt(0).toUpperCase()}${what.slice(1)} not found`);

export const lockRow = (tx: Tx, table: 'talent_review_cycles' | 'talent_reviews' | 'talent_pools' | 'succession_plans' | 'career_paths', id: string) => {
  switch (table) {
    case 'talent_review_cycles': return tx.$executeRaw`SELECT "id" FROM "talent_review_cycles" WHERE "id" = ${id} FOR UPDATE`;
    case 'talent_reviews': return tx.$executeRaw`SELECT "id" FROM "talent_reviews" WHERE "id" = ${id} FOR UPDATE`;
    case 'talent_pools': return tx.$executeRaw`SELECT "id" FROM "talent_pools" WHERE "id" = ${id} FOR UPDATE`;
    case 'succession_plans': return tx.$executeRaw`SELECT "id" FROM "succession_plans" WHERE "id" = ${id} FOR UPDATE`;
    case 'career_paths': return tx.$executeRaw`SELECT "id" FROM "career_paths" WHERE "id" = ${id} FOR UPDATE`;
  }
};

export const employeeRef = { select: { id: true, employeeCode: true, firstName: true, lastName: true } } as const;
export const jobRef = { select: { id: true, code: true, title: true } } as const;

/** The employee's development context, read from Task 25's tables: open needs and the active plan. Facts, no verdict. */
export async function developmentContext(db: Db, employeeId: string): Promise<{ openNeeds: number; activeIdpId: string | null; activeIdpTitle: string | null }> {
  const [openNeeds, idp] = await Promise.all([
    db.trainingNeed.count({ where: { employeeId, status: { in: ['OPEN', 'PLANNED', 'IN_PROGRESS'] } } }),
    db.individualDevelopmentPlan.findFirst({ where: { employeeId, status: 'ACTIVE' }, select: { id: true, title: true }, orderBy: { createdAt: 'desc' } }),
  ]);
  return { openNeeds, activeIdpId: idp?.id ?? null, activeIdpTitle: idp?.title ?? null };
}

/** Display name of a user, for "added by" / "nominated by" fields. */
export async function userNames(db: Db, ids: (string | null | undefined)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((x): x is string => !!x))];
  if (!unique.length) return new Map();
  const users = await db.user.findMany({ where: { id: { in: unique } }, select: { id: true, email: true, employee: { select: { firstName: true, lastName: true } } } });
  return new Map(users.map((u) => [u.id, u.employee ? `${u.employee.firstName} ${u.employee.lastName}` : u.email]));
}
