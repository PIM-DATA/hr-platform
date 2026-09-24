import { Prisma } from '@prisma/client';
import { AUDIT_ACTIONS, RECRUITMENT_WORKFLOW, type CreateOfferInput, type OfferDto, type OfferListQuery, type UpdateOfferInput } from '@hr/shared';
import { prisma } from '../../lib/prisma';
import { AppError } from '../../lib/errors';
import { auditService } from '../../services/audit/audit.service';
import { workflowEngine } from '../../services/workflow';
import type { AuthContext } from '../auth/auth.types';
import { recruitmentPolicyService } from './policy.service';
import { applicationScopeWhere, canSeeCompensation, isRecruitmentAdmin, lockRow, nextNumber, notFound, recruitmentAudit, requesterEmployeeId, textAudit, type Actor, type Db, type Tx } from './recruitment.types';

/**
 * Offers.
 *
 * The salary on an offer is a recruitment proposal, confidential to `recruitment.manage_offers` and to the approver
 * deciding on it; everyone else gets the offer without the figure. Once approved the terms are frozen — a changed
 * offer is a new draft. "Sent", "accepted" and "declined" are HR's record of what happened outside the system: no
 * email leaves here and the candidate has no login. An accepted offer changes nothing by itself; hiring is a separate
 * decision with its own permission.
 */
const include = {
  application: { select: { applicationNumber: true, stage: true, hiringManagerUserId: true, candidate: { select: { id: true, firstName: true, lastName: true } }, opening: { select: { id: true, titleSnapshot: true, requisition: { select: { organizationId: true } } } } } },
} satisfies Prisma.RecruitmentOfferInclude;
type Row = Prisma.RecruitmentOfferGetPayload<{ include: typeof include }>;

const money = (d: Prisma.Decimal | null) => (d === null ? null : d.toFixed(2));

/** The approver of THIS offer sees the figure while it is theirs to decide, and afterwards — they approved it. */
async function isApprover(db: Db, auth: AuthContext, row: Row) {
  if (!row.workflowInstanceId) return false;
  return !!(await db.workflowInstanceStep.findFirst({ where: { instanceId: row.workflowInstanceId, approverUserId: auth.userId }, select: { id: true } }));
}

async function toDto(db: Db, auth: AuthContext, row: Row): Promise<OfferDto> {
  const compensationVisible = canSeeCompensation(auth) || (await isApprover(db, auth, row));
  return {
    id: row.id, offerNumber: row.offerNumber, applicationId: row.applicationId, applicationNumber: row.application.applicationNumber,
    candidate: row.application.candidate, opening: { id: row.application.opening.id, title: row.application.opening.titleSnapshot },
    status: row.status as OfferDto['status'], proposedStartDate: row.proposedStartDate, employmentType: row.employmentTypeSnapshot,
    position: row.positionId ? { id: row.positionId, title: row.positionTitleSnapshot ?? '' } : null,
    baseSalaryProposal: compensationVisible ? money(row.baseSalaryProposal) : null, currencyCode: row.currencyCode,
    otherTermsText: compensationVisible ? row.otherTermsText : null, compensationVisible,
    workflowInstanceId: row.workflowInstanceId,
    submittedAt: row.submittedAt?.toISOString() ?? null, approvedAt: row.approvedAt?.toISOString() ?? null, sentAt: row.sentAt?.toISOString() ?? null,
    acceptedAt: row.acceptedAt?.toISOString() ?? null, declinedAt: row.declinedAt?.toISOString() ?? null, withdrawnAt: row.withdrawnAt?.toISOString() ?? null,
    outcomeRecordedBy: row.outcomeRecordedByUserId, createdAt: row.createdAt.toISOString(),
  };
}

export async function loadOffer(db: Db, id: string) {
  const row = await db.recruitmentOffer.findUnique({ where: { id }, include });
  if (!row) throw notFound('offer');
  return row;
}

/** Offer lists: administrators and offer managers see all; a hiring manager sees their applications' offers (no figure). */
const scopeWhere = (auth: AuthContext): Prisma.RecruitmentOfferWhereInput =>
  isRecruitmentAdmin(auth) || canSeeCompensation(auth) ? {} : { OR: [{ application: { hiringManagerUserId: auth.userId } }, { workflowInstanceId: { in: [] } }] };

async function assertPosition(db: Db, positionId: string | null | undefined) {
  if (!positionId) return null;
  const pos = await db.position.findUnique({ where: { id: positionId }, select: { title: true } });
  if (!pos) throw new AppError(404, 'POSITION_NOT_FOUND', 'Position not found');
  return pos.title;
}

const LIVE = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SENT', 'ACCEPTED'] as const;

export const offerService = {
  async list(auth: AuthContext, q: OfferListQuery) {
    const base = scopeWhere(auth);
    // An approver also sees the offers routed to them, whatever else they hold.
    const approverInstances = isRecruitmentAdmin(auth) || canSeeCompensation(auth) ? [] : (await prisma.workflowInstanceStep.findMany({ where: { approverUserId: auth.userId, instance: { module: RECRUITMENT_WORKFLOW.module, entityType: RECRUITMENT_WORKFLOW.offer } }, select: { instanceId: true } })).map((s) => s.instanceId);
    const where: Prisma.RecruitmentOfferWhereInput = { status: q.status, ...(approverInstances.length ? { OR: [{ application: { hiringManagerUserId: auth.userId } }, { workflowInstanceId: { in: approverInstances } }] } : base) };
    const [total, rows] = await prisma.$transaction([
      prisma.recruitmentOffer.count({ where }),
      prisma.recruitmentOffer.findMany({ where, include, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
    ]);
    return { data: await Promise.all(rows.map((r) => toDto(prisma, auth, r))), meta: { page: q.page, pageSize: q.pageSize, total } };
  },

  async get(auth: AuthContext, id: string): Promise<OfferDto> {
    const row = await loadOffer(prisma, id);
    const allowed = isRecruitmentAdmin(auth) || canSeeCompensation(auth) || row.application.hiringManagerUserId === auth.userId || (await isApprover(prisma, auth, row))
      || !!(await prisma.recruitmentApplication.findFirst({ where: { id: row.applicationId, ...applicationScopeWhere(auth) }, select: { id: true } }));
    if (!allowed) throw notFound('offer');
    return toDto(prisma, auth, row);
  },

  async create(input: CreateOfferInput, actor: Actor): Promise<OfferDto> {
    const id = await prisma.$transaction(async (tx) => {
      await lockRow(tx, 'recruitment_applications', input.applicationId);
      const application = await tx.recruitmentApplication.findUnique({ where: { id: input.applicationId }, select: { stage: true, applicationNumber: true, opening: { select: { status: true } } } });
      if (!application) throw notFound('application');
      if (application.stage !== 'OFFER') throw new AppError(409, 'APPLICATION_NOT_AT_OFFER_STAGE', 'Move the application to the OFFER stage before drafting an offer');
      if (application.opening.status !== 'OPEN') throw new AppError(409, 'OPENING_NOT_OPEN', 'The opening is not open');
      const live = await tx.recruitmentOffer.findFirst({ where: { applicationId: input.applicationId, status: { in: [...LIVE] } }, select: { offerNumber: true } });
      if (live) throw new AppError(409, 'OFFER_EXISTS', `Offer ${live.offerNumber} is already in progress for this application`);
      const positionTitle = await assertPosition(tx, input.positionId);
      const offerNumber = await nextNumber(tx, 'offer');
      const created = await tx.recruitmentOffer.create({
        data: {
          offerNumber, applicationId: input.applicationId, proposedStartDate: input.proposedStartDate, employmentTypeSnapshot: input.employmentType ?? null,
          positionId: input.positionId ?? null, positionTitleSnapshot: positionTitle, baseSalaryProposal: input.baseSalaryProposal ? new Prisma.Decimal(input.baseSalaryProposal) : null,
          currencyCode: input.currencyCode, otherTermsText: input.otherTermsText ?? null, createdByUserId: actor.auth.userId,
        },
      });
      // The figure is not in the log. That it exists, and its currency, is.
      await auditService.log(recruitmentAudit(actor, AUDIT_ACTIONS.CREATE_JOB_OFFER, 'RecruitmentOffer', created.id, { offerNumber, applicationNumber: application.applicationNumber, hasSalary: !!input.baseSalaryProposal, currencyCode: input.currencyCode, ...textAudit('otherTerms', null, input.otherTermsText) }), tx);
      return created.id;
    });
    return toDto(prisma, actor.auth, await loadOffer(prisma, id));
  },

  async update(id: string, input: UpdateOfferInput, actor: Actor): Promise<OfferDto> {
    await prisma.$transaction(async (tx) => {
      await lockRow(tx, 'recruitment_offers', id);
      const before = await loadOffer(tx, id);
      if (before.status !== 'DRAFT') throw new AppError(409, 'OFFER_NOT_DRAFT', `A ${before.status.toLowerCase().replace('_', ' ')} offer is frozen; withdraw it and draft a new one`);
      const positionTitle = input.positionId === undefined ? undefined : await assertPosition(tx, input.positionId);
      const updated = await tx.recruitmentOffer.update({
        where: { id },
        data: {
          proposedStartDate: input.proposedStartDate, employmentTypeSnapshot: input.employmentType, positionId: input.positionId, positionTitleSnapshot: positionTitle,
          baseSalaryProposal: input.baseSalaryProposal === undefined ? undefined : input.baseSalaryProposal === null ? null : new Prisma.Decimal(input.baseSalaryProposal),
          currencyCode: input.currencyCode, otherTermsText: input.otherTermsText,
        },
      });
      await auditService.log(recruitmentAudit(actor, AUDIT_ACTIONS.UPDATE_JOB_OFFER, 'RecruitmentOffer', id,
        { fields: Object.keys(input).filter((k) => k !== 'otherTermsText'), salaryChanged: input.baseSalaryProposal !== undefined, ...textAudit('otherTerms', before.otherTermsText, updated.otherTermsText) }), tx);
    });
    return toDto(prisma, actor.auth, await loadOffer(prisma, id));
  },

  async submit(id: string, actor: Actor): Promise<OfferDto> {
    await prisma.$transaction(async (tx) => {
      await lockRow(tx, 'recruitment_offers', id);
      const row = await loadOffer(tx, id);
      if (row.status !== 'DRAFT') throw new AppError(409, 'OFFER_NOT_DRAFT', `This offer is already ${row.status.toLowerCase().replace('_', ' ')}`);
      if (row.application.stage !== 'OFFER') throw new AppError(409, 'APPLICATION_NOT_AT_OFFER_STAGE', 'The application is no longer at the OFFER stage');
      const policy = await recruitmentPolicyService.resolve(tx, row.application.opening.requisition.organizationId);
      const requester = await requesterEmployeeId(tx, actor.auth.userId);
      const instance = await workflowEngine.submit(
        { definitionCode: policy.offerWorkflowCode, module: RECRUITMENT_WORKFLOW.module, entityType: RECRUITMENT_WORKFLOW.offer, entityId: id, requesterEmployeeId: requester }, actor, tx,
      );
      await tx.recruitmentOffer.update({ where: { id }, data: { status: 'PENDING_APPROVAL', submittedAt: new Date(), workflowInstanceId: instance.id, rejectedAt: null } });
      await auditService.log(recruitmentAudit(actor, AUDIT_ACTIONS.SUBMIT_JOB_OFFER, 'RecruitmentOffer', id, { offerNumber: row.offerNumber, workflowInstanceId: instance.id }), tx);
    });
    return toDto(prisma, actor.auth, await loadOffer(prisma, id));
  },

  /** Workflow callbacks. Approval freezes the terms; rejection hands the draft back to HR to revise and resubmit. */
  async approveFromWorkflow(tx: Tx, id: string, actor: Actor) {
    await lockRow(tx, 'recruitment_offers', id);
    const row = await loadOffer(tx, id);
    if (row.status !== 'PENDING_APPROVAL') throw new AppError(409, 'OFFER_NOT_PENDING', `This offer is ${row.status.toLowerCase().replace('_', ' ')}`);
    await tx.recruitmentOffer.update({ where: { id }, data: { status: 'APPROVED', approvedAt: new Date() } });
    await auditService.log(recruitmentAudit(actor, AUDIT_ACTIONS.APPROVE_JOB_OFFER, 'RecruitmentOffer', id, { offerNumber: row.offerNumber }), tx);
  },
  async rejectFromWorkflow(tx: Tx, id: string, actor: Actor) {
    await lockRow(tx, 'recruitment_offers', id);
    const row = await loadOffer(tx, id);
    if (row.status !== 'PENDING_APPROVAL') throw new AppError(409, 'OFFER_NOT_PENDING', `This offer is ${row.status.toLowerCase().replace('_', ' ')}`);
    await tx.recruitmentOffer.update({ where: { id }, data: { status: 'DRAFT', rejectedAt: new Date(), workflowInstanceId: null } });
    await auditService.log(recruitmentAudit(actor, AUDIT_ACTIONS.REJECT_JOB_OFFER, 'RecruitmentOffer', id, { offerNumber: row.offerNumber }), tx);
  },
  async cancelFromWorkflow(tx: Tx, id: string) {
    await lockRow(tx, 'recruitment_offers', id);
    const row = await loadOffer(tx, id);
    if (row.status === 'PENDING_APPROVAL') await tx.recruitmentOffer.update({ where: { id }, data: { status: 'DRAFT', workflowInstanceId: null } });
  },

  /** HR's record that the approved offer went to the candidate. Nothing is sent from here. */
  async markSent(id: string, actor: Actor): Promise<OfferDto> {
    await prisma.$transaction(async (tx) => {
      await lockRow(tx, 'recruitment_offers', id);
      const row = await loadOffer(tx, id);
      if (row.status !== 'APPROVED') throw new AppError(409, 'OFFER_NOT_APPROVED', `Only an approved offer can be marked as sent; this one is ${row.status.toLowerCase().replace('_', ' ')}`);
      await tx.recruitmentOffer.update({ where: { id }, data: { status: 'SENT', sentAt: new Date(), outcomeRecordedByUserId: actor.auth.userId } });
      await auditService.log(recruitmentAudit(actor, AUDIT_ACTIONS.MARK_JOB_OFFER_SENT, 'RecruitmentOffer', id, { offerNumber: row.offerNumber }), tx);
    });
    return toDto(prisma, actor.auth, await loadOffer(prisma, id));
  },

  async recordOutcome(id: string, outcome: 'ACCEPTED' | 'DECLINED', actor: Actor): Promise<OfferDto> {
    await prisma.$transaction(async (tx) => {
      await lockRow(tx, 'recruitment_offers', id);
      const row = await loadOffer(tx, id);
      if (row.status !== 'SENT') throw new AppError(409, 'OFFER_NOT_SENT', `Only a sent offer can be recorded as ${outcome.toLowerCase()}; this one is ${row.status.toLowerCase().replace('_', ' ')}`);
      await tx.recruitmentOffer.update({ where: { id }, data: { status: outcome, ...(outcome === 'ACCEPTED' ? { acceptedAt: new Date() } : { declinedAt: new Date() }), outcomeRecordedByUserId: actor.auth.userId } });
      await auditService.log(recruitmentAudit(actor, outcome === 'ACCEPTED' ? AUDIT_ACTIONS.RECORD_JOB_OFFER_ACCEPTED : AUDIT_ACTIONS.RECORD_JOB_OFFER_DECLINED, 'RecruitmentOffer', id, { offerNumber: row.offerNumber }), tx);
    });
    return toDto(prisma, actor.auth, await loadOffer(prisma, id));
  },

  /** Withdraw a draft, approved or sent offer. An accepted offer that leads nowhere is withdrawn too — before any hire. */
  async withdraw(id: string, actor: Actor): Promise<OfferDto> {
    await prisma.$transaction(async (tx) => {
      await lockRow(tx, 'recruitment_offers', id);
      const row = await loadOffer(tx, id);
      if (!['DRAFT', 'APPROVED', 'SENT', 'ACCEPTED'].includes(row.status)) throw new AppError(409, 'OFFER_NOT_WITHDRAWABLE', `A ${row.status.toLowerCase().replace('_', ' ')} offer cannot be withdrawn`);
      if (row.application.stage === 'HIRED') throw new AppError(409, 'APPLICATION_HIRED', 'The candidate has been hired on this offer');
      await tx.recruitmentOffer.update({ where: { id }, data: { status: 'WITHDRAWN', withdrawnAt: new Date(), outcomeRecordedByUserId: actor.auth.userId } });
      await auditService.log(recruitmentAudit(actor, AUDIT_ACTIONS.WITHDRAW_JOB_OFFER, 'RecruitmentOffer', id, { offerNumber: row.offerNumber }, { status: row.status }), tx);
    });
    return toDto(prisma, actor.auth, await loadOffer(prisma, id));
  },
};
