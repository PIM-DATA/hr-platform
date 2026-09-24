import type { Prisma } from '@prisma/client';
import {
  AUDIT_ACTIONS, NINE_BOX_CELLS, NOTIFICATION_TYPES, bucketFor, careerReadinessStatus, nineBoxCell, validateBucketRules,
  type AssignTalentReviewsInput, type CreateTalentCycleInput, type NineBoxDto, type SetBucketRulesInput, type SubmitPotentialInput, type TalentBucket,
  type TalentCycleDto, type TalentCycleListQuery, type TalentReviewContextDto, type TalentReviewDto, type TalentReviewListQuery, type UpdateTalentCycleInput,
} from '@hr/shared';
import { prisma } from '../../lib/prisma';
import { AppError } from '../../lib/errors';
import { auditService } from '../../services/audit/audit.service';
import { notificationService } from '../../services/notification';
import type { AuthContext } from '../auth/auth.types';
import { skillGapService } from '../competency/skill-gap.service';
import { canManageTalent, developmentContext, lockRow, notFound, talentAudit, textAudit, type Actor, type Db, type Tx } from './talent.types';

/**
 * Talent review cycles, potential assessment and the 9-box.
 *
 * Performance comes from a finalized performance plan and is snapshotted — never recomputed here, never rewritten
 * by a later cycle. Potential is a named reviewer's judgment on the organization's own three-level scale, written
 * once. The 9-box cell is the pair of buckets: a picture of a distribution, not a rank, and nothing downstream is
 * triggered by it. Which rating means "high performance" is this cycle's configuration.
 */
const DEFAULT_LEVELS = [
  { code: 'LOW', label: 'Low', description: null },
  { code: 'MEDIUM', label: 'Medium', description: null },
  { code: 'HIGH', label: 'High', description: null },
];
const cycleInclude = {
  organization: { select: { id: true, name: true } },
  performanceCycle: { select: { id: true, code: true, name: true, status: true, ratingBands: { select: { code: true, label: true }, orderBy: { minScore: 'asc' as const } } } },
  bucketRules: { orderBy: { ratingCode: 'asc' as const } },
} satisfies Prisma.TalentReviewCycleInclude;
type CycleRow = Prisma.TalentReviewCycleGetPayload<{ include: typeof cycleInclude }>;
const reviewInclude = { cycle: { select: { id: true, code: true, name: true, status: true } }, employee: { select: { id: true, employeeCode: true, firstName: true, lastName: true } } } satisfies Prisma.TalentReviewInclude;
type ReviewRow = Prisma.TalentReviewGetPayload<{ include: typeof reviewInclude }>;

async function cycleDto(db: Db, row: CycleRow): Promise<TalentCycleDto> {
  const counts = await db.talentReview.groupBy({ by: ['status'], where: { cycleId: row.id }, _count: { _all: true }, orderBy: { status: 'asc' } });
  const n = (s: string) => counts.find((c) => c.status === s)?._count._all ?? 0;
  return {
    id: row.id, code: row.code, name: row.name, periodStart: row.periodStart, periodEnd: row.periodEnd, organization: row.organization,
    performanceCycle: row.performanceCycle ? { id: row.performanceCycle.id, code: row.performanceCycle.code, name: row.performanceCycle.name, status: row.performanceCycle.status, ratingBands: row.performanceCycle.ratingBands } : null,
    potentialLevels: row.potentialLevels as TalentCycleDto['potentialLevels'],
    bucketRules: row.bucketRules.map((r) => ({ ratingCode: r.ratingCode, bucket: r.bucket as TalentBucket })),
    status: row.status as TalentCycleDto['status'],
    counts: { assigned: n('ASSIGNED'), submitted: n('SUBMITTED'), finalized: n('FINALIZED') },
    activatedAt: row.activatedAt?.toISOString() ?? null, closedAt: row.closedAt?.toISOString() ?? null, createdAt: row.createdAt.toISOString(),
  };
}

/** Who sees the judgment: the reviewer who made it and the people who run the cycle. A team summary sees the cell only. */
const seesJudgment = (auth: AuthContext, row: ReviewRow) => canManageTalent(auth) || row.reviewerUserId === auth.userId;

export const toReviewDto = (auth: AuthContext, row: ReviewRow): TalentReviewDto => {
  const full = seesJudgment(auth, row);
  return {
    id: row.id, cycle: row.cycle, employee: row.employee,
    snapshot: { organizationName: row.organizationNameSnapshot, departmentName: row.departmentNameSnapshot, jobTitle: row.jobTitleSnapshot, positionTitle: row.positionTitleSnapshot },
    reviewer: { employeeId: row.reviewerEmployeeId, userId: row.reviewerUserId, name: row.reviewerNameSnapshot },
    performance: { planId: row.performancePlanId, score: row.performanceScoreSnapshot?.toFixed(2) ?? null, ratingCode: row.performanceRatingCodeSnapshot, ratingLabel: row.performanceRatingLabelSnapshot, bucket: (row.performanceBucket as TalentBucket | null) ?? null, cycleName: row.performanceCycleNameSnapshot },
    potentialLevel: full ? ((row.potentialLevel as TalentBucket | null) ?? null) : null,
    potentialComment: full ? row.potentialComment : null,
    commentVisible: full,
    nineBoxCell: row.nineBoxCell,
    status: row.status as TalentReviewDto['status'],
    submittedAt: row.submittedAt?.toISOString() ?? null, finalizedAt: row.finalizedAt?.toISOString() ?? null, createdAt: row.createdAt.toISOString(),
  };
};

async function loadCycle(db: Db, id: string) {
  const row = await db.talentReviewCycle.findUnique({ where: { id }, include: cycleInclude });
  if (!row) throw notFound('talent cycle');
  return row;
}
async function loadReview(db: Db, id: string) {
  const row = await db.talentReview.findUnique({ where: { id }, include: reviewInclude });
  if (!row) throw notFound('talent review');
  return row;
}

/** Reviews a non-manager may read: their own assignments as reviewer, plus their direct reports' (cell only). */
const reviewScope = (auth: AuthContext, view: 'mine' | 'team' | 'all'): Prisma.TalentReviewWhereInput => {
  if (view === 'mine') return { reviewerUserId: auth.userId };
  if (canManageTalent(auth) && view === 'all') return {};
  const me = auth.employeeId ?? '__none__';
  const team: Prisma.TalentReviewWhereInput = auth.dataScope === 'ALL' || auth.dataScope === 'TEAM' ? { employee: { managerId: me } } : { id: '__none__' };
  return { OR: [{ reviewerUserId: auth.userId }, team] };
};

async function assertOpenForReview(cycle: { status: string }) {
  if (cycle.status !== 'ACTIVE' && cycle.status !== 'REVIEW') throw new AppError(409, 'TALENT_CYCLE_NOT_OPEN', `This cycle is ${cycle.status.toLowerCase()}`);
}

export const talentCycleService = {
  async list(q: TalentCycleListQuery) {
    const where: Prisma.TalentReviewCycleWhereInput = { status: q.status };
    const [total, rows] = await prisma.$transaction([prisma.talentReviewCycle.count({ where }), prisma.talentReviewCycle.findMany({ where, include: cycleInclude, orderBy: { periodStart: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize })]);
    return { data: await Promise.all(rows.map((r) => cycleDto(prisma, r))), meta: { page: q.page, pageSize: q.pageSize, total } };
  },
  async get(id: string): Promise<TalentCycleDto> { return cycleDto(prisma, await loadCycle(prisma, id)); },

  async create(input: CreateTalentCycleInput, actor: Actor): Promise<TalentCycleDto> {
    if (await prisma.talentReviewCycle.findUnique({ where: { code: input.code }, select: { id: true } })) throw new AppError(409, 'TALENT_CYCLE_CODE_EXISTS', `Cycle ${input.code} already exists`);
    if (input.performanceCycleId) {
      const pc = await prisma.performanceCycle.findUnique({ where: { id: input.performanceCycleId }, select: { status: true } });
      if (!pc) throw new AppError(404, 'PERFORMANCE_CYCLE_NOT_FOUND', 'Performance cycle not found');
      if (pc.status !== 'REVIEW' && pc.status !== 'CLOSED') throw new AppError(422, 'PERFORMANCE_CYCLE_NOT_FINALIZED', 'Talent reviews read finalized performance; choose a cycle in review or closed');
    }
    const row = await prisma.$transaction(async (tx) => {
      const created = await tx.talentReviewCycle.create({ data: { code: input.code, name: input.name, periodStart: input.periodStart, periodEnd: input.periodEnd, organizationId: input.organizationId ?? null, performanceCycleId: input.performanceCycleId ?? null, potentialLevels: input.potentialLevels ?? DEFAULT_LEVELS, createdByUserId: actor.auth.userId }, include: cycleInclude });
      await auditService.log(talentAudit(actor, AUDIT_ACTIONS.CREATE_TALENT_CYCLE, 'TalentReviewCycle', created.id, { code: created.code, name: created.name, performanceCycleId: created.performanceCycleId }), tx);
      return created;
    });
    return cycleDto(prisma, row);
  },

  async update(id: string, input: UpdateTalentCycleInput, actor: Actor): Promise<TalentCycleDto> {
    await prisma.$transaction(async (tx) => {
      await lockRow(tx, 'talent_review_cycles', id);
      const before = await loadCycle(tx, id);
      if (before.status === 'CLOSED') throw new AppError(409, 'TALENT_CYCLE_CLOSED', 'A closed cycle is immutable');
      if (input.performanceCycleId !== undefined && before.status !== 'DRAFT') throw new AppError(409, 'TALENT_CYCLE_NOT_DRAFT', 'The performance input can only change while the cycle is a draft');
      const updated = await tx.talentReviewCycle.update({ where: { id }, data: { name: input.name, periodStart: input.periodStart, periodEnd: input.periodEnd, performanceCycleId: input.performanceCycleId, potentialLevels: input.potentialLevels } });
      if (input.performanceCycleId !== undefined) await tx.talentPerformanceBucketRule.deleteMany({ where: { cycleId: id } });
      await auditService.log(talentAudit(actor, AUDIT_ACTIONS.UPDATE_TALENT_CYCLE, 'TalentReviewCycle', id, { fields: Object.keys(input), name: updated.name, performanceCycleId: updated.performanceCycleId }, { name: before.name, performanceCycleId: before.performanceCycleId }), tx);
    });
    return cycleDto(prisma, await loadCycle(prisma, id));
  },

  /** Every rating band mapped exactly once, or nothing is saved. */
  async setBucketRules(id: string, input: SetBucketRulesInput, actor: Actor): Promise<TalentCycleDto> {
    await prisma.$transaction(async (tx) => {
      await lockRow(tx, 'talent_review_cycles', id);
      const cycle = await loadCycle(tx, id);
      if (cycle.status === 'CLOSED') throw new AppError(409, 'TALENT_CYCLE_CLOSED', 'A closed cycle is immutable');
      if (!cycle.performanceCycle) throw new AppError(422, 'PERFORMANCE_CYCLE_REQUIRED', 'Link a performance cycle before mapping its ratings to buckets');
      const check = validateBucketRules(cycle.performanceCycle.ratingBands.map((b) => b.code), input.rules);
      if (!check.ok) throw new AppError(422, 'BUCKET_RULES_AMBIGUOUS', `Every rating must map to exactly one bucket. Missing: ${check.missing.join(', ') || 'none'}; duplicated: ${check.duplicated.join(', ') || 'none'}; unknown: ${check.unknown.join(', ') || 'none'}`);
      await tx.talentPerformanceBucketRule.deleteMany({ where: { cycleId: id } });
      await tx.talentPerformanceBucketRule.createMany({ data: input.rules.map((r) => ({ cycleId: id, ratingCode: r.ratingCode, bucket: r.bucket })) });
      // Reviews already assigned get their bucket (and cell, if potential is in) recomputed from the new rules — the
      // snapshot of the SCORE is untouched; only the organization's reading of it changed, and it is not closed yet.
      const reviews = await tx.talentReview.findMany({ where: { cycleId: id, status: { not: 'FINALIZED' } }, select: { id: true, performanceRatingCodeSnapshot: true, potentialBucket: true } });
      for (const r of reviews) {
        const bucket = bucketFor(r.performanceRatingCodeSnapshot, input.rules);
        await tx.talentReview.update({ where: { id: r.id }, data: { performanceBucket: bucket, nineBoxCell: nineBoxCell(bucket, r.potentialBucket as TalentBucket | null) } });
      }
      await auditService.log(talentAudit(actor, AUDIT_ACTIONS.UPDATE_TALENT_CYCLE, 'TalentReviewCycle', id, { bucketRules: input.rules, reviewsRebucketed: reviews.length }), tx);
    });
    return cycleDto(prisma, await loadCycle(prisma, id));
  },

  async activate(id: string, actor: Actor): Promise<TalentCycleDto> {
    await prisma.$transaction(async (tx) => {
      await lockRow(tx, 'talent_review_cycles', id);
      const cycle = await loadCycle(tx, id);
      if (cycle.status !== 'DRAFT') throw new AppError(409, 'TALENT_CYCLE_NOT_DRAFT', `This cycle is ${cycle.status.toLowerCase()}`);
      if (cycle.performanceCycle && cycle.bucketRules.length === 0) throw new AppError(422, 'BUCKET_RULES_REQUIRED', 'Map the performance ratings to buckets before activating');
      await tx.talentReviewCycle.update({ where: { id }, data: { status: 'ACTIVE', activatedAt: new Date() } });
      await auditService.log(talentAudit(actor, AUDIT_ACTIONS.UPDATE_TALENT_CYCLE, 'TalentReviewCycle', id, { status: 'ACTIVE' }, { status: 'DRAFT' }), tx);
    });
    return cycleDto(prisma, await loadCycle(prisma, id));
  },

  /** REVIEW: no new assignments, submissions still open. */
  async openReview(id: string, actor: Actor): Promise<TalentCycleDto> {
    await prisma.$transaction(async (tx) => {
      await lockRow(tx, 'talent_review_cycles', id);
      const cycle = await loadCycle(tx, id);
      if (cycle.status !== 'ACTIVE') throw new AppError(409, 'TALENT_CYCLE_NOT_ACTIVE', `This cycle is ${cycle.status.toLowerCase()}`);
      await tx.talentReviewCycle.update({ where: { id }, data: { status: 'REVIEW' } });
      await auditService.log(talentAudit(actor, AUDIT_ACTIONS.UPDATE_TALENT_CYCLE, 'TalentReviewCycle', id, { status: 'REVIEW' }, { status: 'ACTIVE' }), tx);
    });
    return cycleDto(prisma, await loadCycle(prisma, id));
  },

  /** Close: every submitted review becomes FINALIZED and the cycle is immutable. Unsubmitted reviews stay as they are. */
  async close(id: string, actor: Actor): Promise<TalentCycleDto> {
    await prisma.$transaction(async (tx) => {
      await lockRow(tx, 'talent_review_cycles', id);
      const cycle = await loadCycle(tx, id);
      if (cycle.status !== 'ACTIVE' && cycle.status !== 'REVIEW') throw new AppError(409, 'TALENT_CYCLE_NOT_OPEN', `This cycle is ${cycle.status.toLowerCase()}`);
      const finalized = await tx.talentReview.updateMany({ where: { cycleId: id, status: 'SUBMITTED' }, data: { status: 'FINALIZED', finalizedAt: new Date() } });
      const unsubmitted = await tx.talentReview.count({ where: { cycleId: id, status: 'ASSIGNED' } });
      await tx.talentReviewCycle.update({ where: { id }, data: { status: 'CLOSED', closedAt: new Date() } });
      await auditService.log(talentAudit(actor, AUDIT_ACTIONS.FINALIZE_TALENT_REVIEW, 'TalentReviewCycle', id, { finalized: finalized.count, unsubmitted }, { status: cycle.status }), tx);
    });
    return cycleDto(prisma, await loadCycle(prisma, id));
  },

  /**
   * Assign employees to the cycle. Each review snapshots where the person is, their finalized performance in the
   * linked cycle (if any), and their direct manager as reviewer — provided that manager can sign in.
   */
  async assign(id: string, input: AssignTalentReviewsInput, actor: Actor): Promise<{ created: number; skipped: { employeeId: string; employeeCode: string; reason: string }[]; cycle: TalentCycleDto }> {
    const result = await prisma.$transaction(async (tx) => {
      await lockRow(tx, 'talent_review_cycles', id);
      const cycle = await loadCycle(tx, id);
      if (cycle.status !== 'ACTIVE') throw new AppError(409, 'TALENT_CYCLE_NOT_ACTIVE', 'Employees can be assigned while the cycle is active');
      const employees = await tx.employee.findMany({
        where: { employmentStatus: 'ACTIVE', ...(input.employeeIds?.length ? { id: { in: input.employeeIds } } : { departmentId: input.departmentId }) },
        select: {
          id: true, employeeCode: true, firstName: true, lastName: true, organizationId: true, departmentId: true, positionId: true,
          organization: { select: { name: true } }, department: { select: { name: true } }, position: { select: { title: true, jobId: true, job: { select: { title: true } } } },
          manager: { select: { id: true, firstName: true, lastName: true, user: { select: { id: true, isActive: true } } } },
        },
      });
      const existing = new Set((await tx.talentReview.findMany({ where: { cycleId: id, employeeId: { in: employees.map((e) => e.id) } }, select: { employeeId: true } })).map((r) => r.employeeId));
      const plans = cycle.performanceCycleId
        ? await tx.performancePlan.findMany({ where: { cycleId: cycle.performanceCycleId, employeeId: { in: employees.map((e) => e.id) }, status: 'FINALIZED' }, select: { id: true, employeeId: true, weightedScore: true, ratingCode: true, ratingLabelSnapshot: true, cycle: { select: { name: true } } } })
        : [];
      const rules = cycle.bucketRules.map((r) => ({ ratingCode: r.ratingCode, bucket: r.bucket as TalentBucket }));
      const skipped: { employeeId: string; employeeCode: string; reason: string }[] = [];
      let created = 0;
      for (const e of employees) {
        if (existing.has(e.id)) { skipped.push({ employeeId: e.id, employeeCode: e.employeeCode, reason: 'ALREADY_ASSIGNED' }); continue; }
        const plan = plans.find((p) => p.employeeId === e.id) ?? null;
        const reviewerOk = !!e.manager?.user?.isActive;
        const review = await tx.talentReview.create({
          data: {
            cycleId: id, employeeId: e.id, employeeCodeSnapshot: e.employeeCode, employeeNameSnapshot: `${e.firstName} ${e.lastName}`,
            organizationIdSnapshot: e.organizationId, organizationNameSnapshot: e.organization?.name ?? null, departmentIdSnapshot: e.departmentId, departmentNameSnapshot: e.department?.name ?? null,
            jobIdSnapshot: e.position?.jobId ?? null, jobTitleSnapshot: e.position?.job?.title ?? null, positionIdSnapshot: e.positionId, positionTitleSnapshot: e.position?.title ?? null,
            performancePlanId: plan?.id ?? null, performanceCycleNameSnapshot: plan?.cycle.name ?? null, performanceScoreSnapshot: plan?.weightedScore ?? null,
            performanceRatingCodeSnapshot: plan?.ratingCode ?? null, performanceRatingLabelSnapshot: plan?.ratingLabelSnapshot ?? null, performanceBucket: bucketFor(plan?.ratingCode, rules),
            reviewerEmployeeId: e.manager?.id ?? null, reviewerUserId: reviewerOk ? e.manager!.user!.id : null, reviewerNameSnapshot: e.manager ? `${e.manager.firstName} ${e.manager.lastName}` : null,
          },
        });
        created += 1;
        if (reviewerOk) {
          await notificationService.publish(
            { userId: e.manager!.user!.id, type: NOTIFICATION_TYPES.TALENT_REVIEW_REQUIRED, source: { module: 'talent', entityType: 'TALENT_REVIEW', entityId: review.id }, data: { reviewId: review.id, cycleId: id }, dedupeKey: `talent:review:${review.id}:required:${e.manager!.user!.id}` },
            { employeeName: `${e.firstName} ${e.lastName}`, cycleName: cycle.name }, tx,
          );
        }
        await auditService.log(talentAudit(actor, AUDIT_ACTIONS.ASSIGN_TALENT_REVIEW, 'TalentReview', review.id, { cycleId: id, employeeCode: e.employeeCode, reviewerEmployeeId: e.manager?.id ?? null, reviewerHasAccount: reviewerOk, performancePlanId: plan?.id ?? null, performanceBucket: review.performanceBucket }), tx);
      }
      return { created, skipped };
    });
    return { ...result, cycle: await this.get(id) };
  },

  async reassignReviewer(reviewId: string, reviewerEmployeeId: string, actor: Actor): Promise<TalentReviewDto> {
    await prisma.$transaction(async (tx) => {
      await lockRow(tx, 'talent_reviews', reviewId);
      const review = await loadReview(tx, reviewId);
      if (review.status !== 'ASSIGNED') throw new AppError(409, 'TALENT_REVIEW_SUBMITTED', 'The reviewer cannot change after submission');
      const reviewer = await tx.employee.findUnique({ where: { id: reviewerEmployeeId }, select: { id: true, firstName: true, lastName: true, user: { select: { id: true, isActive: true } } } });
      if (!reviewer) throw new AppError(404, 'EMPLOYEE_NOT_FOUND', 'Reviewer not found');
      if (!reviewer.user?.isActive) throw new AppError(409, 'TALENT_REVIEWER_REQUIRED', 'That reviewer has no active account, so they could not open the review');
      if (reviewer.id === review.employeeId) throw new AppError(422, 'TALENT_REVIEWER_SELF', 'Somebody cannot assess their own potential');
      await tx.talentReview.update({ where: { id: reviewId }, data: { reviewerEmployeeId: reviewer.id, reviewerUserId: reviewer.user.id, reviewerNameSnapshot: `${reviewer.firstName} ${reviewer.lastName}` } });
      await notificationService.publish(
        { userId: reviewer.user.id, type: NOTIFICATION_TYPES.TALENT_REVIEW_REQUIRED, source: { module: 'talent', entityType: 'TALENT_REVIEW', entityId: reviewId }, data: { reviewId, cycleId: review.cycleId }, dedupeKey: `talent:review:${reviewId}:required:${reviewer.user.id}` },
        { employeeName: review.employeeNameSnapshot, cycleName: review.cycle.name }, tx,
      );
      await auditService.log(talentAudit(actor, AUDIT_ACTIONS.ASSIGN_TALENT_REVIEW, 'TalentReview', reviewId, { reviewerEmployeeId: reviewer.id, reassigned: true }, { reviewerEmployeeId: review.reviewerEmployeeId }), tx);
    });
    return toReviewDto(actor.auth, await loadReview(prisma, reviewId));
  },

  /** The reviewer's judgment, written once. TEAM scope alone gives no right to write it. */
  async submitPotential(reviewId: string, input: SubmitPotentialInput, actor: Actor): Promise<TalentReviewDto> {
    await prisma.$transaction(async (tx) => {
      await lockRow(tx, 'talent_reviews', reviewId);
      const review = await loadReview(tx, reviewId);
      if (review.reviewerUserId !== actor.auth.userId) throw new AppError(403, 'FORBIDDEN', 'Only the assigned reviewer can submit this assessment');
      const cycle = await loadCycle(tx, review.cycleId);
      await assertOpenForReview(cycle);
      if (review.status !== 'ASSIGNED') throw new AppError(409, 'TALENT_REVIEW_SUBMITTED', 'This assessment has already been submitted');
      const levels = cycle.potentialLevels as { code: string }[];
      if (!levels.some((l) => l.code === input.potentialLevel)) throw new AppError(422, 'POTENTIAL_LEVEL_INVALID', 'That level is not on this cycle\'s potential scale');
      const cell = nineBoxCell(review.performanceBucket as TalentBucket | null, input.potentialLevel);
      await tx.talentReview.update({ where: { id: reviewId }, data: { potentialLevel: input.potentialLevel, potentialComment: input.potentialComment ?? null, potentialBucket: input.potentialLevel, nineBoxCell: cell, status: 'SUBMITTED', submittedAt: new Date() } });
      if (cycle.createdByUserId && cycle.createdByUserId !== actor.auth.userId) {
        await notificationService.publish(
          { userId: cycle.createdByUserId, type: NOTIFICATION_TYPES.TALENT_REVIEW_COMPLETED, source: { module: 'talent', entityType: 'TALENT_REVIEW', entityId: reviewId }, data: { reviewId, cycleId: cycle.id }, dedupeKey: `talent:review:${reviewId}:completed` },
          { cycleName: cycle.name }, tx,
        );
      }
      await auditService.log(talentAudit(actor, AUDIT_ACTIONS.SUBMIT_POTENTIAL_ASSESSMENT, 'TalentReview', reviewId, { cycleId: cycle.id, potentialLevel: input.potentialLevel, nineBoxCell: cell, ...textAudit('potentialComment', null, input.potentialComment) }), tx);
    });
    return toReviewDto(actor.auth, await loadReview(prisma, reviewId));
  },

  async listReviews(auth: AuthContext, q: TalentReviewListQuery) {
    const where: Prisma.TalentReviewWhereInput = { ...reviewScope(auth, q.view), cycleId: q.cycleId, status: q.status, departmentIdSnapshot: q.departmentId, nineBoxCell: q.nineBoxCell };
    const [total, rows] = await prisma.$transaction([prisma.talentReview.count({ where }), prisma.talentReview.findMany({ where, include: reviewInclude, orderBy: [{ cycle: { periodStart: 'desc' } }, { employeeCodeSnapshot: 'asc' }], skip: (q.page - 1) * q.pageSize, take: q.pageSize })]);
    return { data: rows.map((r) => toReviewDto(auth, r)), meta: { page: q.page, pageSize: q.pageSize, total } };
  },

  async getReview(auth: AuthContext, id: string): Promise<TalentReviewDto> {
    const row = await prisma.talentReview.findFirst({ where: { id, ...reviewScope(auth, 'all') }, include: reviewInclude });
    if (!row) throw notFound('talent review');
    return toReviewDto(auth, row);
  },

  /** What a reviewer looks at: the snapshot, the competency picture against the current job, development, prior cycles. */
  async reviewContext(auth: AuthContext, id: string): Promise<TalentReviewContextDto> {
    const review = await this.getReview(auth, id);
    const jobId = (await prisma.employee.findUnique({ where: { id: review.employee.id }, select: { position: { select: { jobId: true } } } }))?.position?.jobId ?? null;
    const rows = jobId ? await skillGapService.getGapsAgainstJob({ employeeId: review.employee.id, jobId }) : [];
    const prior = await prisma.talentReview.findMany({ where: { employeeId: review.employee.id, id: { not: id }, status: 'FINALIZED' }, select: { nineBoxCell: true, finalizedAt: true, cycle: { select: { name: true } } }, orderBy: { finalizedAt: 'desc' }, take: 5 });
    return {
      review,
      competencySummary: jobId ? { requirements: rows.length, assessed: rows.filter((r) => r.gapStatus !== 'UNASSESSED').length, gaps: rows.filter((r) => r.gapStatus === 'GAP').length, unassessed: rows.filter((r) => r.gapStatus === 'UNASSESSED').length, status: careerReadinessStatus(rows.map((r) => ({ gapStatus: r.gapStatus }))) } : null,
      development: await developmentContext(prisma, review.employee.id),
      priorReviews: prior.map((p) => ({ cycleName: p.cycle.name, nineBoxCell: p.nineBoxCell, finalizedAt: p.finalizedAt?.toISOString() ?? null })),
    };
  },

  /** Counts per cell. A distribution, never an ordering. */
  async nineBox(cycleId: string): Promise<NineBoxDto> {
    const cycle = await loadCycle(prisma, cycleId);
    const rows = await prisma.talentReview.groupBy({ by: ['nineBoxCell'], where: { cycleId, status: { in: ['SUBMITTED', 'FINALIZED'] } }, _count: { _all: true }, orderBy: { nineBoxCell: 'asc' } });
    const [noPerformance, noPotential, total] = await Promise.all([
      prisma.talentReview.count({ where: { cycleId, performanceBucket: null } }),
      prisma.talentReview.count({ where: { cycleId, potentialBucket: null } }),
      prisma.talentReview.count({ where: { cycleId } }),
    ]);
    return {
      cycle: { id: cycle.id, name: cycle.name, status: cycle.status },
      cells: NINE_BOX_CELLS.map((cell) => { const m = /^(\w+)_PERFORMANCE_(\w+)_POTENTIAL$/.exec(cell)!; return { cell, performance: m[1]!, potential: m[2]!, count: rows.find((r) => r.nineBoxCell === cell)?._count._all ?? 0 }; }),
      unplaced: { noPerformance, noPotential },
      total,
    };
  },
};

export { loadReview as loadTalentReview };
export type { Tx as TalentTx };
