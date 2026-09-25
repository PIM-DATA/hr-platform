import { AUDIT_ACTIONS, NOTIFICATION_TYPES, certificationStatus, type CreateLearningPathInput, type LearningPathDto, type PathAssignmentDto, type PathAssignmentStepDto, type UpdateLearningPathInput } from '@hr/shared';
import type { Prisma } from '@prisma/client';
import { AppError } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { auditService } from '../../services/audit/audit.service';
import { notificationService } from '../../services/notification/notification.service';
import type { AuthContext } from '../auth/auth.types';
import { P, employeeSnapshot, has, learningAudit, lockRow, notFound, scopedEmployeeIds, snapshotDto, textAudit, today, userNames, type Actor, type Db } from './learning.types';

/**
 * Learning paths: an ordered list of steps (course, OJT program, IDP activity, certification) with an optional
 * prerequisite each. An assignment copies the steps; a step's fulfilment is a projection of the source domain —
 * a completed enrolment, a completed OJT plan, a valid certification — or, for an IDP activity, a person's
 * explicit confirmation citing the completed IDP item. Completing a path promotes nobody and changes no level.
 */
const pathInclude = { steps: { orderBy: { sequence: 'asc' as const } }, _count: { select: { assignments: true } } };
type PathRow = Prisma.LearningPathGetPayload<{ include: typeof pathInclude }>;
async function pathDto(db: Db, r: PathRow): Promise<LearningPathDto> {
  const job = r.targetJobId ? await db.job.findUnique({ where: { id: r.targetJobId }, select: { title: true } }) : null;
  return { id: r.id, code: r.code, name: r.name, description: r.description, organizationId: r.organizationId, targetJobId: r.targetJobId, targetJobTitle: job?.title ?? null, isActive: r.isActive, steps: r.steps.map((s) => ({ id: s.id, stepType: s.stepType as LearningPathDto['steps'][number]['stepType'], referenceId: s.referenceId, title: s.titleSnapshot, sequence: s.sequence, required: s.required, prerequisiteStepId: s.prerequisiteStepId })), assignmentCount: r._count.assignments, createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString() };
}
/** Validates references and resolves the title of each step from its source master. */
async function resolveSteps(db: Db, steps: { stepType: string; referenceId?: string | null; title?: string; required?: boolean; prerequisiteIndex?: number | null }[]) {
  const out: { stepType: string; referenceId: string | null; titleSnapshot: string; required: boolean; prerequisiteIndex: number | null }[] = [];
  for (const [i, s] of steps.entries()) {
    let title = s.title ?? '';
    if (s.stepType === 'COURSE') { const c = await db.trainingCourse.findUnique({ where: { id: s.referenceId! }, select: { title: true } }); if (!c) throw new AppError(422, 'VALIDATION_ERROR', 'Unknown course', [{ field: 'steps', message: `Step ${i + 1}: unknown course` }]); title = title || c.title; }
    if (s.stepType === 'OJT_PROGRAM') { const p = await db.ojtProgram.findUnique({ where: { id: s.referenceId! }, select: { name: true } }); if (!p) throw new AppError(422, 'VALIDATION_ERROR', 'Unknown OJT program', [{ field: 'steps', message: `Step ${i + 1}: unknown program` }]); title = title || p.name; }
    if (s.stepType === 'CERTIFICATION') { const d = await db.certificationDefinition.findUnique({ where: { id: s.referenceId! }, select: { name: true } }); if (!d) throw new AppError(422, 'VALIDATION_ERROR', 'Unknown certification', [{ field: 'steps', message: `Step ${i + 1}: unknown certification` }]); title = title || d.name; }
    if (s.prerequisiteIndex !== null && s.prerequisiteIndex !== undefined && (s.prerequisiteIndex >= i || s.prerequisiteIndex < 0)) throw new AppError(422, 'VALIDATION_ERROR', 'A prerequisite must be an earlier step', [{ field: 'steps', message: `Step ${i + 1}: prerequisite must come before it` }]);
    out.push({ stepType: s.stepType, referenceId: s.stepType === 'IDP_ACTIVITY' ? null : (s.referenceId ?? null), titleSnapshot: title, required: s.required ?? true, prerequisiteIndex: s.prerequisiteIndex ?? null });
  }
  return out;
}
async function createSteps(tx: Prisma.TransactionClient, pathId: string, steps: Awaited<ReturnType<typeof resolveSteps>>) {
  const created: { id: string }[] = [];
  for (const [i, s] of steps.entries()) created.push(await tx.learningPathStep.create({ data: { pathId, stepType: s.stepType, referenceId: s.referenceId, titleSnapshot: s.titleSnapshot, sequence: i + 1, required: s.required, prerequisiteStepId: s.prerequisiteIndex !== null ? created[s.prerequisiteIndex].id : null } }));
}

export const learningPathService = {
  async list(q: { includeInactive?: boolean }): Promise<LearningPathDto[]> { return Promise.all((await prisma.learningPath.findMany({ where: q.includeInactive ? {} : { isActive: true }, include: pathInclude, orderBy: { name: 'asc' } })).map((r) => pathDto(prisma, r))); },
  async get(id: string): Promise<LearningPathDto> { const r = await prisma.learningPath.findUnique({ where: { id }, include: pathInclude }); if (!r) throw notFound('learning path'); return pathDto(prisma, r); },
  async create(input: CreateLearningPathInput, actor: Actor): Promise<LearningPathDto> {
    if (await prisma.learningPath.findUnique({ where: { code: input.code.toUpperCase() } })) throw new AppError(409, 'LEARNING_PATH_CODE_EXISTS', 'A path with this code already exists');
    if (input.targetJobId && !(await prisma.job.findUnique({ where: { id: input.targetJobId }, select: { id: true } }))) throw new AppError(422, 'VALIDATION_ERROR', 'Unknown job', [{ field: 'targetJobId', message: 'Unknown job' }]);
    const steps = await resolveSteps(prisma, input.steps ?? []);
    const id = await prisma.$transaction(async (tx) => {
      const p = await tx.learningPath.create({ data: { code: input.code.toUpperCase(), name: input.name, description: input.description ?? null, organizationId: input.organizationId ?? null, targetJobId: input.targetJobId ?? null } });
      await createSteps(tx, p.id, steps);
      await auditService.log(learningAudit(actor, AUDIT_ACTIONS.CREATE_LEARNING_PATH, 'LearningPath', p.id, { code: p.code, name: p.name, steps: steps.length, targetJobId: p.targetJobId }), tx);
      return p.id;
    });
    return this.get(id);
  },
  async update(id: string, input: UpdateLearningPathInput, actor: Actor): Promise<LearningPathDto> {
    const steps = input.steps ? await resolveSteps(prisma, input.steps) : null;
    await prisma.$transaction(async (tx) => {
      const before = await tx.learningPath.findUnique({ where: { id }, include: pathInclude }); if (!before) throw notFound('learning path');
      if (steps) { await tx.learningPathStep.deleteMany({ where: { pathId: id } }); await createSteps(tx, id, steps); }
      await tx.learningPath.update({ where: { id }, data: { name: input.name, description: input.description === undefined ? undefined : input.description, organizationId: input.organizationId === undefined ? undefined : input.organizationId, targetJobId: input.targetJobId === undefined ? undefined : input.targetJobId, isActive: input.isActive } });
      await auditService.log(learningAudit(actor, AUDIT_ACTIONS.UPDATE_LEARNING_PATH, 'LearningPath', id, { fields: Object.keys(input), steps: steps?.length ?? before.steps.length, isActive: input.isActive ?? before.isActive }, { steps: before.steps.length }), tx);
    });
    return this.get(id);
  },
};

// ---------------------------------------------------------------------------------------------------------------
const asgInclude = { steps: { orderBy: { sequence: 'asc' as const } } };
type AsgRow = Prisma.LearningPathAssignmentGetPayload<{ include: typeof asgInclude }>;
async function loadAssignment(db: Db, id: string) { const r = await db.learningPathAssignment.findUnique({ where: { id }, include: asgInclude }); if (!r) throw notFound('learning path assignment'); return r; }

/** Projects each step's fulfilment from its source domain and caches it. Called before every read of an assignment. */
async function refresh(db: Db, r: AsgRow): Promise<AsgRow> {
  if (r.status !== 'ACTIVE') return r;
  const t = today(); let changed = false;
  for (const s of r.steps) {
    if (s.fulfilledAt) continue;
    let sourceId: string | null = null;
    if (s.stepType === 'COURSE' && s.referenceId) { const e = await db.trainingEnrollment.findFirst({ where: { employeeId: r.employeeId, status: 'COMPLETED', session: { courseId: s.referenceId } }, select: { id: true } }); sourceId = e?.id ?? null; }
    if (s.stepType === 'OJT_PROGRAM' && s.referenceId) { const p = await db.ojtPlan.findFirst({ where: { employeeId: r.employeeId, programId: s.referenceId, status: 'COMPLETED' }, select: { id: true } }); sourceId = p?.id ?? null; }
    if (s.stepType === 'CERTIFICATION' && s.referenceId) { const rows = await db.employeeCertification.findMany({ where: { employeeId: r.employeeId, definitionId: s.referenceId, revokedAt: null }, select: { id: true, expiryDate: true } }); const valid = rows.find((c) => certificationStatus({ expiryDate: c.expiryDate, revokedAt: null }, t) !== 'EXPIRED'); sourceId = valid?.id ?? null; }
    if (sourceId) { await db.learningPathAssignmentStep.update({ where: { id: s.id }, data: { fulfilledAt: new Date(), fulfilledSourceId: sourceId } }); changed = true; }
  }
  if (!changed) return r;
  const again = await loadAssignment(db, r.id);
  if (again.steps.filter((s) => s.required).every((s) => s.fulfilledAt)) return loadAssignment(db, (await db.learningPathAssignment.update({ where: { id: r.id }, data: { status: 'COMPLETED', completedAt: new Date() } })).id);
  return again;
}
async function asgDto(db: Db, auth: AuthContext, r: AsgRow): Promise<PathAssignmentDto> {
  const names = await userNames(db, [r.assignedByUserId, ...r.steps.map((s) => s.fulfilledByUserId)]);
  const bySeq = new Map(r.steps.map((s) => [s.sequence, s]));
  const steps: PathAssignmentStepDto[] = r.steps.map((s) => { const pre = s.prerequisiteSequence !== null ? bySeq.get(s.prerequisiteSequence) : null; const state: PathAssignmentStepDto['state'] = s.fulfilledAt ? 'FULFILLED' : pre && !pre.fulfilledAt ? 'LOCKED' : 'AVAILABLE'; return { id: s.id, stepType: s.stepType as PathAssignmentStepDto['stepType'], referenceId: s.referenceId, title: s.titleSnapshot, sequence: s.sequence, required: s.required, prerequisiteStepId: pre?.id ?? null, state, fulfilledAt: s.fulfilledAt?.toISOString() ?? null, fulfilledBy: s.fulfilledByUserId ? (names.get(s.fulfilledByUserId) ?? null) : null, sourceLabel: s.fulfilledSourceId ? (s.stepType === 'IDP_ACTIVITY' ? 'Development plan activity' : s.stepType === 'COURSE' ? 'Training enrolment' : s.stepType === 'OJT_PROGRAM' ? 'OJT plan' : 'Certification') : null }; });
  const fulfilled = steps.filter((s) => s.state === 'FULFILLED').length;
  return { id: r.id, pathId: r.pathId, pathName: r.pathNameSnapshot, employeeId: r.employeeId, snapshot: snapshotDto(r), targetJobTitle: r.targetJobTitleSnapshot, assignedByName: names.get(r.assignedByUserId) ?? null, assignedAt: r.assignedAt.toISOString(), targetDate: r.targetDate, status: r.status as PathAssignmentDto['status'], completedAt: r.completedAt?.toISOString() ?? null, progress: { total: steps.length, fulfilled, pct: steps.length ? Math.round((fulfilled / steps.length) * 1000) / 10 : 0, requiredOpen: steps.filter((s) => s.required && s.state !== 'FULFILLED').length }, steps, can: { manage: has(auth, P.LEARNING_PATH_MANAGE) } };
}
async function visibleWhere(auth: AuthContext): Promise<Prisma.LearningPathAssignmentWhereInput> { const ids = await scopedEmployeeIds(auth); return ids === null ? {} : { employeeId: { in: ids } }; }

export const pathAssignmentService = {
  async list(auth: AuthContext, q: { page: number; pageSize: number; status?: string; pathId?: string; departmentId?: string }) {
    const where: Prisma.LearningPathAssignmentWhereInput = { ...(await visibleWhere(auth)), status: q.status, pathId: q.pathId, departmentIdSnapshot: q.departmentId };
    const [total, rows] = await prisma.$transaction([prisma.learningPathAssignment.count({ where }), prisma.learningPathAssignment.findMany({ where, include: asgInclude, orderBy: { assignedAt: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize })]);
    const refreshed = []; for (const r of rows) refreshed.push(await refresh(prisma, r));
    return { data: await Promise.all(refreshed.map((r) => asgDto(prisma, auth, r))), meta: { page: q.page, pageSize: q.pageSize, total } };
  },
  async get(auth: AuthContext, id: string): Promise<PathAssignmentDto> {
    const visible = await prisma.learningPathAssignment.findFirst({ where: { AND: [{ id }, await visibleWhere(auth)] }, select: { id: true } });
    if (!visible) throw notFound('learning path assignment');
    return asgDto(prisma, auth, await refresh(prisma, await loadAssignment(prisma, id)));
  },
  async forEmployee(auth: AuthContext, employeeId: string): Promise<PathAssignmentDto[]> {
    const rows = await prisma.learningPathAssignment.findMany({ where: { employeeId, status: { not: 'CANCELLED' } }, include: asgInclude, orderBy: { assignedAt: 'desc' } });
    const out = []; for (const r of rows) out.push(await asgDto(prisma, auth, await refresh(prisma, r))); return out;
  },
  /** A person assigns a path. One active assignment per employee and path. */
  async assign(pathId: string, input: { employeeId: string; targetDate?: string | null }, actor: Actor): Promise<PathAssignmentDto> {
    const path = await prisma.learningPath.findUnique({ where: { id: pathId }, include: pathInclude });
    if (!path || !path.isActive) throw new AppError(422, 'VALIDATION_ERROR', 'Choose an active learning path', [{ field: 'pathId', message: 'Not an active path' }]);
    const { employee, data } = await employeeSnapshot(prisma, input.employeeId);
    if (employee.employmentStatus !== 'ACTIVE') throw new AppError(409, 'EMPLOYEE_NOT_ACTIVE', 'A learning path needs an active employee record');
    const job = path.targetJobId ? await prisma.job.findUnique({ where: { id: path.targetJobId }, select: { title: true } }) : null;
    const id = await prisma.$transaction(async (tx) => {
      if (await tx.learningPathAssignment.findFirst({ where: { pathId, employeeId: employee.id, status: 'ACTIVE' }, select: { id: true } })) throw new AppError(409, 'LEARNING_PATH_ALREADY_ASSIGNED', 'This employee already has this path in progress');
      const a = await tx.learningPathAssignment.create({ data: { pathId, pathNameSnapshot: path.name, targetJobTitleSnapshot: job?.title ?? null, employeeId: employee.id, ...data, assignedByUserId: actor.auth.userId, targetDate: input.targetDate ?? null } });
      const seqOf = new Map(path.steps.map((s) => [s.id, s.sequence]));
      await tx.learningPathAssignmentStep.createMany({ data: path.steps.map((s) => ({ assignmentId: a.id, stepType: s.stepType, referenceId: s.referenceId, titleSnapshot: s.titleSnapshot, sequence: s.sequence, required: s.required, prerequisiteSequence: s.prerequisiteStepId ? (seqOf.get(s.prerequisiteStepId) ?? null) : null })) });
      if (employee.user?.isActive) await notificationService.publish({ userId: employee.user.id, type: NOTIFICATION_TYPES.LEARNING_PATH_ASSIGNED, source: { module: 'learning', entityType: 'LEARNING_PATH_ASSIGNMENT', entityId: a.id }, data: { assignmentId: a.id }, dedupeKey: `learning:path:${a.id}:assigned` }, { courseTitle: path.name, date: input.targetDate ?? undefined }, tx);
      await auditService.log(learningAudit(actor, AUDIT_ACTIONS.ASSIGN_LEARNING_PATH, 'LearningPathAssignment', a.id, { pathId, employeeCode: data.employeeCodeSnapshot, steps: path.steps.length, targetDate: input.targetDate ?? null }), tx);
      return a.id;
    });
    return this.get(actor.auth, id);
  },
  /** An IDP-activity step is confirmed by a person citing the completed IDP item; the item is read, never written. */
  async fulfilStep(assignmentId: string, stepId: string, input: { idpItemId?: string | null; note?: string | null }, actor: Actor): Promise<PathAssignmentDto> {
    await prisma.$transaction(async (tx) => {
      await lockRow(tx, 'learning_path_assignments', assignmentId);
      const a = await loadAssignment(tx, assignmentId);
      if (a.status !== 'ACTIVE') throw new AppError(409, 'LEARNING_PATH_ASSIGNMENT_CLOSED', 'This assignment is closed');
      const s = a.steps.find((x) => x.id === stepId); if (!s) throw notFound('step');
      if (s.stepType !== 'IDP_ACTIVITY') throw new AppError(409, 'LEARNING_STEP_NOT_MANUAL', 'Only development-plan activity steps are confirmed by hand; the others follow their source');
      if (s.fulfilledAt) throw new AppError(409, 'LEARNING_STEP_ALREADY_FULFILLED', 'This step is already fulfilled');
      if (input.idpItemId) { const it = await tx.idpItem.findUnique({ where: { id: input.idpItemId }, select: { status: true, idp: { select: { employeeId: true } } } }); if (!it || it.idp.employeeId !== a.employeeId) throw new AppError(422, 'VALIDATION_ERROR', 'That development activity is not this employee\'s', [{ field: 'idpItemId', message: 'Mismatch' }]); if (it.status !== 'COMPLETED') throw new AppError(409, 'IDP_ITEM_NOT_COMPLETED', 'The development activity is not completed yet'); }
      await tx.learningPathAssignmentStep.update({ where: { id: stepId }, data: { fulfilledAt: new Date(), fulfilledSourceId: input.idpItemId ?? null, fulfilledByUserId: actor.auth.userId, note: input.note ?? null } });
      await auditService.log(learningAudit(actor, AUDIT_ACTIONS.UPDATE_LEARNING_PATH_ASSIGNMENT, 'LearningPathAssignment', assignmentId, { stepFulfilled: stepId, idpItemId: input.idpItemId ?? null, ...textAudit('note', null, input.note ?? null) }), tx);
    });
    return this.get(actor.auth, assignmentId);
  },
  async cancel(id: string, actor: Actor): Promise<PathAssignmentDto> {
    await prisma.$transaction(async (tx) => {
      await lockRow(tx, 'learning_path_assignments', id);
      const a = await loadAssignment(tx, id);
      if (a.status !== 'ACTIVE') throw new AppError(409, 'LEARNING_PATH_ASSIGNMENT_CLOSED', 'This assignment is closed');
      await tx.learningPathAssignment.update({ where: { id }, data: { status: 'CANCELLED', cancelledAt: new Date() } });
      await auditService.log(learningAudit(actor, AUDIT_ACTIONS.CANCEL_LEARNING_PATH, 'LearningPathAssignment', id, { pathId: a.pathId }), tx);
    });
    return asgDto(prisma, actor.auth, await loadAssignment(prisma, id));
  },
};
