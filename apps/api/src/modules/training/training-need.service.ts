import {
  AUDIT_ACTIONS, PERMISSIONS,
  type CreateTrainingNeedInput, type GenerateTnaInput, type GenerateTnaResultDto, type TrainingNeedDto,
  type TrainingNeedListQuery, type UpdateTrainingNeedInput,
} from '@hr/shared';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { AppError } from '../../lib/errors';
import { auditService } from '../../services/audit/audit.service';
import { hasPermission } from '../../services/authorization/authorization.service';
import { employeeScopeWhere } from '../employees/employees.scope';
import { skillGapService } from '../competency/skill-gap.service';
import type { AuthContext } from '../auth/auth.types';
import { trainingAudit, type Actor, type Db } from './training.types';

/**
 * Training needs — the bridge from "this person is short of what their job asks for" to "here is what we are going
 * to do about it".
 *
 * Two boundaries hold this module up.
 *
 * **Gaps are the competency module's to calculate.** This service calls `getSkillGapsForDevelopment` and never
 * touches a competency assessment table. One definition of a gap, one place it can be wrong.
 *
 * **Unassessed is not a need.** A competency nobody has assessed produces no training need, ever: "nobody has
 * looked" is a reason to assess somebody, not evidence that they are deficient, and turning it into a need would
 * fabricate a shortfall the size of the whole requirement. Those come back separately, as `assessmentRequired`.
 *
 * And the need freezes the gap it was raised from. When the job's requirement moves next month, the need still
 * explains why somebody was sent on a course; what the gap is *today* is asked of the competency module, live.
 */
const needInclude = {
  employee: { select: { id: true, employeeCode: true, firstName: true, lastName: true } },
  competency: { select: { id: true, code: true, name: true } },
  enrollments: {
    select: { id: true, sessionId: true, status: true, session: { select: { courseTitleSnapshot: true } } },
    orderBy: { createdAt: 'desc' as const },
  },
} satisfies Prisma.TrainingNeedInclude;
type NeedRow = Prisma.TrainingNeedGetPayload<{ include: typeof needInclude }>;

const toNeedDto = (row: NeedRow, currentGapStatus: string | null = null): TrainingNeedDto => ({
  id: row.id,
  employee: { id: row.employee.id, employeeCode: row.employeeCodeSnapshot, firstName: row.employee.firstName, lastName: row.employee.lastName },
  snapshot: { departmentName: row.departmentNameSnapshot, jobTitle: row.jobTitleSnapshot },
  source: row.source as TrainingNeedDto['source'],
  title: row.title,
  description: row.description,
  competency: row.competency,
  gapSnapshot: row.source === 'COMPETENCY_GAP'
    ? { currentLevel: row.currentLevelSnapshot, requiredLevel: row.requiredLevelSnapshot, gap: row.gapSnapshot }
    : null,
  sourceAssessmentDate: row.sourceAssessmentDate?.toISOString() ?? null,
  priority: row.priority as TrainingNeedDto['priority'],
  status: row.status as TrainingNeedDto['status'],
  currentGapStatus,
  enrollments: row.enrollments.map((e) => ({ id: e.id, sessionId: e.sessionId, courseTitle: e.session.courseTitleSnapshot, status: e.status })),
  createdAt: row.createdAt.toISOString(),
});

/** A need is still being worked on until it is fulfilled or cancelled. */
const OPEN_STATUSES = ['OPEN', 'PLANNED', 'IN_PROGRESS'];

export const trainingNeedService = {
  /**
   * Generate development needs from the current skill gaps.
   *
   * Re-running this is normal — after a new assessment round, after adding a department — so an employee and
   * competency that already has an open need is counted, not duplicated. A need that was fulfilled and has since
   * re-opened as a gap does get a new one: that is a different gap, at a different time.
   */
  async generate(input: GenerateTnaInput, actor: Actor): Promise<GenerateTnaResultDto> {
    const gaps = await skillGapService.getSkillGapsForDevelopment({
      employeeId: input.employeeId,
      organizationId: input.organizationId,
      departmentId: input.departmentId,
      jobId: input.jobId,
    });

    const assessmentRequired = gaps
      .filter((gap) => gap.gapStatus === 'UNASSESSED')
      .map((gap) => ({ employeeCode: gap.employeeCode, competencyCode: gap.competencyCode }));
    const actionable = gaps.filter((gap) => gap.gapStatus === 'GAP' && (gap.gapNeeded ?? 0) > 0);

    if (actionable.length === 0) {
      return { created: 0, alreadyOpen: 0, assessmentRequired };
    }

    return prisma.$transaction(async (tx) => {
      const existing = await tx.trainingNeed.findMany({
        where: {
          employeeId: { in: [...new Set(actionable.map((gap) => gap.employeeId))] },
          competencyId: { in: [...new Set(actionable.map((gap) => gap.competencyId))] },
          status: { in: OPEN_STATUSES },
        },
        select: { employeeId: true, competencyId: true },
      });
      const open = new Set(existing.map((row) => `${row.employeeId}:${row.competencyId}`));

      const toCreate = actionable.filter((gap) => !open.has(`${gap.employeeId}:${gap.competencyId}`));
      if (toCreate.length > 0) {
        await tx.trainingNeed.createMany({
          data: toCreate.map((gap) => ({
            employeeId: gap.employeeId,
            source: 'COMPETENCY_GAP',
            title: `Develop ${gap.competencyName}`,
            competencyId: gap.competencyId,
            competencyCodeSnapshot: gap.competencyCode,
            competencyNameSnapshot: gap.competencyName,
            currentLevelSnapshot: gap.currentLevel,
            requiredLevelSnapshot: gap.requiredLevel,
            gapSnapshot: gap.gapNeeded,
            employeeCodeSnapshot: gap.employeeCode,
            employeeNameSnapshot: gap.employeeName,
            jobId: gap.jobId,
            jobTitleSnapshot: gap.jobTitle,
            departmentId: gap.departmentId,
            departmentNameSnapshot: gap.departmentName,
            sourceAssessmentDate: gap.assessmentDate ? new Date(gap.assessmentDate) : null,
            priority: input.priority,
            status: 'OPEN',
            createdByUserId: actor.auth.userId,
          })),
        });
      }

      await auditService.log(trainingAudit(actor, AUDIT_ACTIONS.GENERATE_TNA, 'TrainingNeed', 'bulk', {
        created: toCreate.length,
        alreadyOpen: actionable.length - toCreate.length,
        assessmentRequired: assessmentRequired.length,
        filters: { organizationId: input.organizationId, departmentId: input.departmentId, jobId: input.jobId, employeeId: input.employeeId },
      }), tx);

      return { created: toCreate.length, alreadyOpen: actionable.length - toCreate.length, assessmentRequired };
    });
  },

  /** A need somebody raised by hand — a compliance course, a new system, a leadership workshop. No competency needed. */
  async create(input: CreateTrainingNeedInput, actor: Actor): Promise<TrainingNeedDto> {
    const row = await prisma.$transaction(async (tx) => {
      const employee = await tx.employee.findUnique({
        where: { id: input.employeeId },
        select: {
          id: true, employeeCode: true, firstName: true, lastName: true, departmentId: true,
          department: { select: { name: true } },
          position: { select: { jobId: true, job: { select: { title: true } } } },
        },
      });
      if (!employee) throw new AppError(404, 'EMPLOYEE_NOT_FOUND', 'Employee not found');
      let competencySnapshot: { code: string; name: string } | null = null;
      if (input.competencyId) {
        const competency = await tx.competency.findUnique({ where: { id: input.competencyId }, select: { code: true, name: true } });
        if (!competency) throw new AppError(404, 'COMPETENCY_NOT_FOUND', 'Competency not found');
        competencySnapshot = competency;
      }

      const created = await tx.trainingNeed.create({
        data: {
          employeeId: employee.id,
          source: 'MANUAL',
          title: input.title,
          description: input.description ?? null,
          competencyId: input.competencyId ?? null,
          competencyCodeSnapshot: competencySnapshot?.code ?? null,
          competencyNameSnapshot: competencySnapshot?.name ?? null,
          employeeCodeSnapshot: employee.employeeCode,
          employeeNameSnapshot: `${employee.firstName} ${employee.lastName}`,
          jobId: employee.position?.jobId ?? null,
          jobTitleSnapshot: employee.position?.job?.title ?? null,
          departmentId: employee.departmentId,
          departmentNameSnapshot: employee.department?.name ?? null,
          priority: input.priority,
          status: 'OPEN',
          createdByUserId: actor.auth.userId,
        },
        include: needInclude,
      });
      await auditService.log(trainingAudit(actor, AUDIT_ACTIONS.CREATE_TRAINING_NEED, 'TrainingNeed', created.id, {
        employee: created.employeeCodeSnapshot, title: created.title, source: 'MANUAL',
      }), tx);
      return created;
    });
    return toNeedDto(row);
  },

  async update(id: string, input: UpdateTrainingNeedInput, actor: Actor): Promise<TrainingNeedDto> {
    const row = await prisma.$transaction(async (tx) => {
      const before = await tx.trainingNeed.findUnique({ where: { id }, include: needInclude });
      if (!before) throw new AppError(404, 'TRAINING_NEED_NOT_FOUND', 'Training need not found');
      const after = await tx.trainingNeed.update({
        where: { id },
        data: {
          status: input.status,
          priority: input.priority,
          description: input.description,
          fulfilledAt: input.status === 'FULFILLED' ? new Date() : input.status ? null : undefined,
        },
        include: needInclude,
      });
      await auditService.log(trainingAudit(actor, AUDIT_ACTIONS.UPDATE_TRAINING_NEED, 'TrainingNeed', id,
        { status: after.status, priority: after.priority }, { status: before.status, priority: before.priority }), tx);
      return after;
    });
    return toNeedDto(row);
  },

  /**
   * Listing needs. `mine` is the caller's own, `team` follows the data scope, `all` needs `training.manage` — a
   * training administrator's authority comes from their permission, not from who reports to them.
   */
  async list(auth: AuthContext, q: TrainingNeedListQuery): Promise<{ data: TrainingNeedDto[]; meta: { page: number; pageSize: number; total: number } }> {
    const where: Prisma.TrainingNeedWhereInput = {
      employeeId: q.employeeId,
      departmentId: q.departmentId,
      jobId: q.jobId,
      competencyId: q.competencyId,
      status: q.status,
      source: q.source,
      ...(q.search ? { OR: [{ title: { contains: q.search, mode: 'insensitive' } }, { employeeNameSnapshot: { contains: q.search, mode: 'insensitive' } }] } : {}),
    };
    if (q.view === 'all') {
      if (!hasPermission(auth, PERMISSIONS.TRAINING_MANAGE)) throw AppError.forbidden();
    } else if (q.view === 'team') {
      where.employee = employeeScopeWhere(auth);
    } else {
      if (!auth.employeeId) return { data: [], meta: { page: q.page, pageSize: q.pageSize, total: 0 } };
      where.employeeId = auth.employeeId;
    }

    const [total, rows] = await prisma.$transaction([
      prisma.trainingNeed.count({ where }),
      prisma.trainingNeed.findMany({ where, include: needInclude, orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }], skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
    ]);

    // What the competency module says today, so a need whose gap has since closed is visible as such. It is never
    // acted on automatically: whether the development is still worth doing is a person's decision.
    const gapStatuses = await currentGapStatuses(rows);
    return {
      data: rows.map((row) => toNeedDto(row, gapStatuses.get(`${row.employeeId}:${row.competencyId}`) ?? null)),
      meta: { page: q.page, pageSize: q.pageSize, total },
    };
  },

  async get(auth: AuthContext, id: string): Promise<TrainingNeedDto> {
    const row = await prisma.trainingNeed.findUnique({ where: { id }, include: needInclude });
    if (!row) throw new AppError(404, 'TRAINING_NEED_NOT_FOUND', 'Training need not found');
    assertCanReadNeed(auth, row);
    const gapStatuses = await currentGapStatuses([row]);
    return toNeedDto(row, gapStatuses.get(`${row.employeeId}:${row.competencyId}`) ?? null);
  },

  /** Moves a need on when its development actually happened, or back when it did not. Never touches a competency. */
  async setStatusFromEnrollment(db: Db, needId: string, status: 'IN_PROGRESS' | 'FULFILLED' | 'OPEN') {
    await db.trainingNeed.update({
      where: { id: needId },
      data: { status, fulfilledAt: status === 'FULFILLED' ? new Date() : null },
    });
  },
};

/** Asks the competency module what each gap-based need looks like now. One call per employee, not per need. */
async function currentGapStatuses(rows: { employeeId: string; competencyId: string | null }[]) {
  const employeeIds = [...new Set(rows.filter((r) => r.competencyId).map((r) => r.employeeId))];
  const statuses = new Map<string, string>();
  for (const employeeId of employeeIds) {
    const gaps = await skillGapService.getSkillGapsForDevelopment({ employeeId });
    for (const gap of gaps) statuses.set(`${employeeId}:${gap.competencyId}`, gap.gapStatus);
  }
  return statuses;
}

function assertCanReadNeed(auth: AuthContext, need: { employeeId: string }) {
  if (hasPermission(auth, PERMISSIONS.TRAINING_MANAGE)) return;
  if (auth.employeeId && need.employeeId === auth.employeeId) return;
  throw AppError.forbidden();
}

export { assertCanReadNeed, OPEN_STATUSES };
