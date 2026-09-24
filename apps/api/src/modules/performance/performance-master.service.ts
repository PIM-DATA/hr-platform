import {
  AUDIT_ACTIONS, findBandGap, findOverlappingBands,
  type CreateKpiInput, type CreatePerformanceCycleInput, type KpiDto, type KpiListQuery,
  type PerformanceCycleDto, type PerformanceCycleListQuery, type RatingBandInput, type UpdateKpiInput,
  type UpdatePerformanceCycleInput,
} from '@hr/shared';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { AppError } from '../../lib/errors';
import { auditService } from '../../services/audit/audit.service';
import { notificationService } from '../../services/notification/notification.service';
import { NOTIFICATION_TYPES } from '@hr/shared';
import { dec, score, toScoreString } from './score';
import { performanceAudit, type Actor, type Db } from './performance.types';

/**
 * Performance configuration: the cycles an appraisal happens in, and the KPI library plans are built from.
 *
 * The rule that runs through both: **a cycle in flight is not reconfigured underneath the people in it.** Score
 * scales and rating bands are frozen once a cycle is active, and a KPI's definition is only ever a template — what an
 * employee was measured on is snapshotted onto their plan, so the library can be tidied up next year without
 * rewriting last year's reviews.
 */
const cycleInclude = {
  organization: { select: { id: true, code: true, name: true } },
  ratingBands: { orderBy: { minScore: 'asc' as const } },
  _count: { select: { plans: true } },
} satisfies Prisma.PerformanceCycleInclude;
type CycleRow = Prisma.PerformanceCycleGetPayload<{ include: typeof cycleInclude }>;

const toCycleDto = (row: CycleRow): PerformanceCycleDto => ({
  id: row.id,
  code: row.code,
  name: row.name,
  description: row.description,
  organization: row.organization,
  periodStart: row.periodStart,
  periodEnd: row.periodEnd,
  selfReviewStart: row.selfReviewStart,
  selfReviewEnd: row.selfReviewEnd,
  managerReviewStart: row.managerReviewStart,
  managerReviewEnd: row.managerReviewEnd,
  selfReviewRequired: row.selfReviewRequired,
  minScore: toScoreString(row.minScore)!,
  maxScore: toScoreString(row.maxScore)!,
  scoreStep: toScoreString(row.scoreStep)!,
  status: row.status as PerformanceCycleDto['status'],
  ratingBands: row.ratingBands.map((b) => ({ id: b.id, code: b.code, label: b.label, minScore: toScoreString(b.minScore)!, maxScore: toScoreString(b.maxScore)! })),
  planCount: row._count.plans,
  createdAt: row.createdAt.toISOString(),
});

/** Bands must not overlap, and each must sit on the cycle's scale. Full coverage is only required at activation. */
function assertBandsValid(bands: RatingBandInput[], minScore: string, maxScore: string) {
  const codes = new Set<string>();
  for (const band of bands) {
    if (codes.has(band.code)) throw new AppError(409, 'PERFORMANCE_BAND_DUPLICATE', `Rating band ${band.code} is listed twice`);
    codes.add(band.code);
    if (dec(band.minScore).lessThan(dec(minScore)) || dec(band.maxScore).greaterThan(dec(maxScore))) {
      throw new AppError(422, 'PERFORMANCE_BAND_OUT_OF_SCALE', `Rating band ${band.code} lies outside the score scale ${minScore}–${maxScore}`);
    }
  }
  const overlap = findOverlappingBands(bands);
  if (overlap) throw new AppError(422, 'PERFORMANCE_BAND_OVERLAP', `Rating bands ${overlap[0].code} and ${overlap[1].code} overlap`);
}

export const performanceCycleService = {
  async list(q: PerformanceCycleListQuery): Promise<{ data: PerformanceCycleDto[]; meta: { page: number; pageSize: number; total: number } }> {
    const where: Prisma.PerformanceCycleWhereInput = {
      organizationId: q.organizationId,
      status: q.status,
      ...(q.search ? { OR: [{ code: { contains: q.search, mode: 'insensitive' } }, { name: { contains: q.search, mode: 'insensitive' } }] } : {}),
    };
    const [total, rows] = await prisma.$transaction([
      prisma.performanceCycle.count({ where }),
      prisma.performanceCycle.findMany({ where, include: cycleInclude, orderBy: [{ periodStart: 'desc' }, { code: 'asc' }], skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
    ]);
    return { data: rows.map(toCycleDto), meta: { page: q.page, pageSize: q.pageSize, total } };
  },

  async get(id: string): Promise<PerformanceCycleDto> {
    const row = await prisma.performanceCycle.findUnique({ where: { id }, include: cycleInclude });
    if (!row) throw new AppError(404, 'PERFORMANCE_CYCLE_NOT_FOUND', 'Performance cycle not found');
    return toCycleDto(row);
  },

  async create(input: CreatePerformanceCycleInput, actor: Actor): Promise<PerformanceCycleDto> {
    const duplicate = await prisma.performanceCycle.findUnique({ where: { code: input.code }, select: { id: true } });
    if (duplicate) throw new AppError(409, 'PERFORMANCE_CYCLE_CODE_TAKEN', `A cycle with the code ${input.code} already exists`);
    assertBandsValid(input.ratingBands, input.minScore, input.maxScore);

    const row = await prisma.$transaction(async (tx) => {
      const created = await tx.performanceCycle.create({
        data: {
          code: input.code, name: input.name, description: input.description ?? null, organizationId: input.organizationId ?? null,
          periodStart: input.periodStart, periodEnd: input.periodEnd,
          selfReviewStart: input.selfReviewStart ?? null, selfReviewEnd: input.selfReviewEnd ?? null,
          managerReviewStart: input.managerReviewStart ?? null, managerReviewEnd: input.managerReviewEnd ?? null,
          selfReviewRequired: input.selfReviewRequired,
          minScore: score(input.minScore), maxScore: score(input.maxScore), scoreStep: score(input.scoreStep),
          status: 'DRAFT', createdByUserId: actor.auth.userId,
          ratingBands: { create: input.ratingBands.map((b) => ({ code: b.code, label: b.label, minScore: score(b.minScore), maxScore: score(b.maxScore) })) },
        },
        include: cycleInclude,
      });
      await auditService.log(performanceAudit(actor, AUDIT_ACTIONS.CREATE_PERFORMANCE_CYCLE, 'PerformanceCycle', created.id, {
        code: created.code, name: created.name, period: `${created.periodStart}→${created.periodEnd}`, bands: input.ratingBands.length,
      }), tx);
      return created;
    });
    return toCycleDto(row);
  },

  /**
   * Editing a cycle. Configuration that decides what a score *means* — the scale and the bands — is frozen once the
   * cycle is active, because plans have already been built and reviewed against it.
   */
  async update(id: string, input: UpdatePerformanceCycleInput, actor: Actor): Promise<PerformanceCycleDto> {
    const row = await prisma.$transaction(async (tx) => {
      const before = await tx.performanceCycle.findUnique({ where: { id }, include: cycleInclude });
      if (!before) throw new AppError(404, 'PERFORMANCE_CYCLE_NOT_FOUND', 'Performance cycle not found');
      if (before.status === 'CLOSED') throw new AppError(409, 'PERFORMANCE_CYCLE_CLOSED', 'A closed cycle cannot be changed');

      const scaleChanged = input.minScore !== undefined || input.maxScore !== undefined || input.scoreStep !== undefined || input.ratingBands !== undefined;
      if (scaleChanged && before.status !== 'DRAFT') {
        throw new AppError(409, 'PERFORMANCE_CYCLE_IN_PROGRESS', 'The score scale and rating bands can only be changed while the cycle is a draft');
      }
      if (input.selfReviewRequired !== undefined && before.status !== 'DRAFT') {
        throw new AppError(409, 'PERFORMANCE_CYCLE_IN_PROGRESS', 'Whether a self review is required can only be changed while the cycle is a draft');
      }

      const minScore = input.minScore ?? toScoreString(before.minScore)!;
      const maxScore = input.maxScore ?? toScoreString(before.maxScore)!;
      if (input.ratingBands) assertBandsValid(input.ratingBands, minScore, maxScore);

      const updated = await tx.performanceCycle.update({
        where: { id },
        data: {
          name: input.name, description: input.description, periodStart: input.periodStart, periodEnd: input.periodEnd,
          selfReviewStart: input.selfReviewStart, selfReviewEnd: input.selfReviewEnd,
          managerReviewStart: input.managerReviewStart, managerReviewEnd: input.managerReviewEnd,
          selfReviewRequired: input.selfReviewRequired,
          minScore: input.minScore === undefined ? undefined : score(input.minScore),
          maxScore: input.maxScore === undefined ? undefined : score(input.maxScore),
          scoreStep: input.scoreStep === undefined ? undefined : score(input.scoreStep),
          ...(input.ratingBands
            ? { ratingBands: { deleteMany: {}, create: input.ratingBands.map((b) => ({ code: b.code, label: b.label, minScore: score(b.minScore), maxScore: score(b.maxScore) })) } }
            : {}),
        },
        include: cycleInclude,
      });
      await auditService.log(performanceAudit(actor, AUDIT_ACTIONS.UPDATE_PERFORMANCE_CYCLE, 'PerformanceCycle', id,
        { name: updated.name, period: `${updated.periodStart}→${updated.periodEnd}`, bands: updated.ratingBands.length },
        { name: before.name, period: `${before.periodStart}→${before.periodEnd}`, bands: before.ratingBands.length }), tx);
      return updated;
    });
    return toCycleDto(row);
  },

  /**
   * Moving a cycle on. The transitions are one-way — `DRAFT → ACTIVE → REVIEW → CLOSED` — and each one changes what
   * everybody inside the cycle is allowed to do, so each is an explicit decision somebody makes, not a date passing.
   */
  async transition(id: string, to: 'ACTIVE' | 'REVIEW' | 'CLOSED', actor: Actor): Promise<PerformanceCycleDto> {
    const allowed: Record<string, string[]> = { ACTIVE: ['DRAFT'], REVIEW: ['ACTIVE'], CLOSED: ['REVIEW', 'ACTIVE'] };
    const action = to === 'ACTIVE' ? AUDIT_ACTIONS.ACTIVATE_PERFORMANCE_CYCLE : to === 'REVIEW' ? AUDIT_ACTIONS.OPEN_PERFORMANCE_REVIEW : AUDIT_ACTIONS.CLOSE_PERFORMANCE_CYCLE;

    const row = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT "id" FROM "performance_cycles" WHERE "id" = ${id} FOR UPDATE`;
      const cycle = await tx.performanceCycle.findUnique({ where: { id }, include: cycleInclude });
      if (!cycle) throw new AppError(404, 'PERFORMANCE_CYCLE_NOT_FOUND', 'Performance cycle not found');
      if (cycle.status === to) throw new AppError(409, 'PERFORMANCE_CYCLE_ALREADY_IN_STATE', `This cycle is already ${to.toLowerCase()}`);
      if (!allowed[to].includes(cycle.status)) {
        throw new AppError(409, 'PERFORMANCE_CYCLE_TRANSITION_INVALID', `A ${cycle.status.toLowerCase()} cycle cannot move to ${to.toLowerCase()}`);
      }

      if (to === 'ACTIVE') {
        // A finalized score that lands in a gap would have no rating to show, so the bands must cover the scale by now.
        const bands = cycle.ratingBands.map((b) => ({ code: b.code, label: b.label, minScore: toScoreString(b.minScore)!, maxScore: toScoreString(b.maxScore)! }));
        const gap = findBandGap(bands, toScoreString(cycle.minScore)!, toScoreString(cycle.maxScore)!);
        if (gap) throw new AppError(422, 'PERFORMANCE_BAND_GAP', gap);
      }

      const updated = await tx.performanceCycle.update({
        where: { id },
        data: {
          status: to,
          activatedAt: to === 'ACTIVE' ? new Date() : undefined,
          reviewOpenedAt: to === 'REVIEW' ? new Date() : undefined,
          closedAt: to === 'CLOSED' ? new Date() : undefined,
        },
        include: cycleInclude,
      });

      // Plans follow their cycle: activating puts them in the employees' hands, opening the review puts them in the
      // hands of whoever owes the first assessment.
      if (to === 'ACTIVE') await tx.performancePlan.updateMany({ where: { cycleId: id, status: 'DRAFT' }, data: { status: 'ACTIVE' } });
      if (to === 'REVIEW') {
        await tx.performancePlan.updateMany({
          where: { cycleId: id, status: { in: ['DRAFT', 'ACTIVE'] } },
          data: { status: cycle.selfReviewRequired ? 'SELF_REVIEW' : 'MANAGER_REVIEW' },
        });
        // Tell whoever owes the first assessment — the employee when there is a self review, otherwise the reviewer.
        const plans = await tx.performancePlan.findMany({
          where: { cycleId: id, status: { in: ['SELF_REVIEW', 'MANAGER_REVIEW'] } },
          select: { id: true, employeeNameSnapshot: true, reviewerUserId: true, employee: { select: { user: { select: { id: true } } } } },
        });
        for (const plan of plans) {
          const recipient = cycle.selfReviewRequired ? plan.employee.user?.id ?? null : plan.reviewerUserId;
          await notificationService.publish(
            {
              userId: recipient,
              type: cycle.selfReviewRequired ? NOTIFICATION_TYPES.PERFORMANCE_REVIEW_OPENED : NOTIFICATION_TYPES.PERFORMANCE_MANAGER_REVIEW_REQUIRED,
              source: { module: 'performance', entityType: 'PERFORMANCE_PLAN', entityId: plan.id },
              data: { planId: plan.id, cycleId: id },
              dedupeKey: `performance:${plan.id}:review-opened`,
            },
            { cycleName: cycle.name, employeeName: plan.employeeNameSnapshot },
            tx,
          );
        }
      }

      await auditService.log(performanceAudit(actor, action, 'PerformanceCycle', id, { status: to, plans: cycle._count.plans }, { status: cycle.status }), tx);
      return updated;
    });
    return toCycleDto(row);
  },
};

// ---------------------------------------------------------------------------
// KPI library
// ---------------------------------------------------------------------------
const kpiInclude = { organization: { select: { id: true, code: true, name: true } } } satisfies Prisma.PerformanceKpiInclude;
type KpiRow = Prisma.PerformanceKpiGetPayload<{ include: typeof kpiInclude }>;

const toKpiDto = (row: KpiRow): KpiDto => ({
  id: row.id,
  code: row.code,
  name: row.name,
  description: row.description,
  category: row.category,
  measurementType: row.measurementType as KpiDto['measurementType'],
  unit: row.unit,
  defaultWeight: toScoreString(row.defaultWeight),
  organization: row.organization,
  isActive: row.isActive,
});

export const kpiService = {
  async list(q: KpiListQuery): Promise<{ data: KpiDto[]; meta: { page: number; pageSize: number; total: number } }> {
    const where: Prisma.PerformanceKpiWhereInput = {
      category: q.category,
      measurementType: q.measurementType,
      organizationId: q.organizationId,
      ...(q.status ? { isActive: q.status === 'active' } : {}),
      ...(q.search ? { OR: [{ code: { contains: q.search, mode: 'insensitive' } }, { name: { contains: q.search, mode: 'insensitive' } }] } : {}),
    };
    const [total, rows] = await prisma.$transaction([
      prisma.performanceKpi.count({ where }),
      prisma.performanceKpi.findMany({ where, include: kpiInclude, orderBy: [{ category: 'asc' }, { code: 'asc' }], skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
    ]);
    return { data: rows.map(toKpiDto), meta: { page: q.page, pageSize: q.pageSize, total } };
  },

  async create(input: CreateKpiInput, actor: Actor): Promise<KpiDto> {
    const duplicate = await prisma.performanceKpi.findUnique({ where: { code: input.code }, select: { id: true } });
    if (duplicate) throw new AppError(409, 'PERFORMANCE_KPI_CODE_TAKEN', `A KPI with the code ${input.code} already exists`);
    const row = await prisma.$transaction(async (tx) => {
      const created = await tx.performanceKpi.create({
        data: {
          code: input.code, name: input.name, description: input.description ?? null, category: input.category ?? null,
          measurementType: input.measurementType, unit: input.unit ?? null,
          defaultWeight: input.defaultWeight ? score(input.defaultWeight) : null,
          organizationId: input.organizationId ?? null, createdByUserId: actor.auth.userId,
        },
        include: kpiInclude,
      });
      await auditService.log(performanceAudit(actor, AUDIT_ACTIONS.CREATE_PERFORMANCE_KPI, 'PerformanceKpi', created.id, {
        code: created.code, name: created.name, measurementType: created.measurementType,
      }), tx);
      return created;
    });
    return toKpiDto(row);
  },

  /**
   * Editing a KPI changes the **library**, not history: plan items keep the code and name they snapshotted, so a
   * rename today leaves last year's reviews reading exactly as they did.
   */
  async update(id: string, input: UpdateKpiInput, actor: Actor): Promise<KpiDto> {
    const row = await prisma.$transaction(async (tx) => {
      const before = await tx.performanceKpi.findUnique({ where: { id }, include: kpiInclude });
      if (!before) throw new AppError(404, 'PERFORMANCE_KPI_NOT_FOUND', 'KPI not found');
      const updated = await tx.performanceKpi.update({
        where: { id },
        data: {
          name: input.name, description: input.description, category: input.category, unit: input.unit,
          defaultWeight: input.defaultWeight === undefined ? undefined : input.defaultWeight === null ? null : score(input.defaultWeight),
          isActive: input.isActive,
        },
        include: kpiInclude,
      });
      await auditService.log(performanceAudit(actor, AUDIT_ACTIONS.UPDATE_PERFORMANCE_KPI, 'PerformanceKpi', id,
        { name: updated.name, isActive: updated.isActive, category: updated.category },
        { name: before.name, isActive: before.isActive, category: before.category }), tx);
      return updated;
    });
    return toKpiDto(row);
  },

  /** The KPI as it will be snapshotted onto a plan item. */
  async forPlanItem(db: Db, kpiId: string) {
    const kpi = await db.performanceKpi.findUnique({ where: { id: kpiId }, select: { id: true, code: true, name: true, description: true, measurementType: true, isActive: true } });
    if (!kpi) throw new AppError(404, 'PERFORMANCE_KPI_NOT_FOUND', 'KPI not found');
    if (!kpi.isActive) throw new AppError(409, 'PERFORMANCE_KPI_INACTIVE', `KPI ${kpi.code} is inactive`);
    return kpi;
  },
};
