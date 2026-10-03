import { AUDIT_ACTIONS, NOTIFICATION_TYPES, TASK_TRANSITIONS, addCalendarDays, type AddPlanTaskInput, type CompleteSeparationInput, type CreateOffboardingCaseInput, type ExitInterviewInput, type LifecycleTaskDto, type OffboardingCaseDetailDto, type OffboardingCaseDto, type UpdateOffboardingCaseInput, type UpdateTaskInput } from '@hr/shared';
import type { Prisma } from '@prisma/client';
import { AppError } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { auditService } from '../../services/audit/audit.service';
import { notificationService } from '../../services/notification/notification.service';
import type { AuthContext } from '../auth/auth.types';
import { canAccessDocument, linkDocumentWithTx } from '../documents/documents.service';
import { separateEmployeeWithTx } from '../employees/employees.service';
import { deactivateUserWithTx } from '../users/users.service';
import { todayForEmployee } from '../../services/business-time/business-time';
import { P, currentOf, employeeSnapshot, has, lifecycleAudit, lifecycleEmployeeWhere, lockRow, notFound, progressOf, snapshotDto, taskDtos, textAudit, userNames, type Actor, type Db, type Tx } from './lifecycle.types';

/**
 * Offboarding: a checklist and a decision record for a departure. Activation starts tasks; completing tasks makes
 * the case READY_TO_COMPLETE; the explicit "Complete employment separation" action is the only step that touches the
 * employee master (through the employees domain helper) and the account (through the users domain helper), in
 * one transaction. No payroll settlement, leave payout, document deletion or replacement requisition ever follows.
 */
const include = { tasks: { orderBy: [{ sortOrder: 'asc' as const }, { dueDate: 'asc' as const }] } };
type Row = Prisma.OffboardingCaseGetPayload<{ include: typeof include }>;
async function load(db: Db, id: string) { const r = await db.offboardingCase.findUnique({ where: { id }, include }); if (!r) throw notFound('offboarding case'); return r; }
/** Categories the employee never sees on their own checklist. */
const CONFIDENTIAL_CATEGORIES = new Set(['ACCESS', 'PAYROLL', 'EXIT_ADMIN']);

async function dto(db: Db, auth: AuthContext, r: Row, withTasks: boolean): Promise<OffboardingCaseDetailDto> {
  const manage = has(auth, P.OFFBOARDING_MANAGE);
  const self = r.employeeId === auth.employeeId && !manage;
  const [names, current] = await Promise.all([userNames(db, [r.hrOwnerUserId, r.exitInterviewerUserId]), currentOf(db, r.employeeId)]);
  const visibleTasks = self ? r.tasks.filter((t) => !CONFIDENTIAL_CATEGORIES.has(t.categorySnapshot) || t.assigneeUserId === auth.userId) : r.tasks;
  const progress = progressOf(r.tasks);
  const open = r.tasks.filter((t) => t.status === 'PENDING' || t.status === 'IN_PROGRESS');
  const t = await todayForEmployee(db, r.employeeId); // Task 53: the employee's own today
  const base: OffboardingCaseDto = {
    id: r.id, employeeId: r.employeeId, templateId: r.templateId, templateName: r.templateNameSnapshot, snapshot: snapshotDto(r), current,
    reasonCode: r.reasonCode as OffboardingCaseDto['reasonCode'], reasonNote: manage ? r.reasonNote : null, plannedLastWorkingDate: r.plannedLastWorkingDate, actualLastWorkingDate: r.actualLastWorkingDate, status: r.status as OffboardingCaseDto['status'],
    hrOwnerUserId: r.hrOwnerUserId, hrOwnerName: r.hrOwnerUserId ? (names.get(r.hrOwnerUserId) ?? null) : null,
    exitInterview: manage && r.exitInterviewDate ? { interviewDate: r.exitInterviewDate, reasonCategory: r.exitReasonCategory, wouldRejoin: r.exitWouldRejoin, note: r.exitInterviewNote, interviewerName: r.exitInterviewerUserId ? (names.get(r.exitInterviewerUserId) ?? null) : null } : null,
    progress, unassignedTasks: open.filter((x) => !x.assigneeUserId).length, overdueTasks: open.filter((x) => x.dueDate < t).length,
    separation: r.completedAt ? { completedAt: r.completedAt.toISOString(), accountDisabled: !!r.separationAccountDisabled, sessionsRevoked: r.separationSessionsRevoked ?? 0 } : null,
    createdByUserId: r.createdByUserId, activatedAt: r.activatedAt?.toISOString() ?? null, completedAt: r.completedAt?.toISOString() ?? null, cancelledAt: r.cancelledAt?.toISOString() ?? null, createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(),
    can: { manage, activate: manage && r.status === 'DRAFT', completeSeparation: has(auth, P.OFFBOARDING_COMPLETE_SEPARATION) && r.status === 'READY_TO_COMPLETE', cancel: manage && (r.status === 'DRAFT' || r.status === 'ACTIVE' || r.status === 'READY_TO_COMPLETE') },
  };
  return { ...base, tasks: withTasks ? await taskDtos(db, auth, visibleTasks, manage, has(auth, P.OFFBOARDING_COMPLETE_TASKS), r.status === 'ACTIVE' || r.status === 'READY_TO_COMPLETE') : [] };
}
async function resolveAssignee(db: Db, c: { employeeId: string; managerIdSnapshot: string | null; hrOwnerUserId: string | null }, assigneeType: string, specificUserId: string | null) {
  if (assigneeType === 'EMPLOYEE') { const e = await db.employee.findUnique({ where: { id: c.employeeId }, select: { user: { select: { id: true, isActive: true } } } }); return { assigneeUserId: e?.user?.isActive ? e.user.id : null, assigneeEmployeeId: c.employeeId }; }
  if (assigneeType === 'MANAGER') { if (!c.managerIdSnapshot) return { assigneeUserId: null, assigneeEmployeeId: null }; const m = await db.employee.findUnique({ where: { id: c.managerIdSnapshot }, select: { user: { select: { id: true, isActive: true } } } }); return { assigneeUserId: m?.user?.isActive ? m.user.id : null, assigneeEmployeeId: c.managerIdSnapshot }; }
  if (assigneeType === 'HR') return { assigneeUserId: c.hrOwnerUserId, assigneeEmployeeId: null };
  return { assigneeUserId: specificUserId, assigneeEmployeeId: null };
}
async function notifyAssignees(tx: Tx, caseId: string, employeeName: string, tasks: { assigneeUserId: string | null }[]) {
  const counts = new Map<string, number>();
  for (const t of tasks) if (t.assigneeUserId) counts.set(t.assigneeUserId, (counts.get(t.assigneeUserId) ?? 0) + 1);
  for (const [userId, n] of counts) await notificationService.publish({ userId, type: NOTIFICATION_TYPES.OFFBOARDING_TASK_ASSIGNED, source: { module: 'lifecycle', entityType: 'OFFBOARDING_CASE', entityId: caseId }, data: { caseId }, dedupeKey: `lifecycle:offboarding:${caseId}:tasks:${userId}` }, { employeeName, taskCount: String(n) }, tx);
}
/** READY_TO_COMPLETE follows from the checklist; ACTIVE returns when a required task reopens. Called under the case lock. */
async function refreshReadiness(tx: Tx, caseId: string, actor: Actor) {
  const c = await load(tx, caseId);
  if (c.status !== 'ACTIVE' && c.status !== 'READY_TO_COMPLETE') return;
  const ready = progressOf(c.tasks).ready;
  if (ready && c.status === 'ACTIVE') { await tx.offboardingCase.update({ where: { id: caseId }, data: { status: 'READY_TO_COMPLETE' } }); await auditService.log(lifecycleAudit(actor, AUDIT_ACTIONS.READY_OFFBOARDING_CASE, 'OffboardingCase', caseId, { tasks: c.tasks.length }), tx); }
  if (!ready && c.status === 'READY_TO_COMPLETE') await tx.offboardingCase.update({ where: { id: caseId }, data: { status: 'ACTIVE' } });
}

export const offboardingService = {
  async list(auth: AuthContext, q: { page: number; pageSize: number; status?: string; departmentId?: string; search?: string; employeeId?: string }) {
    const where: Prisma.OffboardingCaseWhereInput = { ...(await lifecycleEmployeeWhere(auth) as Prisma.OffboardingCaseWhereInput), status: q.status, departmentIdSnapshot: q.departmentId, ...(q.employeeId ? { AND: [{ employeeId: q.employeeId }] } : {}), ...(q.search ? { OR: [{ employeeNameSnapshot: { contains: q.search, mode: 'insensitive' } }, { employeeCodeSnapshot: { contains: q.search, mode: 'insensitive' } }] } : {}) };
    const [total, rows] = await prisma.$transaction([prisma.offboardingCase.count({ where }), prisma.offboardingCase.findMany({ where, include, orderBy: [{ plannedLastWorkingDate: 'asc' }], skip: (q.page - 1) * q.pageSize, take: q.pageSize })]);
    return { data: await Promise.all(rows.map((r) => dto(prisma, auth, r, false))), meta: { page: q.page, pageSize: q.pageSize, total } };
  },
  async get(auth: AuthContext, id: string): Promise<OffboardingCaseDetailDto> {
    const r = await load(prisma, id);
    const visible = await prisma.offboardingCase.findFirst({ where: { AND: [{ id }, await lifecycleEmployeeWhere(auth) as Prisma.OffboardingCaseWhereInput] }, select: { id: true } });
    const assignedToMe = r.tasks.some((t) => t.assigneeUserId === auth.userId);
    if (!visible && !assignedToMe) throw notFound('offboarding case');
    const d = await dto(prisma, auth, r, true);
    return visible ? d : { ...d, reasonNote: null, exitInterview: null, tasks: d.tasks.filter((t) => t.assigneeUserId === auth.userId) };
  },

  async create(input: CreateOffboardingCaseInput, actor: Actor): Promise<OffboardingCaseDetailDto> {
    const { employee, data } = await employeeSnapshot(prisma, input.employeeId);
    if (employee.employmentStatus === 'TERMINATED') throw new AppError(409, 'EMPLOYEE_ALREADY_TERMINATED', 'This employee has already left');
    if (await prisma.offboardingCase.findFirst({ where: { employeeId: employee.id, status: { in: ['DRAFT', 'ACTIVE', 'READY_TO_COMPLETE'] } }, select: { id: true } })) throw new AppError(409, 'OFFBOARDING_CASE_EXISTS', 'This employee already has an open offboarding case');
    const template = input.templateId ? await prisma.lifecycleTemplate.findUnique({ where: { id: input.templateId }, include: { tasks: { orderBy: { sortOrder: 'asc' } } } }) : null;
    if (input.templateId && (!template || template.type !== 'OFFBOARDING' || !template.isActive)) throw new AppError(422, 'VALIDATION_ERROR', 'Choose an active offboarding template', [{ field: 'templateId', message: 'Not an active offboarding template' }]);
    const hrOwnerUserId = input.hrOwnerUserId ?? actor.auth.userId;
    const caseStart = await todayForEmployee(prisma, employee.id); // Task 53: the leaver's business today
    const id = await prisma.$transaction(async (tx) => {
      const c = await tx.offboardingCase.create({ data: { employeeId: employee.id, templateId: template?.id ?? null, templateNameSnapshot: template?.name ?? null, reasonCode: input.reasonCode, reasonNote: input.reasonNote ?? null, plannedLastWorkingDate: input.plannedLastWorkingDate, ...data, hrOwnerUserId, createdByUserId: actor.auth.userId } });
      const tasks: Prisma.OffboardingTaskCreateManyInput[] = [];
      for (const [i, t] of (template?.tasks ?? []).entries()) { const a = await resolveAssignee(tx, { employeeId: employee.id, managerIdSnapshot: data.managerIdSnapshot, hrOwnerUserId }, t.assigneeType, t.specificUserId); tasks.push({ caseId: c.id, titleSnapshot: t.title, descriptionSnapshot: t.description, categorySnapshot: t.category, assigneeType: t.assigneeType, ...a, dueDate: addCalendarDays(t.relativeTo === 'CASE_START' ? caseStart : input.plannedLastWorkingDate, t.dueOffsetDays), required: t.required, requiresDocument: t.requiresDocument, sortOrder: i }); }
      if (tasks.length) await tx.offboardingTask.createMany({ data: tasks });
      await auditService.log(lifecycleAudit(actor, AUDIT_ACTIONS.CREATE_OFFBOARDING_CASE, 'OffboardingCase', c.id, { employeeCode: data.employeeCodeSnapshot, reasonCode: input.reasonCode, plannedLastWorkingDate: input.plannedLastWorkingDate, templateId: template?.id ?? null, tasks: tasks.length, ...textAudit('reasonNote', null, input.reasonNote ?? null) }), tx);
      return c.id;
    });
    return dto(prisma, actor.auth, await load(prisma, id), true);
  },
  /** Dates: changing the planned last day while active recalculates only pending task due dates; completed ones stay as history. */
  async update(id: string, input: UpdateOffboardingCaseInput, actor: Actor): Promise<OffboardingCaseDetailDto> {
    await prisma.$transaction(async (tx) => {
      await lockRow(tx, 'offboarding_cases', id);
      const before = await load(tx, id);
      if (before.status === 'COMPLETED' || before.status === 'CANCELLED') throw new AppError(409, 'OFFBOARDING_CASE_CLOSED', 'This case is closed');
      if (input.hrOwnerUserId && !(await tx.user.findUnique({ where: { id: input.hrOwnerUserId }, select: { id: true } }))) throw new AppError(422, 'VALIDATION_ERROR', 'Unknown user', [{ field: 'hrOwnerUserId', message: 'Unknown user' }]);
      const after = await tx.offboardingCase.update({ where: { id }, data: { reasonCode: input.reasonCode, reasonNote: input.reasonNote === undefined ? undefined : input.reasonNote, plannedLastWorkingDate: input.plannedLastWorkingDate, hrOwnerUserId: input.hrOwnerUserId === undefined ? undefined : input.hrOwnerUserId } });
      let shifted = 0;
      if (input.plannedLastWorkingDate && input.plannedLastWorkingDate !== before.plannedLastWorkingDate) {
        const delta = Math.round((Date.parse(`${input.plannedLastWorkingDate}T00:00:00Z`) - Date.parse(`${before.plannedLastWorkingDate}T00:00:00Z`)) / 86_400_000);
        for (const t of before.tasks) if (t.status === 'PENDING' || t.status === 'IN_PROGRESS') { await tx.offboardingTask.update({ where: { id: t.id }, data: { dueDate: addCalendarDays(t.dueDate, delta) } }); shifted += 1; }
      }
      await auditService.log(lifecycleAudit(actor, AUDIT_ACTIONS.UPDATE_OFFBOARDING_CASE, 'OffboardingCase', id, { fields: Object.keys(input).filter((k) => k !== 'reasonNote'), reasonCode: after.reasonCode, plannedLastWorkingDate: after.plannedLastWorkingDate, pendingTasksRescheduled: shifted, ...textAudit('reasonNote', before.reasonNote, after.reasonNote) }, { reasonCode: before.reasonCode, plannedLastWorkingDate: before.plannedLastWorkingDate }), tx);
    });
    return dto(prisma, actor.auth, await load(prisma, id), true);
  },
  async addTask(caseId: string, input: AddPlanTaskInput, actor: Actor): Promise<LifecycleTaskDto> {
    return prisma.$transaction(async (tx) => {
      await lockRow(tx, 'offboarding_cases', caseId);
      const c = await load(tx, caseId);
      if (c.status === 'COMPLETED' || c.status === 'CANCELLED') throw new AppError(409, 'OFFBOARDING_CASE_CLOSED', 'This case is closed');
      const a = input.assigneeType === 'SPECIFIC_USER' ? { assigneeUserId: input.assigneeUserId ?? null, assigneeEmployeeId: null } : await resolveAssignee(tx, c, input.assigneeType, null);
      const created = await tx.offboardingTask.create({ data: { caseId, titleSnapshot: input.title, descriptionSnapshot: input.description ?? null, categorySnapshot: input.category, assigneeType: input.assigneeType, ...a, dueDate: input.dueDate, required: input.required ?? true, requiresDocument: input.requiresDocument ?? false, sortOrder: c.tasks.length } });
      await auditService.log(lifecycleAudit(actor, AUDIT_ACTIONS.UPDATE_OFFBOARDING_TASK, 'OffboardingTask', created.id, { added: true, caseId, assigneeType: created.assigneeType, assigned: !!created.assigneeUserId, dueDate: created.dueDate, required: created.required }), tx);
      if (c.status !== 'DRAFT') { if (created.assigneeUserId) await notifyAssignees(tx, caseId, c.employeeNameSnapshot, [created]); await refreshReadiness(tx, caseId, actor); }
      return (await taskDtos(tx, actor.auth, [created], true, true, c.status !== 'DRAFT'))[0];
    });
  },
  async activate(id: string, actor: Actor): Promise<OffboardingCaseDetailDto> {
    await prisma.$transaction(async (tx) => {
      await lockRow(tx, 'offboarding_cases', id);
      const c = await load(tx, id);
      if (c.status !== 'DRAFT') throw new AppError(409, 'OFFBOARDING_CASE_NOT_DRAFT', `A ${c.status.toLowerCase().replace(/_/g, ' ')} case cannot be activated`);
      for (const t of c.tasks) if (!t.assigneeUserId && t.assigneeType !== 'SPECIFIC_USER') { const a = await resolveAssignee(tx, c, t.assigneeType, null); if (a.assigneeUserId) await tx.offboardingTask.update({ where: { id: t.id }, data: a }); }
      const tasks = await tx.offboardingTask.findMany({ where: { caseId: id } });
      await tx.offboardingCase.update({ where: { id }, data: { status: 'ACTIVE', activatedAt: new Date() } });
      await notifyAssignees(tx, id, c.employeeNameSnapshot, tasks);
      const emp = await tx.employee.findUnique({ where: { id: c.employeeId }, select: { user: { select: { id: true } } } });
      if (emp?.user) await notificationService.publish({ userId: emp.user.id, type: NOTIFICATION_TYPES.OFFBOARDING_STARTED, source: { module: 'lifecycle', entityType: 'OFFBOARDING_CASE', entityId: id }, data: { caseId: id }, dedupeKey: `lifecycle:offboarding:${id}:started` }, { date: c.plannedLastWorkingDate }, tx);
      await auditService.log(lifecycleAudit(actor, AUDIT_ACTIONS.ACTIVATE_OFFBOARDING_CASE, 'OffboardingCase', id, { tasks: tasks.length, unassigned: tasks.filter((t) => !t.assigneeUserId).length }), tx);
      await refreshReadiness(tx, id, actor);
    });
    return dto(prisma, actor.auth, await load(prisma, id), true);
  },
  async updateTask(taskId: string, input: UpdateTaskInput, actor: Actor): Promise<LifecycleTaskDto> {
    const { auth } = actor;
    return prisma.$transaction(async (tx) => {
      const t0 = await tx.offboardingTask.findUnique({ where: { id: taskId }, select: { caseId: true } });
      if (!t0) throw notFound('task');
      await lockRow(tx, 'offboarding_cases', t0.caseId);
      await lockRow(tx, 'offboarding_tasks', taskId);
      const before = await tx.offboardingTask.findUniqueOrThrow({ where: { id: taskId } });
      const c = await load(tx, before.caseId);
      const manage = has(auth, P.OFFBOARDING_MANAGE);
      const mine = before.assigneeUserId === auth.userId && has(auth, P.OFFBOARDING_COMPLETE_TASKS);
      if (!manage && !mine) throw AppError.forbidden('Only the assignee or an offboarding manager can update this task');
      if (c.status !== 'ACTIVE' && c.status !== 'READY_TO_COMPLETE') throw new AppError(409, 'OFFBOARDING_CASE_NOT_ACTIVE', 'Tasks can be worked while the case is active');
      if ((input.assigneeUserId !== undefined || input.dueDate !== undefined) && !manage) throw AppError.forbidden('Reassigning or rescheduling a task needs offboarding.manage');
      if (input.status) {
        if (!TASK_TRANSITIONS[before.status as keyof typeof TASK_TRANSITIONS].includes(input.status)) throw new AppError(409, 'LIFECYCLE_TASK_INVALID_TRANSITION', `A ${before.status.toLowerCase()} task cannot become ${input.status.toLowerCase()}`);
        if ((input.status === 'SKIPPED' || input.status === 'CANCELLED') && before.required && !manage) throw AppError.forbidden('A required task can be skipped only by an offboarding manager');
        if (input.status === 'COMPLETED' && before.requiresDocument && !before.documentId && !input.documentId) throw new AppError(422, 'LIFECYCLE_TASK_DOCUMENT_REQUIRED', 'This task needs a document before it can be completed');
      }
      if (input.documentId) {
        const doc = await tx.document.findUnique({ where: { id: input.documentId }, include: { category: true, links: true, ownerEmployee: { select: { id: true, employeeCode: true, firstName: true, lastName: true, managerId: true } } } });
        if (!doc || !canAccessDocument(auth, doc)) throw new AppError(404, 'DOCUMENT_NOT_FOUND', 'Document not found');
        await linkDocumentWithTx(tx, input.documentId, { entityType: 'OFFBOARDING_TASK', entityId: taskId, relationType: 'TASK_EVIDENCE' }, actor);
      }
      const done = input.status === 'COMPLETED' || input.status === 'SKIPPED';
      const after = await tx.offboardingTask.update({ where: { id: taskId }, data: { status: input.status, note: input.note === undefined ? undefined : input.note, documentId: input.documentId === undefined ? undefined : input.documentId, assigneeUserId: input.assigneeUserId === undefined ? undefined : input.assigneeUserId, dueDate: input.dueDate, ...(done ? { completedAt: new Date(), completedByUserId: auth.userId } : {}) } });
      await auditService.log(lifecycleAudit(actor, AUDIT_ACTIONS.UPDATE_OFFBOARDING_TASK, 'OffboardingTask', taskId, { caseId: c.id, status: after.status, documentLinked: !!input.documentId, assigneeChanged: input.assigneeUserId !== undefined, dueDate: after.dueDate, ...textAudit('note', before.note, after.note) }, { status: before.status }), tx);
      await refreshReadiness(tx, c.id, actor);
      return (await taskDtos(tx, auth, [after], manage, has(auth, P.OFFBOARDING_COMPLETE_TASKS), true))[0];
    });
  },

  /**
   * The separation. One transaction, under the case lock: verify READY_TO_COMPLETE and not already completed;
   * separate the employee through the employees domain (status, termination date, open position and manager history
   * rows); disable the linked account and revoke its sessions through the users domain unless HR keeps it; mark the
   * case COMPLETED; audit; notify the HR owner. A concurrent second call, or a concurrent cancel, sees the lock and
   * then the changed status, and is refused. Nothing here touches payroll, leave, documents or recruitment.
   */
  async completeSeparation(id: string, input: CompleteSeparationInput, actor: Actor): Promise<OffboardingCaseDetailDto> {
    await prisma.$transaction(async (tx) => {
      await lockRow(tx, 'offboarding_cases', id);
      const c = await load(tx, id);
      if (c.status === 'COMPLETED') throw new AppError(409, 'OFFBOARDING_ALREADY_COMPLETED', 'This separation was already completed');
      if (c.status !== 'READY_TO_COMPLETE') throw new AppError(409, 'OFFBOARDING_NOT_READY', `The case is ${c.status.toLowerCase().replace(/_/g, ' ')}; every required task must be done first`);
      const lastDay = input.actualLastWorkingDate ?? c.plannedLastWorkingDate;
      const sep = await separateEmployeeWithTx(tx, c.employeeId, { terminationDate: lastDay, reason: `OFFBOARDING:${c.reasonCode}` }, actor);
      let account = { disabled: false, sessionsRevoked: 0 };
      if (sep.userId && input.disableAccount !== false) account = await deactivateUserWithTx(tx, sep.userId, actor, `OFFBOARDING:${id}`);
      await tx.offboardingTask.updateMany({ where: { caseId: id, status: { in: ['PENDING', 'IN_PROGRESS'] } }, data: { status: 'CANCELLED' } });
      await tx.offboardingCase.update({ where: { id }, data: { status: 'COMPLETED', completedAt: new Date(), actualLastWorkingDate: lastDay, separationAccountDisabled: account.disabled, separationSessionsRevoked: account.sessionsRevoked } });
      await auditService.log(lifecycleAudit(actor, AUDIT_ACTIONS.COMPLETE_EMPLOYMENT_SEPARATION, 'OffboardingCase', id, { employeeCode: sep.employeeCode, reasonCode: c.reasonCode, actualLastWorkingDate: lastDay, accountDisabled: account.disabled, sessionsRevoked: account.sessionsRevoked }), tx);
      if (c.hrOwnerUserId && c.hrOwnerUserId !== actor.auth.userId) await notificationService.publish({ userId: c.hrOwnerUserId, type: NOTIFICATION_TYPES.OFFBOARDING_COMPLETED, source: { module: 'lifecycle', entityType: 'OFFBOARDING_CASE', entityId: id }, data: { caseId: id }, dedupeKey: `lifecycle:offboarding:${id}:completed` }, { employeeName: c.employeeNameSnapshot, date: lastDay }, tx);
    });
    return dto(prisma, actor.auth, await load(prisma, id), true);
  },
  /** Cancel: the employee stays, the account stays, tasks are cancelled but kept. Refused once the separation completed. */
  async cancel(id: string, actor: Actor): Promise<OffboardingCaseDetailDto> {
    await prisma.$transaction(async (tx) => {
      await lockRow(tx, 'offboarding_cases', id);
      const c = await load(tx, id);
      if (c.status === 'COMPLETED' || c.status === 'CANCELLED') throw new AppError(409, 'OFFBOARDING_CASE_CLOSED', `A ${c.status.toLowerCase()} case cannot be cancelled`);
      await tx.offboardingTask.updateMany({ where: { caseId: id, status: { in: ['PENDING', 'IN_PROGRESS'] } }, data: { status: 'CANCELLED' } });
      await tx.offboardingCase.update({ where: { id }, data: { status: 'CANCELLED', cancelledAt: new Date() } });
      await auditService.log(lifecycleAudit(actor, AUDIT_ACTIONS.CANCEL_OFFBOARDING_CASE, 'OffboardingCase', id, { from: c.status }), tx);
    });
    return dto(prisma, actor.auth, await load(prisma, id), true);
  },
  async recordExitInterview(id: string, input: ExitInterviewInput, actor: Actor): Promise<OffboardingCaseDetailDto> {
    await prisma.$transaction(async (tx) => {
      await lockRow(tx, 'offboarding_cases', id);
      const c = await load(tx, id);
      if (c.status === 'CANCELLED') throw new AppError(409, 'OFFBOARDING_CASE_CLOSED', 'A cancelled case has no exit interview');
      await tx.offboardingCase.update({ where: { id }, data: { exitInterviewDate: input.interviewDate, exitReasonCategory: input.reasonCategory ?? null, exitWouldRejoin: input.wouldRejoin ?? null, exitInterviewNote: input.note ?? null, exitInterviewerUserId: actor.auth.userId } });
      await auditService.log(lifecycleAudit(actor, AUDIT_ACTIONS.RECORD_EXIT_INTERVIEW, 'OffboardingCase', id, { interviewDate: input.interviewDate, reasonCategory: input.reasonCategory ?? null, wouldRejoin: input.wouldRejoin ?? null, ...textAudit('note', c.exitInterviewNote, input.note ?? null) }), tx);
    });
    return dto(prisma, actor.auth, await load(prisma, id), true);
  },
  async mine(auth: AuthContext): Promise<OffboardingCaseDetailDto | null> {
    if (!auth.employeeId) return null;
    const r = await prisma.offboardingCase.findFirst({ where: { employeeId: auth.employeeId, status: { in: ['ACTIVE', 'READY_TO_COMPLETE', 'COMPLETED'] } }, include, orderBy: { createdAt: 'desc' } });
    return r ? dto(prisma, auth, r, true) : null;
  },
};
