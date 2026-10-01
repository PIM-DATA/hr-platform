import type { Prisma } from '@prisma/client';
import { PERMISSIONS, businessToday, type AuditAction, type AuditModule, type ServiceHistoryDto, type ServiceSnapshotDto } from '@hr/shared';
import { AppError } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { hasPermission, scopeFor } from '../../services/authorization/authorization.service';
import type { AuthContext } from '../auth/auth.types';

export type Tx = Prisma.TransactionClient;
export type Db = Prisma.TransactionClient | typeof prisma;
export type Actor = { auth: AuthContext; ipAddress: string | null; userAgent: string | null };

/**
 * Employee services audit: ids, statuses, codes, counts and text lengths. Never a request description, a field
 * answer, a message body, an internal note, a rendered letter body or a salary amount.
 */
export const servicesAudit = (actor: Actor, action: AuditAction, recordType: string, recordId: string, newValue: unknown, oldValue?: unknown) => ({
  userId: actor.auth.userId, ipAddress: actor.ipAddress, userAgent: actor.userAgent, action, module: 'employee_services' as AuditModule, recordType, recordId, oldValue, newValue,
});
export const textAudit = (field: string, before: string | null | undefined, after: string | null | undefined) =>
  (before ?? null) === (after ?? null) ? {} : { [`${field}Changed`]: true, [`${field}Length`]: after?.length ?? 0 };
export const notFound = (what: string) => new AppError(404, `${what.toUpperCase().replace(/ /g, '_')}_NOT_FOUND`, `${what.charAt(0).toUpperCase()}${what.slice(1)} not found`);
export const has = (auth: AuthContext, ...perms: string[]) => perms.some((p) => hasPermission(auth, p));
export const P = PERMISSIONS;
export const today = () => businessToday('Asia/Bangkok');

export const lockRow = (tx: Tx, table: 'service_requests' | 'hr_letters', id: string) => {
  switch (table) {
    case 'service_requests': return tx.$executeRaw`SELECT "id" FROM "service_requests" WHERE "id" = ${id} FOR UPDATE`;
    case 'hr_letters': return tx.$executeRaw`SELECT "id" FROM "hr_letters" WHERE "id" = ${id} FOR UPDATE`;
  }
};

/** Gap-free, concurrency-safe numbers from a row-locked per-kind, per-year counter. */
export async function nextNumber(tx: Tx, kind: 'request' | 'letter'): Promise<string> {
  const year = new Date().getUTCFullYear();
  await tx.serviceSequence.upsert({ where: { kind_year: { kind, year } }, create: { kind, year, next: 1 }, update: {} });
  await tx.$executeRaw`SELECT "next" FROM "service_sequences" WHERE "kind" = ${kind} AND "year" = ${year} FOR UPDATE`;
  const row = await tx.serviceSequence.findUniqueOrThrow({ where: { kind_year: { kind, year } } });
  await tx.serviceSequence.update({ where: { kind_year: { kind, year } }, data: { next: row.next + 1 } });
  return `${kind === 'request' ? 'SR' : 'HRL'}-${year}-${String(row.next).padStart(6, '0')}`;
}

export const employeeInclude = {
  organization: { select: { id: true, name: true } }, department: { select: { id: true, name: true } },
  position: { select: { id: true, title: true, job: { select: { title: true } } } }, user: { select: { id: true, isActive: true } },
} as const;
export type EmployeeRow = Prisma.EmployeeGetPayload<{ include: typeof employeeInclude }>;
export async function employeeSnapshot(db: Db, employeeId: string) {
  const e = await db.employee.findUnique({ where: { id: employeeId }, include: employeeInclude });
  if (!e) throw new AppError(404, 'EMPLOYEE_NOT_FOUND', 'Employee not found');
  return { employee: e, data: snapshotData(e) };
}
export const snapshotData = (e: EmployeeRow) => ({
  employeeCodeSnapshot: e.employeeCode, employeeNameSnapshot: `${e.firstName} ${e.lastName}`, organizationSnapshot: e.organization.name,
  departmentSnapshot: e.department.name, jobSnapshot: e.position?.job?.title ?? null, positionSnapshot: e.position?.title ?? null,
});
export const snapshotDto = (r: { employeeCodeSnapshot: string; employeeNameSnapshot: string; organizationSnapshot: string | null; departmentSnapshot: string | null; jobSnapshot: string | null; positionSnapshot: string | null }): ServiceSnapshotDto =>
  ({ employeeCode: r.employeeCodeSnapshot, employeeName: r.employeeNameSnapshot, organization: r.organizationSnapshot, department: r.departmentSnapshot, job: r.jobSnapshot, position: r.positionSnapshot });

/**
 * Who may see whose tickets. Organization-wide fulfilment staff (an ALL data scope plus a service permission) see
 * the queue; everybody else sees exactly their own requests and letters. A manager's TEAM scope opens nothing:
 * a manager reaches a subordinate's request only as an approver on its workflow, through the review view.
 */
export const fulfillerScope = (auth: AuthContext): boolean => scopeFor(auth, P.SERVICE_REQUEST_VIEW, P.SERVICE_REQUEST_FULFILL, P.SERVICE_REQUEST_MANAGE) === 'ALL' /* Task 50: the scope of these permissions, not of any role */;
export const letterAdminScope = (auth: AuthContext): boolean => scopeFor(auth, P.HR_LETTER_ISSUE, P.HR_LETTER_MANAGE_TEMPLATES, P.SERVICE_REQUEST_VIEW, P.SERVICE_REQUEST_FULFILL) === 'ALL' /* Task 50: the scope of these permissions, not of any role */;
export const visibleRequestWhere = (auth: AuthContext): { employeeId?: string } => (fulfillerScope(auth) ? {} : { employeeId: auth.employeeId ?? '__none__' });
export const visibleLetterWhere = (auth: AuthContext): { employeeId?: string } => (letterAdminScope(auth) ? {} : { employeeId: auth.employeeId ?? '__none__' });
export const isOwner = (auth: AuthContext, employeeId: string): boolean => !!auth.employeeId && auth.employeeId === employeeId;

/**
 * Issuing a salary-bearing letter needs the letter permission AND the authority that guards compensation itself
 * (`payroll.manage`, the permission on `/payroll/compensations`). Fulfilling tickets never becomes a salary
 * back door: a fulfiller without payroll authority can triage the request but not issue the letter.
 */
export const canIssueSalaryLetter = (auth: AuthContext): boolean => has(auth, P.HR_LETTER_ISSUE) && has(auth, P.PAYROLL_MANAGE);

export async function userNames(db: Db, ids: (string | null | undefined)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((x): x is string => !!x))];
  if (!unique.length) return new Map();
  const rows = await db.user.findMany({ where: { id: { in: unique } }, select: { id: true, email: true, employee: { select: { firstName: true, lastName: true } } } });
  return new Map(rows.map((u) => [u.id, u.employee ? `${u.employee.firstName} ${u.employee.lastName}` : u.email]));
}

/** Append-only status trail. It carries a reason code, never a confidential note. */
export async function history(tx: Tx, requestId: string, from: string | null, to: string, actorUserId: string | null, reasonCode?: string | null) {
  await tx.serviceRequestStatusHistory.create({ data: { requestId, fromStatus: from, toStatus: to, actorUserId, reasonCode: reasonCode ?? null } });
}
export async function historyDto(db: Db, requestId: string): Promise<ServiceHistoryDto[]> {
  const rows = await db.serviceRequestStatusHistory.findMany({ where: { requestId }, orderBy: { createdAt: 'asc' } });
  const names = await userNames(db, rows.map((r) => r.actorUserId));
  return rows.map((r) => ({ from: r.fromStatus, to: r.toStatus, actorName: r.actorUserId ? (names.get(r.actorUserId) ?? null) : null, reasonCode: r.reasonCode, at: r.createdAt.toISOString() }));
}

/** Whether this user is an approver on the request's workflow instance, and whether their step is pending now. */
export async function isApprover(db: Db, auth: AuthContext, workflowInstanceId: string | null): Promise<{ any: boolean; pendingNow: boolean }> {
  if (!workflowInstanceId) return { any: false, pendingNow: false };
  const steps = await db.workflowInstanceStep.findMany({ where: { instanceId: workflowInstanceId }, select: { approverUserId: true, status: true } });
  const mine = steps.filter((s) => s.approverUserId === auth.userId);
  return { any: mine.length > 0, pendingNow: mine.some((s) => s.status === 'PENDING') };
}
