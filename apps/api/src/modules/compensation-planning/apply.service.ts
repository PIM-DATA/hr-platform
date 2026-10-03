import { AUDIT_ACTIONS, NOTIFICATION_TYPES, type CompApplyBlocker, type CompApplyPreviewDto, type CompApplyResultDto } from '@hr/shared';
import { AppError } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { auditService } from '../../services/audit/audit.service';
import type { AuthContext } from '../auth/auth.types';
import { dec } from '../payroll/money';
import { applyCompensationChangesWithTx, checkCompensationBaselinesWithTx, type CompensationBaseline } from '../payroll/payroll-master.service';
import { LONG_TX, P, compAudit, has, lockCycle, notFound, requireHr, type Actor, type Db } from './comp.types';
import { notifyCycle } from './cycle.service';

/**
 * Apply: the only path from a salary-review plan to salary history, and a separate, explicit act.
 *
 * FINALIZED means the plan is approved and frozen; it changes nobody's salary. Apply needs
 * compensation_planning.apply AND payroll.manage (the authority over /payroll/compensations), writes through the
 * payroll source service, and is all-or-nothing: under the cycle's row lock every row is checked first — the salary
 * record the plan was based on must be unchanged and still open, the person must still be ACTIVE — and one blocker
 * stops the whole cycle with the list of what to reconcile. A second concurrent Apply waits on the lock and finds the
 * cycle already applied. A zero-increase row is recorded as applied with no new salary record.
 */
async function preflight(db: Db, cycle: { id: string; effectiveDate: string; currency: string }) {
  const rows = await db.compensationProposal.findMany({
    where: { cycleId: cycle.id, status: 'APPROVED' },
    select: { id: true, currentBaseSalary: true, proposedBaseSalary: true, increaseAmount: true, appliedAt: true, approvedByUserId: true, cycleEmployee: { select: { employeeId: true, employeeCodeSnapshot: true, employeeNameSnapshot: true, sourceCompensationId: true, currencySnapshot: true } } },
  });
  const changes = rows.filter((r) => r.increaseAmount && dec(r.increaseAmount).greaterThan(0));
  const [employees, problems] = await Promise.all([
    db.employee.findMany({ where: { id: { in: changes.map((r) => r.cycleEmployee.employeeId) } }, select: { id: true, employmentStatus: true } }),
    checkCompensationBaselinesWithTx(db, changes.map((r): CompensationBaseline => ({
      employeeId: r.cycleEmployee.employeeId, expectedCompensationId: r.cycleEmployee.sourceCompensationId!, expectedBaseSalary: r.currentBaseSalary, currencyCode: cycle.currency, effectiveFrom: cycle.effectiveDate,
    }))),
  ]);
  const status = new Map(employees.map((e) => [e.id, e.employmentStatus]));
  // Task 51 (T44-P1-19): an approval is independent only if the approver is neither the subject nor the last author of
  // the amount (both refused since Task 51; this catches approvals recorded before it).
  const approverIds = [...new Set(changes.map((r) => r.approvedByUserId).filter((x): x is string => !!x))];
  const approverEmployee = new Map((await db.user.findMany({ where: { id: { in: approverIds } }, select: { id: true, employeeId: true } })).map((u) => [u.id, u.employeeId]));
  const authorRows = await db.compensationProposalHistory.findMany({ where: { proposalId: { in: changes.map((r) => r.id) }, action: { in: ['SAVED', 'OVERRIDDEN'] } }, orderBy: { createdAt: 'asc' }, select: { proposalId: true, actorUserId: true } });
  const author = new Map<string, string>(); for (const a of authorRows) author.set(a.proposalId, a.actorUserId);
  const notIndependent = (r: (typeof changes)[number]) => !!r.approvedByUserId && (approverEmployee.get(r.approvedByUserId) === r.cycleEmployee.employeeId || author.get(r.id) === r.approvedByUserId);
  const blockers: CompApplyPreviewDto['blockers'] = [];
  for (const r of changes) {
    const reason: CompApplyBlocker | null = status.get(r.cycleEmployee.employeeId) !== 'ACTIVE' ? 'EMPLOYEE_NOT_ACTIVE' : notIndependent(r) ? 'APPROVAL_NOT_INDEPENDENT' : problems.get(r.cycleEmployee.employeeId) ?? null;
    if (reason) blockers.push({ employeeCode: r.cycleEmployee.employeeCodeSnapshot, employeeName: r.cycleEmployee.employeeNameSnapshot, reason });
  }
  return { rows, changes, blockers };
}

function requireApplyAuthority(auth: AuthContext) {
  requireHr(auth);
  if (!has(auth, P.COMP_PLAN_APPLY) || !has(auth, P.PAYROLL_MANAGE)) throw AppError.forbidden('Applying salary changes needs compensation_planning.apply and payroll.manage');
}

export const compApplyService = {
  async preview(auth: AuthContext, cycleId: string): Promise<CompApplyPreviewDto> {
    requireApplyAuthority(auth);
    const cycle = await prisma.compensationReviewCycle.findUnique({ where: { id: cycleId } });
    if (!cycle) throw notFound('compensation cycle');
    if (cycle.status !== 'FINALIZED') throw new AppError(409, 'COMP_CYCLE_INVALID_STATE', 'Only a finalized cycle can be applied');
    const { rows, changes, blockers } = await preflight(prisma, cycle);
    return { toApply: changes.length, noChange: rows.length - changes.length, alreadyApplied: !!cycle.appliedAt, blockers };
  },

  async apply(cycleId: string, actor: Actor): Promise<CompApplyResultDto> {
    requireApplyAuthority(actor.auth);
    return prisma.$transaction(async (tx) => {
      const cycle = await lockCycle(tx, cycleId);
      if (cycle.appliedAt) throw new AppError(409, 'COMP_CYCLE_ALREADY_APPLIED', 'This cycle has already been applied');
      if (cycle.status !== 'FINALIZED') throw new AppError(409, 'COMP_CYCLE_INVALID_STATE', 'Only a finalized cycle can be applied');
      const { rows, changes, blockers } = await preflight(tx, cycle);
      if (blockers.length) {
        throw new AppError(409, 'COMP_APPLY_BLOCKED', `${blockers.length} row(s) need reconciliation before this cycle can be applied`,
          blockers.map((b) => ({ field: b.employeeCode, message: b.reason })));
      }
      const created = await applyCompensationChangesWithTx(tx, changes.map((r) => ({
        employeeId: r.cycleEmployee.employeeId, expectedCompensationId: r.cycleEmployee.sourceCompensationId!, expectedBaseSalary: r.currentBaseSalary,
        currencyCode: cycle.currency, effectiveFrom: cycle.effectiveDate, newBaseSalary: r.proposedBaseSalary!, note: `Salary review ${cycle.code}`,
      })), actor);
      const now = new Date();
      for (const r of rows) {
        const compensationId = created.get(r.cycleEmployee.employeeId) ?? null;
        await tx.compensationProposal.update({ where: { id: r.id }, data: { appliedAt: now, appliedByUserId: actor.auth.userId, appliedCompensationId: compensationId } });
      }
      await tx.compensationProposalHistory.createMany({ data: rows.map((r) => ({ proposalId: r.id, action: 'APPLIED', actorUserId: actor.auth.userId, oldProposedBaseSalary: r.proposedBaseSalary, newProposedBaseSalary: r.proposedBaseSalary })) });
      await tx.compensationReviewCycle.update({ where: { id: cycleId }, data: { appliedAt: now, appliedByUserId: actor.auth.userId } });
      await auditService.log(compAudit(actor, AUDIT_ACTIONS.APPLY_COMPENSATION_CYCLE, 'CompensationReviewCycle', cycleId, { applied: changes.length, noChange: rows.length - changes.length, effectiveDate: cycle.effectiveDate, currency: cycle.currency }), tx);
      await notifyCycle(tx, cycle, [cycle.createdByUserId, actor.auth.userId], NOTIFICATION_TYPES.COMP_PLAN_APPLIED, 'applied');
      return { applied: changes.length, noChange: rows.length - changes.length, appliedAt: now.toISOString() };
    }, LONG_TX);
  },
};
