import {
  AUDIT_ACTIONS, NOTIFICATION_TYPES, PERMISSIONS,
  type AddIdpItemInput, type CreateIdpInput, type IdpDetailDto, type IdpItemDto, type IdpListQuery,
  type IdpSummaryDto, type UpdateIdpInput, type UpdateIdpItemInput, type UpdateIdpProgressInput,
} from '@hr/shared';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { AppError } from '../../lib/errors';
import { auditService } from '../../services/audit/audit.service';
import { notificationService } from '../../services/notification/notification.service';
import { hasPermission } from '../../services/authorization/authorization.service';
import { employeeScopeWhere } from '../employees/employees.scope';
import type { AuthContext } from '../auth/auth.types';
import { commentAudit, trainingAudit, type Actor, type Tx } from './training.types';

/**
 * Individual development plans: what somebody is going to do about their development this period, and how far they
 * have got.
 *
 * Training is one development type among several — on-the-job work, coaching, mentoring, a project — which is the
 * whole reason a plan exists rather than a list of courses. An item booked onto a training session completes when
 * that training is completed, because two records of the same fact would disagree; everything else is moved by hand.
 *
 * A plan item snapshots the competency it is about, so renaming one next year never makes an old plan unreadable.
 */
const idpInclude = {
  employee: { select: { id: true, employeeCode: true, firstName: true, lastName: true } },
  items: {
    include: {
      competency: { select: { id: true, code: true, name: true } },
      linkedCourse: { select: { id: true, code: true, title: true } },
    },
    orderBy: { createdAt: 'asc' as const },
  },
} satisfies Prisma.IndividualDevelopmentPlanInclude;
type IdpRow = Prisma.IndividualDevelopmentPlanGetPayload<{ include: typeof idpInclude }>;

/**
 * `hrComment` is HR's own note and is only included for somebody who manages plans. The employee sees their own
 * comment and their manager's; the manager sees both of those. That split is documented, and tested.
 */
const toItemDto = (row: IdpRow['items'][number], includeHrComment: boolean): IdpItemDto => ({
  id: row.id,
  title: row.title,
  description: row.description,
  developmentType: row.developmentType as IdpItemDto['developmentType'],
  trainingNeedId: row.trainingNeedId,
  competency: row.competency ? { id: row.competency.id, code: row.competencyCodeSnapshot ?? row.competency.code, name: row.competencyNameSnapshot ?? row.competency.name } : null,
  linkedCourse: row.linkedCourse,
  linkedSessionId: row.linkedSessionId,
  targetDate: row.targetDate,
  status: row.status as IdpItemDto['status'],
  progressPercent: row.progressPercent,
  employeeComment: row.employeeComment,
  managerComment: row.managerComment,
  ...(includeHrComment ? { hrComment: row.hrComment } : {}),
  completedAt: row.completedAt?.toISOString() ?? null,
});

function toSummaryDto(row: IdpRow): IdpSummaryDto {
  const active = row.items.filter((item) => item.status !== 'CANCELLED');
  const completed = active.filter((item) => item.status === 'COMPLETED');
  const progress = active.length === 0 ? 0 : Math.round(active.reduce((sum, item) => sum + (item.status === 'COMPLETED' ? 100 : item.progressPercent), 0) / active.length);
  return {
    id: row.id,
    employee: {
      id: row.employee.id, employeeCode: row.employeeCodeSnapshot,
      firstName: row.employee.firstName, lastName: row.employee.lastName,
      departmentName: row.departmentNameSnapshot,
    },
    title: row.title,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    status: row.status as IdpSummaryDto['status'],
    manager: { employeeId: row.managerEmployeeId, name: row.managerNameSnapshot },
    itemCount: active.length,
    completedItemCount: completed.length,
    progressPercent: progress,
    activatedAt: row.activatedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
  };
}

const toDetailDto = (row: IdpRow, includeHrComment: boolean): IdpDetailDto => ({
  ...toSummaryDto(row),
  items: row.items.map((item) => toItemDto(item, includeHrComment)),
});

async function load(db: Prisma.TransactionClient | typeof prisma, id: string): Promise<IdpRow> {
  const row = await db.individualDevelopmentPlan.findUnique({ where: { id }, include: idpInclude });
  if (!row) throw new AppError(404, 'IDP_NOT_FOUND', 'Development plan not found');
  return row;
}

const lockIdp = async (tx: Tx, id: string) => {
  await tx.$executeRaw`SELECT "id" FROM "individual_development_plans" WHERE "id" = ${id} FOR UPDATE`;
};

/** Who may read one plan: the employee, their manager (team scope), or somebody who manages plans. */
function assertCanRead(auth: AuthContext, idp: { employeeId: string; managerUserId: string | null }) {
  if (hasPermission(auth, PERMISSIONS.IDP_MANAGE)) return;
  if (auth.employeeId && idp.employeeId === auth.employeeId) return;
  if (idp.managerUserId && idp.managerUserId === auth.userId) return;
  throw AppError.forbidden();
}

export const idpService = {
  async create(input: CreateIdpInput, actor: Actor): Promise<IdpDetailDto> {
    const row = await prisma.$transaction(async (tx) => {
      const employee = await tx.employee.findUnique({
        where: { id: input.employeeId },
        select: {
          id: true, employeeCode: true, firstName: true, lastName: true,
          department: { select: { name: true } },
          manager: { select: { id: true, firstName: true, lastName: true, user: { select: { id: true, isActive: true } } } },
        },
      });
      if (!employee) throw new AppError(404, 'EMPLOYEE_NOT_FOUND', 'Employee not found');

      // One plan in flight per employee per overlapping period — two live plans is two versions of the truth.
      const clash = await tx.individualDevelopmentPlan.findFirst({
        where: {
          employeeId: employee.id,
          status: { in: ['DRAFT', 'ACTIVE'] },
          periodStart: { lte: input.periodEnd },
          periodEnd: { gte: input.periodStart },
        },
        select: { id: true, title: true },
      });
      if (clash) throw new AppError(409, 'IDP_PERIOD_OVERLAP', `"${clash.title}" already covers part of that period for this employee`);

      const created = await tx.individualDevelopmentPlan.create({
        data: {
          employeeId: employee.id,
          employeeCodeSnapshot: employee.employeeCode,
          employeeNameSnapshot: `${employee.firstName} ${employee.lastName}`,
          departmentNameSnapshot: employee.department?.name ?? null,
          title: input.title,
          periodStart: input.periodStart,
          periodEnd: input.periodEnd,
          managerEmployeeId: employee.manager?.id ?? null,
          managerUserId: employee.manager?.user?.isActive ? employee.manager.user.id : null,
          managerNameSnapshot: employee.manager ? `${employee.manager.firstName} ${employee.manager.lastName}` : null,
          status: 'DRAFT',
          createdByUserId: actor.auth.userId,
        },
        include: idpInclude,
      });
      await auditService.log(trainingAudit(actor, AUDIT_ACTIONS.CREATE_IDP, 'IndividualDevelopmentPlan', created.id, {
        employee: created.employeeCodeSnapshot, title: created.title, period: `${created.periodStart}→${created.periodEnd}`,
      }), tx);
      return created;
    });
    return toDetailDto(row, true);
  },

  async update(id: string, input: UpdateIdpInput, actor: Actor): Promise<IdpDetailDto> {
    const row = await prisma.$transaction(async (tx) => {
      const before = await load(tx, id);
      if (['COMPLETED', 'CANCELLED'].includes(before.status)) throw new AppError(409, 'IDP_FINISHED', `This plan is ${before.status.toLowerCase()}`);
      const after = await tx.individualDevelopmentPlan.update({
        where: { id },
        data: {
          title: input.title, periodStart: input.periodStart, periodEnd: input.periodEnd,
          status: input.status, cancelledAt: input.status === 'CANCELLED' ? new Date() : undefined,
        },
        include: idpInclude,
      });
      await auditService.log(trainingAudit(actor, AUDIT_ACTIONS.UPDATE_IDP, 'IndividualDevelopmentPlan', id,
        { title: after.title, status: after.status }, { title: before.title, status: before.status }), tx);
      return after;
    });
    return toDetailDto(row, true);
  },

  async activate(id: string, actor: Actor): Promise<IdpDetailDto> {
    const row = await prisma.$transaction(async (tx) => {
      await lockIdp(tx, id);
      const idp = await load(tx, id);
      if (idp.status !== 'DRAFT') throw new AppError(409, 'IDP_NOT_DRAFT', `This plan is already ${idp.status.toLowerCase()}`);
      if (idp.items.length === 0) throw new AppError(422, 'IDP_EMPTY', 'A development plan needs at least one activity');
      const after = await tx.individualDevelopmentPlan.update({ where: { id }, data: { status: 'ACTIVE', activatedAt: new Date() }, include: idpInclude });
      await auditService.log(trainingAudit(actor, AUDIT_ACTIONS.ACTIVATE_IDP, 'IndividualDevelopmentPlan', id, {
        employee: idp.employeeCodeSnapshot, items: idp.items.length,
      }), tx);
      await notificationService.publish(
        {
          userId: (await tx.user.findFirst({ where: { employeeId: idp.employeeId }, select: { id: true } }))?.id ?? null,
          type: NOTIFICATION_TYPES.IDP_ACTIVATED,
          source: { module: 'training', entityType: 'IDP', entityId: id },
          data: { idpId: id },
          dedupeKey: `idp:${id}:activated`,
        },
        { cycleName: idp.title },
        tx,
      );
      return after;
    });
    return toDetailDto(row, true);
  },

  /**
   * Completing a plan. Guarded rather than automatic: every activity that has not been cancelled must be complete,
   * and somebody has to say so — a plan quietly completing itself is a plan nobody reviewed.
   */
  async complete(id: string, actor: Actor): Promise<IdpDetailDto> {
    const row = await prisma.$transaction(async (tx) => {
      await lockIdp(tx, id);
      const idp = await load(tx, id);
      if (idp.status === 'COMPLETED') throw new AppError(409, 'IDP_ALREADY_COMPLETED', 'This plan is already complete');
      if (idp.status !== 'ACTIVE') throw new AppError(409, 'IDP_NOT_ACTIVE', `A ${idp.status.toLowerCase()} plan cannot be completed`);
      const outstanding = idp.items.filter((item) => !['COMPLETED', 'CANCELLED'].includes(item.status));
      if (outstanding.length > 0) {
        throw new AppError(422, 'IDP_ITEMS_OUTSTANDING', `${outstanding.length} activit${outstanding.length === 1 ? 'y is' : 'ies are'} not finished yet`);
      }
      const after = await tx.individualDevelopmentPlan.update({ where: { id }, data: { status: 'COMPLETED', completedAt: new Date() }, include: idpInclude });
      await auditService.log(trainingAudit(actor, AUDIT_ACTIONS.COMPLETE_IDP, 'IndividualDevelopmentPlan', id, {
        employee: idp.employeeCodeSnapshot, items: idp.items.length,
      }), tx);
      await notificationService.publish(
        {
          userId: (await tx.user.findFirst({ where: { employeeId: idp.employeeId }, select: { id: true } }))?.id ?? null,
          type: NOTIFICATION_TYPES.IDP_COMPLETED,
          source: { module: 'training', entityType: 'IDP', entityId: id },
          data: { idpId: id },
          dedupeKey: `idp:${id}:completed`,
        },
        { cycleName: idp.title },
        tx,
      );
      return after;
    });
    return toDetailDto(row, true);
  },

  async list(auth: AuthContext, q: IdpListQuery): Promise<{ data: IdpSummaryDto[]; meta: { page: number; pageSize: number; total: number } }> {
    const where: Prisma.IndividualDevelopmentPlanWhereInput = {
      employeeId: q.employeeId,
      status: q.status,
      ...(q.search ? { OR: [{ title: { contains: q.search, mode: 'insensitive' } }, { employeeNameSnapshot: { contains: q.search, mode: 'insensitive' } }] } : {}),
    };
    if (q.view === 'all') {
      if (!hasPermission(auth, PERMISSIONS.IDP_MANAGE)) throw AppError.forbidden();
    } else if (q.view === 'team') {
      where.employee = employeeScopeWhere(auth);
    } else {
      if (!auth.employeeId) return { data: [], meta: { page: q.page, pageSize: q.pageSize, total: 0 } };
      where.employeeId = auth.employeeId;
    }
    const [total, rows] = await prisma.$transaction([
      prisma.individualDevelopmentPlan.count({ where }),
      prisma.individualDevelopmentPlan.findMany({ where, include: idpInclude, orderBy: [{ periodStart: 'desc' }, { employeeCodeSnapshot: 'asc' }], skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
    ]);
    return { data: rows.map(toSummaryDto), meta: { page: q.page, pageSize: q.pageSize, total } };
  },

  async get(auth: AuthContext, id: string): Promise<IdpDetailDto> {
    const row = await load(prisma, id);
    assertCanRead(auth, row);
    return toDetailDto(row, hasPermission(auth, PERMISSIONS.IDP_MANAGE));
  },

  // -------------------------------------------------------------------------
  // activities
  // -------------------------------------------------------------------------
  async addItem(idpId: string, input: AddIdpItemInput, actor: Actor): Promise<IdpDetailDto> {
    const row = await prisma.$transaction(async (tx) => {
      const idp = await load(tx, idpId);
      if (['COMPLETED', 'CANCELLED'].includes(idp.status)) throw new AppError(409, 'IDP_FINISHED', `This plan is ${idp.status.toLowerCase()}`);

      // An activity raised from a need inherits the competency and its wording, frozen here.
      let competencyId = input.competencyId ?? null;
      let snapshot: { code: string; name: string } | null = null;
      if (input.trainingNeedId) {
        const need = await tx.trainingNeed.findUnique({
          where: { id: input.trainingNeedId },
          select: { id: true, employeeId: true, competencyId: true, competencyCodeSnapshot: true, competencyNameSnapshot: true, status: true },
        });
        if (!need) throw new AppError(404, 'TRAINING_NEED_NOT_FOUND', 'Training need not found');
        if (need.employeeId !== idp.employeeId) throw new AppError(409, 'TRAINING_NEED_OTHER_EMPLOYEE', 'That development need belongs to somebody else');
        competencyId = competencyId ?? need.competencyId;
        if (need.competencyCodeSnapshot && need.competencyNameSnapshot) snapshot = { code: need.competencyCodeSnapshot, name: need.competencyNameSnapshot };
        if (need.status === 'OPEN') await tx.trainingNeed.update({ where: { id: need.id }, data: { status: 'PLANNED' } });
      }
      if (competencyId && !snapshot) {
        const competency = await tx.competency.findUnique({ where: { id: competencyId }, select: { code: true, name: true } });
        if (!competency) throw new AppError(404, 'COMPETENCY_NOT_FOUND', 'Competency not found');
        snapshot = competency;
      }
      if (input.linkedCourseId) {
        const course = await tx.trainingCourse.findUnique({ where: { id: input.linkedCourseId }, select: { id: true } });
        if (!course) throw new AppError(404, 'TRAINING_COURSE_NOT_FOUND', 'Course not found');
      }

      await tx.idpItem.create({
        data: {
          idpId,
          title: input.title,
          description: input.description ?? null,
          developmentType: input.developmentType,
          trainingNeedId: input.trainingNeedId ?? null,
          competencyId,
          competencyCodeSnapshot: snapshot?.code ?? null,
          competencyNameSnapshot: snapshot?.name ?? null,
          linkedCourseId: input.linkedCourseId ?? null,
          targetDate: input.targetDate ?? null,
          status: 'PLANNED',
        },
      });
      await auditService.log(trainingAudit(actor, AUDIT_ACTIONS.UPDATE_IDP_ITEM, 'IndividualDevelopmentPlan', idpId, {
        added: input.title, developmentType: input.developmentType, fromNeed: !!input.trainingNeedId,
      }), tx);
      return load(tx, idpId);
    });
    return toDetailDto(row, true);
  },

  async updateItem(itemId: string, input: UpdateIdpItemInput, actor: Actor): Promise<IdpDetailDto> {
    const row = await prisma.$transaction(async (tx) => {
      const item = await tx.idpItem.findUnique({ where: { id: itemId } });
      if (!item) throw new AppError(404, 'IDP_ITEM_NOT_FOUND', 'Development activity not found');
      const idp = await load(tx, item.idpId);
      if (['COMPLETED', 'CANCELLED'].includes(idp.status)) throw new AppError(409, 'IDP_FINISHED', `This plan is ${idp.status.toLowerCase()}`);

      const after = await tx.idpItem.update({
        where: { id: itemId },
        data: {
          title: input.title,
          description: input.description,
          targetDate: input.targetDate,
          status: input.status,
          managerComment: input.managerComment,
          hrComment: input.hrComment,
          progressPercent: input.status === 'COMPLETED' ? 100 : undefined,
          completedAt: input.status === 'COMPLETED' ? new Date() : input.status ? null : undefined,
        },
      });
      await auditService.log(trainingAudit(actor, AUDIT_ACTIONS.UPDATE_IDP_ITEM, 'IdpItem', itemId, {
        title: after.title, status: after.status,
        ...commentAudit(item.managerComment, after.managerComment),
      }, { status: item.status }), tx);
      return load(tx, item.idpId);
    });
    return toDetailDto(row, true);
  },

  /** The employee's own update: how far they have got and what they want to say about it. */
  async updateProgress(auth: AuthContext, itemId: string, input: UpdateIdpProgressInput): Promise<IdpDetailDto> {
    const row = await prisma.$transaction(async (tx) => {
      const item = await tx.idpItem.findUnique({ where: { id: itemId } });
      if (!item) throw new AppError(404, 'IDP_ITEM_NOT_FOUND', 'Development activity not found');
      const idp = await load(tx, item.idpId);
      if (!auth.employeeId || idp.employeeId !== auth.employeeId) throw AppError.forbidden();
      if (idp.status !== 'ACTIVE') throw new AppError(409, 'IDP_NOT_ACTIVE', `This plan is ${idp.status.toLowerCase()}`);
      if (['COMPLETED', 'CANCELLED'].includes(item.status)) throw new AppError(409, 'IDP_ITEM_FINISHED', 'This activity is finished');

      await tx.idpItem.update({
        where: { id: itemId },
        data: {
          progressPercent: input.progressPercent,
          employeeComment: input.employeeComment,
          status: input.progressPercent !== undefined && input.progressPercent > 0 && item.status === 'PLANNED' ? 'IN_PROGRESS' : undefined,
        },
      });
      return load(tx, item.idpId);
    });
    return toDetailDto(row, hasPermission(auth, PERMISSIONS.IDP_MANAGE));
  },
};

export { assertCanRead as assertCanReadIdp };
