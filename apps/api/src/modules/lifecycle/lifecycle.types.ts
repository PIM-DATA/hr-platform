import type { Prisma } from '@prisma/client';
import { PERMISSIONS, businessToday, checklistProgress, type AuditAction, type AuditModule, type LifecycleSnapshotDto, type LifecycleTaskDto } from '@hr/shared';
import { AppError } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { hasPermission } from '../../services/authorization/authorization.service';
import type { AuthContext } from '../auth/auth.types';
import { employeeScopeWhere } from '../employees/employees.scope';

export type Tx = Prisma.TransactionClient;
export type Db = Prisma.TransactionClient | typeof prisma;
export type Actor = { auth: AuthContext; ipAddress: string | null; userAgent: string | null };

/** Lifecycle audit: dates, statuses, codes and lengths. Never a reason note, a review comment or a task note. */
export const lifecycleAudit = (actor: Actor, action: AuditAction, recordType: string, recordId: string, newValue: unknown, oldValue?: unknown) => ({
  userId: actor.auth.userId, ipAddress: actor.ipAddress, userAgent: actor.userAgent, action, module: 'lifecycle' as AuditModule, recordType, recordId, oldValue, newValue,
});
export const textAudit = (field: string, before: string | null | undefined, after: string | null | undefined) =>
  (before ?? null) === (after ?? null) ? {} : { [`${field}Changed`]: true, [`${field}Length`]: after?.length ?? 0 };
export const notFound = (what: string) => new AppError(404, `${what.toUpperCase().replace(/ /g, '_')}_NOT_FOUND`, `${what.charAt(0).toUpperCase()}${what.slice(1)} not found`);
export const has = (auth: AuthContext, ...perms: string[]) => perms.some((p) => hasPermission(auth, p));
export const P = PERMISSIONS;
export const today = () => businessToday('Asia/Bangkok');

export const lockRow = (tx: Tx, table: 'onboarding_plans' | 'onboarding_tasks' | 'probation_cases' | 'offboarding_cases' | 'offboarding_tasks', id: string) => {
  switch (table) {
    case 'onboarding_plans': return tx.$executeRaw`SELECT "id" FROM "onboarding_plans" WHERE "id" = ${id} FOR UPDATE`;
    case 'onboarding_tasks': return tx.$executeRaw`SELECT "id" FROM "onboarding_tasks" WHERE "id" = ${id} FOR UPDATE`;
    case 'probation_cases': return tx.$executeRaw`SELECT "id" FROM "probation_cases" WHERE "id" = ${id} FOR UPDATE`;
    case 'offboarding_cases': return tx.$executeRaw`SELECT "id" FROM "offboarding_cases" WHERE "id" = ${id} FOR UPDATE`;
    case 'offboarding_tasks': return tx.$executeRaw`SELECT "id" FROM "offboarding_tasks" WHERE "id" = ${id} FOR UPDATE`;
  }
};

/** Who a lifecycle record is about, as it was: the snapshot every plan and case stores at creation. */
export async function employeeSnapshot(db: Db, employeeId: string) {
  const e = await db.employee.findUnique({ where: { id: employeeId }, include: { organization: { select: { name: true } }, department: { select: { id: true, name: true } }, position: { select: { title: true, job: { select: { title: true } } } }, manager: { select: { id: true, employeeCode: true, firstName: true, lastName: true, user: { select: { id: true, isActive: true } } } }, user: { select: { id: true, isActive: true } } } });
  if (!e) throw new AppError(404, 'EMPLOYEE_NOT_FOUND', 'Employee not found');
  return {
    employee: e,
    data: {
      employeeCodeSnapshot: e.employeeCode, employeeNameSnapshot: `${e.firstName} ${e.lastName}`, organizationSnapshot: e.organization.name, departmentSnapshot: e.department.name, departmentIdSnapshot: e.department.id,
      jobSnapshot: e.position.job?.title ?? null, positionSnapshot: e.position.title, managerIdSnapshot: e.manager?.id ?? null, managerNameSnapshot: e.manager ? `${e.manager.firstName} ${e.manager.lastName}` : null, managerCodeSnapshot: e.manager?.employeeCode ?? null,
    },
  };
}
export const snapshotDto = (r: { employeeCodeSnapshot: string; employeeNameSnapshot: string; organizationSnapshot: string | null; departmentSnapshot: string | null; jobSnapshot: string | null; positionSnapshot: string | null; managerIdSnapshot: string | null; managerNameSnapshot: string | null; managerCodeSnapshot: string | null }): LifecycleSnapshotDto =>
  ({ employeeCode: r.employeeCodeSnapshot, employeeName: r.employeeNameSnapshot, organization: r.organizationSnapshot, department: r.departmentSnapshot, job: r.jobSnapshot, position: r.positionSnapshot, manager: r.managerIdSnapshot ? { employeeId: r.managerIdSnapshot, employeeCode: r.managerCodeSnapshot ?? '', name: r.managerNameSnapshot ?? '' } : null });

/** The employee's state today, shown beside the snapshot so a transfer after the fact is visible, never rewritten. */
export async function currentOf(db: Db, employeeId: string) {
  const e = await db.employee.findUnique({ where: { id: employeeId }, select: { employmentStatus: true, terminationDate: true, department: { select: { name: true } }, manager: { select: { firstName: true, lastName: true, employeeCode: true } }, user: { select: { isActive: true } } } });
  return e ? { department: e.department.name, manager: e.manager ? `${e.manager.firstName} ${e.manager.lastName} (${e.manager.employeeCode})` : null, employmentStatus: e.employmentStatus, terminationDate: e.terminationDate?.toISOString().slice(0, 10) ?? null, accountActive: e.user?.isActive ?? null } : null;
}

/**
 * Which employees' lifecycle records a reader may see: the employee module's own scope (ALL / TEAM = self and direct
 * reports / SELF), plus — for the manager snapshot — records where the reader was the manager at creation, so a
 * later transfer does not hide history from the person who owned it. A reader with only their own record sees only
 * their own record.
 */
export async function lifecycleEmployeeWhere(auth: AuthContext): Promise<Prisma.OnboardingPlanWhereInput> {
  const scope = employeeScopeWhere(auth) as Prisma.EmployeeWhereInput;
  if (auth.dataScope === 'ALL') return {};
  const ids = (await prisma.employee.findMany({ where: scope, select: { id: true } })).map((e) => e.id);
  const managed = auth.dataScope === 'TEAM' && auth.employeeId ? { managerIdSnapshot: auth.employeeId } : null;
  return managed ? { OR: [{ employeeId: { in: ids } }, managed] } : { employeeId: { in: ids } };
}

export async function userNames(db: Db, ids: (string | null | undefined)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((x): x is string => !!x))];
  if (!unique.length) return new Map();
  const users = await db.user.findMany({ where: { id: { in: unique } }, select: { id: true, email: true, employee: { select: { firstName: true, lastName: true } } } });
  return new Map(users.map((u) => [u.id, u.employee ? `${u.employee.firstName} ${u.employee.lastName}` : u.email]));
}

type TaskRow = { id: string; titleSnapshot: string; descriptionSnapshot: string | null; categorySnapshot: string; assigneeType: string; assigneeUserId: string | null; assigneeEmployeeId: string | null; dueDate: string; required: boolean; requiresDocument: boolean; documentId: string | null; status: string; completedAt: Date | null; completedByUserId: string | null; note: string | null };
/** Task DTO. The note is shown only to people who may act on the task or manage the process. */
export async function taskDtos(db: Db, auth: AuthContext, rows: TaskRow[], manage: boolean, complete: boolean, processOpen: boolean): Promise<LifecycleTaskDto[]> {
  const names = await userNames(db, rows.flatMap((r) => [r.assigneeUserId, r.completedByUserId]));
  const docIds = [...new Set(rows.map((r) => r.documentId).filter((x): x is string => !!x))];
  const docs = new Map((docIds.length ? await db.document.findMany({ where: { id: { in: docIds } }, select: { id: true, title: true } }) : []).map((d) => [d.id, d.title]));
  const t = today();
  return rows.map((r) => {
    const mine = r.assigneeUserId === auth.userId && complete;
    const open = r.status === 'PENDING' || r.status === 'IN_PROGRESS';
    return {
      id: r.id, title: r.titleSnapshot, description: r.descriptionSnapshot, category: r.categorySnapshot, assigneeType: r.assigneeType as LifecycleTaskDto['assigneeType'], assigneeUserId: r.assigneeUserId, assigneeName: r.assigneeUserId ? (names.get(r.assigneeUserId) ?? null) : null, assigneeEmployeeId: r.assigneeEmployeeId, unassigned: !r.assigneeUserId && open,
      dueDate: r.dueDate, required: r.required, requiresDocument: r.requiresDocument, documentId: r.documentId, documentTitle: r.documentId ? (docs.get(r.documentId) ?? null) : null, status: r.status as LifecycleTaskDto['status'], completedAt: r.completedAt?.toISOString() ?? null, completedByName: r.completedByUserId ? (names.get(r.completedByUserId) ?? null) : null,
      note: manage || mine ? r.note : null, overdue: open && r.dueDate < t, can: { update: processOpen && open && (manage || mine) },
    };
  });
}
export const progressOf = (rows: { status: string; required: boolean }[]) => checklistProgress(rows);
