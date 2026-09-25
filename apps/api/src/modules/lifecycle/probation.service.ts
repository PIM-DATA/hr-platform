import { AUDIT_ACTIONS, NOTIFICATION_TYPES, addCalendarDays, calendarDaysBetween, type CreateProbationCaseInput, type CreateProbationPolicyInput, type ProbationCaseDto, type ProbationPolicyDto, type SubmitProbationReviewInput, type UpdateProbationPolicyInput } from '@hr/shared';
import type { Prisma } from '@prisma/client';
import { AppError } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { auditService } from '../../services/audit/audit.service';
import { notificationService } from '../../services/notification/notification.service';
import type { AuthContext } from '../auth/auth.types';
import { P, currentOf, employeeSnapshot, has, lifecycleAudit, lifecycleEmployeeWhere, lockRow, notFound, snapshotDto, textAudit, today, userNames, type Actor, type Db, type Tx } from './lifecycle.types';

/**
 * Probation: a configurable period, a human review, an optional extension, a recorded outcome. The system computes
 * dates and keeps history; it never suggests PASS, EXTEND or NOT_PASS, never reads attendance, leave, warnings,
 * surveys, performance or talent to do so, and never changes employment because of an outcome.
 */
const include = { reviews: { orderBy: { submittedAt: 'asc' as const } } };
type Row = Prisma.ProbationCaseGetPayload<{ include: typeof include }>;
async function load(db: Db, id: string) { const r = await db.probationCase.findUnique({ where: { id }, include }); if (!r) throw notFound('probation case'); return r; }
const policyDto = async (db: Db, p: Prisma.ProbationPolicyGetPayload<object>): Promise<ProbationPolicyDto> => ({ id: p.id, name: p.name, organizationId: p.organizationId, organizationName: p.organizationId ? ((await db.organization.findUnique({ where: { id: p.organizationId }, select: { name: true } }))?.name ?? null) : null, durationDays: p.durationDays, reviewLeadDays: p.reviewLeadDays, allowExtension: p.allowExtension, maxExtensionDays: p.maxExtensionDays, isActive: p.isActive, createdAt: p.createdAt.toISOString(), updatedAt: p.updatedAt.toISOString() });

async function dto(db: Db, auth: AuthContext, r: Row, self: boolean): Promise<ProbationCaseDto> {
  const manage = has(auth, P.PROBATION_MANAGE);
  const reviewer = r.reviewerUserId === auth.userId && has(auth, P.PROBATION_REVIEW);
  const [names, current] = await Promise.all([userNames(db, [r.reviewerUserId, ...r.reviews.map((x) => x.reviewerUserId)]), currentOf(db, r.employeeId)]);
  const open = r.status === 'ACTIVE' || r.status === 'PENDING_REVIEW' || r.status === 'EXTENDED';
  return {
    id: r.id, employeeId: r.employeeId, policyId: r.policyId, policyName: r.policyNameSnapshot, snapshot: snapshotDto(r), current, startDate: r.startDate, originalEndDate: r.originalEndDate, currentEndDate: r.currentEndDate, daysRemaining: calendarDaysBetween(today(), r.currentEndDate),
    reviewerUserId: self ? null : r.reviewerUserId, reviewerName: self ? null : (r.reviewerUserId ? (names.get(r.reviewerUserId) ?? null) : null), status: r.status as ProbationCaseDto['status'], finalOutcome: r.finalOutcome as ProbationCaseDto['finalOutcome'], extensions: r.reviews.filter((x) => x.outcome === 'EXTEND').length,
    // Review comments are the reviewer's and HR's; the employee sees dates and outcomes only.
    reviews: r.reviews.map((x) => ({ id: x.id, reviewerUserId: x.reviewerUserId, reviewerName: names.get(x.reviewerUserId) ?? null, reviewDate: x.reviewDate, outcome: x.outcome as ProbationCaseDto['reviews'][number]['outcome'], comment: manage || reviewer ? x.comment : null, extensionEndDate: x.extensionEndDate, submittedAt: x.submittedAt.toISOString() })),
    createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(), can: { review: reviewer && open, manage },
  };
}
async function defaultReviewer(db: Db, managerIdSnapshot: string | null): Promise<string | null> {
  if (!managerIdSnapshot) return null;
  const m = await db.employee.findUnique({ where: { id: managerIdSnapshot }, select: { user: { select: { id: true, isActive: true } } } });
  return m?.user?.isActive ? m.user.id : null;
}

export const probationService = {
  async policies(includeInactive: boolean): Promise<ProbationPolicyDto[]> { return Promise.all((await prisma.probationPolicy.findMany({ where: includeInactive ? {} : { isActive: true }, orderBy: { name: 'asc' } })).map((p) => policyDto(prisma, p))); },
  async createPolicy(input: CreateProbationPolicyInput, actor: Actor): Promise<ProbationPolicyDto> {
    if (input.organizationId && !(await prisma.organization.findUnique({ where: { id: input.organizationId }, select: { id: true } }))) throw new AppError(422, 'VALIDATION_ERROR', 'Unknown organization', [{ field: 'organizationId', message: 'Unknown organization' }]);
    const row = await prisma.$transaction(async (tx) => {
      const created = await tx.probationPolicy.create({ data: { name: input.name, organizationId: input.organizationId ?? null, durationDays: input.durationDays, reviewLeadDays: input.reviewLeadDays ?? null, allowExtension: input.allowExtension ?? true, maxExtensionDays: input.maxExtensionDays ?? null } });
      await auditService.log(lifecycleAudit(actor, AUDIT_ACTIONS.CREATE_PROBATION_POLICY, 'ProbationPolicy', created.id, { name: created.name, durationDays: created.durationDays, allowExtension: created.allowExtension, maxExtensionDays: created.maxExtensionDays }), tx);
      return created;
    });
    return policyDto(prisma, row);
  },
  async updatePolicy(id: string, input: UpdateProbationPolicyInput, actor: Actor): Promise<ProbationPolicyDto> {
    const row = await prisma.$transaction(async (tx) => {
      const before = await tx.probationPolicy.findUnique({ where: { id } }); if (!before) throw notFound('probation policy');
      const after = await tx.probationPolicy.update({ where: { id }, data: { name: input.name, organizationId: input.organizationId === undefined ? undefined : input.organizationId, durationDays: input.durationDays, reviewLeadDays: input.reviewLeadDays === undefined ? undefined : input.reviewLeadDays, allowExtension: input.allowExtension, maxExtensionDays: input.maxExtensionDays === undefined ? undefined : input.maxExtensionDays, isActive: input.isActive } });
      await auditService.log(lifecycleAudit(actor, AUDIT_ACTIONS.UPDATE_PROBATION_POLICY, 'ProbationPolicy', id, { fields: Object.keys(input), durationDays: after.durationDays, isActive: after.isActive }, { durationDays: before.durationDays }), tx);
      return after;
    });
    return policyDto(prisma, row);
  },

  async list(auth: AuthContext, q: { page: number; pageSize: number; status?: string; departmentId?: string; dueWithinDays?: number; mine?: string }) {
    const where: Prisma.ProbationCaseWhereInput = { ...(await lifecycleEmployeeWhere(auth) as Prisma.ProbationCaseWhereInput), status: q.status, departmentIdSnapshot: q.departmentId, ...(q.dueWithinDays !== undefined ? { status: { in: ['ACTIVE', 'PENDING_REVIEW', 'EXTENDED'] }, currentEndDate: { lte: addCalendarDays(today(), q.dueWithinDays) } } : {}) };
    const final: Prisma.ProbationCaseWhereInput = q.mine ? { OR: [where, { reviewerUserId: auth.userId }] } : where;
    const [total, rows] = await prisma.$transaction([prisma.probationCase.count({ where: final }), prisma.probationCase.findMany({ where: final, include, orderBy: [{ currentEndDate: 'asc' }], skip: (q.page - 1) * q.pageSize, take: q.pageSize })]);
    return { data: await Promise.all(rows.map((r) => dto(prisma, auth, r, r.employeeId === auth.employeeId && !has(auth, P.PROBATION_MANAGE)))), meta: { page: q.page, pageSize: q.pageSize, total } };
  },
  async get(auth: AuthContext, id: string): Promise<ProbationCaseDto> {
    const r = await load(prisma, id);
    const visible = await prisma.probationCase.findFirst({ where: { AND: [{ id }, await lifecycleEmployeeWhere(auth) as Prisma.ProbationCaseWhereInput] }, select: { id: true } });
    if (!visible && r.reviewerUserId !== auth.userId) throw notFound('probation case');
    return dto(prisma, auth, r, r.employeeId === auth.employeeId && !has(auth, P.PROBATION_MANAGE));
  },

  async createWithTx(tx: Tx, input: CreateProbationCaseInput, actor: Actor): Promise<{ id: string }> {
    const { employee, data } = await employeeSnapshot(tx, input.employeeId);
    if (employee.employmentStatus !== 'ACTIVE') throw new AppError(409, 'EMPLOYEE_NOT_ACTIVE', 'Probation needs an active employee record');
    if (await tx.probationCase.findFirst({ where: { employeeId: employee.id, status: { in: ['ACTIVE', 'PENDING_REVIEW', 'EXTENDED'] } }, select: { id: true } })) throw new AppError(409, 'PROBATION_CASE_EXISTS', 'This employee already has an open probation case');
    const policy = input.policyId ? await tx.probationPolicy.findUnique({ where: { id: input.policyId } }) : null;
    if (input.policyId && (!policy || !policy.isActive)) throw new AppError(422, 'VALIDATION_ERROR', 'Choose an active probation policy', [{ field: 'policyId', message: 'Not an active policy' }]);
    const durationDays = input.durationDays ?? policy?.durationDays;
    if (!durationDays) throw new AppError(422, 'VALIDATION_ERROR', 'A policy or a duration is required', [{ field: 'durationDays', message: 'Required without a policy' }]);
    const startDate = input.startDate ?? employee.hireDate.toISOString().slice(0, 10);
    const endDate = addCalendarDays(startDate, durationDays);
    const reviewerUserId = input.reviewerUserId ?? (await defaultReviewer(tx, data.managerIdSnapshot));
    if (input.reviewerUserId && !(await tx.user.findUnique({ where: { id: input.reviewerUserId }, select: { id: true } }))) throw new AppError(422, 'VALIDATION_ERROR', 'Unknown reviewer', [{ field: 'reviewerUserId', message: 'Unknown user' }]);
    const created = await tx.probationCase.create({ data: { employeeId: employee.id, policyId: policy?.id ?? null, policyNameSnapshot: policy?.name ?? null, allowExtension: policy?.allowExtension ?? true, maxExtensionDays: policy?.maxExtensionDays ?? null, ...data, startDate, originalEndDate: endDate, currentEndDate: endDate, reviewerUserId, createdByUserId: actor.auth.userId } });
    await auditService.log(lifecycleAudit(actor, AUDIT_ACTIONS.CREATE_PROBATION_CASE, 'ProbationCase', created.id, { employeeCode: data.employeeCodeSnapshot, policyId: policy?.id ?? null, startDate, endDate, durationDays, reviewerAssigned: !!reviewerUserId }), tx);
    if (reviewerUserId) await notificationService.publish({ userId: reviewerUserId, type: NOTIFICATION_TYPES.PROBATION_REVIEW_REQUIRED, source: { module: 'lifecycle', entityType: 'PROBATION_CASE', entityId: created.id }, data: { caseId: created.id }, dedupeKey: `lifecycle:probation:${created.id}:review:${reviewerUserId}` }, { employeeName: data.employeeNameSnapshot, date: endDate }, tx);
    return { id: created.id };
  },
  async create(input: CreateProbationCaseInput, actor: Actor): Promise<ProbationCaseDto> {
    const { id } = await prisma.$transaction((tx) => this.createWithTx(tx, input, actor));
    return dto(prisma, actor.auth, await load(prisma, id), false);
  },

  async reassignReviewer(id: string, reviewerUserId: string, actor: Actor): Promise<ProbationCaseDto> {
    await prisma.$transaction(async (tx) => {
      await lockRow(tx, 'probation_cases', id);
      const c = await load(tx, id);
      if (!['ACTIVE', 'PENDING_REVIEW', 'EXTENDED'].includes(c.status)) throw new AppError(409, 'PROBATION_CASE_CLOSED', 'This probation case is closed');
      const u = await tx.user.findUnique({ where: { id: reviewerUserId }, select: { id: true, isActive: true } });
      if (!u || !u.isActive) throw new AppError(422, 'VALIDATION_ERROR', 'Reviewer needs an active account', [{ field: 'reviewerUserId', message: 'Unknown or inactive user' }]);
      await tx.probationCase.update({ where: { id }, data: { reviewerUserId } });
      await auditService.log(lifecycleAudit(actor, AUDIT_ACTIONS.REASSIGN_PROBATION_REVIEWER, 'ProbationCase', id, { reviewerUserId }, { reviewerUserId: c.reviewerUserId }), tx);
      await notificationService.publish({ userId: reviewerUserId, type: NOTIFICATION_TYPES.PROBATION_REVIEW_REQUIRED, source: { module: 'lifecycle', entityType: 'PROBATION_CASE', entityId: id }, data: { caseId: id }, dedupeKey: `lifecycle:probation:${id}:review:${reviewerUserId}` }, { employeeName: c.employeeNameSnapshot, date: c.currentEndDate }, tx);
    });
    return dto(prisma, actor.auth, await load(prisma, id), false);
  },

  /**
   * The review: one event per submission, appended, never overwritten. PASS / NOT_PASS finalize the case; EXTEND
   * moves currentEndDate forward within the policy's maximum. The employee master is not touched by any outcome.
   */
  async submitReview(id: string, input: SubmitProbationReviewInput, actor: Actor): Promise<ProbationCaseDto> {
    const { auth } = actor;
    await prisma.$transaction(async (tx) => {
      await lockRow(tx, 'probation_cases', id);
      const c = await load(tx, id);
      const reviewer = c.reviewerUserId === auth.userId && has(auth, P.PROBATION_REVIEW);
      if (!reviewer && !has(auth, P.PROBATION_MANAGE)) throw AppError.forbidden('Only the assigned reviewer or a probation manager may record the review');
      if (!['ACTIVE', 'PENDING_REVIEW', 'EXTENDED'].includes(c.status)) throw new AppError(409, 'PROBATION_CASE_CLOSED', `A ${c.status.toLowerCase().replace('_', ' ')} case cannot be reviewed again`);
      const reviewDate = input.reviewDate ?? today();
      let newEnd = c.currentEndDate;
      if (input.outcome === 'EXTEND') {
        if (!c.allowExtension) throw new AppError(409, 'PROBATION_EXTENSION_NOT_ALLOWED', 'This probation policy does not allow extensions');
        newEnd = input.extensionEndDate!;
        if (newEnd <= c.currentEndDate) throw new AppError(422, 'VALIDATION_ERROR', 'The new end date must be after the current end date', [{ field: 'extensionEndDate', message: 'Not after the current end' }]);
        if (c.maxExtensionDays !== null && calendarDaysBetween(c.originalEndDate, newEnd) > c.maxExtensionDays) throw new AppError(422, 'PROBATION_EXTENSION_TOO_LONG', `Extensions may total at most ${c.maxExtensionDays} day(s) beyond the original end date`);
      }
      const review = await tx.probationReview.create({ data: { caseId: id, reviewerUserId: auth.userId, reviewDate, outcome: input.outcome, comment: input.comment ?? null, extensionEndDate: input.outcome === 'EXTEND' ? newEnd : null, previousEndDate: c.currentEndDate } });
      const status = input.outcome === 'PASS' ? 'PASSED' : input.outcome === 'NOT_PASS' ? 'NOT_PASSED' : 'EXTENDED';
      await tx.probationCase.update({ where: { id }, data: { status, currentEndDate: newEnd, ...(input.outcome !== 'EXTEND' ? { finalOutcome: input.outcome, finalizedAt: new Date() } : {}) } });
      await auditService.log(lifecycleAudit(actor, input.outcome === 'EXTEND' ? AUDIT_ACTIONS.EXTEND_PROBATION : AUDIT_ACTIONS.SUBMIT_PROBATION_REVIEW, 'ProbationCase', id, { reviewId: review.id, outcome: input.outcome, reviewDate, previousEndDate: c.currentEndDate, newEndDate: newEnd, ...textAudit('comment', null, input.comment ?? null) }, { status: c.status }), tx);
      if (input.outcome !== 'EXTEND') await auditService.log(lifecycleAudit(actor, AUDIT_ACTIONS.FINALIZE_PROBATION, 'ProbationCase', id, { finalOutcome: input.outcome }), tx);
      const emp = await tx.employee.findUnique({ where: { id: c.employeeId }, select: { user: { select: { id: true } } } });
      if (emp?.user) await notificationService.publish({ userId: emp.user.id, type: NOTIFICATION_TYPES.PROBATION_OUTCOME_RECORDED, source: { module: 'lifecycle', entityType: 'PROBATION_CASE', entityId: id }, data: { caseId: id }, dedupeKey: `lifecycle:probation:${id}:outcome:${review.id}` }, { date: newEnd }, tx);
    });
    return dto(prisma, auth, await load(prisma, id), false);
  },
  async cancel(id: string, actor: Actor): Promise<ProbationCaseDto> {
    await prisma.$transaction(async (tx) => {
      await lockRow(tx, 'probation_cases', id);
      const c = await load(tx, id);
      if (!['ACTIVE', 'PENDING_REVIEW', 'EXTENDED'].includes(c.status)) throw new AppError(409, 'PROBATION_CASE_CLOSED', 'This probation case is closed');
      await tx.probationCase.update({ where: { id }, data: { status: 'CANCELLED', cancelledAt: new Date() } });
      await auditService.log(lifecycleAudit(actor, AUDIT_ACTIONS.CANCEL_PROBATION_CASE, 'ProbationCase', id, { from: c.status }), tx);
    });
    return dto(prisma, actor.auth, await load(prisma, id), false);
  },
  /** The employee's own view: period, current end, status and final outcome. No reviewer, no comment. */
  async mine(auth: AuthContext) {
    if (!auth.employeeId) return null;
    const r = await prisma.probationCase.findFirst({ where: { employeeId: auth.employeeId, status: { not: 'CANCELLED' } }, include, orderBy: { createdAt: 'desc' } });
    return r ? { startDate: r.startDate, currentEndDate: r.currentEndDate, status: r.status, finalOutcome: r.finalOutcome, extensions: r.reviews.filter((x) => x.outcome === 'EXTEND').length } : null;
  },
};
