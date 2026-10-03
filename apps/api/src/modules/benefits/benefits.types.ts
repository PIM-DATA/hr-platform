import type { Prisma } from '@prisma/client';
import { PERMISSIONS, type AuditAction, type AuditModule, type BenefitSnapshotDto } from '@hr/shared';
import { AppError } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { hasPermission, scopeFor } from '../../services/authorization/authorization.service';
import { businessYear } from '../../services/business-time/business-time';
import type { AuthContext } from '../auth/auth.types';

export type Tx = Prisma.TransactionClient;
export type Db = Prisma.TransactionClient | typeof prisma;
export type Actor = { auth: AuthContext; ipAddress: string | null; userAgent: string | null };

/** Benefits audit: ids, statuses, decimal strings and text lengths. Never a description, a receipt name, a note's words. */
export const benefitsAudit = (actor: Actor, action: AuditAction, recordType: string, recordId: string, newValue: unknown, oldValue?: unknown) => ({
  userId: actor.auth.userId, ipAddress: actor.ipAddress, userAgent: actor.userAgent, action, module: 'benefits' as AuditModule, recordType, recordId, oldValue, newValue,
});
export const textAudit = (field: string, before: string | null | undefined, after: string | null | undefined) =>
  (before ?? null) === (after ?? null) ? {} : { [`${field}Changed`]: true, [`${field}Length`]: after?.length ?? 0 };
export const notFound = (what: string) => new AppError(404, `${what.toUpperCase().replace(/ /g, '_')}_NOT_FOUND`, `${what.charAt(0).toUpperCase()}${what.slice(1)} not found`);
export const has = (auth: AuthContext, ...perms: string[]) => perms.some((p) => hasPermission(auth, p));
export const P = PERMISSIONS;

export const lockRow = (tx: Tx, table: 'benefit_plans' | 'benefit_periods' | 'benefit_entitlements' | 'benefit_claims' | 'benefit_enrollments', id: string) => {
  switch (table) {
    case 'benefit_plans': return tx.$executeRaw`SELECT "id" FROM "benefit_plans" WHERE "id" = ${id} FOR UPDATE`;
    case 'benefit_periods': return tx.$executeRaw`SELECT "id" FROM "benefit_periods" WHERE "id" = ${id} FOR UPDATE`;
    case 'benefit_entitlements': return tx.$executeRaw`SELECT "id" FROM "benefit_entitlements" WHERE "id" = ${id} FOR UPDATE`;
    case 'benefit_claims': return tx.$executeRaw`SELECT "id" FROM "benefit_claims" WHERE "id" = ${id} FOR UPDATE`;
    case 'benefit_enrollments': return tx.$executeRaw`SELECT "id" FROM "benefit_enrollments" WHERE "id" = ${id} FOR UPDATE`;
  }
};
export async function nextClaimNumber(tx: Tx, employeeId: string): Promise<string> {
  const year = await businessYear(tx, { employeeId }); const kind = 'claim'; // Task 53: the claimant's business year
  await tx.benefitSequence.upsert({ where: { kind_year: { kind, year } }, create: { kind, year, next: 1 }, update: {} });
  await tx.$executeRaw`SELECT "next" FROM "benefit_sequences" WHERE "kind" = ${kind} AND "year" = ${year} FOR UPDATE`;
  const row = await tx.benefitSequence.findUniqueOrThrow({ where: { kind_year: { kind, year } } });
  await tx.benefitSequence.update({ where: { kind_year: { kind, year } }, data: { next: row.next + 1 } });
  return `BCL-${year}-${String(row.next).padStart(6, '0')}`;
}

export const employeeInclude = { organization: { select: { id: true, name: true } }, department: { select: { id: true, name: true } }, position: { select: { id: true, title: true, jobId: true, job: { select: { title: true } } } }, user: { select: { id: true, isActive: true } } } as const;
export type EmployeeRow = Prisma.EmployeeGetPayload<{ include: typeof employeeInclude }>;
export async function employeeSnapshot(db: Db, employeeId: string) {
  const e = await db.employee.findUnique({ where: { id: employeeId }, include: employeeInclude });
  if (!e) throw new AppError(404, 'EMPLOYEE_NOT_FOUND', 'Employee not found');
  return { employee: e, data: snapshotData(e) };
}
export const snapshotData = (e: EmployeeRow) => ({ employeeCodeSnapshot: e.employeeCode, employeeNameSnapshot: `${e.firstName} ${e.lastName}`, organizationSnapshot: e.organization.name, departmentSnapshot: e.department.name, jobSnapshot: e.position?.job?.title ?? null, positionSnapshot: e.position?.title ?? null });
export const snapshotDto = (r: { employeeCodeSnapshot: string; employeeNameSnapshot: string; organizationSnapshot: string | null; departmentSnapshot: string | null; jobSnapshot: string | null; positionSnapshot: string | null }): BenefitSnapshotDto =>
  ({ employeeCode: r.employeeCodeSnapshot, employeeName: r.employeeNameSnapshot, organization: r.organizationSnapshot, department: r.departmentSnapshot, job: r.jobSnapshot, position: r.positionSnapshot });

/**
 * Who may see whose benefits. This module is deliberately narrower than the employee data scope: a manager's TEAM
 * scope never opens a subordinate's claims, balances or receipts. Only the organization-wide administrative
 * permissions (`benefits.view` / manage / review / record_payment) held with an ALL data scope see other people.
 */
export const adminScope = (auth: AuthContext): boolean => scopeFor(auth, P.BENEFITS_VIEW, P.BENEFITS_MANAGE, P.BENEFITS_REVIEW_CLAIMS, P.BENEFITS_RECORD_PAYMENT) === 'ALL' /* Task 50: the scope of these permissions, not of any role */;
/** A where clause on `employeeId`: everyone for administrators, otherwise exactly the caller's own record. */
export const visibleEmployeeWhere = (auth: AuthContext): { employeeId?: string } => (adminScope(auth) ? {} : { employeeId: auth.employeeId ?? '__none__' });
export const canSeeEmployee = (auth: AuthContext, employeeId: string): boolean => adminScope(auth) || (!!auth.employeeId && auth.employeeId === employeeId);
export async function userNames(db: Db, ids: (string | null | undefined)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((x): x is string => !!x))];
  if (!unique.length) return new Map();
  const users = await db.user.findMany({ where: { id: { in: unique } }, select: { id: true, email: true, employee: { select: { firstName: true, lastName: true } } } });
  return new Map(users.map((u) => [u.id, u.employee ? `${u.employee.firstName} ${u.employee.lastName}` : u.email]));
}
