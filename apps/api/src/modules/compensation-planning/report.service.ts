import { Prisma } from '@prisma/client';
import type { CompCycleStatus, CompReportDto } from '@hr/shared';
import { AppError } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import type { AuthContext } from '../auth/auth.types';
import { ROUNDING, dec, money, toMoneyString } from '../payroll/money';
import { P, budgetDto, budgetUsed, has, hrScope, notFound, type Db } from './comp.types';

/**
 * Aggregate salary-review reporting. Counts and Decimal totals per cycle; no employee, no individual salary, no
 * individual increase, no comment. The per-department split is for compensation-authorized HR only (an
 * organization-wide data scope plus a compensation HR permission): for an executive a small department's total
 * could be one person's salary, so they get organization-level figures.
 *
 * Definitions: currentBase = Σ frozen current salary of plannable rows; increase = Σ (proposed − current) over rows
 * with a proposed value; proposedBase = currentBase + increase (rows without a value count at their current salary);
 * averageIncreasePercent = increase ÷ Σ current of rows with a value × 100, 2 dp.
 */
export const canReadReports = (auth: AuthContext) => has(auth, P.COMP_PLAN_VIEW_REPORTS) || hrScope(auth);

export async function cycleReport(db: Db, cycleId: string, withDepartments: boolean): Promise<CompReportDto> {
  const cycle = await db.compensationReviewCycle.findUnique({ where: { id: cycleId }, include: { budget: true } });
  if (!cycle) throw notFound('compensation cycle');
  const [elig, statuses, all, valued, approved, used] = await Promise.all([
    db.compensationCycleEmployee.groupBy({ by: ['eligibility'], where: { cycleId }, _count: { _all: true } }),
    db.compensationProposal.groupBy({ by: ['status'], where: { cycleId }, _count: { _all: true } }),
    db.compensationProposal.aggregate({ where: { cycleId }, _sum: { currentBaseSalary: true } }),
    db.compensationProposal.aggregate({ where: { cycleId, proposedBaseSalary: { not: null } }, _sum: { currentBaseSalary: true }, _count: { _all: true } }),
    db.compensationProposal.aggregate({ where: { cycleId, status: 'APPROVED' }, _sum: { increaseAmount: true } }),
    budgetUsed(db, cycleId),
  ]);
  const byElig = (k: string) => elig.find((r) => r.eligibility === k)?._count._all ?? 0;
  const bySt = (k: string) => statuses.find((r) => r.status === k)?._count._all ?? 0;
  const total = elig.reduce((n, r) => n + r._count._all, 0);
  const eligible = byElig('ELIGIBLE');
  const current = money(all._sum.currentBaseSalary ?? 0);
  const valuedCurrent = dec(valued._sum.currentBaseSalary ?? 0);
  let byDepartment: CompReportDto['byDepartment'] = null;
  if (withDepartments) {
    const rows = await db.$queryRaw<{ department: string; rows: bigint; addressed: bigint; current: Prisma.Decimal | null; increase: Prisma.Decimal | null }[]>`
      SELECT ce."department_name_snapshot" AS department, count(p."id") AS rows, count(p."proposed_base_salary") AS addressed,
             sum(p."current_base_salary") AS current, sum(p."increase_amount") AS increase
      FROM "compensation_cycle_employees" ce JOIN "compensation_proposals" p ON p."cycle_employee_id" = ce."id"
      WHERE ce."cycle_id" = ${cycleId} GROUP BY ce."department_name_snapshot" ORDER BY ce."department_name_snapshot"`;
    byDepartment = rows.map((r) => {
      const c = money(r.current ?? 0); const i = money(r.increase ?? 0);
      return { department: r.department, rows: Number(r.rows), addressed: Number(r.addressed), currentBase: toMoneyString(c), proposedBase: toMoneyString(c.plus(i)), increase: toMoneyString(i) };
    });
  }
  return {
    cycle: { id: cycle.id, code: cycle.code, name: cycle.name, status: cycle.status as CompCycleStatus, currency: cycle.currency, effectiveDate: cycle.effectiveDate, applied: !!cycle.appliedAt },
    population: { total, eligible, notPlannable: total - eligible },
    completion: {
      notStarted: bySt('NOT_STARTED'), draft: bySt('DRAFT'), submitted: bySt('SUBMITTED'), hrReview: bySt('HR_REVIEW'), approved: bySt('APPROVED'), returned: bySt('RETURNED'),
      addressedPercent: eligible ? Math.round((valued._count._all / eligible) * 1000) / 10 : null,
    },
    totals: { currentBase: toMoneyString(current), proposedBase: toMoneyString(current.plus(used)), increase: toMoneyString(used), approvedIncrease: toMoneyString(approved._sum.increaseAmount ?? 0) },
    averageIncreasePercent: valuedCurrent.greaterThan(0) ? used.dividedBy(valuedCurrent).times(100).toDecimalPlaces(2, ROUNDING).toFixed(2) : null,
    budget: budgetDto(cycle.budget ? dec(cycle.budget.budgetAmount) : null, used),
    byDepartment,
    generatedAt: new Date().toISOString(),
  };
}

export const compReportService = {
  /** Cycles a report reader may pick from: identity and state only. DRAFT cycles have no figures and are left out. */
  async cycles(auth: AuthContext) {
    if (!canReadReports(auth)) throw AppError.forbidden();
    const rows = await prisma.compensationReviewCycle.findMany({ where: { status: { not: 'DRAFT' } }, select: { id: true, code: true, name: true, status: true, effectiveDate: true, currency: true, appliedAt: true }, orderBy: { effectiveDate: 'desc' } });
    return rows.map((r) => ({ id: r.id, code: r.code, name: r.name, status: r.status as CompCycleStatus, effectiveDate: r.effectiveDate, currency: r.currency, applied: !!r.appliedAt }));
  },
  async report(auth: AuthContext, cycleId: string) {
    if (!canReadReports(auth)) throw AppError.forbidden();
    const c = await prisma.compensationReviewCycle.findUnique({ where: { id: cycleId }, select: { status: true } });
    if (!c || c.status === 'DRAFT') throw notFound('compensation cycle');
    return cycleReport(prisma, cycleId, hrScope(auth));
  },
};
