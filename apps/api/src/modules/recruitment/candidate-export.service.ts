import { Prisma } from '@prisma/client';
import { AUDIT_ACTIONS, type CandidateDataExportDto } from '@hr/shared';
import { prisma } from '../../lib/prisma';
import { auditService } from '../../services/audit/audit.service';
import { notFound, type Actor } from './recruitment.types';

/**
 * A candidate's personal data, for a subject access request. Reached through the privacy router behind
 * `privacy.export_data`, like the employee export: the candidate's own profile and the record of what happened to
 * their applications. Interviewer feedback and offer drafts that never reached them are HR working records, and are
 * listed under `notIncluded` rather than silently dropped. There is no delete: erasure is a policy decision.
 */
export const candidateExportService = {
  async exportCandidate(candidateId: string, actor: Actor): Promise<CandidateDataExportDto> {
    const MAX_ROWS = 2000;
    const data = await prisma.$transaction(async (tx) => {
      const candidate = await tx.recruitmentCandidate.findUnique({ where: { id: candidateId } });
      if (!candidate) throw notFound('candidate');
      const applications = await tx.recruitmentApplication.findMany({
        where: { candidateId },
        select: {
          applicationNumber: true, appliedAt: true, stage: true, jobTitleSnapshot: true, departmentNameSnapshot: true, sourceSnapshot: true,
          rejectionReasonCode: true, rejectedAt: true, withdrawnAt: true, hiredAt: true, createdAt: true,
          stageHistory: { select: { fromStage: true, toStage: true, changedAt: true }, orderBy: { changedAt: 'asc' } },
          interviews: { select: { title: true, roundNumber: true, scheduledStart: true, scheduledEnd: true, timezone: true, location: true, status: true }, orderBy: { scheduledStart: 'asc' } },
          offers: { where: { status: { in: ['SENT', 'ACCEPTED', 'DECLINED'] } }, select: { offerNumber: true, status: true, proposedStartDate: true, employmentTypeSnapshot: true, positionTitleSnapshot: true, baseSalaryProposal: true, currencyCode: true, otherTermsText: true, sentAt: true, acceptedAt: true, declinedAt: true }, orderBy: { createdAt: 'asc' } },
        },
        orderBy: { createdAt: 'asc' },
        take: MAX_ROWS,
      });
      return { candidate, applications };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });

    const c = data.candidate;
    const result: CandidateDataExportDto = {
      formatVersion: 1,
      generatedAt: new Date().toISOString(),
      subject: { candidateId: c.id, candidateNumber: c.candidateNumber, firstName: c.firstName, lastName: c.lastName },
      data: {
        profile: {
          candidateNumber: c.candidateNumber, firstName: c.firstName, lastName: c.lastName, email: c.email, phone: c.phone, currentCompany: c.currentCompany, currentTitle: c.currentTitle,
          locationText: c.locationText, source: c.source, sourceDetail: c.sourceDetail, summary: c.summary, status: c.status, hiredEmployeeId: c.hiredEmployeeId, createdAt: c.createdAt, updatedAt: c.updatedAt,
        },
        applications: data.applications.map((a) => ({ ...a, offers: a.offers.map((o) => ({ ...o, baseSalaryProposal: o.baseSalaryProposal?.toFixed(2) ?? null })) })),
      },
      notIncluded: [
        { category: 'interviewer feedback', reason: 'Interview feedback is an interviewer’s working assessment, held for the hiring decision; disclosure to the candidate is a policy decision made outside this export.' },
        { category: 'offer drafts', reason: 'Offers that were never sent to the candidate are internal proposals; the export carries offers marked as sent, accepted or declined.' },
        { category: 'rejection notes', reason: 'The coded rejection reason is included; the recruiter’s free-text note is an internal working record.' },
        { category: 'who acted', reason: 'The names of recruiters, hiring managers and interviewers are their personal data and are not part of the candidate’s copy.' },
        { category: 'employee record', reason: 'If the candidate was hired, their employee record is exported through the employee personal-data export.' },
      ],
    };
    await auditService.log({
      userId: actor.auth.userId, ipAddress: actor.ipAddress, userAgent: actor.userAgent,
      action: AUDIT_ACTIONS.EXPORT_CANDIDATE_PERSONAL_DATA, module: 'privacy', recordType: 'RecruitmentCandidate', recordId: c.id,
      newValue: { candidateNumber: c.candidateNumber, generatedAt: result.generatedAt, counts: { applications: data.applications.length, interviews: data.applications.reduce((n, a) => n + a.interviews.length, 0), offers: data.applications.reduce((n, a) => n + a.offers.length, 0) } },
    });
    return result;
  },
};
