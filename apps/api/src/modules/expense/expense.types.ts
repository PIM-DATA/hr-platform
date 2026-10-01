import type { Prisma } from '@prisma/client';
import { PERMISSIONS, businessToday, type AuditAction, type AuditModule, type ExpenseHistoryDto, type ExpenseSnapshotDto } from '@hr/shared';
import { AppError } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { hasPermission, scopeFor } from '../../services/authorization/authorization.service';
import type { AuthContext } from '../auth/auth.types';

export type Tx = Prisma.TransactionClient;
export type Db = Prisma.TransactionClient | typeof prisma;
export type Actor = { auth: AuthContext; ipAddress: string | null; userAgent: string | null };

/** Expense audit: ids, statuses, decimal strings, counts and text lengths. Never a purpose, merchant, description, receipt name, payment reference or workflow comment. */
export const expenseAudit = (actor: Actor, action: AuditAction, recordType: string, recordId: string, newValue: unknown, oldValue?: unknown) => ({
  userId: actor.auth.userId, ipAddress: actor.ipAddress, userAgent: actor.userAgent, action, module: 'expense' as AuditModule, recordType, recordId, oldValue, newValue,
});
export const textAudit = (field: string, before: string | null | undefined, after: string | null | undefined) =>
  (before ?? null) === (after ?? null) ? {} : { [`${field}Changed`]: true, [`${field}Length`]: after?.length ?? 0 };
export const notFound = (what: string) => new AppError(404, `${what.toUpperCase().replace(/ /g, '_')}_NOT_FOUND`, `${what.charAt(0).toUpperCase()}${what.slice(1)} not found`);
export const has = (auth: AuthContext, ...perms: string[]) => perms.some((p) => hasPermission(auth, p));
export const P = PERMISSIONS;
export const today = () => businessToday('Asia/Bangkok');

export const lockRow = (tx: Tx, table: 'travel_requests' | 'expense_reports' | 'expense_policies', id: string) => {
  switch (table) {
    case 'travel_requests': return tx.$executeRaw`SELECT "id" FROM "travel_requests" WHERE "id" = ${id} FOR UPDATE`;
    case 'expense_reports': return tx.$executeRaw`SELECT "id" FROM "expense_reports" WHERE "id" = ${id} FOR UPDATE`;
    case 'expense_policies': return tx.$executeRaw`SELECT "id" FROM "expense_policies" WHERE "id" = ${id} FOR UPDATE`;
  }
};
export async function nextNumber(tx: Tx, kind: 'travel' | 'report'): Promise<string> {
  const year = new Date().getUTCFullYear();
  await tx.expenseSequence.upsert({ where: { kind_year: { kind, year } }, create: { kind, year, next: 1 }, update: {} });
  await tx.$executeRaw`SELECT "next" FROM "expense_sequences" WHERE "kind" = ${kind} AND "year" = ${year} FOR UPDATE`;
  const row = await tx.expenseSequence.findUniqueOrThrow({ where: { kind_year: { kind, year } } });
  await tx.expenseSequence.update({ where: { kind_year: { kind, year } }, data: { next: row.next + 1 } });
  return `${kind === 'travel' ? 'TRV' : 'EXP'}-${year}-${String(row.next).padStart(6, '0')}`;
}

export const employeeInclude = { organization: { select: { id: true, name: true } }, department: { select: { id: true, name: true } }, position: { select: { id: true, title: true, jobId: true, job: { select: { title: true } } } }, user: { select: { id: true, isActive: true } } } as const;
export type EmployeeRow = Prisma.EmployeeGetPayload<{ include: typeof employeeInclude }>;
export async function employeeSnapshot(db: Db, employeeId: string) {
  const e = await db.employee.findUnique({ where: { id: employeeId }, include: employeeInclude });
  if (!e) throw new AppError(404, 'EMPLOYEE_NOT_FOUND', 'Employee not found');
  return { employee: e, data: snapshotData(e) };
}
export const snapshotData = (e: EmployeeRow) => ({ employeeCodeSnapshot: e.employeeCode, employeeNameSnapshot: `${e.firstName} ${e.lastName}`, organizationSnapshot: e.organization.name, departmentSnapshot: e.department.name, jobSnapshot: e.position?.job?.title ?? null, positionSnapshot: e.position?.title ?? null });
export const snapshotDto = (r: { employeeCodeSnapshot: string; employeeNameSnapshot: string; organizationSnapshot: string | null; departmentSnapshot: string | null; jobSnapshot: string | null; positionSnapshot: string | null }): ExpenseSnapshotDto =>
  ({ employeeCode: r.employeeCodeSnapshot, employeeName: r.employeeNameSnapshot, organization: r.organizationSnapshot, department: r.departmentSnapshot, job: r.jobSnapshot, position: r.positionSnapshot });

/**
 * Who may see whose expenses: organization-wide administrators (an ALL data scope plus an expense administration
 * permission) see everyone; everybody else sees exactly their own rows. A manager's TEAM scope opens nothing here;
 * a manager reaches a subordinate's report only as an approver on its workflow, through the review view.
 */
export const adminScope = (auth: AuthContext): boolean => scopeFor(auth, P.EXPENSE_VIEW, P.EXPENSE_MANAGE, P.EXPENSE_REVIEW, P.EXPENSE_RECORD_PAYMENT) === 'ALL' /* Task 50: the scope of these permissions, not of any role */;
export const visibleEmployeeWhere = (auth: AuthContext): { employeeId?: string } => (adminScope(auth) ? {} : { employeeId: auth.employeeId ?? '__none__' });
export const canSeeEmployee = (auth: AuthContext, employeeId: string): boolean => adminScope(auth) || (!!auth.employeeId && auth.employeeId === employeeId);
export async function userNames(db: Db, ids: (string | null | undefined)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((x): x is string => !!x))];
  if (!unique.length) return new Map();
  const users = await db.user.findMany({ where: { id: { in: unique } }, select: { id: true, email: true, employee: { select: { firstName: true, lastName: true } } } });
  return new Map(users.map((u) => [u.id, u.employee ? `${u.employee.firstName} ${u.employee.lastName}` : u.email]));
}
export async function history(tx: Tx, entityType: 'TRAVEL_REQUEST' | 'EXPENSE_REPORT', entityId: string, from: string | null, to: string, actorUserId: string | null, reasonCode: string | null = null) {
  await tx.expenseStatusHistory.create({ data: { entityType, entityId, fromStatus: from, toStatus: to, actorUserId, reasonCode } });
}
export async function historyDto(db: Db, entityType: 'TRAVEL_REQUEST' | 'EXPENSE_REPORT', entityId: string): Promise<ExpenseHistoryDto[]> {
  const rows = await db.expenseStatusHistory.findMany({ where: { entityType, entityId }, orderBy: { createdAt: 'asc' } });
  const names = await userNames(db, rows.map((r) => r.actorUserId));
  return rows.map((h) => ({ from: h.fromStatus, to: h.toStatus, actorName: names.get(h.actorUserId ?? '') ?? null, reasonCode: h.reasonCode, at: h.createdAt.toISOString() }));
}
export async function isApprover(db: Db, auth: AuthContext, workflowInstanceId: string | null): Promise<{ any: boolean; pendingNow: boolean }> {
  if (!workflowInstanceId) return { any: false, pendingNow: false };
  const steps = await db.workflowInstanceStep.findMany({ where: { instanceId: workflowInstanceId, approverUserId: auth.userId }, select: { status: true } });
  return { any: steps.length > 0, pendingNow: steps.some((s) => s.status === 'PENDING') };
}
