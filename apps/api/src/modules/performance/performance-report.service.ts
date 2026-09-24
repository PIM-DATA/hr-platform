import type { CycleReportDto } from '@hr/shared';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { AppError } from '../../lib/errors';
import { score, toScoreString, ZERO } from './score';

/**
 * Performance reporting — **aggregates only**.
 *
 * Nothing here returns an individual's score, rating or comment: those belong to the employee, their snapshot
 * reviewer and whoever manages the cycle, and a report is the one surface that a wider audience sees. Everything is
 * counted and averaged in the database rather than pulled into the API and added up in a loop, so a cycle with a few
 * thousand plans stays a few queries.
 *
 * Every dimension comes from the **plan snapshot**, not from where the employee sits today: a transfer in October
 * must not quietly move somebody's January result into another department's average.
 */
export const performanceReportService = {
  async cycleReport(cycleId: string, departmentId?: string): Promise<CycleReportDto> {
    const cycle = await prisma.performanceCycle.findUnique({
      where: { id: cycleId },
      select: { id: true, code: true, name: true, status: true, ratingBands: { orderBy: { minScore: 'desc' } } },
    });
    if (!cycle) throw new AppError(404, 'PERFORMANCE_CYCLE_NOT_FOUND', 'Performance cycle not found');

    const where: Prisma.PerformancePlanWhereInput = { cycleId, departmentId };

    const [assigned, selfSubmitted, managerSubmitted, finalized, averages] = await prisma.$transaction([
      prisma.performancePlan.count({ where }),
      prisma.performancePlan.count({ where: { ...where, selfSubmittedAt: { not: null } } }),
      prisma.performancePlan.count({ where: { ...where, managerSubmittedAt: { not: null } } }),
      prisma.performancePlan.count({ where: { ...where, status: 'FINALIZED' } }),
      prisma.performancePlan.aggregate({ where: { ...where, weightedScore: { not: null } }, _avg: { weightedScore: true } }),
    ]);

    const [byRating, byDepartment, finalizedByDepartment, byKpi] = await Promise.all([
      prisma.performancePlan.groupBy({ by: ['ratingCode'], where: { ...where, ratingCode: { not: null } }, _count: { _all: true }, orderBy: { ratingCode: 'asc' } }),
      // Department, job and position all come from the plan's snapshot, so a transfer never moves a finished result.
      prisma.performancePlan.groupBy({ by: ['departmentName'], where, _count: { _all: true }, _avg: { weightedScore: true }, orderBy: { departmentName: 'asc' } }),
      // How many of each department's plans are finished needs its own count — an average says nothing about coverage.
      prisma.performancePlan.groupBy({ by: ['departmentName'], where: { ...where, status: 'FINALIZED' }, _count: { _all: true }, orderBy: { departmentName: 'asc' } }),
      // A KPI average is only meaningful across plans that used the same KPI, which is what the code snapshot identifies.
      prisma.performancePlanItem.groupBy({
        by: ['kpiCodeSnapshot', 'kpiNameSnapshot'],
        where: { plan: where, managerScore: { not: null } },
        _count: { _all: true },
        _avg: { managerScore: true },
        orderBy: { kpiCodeSnapshot: 'asc' },
      }),
    ]);
    const finalizedMap = new Map(finalizedByDepartment.map((row) => [row.departmentName ?? '', row._count._all]));

    const ratingCounts = new Map(byRating.map((row) => [row.ratingCode ?? '', row._count._all]));

    return {
      cycle: { id: cycle.id, code: cycle.code, name: cycle.name, status: cycle.status },
      completion: { assigned, selfSubmitted, managerSubmitted, finalized },
      averageFinalScore: averages._avg.weightedScore ? toScoreString(averages._avg.weightedScore) : null,
      // Every band is listed, including the ones nobody landed in — a distribution with holes in it is misread.
      ratingDistribution: cycle.ratingBands.map((band) => ({ code: band.code, label: band.label, count: ratingCounts.get(band.code) ?? 0 })),
      byDepartment: byDepartment.map((row) => ({
        departmentName: row.departmentName ?? 'Unassigned',
        assigned: row._count._all,
        finalized: finalizedMap.get(row.departmentName ?? '') ?? 0,
        averageScore: row._avg.weightedScore ? toScoreString(row._avg.weightedScore) : null,
      })),
      byKpi: byKpi.map((row) => ({
        kpiCode: row.kpiCodeSnapshot,
        kpiName: row.kpiNameSnapshot,
        plans: row._count._all,
        averageManagerScore: row._avg.managerScore ? toScoreString(score(row._avg.managerScore ?? ZERO)) : null,
      })),
    };
  },
};
