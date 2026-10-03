import { Prisma } from '@prisma/client';
import { AUDIT_ACTIONS, NOTIFICATION_TYPES, type CompCycleEmployeesQuery, type CompCycleStatus, type CompHistoryDto, type CompMyPlanDto, type UpdateCompProposalInput } from '@hr/shared';
import { AppError } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { auditService } from '../../services/audit/audit.service';
import type { AuthContext } from '../auth/auth.types';
import { dec, money, toMoneyString } from '../payroll/money';
import {
  P, assertStatus, assertWithinBudget, compAudit, derive, has, hrScope, lockCycle, m, notFound, performanceContext, plannerCapable, requireHr, rowDto, rowInclude, userNames,
  type Actor, type Db, type RowWithProposal, type Tx,
} from './comp.types';
import { notifyCycle } from './cycle.service';
import { assertNotSelfFinancial, isSelf, makerCheckerConflict } from '../../services/authorization/self-dealing';

/**
 * Proposals. A planner enters one number per person — the proposed base salary — for the rows assigned to them;
 * the increase and percentage are derived server-side. There is no suggested value, no default increase, no merit
 * matrix and no ordering by anything but neutral columns. Every change is appended to the proposal's history.
 */
const EDITABLE_ACTIVE = ['NOT_STARTED', 'DRAFT', 'RETURNED'];
const PLANNER_OPEN_CYCLES = ['ACTIVE', 'REVIEW', 'FINALIZED'];

async function history(tx: Tx, proposalId: string, action: string, actorUserId: string, oldV: Prisma.Decimal | null, newV: Prisma.Decimal | null, reasonCode?: string | null) {
  await tx.compensationProposalHistory.create({ data: { proposalId, action, actorUserId, oldProposedBaseSalary: oldV, newProposedBaseSalary: newV, reasonCode: reasonCode ?? null } });
}

/** A proposal the caller may act on as planner, or 404 — another planner's row is indistinguishable from none. */
async function plannerProposal(tx: Tx, auth: AuthContext, proposalId: string) {
  const p = await tx.compensationProposal.findUnique({ where: { id: proposalId }, include: { cycleEmployee: true } });
  if (!p || p.cycleEmployee.plannerUserId !== auth.userId || !plannerCapable(auth)) throw notFound('compensation proposal');
  assertNotSelfFinancial(auth, p.cycleEmployee.employeeId, 'plan a salary'); // Task 51 (T44-P1-19)
  return p;
}
async function hrProposal(tx: Tx, auth: AuthContext, proposalId: string) {
  requireHr(auth);
  if (!has(auth, P.COMP_PLAN_REVIEW)) throw AppError.forbidden();
  const p = await tx.compensationProposal.findUnique({ where: { id: proposalId }, include: { cycleEmployee: true } });
  if (!p) throw notFound('compensation proposal');
  // Task 51: HR never overrides, approves or returns a proposal about themselves.
  assertNotSelfFinancial(auth, p.cycleEmployee.employeeId, 'review a salary proposal');
  return p;
}

/** Task 51: who last SET the proposed amount (planner save or HR override) — server-owned history, never the client. */
async function lastAmountAuthors(tx: Tx, proposalIds: string[]): Promise<Map<string, string>> {
  const rows = await tx.compensationProposalHistory.findMany({ where: { proposalId: { in: proposalIds }, action: { in: ['SAVED', 'OVERRIDDEN'] } }, orderBy: { createdAt: 'asc' }, select: { proposalId: true, actorUserId: true } });
  const out = new Map<string, string>();
  for (const r of rows) out.set(r.proposalId, r.actorUserId); // ascending → the last one wins
  return out;
}

function validateProposed(current: Prisma.Decimal, proposedRaw: string) {
  const proposed = money(proposedRaw);
  // V1 plans increases or no change only: a salary reduction is a different process and is refused here.
  if (proposed.lessThan(current)) throw new AppError(422, 'COMP_DECREASE_NOT_ALLOWED', 'The proposed salary cannot be lower than the current salary in a salary review');
  return proposed;
}

async function rowsToDtos(db: Db, auth: AuthContext, cycle: { showPerformanceContext: boolean }, rows: RowWithProposal[], asPlanner: boolean) {
  const names = await userNames(db, rows.map((r) => r.plannerUserId));
  const perf = cycle.showPerformanceContext && has(auth, P.PERFORMANCE_VIEW) ? await performanceContext(db, rows.map((r) => r.employeeId)) : new Map();
  return rows.map((r) => rowDto(r, {
    plannerName: r.plannerUserId ? (names.get(r.plannerUserId) ?? null) : null,
    showComment: asPlanner ? r.plannerUserId === auth.userId : true,
    performance: perf.get(r.employeeId) ?? null,
  }));
}

export const compProposalService = {
  /** Cycles where the caller is a planner (open or finalized, read-only once finalized). */
  async myCycles(auth: AuthContext) {
    if (!plannerCapable(auth)) return [];
    const rows = await prisma.compensationCycleEmployee.groupBy({ by: ['cycleId'], where: { plannerUserId: auth.userId, cycle: { status: { in: PLANNER_OPEN_CYCLES } } }, _count: { _all: true } });
    const cycles = await prisma.compensationReviewCycle.findMany({ where: { id: { in: rows.map((r) => r.cycleId) } }, select: { id: true, code: true, name: true, status: true, effectiveDate: true, currency: true }, orderBy: { effectiveDate: 'desc' } });
    return cycles.map((c) => ({ ...c, status: c.status as CompCycleStatus, rows: rows.find((r) => r.cycleId === c.id)?._count._all ?? 0 }));
  },

  /** The planner's sheet: only their rows, their group's totals, and nothing about anyone else. */
  async myPlan(auth: AuthContext, cycleId: string): Promise<CompMyPlanDto> {
    if (!plannerCapable(auth)) throw notFound('compensation cycle');
    const cycle = await prisma.compensationReviewCycle.findUnique({ where: { id: cycleId } });
    if (!cycle || !PLANNER_OPEN_CYCLES.includes(cycle.status)) throw notFound('compensation cycle');
    const rows = await prisma.compensationCycleEmployee.findMany({ where: { cycleId, plannerUserId: auth.userId }, include: rowInclude, orderBy: [{ departmentNameSnapshot: 'asc' }, { employeeNameSnapshot: 'asc' }] });
    if (!rows.length) throw notFound('compensation cycle');
    const dtos = await rowsToDtos(prisma, auth, cycle, rows, true);
    const props = rows.map((r) => r.proposal).filter((p): p is NonNullable<typeof p> => !!p);
    const current = money(props.reduce((a, p) => a.plus(p.currentBaseSalary), new Prisma.Decimal(0)));
    const increase = money(props.reduce((a, p) => a.plus(p.increaseAmount ?? 0), new Prisma.Decimal(0)));
    const canEdit = has(auth, P.COMP_PLAN_PLAN) && (cycle.status === 'ACTIVE' ? props.some((p) => EDITABLE_ACTIVE.includes(p.status)) : cycle.status === 'REVIEW' && props.some((p) => p.status === 'RETURNED'));
    return {
      cycle: { id: cycle.id, code: cycle.code, name: cycle.name, effectiveDate: cycle.effectiveDate, currency: cycle.currency, status: cycle.status as CompCycleStatus },
      rows: dtos,
      totals: { currentBase: toMoneyString(current), proposedBase: toMoneyString(current.plus(increase)), increase: toMoneyString(increase), rows: props.length, addressed: props.filter((p) => p.proposedBaseSalary !== null).length, submitted: props.filter((p) => ['SUBMITTED', 'HR_REVIEW', 'APPROVED'].includes(p.status)).length },
      canEdit, canSubmit: canEdit,
    };
  },

  /** Planner saves one row. ACTIVE: any row not yet submitted; REVIEW: only rows HR returned. */
  async update(proposalId: string, input: UpdateCompProposalInput, actor: Actor) {
    if (!has(actor.auth, P.COMP_PLAN_PLAN)) throw AppError.forbidden();
    const row = await prisma.$transaction(async (tx) => {
      const p = await plannerProposal(tx, actor.auth, proposalId);
      const cycle = await lockCycle(tx, p.cycleId);
      const editable = cycle.status === 'ACTIVE' ? EDITABLE_ACTIVE.includes(p.status) : cycle.status === 'REVIEW' && p.status === 'RETURNED';
      if (!editable) throw new AppError(409, 'COMP_PROPOSAL_LOCKED', 'This proposal cannot be edited now');
      const proposed = validateProposed(dec(p.currentBaseSalary), input.proposedBaseSalary);
      const { increase, percent } = derive(dec(p.currentBaseSalary), proposed);
      const comment = input.managerComment === undefined ? p.managerComment : input.managerComment || null;
      // In ACTIVE a saved row is a draft; in REVIEW a returned row stays RETURNED until the planner resubmits it.
      const nextStatus = cycle.status === 'ACTIVE' ? 'DRAFT' : 'RETURNED';
      const after = await tx.compensationProposal.update({ where: { id: p.id }, data: { proposedBaseSalary: proposed, increaseAmount: increase, increasePercent: percent, managerComment: comment, status: nextStatus } });
      if (!p.proposedBaseSalary || !dec(p.proposedBaseSalary).equals(proposed)) await history(tx, p.id, 'SAVED', actor.auth.userId, p.proposedBaseSalary, proposed);
      await auditService.log(compAudit(actor, AUDIT_ACTIONS.UPDATE_COMPENSATION_PROPOSAL, 'CompensationProposal', p.id,
        { cycleId: p.cycleId, employeeId: p.cycleEmployee.employeeId, status: nextStatus, ...(comment !== p.managerComment ? { commentChanged: true, commentLength: comment?.length ?? 0 } : {}) }, { status: p.status }), tx);
      return after;
    });
    return { id: row.id, status: row.status, proposedBaseSalary: m(row.proposedBaseSalary), increaseAmount: m(row.increaseAmount), increasePercent: row.increasePercent ? dec(row.increasePercent).toFixed(2) : null };
  },

  /**
   * Submit the caller's plan for a cycle: every row they plan must carry a value (zero increase is a value), and the
   * cycle's Σ increase must stay within the budget. After submission the planner cannot edit until HR returns a row.
   */
  async submit(cycleId: string, actor: Actor) {
    if (!has(actor.auth, P.COMP_PLAN_PLAN)) throw AppError.forbidden();
    return prisma.$transaction(async (tx) => {
      const cycle = await lockCycle(tx, cycleId);
      const mine = await tx.compensationProposal.findMany({ where: { cycleId, cycleEmployee: { plannerUserId: actor.auth.userId } }, include: { cycleEmployee: { select: { employeeId: true } } } });
      if (!mine.length) throw notFound('compensation cycle');
      for (const p of mine) assertNotSelfFinancial(actor.auth, p.cycleEmployee.employeeId, 'submit a salary plan'); // Task 51 (legacy assignment)
      assertStatus(cycle, ['ACTIVE', 'REVIEW'], 'submit a plan in');
      const open = mine.filter((p) => (cycle.status === 'ACTIVE' ? EDITABLE_ACTIVE.includes(p.status) : p.status === 'RETURNED'));
      if (!open.length) throw new AppError(409, 'COMP_NOTHING_TO_SUBMIT', 'There is nothing to submit');
      const missing = open.filter((p) => p.proposedBaseSalary === null).length;
      if (missing) throw new AppError(409, 'COMP_PLAN_INCOMPLETE', `${missing} row(s) have no proposed salary yet (enter the current salary for no change)`);
      await assertWithinBudget(tx, cycleId, cycle.budget ? dec(cycle.budget.budgetAmount) : null);
      const next = cycle.status === 'ACTIVE' ? 'SUBMITTED' : 'HR_REVIEW';
      const now = new Date();
      await tx.compensationProposal.updateMany({ where: { id: { in: open.map((p) => p.id) } }, data: { status: next, submittedAt: now, submittedByUserId: actor.auth.userId, returnReasonCode: null } });
      await tx.compensationProposalHistory.createMany({ data: open.map((p) => ({ proposalId: p.id, action: 'SUBMITTED', actorUserId: actor.auth.userId, newProposedBaseSalary: p.proposedBaseSalary })) });
      await auditService.log(compAudit(actor, AUDIT_ACTIONS.SUBMIT_COMPENSATION_PLAN, 'CompensationReviewCycle', cycleId, { proposals: open.length, status: next }), tx);
      await notifyCycle(tx, cycle, [cycle.createdByUserId], NOTIFICATION_TYPES.COMP_PLAN_MANAGER_SUBMITTED, `submitted-${actor.auth.userId}-${now.getTime()}`);
      const outstanding = await tx.compensationProposal.count({ where: { cycleId, status: { in: ['NOT_STARTED', 'DRAFT', 'RETURNED'] } } });
      if (!outstanding && cycle.status === 'ACTIVE') await notifyCycle(tx, cycle, [cycle.createdByUserId], NOTIFICATION_TYPES.COMP_PLAN_READY_FOR_REVIEW, 'ready');
      return { submitted: open.length, status: next };
    });
  },

  /** HR's grid: every row of the cycle, filterable and paged, ordered by neutral columns only (department, name). */
  async hrRows(auth: AuthContext, cycleId: string, q: CompCycleEmployeesQuery) {
    requireHr(auth);
    const cycle = await prisma.compensationReviewCycle.findUnique({ where: { id: cycleId } });
    if (!cycle) throw notFound('compensation cycle');
    const where: Prisma.CompensationCycleEmployeeWhereInput = {
      cycleId, departmentIdSnapshot: q.departmentId, plannerUserId: q.plannerUserId, eligibility: q.eligibility,
      ...(q.status ? { proposal: { status: q.status } } : {}),
      ...(q.search ? { OR: [{ employeeCodeSnapshot: { contains: q.search, mode: 'insensitive' } }, { employeeNameSnapshot: { contains: q.search, mode: 'insensitive' } }] } : {}),
    };
    const [total, rows] = await prisma.$transaction([
      prisma.compensationCycleEmployee.count({ where }),
      prisma.compensationCycleEmployee.findMany({ where, include: rowInclude, orderBy: [{ departmentNameSnapshot: 'asc' }, { employeeNameSnapshot: 'asc' }, { id: 'asc' }], skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
    ]);
    return { data: await rowsToDtos(prisma, auth, cycle, rows, false), meta: { page: q.page, pageSize: q.pageSize, total } };
  },

  async returnToPlanner(proposalId: string, input: { reasonCode: string }, actor: Actor) {
    return prisma.$transaction(async (tx) => {
      const p = await hrProposal(tx, actor.auth, proposalId);
      const cycle = await lockCycle(tx, p.cycleId);
      assertStatus(cycle, ['ACTIVE', 'REVIEW'], 'return a proposal in');
      if (!['SUBMITTED', 'HR_REVIEW', 'APPROVED'].includes(p.status)) throw new AppError(409, 'COMP_PROPOSAL_INVALID_STATE', 'Only a submitted proposal can be returned');
      if (!p.cycleEmployee.plannerUserId) throw new AppError(409, 'COMP_NO_PLANNER', 'Assign a planner before returning this proposal');
      await tx.compensationProposal.update({ where: { id: p.id }, data: { status: 'RETURNED', returnedAt: new Date(), returnReasonCode: input.reasonCode, approvedAt: null, approvedByUserId: null } });
      await history(tx, p.id, 'RETURNED', actor.auth.userId, p.proposedBaseSalary, p.proposedBaseSalary, input.reasonCode);
      await auditService.log(compAudit(actor, AUDIT_ACTIONS.RETURN_COMPENSATION_PROPOSAL, 'CompensationProposal', p.id, { cycleId: p.cycleId, employeeId: p.cycleEmployee.employeeId, reasonCode: input.reasonCode, status: 'RETURNED' }, { status: p.status }), tx);
      await notifyCycle(tx, cycle, [p.cycleEmployee.plannerUserId], NOTIFICATION_TYPES.COMP_PLAN_RETURNED, `returned-${p.id}-${Date.now()}`);
      return { status: 'RETURNED' };
    });
  },

  /** HR changes the proposed salary. Never silent: old and new values, actor and reason code go to the history. */
  async override(proposalId: string, input: { proposedBaseSalary: string; reasonCode: string }, actor: Actor) {
    return prisma.$transaction(async (tx) => {
      const p = await hrProposal(tx, actor.auth, proposalId);
      const cycle = await lockCycle(tx, p.cycleId);
      assertStatus(cycle, ['REVIEW'], 'change a proposal in');
      if (!['HR_REVIEW', 'APPROVED'].includes(p.status)) throw new AppError(409, 'COMP_PROPOSAL_INVALID_STATE', 'Only a proposal under HR review can be changed by HR');
      const proposed = validateProposed(dec(p.currentBaseSalary), input.proposedBaseSalary);
      const { increase, percent } = derive(dec(p.currentBaseSalary), proposed);
      await tx.compensationProposal.update({ where: { id: p.id }, data: { proposedBaseSalary: proposed, increaseAmount: increase, increasePercent: percent, status: 'HR_REVIEW', approvedAt: null, approvedByUserId: null } });
      await assertWithinBudget(tx, p.cycleId, cycle.budget ? dec(cycle.budget.budgetAmount) : null);
      await history(tx, p.id, 'OVERRIDDEN', actor.auth.userId, p.proposedBaseSalary, proposed, input.reasonCode);
      await auditService.log(compAudit(actor, AUDIT_ACTIONS.OVERRIDE_COMPENSATION_PROPOSAL, 'CompensationProposal', p.id, { cycleId: p.cycleId, employeeId: p.cycleEmployee.employeeId, reasonCode: input.reasonCode, status: 'HR_REVIEW' }, { status: p.status }), tx);
      return { status: 'HR_REVIEW', proposedBaseSalary: toMoneyString(proposed), increaseAmount: toMoneyString(increase), increasePercent: percent ? percent.toFixed(2) : null };
    });
  },

  async approve(proposalId: string, actor: Actor) {
    return prisma.$transaction(async (tx) => {
      const p = await hrProposal(tx, actor.auth, proposalId);
      const cycle = await lockCycle(tx, p.cycleId);
      assertStatus(cycle, ['REVIEW'], 'approve a proposal in');
      if (p.status !== 'HR_REVIEW') throw new AppError(409, 'COMP_PROPOSAL_INVALID_STATE', 'Only a proposal under HR review can be approved');
      // Task 51: maker ≠ checker — the person who last set this amount (as planner or by override) does not approve it.
      if ((await lastAmountAuthors(tx, [p.id])).get(p.id) === actor.auth.userId) throw makerCheckerConflict('proposed salary');
      await tx.compensationProposal.update({ where: { id: p.id }, data: { status: 'APPROVED', approvedAt: new Date(), approvedByUserId: actor.auth.userId } });
      await history(tx, p.id, 'APPROVED', actor.auth.userId, p.proposedBaseSalary, p.proposedBaseSalary);
      await auditService.log(compAudit(actor, AUDIT_ACTIONS.APPROVE_COMPENSATION_PROPOSAL, 'CompensationProposal', p.id, { cycleId: p.cycleId, employeeId: p.cycleEmployee.employeeId, status: 'APPROVED' }, { status: p.status }), tx);
      return { status: 'APPROVED' };
    });
  },

  /** Approve every proposal under HR review (optionally one planner's or one department's) — one audit event with the count. */
  async approveMany(cycleId: string, f: { plannerUserId?: string; departmentId?: string }, actor: Actor) {
    requireHr(actor.auth);
    if (!has(actor.auth, P.COMP_PLAN_REVIEW)) throw AppError.forbidden();
    return prisma.$transaction(async (tx) => {
      const cycle = await lockCycle(tx, cycleId);
      assertStatus(cycle, ['REVIEW'], 'approve proposals in');
      const candidates = await tx.compensationProposal.findMany({ where: { cycleId, status: 'HR_REVIEW', cycleEmployee: { plannerUserId: f.plannerUserId, departmentIdSnapshot: f.departmentId } }, select: { id: true, proposedBaseSalary: true, cycleEmployee: { select: { employeeId: true } } } });
      // Task 51: rows about the reviewer, and rows whose amount the reviewer set, are left for another reviewer — counted.
      const authors = await lastAmountAuthors(tx, candidates.map((c) => c.id));
      const targets = candidates.filter((c) => !isSelf(actor.auth, c.cycleEmployee.employeeId) && authors.get(c.id) !== actor.auth.userId);
      const skipped = candidates.length - targets.length;
      if (!targets.length) return { approved: 0, skipped };
      await tx.compensationProposal.updateMany({ where: { id: { in: targets.map((t) => t.id) } }, data: { status: 'APPROVED', approvedAt: new Date(), approvedByUserId: actor.auth.userId } });
      await tx.compensationProposalHistory.createMany({ data: targets.map((t) => ({ proposalId: t.id, action: 'APPROVED', actorUserId: actor.auth.userId, oldProposedBaseSalary: t.proposedBaseSalary, newProposedBaseSalary: t.proposedBaseSalary })) });
      await auditService.log(compAudit(actor, AUDIT_ACTIONS.APPROVE_COMPENSATION_PROPOSAL, 'CompensationReviewCycle', cycleId, { approved: targets.length, plannerUserId: f.plannerUserId ?? null, departmentId: f.departmentId ?? null }), tx);
      return { approved: targets.length, skipped };
    }, { timeout: 60_000 });
  },

  /** A proposal's append-only history — HR, or the planner of that row. */
  async history(auth: AuthContext, proposalId: string): Promise<CompHistoryDto[]> {
    const p = await prisma.compensationProposal.findUnique({ where: { id: proposalId }, include: { cycleEmployee: { select: { plannerUserId: true } } } });
    if (!p || !(hrScope(auth) || (plannerCapable(auth) && p.cycleEmployee.plannerUserId === auth.userId))) throw notFound('compensation proposal');
    const rows = await prisma.compensationProposalHistory.findMany({ where: { proposalId }, orderBy: { createdAt: 'asc' } });
    const names = await userNames(prisma, rows.map((r) => r.actorUserId));
    return rows.map((r) => ({ action: r.action, oldProposedBaseSalary: m(r.oldProposedBaseSalary), newProposedBaseSalary: m(r.newProposedBaseSalary), actorName: names.get(r.actorUserId) ?? null, reasonCode: r.reasonCode, at: r.createdAt.toISOString() }));
  },
};
