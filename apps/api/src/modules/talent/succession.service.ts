import type { Prisma } from '@prisma/client';
import { AUDIT_ACTIONS, type CreateSuccessionPlanInput, type NominateSuccessorInput, type RemoveSuccessorInput, type SuccessionCandidateContextDto, type SuccessionCandidateDto, type SuccessionListQuery, type SuccessionPlanDto, type UpdateSuccessionPlanInput, type UpdateSuccessorInput } from '@hr/shared';
import { prisma } from '../../lib/prisma';
import { AppError } from '../../lib/errors';
import { auditService } from '../../services/audit/audit.service';
import type { AuthContext } from '../auth/auth.types';
import { careerService } from './career.service';
import { canManageSuccession, developmentContext, lockRow, notFound, talentAudit, textAudit, userNames, type Actor, type Db } from './talent.types';

/**
 * Succession plans.
 *
 * A plan is for a position — the real seat somebody would take over — with its job, department and organization
 * frozen as they were. A nomination is a named person's act, with a readiness they chose (READY_NOW / READY_SOON /
 * DEVELOPING) and the candidate's job as it was; nothing derives readiness from a score, and a later transfer does
 * not rewrite the nomination. The candidate is never told by this module. Notes reach `succession.manage` only.
 */
const candidateInclude = { employee: { select: { id: true, employeeCode: true, firstName: true, lastName: true } } } satisfies Prisma.SuccessionCandidateInclude;
type CandidateRow = Prisma.SuccessionCandidateGetPayload<{ include: typeof candidateInclude }>;
const include = { position: { select: { id: true, code: true, title: true, employees: { where: { employmentStatus: 'ACTIVE' }, select: { id: true, employeeCode: true, firstName: true, lastName: true } } } }, candidates: { include: candidateInclude, orderBy: [{ status: 'asc' as const }, { nominatedAt: 'asc' as const }] } } satisfies Prisma.SuccessionPlanInclude;
type Row = Prisma.SuccessionPlanGetPayload<{ include: typeof include }>;

async function candidateDtos(db: Db, auth: AuthContext, rows: CandidateRow[]): Promise<SuccessionCandidateDto[]> {
  const names = await userNames(db, rows.flatMap((r) => [r.nominatedByUserId, r.removedByUserId]));
  const notesVisible = canManageSuccession(auth);
  return rows.map((r) => ({
    id: r.id, planId: r.planId, employee: r.employee,
    snapshot: { jobTitle: r.jobTitleSnapshot, departmentName: r.departmentNameSnapshot, positionTitle: r.positionTitleSnapshot },
    readiness: r.readiness as SuccessionCandidateDto['readiness'], targetReadinessDate: r.targetReadinessDate, notes: notesVisible ? r.notes : null,
    nominatedAt: r.nominatedAt.toISOString(), nominatedBy: names.get(r.nominatedByUserId) ?? null,
    status: r.status as 'ACTIVE' | 'REMOVED', removedAt: r.removedAt?.toISOString() ?? null, removedBy: r.removedByUserId ? names.get(r.removedByUserId) ?? null : null, removalReason: notesVisible ? r.removalReason : null,
  }));
}

async function toDto(db: Db, auth: AuthContext, row: Row): Promise<SuccessionPlanDto> {
  const candidates = await candidateDtos(db, auth, row.candidates);
  const active = candidates.filter((c) => c.status === 'ACTIVE');
  return {
    id: row.id, position: { id: row.position.id, code: row.position.code, title: row.position.title },
    snapshot: { organizationName: row.organizationNameSnapshot, departmentName: row.departmentNameSnapshot, jobTitle: row.jobTitleSnapshot, positionTitle: row.positionTitleSnapshot },
    jobId: row.jobIdSnapshot, incumbents: row.position.employees,
    criticality: row.criticality as SuccessionPlanDto['criticality'], notes: canManageSuccession(auth) ? row.notes : null, status: row.status as SuccessionPlanDto['status'],
    candidates,
    counts: { active: active.length, readyNow: active.filter((c) => c.readiness === 'READY_NOW').length, readySoon: active.filter((c) => c.readiness === 'READY_SOON').length, developing: active.filter((c) => c.readiness === 'DEVELOPING').length },
    createdAt: row.createdAt.toISOString(), closedAt: row.closedAt?.toISOString() ?? null,
  };
}
async function load(db: Db, id: string) {
  const row = await db.successionPlan.findUnique({ where: { id }, include });
  if (!row) throw notFound('succession plan');
  return row;
}

export const successionService = {
  async list(auth: AuthContext, q: SuccessionListQuery) {
    const where: Prisma.SuccessionPlanWhereInput = { status: q.status, criticality: q.criticality, departmentIdSnapshot: q.departmentId };
    const [total, rows] = await prisma.$transaction([prisma.successionPlan.count({ where }), prisma.successionPlan.findMany({ where, include, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize })]);
    return { data: await Promise.all(rows.map((r) => toDto(prisma, auth, r))), meta: { page: q.page, pageSize: q.pageSize, total } };
  },
  async get(auth: AuthContext, id: string): Promise<SuccessionPlanDto> { return toDto(prisma, auth, await load(prisma, id)); },

  /** One open plan per position. */
  async create(input: CreateSuccessionPlanInput, actor: Actor): Promise<SuccessionPlanDto> {
    const id = await prisma.$transaction(async (tx) => {
      const position = await tx.position.findUnique({ where: { id: input.positionId }, select: { id: true, title: true, jobId: true, job: { select: { title: true } }, department: { select: { id: true, name: true, organizationId: true, organization: { select: { name: true } } } } } });
      if (!position) throw new AppError(404, 'POSITION_NOT_FOUND', 'Position not found');
      await tx.$executeRaw`SELECT "id" FROM "positions" WHERE "id" = ${position.id} FOR UPDATE`;
      const open = await tx.successionPlan.findFirst({ where: { positionId: position.id, status: { not: 'CLOSED' } }, select: { id: true } });
      if (open) throw new AppError(409, 'SUCCESSION_PLAN_EXISTS', 'This position already has an open succession plan');
      const created = await tx.successionPlan.create({ data: {
        positionId: position.id, organizationIdSnapshot: position.department.organizationId, organizationNameSnapshot: position.department.organization.name, departmentIdSnapshot: position.department.id, departmentNameSnapshot: position.department.name,
        jobIdSnapshot: position.jobId, jobTitleSnapshot: position.job?.title ?? null, positionTitleSnapshot: position.title, criticality: input.criticality, notes: input.notes ?? null, createdByUserId: actor.auth.userId,
      } });
      await auditService.log(talentAudit(actor, AUDIT_ACTIONS.CREATE_SUCCESSION_PLAN, 'SuccessionPlan', created.id, { positionId: position.id, positionTitle: position.title, criticality: input.criticality, ...textAudit('notes', null, input.notes) }), tx);
      return created.id;
    });
    return this.get(actor.auth, id);
  },

  async update(id: string, input: UpdateSuccessionPlanInput, actor: Actor): Promise<SuccessionPlanDto> {
    await prisma.$transaction(async (tx) => {
      await lockRow(tx, 'succession_plans', id);
      const before = await load(tx, id);
      if (before.status === 'CLOSED') throw new AppError(409, 'SUCCESSION_PLAN_CLOSED', 'A closed plan is immutable');
      if (input.status === 'DRAFT' && before.status === 'ACTIVE') throw new AppError(409, 'SUCCESSION_PLAN_ACTIVE', 'An active plan cannot go back to draft');
      await tx.successionPlan.update({ where: { id }, data: { criticality: input.criticality, notes: input.notes, status: input.status, closedAt: input.status === 'CLOSED' ? new Date() : undefined } });
      await auditService.log(talentAudit(actor, AUDIT_ACTIONS.UPDATE_SUCCESSION_PLAN, 'SuccessionPlan', id, { fields: Object.keys(input), criticality: input.criticality ?? before.criticality, status: input.status ?? before.status, ...textAudit('notes', before.notes, input.notes === undefined ? before.notes : input.notes) }, { criticality: before.criticality, status: before.status }), tx);
    });
    return this.get(actor.auth, id);
  },

  /** A nomination is one person's act. One active nomination per employee per plan; a repeat returns the existing one. */
  async nominate(id: string, input: NominateSuccessorInput, actor: Actor): Promise<SuccessionCandidateDto> {
    const candidateId = await prisma.$transaction(async (tx) => {
      await lockRow(tx, 'succession_plans', id);
      const plan = await load(tx, id);
      if (plan.status === 'CLOSED') throw new AppError(409, 'SUCCESSION_PLAN_CLOSED', 'A closed plan takes no nominations');
      const employee = await tx.employee.findUnique({ where: { id: input.employeeId }, select: { id: true, employeeCode: true, employmentStatus: true, department: { select: { name: true } }, position: { select: { title: true, job: { select: { title: true } } } } } });
      if (!employee) throw new AppError(404, 'EMPLOYEE_NOT_FOUND', 'Employee not found');
      if (employee.employmentStatus !== 'ACTIVE') throw new AppError(422, 'EMPLOYEE_NOT_ACTIVE', 'Successors are active employees');
      const active = await tx.successionCandidate.findFirst({ where: { planId: id, employeeId: input.employeeId, status: 'ACTIVE' }, select: { id: true } });
      if (active) return active.id;
      const created = await tx.successionCandidate.create({ data: {
        planId: id, employeeId: employee.id, jobTitleSnapshot: employee.position?.job?.title ?? null, departmentNameSnapshot: employee.department?.name ?? null, positionTitleSnapshot: employee.position?.title ?? null,
        readiness: input.readiness, targetReadinessDate: input.targetReadinessDate ?? null, notes: input.notes ?? null, nominatedByUserId: actor.auth.userId,
      } });
      await auditService.log(talentAudit(actor, AUDIT_ACTIONS.NOMINATE_SUCCESSOR, 'SuccessionCandidate', created.id, { planId: id, positionTitle: plan.positionTitleSnapshot, employeeCode: employee.employeeCode, readiness: input.readiness, ...textAudit('notes', null, input.notes) }), tx);
      return created.id;
    });
    const row = await prisma.successionCandidate.findUniqueOrThrow({ where: { id: candidateId }, include: candidateInclude });
    return (await candidateDtos(prisma, actor.auth, [row]))[0]!;
  },

  async updateCandidate(candidateId: string, input: UpdateSuccessorInput, actor: Actor): Promise<SuccessionCandidateDto> {
    await prisma.$transaction(async (tx) => {
      const before = await tx.successionCandidate.findUnique({ where: { id: candidateId }, include: candidateInclude });
      if (!before) throw notFound('succession candidate');
      await lockRow(tx, 'succession_plans', before.planId);
      const fresh = await tx.successionCandidate.findUniqueOrThrow({ where: { id: candidateId } });
      if (fresh.status !== 'ACTIVE') throw new AppError(409, 'SUCCESSOR_REMOVED', 'This nomination was removed');
      if ((await tx.successionPlan.findUniqueOrThrow({ where: { id: before.planId }, select: { status: true } })).status === 'CLOSED') throw new AppError(409, 'SUCCESSION_PLAN_CLOSED', 'A closed plan is immutable');
      await tx.successionCandidate.update({ where: { id: candidateId }, data: { readiness: input.readiness, targetReadinessDate: input.targetReadinessDate, notes: input.notes } });
      await auditService.log(talentAudit(actor, AUDIT_ACTIONS.UPDATE_SUCCESSOR_READINESS, 'SuccessionCandidate', candidateId, { planId: before.planId, employeeCode: before.employee.employeeCode, readiness: input.readiness ?? fresh.readiness, ...textAudit('notes', fresh.notes, input.notes === undefined ? fresh.notes : input.notes) }, { readiness: fresh.readiness }), tx);
    });
    const row = await prisma.successionCandidate.findUniqueOrThrow({ where: { id: candidateId }, include: candidateInclude });
    return (await candidateDtos(prisma, actor.auth, [row]))[0]!;
  },

  async removeCandidate(candidateId: string, input: RemoveSuccessorInput, actor: Actor): Promise<SuccessionCandidateDto> {
    await prisma.$transaction(async (tx) => {
      const before = await tx.successionCandidate.findUnique({ where: { id: candidateId }, include: candidateInclude });
      if (!before) throw notFound('succession candidate');
      await lockRow(tx, 'succession_plans', before.planId);
      const fresh = await tx.successionCandidate.findUniqueOrThrow({ where: { id: candidateId } });
      if (fresh.status !== 'ACTIVE') throw new AppError(409, 'SUCCESSOR_REMOVED', 'This nomination was already removed');
      await tx.successionCandidate.update({ where: { id: candidateId }, data: { status: 'REMOVED', removedAt: new Date(), removedByUserId: actor.auth.userId, removalReason: input.reason ?? null } });
      await auditService.log(talentAudit(actor, AUDIT_ACTIONS.REMOVE_SUCCESSOR, 'SuccessionCandidate', candidateId, { planId: before.planId, employeeCode: before.employee.employeeCode, ...textAudit('reason', null, input.reason) }, { readiness: fresh.readiness }), tx);
    });
    const row = await prisma.successionCandidate.findUniqueOrThrow({ where: { id: candidateId }, include: candidateInclude });
    return (await candidateDtos(prisma, actor.auth, [row]))[0]!;
  },

  /** Current facts next to the historical nomination. Two contexts, kept apart on purpose. */
  async candidateContext(auth: AuthContext, candidateId: string): Promise<SuccessionCandidateContextDto> {
    const row = await prisma.successionCandidate.findUnique({ where: { id: candidateId }, include: { ...candidateInclude, plan: { select: { id: true, positionTitleSnapshot: true, jobTitleSnapshot: true, jobIdSnapshot: true } } } });
    if (!row) throw notFound('succession candidate');
    const employee = await prisma.employee.findUnique({ where: { id: row.employeeId }, select: { position: { select: { job: { select: { id: true, code: true, title: true } } } } } });
    const [readiness, performance, talentReview, development] = await Promise.all([
      row.plan.jobIdSnapshot ? careerService.getCareerReadiness({ employeeId: row.employeeId, targetJobId: row.plan.jobIdSnapshot }).catch(() => null) : null,
      prisma.performancePlan.findFirst({ where: { employeeId: row.employeeId, status: 'FINALIZED' }, select: { weightedScore: true, ratingLabelSnapshot: true, finalizedAt: true, cycle: { select: { name: true } } }, orderBy: { finalizedAt: 'desc' } }),
      prisma.talentReview.findFirst({ where: { employeeId: row.employeeId, status: 'FINALIZED' }, select: { nineBoxCell: true, finalizedAt: true, cycle: { select: { name: true } } }, orderBy: { finalizedAt: 'desc' } }),
      developmentContext(prisma, row.employeeId),
    ]);
    return {
      candidate: (await candidateDtos(prisma, auth, [row]))[0]!,
      plan: { id: row.plan.id, positionTitle: row.plan.positionTitleSnapshot, jobTitle: row.plan.jobTitleSnapshot, jobId: row.plan.jobIdSnapshot },
      currentJob: employee?.position?.job ?? null,
      readiness,
      performance: performance ? { cycleName: performance.cycle.name, score: performance.weightedScore?.toFixed(2) ?? null, ratingLabel: performance.ratingLabelSnapshot, finalizedAt: performance.finalizedAt?.toISOString() ?? null } : null,
      talentReview: talentReview ? { cycleName: talentReview.cycle.name, nineBoxCell: talentReview.nineBoxCell, finalizedAt: talentReview.finalizedAt?.toISOString() ?? null } : null,
      development,
    };
  },
};
