import type { Prisma } from '@prisma/client';
import { AUDIT_ACTIONS, type CreateOpeningInput, type OpeningDto, type OpeningListQuery, type UpdateOpeningInput } from '@hr/shared';
import { prisma } from '../../lib/prisma';
import { AppError } from '../../lib/errors';
import { auditService } from '../../services/audit/audit.service';
import type { AuthContext } from '../auth/auth.types';
import { isRecruitmentAdmin, lockRow, nextNumber, notFound, recruitmentAudit, textAudit, type Actor, type Db, type Tx } from './recruitment.types';

/**
 * Openings — the vacancies candidates apply to.
 *
 * An opening comes only from an APPROVED requisition and, with its siblings, never exceeds the approved headcount.
 * "Open" means it takes applications inside this system; nothing is published anywhere. `filledCount` is counted
 * from HIRED applications every time it is read — a counter that could drift would be worse than a slower query.
 */
const include = {
  requisition: { select: { requisitionNumber: true, requestedOpenings: true, status: true } },
  job: { select: { id: true, code: true, title: true } },
  _count: { select: { applications: { where: { stage: { in: ['APPLIED', 'SCREENING', 'INTERVIEW', 'OFFER'] } } } } },
  applications: { where: { stage: 'HIRED' }, select: { id: true } },
} satisfies Prisma.RecruitmentOpeningInclude;
type Row = Prisma.RecruitmentOpeningGetPayload<{ include: typeof include }>;

async function toDto(db: Db, row: Row): Promise<OpeningDto> {
  const position = row.positionId ? await db.position.findUnique({ where: { id: row.positionId }, select: { id: true, code: true, title: true } }) : null;
  const filledCount = row.applications.length;
  return {
    id: row.id, openingNumber: row.openingNumber, requisitionId: row.requisitionId, requisitionNumber: row.requisition.requisitionNumber,
    job: row.job, position,
    snapshot: { title: row.titleSnapshot, departmentName: row.departmentNameSnapshot, organizationName: row.organizationNameSnapshot },
    hiringManager: { employeeId: row.hiringManagerEmployeeId, userId: row.hiringManagerUserId, name: row.hiringManagerNameSnapshot },
    description: row.description, requirementsText: row.requirementsText, openingsCount: row.openingsCount,
    filledCount, isFull: filledCount >= row.openingsCount, activeApplications: row._count.applications,
    openedAt: row.openedAt?.toISOString() ?? null, targetCloseDate: row.targetCloseDate, status: row.status as OpeningDto['status'], createdAt: row.createdAt.toISOString(),
  };
}

export async function loadOpening(db: Db, id: string) {
  const row = await db.recruitmentOpening.findUnique({ where: { id }, include });
  if (!row) throw notFound('opening');
  return row;
}

const scopeWhere = (auth: AuthContext): Prisma.RecruitmentOpeningWhereInput => (isRecruitmentAdmin(auth) ? {} : { hiringManagerUserId: auth.userId });

/** Sum of every live opening on the requisition must stay within the approved headcount. */
async function assertWithinRequisition(tx: Tx, requisitionId: string, requestedOpenings: number, excludeOpeningId: string | null, adding: number) {
  const others = await tx.recruitmentOpening.aggregate({ where: { requisitionId, status: { not: 'CANCELLED' }, ...(excludeOpeningId ? { id: { not: excludeOpeningId } } : {}) }, _sum: { openingsCount: true } });
  const total = (others._sum.openingsCount ?? 0) + adding;
  if (total > requestedOpenings) throw new AppError(422, 'REQUISITION_HEADCOUNT_EXCEEDED', `The requisition approved ${requestedOpenings} opening(s); this would make ${total}`);
}

export const openingService = {
  async list(auth: AuthContext, q: OpeningListQuery) {
    const where: Prisma.RecruitmentOpeningWhereInput = { ...scopeWhere(auth), status: q.status, ...(q.organizationId ? { requisition: { organizationId: q.organizationId } } : {}) };
    const [total, rows] = await prisma.$transaction([
      prisma.recruitmentOpening.count({ where }),
      prisma.recruitmentOpening.findMany({ where, include, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
    ]);
    return { data: await Promise.all(rows.map((r) => toDto(prisma, r))), meta: { page: q.page, pageSize: q.pageSize, total } };
  },

  async get(auth: AuthContext, id: string): Promise<OpeningDto> {
    const row = await prisma.recruitmentOpening.findFirst({ where: { id, ...scopeWhere(auth) }, include });
    if (!row) throw notFound('opening');
    return toDto(prisma, row);
  },

  async create(input: CreateOpeningInput, actor: Actor): Promise<OpeningDto> {
    const id = await prisma.$transaction(async (tx) => {
      await lockRow(tx, 'recruitment_requisitions', input.requisitionId);
      const req = await tx.recruitmentRequisition.findUnique({ where: { id: input.requisitionId }, include: { organization: { select: { name: true } }, job: { select: { title: true } }, hiringManagerEmployee: { select: { firstName: true, lastName: true } } } });
      if (!req) throw notFound('requisition');
      if (req.status !== 'APPROVED') throw new AppError(409, 'REQUISITION_NOT_APPROVED', 'Openings can only be created from an approved requisition');
      await assertWithinRequisition(tx, req.id, req.requestedOpenings, null, input.openingsCount);
      const department = req.departmentId ? await tx.department.findUnique({ where: { id: req.departmentId }, select: { name: true } }) : null;
      const openingNumber = await nextNumber(tx, 'opening');
      const created = await tx.recruitmentOpening.create({
        data: {
          openingNumber, requisitionId: req.id, jobId: req.jobId, positionId: req.positionId,
          titleSnapshot: req.positionTitleSnapshot ?? req.jobTitleSnapshot ?? req.job.title,
          departmentNameSnapshot: req.departmentNameSnapshot ?? department?.name ?? null, organizationNameSnapshot: req.organizationNameSnapshot ?? req.organization.name,
          hiringManagerUserId: req.hiringManagerUserId, hiringManagerEmployeeId: req.hiringManagerEmployeeId,
          hiringManagerNameSnapshot: req.hiringManagerNameSnapshot ?? (req.hiringManagerEmployee ? `${req.hiringManagerEmployee.firstName} ${req.hiringManagerEmployee.lastName}` : null),
          description: input.description ?? null, requirementsText: input.requirementsText ?? null, openingsCount: input.openingsCount,
          targetCloseDate: input.targetCloseDate ?? null, createdByUserId: actor.auth.userId,
        },
      });
      await auditService.log(recruitmentAudit(actor, AUDIT_ACTIONS.CREATE_RECRUITMENT_OPENING, 'RecruitmentOpening', created.id, { openingNumber, requisitionId: req.id, openingsCount: input.openingsCount }), tx);
      return created.id;
    });
    return toDto(prisma, await loadOpening(prisma, id));
  },

  async update(id: string, input: UpdateOpeningInput, actor: Actor): Promise<OpeningDto> {
    await prisma.$transaction(async (tx) => {
      await lockRow(tx, 'recruitment_openings', id);
      const before = await loadOpening(tx, id);
      if (before.status === 'CLOSED' || before.status === 'CANCELLED') throw new AppError(409, 'OPENING_CLOSED', `A ${before.status.toLowerCase()} opening cannot be edited`);
      if (input.openingsCount !== undefined) {
        await lockRow(tx, 'recruitment_requisitions', before.requisitionId);
        await assertWithinRequisition(tx, before.requisitionId, before.requisition.requestedOpenings, id, input.openingsCount);
        if (input.openingsCount < before.applications.length) throw new AppError(422, 'OPENINGS_BELOW_HIRES', `${before.applications.length} candidate(s) are already hired against this opening`);
      }
      await tx.recruitmentOpening.update({ where: { id }, data: { openingsCount: input.openingsCount, description: input.description, requirementsText: input.requirementsText, targetCloseDate: input.targetCloseDate } });
      await auditService.log(recruitmentAudit(actor, AUDIT_ACTIONS.UPDATE_RECRUITMENT_OPENING, 'RecruitmentOpening', id,
        { fields: Object.keys(input).filter((k) => !['description', 'requirementsText'].includes(k)), openingsCount: input.openingsCount, ...textAudit('description', before.description, input.description === undefined ? before.description : input.description), ...textAudit('requirementsText', before.requirementsText, input.requirementsText === undefined ? before.requirementsText : input.requirementsText) },
        { openingsCount: before.openingsCount }), tx);
    });
    return toDto(prisma, await loadOpening(prisma, id));
  },

  /** DRAFT → OPEN, ON_HOLD → OPEN. */
  async open(id: string, actor: Actor): Promise<OpeningDto> {
    await prisma.$transaction(async (tx) => {
      await lockRow(tx, 'recruitment_openings', id);
      const row = await loadOpening(tx, id);
      if (row.status !== 'DRAFT' && row.status !== 'ON_HOLD') throw new AppError(409, 'OPENING_STATUS_INVALID', `A ${row.status.toLowerCase()} opening cannot be opened`);
      if (row.requisition.status !== 'APPROVED') throw new AppError(409, 'REQUISITION_NOT_APPROVED', 'The requisition is no longer approved');
      await tx.recruitmentOpening.update({ where: { id }, data: { status: 'OPEN', openedAt: row.openedAt ?? new Date() } });
      await auditService.log(recruitmentAudit(actor, AUDIT_ACTIONS.OPEN_RECRUITMENT_OPENING, 'RecruitmentOpening', id, { status: 'OPEN' }, { status: row.status }), tx);
    });
    return toDto(prisma, await loadOpening(prisma, id));
  },

  async hold(id: string, actor: Actor): Promise<OpeningDto> {
    await prisma.$transaction(async (tx) => {
      await lockRow(tx, 'recruitment_openings', id);
      const row = await loadOpening(tx, id);
      if (row.status !== 'OPEN') throw new AppError(409, 'OPENING_STATUS_INVALID', 'Only an open opening can be put on hold');
      await tx.recruitmentOpening.update({ where: { id }, data: { status: 'ON_HOLD' } });
      await auditService.log(recruitmentAudit(actor, AUDIT_ACTIONS.UPDATE_RECRUITMENT_OPENING, 'RecruitmentOpening', id, { status: 'ON_HOLD' }, { status: 'OPEN' }), tx);
    });
    return toDto(prisma, await loadOpening(prisma, id));
  },

  /** Closing is a decision, never a side effect of the last hire; a draft that never opened is cancelled instead. */
  async close(id: string, actor: Actor): Promise<OpeningDto> {
    await prisma.$transaction(async (tx) => {
      await lockRow(tx, 'recruitment_openings', id);
      const row = await loadOpening(tx, id);
      if (row.status === 'CLOSED' || row.status === 'CANCELLED') throw new AppError(409, 'OPENING_CLOSED', `This opening is already ${row.status.toLowerCase()}`);
      const next = row.status === 'DRAFT' ? 'CANCELLED' : 'CLOSED';
      await tx.recruitmentOpening.update({ where: { id }, data: { status: next, closedAt: new Date() } });
      await auditService.log(recruitmentAudit(actor, AUDIT_ACTIONS.CLOSE_RECRUITMENT_OPENING, 'RecruitmentOpening', id, { status: next, activeApplications: row._count.applications }, { status: row.status }), tx);
    });
    return toDto(prisma, await loadOpening(prisma, id));
  },
};
