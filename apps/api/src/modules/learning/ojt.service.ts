import { AUDIT_ACTIONS, NOTIFICATION_TYPES, activityCompletionBlockers, ojtProgress, type CompetencyEvidenceDto, type CreateOjtPlanInput, type CreateOjtProgramInput, type OjtPlanActivityDto, type OjtPlanDetailDto, type OjtPlanDto, type OjtProgramDto, type SubmitObservationInput, type SubmitOjtAssessmentInput, type UpdateOjtActivityInput, type UpdateOjtPlanInput, type UpdateOjtProgramInput } from '@hr/shared';
import type { Prisma } from '@prisma/client';
import { AppError } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { auditService } from '../../services/audit/audit.service';
import { notificationService } from '../../services/notification/notification.service';
import type { AuthContext } from '../auth/auth.types';
import { canAccessDocument, linkDocumentWithTx } from '../documents/documents.service';
import { trainingNeedService } from '../training/training-need.service';
import { todayForEmployee } from '../../services/business-time/business-time';
import { P, employeeSnapshot, has, learningAudit, lockRow, nextPlanNumber, notFound, scopedEmployeeIds, snapshotDto, textAudit, userNames, type Actor, type Db } from './learning.types';

/**
 * OJT: a reusable program (objectives, activities, observation criteria) and one plan per trainee that copies it.
 * The trainer HR chose records observations — evidence, not scores — and a final outcome; the trainee works
 * activities, writes reflections and links evidence. Completing a plan writes no competency level anywhere; the
 * explicit handoff creates evidence pointers a competency assessor can read later.
 */
const programInclude = { competencies: true, activities: { orderBy: { sequence: 'asc' as const }, include: { criteria: { orderBy: { sequence: 'asc' as const } } } }, _count: { select: { plans: true } } };
type ProgramRow = Prisma.OjtProgramGetPayload<{ include: typeof programInclude }>;
async function programDto(db: Db, r: ProgramRow): Promise<OjtProgramDto> {
  const [org, job, comps] = await Promise.all([r.organizationId ? db.organization.findUnique({ where: { id: r.organizationId }, select: { name: true } }) : null, r.jobId ? db.job.findUnique({ where: { id: r.jobId }, select: { title: true } }) : null, db.competency.findMany({ where: { id: { in: r.competencies.map((c) => c.competencyId) } }, select: { id: true, code: true, name: true } })]);
  const byId = new Map(comps.map((c) => [c.id, c]));
  return { id: r.id, code: r.code, name: r.name, description: r.description, organizationId: r.organizationId, organizationName: org?.name ?? null, jobId: r.jobId, jobTitle: job?.title ?? null, durationDays: r.durationDays, isActive: r.isActive, competencies: r.competencies.map((c) => ({ competencyId: c.competencyId, competencyCode: byId.get(c.competencyId)?.code ?? '?', competencyName: byId.get(c.competencyId)?.name ?? '?', targetLevel: c.targetLevel, importance: c.importance, description: c.description })), activities: r.activities.map((a) => ({ id: a.id, title: a.title, description: a.description, activityType: a.activityType as OjtProgramDto['activities'][number]['activityType'], sequence: a.sequence, required: a.required, expectedDays: a.expectedDays, documentEvidenceRequired: a.documentEvidenceRequired, criteria: a.criteria.map((c) => ({ id: c.id, criterion: c.criterion, required: c.required, sequence: c.sequence })) })), planCount: r._count.plans, createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString() };
}
async function validateProgramRefs(db: Db, input: { organizationId?: string | null; jobId?: string | null; competencies?: { competencyId: string; targetLevel?: number | null }[] }) {
  if (input.organizationId && !(await db.organization.findUnique({ where: { id: input.organizationId }, select: { id: true } }))) throw new AppError(422, 'VALIDATION_ERROR', 'Unknown organization', [{ field: 'organizationId', message: 'Unknown organization' }]);
  if (input.jobId && !(await db.job.findUnique({ where: { id: input.jobId }, select: { id: true } }))) throw new AppError(422, 'VALIDATION_ERROR', 'Unknown job', [{ field: 'jobId', message: 'Unknown job' }]);
  for (const c of input.competencies ?? []) {
    const comp = await db.competency.findUnique({ where: { id: c.competencyId }, select: { id: true, scale: { select: { levels: { select: { level: true } } } } } });
    if (!comp) throw new AppError(422, 'VALIDATION_ERROR', 'Unknown competency', [{ field: 'competencies', message: `Unknown competency ${c.competencyId}` }]);
    // The target level is an expected level of evidence on the competency's own scale — never a level the plan grants.
    if (c.targetLevel != null && !comp.scale.levels.some((l) => l.level === c.targetLevel)) throw new AppError(422, 'VALIDATION_ERROR', 'Target level is not on the competency scale', [{ field: 'competencies', message: `Level ${c.targetLevel} is not on the scale of competency ${c.competencyId}` }]);
  }
}

export const ojtProgramService = {
  async list(q: { includeInactive?: boolean }): Promise<OjtProgramDto[]> { return Promise.all((await prisma.ojtProgram.findMany({ where: q.includeInactive ? {} : { isActive: true }, include: programInclude, orderBy: { name: 'asc' } })).map((r) => programDto(prisma, r))); },
  async get(id: string): Promise<OjtProgramDto> { const r = await prisma.ojtProgram.findUnique({ where: { id }, include: programInclude }); if (!r) throw notFound('OJT program'); return programDto(prisma, r); },
  async create(input: CreateOjtProgramInput, actor: Actor): Promise<OjtProgramDto> {
    if (await prisma.ojtProgram.findUnique({ where: { code: input.code.toUpperCase() } })) throw new AppError(409, 'OJT_PROGRAM_CODE_EXISTS', 'A program with this code already exists');
    await validateProgramRefs(prisma, input);
    const row = await prisma.$transaction(async (tx) => {
      const created = await tx.ojtProgram.create({ data: { code: input.code.toUpperCase(), name: input.name, description: input.description ?? null, organizationId: input.organizationId ?? null, jobId: input.jobId ?? null, durationDays: input.durationDays ?? null, createdByUserId: actor.auth.userId,
        competencies: { create: (input.competencies ?? []).map((c) => ({ competencyId: c.competencyId, targetLevel: c.targetLevel ?? null, importance: c.importance ?? null, description: c.description ?? null })) },
        activities: { create: (input.activities ?? []).map((a, i) => ({ title: a.title, description: a.description ?? null, activityType: a.activityType, sequence: i + 1, required: a.required ?? true, expectedDays: a.expectedDays ?? null, documentEvidenceRequired: a.documentEvidenceRequired ?? false, criteria: { create: (a.criteria ?? []).map((c, j) => ({ criterion: c.criterion, sequence: j + 1, required: c.required ?? true })) } })) } }, include: programInclude });
      await auditService.log(learningAudit(actor, AUDIT_ACTIONS.CREATE_OJT_PROGRAM, 'OjtProgram', created.id, { code: created.code, name: created.name, competencies: created.competencies.length, activities: created.activities.length }), tx);
      return created;
    });
    return programDto(prisma, row);
  },
  /** Replaces objectives / activities when given. Plans already created keep their own copies. */
  async update(id: string, input: UpdateOjtProgramInput, actor: Actor): Promise<OjtProgramDto> {
    await validateProgramRefs(prisma, input);
    const row = await prisma.$transaction(async (tx) => {
      const before = await tx.ojtProgram.findUnique({ where: { id }, include: programInclude }); if (!before) throw notFound('OJT program');
      if (input.competencies) await tx.ojtProgramCompetency.deleteMany({ where: { programId: id } });
      if (input.activities) { await tx.ojtActivityCriterion.deleteMany({ where: { activity: { programId: id } } }); await tx.ojtProgramActivity.deleteMany({ where: { programId: id } }); }
      const after = await tx.ojtProgram.update({ where: { id }, data: { name: input.name, description: input.description === undefined ? undefined : input.description, organizationId: input.organizationId === undefined ? undefined : input.organizationId, jobId: input.jobId === undefined ? undefined : input.jobId, durationDays: input.durationDays === undefined ? undefined : input.durationDays, isActive: input.isActive,
        ...(input.competencies ? { competencies: { create: input.competencies.map((c) => ({ competencyId: c.competencyId, targetLevel: c.targetLevel ?? null, importance: c.importance ?? null, description: c.description ?? null })) } } : {}),
        ...(input.activities ? { activities: { create: input.activities.map((a, i) => ({ title: a.title, description: a.description ?? null, activityType: a.activityType, sequence: i + 1, required: a.required ?? true, expectedDays: a.expectedDays ?? null, documentEvidenceRequired: a.documentEvidenceRequired ?? false, criteria: { create: (a.criteria ?? []).map((c, j) => ({ criterion: c.criterion, sequence: j + 1, required: c.required ?? true })) } })) } } : {}) }, include: programInclude });
      await auditService.log(learningAudit(actor, AUDIT_ACTIONS.UPDATE_OJT_PROGRAM, 'OjtProgram', id, { fields: Object.keys(input), activities: after.activities.length, competencies: after.competencies.length, isActive: after.isActive }, { activities: before.activities.length, competencies: before.competencies.length }), tx);
      return after;
    });
    return programDto(prisma, row);
  },
};

// ---------------------------------------------------------------------------------------------------------------
const planInclude = { competencies: true, activities: { orderBy: { sequence: 'asc' as const }, include: { criteria: { orderBy: { sequence: 'asc' as const } }, observations: true } }, assessments: { orderBy: { submittedAt: 'asc' as const } } };
type PlanRow = Prisma.OjtPlanGetPayload<{ include: typeof planInclude }>;
async function loadPlan(db: Db, id: string) { const r = await db.ojtPlan.findUnique({ where: { id }, include: planInclude }); if (!r) throw notFound('OJT plan'); return r; }
const isTrainer = (auth: AuthContext, r: { trainerUserId: string | null }) => !!r.trainerUserId && r.trainerUserId === auth.userId;
const isTrainee = (auth: AuthContext, r: { employeeId: string }) => !!auth.employeeId && r.employeeId === auth.employeeId;

async function planDto(db: Db, auth: AuthContext, r: PlanRow, withActivities: boolean): Promise<OjtPlanDetailDto> {
  const manage = has(auth, P.OJT_MANAGE);
  const trainer = isTrainer(auth, r) && has(auth, P.OJT_TRAIN);
  const trainee = isTrainee(auth, r);
  const seesTrainerText = manage || trainer;
  const [names, evidence] = await Promise.all([userNames(db, [r.trainerUserId, ...r.assessments.map((a) => a.assessorUserId), ...r.activities.flatMap((a) => a.observations.map((o) => o.observerUserId))]), db.competencyEvidence.findMany({ where: { sourceType: 'OJT', sourceId: r.id }, select: { competencyId: true, createdAt: true } })]);
  const compNames = new Map(r.competencies.map((c) => [c.competencyId, c.competencyNameSnapshot]));
  const docIds = r.activities.map((a) => a.documentId).filter((x): x is string => !!x);
  const docs = new Map((docIds.length ? await db.document.findMany({ where: { id: { in: docIds } }, select: { id: true, title: true } }) : []).map((d) => [d.id, d.title]));
  const progress = ojtProgress(r.activities);
  const activities: OjtPlanActivityDto[] = withActivities ? r.activities.map((a) => {
    const open = a.status === 'PENDING' || a.status === 'IN_PROGRESS';
    const criteria = a.criteria.map((c) => { const o = a.observations.find((x) => x.criterionId === c.id && (x.observerUserId === r.trainerUserId || !r.trainerUserId)) ?? a.observations.find((x) => x.criterionId === c.id) ?? null; return { criterionId: c.id, criterion: c.criterionSnapshot, required: c.required, result: (o?.result ?? null) as OjtPlanActivityDto['observations'][number]['result'], comment: seesTrainerText ? (o?.comment ?? null) : null, observerName: o ? (names.get(o.observerUserId) ?? null) : null, observedAt: o?.observedAt ?? null }; });
    return {
      id: a.id, title: a.titleSnapshot, description: a.descriptionSnapshot, activityType: a.activityType as OjtPlanActivityDto['activityType'], sequence: a.sequence, required: a.required, expectedDays: a.expectedDays, requiresEvidence: a.requiresEvidence, documentId: a.documentId, documentTitle: a.documentId ? (docs.get(a.documentId) ?? null) : null,
      status: a.status as OjtPlanActivityDto['status'], startedAt: a.startedAt?.toISOString() ?? null, completedAt: a.completedAt?.toISOString() ?? null, employeeReflection: trainee || seesTrainerText ? a.employeeReflection : null, trainerComment: seesTrainerText ? a.trainerComment : null,
      observations: criteria, blockers: open ? activityCompletionBlockers({ requiresEvidence: a.requiresEvidence, documentId: a.documentId, criteria: criteria.map((c) => ({ required: c.required, result: c.result })) }) : [],
      can: { updateStatus: r.status === 'ACTIVE' && open && (trainee || trainer || manage), reflect: r.status === 'ACTIVE' && trainee, observe: r.status === 'ACTIVE' && open && (trainer || manage), linkEvidence: r.status === 'ACTIVE' && open && (trainee || trainer || manage) },
    };
  }) : [];
  return {
    id: r.id, planNumber: r.planNumber, employeeId: r.employeeId, programId: r.programId, programName: r.programNameSnapshot, snapshot: snapshotDto(r), trainer: r.trainerUserId || r.trainerEmployeeId ? { employeeId: r.trainerEmployeeId, userId: r.trainerUserId, name: r.trainerNameSnapshot } : null,
    startDate: r.startDate, targetEndDate: r.targetEndDate, status: r.status as OjtPlanDto['status'], competencies: r.competencies.map((c) => ({ competencyId: c.competencyId, competencyCode: c.competencyCodeSnapshot, competencyName: c.competencyNameSnapshot, targetLevel: c.targetLevel, importance: c.importance, description: c.description })), progress,
    assessment: r.assessments.map((a) => ({ outcome: a.outcome as OjtPlanDto['assessment'][number]['outcome'], comment: seesTrainerText ? a.comment : null, assessorName: names.get(a.assessorUserId) ?? null, submittedAt: a.submittedAt.toISOString() })),
    evidenceHandoffs: evidence.map((e) => ({ competencyId: e.competencyId, competencyName: compNames.get(e.competencyId) ?? '?', createdAt: e.createdAt.toISOString() })), trainingNeedId: r.trainingNeedId, idpItemId: r.idpItemId,
    activatedAt: r.activatedAt?.toISOString() ?? null, completedAt: r.completedAt?.toISOString() ?? null, cancelledAt: r.cancelledAt?.toISOString() ?? null, createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(),
    can: { manage, train: trainer, assess: r.status === 'ACTIVE' && ((trainer && has(auth, P.OJT_ASSESS)) || manage), complete: manage && r.status === 'ACTIVE' && progress.ready, handoff: manage && r.status === 'COMPLETED' },
    activities,
  };
}
/** Trainer identity: an employee with an active account, chosen by HR. Never inferred from performance or talent. */
async function resolveTrainer(db: Db, trainerEmployeeId: string | null | undefined) {
  if (!trainerEmployeeId) return { trainerEmployeeId: null, trainerUserId: null, trainerNameSnapshot: null };
  const t = await db.employee.findUnique({ where: { id: trainerEmployeeId }, select: { id: true, firstName: true, lastName: true, employeeCode: true, user: { select: { id: true, isActive: true } } } });
  if (!t) throw new AppError(422, 'VALIDATION_ERROR', 'Unknown trainer', [{ field: 'trainerEmployeeId', message: 'Unknown employee' }]);
  if (!t.user?.isActive) throw new AppError(422, 'OJT_TRAINER_NO_ACCOUNT', 'The trainer needs an active user account');
  return { trainerEmployeeId: t.id, trainerUserId: t.user.id, trainerNameSnapshot: `${t.firstName} ${t.lastName} (${t.employeeCode})` };
}
async function visibleWhere(auth: AuthContext): Promise<Prisma.OjtPlanWhereInput> {
  const ids = await scopedEmployeeIds(auth);
  const own: Prisma.OjtPlanWhereInput[] = [{ trainerUserId: auth.userId }];
  if (ids === null) return {};
  return { OR: [{ employeeId: { in: ids } }, ...own] };
}

export const ojtPlanService = {
  async list(auth: AuthContext, q: { page: number; pageSize: number; status?: string; programId?: string; departmentId?: string; mine?: 'trainee' | 'trainer'; search?: string }) {
    const base = q.mine === 'trainer' ? { trainerUserId: auth.userId } : q.mine === 'trainee' ? { employeeId: auth.employeeId ?? '__none__' } : await visibleWhere(auth);
    const where: Prisma.OjtPlanWhereInput = { ...base, status: q.status, programId: q.programId, departmentIdSnapshot: q.departmentId, ...(q.search ? { OR: [{ employeeNameSnapshot: { contains: q.search, mode: 'insensitive' } }, { employeeCodeSnapshot: { contains: q.search, mode: 'insensitive' } }, { planNumber: { contains: q.search, mode: 'insensitive' } }] } : {}) };
    const [total, rows] = await prisma.$transaction([prisma.ojtPlan.count({ where }), prisma.ojtPlan.findMany({ where, include: planInclude, orderBy: [{ startDate: 'desc' }], skip: (q.page - 1) * q.pageSize, take: q.pageSize })]);
    return { data: await Promise.all(rows.map((r) => planDto(prisma, auth, r, false))), meta: { page: q.page, pageSize: q.pageSize, total } };
  },
  async get(auth: AuthContext, id: string): Promise<OjtPlanDetailDto> {
    const r = await loadPlan(prisma, id);
    const visible = await prisma.ojtPlan.findFirst({ where: { AND: [{ id }, await visibleWhere(auth)] }, select: { id: true } });
    if (!visible) throw notFound('OJT plan');
    return planDto(prisma, auth, r, true);
  },

  async create(input: CreateOjtPlanInput, actor: Actor): Promise<OjtPlanDetailDto> {
    const { employee, data } = await employeeSnapshot(prisma, input.employeeId);
    if (employee.employmentStatus !== 'ACTIVE') throw new AppError(409, 'EMPLOYEE_NOT_ACTIVE', 'OJT needs an active employee record');
    const program = await prisma.ojtProgram.findUnique({ where: { id: input.programId }, include: programInclude });
    if (!program || !program.isActive) throw new AppError(422, 'VALIDATION_ERROR', 'Choose an active OJT program', [{ field: 'programId', message: 'Not an active program' }]);
    if (await prisma.ojtPlan.findFirst({ where: { employeeId: employee.id, programId: program.id, status: { in: ['DRAFT', 'ACTIVE'] } }, select: { id: true } })) throw new AppError(409, 'OJT_PLAN_EXISTS', 'This employee already has an open plan for this program');
    if (input.trainingNeedId) { const n = await prisma.trainingNeed.findUnique({ where: { id: input.trainingNeedId }, select: { employeeId: true } }); if (!n || n.employeeId !== employee.id) throw new AppError(422, 'VALIDATION_ERROR', 'That training need is not this employee\'s', [{ field: 'trainingNeedId', message: 'Mismatch' }]); }
    if (input.idpItemId) { const it = await prisma.idpItem.findUnique({ where: { id: input.idpItemId }, select: { idp: { select: { employeeId: true } } } }); if (!it || it.idp.employeeId !== employee.id) throw new AppError(422, 'VALIDATION_ERROR', 'That development activity is not this employee\'s', [{ field: 'idpItemId', message: 'Mismatch' }]); }
    const trainer = await resolveTrainer(prisma, input.trainerEmployeeId);
    const comps = new Map((await prisma.competency.findMany({ where: { id: { in: program.competencies.map((c) => c.competencyId) } }, select: { id: true, code: true, name: true } })).map((c) => [c.id, c]));
    const id = await prisma.$transaction(async (tx) => {
      const planNumber = await nextPlanNumber(tx, employee.id);
      const plan = await tx.ojtPlan.create({ data: { planNumber, employeeId: employee.id, programId: program.id, programNameSnapshot: program.name, ...data, ...trainer, startDate: input.startDate, targetEndDate: input.targetEndDate ?? (program.durationDays ? addDays(input.startDate, program.durationDays) : null), trainingNeedId: input.trainingNeedId ?? null, idpItemId: input.idpItemId ?? null, createdByUserId: actor.auth.userId,
        competencies: { create: program.competencies.map((c) => ({ competencyId: c.competencyId, competencyCodeSnapshot: comps.get(c.competencyId)?.code ?? '?', competencyNameSnapshot: comps.get(c.competencyId)?.name ?? '?', targetLevel: c.targetLevel, importance: c.importance, description: c.description })) },
        activities: { create: program.activities.map((a) => ({ titleSnapshot: a.title, descriptionSnapshot: a.description, activityType: a.activityType, sequence: a.sequence, required: a.required, expectedDays: a.expectedDays, requiresEvidence: a.documentEvidenceRequired, criteria: { create: a.criteria.map((c) => ({ criterionSnapshot: c.criterion, sequence: c.sequence, required: c.required })) } })) } } });
      await auditService.log(learningAudit(actor, AUDIT_ACTIONS.CREATE_OJT_PLAN, 'OjtPlan', plan.id, { planNumber, employeeCode: data.employeeCodeSnapshot, programId: program.id, trainerAssigned: !!trainer.trainerUserId, startDate: input.startDate, activities: program.activities.length, competencies: program.competencies.length }), tx);
      return plan.id;
    });
    return planDto(prisma, actor.auth, await loadPlan(prisma, id), true);
  },
  async update(id: string, input: UpdateOjtPlanInput, actor: Actor): Promise<OjtPlanDetailDto> {
    await prisma.$transaction(async (tx) => {
      await lockRow(tx, 'ojt_plans', id);
      const before = await loadPlan(tx, id);
      if (before.status !== 'DRAFT' && before.status !== 'ACTIVE') throw new AppError(409, 'OJT_PLAN_CLOSED', 'This plan is closed');
      const trainer: Partial<Awaited<ReturnType<typeof resolveTrainer>>> = input.trainerEmployeeId === undefined ? {} : await resolveTrainer(tx, input.trainerEmployeeId);
      await tx.ojtPlan.update({ where: { id }, data: { ...trainer, startDate: input.startDate, targetEndDate: input.targetEndDate === undefined ? undefined : input.targetEndDate } });
      await auditService.log(learningAudit(actor, AUDIT_ACTIONS.UPDATE_OJT_PLAN, 'OjtPlan', id, { fields: Object.keys(input), trainerChanged: input.trainerEmployeeId !== undefined }), tx);
      if (trainer.trainerUserId && trainer.trainerUserId !== before.trainerUserId && before.status === 'ACTIVE') await notificationService.publish({ userId: trainer.trainerUserId, type: NOTIFICATION_TYPES.OJT_PLAN_ASSIGNED, source: { module: 'learning', entityType: 'OJT_PLAN', entityId: id }, data: { planId: id }, dedupeKey: `learning:ojt:${id}:trainer:${trainer.trainerUserId}` }, { employeeName: before.employeeNameSnapshot, courseTitle: before.programNameSnapshot }, tx);
    });
    return planDto(prisma, actor.auth, await loadPlan(prisma, id), true);
  },
  /** ACTIVE freezes the structure and tells the trainee and the trainer. */
  async activate(id: string, actor: Actor): Promise<OjtPlanDetailDto> {
    await prisma.$transaction(async (tx) => {
      await lockRow(tx, 'ojt_plans', id);
      const plan = await loadPlan(tx, id);
      if (plan.status !== 'DRAFT') throw new AppError(409, 'OJT_PLAN_NOT_DRAFT', `A ${plan.status.toLowerCase()} plan cannot be activated`);
      if (!plan.trainerUserId) throw new AppError(409, 'OJT_TRAINER_REQUIRED', 'Assign a trainer before activating');
      await tx.ojtPlan.update({ where: { id }, data: { status: 'ACTIVE', activatedAt: new Date() } });
      const emp = await tx.employee.findUnique({ where: { id: plan.employeeId }, select: { user: { select: { id: true } } } });
      if (emp?.user) await notificationService.publish({ userId: emp.user.id, type: NOTIFICATION_TYPES.OJT_ACTIVITY_READY, source: { module: 'learning', entityType: 'OJT_PLAN', entityId: id }, data: { planId: id }, dedupeKey: `learning:ojt:${id}:trainee` }, { courseTitle: plan.programNameSnapshot }, tx);
      await notificationService.publish({ userId: plan.trainerUserId, type: NOTIFICATION_TYPES.OJT_PLAN_ASSIGNED, source: { module: 'learning', entityType: 'OJT_PLAN', entityId: id }, data: { planId: id }, dedupeKey: `learning:ojt:${id}:trainer:${plan.trainerUserId}` }, { employeeName: plan.employeeNameSnapshot, courseTitle: plan.programNameSnapshot }, tx);
      if (plan.trainingNeedId) await trainingNeedService.setStatusFromEnrollment(tx, plan.trainingNeedId, 'IN_PROGRESS');
      await auditService.log(learningAudit(actor, AUDIT_ACTIONS.ACTIVATE_OJT_PLAN, 'OjtPlan', id, { activities: plan.activities.length }), tx);
    });
    return planDto(prisma, actor.auth, await loadPlan(prisma, id), true);
  },

  /**
   * Activity work. The trainee moves PENDING → IN_PROGRESS → COMPLETED and writes a reflection; the trainer (or a
   * manager) writes the trainer comment; either links evidence the actor may open. COMPLETED is refused while a
   * required criterion has no MEETS observation or required evidence is missing. Under the activity row lock.
   */
  async updateActivity(activityId: string, input: UpdateOjtActivityInput, actor: Actor): Promise<OjtPlanActivityDto> {
    const { auth } = actor;
    const planId = await prisma.$transaction(async (tx) => {
      const a0 = await tx.ojtPlanActivity.findUnique({ where: { id: activityId }, select: { planId: true } }); if (!a0) throw notFound('OJT activity');
      await lockRow(tx, 'ojt_plan_activities', activityId);
      const plan = await loadPlan(tx, a0.planId);
      const before = plan.activities.find((a) => a.id === activityId)!;
      const manage = has(auth, P.OJT_MANAGE); const trainer = isTrainer(auth, plan) && has(auth, P.OJT_TRAIN); const trainee = isTrainee(auth, plan);
      if (!manage && !trainer && !trainee) throw AppError.forbidden();
      if (plan.status !== 'ACTIVE') throw new AppError(409, 'OJT_PLAN_NOT_ACTIVE', 'Activities can be worked while the plan is active');
      if (input.employeeReflection !== undefined && !trainee) throw AppError.forbidden('Only the trainee writes the reflection');
      if (input.trainerComment !== undefined && !trainer && !manage) throw AppError.forbidden('Only the trainer writes the trainer comment');
      if (input.status) {
        if (before.status === 'COMPLETED' || before.status === 'SKIPPED') throw new AppError(409, 'OJT_ACTIVITY_FINISHED', 'This activity is finished');
        if (input.status === 'SKIPPED' && before.required && !manage) throw AppError.forbidden('A required activity can be skipped only by an OJT manager');
        if (input.status === 'COMPLETED') {
          const criteria = before.criteria.map((c) => ({ required: c.required, result: before.observations.find((o) => o.criterionId === c.id && o.observerUserId === plan.trainerUserId)?.result ?? null }));
          const blockers = activityCompletionBlockers({ requiresEvidence: before.requiresEvidence, documentId: input.documentId ?? before.documentId, criteria });
          if (blockers.length) throw new AppError(422, 'OJT_ACTIVITY_INCOMPLETE', blockers.join('; '), blockers.map((b) => ({ field: 'status', message: b })));
        }
      }
      if (input.documentId) {
        const doc = await tx.document.findUnique({ where: { id: input.documentId }, include: { category: true, links: true, ownerEmployee: { select: { id: true, employeeCode: true, firstName: true, lastName: true, managerId: true } } } });
        if (!doc || !canAccessDocument(auth, doc)) throw new AppError(404, 'DOCUMENT_NOT_FOUND', 'Document not found');
        await linkDocumentWithTx(tx, input.documentId, { entityType: 'OJT_ACTIVITY', entityId: activityId, relationType: 'OJT_EVIDENCE' }, actor);
      }
      const after = await tx.ojtPlanActivity.update({ where: { id: activityId }, data: { status: input.status, employeeReflection: input.employeeReflection === undefined ? undefined : input.employeeReflection, trainerComment: input.trainerComment === undefined ? undefined : input.trainerComment, documentId: input.documentId === undefined ? undefined : input.documentId, ...(input.status === 'IN_PROGRESS' && !before.startedAt ? { startedAt: new Date() } : {}), ...(input.status === 'COMPLETED' || input.status === 'SKIPPED' ? { completedAt: new Date() } : {}) } });
      await auditService.log(learningAudit(actor, AUDIT_ACTIONS.UPDATE_OJT_ACTIVITY, 'OjtPlanActivity', activityId, { planId: plan.id, status: after.status, evidenceLinked: !!input.documentId, ...textAudit('reflection', before.employeeReflection, after.employeeReflection), ...textAudit('trainerComment', before.trainerComment, after.trainerComment) }, { status: before.status }), tx);
      return plan.id;
    });
    const d = await planDto(prisma, auth, await loadPlan(prisma, planId), true);
    return d.activities.find((a) => a.id === activityId)!;
  },
  /** One final observation per criterion per observer: a resubmission replaces, never duplicates. */
  async observe(activityId: string, input: SubmitObservationInput, actor: Actor): Promise<OjtPlanActivityDto> {
    const { auth } = actor;
    const planId = await prisma.$transaction(async (tx) => {
      const a0 = await tx.ojtPlanActivity.findUnique({ where: { id: activityId }, select: { planId: true } }); if (!a0) throw notFound('OJT activity');
      await lockRow(tx, 'ojt_plan_activities', activityId);
      const plan = await loadPlan(tx, a0.planId);
      const act = plan.activities.find((a) => a.id === activityId)!;
      const trainer = isTrainer(auth, plan) && has(auth, P.OJT_TRAIN);
      if (!trainer && !has(auth, P.OJT_MANAGE)) throw AppError.forbidden('Only the assigned trainer records observations');
      if (plan.status !== 'ACTIVE') throw new AppError(409, 'OJT_PLAN_NOT_ACTIVE', 'Observations are recorded while the plan is active');
      if (act.status === 'COMPLETED' || act.status === 'SKIPPED') throw new AppError(409, 'OJT_ACTIVITY_FINISHED', 'This activity is finished');
      if (!act.criteria.some((c) => c.id === input.criterionId)) throw new AppError(422, 'VALIDATION_ERROR', 'Criterion does not belong to this activity', [{ field: 'criterionId', message: 'Unknown criterion' }]);
      const observedOn = input.observedAt ?? await todayForEmployee(tx, plan.employeeId); // Task 53: the trainee's today
      const o = await tx.ojtActivityObservation.upsert({ where: { criterionId_observerUserId: { criterionId: input.criterionId, observerUserId: auth.userId } }, create: { planActivityId: activityId, criterionId: input.criterionId, observerUserId: auth.userId, result: input.result, comment: input.comment ?? null, observedAt: observedOn }, update: { result: input.result, comment: input.comment ?? null, observedAt: observedOn } });
      await auditService.log(learningAudit(actor, AUDIT_ACTIONS.SUBMIT_OJT_OBSERVATION, 'OjtPlanActivity', activityId, { planId: plan.id, criterionId: input.criterionId, result: input.result, observedAt: o.observedAt, ...textAudit('comment', null, input.comment ?? null) }), tx);
      return plan.id;
    });
    const d = await planDto(prisma, auth, await loadPlan(prisma, planId), true);
    return d.activities.find((a) => a.id === activityId)!;
  },
  /** The trainer's (or a manager's) final word. MORE_PRACTICE_REQUIRED keeps the plan active; it fails nobody. */
  async assess(id: string, input: SubmitOjtAssessmentInput, actor: Actor): Promise<OjtPlanDetailDto> {
    const { auth } = actor;
    await prisma.$transaction(async (tx) => {
      await lockRow(tx, 'ojt_plans', id);
      const plan = await loadPlan(tx, id);
      const trainer = isTrainer(auth, plan) && has(auth, P.OJT_ASSESS);
      if (!trainer && !has(auth, P.OJT_MANAGE)) throw AppError.forbidden('Only the assigned trainer or an OJT manager submits the assessment');
      if (plan.status !== 'ACTIVE') throw new AppError(409, 'OJT_PLAN_NOT_ACTIVE', 'Assessments are submitted while the plan is active');
      const a = await tx.ojtPlanAssessment.create({ data: { planId: id, assessorUserId: auth.userId, outcome: input.outcome, comment: input.comment ?? null } });
      await auditService.log(learningAudit(actor, AUDIT_ACTIONS.SUBMIT_OJT_ASSESSMENT, 'OjtPlan', id, { assessmentId: a.id, outcome: input.outcome, ...textAudit('comment', null, input.comment ?? null) }), tx);
    });
    return planDto(prisma, auth, await loadPlan(prisma, id), true);
  },
  /** COMPLETED when every required activity is completed or skipped. Records dates and, if linked, marks the training need fulfilled. Writes no competency. */
  async complete(id: string, actor: Actor): Promise<OjtPlanDetailDto> {
    await prisma.$transaction(async (tx) => {
      await lockRow(tx, 'ojt_plans', id);
      const plan = await loadPlan(tx, id);
      if (plan.status !== 'ACTIVE') throw new AppError(409, 'OJT_PLAN_NOT_ACTIVE', `A ${plan.status.toLowerCase()} plan cannot be completed`);
      const progress = ojtProgress(plan.activities);
      if (!progress.ready) throw new AppError(409, 'OJT_REQUIRED_ACTIVITIES_OPEN', `${progress.requiredOpen} required activity(ies) are still open`);
      await tx.ojtPlan.update({ where: { id }, data: { status: 'COMPLETED', completedAt: new Date() } });
      if (plan.trainingNeedId) await trainingNeedService.setStatusFromEnrollment(tx, plan.trainingNeedId, 'FULFILLED');
      const emp = await tx.employee.findUnique({ where: { id: plan.employeeId }, select: { user: { select: { id: true } } } });
      if (emp?.user) await notificationService.publish({ userId: emp.user.id, type: NOTIFICATION_TYPES.OJT_COMPLETED, source: { module: 'learning', entityType: 'OJT_PLAN', entityId: id }, data: { planId: id }, dedupeKey: `learning:ojt:${id}:completed` }, { courseTitle: plan.programNameSnapshot }, tx);
      await auditService.log(learningAudit(actor, AUDIT_ACTIONS.COMPLETE_OJT_PLAN, 'OjtPlan', id, { activities: progress.total, completed: progress.completed, trainingNeedFulfilled: !!plan.trainingNeedId }), tx);
    });
    return planDto(prisma, actor.auth, await loadPlan(prisma, id), true);
  },
  async cancel(id: string, actor: Actor): Promise<OjtPlanDetailDto> {
    await prisma.$transaction(async (tx) => {
      await lockRow(tx, 'ojt_plans', id);
      const plan = await loadPlan(tx, id);
      if (plan.status !== 'DRAFT' && plan.status !== 'ACTIVE') throw new AppError(409, 'OJT_PLAN_CLOSED', 'This plan is closed');
      await tx.ojtPlan.update({ where: { id }, data: { status: 'CANCELLED', cancelledAt: new Date() } });
      if (plan.trainingNeedId && plan.status === 'ACTIVE') await trainingNeedService.setStatusFromEnrollment(tx, plan.trainingNeedId, 'OPEN');
      await auditService.log(learningAudit(actor, AUDIT_ACTIONS.CANCEL_OJT_PLAN, 'OjtPlan', id, { from: plan.status }), tx);
    });
    return planDto(prisma, actor.auth, await loadPlan(prisma, id), true);
  },
  /**
   * "Use as evidence for competency assessment": creates one evidence pointer per program competency (or the chosen
   * ones) carrying the program's *objective* level and the plan as source. `observedLevel` stays null: nobody in this
   * flow observed a level on the competency scale, and an objective must never read as an achievement. It changes no
   * competency level and is idempotent per competency.
   */
  async handoffEvidence(id: string, input: { competencyIds?: string[]; note?: string | null }, actor: Actor): Promise<CompetencyEvidenceDto[]> {
    const created = await prisma.$transaction(async (tx) => {
      await lockRow(tx, 'ojt_plans', id);
      const plan = await loadPlan(tx, id);
      if (plan.status !== 'COMPLETED') throw new AppError(409, 'OJT_PLAN_NOT_COMPLETED', 'Evidence is handed off from a completed plan');
      const comps = plan.competencies.filter((c) => !input.competencyIds || input.competencyIds.includes(c.competencyId));
      if (!comps.length) throw new AppError(422, 'VALIDATION_ERROR', 'No matching program competency', [{ field: 'competencyIds', message: 'Unknown competency for this plan' }]);
      let n = 0;
      for (const c of comps) { const r = await tx.competencyEvidence.upsert({ where: { sourceType_sourceId_competencyId: { sourceType: 'OJT', sourceId: id, competencyId: c.competencyId } }, create: { employeeId: plan.employeeId, competencyId: c.competencyId, sourceType: 'OJT', sourceId: id, sourceLabel: `OJT ${plan.planNumber} — ${plan.programNameSnapshot}`, objectiveLevelSnapshot: c.targetLevel, observedLevel: null, note: input.note ?? null, createdByUserId: actor.auth.userId }, update: {} }); if (r.createdByUserId === actor.auth.userId) n += 1; }
      await auditService.log(learningAudit(actor, AUDIT_ACTIONS.CREATE_COMPETENCY_EVIDENCE_FROM_OJT, 'OjtPlan', id, { competencies: comps.map((c) => c.competencyId), ...textAudit('note', null, input.note ?? null) }), tx);
      return n;
    });
    void created;
    return this.evidenceFor(actor.auth, (await loadPlan(prisma, id)).employeeId);
  },
  /** Evidence pointers an assessor reads: the employee's own, or within the competency module's view scope. */
  async evidenceFor(auth: AuthContext, employeeId: string): Promise<CompetencyEvidenceDto[]> {
    const ids = await scopedEmployeeIds(auth);
    // Evidence follows the employee data scope exactly as the competency module does: an assessor sees their own team, never someone else's.
    if (ids !== null && !ids.includes(employeeId)) throw notFound('employee');
    const rows = await prisma.competencyEvidence.findMany({ where: { employeeId }, orderBy: { createdAt: 'desc' } });
    const [comps, names] = await Promise.all([prisma.competency.findMany({ where: { id: { in: rows.map((r) => r.competencyId) } }, select: { id: true, name: true } }), userNames(prisma, rows.map((r) => r.createdByUserId))]);
    const cn = new Map(comps.map((c) => [c.id, c.name]));
    return rows.map((r) => ({ id: r.id, employeeId: r.employeeId, competencyId: r.competencyId, competencyName: cn.get(r.competencyId) ?? '?', sourceType: r.sourceType, sourceId: r.sourceId, sourceLabel: r.sourceLabel, objectiveLevel: r.objectiveLevelSnapshot, observedLevel: r.observedLevel, note: r.note, createdAt: r.createdAt.toISOString(), createdByName: names.get(r.createdByUserId) ?? null }));
  },
};
const addDays = (date: string, days: number) => { const d = new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
export { planDto as ojtPlanDto, loadPlan as loadOjtPlan };
