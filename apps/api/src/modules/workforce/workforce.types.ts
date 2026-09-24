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
 * Workforce planning sits beside the live organization. Its audit trail records plans, not people: a planned
 * headcount is a number with an actor; notes are recorded by length only.
 */
export const workforceAudit = (actor: Actor, action: AuditAction, recordType: string, recordId: string, newValue: unknown, oldValue?: unknown) => ({
  userId: actor.auth.userId, ipAddress: actor.ipAddress, userAgent: actor.userAgent, action, module: 'workforce' as AuditModule, recordType, recordId, oldValue, newValue,
});
export const textAudit = (field: string, before: string | null | undefined, after: string | null | undefined) =>
  (before ?? null) === (after ?? null) ? {} : { [`${field}Changed`]: true, [`${field}Length`]: after?.length ?? 0 };
export const notFound = (what: string) => new AppError(404, `${what.toUpperCase().replace(/ /g, '_')}_NOT_FOUND`, `${what.charAt(0).toUpperCase()}${what.slice(1)} not found`);

export const canPlan = (auth: AuthContext) => hasPermission(auth, PERMISSIONS.WORKFORCE_PLAN) || hasPermission(auth, PERMISSIONS.WORKFORCE_MANAGE);
export const canManage = (auth: AuthContext) => hasPermission(auth, PERMISSIONS.WORKFORCE_MANAGE);
export const canDesign = (auth: AuthContext) => hasPermission(auth, PERMISSIONS.ORG_DESIGN_MANAGE);

export const lockRow = (tx: Tx, table: 'workforce_planning_cycles' | 'organization_design_scenarios', id: string) =>
  table === 'workforce_planning_cycles'
    ? tx.$executeRaw`SELECT "id" FROM "workforce_planning_cycles" WHERE "id" = ${id} FOR UPDATE`
    : tx.$executeRaw`SELECT "id" FROM "organization_design_scenarios" WHERE "id" = ${id} FOR UPDATE`;

/**
 * Which departments a reader may see plans for. ALL scope → everything. TEAM scope (a manager with workforce.view)
 * → the manager's own department plus departments they head. Nothing widens through TEAM to the company.
 * SELF scope → nothing (the permission is not granted to employees; this is the belt to that brace).
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
export const departmentFilter = (ids: string[] | null): Prisma.WorkforcePlanItemWhereInput => (ids === null ? {} : { departmentId: { in: ids } });

/** Current headcount by department + job from the live employee master (active employees, their current position's job). */
export async function currentHeadcountByGrain(db: Db, organizationId?: string | null, departmentIds?: string[] | null): Promise<Map<string, { organizationId: string; departmentId: string; jobId: string | null; count: number }>> {
  const groups = await db.employee.groupBy({
    by: ['organizationId', 'departmentId', 'positionId'],
    where: { employmentStatus: 'ACTIVE', ...(organizationId ? { organizationId } : {}), ...(departmentIds ? { departmentId: { in: departmentIds } } : {}) },
    _count: { _all: true },
  });
  const positionIds = [...new Set(groups.map((g) => g.positionId))];
  const positions = positionIds.length ? await db.position.findMany({ where: { id: { in: positionIds } }, select: { id: true, jobId: true } }) : [];
  const jobOf = new Map(positions.map((p) => [p.id, p.jobId]));
  const out = new Map<string, { organizationId: string; departmentId: string; jobId: string | null; count: number }>();
  for (const g of groups) {
    const jobId = jobOf.get(g.positionId) ?? null;
    const key = `${g.departmentId}:${jobId ?? '-'}`;
    const cur = out.get(key) ?? { organizationId: g.organizationId, departmentId: g.departmentId, jobId, count: 0 };
    cur.count += g._count._all;
    out.set(key, cur);
  }
  return out;
}
