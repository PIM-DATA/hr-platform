import type { Prisma } from '@prisma/client';
import {
  AUDIT_ACTIONS, businessToday, stageMoveCheck, type ApplicationDetailDto, type ApplicationDto, type ApplicationListQuery, type CreateApplicationInput,
  type MoveStageInput, type RejectApplicationInput, type StageHistoryDto, type WithdrawApplicationInput,
} from '@hr/shared';
import { prisma } from '../../lib/prisma';
import { AppError } from '../../lib/errors';
import { auditService } from '../../services/audit/audit.service';
import type { AuthContext } from '../auth/auth.types';
import { applicationScopeWhere, lockRow, nextNumber, notFound, recruitmentAudit, textAudit, type Actor, type Db, type Tx } from './recruitment.types';
import { interviewDtos } from './interview.service';

/**
 * Applications — one candidate against one opening.
 *
 * Stages are a fixed pipeline: APPLIED → SCREENING → INTERVIEW → OFFER, and then HIRED, REJECTED or WITHDRAWN. Every
 * move is somebody's explicit action, recorded in an append-only history with who, when and why. Nothing here moves
 * a candidate on its own: not a submitted feedback, not an accepted offer, not a passing date.
 */
export const applicationInclude = {
  candidate: { select: { id: true, candidateNumber: true, firstName: true, lastName: true, email: true, source: true } },
  opening: { select: { id: true, openingNumber: true, titleSnapshot: true, departmentNameSnapshot: true, status: true, hiringManagerUserId: true, openingsCount: true } },
  _count: { select: { interviews: true } },
  offers: { select: { status: true }, orderBy: { createdAt: 'desc' as const }, take: 1 },
} satisfies Prisma.RecruitmentApplicationInclude;
type Row = Prisma.RecruitmentApplicationGetPayload<{ include: typeof applicationInclude }>;

export const toApplicationDto = (row: Row): ApplicationDto => ({
  id: row.id, applicationNumber: row.applicationNumber,
  candidate: { id: row.candidate.id, candidateNumber: row.candidate.candidateNumber, firstName: row.candidate.firstName, lastName: row.candidate.lastName, email: row.candidate.email, source: row.candidate.source },
  opening: { id: row.opening.id, openingNumber: row.opening.openingNumber, title: row.opening.titleSnapshot, departmentName: row.opening.departmentNameSnapshot, status: row.opening.status },
  stage: row.stage as ApplicationDto['stage'], appliedAt: row.appliedAt, recruiterUserId: row.recruiterUserId, hiringManagerUserId: row.hiringManagerUserId,
  rejection: row.rejectedAt ? { reasonCode: row.rejectionReasonCode ?? 'OTHER', note: row.rejectionNote, at: row.rejectedAt.toISOString() } : null,
  withdrawal: row.withdrawnAt ? { note: row.withdrawnNote, at: row.withdrawnAt.toISOString() } : null,
  hiredEmployeeId: row.hiredEmployeeId, hiredAt: row.hiredAt?.toISOString() ?? null,
  interviewCount: row._count.interviews, offerStatus: row.offers[0]?.status ?? null, createdAt: row.createdAt.toISOString(),
});

export async function loadApplication(db: Db, id: string) {
  const row = await db.recruitmentApplication.findUnique({ where: { id }, include: applicationInclude });
  if (!row) throw notFound('application');
  return row;
}

/** Scoped load: a 404 for anyone outside the application's hiring team, never a 403 that confirms it exists. */
export async function loadApplicationFor(auth: AuthContext, id: string) {
  const row = await prisma.recruitmentApplication.findFirst({ where: { id, ...applicationScopeWhere(auth) }, include: applicationInclude });
  if (!row) throw notFound('application');
  return row;
}

export async function recordStage(tx: Tx, applicationId: string, fromStage: string | null, toStage: string, userId: string, reason: string | null) {
  await tx.recruitmentApplication.update({ where: { id: applicationId }, data: { stage: toStage } });
  await tx.recruitmentApplicationStageHistory.create({ data: { applicationId, fromStage, toStage, changedByUserId: userId, reason } });
}

async function history(db: Db, applicationId: string): Promise<StageHistoryDto[]> {
  const rows = await db.recruitmentApplicationStageHistory.findMany({ where: { applicationId }, orderBy: { changedAt: 'asc' } });
  const userIds = [...new Set(rows.map((r) => r.changedByUserId))];
  const users = userIds.length ? await db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, employee: { select: { firstName: true, lastName: true } }, email: true } }) : [];
  const name = (id: string) => { const u = users.find((x) => x.id === id); return u ? (u.employee ? `${u.employee.firstName} ${u.employee.lastName}` : u.email) : null; };
  return rows.map((r) => ({ fromStage: r.fromStage, toStage: r.toStage, changedBy: name(r.changedByUserId), changedAt: r.changedAt.toISOString(), reason: r.reason }));
}

export const applicationService = {
  async list(auth: AuthContext, q: ApplicationListQuery) {
    const where: Prisma.RecruitmentApplicationWhereInput = {
      ...applicationScopeWhere(auth), openingId: q.openingId, candidateId: q.candidateId, stage: q.stage,
      ...(q.active ? { stage: { in: ['APPLIED', 'SCREENING', 'INTERVIEW', 'OFFER'] } } : {}),
      ...(q.search ? { OR: [{ applicationNumber: { contains: q.search, mode: 'insensitive' } }, { candidate: { OR: [{ firstName: { contains: q.search, mode: 'insensitive' } }, { lastName: { contains: q.search, mode: 'insensitive' } }] } }] } : {}),
    };
    const [total, rows] = await prisma.$transaction([
      prisma.recruitmentApplication.count({ where }),
      prisma.recruitmentApplication.findMany({ where, include: applicationInclude, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
    ]);
    return { data: rows.map(toApplicationDto), meta: { page: q.page, pageSize: q.pageSize, total } };
  },

  async get(auth: AuthContext, id: string): Promise<ApplicationDetailDto> {
    const row = await loadApplicationFor(auth, id);
    const [stageHistory, interviews] = await Promise.all([history(prisma, id), interviewDtos(auth, { applicationId: id })]);
    return { ...toApplicationDto(row), stageHistory, interviews };
  },

  async create(input: CreateApplicationInput, actor: Actor): Promise<ApplicationDto> {
    const id = await prisma.$transaction(async (tx) => {
      await lockRow(tx, 'recruitment_openings', input.openingId);
      await lockRow(tx, 'recruitment_candidates', input.candidateId);
      const [opening, candidate] = await Promise.all([
        tx.recruitmentOpening.findUnique({ where: { id: input.openingId } }),
        tx.recruitmentCandidate.findUnique({ where: { id: input.candidateId } }),
      ]);
      if (!opening) throw notFound('opening');
      if (!candidate) throw notFound('candidate');
      const org = await tx.recruitmentRequisition.findUnique({ where: { id: opening.requisitionId }, select: { organization: { select: { timezone: true } } } });
      const orgTimezone = org?.organization.timezone ?? 'UTC';
      if (opening.status !== 'OPEN') throw new AppError(409, 'OPENING_NOT_OPEN', `This opening is ${opening.status.toLowerCase().replace('_', ' ')} and is not taking applications`);
      if (candidate.status !== 'ACTIVE') throw new AppError(409, 'CANDIDATE_NOT_ACTIVE', `This candidate is ${candidate.status.toLowerCase()}`);
      const existing = await tx.recruitmentApplication.findUnique({ where: { candidateId_openingId: { candidateId: candidate.id, openingId: opening.id } }, select: { applicationNumber: true } });
      if (existing) throw new AppError(409, 'APPLICATION_EXISTS', `This candidate already has application ${existing.applicationNumber} for this opening`);
      const applicationNumber = await nextNumber(tx, 'application');
      const created = await tx.recruitmentApplication.create({
        data: {
          applicationNumber, candidateId: candidate.id, openingId: opening.id, appliedAt: input.appliedAt ?? businessToday(orgTimezone), stage: 'APPLIED',
          recruiterUserId: actor.auth.userId, hiringManagerUserId: opening.hiringManagerUserId, sourceSnapshot: candidate.source,
          departmentNameSnapshot: opening.departmentNameSnapshot, jobTitleSnapshot: opening.titleSnapshot,
          stageHistory: { create: { fromStage: null, toStage: 'APPLIED', changedByUserId: actor.auth.userId, reason: null } },
        },
      });
      await auditService.log(recruitmentAudit(actor, AUDIT_ACTIONS.CREATE_APPLICATION, 'RecruitmentApplication', created.id, { applicationNumber, candidateId: candidate.id, openingId: opening.id, source: candidate.source }), tx);
      return created.id;
    });
    return toApplicationDto(await loadApplication(prisma, id));
  },

  /** An explicit move between active stages. Backwards needs a reason; the check is the shared pure rule. */
  async moveStage(id: string, input: MoveStageInput, actor: Actor): Promise<ApplicationDetailDto> {
    await prisma.$transaction(async (tx) => {
      await lockRow(tx, 'recruitment_applications', id);
      const row = await loadApplication(tx, id);
      const check = stageMoveCheck(row.stage, input.toStage, input.reason);
      if (!check.ok) throw new AppError(check.code === 'REASON_REQUIRED' ? 422 : 409, check.code, check.message);
      if (row.opening.status !== 'OPEN') throw new AppError(409, 'OPENING_NOT_OPEN', `The opening is ${row.opening.status.toLowerCase().replace('_', ' ')}`);
      await recordStage(tx, id, row.stage, input.toStage, actor.auth.userId, input.reason?.trim() || null);
      await auditService.log(recruitmentAudit(actor, AUDIT_ACTIONS.MOVE_APPLICATION_STAGE, 'RecruitmentApplication', id, { applicationNumber: row.applicationNumber, toStage: input.toStage, backwards: check.backwards, ...textAudit('reason', null, input.reason) }, { stage: row.stage }), tx);
    });
    return this.get(actor.auth, id);
  },

  /** A rejection is a coded reason plus an optional note. The code is aggregated in reports; the note never is. */
  async reject(id: string, input: RejectApplicationInput, actor: Actor): Promise<ApplicationDetailDto> {
    await prisma.$transaction(async (tx) => {
      await lockRow(tx, 'recruitment_applications', id);
      const row = await loadApplication(tx, id);
      if (!['APPLIED', 'SCREENING', 'INTERVIEW', 'OFFER'].includes(row.stage)) throw new AppError(409, 'APPLICATION_CLOSED', `This application is already ${row.stage.toLowerCase()}`);
      const liveOffer = await tx.recruitmentOffer.findFirst({ where: { applicationId: id, status: { in: ['PENDING_APPROVAL', 'APPROVED', 'SENT', 'ACCEPTED'] } }, select: { offerNumber: true } });
      if (liveOffer) throw new AppError(409, 'OFFER_IN_PROGRESS', `Withdraw offer ${liveOffer.offerNumber} first`);
      await tx.recruitmentApplication.update({ where: { id }, data: { rejectionReasonCode: input.reasonCode, rejectionNote: input.note ?? null, rejectedAt: new Date() } });
      await recordStage(tx, id, row.stage, 'REJECTED', actor.auth.userId, input.reasonCode);
      await tx.recruitmentInterview.updateMany({ where: { applicationId: id, status: 'SCHEDULED' }, data: { status: 'CANCELLED', cancelledAt: new Date() } });
      await auditService.log(recruitmentAudit(actor, AUDIT_ACTIONS.REJECT_APPLICATION, 'RecruitmentApplication', id, { applicationNumber: row.applicationNumber, reasonCode: input.reasonCode, ...textAudit('note', null, input.note) }, { stage: row.stage }), tx);
    });
    return this.get(actor.auth, id);
  },

  /** HR records that the candidate withdrew. The candidate has no login; this is a record of what they told us. */
  async withdraw(id: string, input: WithdrawApplicationInput, actor: Actor): Promise<ApplicationDetailDto> {
    await prisma.$transaction(async (tx) => {
      await lockRow(tx, 'recruitment_applications', id);
      const row = await loadApplication(tx, id);
      if (!['APPLIED', 'SCREENING', 'INTERVIEW', 'OFFER'].includes(row.stage)) throw new AppError(409, 'APPLICATION_CLOSED', `This application is already ${row.stage.toLowerCase()}`);
      await tx.recruitmentApplication.update({ where: { id }, data: { withdrawnNote: input.note ?? null, withdrawnAt: new Date() } });
      await recordStage(tx, id, row.stage, 'WITHDRAWN', actor.auth.userId, null);
      await tx.recruitmentInterview.updateMany({ where: { applicationId: id, status: 'SCHEDULED' }, data: { status: 'CANCELLED', cancelledAt: new Date() } });
      await tx.recruitmentOffer.updateMany({ where: { applicationId: id, status: { in: ['DRAFT', 'APPROVED', 'SENT'] } }, data: { status: 'WITHDRAWN', withdrawnAt: new Date(), outcomeRecordedByUserId: actor.auth.userId } });
      await auditService.log(recruitmentAudit(actor, AUDIT_ACTIONS.WITHDRAW_APPLICATION, 'RecruitmentApplication', id, { applicationNumber: row.applicationNumber, ...textAudit('note', null, input.note) }, { stage: row.stage }), tx);
    });
    return this.get(actor.auth, id);
  },
};
