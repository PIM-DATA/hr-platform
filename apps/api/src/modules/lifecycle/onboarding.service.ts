import { AUDIT_ACTIONS, NOTIFICATION_TYPES, TASK_TRANSITIONS, addCalendarDays, type AddPlanTaskInput, type CreateOnboardingPlanInput, type LifecycleTaskDto, type OnboardingPlanDetailDto, type OnboardingPlanDto, type UpdateTaskInput } from '@hr/shared';
import type { Prisma } from '@prisma/client';
import { AppError } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { auditService } from '../../services/audit/audit.service';
import { notificationService } from '../../services/notification/notification.service';
import type { AuthContext } from '../auth/auth.types';
import { canAccessDocument, linkDocumentWithTx } from '../documents/documents.service';
import { P, currentOf, employeeSnapshot, has, lifecycleAudit, lifecycleEmployeeWhere, lockRow, notFound, progressOf, snapshotDto, taskDtos, textAudit, today, userNames, type Actor, type Db, type Tx } from './lifecycle.types';
import { probationService } from './probation.service';

/**
 * Onboarding plans: a checklist for one new joiner, copied from a template at creation, activated by HR, worked by
 * the employee, the manager and HR, and completed when every required task is done. Completing a task records that
 * a person did something; it never creates an account, a payroll profile or anything else.
 */
const include = { tasks: { orderBy: [{ sortOrder: 'asc' as const }, { dueDate: 'asc' as const }] } };
type Row = Prisma.OnboardingPlanGetPayload<{ include: typeof include }>;
async function load(db: Db, id: string) { const r = await db.onboardingPlan.findUnique({ where: { id }, include }); if (!r) throw notFound('onboarding plan'); return r; }

async function dto(db: Db, auth: AuthContext, r: Row, withTasks: boolean): Promise<OnboardingPlanDetailDto> {
  const manage = has(auth, P.ONBOARDING_MANAGE);
  const [names, current] = await Promise.all([userNames(db, [r.hrOwnerUserId]), currentOf(db, r.employeeId)]);
  const progress = progressOf(r.tasks);
  const openTasks = r.tasks.filter((t) => t.status === 'PENDING' || t.status === 'IN_PROGRESS');
  const t = today();
  const base: OnboardingPlanDto = {
    id: r.id, employeeId: r.employeeId, templateId: r.templateId, templateName: r.templateNameSnapshot, snapshot: snapshotDto(r), current, hireDate: r.hireDateSnapshot, startDate: r.startDate, status: r.status as OnboardingPlanDto['status'],
    hrOwnerUserId: r.hrOwnerUserId, hrOwnerName: r.hrOwnerUserId ? (names.get(r.hrOwnerUserId) ?? null) : null, applicationId: r.applicationId, probationCaseId: r.probationCaseId,
    progress, unassignedTasks: openTasks.filter((x) => !x.assigneeUserId).length, overdueTasks: openTasks.filter((x) => x.dueDate < t).length,
    createdByUserId: r.createdByUserId, activatedAt: r.activatedAt?.toISOString() ?? null, completedAt: r.completedAt?.toISOString() ?? null, cancelledAt: r.cancelledAt?.toISOString() ?? null, createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(),
    can: { manage, activate: manage && r.status === 'DRAFT', complete: manage && r.status === 'ACTIVE' && progress.ready },
  };
  return { ...base, tasks: withTasks ? await taskDtos(db, auth, r.tasks, manage, has(auth, P.ONBOARDING_COMPLETE_TASKS), r.status === 'ACTIVE') : [] };
}

/** Resolves who owns a task now. An employee without an account leaves the task unassigned — visible to HR, never auto-provisioned. */
async function resolveAssignee(db: Db, plan: { employeeId: string; managerIdSnapshot: string | null; hrOwnerUserId: string | null }, assigneeType: string, specificUserId: string | null): Promise<{ assigneeUserId: string | null; assigneeEmployeeId: string | null }> {
  if (assigneeType === 'EMPLOYEE') { const e = await db.employee.findUnique({ where: { id: plan.employeeId }, select: { user: { select: { id: true, isActive: true } } } }); return { assigneeUserId: e?.user?.isActive ? e.user.id : null, assigneeEmployeeId: plan.employeeId }; }
  if (assigneeType === 'MANAGER') { if (!plan.managerIdSnapshot) return { assigneeUserId: null, assigneeEmployeeId: null }; const m = await db.employee.findUnique({ where: { id: plan.managerIdSnapshot }, select: { user: { select: { id: true, isActive: true } } } }); return { assigneeUserId: m?.user?.isActive ? m.user.id : null, assigneeEmployeeId: plan.managerIdSnapshot }; }
  if (assigneeType === 'HR') return { assigneeUserId: plan.hrOwnerUserId, assigneeEmployeeId: null };
  return { assigneeUserId: specificUserId, assigneeEmployeeId: null };
}
const dueDateFor = (relativeTo: string, offset: number, dates: { hireDate: string; startDate: string }) => addCalendarDays(relativeTo === 'HIRE_DATE' ? dates.hireDate : dates.startDate, offset);

async function notifyAssignees(tx: Tx, kind: 'ONBOARDING', planId: string, employeeName: string, tasks: { assigneeUserId: string | null }[]) {
  const counts = new Map<string, number>();
  for (const t of tasks) if (t.assigneeUserId) counts.set(t.assigneeUserId, (counts.get(t.assigneeUserId) ?? 0) + 1);
  for (const [userId, n] of counts) await notificationService.publish({ userId, type: NOTIFICATION_TYPES.ONBOARDING_TASK_ASSIGNED, source: { module: 'lifecycle', entityType: 'ONBOARDING_PLAN', entityId: planId }, data: { planId, kind }, dedupeKey: `lifecycle:onboarding:${planId}:tasks:${userId}` }, { employeeName, taskCount: String(n) }, tx);
}

export const onboardingService = {
  async list(auth: AuthContext, q: { page: number; pageSize: number; status?: string; departmentId?: string; search?: string; employeeId?: string }) {
    // employeeId narrows within the caller's lifecycle scope (an AND with the scope where), never widens it.
    const where: Prisma.OnboardingPlanWhereInput = { ...(await lifecycleEmployeeWhere(auth)), status: q.status, departmentIdSnapshot: q.departmentId, ...(q.employeeId ? { AND: [{ employeeId: q.employeeId }] } : {}), ...(q.search ? { OR: [{ employeeNameSnapshot: { contains: q.search, mode: 'insensitive' } }, { employeeCodeSnapshot: { contains: q.search, mode: 'insensitive' } }] } : {}) };
    const [total, rows] = await prisma.$transaction([prisma.onboardingPlan.count({ where }), prisma.onboardingPlan.findMany({ where, include, orderBy: [{ startDate: 'desc' }, { createdAt: 'desc' }], skip: (q.page - 1) * q.pageSize, take: q.pageSize })]);
    return { data: await Promise.all(rows.map((r) => dto(prisma, auth, r, false))), meta: { page: q.page, pageSize: q.pageSize, total } };
  },
  async get(auth: AuthContext, id: string): Promise<OnboardingPlanDetailDto> {
    const r = await load(prisma, id);
    const scope = await lifecycleEmployeeWhere(auth);
    const visible = await prisma.onboardingPlan.findFirst({ where: { AND: [{ id }, scope] }, select: { id: true } });
    const assignedToMe = r.tasks.some((t) => t.assigneeUserId === auth.userId);
    if (!visible && !assignedToMe) throw notFound('onboarding plan');
    const d = await dto(prisma, auth, r, true);
    // Someone who only holds assigned tasks sees those tasks, not the whole checklist.
    return visible ? d : { ...d, tasks: d.tasks.filter((t) => t.assigneeUserId === auth.userId) };
  },

  /** Creates a DRAFT plan for an existing employee, copying the template's tasks with due dates from the start date. */
  async create(input: CreateOnboardingPlanInput, actor: Actor): Promise<OnboardingPlanDetailDto> {
    const { employee, data } = await employeeSnapshot(prisma, input.employeeId);
    if (employee.employmentStatus !== 'ACTIVE') throw new AppError(409, 'EMPLOYEE_NOT_ACTIVE', 'Onboarding needs an active employee record');
    const open = await prisma.onboardingPlan.findFirst({ where: { employeeId: employee.id, status: { in: ['DRAFT', 'ACTIVE'] } }, select: { id: true } });
    if (open) throw new AppError(409, 'ONBOARDING_PLAN_EXISTS', 'This employee already has an open onboarding plan');
    const template = input.templateId ? await prisma.lifecycleTemplate.findUnique({ where: { id: input.templateId }, include: { tasks: { orderBy: { sortOrder: 'asc' } } } }) : null;
    if (input.templateId && (!template || template.type !== 'ONBOARDING' || !template.isActive)) throw new AppError(422, 'VALIDATION_ERROR', 'Choose an active onboarding template', [{ field: 'templateId', message: 'Not an active onboarding template' }]);
    if (input.applicationId) { const app = await prisma.recruitmentApplication.findUnique({ where: { id: input.applicationId }, select: { hiredEmployeeId: true } }); if (!app || app.hiredEmployeeId !== employee.id) throw new AppError(422, 'VALIDATION_ERROR', 'That application did not hire this employee', [{ field: 'applicationId', message: 'Mismatch' }]); }
    const hireDate = employee.hireDate.toISOString().slice(0, 10);
    const startDate = input.startDate ?? hireDate;
    const hrOwnerUserId = input.hrOwnerUserId ?? actor.auth.userId;
    const row = await prisma.$transaction(async (tx) => {
      const plan = await tx.onboardingPlan.create({ data: { employeeId: employee.id, templateId: template?.id ?? null, templateNameSnapshot: template?.name ?? null, ...data, hireDateSnapshot: hireDate, startDate, hrOwnerUserId, applicationId: input.applicationId ?? null, createdByUserId: actor.auth.userId } });
      const tasks: Prisma.OnboardingTaskCreateManyInput[] = [];
      for (const [i, t] of (template?.tasks ?? []).entries()) { const a = await resolveAssignee(tx, { employeeId: employee.id, managerIdSnapshot: data.managerIdSnapshot, hrOwnerUserId }, t.assigneeType, t.specificUserId); tasks.push({ planId: plan.id, titleSnapshot: t.title, descriptionSnapshot: t.description, categorySnapshot: t.category, assigneeType: t.assigneeType, ...a, dueDate: dueDateFor(t.relativeTo, t.dueOffsetDays, { hireDate, startDate }), required: t.required, requiresDocument: t.requiresDocument, sortOrder: i }); }
      if (tasks.length) await tx.onboardingTask.createMany({ data: tasks });
      let probationCaseId: string | null = null;
      if (input.createProbation) { const c = await probationService.createWithTx(tx, { employeeId: employee.id, policyId: input.probationPolicyId ?? null, startDate }, actor); probationCaseId = c.id; await tx.onboardingPlan.update({ where: { id: plan.id }, data: { probationCaseId } }); }
      await auditService.log(lifecycleAudit(actor, AUDIT_ACTIONS.CREATE_ONBOARDING_PLAN, 'OnboardingPlan', plan.id, { employeeCode: data.employeeCodeSnapshot, templateId: template?.id ?? null, startDate, tasks: tasks.length, unassigned: tasks.filter((t) => !t.assigneeUserId).length, applicationId: input.applicationId ?? null, probationCaseId }), tx);
      return plan.id;
    });
    return dto(prisma, actor.auth, await load(prisma, row), true);
  },

  async addTask(planId: string, input: AddPlanTaskInput, actor: Actor): Promise<LifecycleTaskDto> {
    return prisma.$transaction(async (tx) => {
      await lockRow(tx, 'onboarding_plans', planId);
      const plan = await load(tx, planId);
      if (plan.status !== 'DRAFT' && plan.status !== 'ACTIVE') throw new AppError(409, 'ONBOARDING_PLAN_CLOSED', 'This plan is closed');
      const a = input.assigneeType === 'SPECIFIC_USER' ? { assigneeUserId: input.assigneeUserId ?? null, assigneeEmployeeId: null } : await resolveAssignee(tx, plan, input.assigneeType, null);
      const created = await tx.onboardingTask.create({ data: { planId, titleSnapshot: input.title, descriptionSnapshot: input.description ?? null, categorySnapshot: input.category, assigneeType: input.assigneeType, ...a, dueDate: input.dueDate, required: input.required ?? true, requiresDocument: input.requiresDocument ?? false, sortOrder: plan.tasks.length } });
      await auditService.log(lifecycleAudit(actor, AUDIT_ACTIONS.UPDATE_ONBOARDING_TASK, 'OnboardingTask', created.id, { added: true, planId, assigneeType: created.assigneeType, assigned: !!created.assigneeUserId, dueDate: created.dueDate, required: created.required }), tx);
      if (plan.status === 'ACTIVE' && created.assigneeUserId) await notifyAssignees(tx, 'ONBOARDING', planId, plan.employeeNameSnapshot, [created]);
      return (await taskDtos(tx, actor.auth, [created], true, true, plan.status === 'ACTIVE'))[0];
    });
  },

  /** ACTIVE: assignees are resolved again (an account created since draft is picked up), notified, and the employee is told. */
  async activate(planId: string, actor: Actor): Promise<OnboardingPlanDetailDto> {
    await prisma.$transaction(async (tx) => {
      await lockRow(tx, 'onboarding_plans', planId);
      const plan = await load(tx, planId);
      if (plan.status !== 'DRAFT') throw new AppError(409, 'ONBOARDING_PLAN_NOT_DRAFT', `A ${plan.status.toLowerCase()} plan cannot be activated`);
      for (const t of plan.tasks) if (!t.assigneeUserId && t.assigneeType !== 'SPECIFIC_USER') { const a = await resolveAssignee(tx, plan, t.assigneeType, null); if (a.assigneeUserId) await tx.onboardingTask.update({ where: { id: t.id }, data: a }); }
      const tasks = await tx.onboardingTask.findMany({ where: { planId } });
      await tx.onboardingPlan.update({ where: { id: planId }, data: { status: 'ACTIVE', activatedAt: new Date() } });
      await notifyAssignees(tx, 'ONBOARDING', planId, plan.employeeNameSnapshot, tasks);
      const emp = await tx.employee.findUnique({ where: { id: plan.employeeId }, select: { user: { select: { id: true } } } });
      if (emp?.user) await notificationService.publish({ userId: emp.user.id, type: NOTIFICATION_TYPES.ONBOARDING_PLAN_STARTED, source: { module: 'lifecycle', entityType: 'ONBOARDING_PLAN', entityId: planId }, data: { planId }, dedupeKey: `lifecycle:onboarding:${planId}:started` }, { date: plan.startDate }, tx);
      await auditService.log(lifecycleAudit(actor, AUDIT_ACTIONS.ACTIVATE_ONBOARDING_PLAN, 'OnboardingPlan', planId, { tasks: tasks.length, unassigned: tasks.filter((t) => !t.assigneeUserId).length }), tx);
    });
    return dto(prisma, actor.auth, await load(prisma, planId), true);
  },

  /**
   * Task update by the assignee (status, note, document) or a manager (also assignee and due date). Required tasks
   * may be skipped only with onboarding.manage. A document must be one the actor can open, and it is linked through
   * the document module. Under the task row lock, so a double completion is one completion plus one 409.
   */
  async updateTask(taskId: string, input: UpdateTaskInput, actor: Actor): Promise<LifecycleTaskDto> {
    const { auth } = actor;
    return prisma.$transaction(async (tx) => {
      await lockRow(tx, 'onboarding_tasks', taskId);
      const before = await tx.onboardingTask.findUnique({ where: { id: taskId } });
      if (!before) throw notFound('task');
      const plan = await load(tx, before.planId);
      const manage = has(auth, P.ONBOARDING_MANAGE);
      const mine = before.assigneeUserId === auth.userId && has(auth, P.ONBOARDING_COMPLETE_TASKS);
      if (!manage && !mine) throw AppError.forbidden('Only the assignee or an onboarding manager can update this task');
      if (plan.status !== 'ACTIVE') throw new AppError(409, 'ONBOARDING_PLAN_NOT_ACTIVE', 'Tasks can be worked while the plan is active');
      if ((input.assigneeUserId !== undefined || input.dueDate !== undefined) && !manage) throw AppError.forbidden('Reassigning or rescheduling a task needs onboarding.manage');
      if (input.status) {
        if (!TASK_TRANSITIONS[before.status as keyof typeof TASK_TRANSITIONS].includes(input.status)) throw new AppError(409, 'LIFECYCLE_TASK_INVALID_TRANSITION', `A ${before.status.toLowerCase()} task cannot become ${input.status.toLowerCase()}`);
        if ((input.status === 'SKIPPED' || input.status === 'CANCELLED') && before.required && !manage) throw AppError.forbidden('A required task can be skipped only by an onboarding manager');
        if (input.status === 'COMPLETED' && before.requiresDocument && !before.documentId && !input.documentId) throw new AppError(422, 'LIFECYCLE_TASK_DOCUMENT_REQUIRED', 'This task needs a document before it can be completed');
      }
      if (input.documentId) {
        const doc = await tx.document.findUnique({ where: { id: input.documentId }, include: { category: true, links: true, ownerEmployee: { select: { id: true, employeeCode: true, firstName: true, lastName: true, managerId: true } } } });
        if (!doc || !canAccessDocument(auth, doc)) throw new AppError(404, 'DOCUMENT_NOT_FOUND', 'Document not found');
        await linkDocumentWithTx(tx, input.documentId, { entityType: 'ONBOARDING_TASK', entityId: taskId, relationType: 'TASK_EVIDENCE' }, actor);
      }
      if (input.assigneeUserId && !(await tx.user.findUnique({ where: { id: input.assigneeUserId }, select: { id: true } }))) throw new AppError(422, 'VALIDATION_ERROR', 'Unknown user', [{ field: 'assigneeUserId', message: 'Unknown user' }]);
      const done = input.status === 'COMPLETED' || input.status === 'SKIPPED';
      const after = await tx.onboardingTask.update({ where: { id: taskId }, data: { status: input.status, note: input.note === undefined ? undefined : input.note, documentId: input.documentId === undefined ? undefined : input.documentId, assigneeUserId: input.assigneeUserId === undefined ? undefined : input.assigneeUserId, dueDate: input.dueDate, ...(done ? { completedAt: new Date(), completedByUserId: auth.userId } : {}) } });
      await auditService.log(lifecycleAudit(actor, AUDIT_ACTIONS.UPDATE_ONBOARDING_TASK, 'OnboardingTask', taskId, { planId: plan.id, status: after.status, documentLinked: !!input.documentId, assigneeChanged: input.assigneeUserId !== undefined, dueDate: after.dueDate, ...textAudit('note', before.note, after.note) }, { status: before.status }), tx);
      return (await taskDtos(tx, auth, [after], manage, has(auth, P.ONBOARDING_COMPLETE_TASKS), true))[0];
    });
  },

  /** COMPLETED only when every required task is completed or skipped. Under the plan lock: a double complete is one transition. */
  async complete(planId: string, actor: Actor): Promise<OnboardingPlanDetailDto> {
    await prisma.$transaction(async (tx) => {
      await lockRow(tx, 'onboarding_plans', planId);
      const plan = await load(tx, planId);
      if (plan.status !== 'ACTIVE') throw new AppError(409, 'ONBOARDING_PLAN_NOT_ACTIVE', `A ${plan.status.toLowerCase()} plan cannot be completed`);
      const progress = progressOf(plan.tasks);
      if (!progress.ready) throw new AppError(409, 'ONBOARDING_REQUIRED_TASKS_OPEN', `${progress.requiredOpen} required task(s) are still open`);
      await tx.onboardingTask.updateMany({ where: { planId, status: { in: ['PENDING', 'IN_PROGRESS'] } }, data: { status: 'CANCELLED' } });
      await tx.onboardingPlan.update({ where: { id: planId }, data: { status: 'COMPLETED', completedAt: new Date() } });
      await auditService.log(lifecycleAudit(actor, AUDIT_ACTIONS.COMPLETE_ONBOARDING_PLAN, 'OnboardingPlan', planId, { tasks: progress.total, done: progress.done }), tx);
    });
    return dto(prisma, actor.auth, await load(prisma, planId), true);
  },
  async cancel(planId: string, actor: Actor): Promise<OnboardingPlanDetailDto> {
    await prisma.$transaction(async (tx) => {
      await lockRow(tx, 'onboarding_plans', planId);
      const plan = await load(tx, planId);
      if (plan.status !== 'DRAFT' && plan.status !== 'ACTIVE') throw new AppError(409, 'ONBOARDING_PLAN_CLOSED', 'This plan is already closed');
      await tx.onboardingTask.updateMany({ where: { planId, status: { in: ['PENDING', 'IN_PROGRESS'] } }, data: { status: 'CANCELLED' } });
      await tx.onboardingPlan.update({ where: { id: planId }, data: { status: 'CANCELLED', cancelledAt: new Date() } });
      await auditService.log(lifecycleAudit(actor, AUDIT_ACTIONS.CANCEL_ONBOARDING_PLAN, 'OnboardingPlan', planId, { from: plan.status }), tx);
    });
    return dto(prisma, actor.auth, await load(prisma, planId), true);
  },
  /** The signed-in employee's own plan, if any (most recent). */
  async mine(auth: AuthContext): Promise<OnboardingPlanDetailDto | null> {
    if (!auth.employeeId) return null;
    const r = await prisma.onboardingPlan.findFirst({ where: { employeeId: auth.employeeId, status: { in: ['ACTIVE', 'COMPLETED'] } }, include, orderBy: { createdAt: 'desc' } });
    return r ? dto(prisma, auth, r, true) : null;
  },
};
