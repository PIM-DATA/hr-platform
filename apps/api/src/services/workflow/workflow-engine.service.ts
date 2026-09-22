import type { Prisma } from '@prisma/client';
import {
  AUDIT_ACTIONS, PERMISSIONS, SKIP_REASONS, WORKFLOW_ACTIONS, WORKFLOW_INSTANCE_STATUS as IS, WORKFLOW_STEP_STATUS as SS,
  type WorkflowActionInput, type WorkflowInboxItemDto, type WorkflowInstanceDto,
} from '@hr/shared';
import { prisma } from '../../lib/prisma';
import { AppError } from '../../lib/errors';
import { auditService } from '../audit/audit.service';
import { hasPermission } from '../authorization/authorization.service';
import type { AuthContext } from '../../modules/auth/auth.types';
import { workflowDefinitionsService } from './workflow-definitions.service';
import { resolveApprover } from './approver-resolver';
import type { Actor, SubmitInput, Tx, WorkflowCallbackContext, WorkflowHandlers } from './workflow.types';

const handlers = new Map<string, WorkflowHandlers>();
const employeeRef = { select: { id: true, employeeCode: true, firstName: true, lastName: true } } as const;
const userRef = { select: { id: true, email: true } } as const;

const instanceInclude = {
  definition: { select: { id: true, code: true, version: true, name: true } },
  requesterEmployee: employeeRef,
  steps: { orderBy: { stepOrder: 'asc' }, include: { approverEmployee: employeeRef, approverUser: userRef, actedBy: userRef } },
  actions: { orderBy: { createdAt: 'asc' }, include: { actor: userRef } },
} satisfies Prisma.WorkflowInstanceInclude;
type InstanceRow = Prisma.WorkflowInstanceGetPayload<{ include: typeof instanceInclude }>;

function toDto(i: InstanceRow): WorkflowInstanceDto {
  return {
    id: i.id, definition: i.definition, module: i.module, entityType: i.entityType, entityId: i.entityId, requesterEmployee: i.requesterEmployee,
    status: i.status, currentStepOrder: i.currentStepOrder, submittedAt: i.submittedAt.toISOString(), completedAt: i.completedAt?.toISOString() ?? null,
    steps: i.steps.map((s) => ({ stepOrder: s.stepOrder, name: s.name, approverType: s.approverType, approverEmployee: s.approverEmployee, approverUser: s.approverUser, status: s.status, skipReason: s.skipReason, actedBy: s.actedBy, actedAt: s.actedAt?.toISOString() ?? null, comment: s.comment })),
    actions: i.actions.map((a) => ({ id: a.id, stepOrder: a.stepOrder, action: a.action, actor: a.actor, comment: a.comment, createdAt: a.createdAt.toISOString() })),
  };
}

const audit = (actor: Actor, action: keyof typeof AUDIT_ACTIONS, instanceId: string, newValue: unknown) => ({
  userId: actor.auth.userId, ipAddress: actor.ipAddress, userAgent: actor.userAgent,
  action: AUDIT_ACTIONS[action], module: 'workflow', recordType: 'WorkflowInstance', recordId: instanceId, newValue,
});

async function loadInstance(tx: Tx | typeof prisma, id: string) {
  const row = await tx.workflowInstance.findUnique({ where: { id }, include: instanceInclude });
  if (!row) throw new AppError(404, 'WORKFLOW_INSTANCE_NOT_FOUND', 'Workflow instance not found');
  return row;
}

/**
 * The single place an instance is loaded for a transition (act / cancel): takes the PostgreSQL row lock FIRST
 * (held until the caller's transaction ends), then reads status/steps — so status is never decided on a
 * pre-lock read (no TOCTOU). Transitions of ONE instance are serialised at the database row; other instances
 * are unaffected (no global mutex). Lock order for business handlers: workflow_instance → business record →
 * entitlement; a handler must never lock the instance again in a different order. Parameterised tagged template.
 */
export async function loadWorkflowInstanceForMutation(tx: Tx, id: string) {
  await tx.$queryRaw`SELECT "id" FROM "workflow_instances" WHERE "id" = ${id} FOR UPDATE`;
  return loadInstance(tx, id);
}

function callbackContext(i: InstanceRow, actor: Actor, comment: string | null): WorkflowCallbackContext {
  return { instanceId: i.id, module: i.module, entityType: i.entityType, entityId: i.entityId, requesterEmployeeId: i.requesterEmployeeId, actor, comment };
}

/**
 * Shared workflow engine. Business modules call submit()/cancel() inside THEIR transaction and register
 * handlers that run inside the engine's transaction when an instance completes. The engine never knows
 * what a "leave request" is — only (module, entityType, entityId).
 */
export const workflowEngine = {
  /** Registers callbacks for a business module key (idempotent; last registration wins). */
  registerHandler(module: string, h: WorkflowHandlers) {
    handlers.set(module, h);
  },

  /**
   * Creates an instance from the ACTIVE definition version: resolves every step's approver from the
   * requester's current org data, snapshots it, applies onSelf/onUnresolved, marks the first live step
   * PENDING (or completes immediately when every step was skipped). Must run inside the caller's tx.
   */
  async submit(input: SubmitInput, actor: Actor, tx: Tx): Promise<WorkflowInstanceDto> {
    const def = await workflowDefinitionsService.getActive(tx, input.definitionCode);
    if (def.module !== input.module || def.entityType !== input.entityType) {
      throw new AppError(409, 'WORKFLOW_DEFINITION_MISMATCH', `${def.code} is defined for ${def.module}/${def.entityType}`);
    }
    const pending = await tx.workflowInstance.findFirst({ where: { module: input.module, entityType: input.entityType, entityId: input.entityId, status: IS.PENDING }, select: { id: true } });
    if (pending) throw new AppError(409, 'WORKFLOW_ALREADY_PENDING', 'This record already has a pending workflow');

    const requester = await tx.employee.findUnique({
      where: { id: input.requesterEmployeeId },
      select: { id: true, managerId: true, employmentStatus: true, department: { select: { headEmployeeId: true } }, user: { select: { id: true } } },
    });
    if (!requester) throw new AppError(404, 'EMPLOYEE_NOT_FOUND', 'Requester employee not found');
    if (requester.employmentStatus !== 'ACTIVE') throw new AppError(409, 'EMPLOYEE_INACTIVE', 'Requester is not an active employee');

    // resolve + snapshot every step
    const snapshot: Prisma.WorkflowInstanceStepCreateWithoutInstanceInput[] = [];
    for (const step of def.steps) {
      const resolved = await resolveApprover(tx, step, { employeeId: requester.id, managerId: requester.managerId, departmentHeadEmployeeId: requester.department.headEmployeeId });
      const base = { stepOrder: step.stepOrder, name: step.name, approverType: step.approverType };
      if (!resolved.ok) {
        if (step.onUnresolved === 'SKIP') { snapshot.push({ ...base, status: SS.SKIPPED, skipReason: SKIP_REASONS.UNRESOLVED }); continue; }
        throw new AppError(409, 'APPROVER_UNRESOLVED', `Step ${step.stepOrder} (${step.name}) has no valid approver: ${resolved.reason}`, [{ field: `step${step.stepOrder}`, message: `${step.approverType}: ${resolved.reason}` }]);
      }
      const isSelf = resolved.approver.approverEmployeeId === requester.id || resolved.approver.approverUserId === requester.user?.id;
      if (isSelf) {
        if (step.onSelf === 'SKIP') { snapshot.push({ ...base, status: SS.SKIPPED, skipReason: SKIP_REASONS.SELF, approverEmployee: { connect: { id: requester.id } } }); continue; }
        throw new AppError(409, 'SELF_APPROVAL_NOT_ALLOWED', `Step ${step.stepOrder} (${step.name}) would be approved by the requester`, [{ field: `step${step.stepOrder}`, message: step.approverType }]);
      }
      snapshot.push({
        ...base, status: SS.WAITING,
        approverEmployee: resolved.approver.approverEmployeeId ? { connect: { id: resolved.approver.approverEmployeeId } } : undefined,
        approverUser: { connect: { id: resolved.approver.approverUserId } },
      });
    }
    const first = snapshot.find((s) => s.status === SS.WAITING);
    if (first) first.status = SS.PENDING;
    const allSkipped = !first;

    const instance = await tx.workflowInstance.create({
      data: {
        definitionId: def.id, module: input.module, entityType: input.entityType, entityId: input.entityId,
        requesterEmployeeId: requester.id, requesterUserId: actor.auth.userId,
        status: allSkipped ? IS.APPROVED : IS.PENDING, currentStepOrder: first?.stepOrder ?? null, completedAt: allSkipped ? new Date() : null,
        steps: { create: snapshot },
        actions: { create: { action: WORKFLOW_ACTIONS.SUBMIT, actorUserId: actor.auth.userId } },
      },
      include: instanceInclude,
    });
    await auditService.log(audit(actor, 'WORKFLOW_SUBMIT', instance.id, {
      definition: `${def.code}@${def.version}`, entity: `${input.module}/${input.entityType}/${input.entityId}`,
      steps: instance.steps.map((s) => ({ stepOrder: s.stepOrder, approverType: s.approverType, approverUserId: s.approverUserId, status: s.status, skipReason: s.skipReason })),
      autoApproved: allSkipped,
    }), tx);
    if (allSkipped) await handlers.get(input.module)?.onApproved?.(callbackContext(instance, actor, null), tx);
    return toDto(instance);
  },

  /**
   * APPROVE / REJECT by the snapshot approver of the CURRENT pending step. Runs inside `tx`.
   * APPROVE advances to the next non-skipped step or completes the instance; REJECT completes it.
   */
  async act(instanceId: string, input: WorkflowActionInput, actor: Actor, tx: Tx): Promise<WorkflowInstanceDto> {
    if (!hasPermission(actor.auth, PERMISSIONS.WORKFLOW_APPROVE)) throw AppError.forbidden();
    // 1. lock → 2. reload → 3. status → 4. actor → 5. step → 6. instance → 7. action → 8. audit → 9. handler → commit
    const instance = await loadWorkflowInstanceForMutation(tx, instanceId);
    if (instance.status !== IS.PENDING) throw new AppError(409, 'WORKFLOW_NOT_PENDING', `Workflow is already ${instance.status}`);
    const current = instance.steps.find((s) => s.stepOrder === instance.currentStepOrder && s.status === SS.PENDING);
    if (!current) throw new AppError(409, 'WORKFLOW_STEP_NOT_PENDING', 'No step is waiting for a decision');
    if (current.approverUserId !== actor.auth.userId) throw new AppError(403, 'NOT_STEP_APPROVER', 'You are not the approver of the current step');

    const now = new Date();
    const comment = input.comment ?? null;
    const approved = input.action === WORKFLOW_ACTIONS.APPROVE;
    await tx.workflowInstanceStep.update({ where: { id: current.id }, data: { status: approved ? SS.APPROVED : SS.REJECTED, actedByUserId: actor.auth.userId, actedAt: now, comment } });
    await tx.workflowAction.create({ data: { instanceId, stepOrder: current.stepOrder, action: input.action, actorUserId: actor.auth.userId, comment } });

    let finalStatus: string = IS.PENDING;
    let nextOrder: number | null = null;
    if (approved) {
      const next = instance.steps.find((s) => s.stepOrder > current.stepOrder && s.status === SS.WAITING);
      if (next) { nextOrder = next.stepOrder; await tx.workflowInstanceStep.update({ where: { id: next.id }, data: { status: SS.PENDING } }); }
      else finalStatus = IS.APPROVED;
    } else {
      finalStatus = IS.REJECTED;
      await tx.workflowInstanceStep.updateMany({ where: { instanceId, status: SS.WAITING }, data: { status: SS.CANCELLED } });
    }
    const after = await tx.workflowInstance.update({
      where: { id: instanceId },
      data: { status: finalStatus, currentStepOrder: finalStatus === IS.PENDING ? nextOrder : null, completedAt: finalStatus === IS.PENDING ? null : now },
      include: instanceInclude,
    });
    await auditService.log(audit(actor, approved ? 'WORKFLOW_APPROVE' : 'WORKFLOW_REJECT', instanceId, { stepOrder: current.stepOrder, instanceStatus: finalStatus, nextStepOrder: nextOrder }), tx);

    const h = handlers.get(after.module);
    if (finalStatus === IS.APPROVED) await h?.onApproved?.(callbackContext(after, actor, comment), tx);
    if (finalStatus === IS.REJECTED) await h?.onRejected?.(callbackContext(after, actor, comment), tx);
    return toDto(after);
  },

  /**
   * INTERNAL: cancels a pending instance (pending/waiting steps → CANCELLED). Not exposed on the generic
   * HTTP action endpoint — business modules call it from their own cancel endpoint after their rules ran.
   */
  async cancel(instanceId: string, actor: Actor, tx: Tx, comment: string | null = null): Promise<WorkflowInstanceDto> {
    const instance = await loadWorkflowInstanceForMutation(tx, instanceId); // same lock-first order as act()
    if (instance.status !== IS.PENDING) throw new AppError(409, 'WORKFLOW_NOT_PENDING', `Workflow is already ${instance.status}`);
    const now = new Date();
    await tx.workflowInstanceStep.updateMany({ where: { instanceId, status: { in: [SS.PENDING, SS.WAITING] } }, data: { status: SS.CANCELLED } });
    await tx.workflowAction.create({ data: { instanceId, stepOrder: instance.currentStepOrder, action: WORKFLOW_ACTIONS.CANCEL, actorUserId: actor.auth.userId, comment } });
    const after = await tx.workflowInstance.update({ where: { id: instanceId }, data: { status: IS.CANCELLED, currentStepOrder: null, completedAt: now }, include: instanceInclude });
    await auditService.log(audit(actor, 'WORKFLOW_CANCEL', instanceId, { atStepOrder: instance.currentStepOrder }), tx);
    await handlers.get(after.module)?.onCancelled?.(callbackContext(after, actor, comment), tx);
    return toDto(after);
  },

  /** Steps waiting for ME (snapshot approverUserId) — an authorization context of its own, unrelated to data scope. */
  async inbox(auth: AuthContext, q: { page: number; pageSize: number; module?: string }): Promise<{ data: WorkflowInboxItemDto[]; meta: { page: number; pageSize: number; total: number } }> {
    const where: Prisma.WorkflowInstanceStepWhereInput = { approverUserId: auth.userId, status: SS.PENDING, instance: { status: IS.PENDING, module: q.module } };
    const [total, rows] = await prisma.$transaction([
      prisma.workflowInstanceStep.count({ where }),
      prisma.workflowInstanceStep.findMany({
        where,
        include: { instance: { include: { requesterEmployee: employeeRef, definition: { select: { name: true } } } } },
        orderBy: { instance: { submittedAt: 'asc' } },
        skip: (q.page - 1) * q.pageSize, take: q.pageSize,
      }),
    ]);
    return {
      data: rows.map((s) => ({ instanceId: s.instanceId, stepOrder: s.stepOrder, stepName: s.name, module: s.instance.module, entityType: s.instance.entityType, entityId: s.instance.entityId, definitionName: s.instance.definition.name, requesterEmployee: s.instance.requesterEmployee, submittedAt: s.instance.submittedAt.toISOString() })),
      meta: { page: q.page, pageSize: q.pageSize, total },
    };
  },

  /** Requester, any snapshot approver, or workflow.view_all may read an instance; others get 404 (no existence leak). */
  async getInstance(auth: AuthContext, id: string): Promise<WorkflowInstanceDto> {
    const row = await loadInstance(prisma, id);
    const involved = row.requesterUserId === auth.userId || (auth.employeeId && row.requesterEmployeeId === auth.employeeId) || row.steps.some((s) => s.approverUserId === auth.userId);
    if (!involved && !hasPermission(auth, PERMISSIONS.WORKFLOW_VIEW_ALL)) throw new AppError(404, 'WORKFLOW_INSTANCE_NOT_FOUND', 'Workflow instance not found');
    return toDto(row);
  },

  /** Admin listing (workflow.view_all). */
  async list(q: { page: number; pageSize: number; module?: string; status?: string; entityType?: string; requesterEmployeeId?: string }) {
    const where: Prisma.WorkflowInstanceWhereInput = { module: q.module, status: q.status, entityType: q.entityType, requesterEmployeeId: q.requesterEmployeeId };
    const [total, rows] = await prisma.$transaction([
      prisma.workflowInstance.count({ where }),
      prisma.workflowInstance.findMany({ where, include: instanceInclude, orderBy: { submittedAt: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
    ]);
    return { data: rows.map(toDto), meta: { page: q.page, pageSize: q.pageSize, total } };
  },

  /** Test/diagnostic helper. */
  _clearHandlers() {
    handlers.clear();
  },
};
