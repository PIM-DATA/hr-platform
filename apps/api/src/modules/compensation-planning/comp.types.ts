import { Prisma } from '@prisma/client';
import { PERMISSIONS, businessToday, type AuditAction, type AuditModule, type CompPerformanceContextDto, type CompRowDto } from '@hr/shared';
import { AppError } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { hasPermission, scopeFor } from '../../services/authorization/authorization.service';
import type { AuthContext } from '../auth/auth.types';
import { ROUNDING, dec, money, toMoneyString } from '../payroll/money';

export type Tx = Prisma.TransactionClient;
export type Db = Prisma.TransactionClient | typeof prisma;
export type Actor = { auth: AuthContext; ipAddress: string | null; userAgent: string | null };
export const P = PERMISSIONS;
export const has = (auth: AuthContext, ...perms: string[]) => perms.some((p) => hasPermission(auth, p));
export const today = () => businessToday('Asia/Bangkok');
/** Batch operations over a whole population (1,000+ rows) run longer than Prisma's 5 s interactive default. */
export const LONG_TX = { timeout: 120_000, maxWait: 10_000 };

/**
 * Compensation-planning audit: ids, statuses, codes, counts, the cycle currency. Never a person's salary, proposed
 * salary, increase or percentage, and never a manager comment (only whether one changed and its length).
 */
export const compAudit = (actor: Actor, action: AuditAction, recordType: string, recordId: string, newValue: unknown, oldValue?: unknown) => ({
  userId: actor.auth.userId, ipAddress: actor.ipAddress, userAgent: actor.userAgent, action, module: 'compensation_planning' as AuditModule, recordType, recordId, oldValue, newValue,
});
export const notFound = (what: string) => new AppError(404, `${what.toUpperCase().replace(/ /g, '_')}_NOT_FOUND`, `${what.charAt(0).toUpperCase()}${what.slice(1)} not found`);

/**
 * Who sees what. HR review needs an organization-wide data scope plus a compensation-planning HR permission: that
 * opens every row of a cycle. Anyone else sees exactly the rows where they are the assigned planner — a manager's
 * TEAM scope, the org chart or being someone's current manager opens nothing by itself.
 */
export const hrScope = (auth: AuthContext): boolean =>
  scopeFor(auth, P.COMP_PLAN_REVIEW, P.COMP_PLAN_MANAGE_CYCLES, P.COMP_PLAN_MANAGE_BUDGET, P.COMP_PLAN_FINALIZE, P.COMP_PLAN_APPLY) === 'ALL' /* Task 50: the scope of these permissions, not of any role */;
export const plannerCapable = (auth: AuthContext): boolean => has(auth, P.COMP_PLAN_VIEW_TEAM, P.COMP_PLAN_PLAN);
export const requireHr = (auth: AuthContext) => { if (!hrScope(auth)) throw AppError.forbidden('Compensation planning administration needs an organization-wide data scope'); };

export async function lockCycle(tx: Tx, cycleId: string) {
  await tx.$executeRaw`SELECT "id" FROM "compensation_review_cycles" WHERE "id" = ${cycleId} FOR UPDATE`;
  const cycle = await tx.compensationReviewCycle.findUnique({ where: { id: cycleId }, include: { budget: true } });
  if (!cycle) throw notFound('compensation cycle');
  return cycle;
}
export const assertStatus = (cycle: { status: string }, allowed: string[], action: string) => {
  if (!allowed.includes(cycle.status)) throw new AppError(409, 'COMP_CYCLE_INVALID_STATE', `Cannot ${action} a cycle that is ${cycle.status}`);
};

/**
 * The only numbers the system derives. A person enters the proposed base salary; the increase and the percentage
 * follow from it and the frozen current salary. Amount: 2 dp. Percent: stored at 4 dp (half-up), shown at 2 dp.
 */
export function derive(current: Prisma.Decimal, proposed: Prisma.Decimal) {
  const increase = money(proposed.minus(current));
  const percent = current.greaterThan(0) ? increase.dividedBy(current).times(100).toDecimalPlaces(4, ROUNDING) : null;
  return { increase, percent };
}
export const pct2 = (v: Prisma.Decimal | null | undefined) => (v === null || v === undefined ? null : dec(v).toDecimalPlaces(2, ROUNDING).toFixed(2));
export const m = (v: Prisma.Decimal | null | undefined) => (v === null || v === undefined ? null : toMoneyString(v));

/** Σ increase over proposals that carry a value — the budget's "used". One aggregate query, exact Decimal. */
export async function budgetUsed(db: Db, cycleId: string): Promise<Prisma.Decimal> {
  const r = await db.compensationProposal.aggregate({ where: { cycleId, proposedBaseSalary: { not: null } }, _sum: { increaseAmount: true } });
  return money(r._sum.increaseAmount ?? 0);
}
export function budgetDto(amount: Prisma.Decimal | null, used: Prisma.Decimal) {
  if (amount === null) return null;
  const remaining = money(amount.minus(used));
  return { amount: toMoneyString(amount), used: toMoneyString(used), remaining: toMoneyString(remaining), overBudget: remaining.isNegative() };
}
export async function assertWithinBudget(db: Db, cycleId: string, budgetAmount: Prisma.Decimal | null | undefined) {
  if (budgetAmount === null || budgetAmount === undefined) return;
  const used = await budgetUsed(db, cycleId);
  if (used.greaterThan(budgetAmount)) throw new AppError(409, 'COMP_BUDGET_EXCEEDED', 'The proposed increases exceed the cycle budget');
}

export async function userNames(db: Db, ids: (string | null | undefined)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((x): x is string => !!x))];
  if (!unique.length) return new Map();
  const rows = await db.user.findMany({ where: { id: { in: unique } }, select: { id: true, email: true, employee: { select: { firstName: true, lastName: true } } } });
  return new Map(rows.map((u) => [u.id, u.employee ? `${u.employee.firstName} ${u.employee.lastName}` : u.email]));
}

/** Whether a user (not the caller) holds a permission through an active role — for choosing a planner. */
export async function userHasPermission(db: Db, userId: string, code: string): Promise<boolean> {
  const n = await db.userRole.count({ where: { userId, user: { isActive: true }, role: { rolePermissions: { some: { permission: { code } } } } } });
  return n > 0;
}

/**
 * Performance context: the latest FINALIZED Task 23 plan per employee — cycle, score, rating. Factual context only;
 * nothing reads it to produce a number. Shown when the cycle allows it and the reader holds performance.view.
 */
export async function performanceContext(db: Db, employeeIds: string[]): Promise<Map<string, CompPerformanceContextDto>> {
  if (!employeeIds.length) return new Map();
  const plans = await db.performancePlan.findMany({
    where: { employeeId: { in: employeeIds }, status: 'FINALIZED' },
    select: { employeeId: true, weightedScore: true, ratingLabelSnapshot: true, finalizedAt: true, cycle: { select: { name: true } } },
    orderBy: [{ finalizedAt: 'desc' }],
  });
  const out = new Map<string, CompPerformanceContextDto>();
  for (const p of plans) if (!out.has(p.employeeId)) out.set(p.employeeId, { cycleName: p.cycle.name, score: p.weightedScore ? dec(p.weightedScore).toFixed(2) : null, rating: p.ratingLabelSnapshot, finalizedAt: p.finalizedAt?.toISOString() ?? null });
  return out;
}

export const rowInclude = { proposal: true } as const;
export type RowWithProposal = Prisma.CompensationCycleEmployeeGetPayload<{ include: typeof rowInclude }>;

/** One population row as a DTO. The comment is included only when the caller may read it (planner of the row or HR). */
export function rowDto(r: RowWithProposal, o: { plannerName: string | null; showComment: boolean; performance: CompPerformanceContextDto | null }): CompRowDto {
  const p = r.proposal;
  return {
    id: r.id, proposalId: p?.id ?? null,
    employee: { id: r.employeeId, code: r.employeeCodeSnapshot, name: r.employeeNameSnapshot },
    department: r.departmentNameSnapshot, job: r.jobTitleSnapshot, managerName: r.managerNameSnapshot,
    planner: r.plannerUserId ? { userId: r.plannerUserId, name: o.plannerName ?? '—' } : null,
    eligibility: r.eligibility as CompRowDto['eligibility'],
    currentBaseSalary: m(r.currentBaseSalarySnapshot), currency: r.currencySnapshot, compensationEffectiveFrom: r.compensationEffectiveFromSnapshot,
    proposedBaseSalary: m(p?.proposedBaseSalary), increaseAmount: m(p?.increaseAmount), increasePercent: pct2(p?.increasePercent),
    status: (p?.status ?? null) as CompRowDto['status'],
    managerComment: o.showComment ? (p?.managerComment ?? null) : null,
    performance: o.performance,
    submittedAt: p?.submittedAt?.toISOString() ?? null, approvedAt: p?.approvedAt?.toISOString() ?? null,
    applied: p?.appliedAt ? { at: p.appliedAt.toISOString(), compensationId: p.appliedCompensationId } : null,
  };
}
