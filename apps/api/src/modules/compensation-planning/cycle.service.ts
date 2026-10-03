import { Prisma } from '@prisma/client';
import {
  AUDIT_ACTIONS, NOTIFICATION_TYPES, compareBusinessDate,
  type CompCycleDto, type CompCycleStatus, type CompEligibility, type CompPopulationPreviewDto, type CompPopulationRowDto, type CreateCompCycleInput, type UpdateCompCycleInput,
} from '@hr/shared';
import { AppError } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { auditService } from '../../services/audit/audit.service';
import { notificationService } from '../../services/notification/notification.service';
import type { AuthContext } from '../auth/auth.types';
import { dec, money, toMoneyString } from '../payroll/money';
import {
  LONG_TX, P, assertStatus, assertWithinBudget, budgetDto, budgetUsed, compAudit, has, lockCycle, notFound, requireHr, today, userHasPermission, userNames,
  type Actor, type Db, type Tx,
} from './comp.types';

/**
 * Salary-review cycles: DRAFT (configure) → ACTIVE (planners enter proposals) → REVIEW (HR) → FINALIZED (frozen) →
 * ARCHIVED. The population is decided once, at activation, from facts only — employed and active in the cycle's
 * organization, not excluded by HR, with an authoritative salary record in the cycle currency — and then frozen.
 * Nothing about performance, potential, age, tenure, discipline or anything else a person is decides inclusion.
 */
type CycleRow = Prisma.CompensationReviewCycleGetPayload<{ include: { budget: true } }>;

async function notifyCycle(tx: Tx, cycle: { id: string; name: string }, userIds: (string | null)[], type: (typeof NOTIFICATION_TYPES)[keyof typeof NOTIFICATION_TYPES], key: string) {
  // The cycle name only: never a salary, an increase, a percentage, a comment or a count.
  for (const userId of [...new Set(userIds.filter((u): u is string => !!u))]) {
    await notificationService.publish(
      { userId, type, source: { module: 'compensation_planning', entityType: 'CompensationReviewCycle', entityId: cycle.id }, data: { cycleId: cycle.id }, dedupeKey: `comp-cycle:${cycle.id}:${key}:${userId}` },
      { cycleName: cycle.name }, tx,
    );
  }
}
export { notifyCycle };

/** Candidates for the population: active employees of the cycle's organization, with the salary record in effect on `asOf`. */
async function resolveCandidates(db: Db, cycle: { id: string; organizationId: string; currency: string }, asOf: string) {
  const [employees, excluded] = await Promise.all([
    db.employee.findMany({
      where: { organizationId: cycle.organizationId, employmentStatus: 'ACTIVE' },
      select: {
        id: true, employeeCode: true, firstName: true, lastName: true, employmentType: true, organizationId: true, departmentId: true, positionId: true, managerId: true,
        department: { select: { name: true } }, position: { select: { title: true, jobId: true, job: { select: { title: true } } } },
        manager: { select: { id: true, firstName: true, lastName: true, user: { select: { id: true, isActive: true } } } },
      },
      orderBy: [{ employeeCode: 'asc' }],
    }),
    db.compensationCycleExclusion.findMany({ where: { cycleId: cycle.id }, select: { employeeId: true } }),
  ]);
  const comps = await db.employeeCompensation.findMany({
    where: { employeeId: { in: employees.map((e) => e.id) }, effectiveFrom: { lte: asOf }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: asOf } }] },
    select: { id: true, employeeId: true, baseSalary: true, currencyCode: true, effectiveFrom: true },
  });
  const compOf = new Map(comps.map((c) => [c.employeeId, c]));
  const excludedIds = new Set(excluded.map((x) => x.employeeId));
  return employees.map((e) => {
    const c = compOf.get(e.id);
    // No salary record (or a zero one) is flagged, never treated as 0; a different currency is flagged, never converted.
    const eligibility: CompEligibility = !c || !dec(c.baseSalary).greaterThan(0) ? 'MISSING_COMPENSATION' : c.currencyCode !== cycle.currency ? 'CURRENCY_MISMATCH' : 'ELIGIBLE';
    return { e, c: c ?? null, eligibility, excluded: excludedIds.has(e.id) };
  });
}

async function cycleDto(db: Db, cycle: CycleRow, auth: AuthContext): Promise<CompCycleDto> {
  const [org, eligibility, statuses, used, sums, planners] = await Promise.all([
    db.organization.findUnique({ where: { id: cycle.organizationId }, select: { id: true, name: true } }),
    db.compensationCycleEmployee.groupBy({ by: ['eligibility'], where: { cycleId: cycle.id }, _count: { _all: true } }),
    db.compensationProposal.groupBy({ by: ['status'], where: { cycleId: cycle.id }, _count: { _all: true } }),
    budgetUsed(db, cycle.id),
    db.compensationProposal.aggregate({ where: { cycleId: cycle.id }, _sum: { currentBaseSalary: true } }),
    db.compensationCycleEmployee.groupBy({ by: ['plannerUserId'], where: { cycleId: cycle.id, eligibility: 'ELIGIBLE' }, _count: { _all: true } }),
  ]);
  const submittedPerPlanner = cycle.status === 'DRAFT' ? [] : await db.$queryRaw<{ planner: string | null; n: bigint }[]>`
    SELECT ce."planner_user_id" AS planner, count(*) AS n FROM "compensation_cycle_employees" ce JOIN "compensation_proposals" p ON p."cycle_employee_id" = ce."id"
    WHERE ce."cycle_id" = ${cycle.id} AND p."status" IN ('SUBMITTED', 'HR_REVIEW', 'APPROVED') GROUP BY ce."planner_user_id"`;
  const names = await userNames(db, planners.map((p) => p.plannerUserId));
  const byElig = (k: string) => eligibility.find((r) => r.eligibility === k)?._count._all ?? 0;
  const bySt = (k: string) => statuses.find((r) => r.status === k)?._count._all ?? 0;
  const current = money(sums._sum.currentBaseSalary ?? 0);
  const activated = cycle.status !== 'DRAFT';
  return {
    id: cycle.id, code: cycle.code, name: cycle.name, organization: org ?? { id: cycle.organizationId, name: cycle.organizationNameSnapshot }, effectiveDate: cycle.effectiveDate, currency: cycle.currency,
    status: cycle.status as CompCycleStatus, showPerformanceContext: cycle.showPerformanceContext,
    activatedAt: cycle.activatedAt?.toISOString() ?? null, reviewStartedAt: cycle.reviewStartedAt?.toISOString() ?? null, finalizedAt: cycle.finalizedAt?.toISOString() ?? null,
    appliedAt: cycle.appliedAt?.toISOString() ?? null, archivedAt: cycle.archivedAt?.toISOString() ?? null,
    population: activated ? { total: byElig('ELIGIBLE') + byElig('MISSING_COMPENSATION') + byElig('CURRENCY_MISMATCH'), eligible: byElig('ELIGIBLE'), missingCompensation: byElig('MISSING_COMPENSATION'), currencyMismatch: byElig('CURRENCY_MISMATCH') } : null,
    progress: activated ? { notStarted: bySt('NOT_STARTED'), draft: bySt('DRAFT'), submitted: bySt('SUBMITTED'), hrReview: bySt('HR_REVIEW'), approved: bySt('APPROVED'), returned: bySt('RETURNED') } : null,
    budget: budgetDto(cycle.budget ? dec(cycle.budget.budgetAmount) : null, used),
    // Organization-level totals for HR; a planner never receives this DTO.
    totals: activated && has(auth, P.COMP_PLAN_REVIEW, P.COMP_PLAN_MANAGE_CYCLES, P.COMP_PLAN_FINALIZE, P.COMP_PLAN_APPLY, P.COMP_PLAN_MANAGE_BUDGET)
      ? { currentBase: toMoneyString(current), proposedBase: toMoneyString(current.plus(used)), increase: toMoneyString(used) } : null,
    planners: planners.map((p) => ({ userId: p.plannerUserId, name: p.plannerUserId ? (names.get(p.plannerUserId) ?? null) : null, rows: p._count._all, submitted: Number(submittedPerPlanner.find((s) => s.planner === p.plannerUserId)?.n ?? 0) }))
      .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '')),
    createdAt: cycle.createdAt.toISOString(),
  };
}

async function load(db: Db, id: string): Promise<CycleRow> {
  const c = await db.compensationReviewCycle.findUnique({ where: { id }, include: { budget: true } });
  if (!c) throw notFound('compensation cycle');
  return c;
}

export const compCycleService = {
  async list(auth: AuthContext, q: { status?: string }) {
    requireHr(auth);
    const rows = await prisma.compensationReviewCycle.findMany({ where: { status: q.status }, include: { budget: true }, orderBy: [{ effectiveDate: 'desc' }, { code: 'asc' }] });
    return Promise.all(rows.map((r) => cycleDto(prisma, r, auth)));
  },
  async get(auth: AuthContext, id: string) { requireHr(auth); return cycleDto(prisma, await load(prisma, id), auth); },

  async create(input: CreateCompCycleInput, actor: Actor) {
    requireHr(actor.auth);
    const org = await prisma.organization.findUnique({ where: { id: input.organizationId }, select: { id: true, name: true } });
    if (!org) throw new AppError(404, 'ORGANIZATION_NOT_FOUND', 'Organization not found');
    const code = input.code.toUpperCase();
    if (await prisma.compensationReviewCycle.findUnique({ where: { code } })) throw new AppError(409, 'COMP_CYCLE_CODE_EXISTS', 'A cycle with this code already exists');
    const row = await prisma.$transaction(async (tx) => {
      const c = await tx.compensationReviewCycle.create({ data: { code, name: input.name, organizationId: org.id, organizationNameSnapshot: org.name, effectiveDate: input.effectiveDate, currency: input.currency, showPerformanceContext: input.showPerformanceContext, createdByUserId: actor.auth.userId }, include: { budget: true } });
      await auditService.log(compAudit(actor, AUDIT_ACTIONS.CREATE_COMPENSATION_CYCLE, 'CompensationReviewCycle', c.id, { code, organizationId: org.id, effectiveDate: c.effectiveDate, currency: c.currency }), tx);
      return c;
    });
    return cycleDto(prisma, row, actor.auth);
  },

  async update(id: string, input: UpdateCompCycleInput, actor: Actor) {
    requireHr(actor.auth);
    const row = await prisma.$transaction(async (tx) => {
      const before = await lockCycle(tx, id);
      assertStatus(before, ['DRAFT'], 'edit');
      if (input.currency && before.budget && input.currency !== before.budget.currency) throw new AppError(409, 'COMP_BUDGET_CURRENCY', 'Remove or re-enter the budget before changing the currency');
      const after = await tx.compensationReviewCycle.update({ where: { id }, data: { name: input.name, effectiveDate: input.effectiveDate, currency: input.currency, showPerformanceContext: input.showPerformanceContext }, include: { budget: true } });
      await auditService.log(compAudit(actor, AUDIT_ACTIONS.UPDATE_COMPENSATION_CYCLE, 'CompensationReviewCycle', id, { fields: Object.keys(input), effectiveDate: after.effectiveDate, currency: after.currency }, { effectiveDate: before.effectiveDate, currency: before.currency }), tx);
      return after;
    });
    return cycleDto(prisma, row, actor.auth);
  },

  /** Who would be in the population if the cycle were activated today, with the facts that decide it. Paged, HR only. */
  async populationPreview(auth: AuthContext, id: string, q: { page: number; pageSize: number; search?: string }): Promise<CompPopulationPreviewDto> {
    requireHr(auth);
    const cycle = await load(prisma, id);
    assertStatus(cycle, ['DRAFT'], 'preview the population of');
    const all = await resolveCandidates(prisma, cycle, today());
    const s = q.search?.toLowerCase();
    const filtered = s ? all.filter(({ e }) => `${e.employeeCode} ${e.firstName} ${e.lastName}`.toLowerCase().includes(s)) : all;
    const rows: CompPopulationRowDto[] = filtered.slice((q.page - 1) * q.pageSize, q.page * q.pageSize).map(({ e, c, eligibility, excluded }) => ({
      employeeId: e.id, code: e.employeeCode, name: `${e.firstName} ${e.lastName}`, department: e.department.name, job: e.position?.job?.title ?? null,
      managerName: e.manager ? `${e.manager.firstName} ${e.manager.lastName}` : null,
      currentBaseSalary: c ? toMoneyString(c.baseSalary) : null, currency: c?.currencyCode ?? null, eligibility, excluded,
    }));
    const inScope = all.filter((x) => !x.excluded);
    return {
      rows, meta: { page: q.page, pageSize: q.pageSize, total: filtered.length },
      counts: { candidates: all.length, excluded: all.length - inScope.length, eligible: inScope.filter((x) => x.eligibility === 'ELIGIBLE').length, missingCompensation: inScope.filter((x) => x.eligibility === 'MISSING_COMPENSATION').length, currencyMismatch: inScope.filter((x) => x.eligibility === 'CURRENCY_MISMATCH').length },
    };
  },

  async setExclusion(id: string, input: { employeeId: string; excluded: boolean }, actor: Actor) {
    requireHr(actor.auth);
    await prisma.$transaction(async (tx) => {
      const cycle = await lockCycle(tx, id);
      assertStatus(cycle, ['DRAFT'], 'change the population of');
      const emp = await tx.employee.findUnique({ where: { id: input.employeeId }, select: { organizationId: true } });
      if (!emp || emp.organizationId !== cycle.organizationId) throw new AppError(404, 'EMPLOYEE_NOT_FOUND', 'Employee not found in this cycle\'s organization');
      if (input.excluded) await tx.compensationCycleExclusion.upsert({ where: { cycleId_employeeId: { cycleId: id, employeeId: input.employeeId } }, create: { cycleId: id, employeeId: input.employeeId, createdByUserId: actor.auth.userId }, update: {} });
      else await tx.compensationCycleExclusion.deleteMany({ where: { cycleId: id, employeeId: input.employeeId } });
      await auditService.log(compAudit(actor, AUDIT_ACTIONS.SET_COMPENSATION_CYCLE_EXCLUSION, 'CompensationReviewCycle', id, { employeeId: input.employeeId, excluded: input.excluded }), tx);
    });
    return { ok: true };
  },

  /** The organization pool: a ceiling on Σ(proposed − current). It reserves nothing and commits no payroll money. */
  async setBudget(id: string, input: { budgetAmount: string }, actor: Actor) {
    requireHr(actor.auth);
    const row = await prisma.$transaction(async (tx) => {
      const cycle = await lockCycle(tx, id);
      assertStatus(cycle, ['DRAFT', 'ACTIVE', 'REVIEW'], 'set the budget of');
      const amount = money(input.budgetAmount);
      const existed = !!cycle.budget;
      await tx.compensationBudgetPool.upsert({
        where: { cycleId: id },
        create: { cycleId: id, organizationId: cycle.organizationId, budgetAmount: amount, currency: cycle.currency, createdByUserId: actor.auth.userId },
        update: { budgetAmount: amount, currency: cycle.currency },
      });
      // The budget is an aggregate ceiling, not anyone's salary, so the audit records it.
      await auditService.log(compAudit(actor, existed ? AUDIT_ACTIONS.UPDATE_COMPENSATION_BUDGET : AUDIT_ACTIONS.CREATE_COMPENSATION_BUDGET, 'CompensationReviewCycle', id,
        { budgetAmount: toMoneyString(amount), currency: cycle.currency }, existed ? { budgetAmount: toMoneyString(cycle.budget!.budgetAmount) } : undefined), tx);
      return tx.compensationReviewCycle.findUniqueOrThrow({ where: { id }, include: { budget: true } });
    });
    return cycleDto(prisma, row, actor.auth);
  },

  /**
   * Activation, in one transaction under the cycle's row lock: freeze the population and each person's salary record,
   * department, job, position and manager as of today; the planner is the manager's active user account (HR can
   * reassign); a proposal row is opened (NOT_STARTED, no value) for every plannable person. A second concurrent
   * activation waits on the lock and then finds the cycle ACTIVE — and the unique (cycle, employee) key forbids
   * duplicates regardless.
   */
  async activate(id: string, actor: Actor) {
    requireHr(actor.auth);
    const asOf = today();
    const result = await prisma.$transaction(async (tx) => {
      const cycle = await lockCycle(tx, id);
      assertStatus(cycle, ['DRAFT'], 'activate');
      if (compareBusinessDate(cycle.effectiveDate, asOf) <= 0) throw new AppError(409, 'COMP_EFFECTIVE_DATE_PAST', 'The effective date must be after today: salaries are planned for a future date');
      if (cycle.budget && cycle.budget.currency !== cycle.currency) throw new AppError(409, 'COMP_BUDGET_CURRENCY', 'The budget currency does not match the cycle');
      const candidates = (await resolveCandidates(tx, cycle, asOf)).filter((x) => !x.excluded);
      if (!candidates.some((x) => x.eligibility === 'ELIGIBLE')) throw new AppError(409, 'COMP_POPULATION_EMPTY', 'No active employee of this organization has a salary record in the cycle currency');
      await tx.compensationCycleEmployee.createMany({
        skipDuplicates: true,
        data: candidates.map(({ e, c, eligibility }) => ({
          cycleId: id, employeeId: e.id, employeeCodeSnapshot: e.employeeCode, employeeNameSnapshot: `${e.firstName} ${e.lastName}`,
          organizationIdSnapshot: e.organizationId, departmentIdSnapshot: e.departmentId, departmentNameSnapshot: e.department.name,
          jobIdSnapshot: e.position?.jobId ?? null, jobTitleSnapshot: e.position?.job?.title ?? null, positionIdSnapshot: e.positionId,
          managerEmployeeIdSnapshot: e.managerId, managerNameSnapshot: e.manager ? `${e.manager.firstName} ${e.manager.lastName}` : null,
          employmentTypeSnapshot: e.employmentType, eligibility,
          sourceCompensationId: c?.id ?? null, currentBaseSalarySnapshot: c ? money(c.baseSalary) : null, currencySnapshot: c?.currencyCode ?? null, compensationEffectiveFromSnapshot: c?.effectiveFrom ?? null,
          plannerUserId: eligibility === 'ELIGIBLE' && e.manager?.user?.isActive ? e.manager.user.id : null,
        })),
      });
      const rows = await tx.compensationCycleEmployee.findMany({ where: { cycleId: id, eligibility: 'ELIGIBLE' }, select: { id: true, currentBaseSalarySnapshot: true, plannerUserId: true } });
      await tx.compensationProposal.createMany({ skipDuplicates: true, data: rows.map((r) => ({ cycleEmployeeId: r.id, cycleId: id, currentBaseSalary: r.currentBaseSalarySnapshot!, status: 'NOT_STARTED' })) });
      const after = await tx.compensationReviewCycle.update({ where: { id }, data: { status: 'ACTIVE', activatedAt: new Date(), baselineDate: asOf }, include: { budget: true } });
      const notPlannable = candidates.length - rows.length;
      await auditService.log(compAudit(actor, AUDIT_ACTIONS.ACTIVATE_COMPENSATION_CYCLE, 'CompensationReviewCycle', id,
        { population: candidates.length, plannable: rows.length, notPlannable, withoutPlanner: rows.filter((r) => !r.plannerUserId).length, baselineDate: asOf, currency: cycle.currency }), tx);
      await notifyCycle(tx, after, rows.map((r) => r.plannerUserId), NOTIFICATION_TYPES.COMP_PLAN_CYCLE_OPENED, 'opened');
      return after;
    }, LONG_TX);
    return cycleDto(prisma, result, actor.auth);
  },

  /** ACTIVE → REVIEW once every plannable row has been submitted; submitted proposals move to HR_REVIEW. */
  async startReview(id: string, actor: Actor) {
    requireHr(actor.auth);
    const row = await prisma.$transaction(async (tx) => {
      const cycle = await lockCycle(tx, id);
      assertStatus(cycle, ['ACTIVE'], 'start the review of');
      const outstanding = await tx.compensationProposal.count({ where: { cycleId: id, status: { in: ['NOT_STARTED', 'DRAFT', 'RETURNED'] } } });
      if (outstanding) throw new AppError(409, 'COMP_PLANS_OUTSTANDING', `${outstanding} proposal(s) have not been submitted yet`);
      const moved = await tx.compensationProposal.updateMany({ where: { cycleId: id, status: 'SUBMITTED' }, data: { status: 'HR_REVIEW' } });
      const after = await tx.compensationReviewCycle.update({ where: { id }, data: { status: 'REVIEW', reviewStartedAt: new Date() }, include: { budget: true } });
      await auditService.log(compAudit(actor, AUDIT_ACTIONS.START_COMPENSATION_REVIEW, 'CompensationReviewCycle', id, { proposals: moved.count }), tx);
      return after;
    });
    return cycleDto(prisma, row, actor.auth);
  },

  /**
   * Finalize: under the cycle lock, every plannable proposal must be APPROVED and Σ increase within the budget. The
   * plan is then frozen (no service edits a FINALIZED cycle). No salary record is touched — that is Apply.
   */
  async finalize(id: string, actor: Actor) {
    requireHr(actor.auth);
    const row = await prisma.$transaction(async (tx) => {
      const cycle = await lockCycle(tx, id);
      assertStatus(cycle, ['REVIEW'], 'finalize');
      const notApproved = await tx.compensationProposal.count({ where: { cycleId: id, status: { not: 'APPROVED' } } });
      if (notApproved) throw new AppError(409, 'COMP_PROPOSALS_NOT_APPROVED', `${notApproved} proposal(s) are not approved yet`);
      await assertWithinBudget(tx, id, cycle.budget ? dec(cycle.budget.budgetAmount) : null);
      const after = await tx.compensationReviewCycle.update({ where: { id }, data: { status: 'FINALIZED', finalizedAt: new Date(), finalizedByUserId: actor.auth.userId }, include: { budget: true } });
      const approved = await tx.compensationProposal.count({ where: { cycleId: id } });
      await auditService.log(compAudit(actor, AUDIT_ACTIONS.FINALIZE_COMPENSATION_CYCLE, 'CompensationReviewCycle', id, { approved, currency: cycle.currency }), tx);
      const planners = await tx.compensationCycleEmployee.findMany({ where: { cycleId: id, plannerUserId: { not: null } }, select: { plannerUserId: true }, distinct: ['plannerUserId'] });
      await notifyCycle(tx, after, [cycle.createdByUserId, ...planners.map((p) => p.plannerUserId)], NOTIFICATION_TYPES.COMP_PLAN_FINALIZED, 'finalized');
      return after;
    });
    return cycleDto(prisma, row, actor.auth);
  },

  /** DRAFT (abandon) or FINALIZED (history) → ARCHIVED. An archived cycle can no longer be applied. */
  async archive(id: string, actor: Actor) {
    requireHr(actor.auth);
    const row = await prisma.$transaction(async (tx) => {
      const cycle = await lockCycle(tx, id);
      assertStatus(cycle, ['DRAFT', 'FINALIZED'], 'archive');
      const after = await tx.compensationReviewCycle.update({ where: { id }, data: { status: 'ARCHIVED', archivedAt: new Date() }, include: { budget: true } });
      await auditService.log(compAudit(actor, AUDIT_ACTIONS.ARCHIVE_COMPENSATION_CYCLE, 'CompensationReviewCycle', id, { from: cycle.status, applied: !!cycle.appliedAt }), tx);
      return after;
    });
    return cycleDto(prisma, row, actor.auth);
  },

  /**
   * HR reassigns the planner of one row (the activation snapshot never rewrites itself when a manager changes). The
   * new planner must be an active user holding compensation_planning.plan. Recorded append-only.
   */
  async reassignPlanner(cycleEmployeeId: string, input: { plannerUserId: string | null; reasonCode: string }, actor: Actor) {
    requireHr(actor.auth);
    if (!has(actor.auth, P.COMP_PLAN_MANAGE_CYCLES)) throw AppError.forbidden();
    await prisma.$transaction(async (tx) => {
      const row = await tx.compensationCycleEmployee.findUnique({ where: { id: cycleEmployeeId }, select: { id: true, cycleId: true, plannerUserId: true, eligibility: true, employeeId: true } });
      if (!row) throw notFound('cycle employee');
      const cycle = await lockCycle(tx, row.cycleId);
      assertStatus(cycle, ['ACTIVE', 'REVIEW'], 'reassign a planner in');
      if (row.eligibility !== 'ELIGIBLE') throw new AppError(409, 'COMP_ROW_NOT_PLANNABLE', 'This person cannot be planned in this cycle');
      if (input.plannerUserId && !(await userHasPermission(tx, input.plannerUserId, P.COMP_PLAN_PLAN))) throw new AppError(422, 'COMP_PLANNER_NOT_ALLOWED', 'The planner must be an active user with compensation_planning.plan');
      // Task 51 (T44-P1-19): nobody plans their own salary.
      if (input.plannerUserId && (await tx.user.findUnique({ where: { id: input.plannerUserId }, select: { employeeId: true } }))?.employeeId === row.employeeId) {
        throw new AppError(409, 'COMP_PLANNER_SELF_ROW', 'A planner cannot be assigned to plan their own salary');
      }
      await tx.compensationCycleEmployee.update({ where: { id: row.id }, data: { plannerUserId: input.plannerUserId } });
      await tx.compensationPlannerAssignment.create({ data: { cycleEmployeeId: row.id, fromUserId: row.plannerUserId, toUserId: input.plannerUserId, reasonCode: input.reasonCode, actorUserId: actor.auth.userId } });
      await auditService.log(compAudit(actor, AUDIT_ACTIONS.ASSIGN_COMPENSATION_PLANNER, 'CompensationCycleEmployee', row.id, { employeeId: row.employeeId, toUserId: input.plannerUserId, reasonCode: input.reasonCode }, { fromUserId: row.plannerUserId }), tx);
      if (input.plannerUserId) await notifyCycle(tx, cycle, [input.plannerUserId], NOTIFICATION_TYPES.COMP_PLAN_CYCLE_OPENED, `assigned-${row.id}`);
    });
    return { ok: true };
  },

  /** Active users who may plan, for the reassignment picker. Names only. */
  async plannerOptions(auth: AuthContext) {
    requireHr(auth);
    const users = await prisma.user.findMany({
      where: { isActive: true, userRoles: { some: { role: { rolePermissions: { some: { permission: { code: P.COMP_PLAN_PLAN } } } } } } },
      select: { id: true, email: true, employee: { select: { firstName: true, lastName: true } } }, orderBy: { email: 'asc' }, take: 500,
    });
    return users.map((u) => ({ userId: u.id, name: u.employee ? `${u.employee.firstName} ${u.employee.lastName}` : u.email }));
  },
};
