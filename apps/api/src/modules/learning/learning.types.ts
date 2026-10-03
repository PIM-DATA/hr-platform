import type { Prisma } from '@prisma/client';
import { PERMISSIONS, type AuditAction, type AuditModule, type LearningSnapshotDto } from '@hr/shared';
import { AppError } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { hasPermission } from '../../services/authorization/authorization.service';
import type { AuthContext } from '../auth/auth.types';
import { businessYear } from '../../services/business-time/business-time';
import { employeeScopeWhere } from '../employees/employees.scope';

export type Tx = Prisma.TransactionClient;
export type Db = Prisma.TransactionClient | typeof prisma;
export type Actor = { auth: AuthContext; ipAddress: string | null; userAgent: string | null };

/** Learning audit: statuses, dates, counts, lengths. Never a trainer comment, a reflection, evidence content or a certificate number. */
export const learningAudit = (actor: Actor, action: AuditAction, recordType: string, recordId: string, newValue: unknown, oldValue?: unknown) => ({
  userId: actor.auth.userId, ipAddress: actor.ipAddress, userAgent: actor.userAgent, action, module: 'learning' as AuditModule, recordType, recordId, oldValue, newValue,
});
export const textAudit = (field: string, before: string | null | undefined, after: string | null | undefined) =>
  (before ?? null) === (after ?? null) ? {} : { [`${field}Changed`]: true, [`${field}Length`]: after?.length ?? 0 };
export const notFound = (what: string) => new AppError(404, `${what.toUpperCase().replace(/ /g, '_')}_NOT_FOUND`, `${what.charAt(0).toUpperCase()}${what.slice(1)} not found`);
export const has = (auth: AuthContext, ...perms: string[]) => perms.some((p) => hasPermission(auth, p));
export const P = PERMISSIONS;

export const lockRow = (tx: Tx, table: 'ojt_plans' | 'ojt_plan_activities' | 'learning_path_assignments' | 'employee_certifications', id: string) => {
  switch (table) {
    case 'ojt_plans': return tx.$executeRaw`SELECT "id" FROM "ojt_plans" WHERE "id" = ${id} FOR UPDATE`;
    case 'ojt_plan_activities': return tx.$executeRaw`SELECT "id" FROM "ojt_plan_activities" WHERE "id" = ${id} FOR UPDATE`;
    case 'learning_path_assignments': return tx.$executeRaw`SELECT "id" FROM "learning_path_assignments" WHERE "id" = ${id} FOR UPDATE`;
    case 'employee_certifications': return tx.$executeRaw`SELECT "id" FROM "employee_certifications" WHERE "id" = ${id} FOR UPDATE`;
  }
};
export async function nextPlanNumber(tx: Tx, employeeId: string): Promise<string> {
  const year = await businessYear(tx, { employeeId }); const kind = 'ojt'; // Task 53: the trainee's business year
  await tx.learningSequence.upsert({ where: { kind_year: { kind, year } }, create: { kind, year, next: 1 }, update: {} });
  await tx.$executeRaw`SELECT "next" FROM "learning_sequences" WHERE "kind" = ${kind} AND "year" = ${year} FOR UPDATE`;
  const row = await tx.learningSequence.findUniqueOrThrow({ where: { kind_year: { kind, year } } });
  await tx.learningSequence.update({ where: { kind_year: { kind, year } }, data: { next: row.next + 1 } });
  return `OJT-${year}-${String(row.next).padStart(6, '0')}`;
}

export async function employeeSnapshot(db: Db, employeeId: string) {
  const e = await db.employee.findUnique({ where: { id: employeeId }, include: { organization: { select: { name: true } }, department: { select: { id: true, name: true } }, position: { select: { title: true, job: { select: { title: true } } } }, user: { select: { id: true, isActive: true } } } });
  if (!e) throw new AppError(404, 'EMPLOYEE_NOT_FOUND', 'Employee not found');
  return { employee: e, data: { employeeCodeSnapshot: e.employeeCode, employeeNameSnapshot: `${e.firstName} ${e.lastName}`, organizationSnapshot: e.organization.name, departmentSnapshot: e.department.name, departmentIdSnapshot: e.department.id, jobSnapshot: e.position.job?.title ?? null, positionSnapshot: e.position.title } };
}
export const snapshotDto = (r: { employeeCodeSnapshot: string; employeeNameSnapshot: string; organizationSnapshot: string | null; departmentSnapshot: string | null; jobSnapshot: string | null; positionSnapshot: string | null }): LearningSnapshotDto =>
  ({ employeeCode: r.employeeCodeSnapshot, employeeName: r.employeeNameSnapshot, organization: r.organizationSnapshot, department: r.departmentSnapshot, job: r.jobSnapshot, position: r.positionSnapshot });

/** The employee module's own data scope, as a where on `employeeId`: own record, own team, or everyone. */
export async function scopedEmployeeIds(auth: AuthContext): Promise<string[] | null> {
  if (auth.dataScope === 'ALL') return null;
  const rows = await prisma.employee.findMany({ where: employeeScopeWhere(auth) as Prisma.EmployeeWhereInput, select: { id: true } });
  return rows.map((r) => r.id);
}
export async function userNames(db: Db, ids: (string | null | undefined)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((x): x is string => !!x))];
  if (!unique.length) return new Map();
  const users = await db.user.findMany({ where: { id: { in: unique } }, select: { id: true, email: true, employee: { select: { firstName: true, lastName: true } } } });
  return new Map(users.map((u) => [u.id, u.employee ? `${u.employee.firstName} ${u.employee.lastName}` : u.email]));
}
