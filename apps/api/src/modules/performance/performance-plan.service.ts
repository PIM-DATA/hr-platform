import {
  AUDIT_ACTIONS, NOTIFICATION_TYPES, PERFORMANCE_TOTAL_WEIGHT, PERMISSIONS, planProgressPercent, resolveRatingBand,
  type AddPlanItemInput, type AssignPlansInput, type AssignPlansResultDto, type ManagerAssessmentInput,
  type PlanDetailDto, type PlanItemDto, type PlanListQuery, type PlanSummaryDto, type SelfAssessmentInput,
  type UpdatePlanInput, type UpdatePlanItemInput, type UpdateProgressInput,
} from '@hr/shared';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { AppError } from '../../lib/errors';
import { auditService } from '../../services/audit/audit.service';
import { notificationService } from '../../services/notification/notification.service';
import { hasPermission } from '../../services/authorization/authorization.service';
import type { AuthContext } from '../auth/auth.types';
import { kpiService } from './performance-master.service';
import { equals, score, scoreIsOnScale, sumWeights, toScoreString, weightedScore } from './score';
import { performanceAudit, type Actor, type Db, type Tx } from './performance.types';

/**
 * Performance plans: one employee, one cycle, the things they are measured on, and the two assessments that close it.
 *
 * Three things matter more than the rest.
 *
 * **The snapshot is the record.** A plan freezes who the employee was — organization, department, position, job — and
 * who reviews them, at the moment it is created. Somebody transferring in October does not retroactively move their
 * January review to another department's report, and a new manager does not inherit a review already under way.
 *
 * **Authority is the reviewer snapshot, not the org chart.** Being somebody's manager today does not let you write a
 * review that was assigned to somebody else; the check is `reviewerUserId == you`, every time.
 *
 * **Scores are decimal and calculated once.** The weighted score is `SUM(managerScore × weight / 100)`, rounded once,
 * on the server, when the manager submits. Nothing else computes it — least of all the browser.
 */
const planInclude = {
  cycle: { select: { id: true, code: true, name: true, status: true, selfReviewRequired: true, minScore: true, maxScore: true, scoreStep: true, ratingBands: true } },
  employee: { select: { id: true, employeeCode: true, firstName: true, lastName: true, user: { select: { id: true, isActive: true } } } },
  items: { orderBy: [{ createdAt: 'asc' as const }] },
} satisfies Prisma.PerformancePlanInclude;
type PlanRow = Prisma.PerformancePlanGetPayload<{ include: typeof planInclude }>;

const toItemDto = (row: PlanRow['items'][number]): PlanItemDto => ({
  id: row.id,
  kpiId: row.kpiId,
  kpiCode: row.kpiCodeSnapshot,
  kpiName: row.kpiNameSnapshot,
  description: row.descriptionSnapshot,
  measurementType: row.measurementType as PlanItemDto['measurementType'],
  weight: toScoreString(row.weight)!,
  targetValue: toScoreString(row.targetValue),
  targetText: row.targetText,
  actualValue: toScoreString(row.actualValue),
  actualText: row.actualText,
  progressPercent: row.progressPercent,
  employeeComment: row.employeeComment,
  managerComment: row.managerComment,
  selfScore: toScoreString(row.selfScore),
  managerScore: toScoreString(row.managerScore),
  finalScore: toScoreString(row.finalScore),
});

function toSummaryDto(row: PlanRow): PlanSummaryDto {
  const items = row.items.map(toItemDto);
  return {
    id: row.id,
    cycle: {
      id: row.cycle.id, code: row.cycle.code, name: row.cycle.name, status: row.cycle.status,
      selfReviewRequired: row.cycle.selfReviewRequired,
      minScore: toScoreString(row.cycle.minScore)!, maxScore: toScoreString(row.cycle.maxScore)!,
    },
    employee: { id: row.employee.id, employeeCode: row.employeeCodeSnapshot, firstName: row.employee.firstName, lastName: row.employee.lastName },
    snapshot: { organizationName: row.organizationName, departmentName: row.departmentName, positionTitle: row.positionTitle, jobTitle: row.jobTitle },
    reviewer: { employeeId: row.reviewerEmployeeId, name: row.reviewerNameSnapshot, hasAccount: !!row.reviewerUserId },
    status: row.status as PlanSummaryDto['status'],
    selfSubmittedAt: row.selfSubmittedAt?.toISOString() ?? null,
    managerSubmittedAt: row.managerSubmittedAt?.toISOString() ?? null,
    finalizedAt: row.finalizedAt?.toISOString() ?? null,
    weightedScore: toScoreString(row.weightedScore),
    ratingCode: row.ratingCode,
    ratingLabel: row.ratingLabelSnapshot,
    totalWeight: toScoreString(sumWeights(items.map((i) => i.weight)))!,
    progressPercent: planProgressPercent(items.map((i) => ({ progressPercent: i.progressPercent, weight: i.weight }))),
    itemCount: items.length,
    selfReviewUnavailable: !row.employee.user?.isActive,
  };
}

const toDetailDto = (row: PlanRow): PlanDetailDto => ({ ...toSummaryDto(row), items: row.items.map(toItemDto) });

async function loadPlan(db: Db, id: string): Promise<PlanRow> {
  const row = await db.performancePlan.findUnique({ where: { id }, include: planInclude });
  if (!row) throw new AppError(404, 'PERFORMANCE_PLAN_NOT_FOUND', 'Performance plan not found');
  return row;
}

const lockPlan = async (tx: Tx, id: string) => {
  await tx.$executeRaw`SELECT "id" FROM "performance_plans" WHERE "id" = ${id} FOR UPDATE`;
};

// ---------------------------------------------------------------------------
// authorization
// ---------------------------------------------------------------------------
/**
 * Who may read one plan: the employee it is about, the reviewer it was assigned to, or somebody who manages cycles.
 *
 * A data scope is deliberately not in that list. Seeing a report's attendance is an operational need; reading what
 * their manager wrote about them is not, and the two must not be joined up by accident.
 */
function assertCanRead(auth: AuthContext, plan: { employeeId: string; reviewerUserId: string | null }) {
  const isSubject = !!auth.employeeId && plan.employeeId === auth.employeeId;
  const isReviewer = !!plan.reviewerUserId && plan.reviewerUserId === auth.userId;
  const managesCycles = hasPermission(auth, PERMISSIONS.PERFORMANCE_MANAGE_CYCLES);
  if (!isSubject && !isReviewer && !managesCycles) throw AppError.forbidden();
}

/** Writing an assessment is narrower still: only the snapshot reviewer, and only with `performance.review`. */
function assertIsReviewer(auth: AuthContext, plan: { reviewerUserId: string | null }) {
  if (!plan.reviewerUserId || plan.reviewerUserId !== auth.userId) throw AppError.forbidden();
  if (!hasPermission(auth, PERMISSIONS.PERFORMANCE_REVIEW)) throw AppError.forbidden();
}

function assertIsSubject(auth: AuthContext, plan: { employeeId: string }) {
  if (!auth.employeeId || plan.employeeId !== auth.employeeId) throw AppError.forbidden();
}

// ---------------------------------------------------------------------------
// snapshots
// ---------------------------------------------------------------------------
const employeeForPlan = {
  id: true, employeeCode: true, firstName: true, lastName: true, employmentStatus: true,
  organizationId: true, departmentId: true, positionId: true, managerId: true,
  organization: { select: { name: true } },
  department: { select: { name: true } },
  position: { select: { title: true, jobId: true, job: { select: { title: true } } } },
  manager: { select: { id: true, firstName: true, lastName: true, user: { select: { id: true, isActive: true } } } },
} satisfies Prisma.EmployeeSelect;
type EmployeeForPlan = Prisma.EmployeeGetPayload<{ select: typeof employeeForPlan }>;

/** Everything a plan freezes about an employee at the moment it is created. */
const snapshotOf = (employee: EmployeeForPlan) => ({
  employeeCodeSnapshot: employee.employeeCode,
  employeeNameSnapshot: `${employee.firstName} ${employee.lastName}`,
  organizationId: employee.organizationId,
  organizationName: employee.organization?.name ?? null,
  departmentId: employee.departmentId,
  departmentName: employee.department?.name ?? null,
  positionId: employee.positionId,
  positionTitle: employee.position?.title ?? null,
  jobId: employee.position?.jobId ?? null,
  jobTitle: employee.position?.job?.title ?? null,
  reviewerEmployeeId: employee.manager?.id ?? null,
  reviewerUserId: employee.manager?.user?.isActive ? employee.manager.user.id : null,
  reviewerNameSnapshot: employee.manager ? `${employee.manager.firstName} ${employee.manager.lastName}` : null,
});

export const performancePlanService = {
  /**
   * Assigning a cycle to a population. HR picks a filter or a list of people and gets one plan each — assigning a
   * hundred employees one at a time is not a workflow anybody would use twice.
   *
   * Already-assigned employees are counted, not failed: re-running an assignment after adding a department is normal.
   */
  async assign(cycleId: string, input: AssignPlansInput, actor: Actor): Promise<AssignPlansResultDto> {
    return prisma.$transaction(async (tx) => {
      const cycle = await tx.performanceCycle.findUnique({ where: { id: cycleId }, select: { id: true, code: true, status: true, organizationId: true } });
      if (!cycle) throw new AppError(404, 'PERFORMANCE_CYCLE_NOT_FOUND', 'Performance cycle not found');
      if (cycle.status === 'CLOSED') throw new AppError(409, 'PERFORMANCE_CYCLE_CLOSED', 'A closed cycle cannot be assigned to');

      const where: Prisma.EmployeeWhereInput = input.employeeIds?.length
        ? { id: { in: input.employeeIds } }
        : {
            employmentStatus: 'ACTIVE',
            organizationId: input.organizationId ?? cycle.organizationId ?? undefined,
            departmentId: input.departmentId,
            positionId: input.positionId,
            ...(input.jobId ? { position: { jobId: input.jobId } } : {}),
          };
      const employees = await tx.employee.findMany({ where, select: employeeForPlan, orderBy: { employeeCode: 'asc' } });
      if (employees.length === 0) throw new AppError(409, 'PERFORMANCE_NO_EMPLOYEES', 'No employee matches that selection');

      const existing = await tx.performancePlan.findMany({ where: { cycleId, employeeId: { in: employees.map((e) => e.id) } }, select: { employeeId: true } });
      const alreadyAssigned = new Set(existing.map((e) => e.employeeId));

      const skipped: AssignPlansResultDto['skipped'] = [];
      const toCreate: EmployeeForPlan[] = [];
      for (const employee of employees) {
        if (alreadyAssigned.has(employee.id)) continue;
        if (employee.employmentStatus !== 'ACTIVE') { skipped.push({ employeeCode: employee.employeeCode, reason: 'Not an active employee' }); continue; }
        toCreate.push(employee);
      }

      if (toCreate.length > 0) {
        await tx.performancePlan.createMany({
          data: toCreate.map((employee) => ({
            cycleId,
            employeeId: employee.id,
            ...snapshotOf(employee),
            status: cycle.status === 'DRAFT' ? 'DRAFT' : 'ACTIVE',
          })),
        });
      }

      await auditService.log(performanceAudit(actor, AUDIT_ACTIONS.ASSIGN_PERFORMANCE_PLAN, 'PerformanceCycle', cycleId, {
        cycle: cycle.code, created: toCreate.length, alreadyAssigned: alreadyAssigned.size, skipped: skipped.length,
      }), tx);

      return { created: toCreate.length, alreadyAssigned: alreadyAssigned.size, skipped };
    });
  },

  /**
   * Listing plans. The `view` decides the population and each one is authorized on its own terms: your own plan needs
   * nothing, the ones you review need `performance.review`, and everybody's needs `performance.manage_cycles`.
   */
  async list(auth: AuthContext, q: PlanListQuery): Promise<{ data: PlanSummaryDto[]; meta: { page: number; pageSize: number; total: number } }> {
    let scope: Prisma.PerformancePlanWhereInput;
    if (q.view === 'all') {
      if (!hasPermission(auth, PERMISSIONS.PERFORMANCE_MANAGE_CYCLES)) throw AppError.forbidden();
      scope = {};
    } else if (q.view === 'reviewing') {
      if (!hasPermission(auth, PERMISSIONS.PERFORMANCE_REVIEW)) throw AppError.forbidden();
      scope = { reviewerUserId: auth.userId };
    } else {
      if (!auth.employeeId) return { data: [], meta: { page: q.page, pageSize: q.pageSize, total: 0 } };
      scope = { employeeId: auth.employeeId };
    }

    const where: Prisma.PerformancePlanWhereInput = {
      ...scope,
      cycleId: q.cycleId,
      status: q.status,
      departmentId: q.departmentId,
      ...(q.search ? { OR: [{ employeeCodeSnapshot: { contains: q.search, mode: 'insensitive' } }, { employeeNameSnapshot: { contains: q.search, mode: 'insensitive' } }] } : {}),
    };
    const [total, rows] = await prisma.$transaction([
      prisma.performancePlan.count({ where }),
      prisma.performancePlan.findMany({ where, include: planInclude, orderBy: [{ cycle: { periodStart: 'desc' } }, { employeeCodeSnapshot: 'asc' }], skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
    ]);
    return { data: rows.map(toSummaryDto), meta: { page: q.page, pageSize: q.pageSize, total } };
  },

  async get(auth: AuthContext, id: string): Promise<PlanDetailDto> {
    const row = await loadPlan(prisma, id);
    assertCanRead(auth, row);
    return toDetailDto(row);
  },

  /**
   * Reassigning a reviewer — the one way the snapshot changes, and only by an explicit decision. It exists because a
   * manager can leave, or have no account at all, and a plan with nobody able to review it is stuck.
   */
  async update(id: string, input: UpdatePlanInput, actor: Actor): Promise<PlanDetailDto> {
    const row = await prisma.$transaction(async (tx) => {
      const plan = await loadPlan(tx, id);
      if (plan.status === 'FINALIZED' || plan.cycle.status === 'CLOSED') {
        throw new AppError(409, 'PERFORMANCE_PLAN_FINALIZED', 'A finalized plan cannot be changed');
      }
      let data: Prisma.PerformancePlanUpdateInput = {};
      if (input.reviewerEmployeeId !== undefined) {
        if (input.reviewerEmployeeId === null) {
          data = { reviewerEmployee: { disconnect: true }, reviewerUser: { disconnect: true }, reviewerNameSnapshot: null };
        } else {
          const reviewer = await tx.employee.findUnique({
            where: { id: input.reviewerEmployeeId },
            select: { id: true, firstName: true, lastName: true, user: { select: { id: true, isActive: true } } },
          });
          if (!reviewer) throw new AppError(404, 'EMPLOYEE_NOT_FOUND', 'That employee does not exist');
          if (reviewer.id === plan.employeeId) throw new AppError(409, 'PERFORMANCE_REVIEWER_IS_SUBJECT', 'Somebody cannot review their own plan');
          if (!reviewer.user?.isActive) {
            throw new AppError(409, 'PERFORMANCE_REVIEWER_REQUIRED', 'That reviewer has no active account, so they could not open the review');
          }
          data = {
            reviewerEmployee: { connect: { id: reviewer.id } },
            reviewerUser: { connect: { id: reviewer.user.id } },
            reviewerNameSnapshot: `${reviewer.firstName} ${reviewer.lastName}`,
          };
        }
      }
      const updated = await tx.performancePlan.update({ where: { id }, data, include: planInclude });
      await auditService.log(performanceAudit(actor, AUDIT_ACTIONS.UPDATE_PERFORMANCE_PLAN, 'PerformancePlan', id,
        { reviewerEmployeeId: updated.reviewerEmployeeId, reviewerName: updated.reviewerNameSnapshot },
        { reviewerEmployeeId: plan.reviewerEmployeeId, reviewerName: plan.reviewerNameSnapshot }), tx);
      return updated;
    });
    return toDetailDto(row);
  },

  // -------------------------------------------------------------------------
  // structure (HR, before the review starts)
  // -------------------------------------------------------------------------
  async addItem(planId: string, input: AddPlanItemInput, actor: Actor): Promise<PlanDetailDto> {
    const row = await prisma.$transaction(async (tx) => {
      const plan = await loadPlan(tx, planId);
      assertStructureEditable(plan);

      const kpi = input.kpiId ? await kpiService.forPlanItem(tx, input.kpiId) : null;
      await tx.performancePlanItem.create({
        data: {
          planId,
          kpiId: kpi?.id ?? null,
          kpiCodeSnapshot: kpi?.code ?? (input.name ?? 'ITEM').toUpperCase().replace(/[^A-Z0-9]+/g, '_').slice(0, 40),
          kpiNameSnapshot: kpi?.name ?? input.name!,
          descriptionSnapshot: input.description ?? kpi?.description ?? null,
          measurementType: kpi?.measurementType ?? input.measurementType!,
          weight: score(input.weight),
          targetValue: input.targetValue ? score(input.targetValue) : null,
          targetText: input.targetText ?? null,
        },
      });
      await auditService.log(performanceAudit(actor, AUDIT_ACTIONS.UPDATE_PERFORMANCE_PLAN, 'PerformancePlan', planId, {
        addedItem: kpi?.code ?? input.name, weight: input.weight,
      }), tx);
      return loadPlan(tx, planId);
    });
    return toDetailDto(row);
  },

  async updateItem(itemId: string, input: UpdatePlanItemInput, actor: Actor): Promise<PlanDetailDto> {
    const row = await prisma.$transaction(async (tx) => {
      const item = await tx.performancePlanItem.findUnique({ where: { id: itemId }, select: { id: true, planId: true, kpiCodeSnapshot: true, weight: true } });
      if (!item) throw new AppError(404, 'PERFORMANCE_ITEM_NOT_FOUND', 'Plan item not found');
      const plan = await loadPlan(tx, item.planId);
      assertStructureEditable(plan);

      await tx.performancePlanItem.update({
        where: { id: itemId },
        data: {
          weight: input.weight === undefined ? undefined : score(input.weight),
          targetValue: input.targetValue === undefined ? undefined : input.targetValue === null ? null : score(input.targetValue),
          targetText: input.targetText,
          descriptionSnapshot: input.description,
        },
      });
      await auditService.log(performanceAudit(actor, AUDIT_ACTIONS.UPDATE_PERFORMANCE_PLAN, 'PerformancePlan', item.planId,
        { item: item.kpiCodeSnapshot, weight: input.weight }, { weight: toScoreString(item.weight) }), tx);
      return loadPlan(tx, item.planId);
    });
    return toDetailDto(row);
  },

  async removeItem(itemId: string, actor: Actor): Promise<PlanDetailDto> {
    const row = await prisma.$transaction(async (tx) => {
      const item = await tx.performancePlanItem.findUnique({ where: { id: itemId }, select: { id: true, planId: true, kpiCodeSnapshot: true } });
      if (!item) throw new AppError(404, 'PERFORMANCE_ITEM_NOT_FOUND', 'Plan item not found');
      const plan = await loadPlan(tx, item.planId);
      assertStructureEditable(plan);
      await tx.performancePlanItem.delete({ where: { id: itemId } });
      await auditService.log(performanceAudit(actor, AUDIT_ACTIONS.UPDATE_PERFORMANCE_PLAN, 'PerformancePlan', item.planId, { removedItem: item.kpiCodeSnapshot }), tx);
      return loadPlan(tx, item.planId);
    });
    return toDetailDto(row);
  },

  // -------------------------------------------------------------------------
  // the employee's side
  // -------------------------------------------------------------------------
  /** Progress as the period runs: what actually happened, and how far along it is. Not a score. */
  async updateProgress(auth: AuthContext, itemId: string, input: UpdateProgressInput): Promise<PlanDetailDto> {
    const row = await prisma.$transaction(async (tx) => {
      const item = await tx.performancePlanItem.findUnique({ where: { id: itemId }, select: { id: true, planId: true } });
      if (!item) throw new AppError(404, 'PERFORMANCE_ITEM_NOT_FOUND', 'Plan item not found');
      const plan = await loadPlan(tx, item.planId);
      assertIsSubject(auth, plan);
      if (!['ACTIVE', 'SELF_REVIEW'].includes(plan.status)) {
        throw new AppError(409, 'PERFORMANCE_PLAN_NOT_OPEN', `This plan is ${plan.status.toLowerCase().replace('_', ' ')}: progress can no longer be recorded`);
      }
      await tx.performancePlanItem.update({
        where: { id: itemId },
        data: {
          actualValue: input.actualValue === undefined ? undefined : input.actualValue === null ? null : score(input.actualValue),
          actualText: input.actualText,
          progressPercent: input.progressPercent,
          employeeComment: input.employeeComment,
        },
      });
      return loadPlan(tx, item.planId);
    });
    return toDetailDto(row);
  },

  /** The employee's own assessment. Editable until they submit it, and never afterwards. */
  async selfAssess(auth: AuthContext, itemId: string, input: SelfAssessmentInput): Promise<PlanDetailDto> {
    const row = await prisma.$transaction(async (tx) => {
      const item = await tx.performancePlanItem.findUnique({ where: { id: itemId }, select: { id: true, planId: true } });
      if (!item) throw new AppError(404, 'PERFORMANCE_ITEM_NOT_FOUND', 'Plan item not found');
      const plan = await loadPlan(tx, item.planId);
      assertIsSubject(auth, plan);
      if (plan.status !== 'SELF_REVIEW') {
        throw new AppError(409, 'PERFORMANCE_SELF_REVIEW_CLOSED', plan.selfSubmittedAt ? 'Your self review has been submitted and can no longer be changed' : 'The self review is not open for this plan');
      }
      if (input.selfScore !== undefined && input.selfScore !== null) assertScoreOnScale(plan, input.selfScore);
      await tx.performancePlanItem.update({
        where: { id: itemId },
        data: {
          selfScore: input.selfScore === undefined ? undefined : input.selfScore === null ? null : score(input.selfScore),
          employeeComment: input.employeeComment,
        },
      });
      return loadPlan(tx, item.planId);
    });
    return toDetailDto(row);
  },

  /**
   * Submitting the self review. Locked, validated and one-way: every item scored, every score on the scale, and the
   * weights adding up — because the next person to touch this plan is the reviewer, and they should not have to
   * discover it is half-finished.
   */
  async submitSelf(auth: AuthContext, planId: string, actor: Actor): Promise<PlanDetailDto> {
    const row = await prisma.$transaction(async (tx) => {
      await lockPlan(tx, planId);
      const plan = await loadPlan(tx, planId);
      assertIsSubject(auth, plan);
      if (plan.status !== 'SELF_REVIEW') {
        throw new AppError(409, 'PERFORMANCE_SELF_REVIEW_CLOSED', plan.selfSubmittedAt ? 'Your self review has already been submitted' : 'The self review is not open for this plan');
      }
      assertWeightsComplete(plan);
      for (const item of plan.items) {
        if (item.selfScore === null) throw new AppError(422, 'PERFORMANCE_SELF_SCORE_MISSING', `${item.kpiNameSnapshot} has no score yet`);
        assertScoreOnScale(plan, toScoreString(item.selfScore)!);
      }
      if (!plan.reviewerUserId) throw new AppError(409, 'PERFORMANCE_REVIEWER_REQUIRED', 'This plan has no reviewer with an account; ask HR to assign one');

      const updated = await tx.performancePlan.update({ where: { id: planId }, data: { status: 'MANAGER_REVIEW', selfSubmittedAt: new Date() }, include: planInclude });
      // The audit records that comments exist, never a word of them: a review comment is a manager writing about a
      // person, and an audit log is read by people who are not entitled to that text.
      await auditService.log(performanceAudit(actor, AUDIT_ACTIONS.SUBMIT_SELF_REVIEW, 'PerformancePlan', planId, {
        cycle: plan.cycle.code, employee: plan.employeeCodeSnapshot, items: plan.items.length,
        commentedItems: plan.items.filter((i) => !!i.employeeComment).length,
      }), tx);
      await notificationService.publish(
        {
          userId: plan.reviewerUserId,
          type: NOTIFICATION_TYPES.PERFORMANCE_SELF_REVIEW_SUBMITTED,
          source: { module: 'performance', entityType: 'PERFORMANCE_PLAN', entityId: planId },
          data: { planId, cycleId: plan.cycleId },
          dedupeKey: `performance:${planId}:self-submitted`,
        },
        { employeeName: plan.employeeNameSnapshot, cycleName: plan.cycle.name },
        tx,
      );
      await notificationService.publish(
        {
          userId: plan.reviewerUserId,
          type: NOTIFICATION_TYPES.PERFORMANCE_MANAGER_REVIEW_REQUIRED,
          source: { module: 'performance', entityType: 'PERFORMANCE_PLAN', entityId: planId },
          data: { planId, cycleId: plan.cycleId },
          dedupeKey: `performance:${planId}:manager-review-required`,
        },
        { employeeName: plan.employeeNameSnapshot, cycleName: plan.cycle.name },
        tx,
      );
      return updated;
    });
    return toDetailDto(row);
  },

  // -------------------------------------------------------------------------
  // the reviewer's side
  // -------------------------------------------------------------------------
  async managerAssess(auth: AuthContext, itemId: string, input: ManagerAssessmentInput): Promise<PlanDetailDto> {
    const row = await prisma.$transaction(async (tx) => {
      const item = await tx.performancePlanItem.findUnique({ where: { id: itemId }, select: { id: true, planId: true } });
      if (!item) throw new AppError(404, 'PERFORMANCE_ITEM_NOT_FOUND', 'Plan item not found');
      const plan = await loadPlan(tx, item.planId);
      assertIsReviewer(auth, plan);
      if (plan.status !== 'MANAGER_REVIEW') {
        throw new AppError(409, 'PERFORMANCE_MANAGER_REVIEW_CLOSED', plan.status === 'FINALIZED' ? 'This review has been submitted and can no longer be changed' : 'This plan is not waiting for your review');
      }
      if (input.managerScore !== undefined && input.managerScore !== null) assertScoreOnScale(plan, input.managerScore);
      await tx.performancePlanItem.update({
        where: { id: itemId },
        data: {
          managerScore: input.managerScore === undefined ? undefined : input.managerScore === null ? null : score(input.managerScore),
          managerComment: input.managerComment,
        },
      });
      return loadPlan(tx, item.planId);
    });
    return toDetailDto(row);
  },

  /**
   * Submitting the review, which finalizes the plan: the weighted score is calculated here, once, from the manager's
   * scores and the weights, and the rating band is resolved and **snapshotted by label** so renaming a band later
   * does not rewrite what somebody was told.
   */
  async submitManager(auth: AuthContext, planId: string, actor: Actor): Promise<PlanDetailDto> {
    const row = await prisma.$transaction(async (tx) => {
      await lockPlan(tx, planId);
      const plan = await loadPlan(tx, planId);
      assertIsReviewer(auth, plan);
      if (plan.status !== 'MANAGER_REVIEW') {
        throw new AppError(409, 'PERFORMANCE_MANAGER_REVIEW_CLOSED', plan.status === 'FINALIZED' ? 'This review has already been submitted' : 'This plan is not waiting for your review');
      }
      if (plan.cycle.status === 'CLOSED') throw new AppError(409, 'PERFORMANCE_CYCLE_CLOSED', 'This cycle is closed');
      assertWeightsComplete(plan);
      for (const item of plan.items) {
        if (item.managerScore === null) throw new AppError(422, 'PERFORMANCE_MANAGER_SCORE_MISSING', `${item.kpiNameSnapshot} has no score yet`);
        assertScoreOnScale(plan, toScoreString(item.managerScore)!);
      }

      const total = weightedScore(plan.items.map((i) => ({ managerScore: i.managerScore, weight: i.weight })));
      const bands = plan.cycle.ratingBands.map((b) => ({ code: b.code, label: b.label, minScore: toScoreString(b.minScore)!, maxScore: toScoreString(b.maxScore)! }));
      const band = resolveRatingBand(bands, total.toFixed(2));

      // The final score is what the weighted total was actually built from, frozen per item.
      for (const item of plan.items) {
        await tx.performancePlanItem.update({ where: { id: item.id }, data: { finalScore: item.managerScore } });
      }
      const updated = await tx.performancePlan.update({
        where: { id: planId },
        data: {
          status: 'FINALIZED',
          managerSubmittedAt: new Date(),
          finalizedAt: new Date(),
          weightedScore: total,
          ratingCode: band?.code ?? null,
          ratingLabelSnapshot: band?.label ?? null,
        },
        include: planInclude,
      });

      await auditService.log(performanceAudit(actor, AUDIT_ACTIONS.SUBMIT_MANAGER_REVIEW, 'PerformancePlan', planId, {
        cycle: plan.cycle.code, employee: plan.employeeCodeSnapshot, items: plan.items.length,
        commentedItems: plan.items.filter((i) => !!i.managerComment).length,
      }), tx);
      await auditService.log(performanceAudit(actor, AUDIT_ACTIONS.FINALIZE_PERFORMANCE_PLAN, 'PerformancePlan', planId, {
        cycle: plan.cycle.code, employee: plan.employeeCodeSnapshot, weightedScore: total.toFixed(2), rating: band?.code ?? null,
      }), tx);
      await notificationService.publish(
        {
          userId: plan.employee.user?.id ?? null,
          type: NOTIFICATION_TYPES.PERFORMANCE_FINALIZED,
          source: { module: 'performance', entityType: 'PERFORMANCE_PLAN', entityId: planId },
          data: { planId, cycleId: plan.cycleId },
          dedupeKey: `performance:${planId}:finalized`,
        },
        { cycleName: plan.cycle.name },
        tx,
      );
      return updated;
    });
    return toDetailDto(row);
  },
};

// ---------------------------------------------------------------------------
// shared rules
// ---------------------------------------------------------------------------
/** KPI structure, weights and targets are HR's until the review starts; after that they are the record. */
function assertStructureEditable(plan: PlanRow) {
  if (plan.cycle.status === 'CLOSED') throw new AppError(409, 'PERFORMANCE_CYCLE_CLOSED', 'This cycle is closed');
  if (!['DRAFT', 'ACTIVE'].includes(plan.status)) {
    throw new AppError(409, 'PERFORMANCE_PLAN_IN_REVIEW', 'The KPIs, weights and targets are frozen once the review starts');
  }
}

function assertWeightsComplete(plan: PlanRow) {
  if (plan.items.length === 0) throw new AppError(422, 'PERFORMANCE_PLAN_EMPTY', 'This plan has no KPIs');
  const total = sumWeights(plan.items.map((i) => i.weight));
  if (!equals(total, PERFORMANCE_TOTAL_WEIGHT)) {
    throw new AppError(422, 'PERFORMANCE_WEIGHT_INVALID', `The KPI weights add up to ${total.toFixed(2)}%, and they must add up to exactly 100%`);
  }
}

function assertScoreOnScale(plan: PlanRow, value: string) {
  const min = toScoreString(plan.cycle.minScore)!;
  const max = toScoreString(plan.cycle.maxScore)!;
  if (!scoreIsOnScale(value, min, max, plan.cycle.scoreStep)) {
    throw new AppError(422, 'PERFORMANCE_SCORE_OUT_OF_RANGE', `A score must be between ${min} and ${max}, in steps of ${toScoreString(plan.cycle.scoreStep)}`);
  }
}

export { assertCanRead };
