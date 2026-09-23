import { AUDIT_ACTIONS, NOTIFICATION_TYPES, PAYROLL_WORKFLOW, payrollPeriodLabel } from '@hr/shared';
import { AppError } from '../../lib/errors';
import { auditService } from '../../services/audit/audit.service';
import { workflowEngine, type WorkflowCallbackContext, type WorkflowStepPendingContext } from '../../services/workflow';
import { notificationService } from '../../services/notification';
import { toMoneyString } from './money';
import { payrollAudit, type Tx } from './payroll.types';
import { payrollRunService } from './payroll-run.service';

/**
 * Payroll approval, run inside the workflow engine's transaction.
 *
 * Approval is not a formality here: before the status moves, the run is checked again — the inputs must still be the
 * ones it was calculated from, the arithmetic must close, and nobody may be left with a negative net. Failing any of
 * those aborts the transition and leaves the run in review, because approving payroll that no longer matches its
 * sources is how people get paid the wrong amount.
 */
const loadRun = async (tx: Tx, runId: string) => {
  const run = await tx.payrollRun.findUnique({ where: { id: runId }, include: { period: { include: { organization: { select: { id: true, code: true, name: true } }, runs: { orderBy: { version: 'desc' }, take: 1 } } } } });
  if (!run) throw new AppError(404, 'PAYROLL_RUN_NOT_FOUND', 'Payroll run not found');
  return run;
};

export const payrollWorkflowHandlers = {
  async onApproved(ctx: WorkflowCallbackContext, tx: Tx) {
    const run = await loadRun(tx, ctx.entityId);
    await payrollRunService.lockPeriod(tx, run.periodId);
    if (run.status !== 'REVIEW') throw new AppError(409, 'PAYROLL_RUN_NOT_IN_REVIEW', `This run is ${run.status.toLowerCase()}`);

    // The same three questions as at submit, asked again at the moment the decision actually lands.
    await payrollRunService.assertApprovable(tx, run.id, run.period);

    const approved = await tx.payrollRun.update({ where: { id: run.id }, data: { status: 'APPROVED', approvedAt: new Date() } });
    await tx.payrollPeriod.update({ where: { id: run.periodId }, data: { status: 'APPROVED' } });
    await auditService.log(payrollAudit(ctx.actor, AUDIT_ACTIONS.APPROVE_PAYROLL_RUN, 'PayrollRun', run.id, {
      period: payrollPeriodLabel(run.period.year, run.period.month), employees: approved.employeeCount,
      grossTotal: toMoneyString(approved.grossTotal), deductionTotal: toMoneyString(approved.deductionTotal), netTotal: toMoneyString(approved.netTotal),
      workflowInstanceId: ctx.instanceId, comment: ctx.comment,
    }, { status: 'REVIEW' }), tx);
  },

  async onRejected(ctx: WorkflowCallbackContext, tx: Tx) {
    const run = await loadRun(tx, ctx.entityId);
    await payrollRunService.lockPeriod(tx, run.periodId);
    // A rejected run goes back to review: the administrator fixes what the approver objected to and resubmits.
    await tx.payrollRun.update({ where: { id: run.id }, data: { status: 'REVIEW', workflowInstanceId: null } });
    await tx.payrollPeriod.update({ where: { id: run.periodId }, data: { status: 'REVIEW' } });
    await auditService.log(payrollAudit(ctx.actor, AUDIT_ACTIONS.REJECT_PAYROLL_RUN, 'PayrollRun', run.id, {
      period: payrollPeriodLabel(run.period.year, run.period.month), workflowInstanceId: ctx.instanceId, comment: ctx.comment,
    }, { status: 'REVIEW' }), tx);
  },

  /** The submitter withdrew it: back to review, nothing decided. */
  async onCancelled(ctx: WorkflowCallbackContext, tx: Tx) {
    const run = await loadRun(tx, ctx.entityId);
    await payrollRunService.lockPeriod(tx, run.periodId);
    await tx.payrollRun.update({ where: { id: run.id }, data: { status: 'REVIEW', workflowInstanceId: null } });
    await tx.payrollPeriod.update({ where: { id: run.periodId }, data: { status: 'REVIEW' } });
  },

  /**
   * Tells the current approver there is a payroll run waiting. The notification carries **no amounts** — payroll
   * figures belong behind the permission that guards the screen, not in an inbox line.
   */
  async onStepPending(ctx: WorkflowStepPendingContext, tx: Tx) {
    if (!ctx.step.approverUserId) return;
    const run = await tx.payrollRun.findUnique({ where: { id: ctx.entityId }, include: { period: { select: { year: true, month: true } } } });
    if (!run) return;
    await notificationService.publish(
      {
        userId: ctx.step.approverUserId,
        type: NOTIFICATION_TYPES.APPROVAL_REQUIRED,
        source: { module: PAYROLL_WORKFLOW.module, entityType: PAYROLL_WORKFLOW.entityType, entityId: run.id },
        data: { payrollRunId: run.id, workflowInstanceId: ctx.instanceId },
        dedupeKey: `workflow:${ctx.instanceId}:step:${ctx.step.id}:approval-required`,
      },
      { employeeName: 'Payroll', requestKind: `payroll run for ${payrollPeriodLabel(run.period.year, run.period.month)}`, date: payrollPeriodLabel(run.period.year, run.period.month) },
      tx,
    );
  },
};

workflowEngine.registerHandler(PAYROLL_WORKFLOW.module, payrollWorkflowHandlers);
