import { AUDIT_ACTIONS, NOTIFICATION_TYPES, RECRUITMENT_WORKFLOW, type HireCandidateInput, type HireResultDto } from '@hr/shared';
import { prisma } from '../../lib/prisma';
import { AppError } from '../../lib/errors';
import { auditService } from '../../services/audit/audit.service';
import { notificationService } from '../../services/notification';
import { createEmployeeWithTx } from '../employees/employees.service';
import { lockRow, notFound, recruitmentAudit, type Actor } from './recruitment.types';
import { recordStage } from './application.service';

/**
 * Hire — the one bridge from the ATS into the employee master.
 *
 * One transaction, with the application, its opening and its candidate all locked: the accepted offer is verified,
 * the candidate is confirmed not already hired anywhere, the opening's headcount is counted under the lock, and the
 * employee is created through `createEmployeeWithTx` — the same road every other employee takes, with the same
 * uniqueness checks and the same audit. If any step fails, nothing was hired.
 *
 * What does NOT happen here, on purpose: no user account (an account is an access decision), no payroll compensation
 * (the offer figure is a proposal, and payroll has its own authorization), and no automatic closing of the opening.
 */
export const hireService = {
  async hire(applicationId: string, input: HireCandidateInput, actor: Actor): Promise<HireResultDto> {
    return prisma.$transaction(async (tx) => {
      await lockRow(tx, 'recruitment_applications', applicationId);
      const application = await tx.recruitmentApplication.findUnique({ where: { id: applicationId }, include: { candidate: true, opening: { select: { id: true, status: true, openingsCount: true, titleSnapshot: true, hiringManagerUserId: true } } } });
      if (!application) throw notFound('application');
      await lockRow(tx, 'recruitment_openings', application.openingId);
      await lockRow(tx, 'recruitment_candidates', application.candidateId);
      const [opening, candidate] = await Promise.all([
        tx.recruitmentOpening.findUniqueOrThrow({ where: { id: application.openingId }, select: { status: true, openingsCount: true, titleSnapshot: true, hiringManagerUserId: true } }),
        tx.recruitmentCandidate.findUniqueOrThrow({ where: { id: application.candidateId } }),
      ]);

      if (application.stage === 'HIRED' || application.hiredEmployeeId) throw new AppError(409, 'ALREADY_HIRED', 'This application has already been converted to an employee');
      if (application.stage !== 'OFFER') throw new AppError(409, 'APPLICATION_NOT_AT_OFFER_STAGE', `This application is at ${application.stage}; hiring needs an accepted offer at the OFFER stage`);
      if (candidate.status === 'HIRED' || candidate.hiredEmployeeId) throw new AppError(409, 'CANDIDATE_ALREADY_HIRED', 'This candidate has already been hired on another application');
      const offer = await tx.recruitmentOffer.findFirst({ where: { applicationId, status: 'ACCEPTED' }, select: { id: true, offerNumber: true } });
      if (!offer) throw new AppError(409, 'OFFER_NOT_ACCEPTED', 'Hiring needs an offer recorded as accepted');
      if (opening.status !== 'OPEN') throw new AppError(409, 'OPENING_NOT_OPEN', `The opening is ${opening.status.toLowerCase().replace('_', ' ')}`);
      const hired = await tx.recruitmentApplication.count({ where: { openingId: application.openingId, stage: 'HIRED' } });
      if (hired >= opening.openingsCount) throw new AppError(409, 'OPENING_FULL', `All ${opening.openingsCount} opening(s) are already filled`);

      const employee = await createEmployeeWithTx(tx, {
        employeeCode: input.employeeCode, firstName: candidate.firstName, lastName: candidate.lastName, email: input.email, phone: candidate.phone ?? null,
        hireDate: new Date(`${input.hireDate}T00:00:00.000Z`), employmentType: input.employmentType, positionId: input.positionId, managerId: input.managerId ?? null,
      }, actor);

      const hiredAt = new Date();
      await tx.recruitmentApplication.update({ where: { id: applicationId }, data: { hiredEmployeeId: employee.id, hiredAt } });
      await recordStage(tx, applicationId, application.stage, 'HIRED', actor.auth.userId, `Hired on offer ${offer.offerNumber}`);
      await tx.recruitmentCandidate.update({ where: { id: candidate.id }, data: { status: 'HIRED', hiredEmployeeId: employee.id } });
      await tx.recruitmentInterview.updateMany({ where: { applicationId, status: 'SCHEDULED' }, data: { status: 'CANCELLED', cancelledAt: hiredAt } });

      const recipients = new Set([application.recruiterUserId, opening.hiringManagerUserId].filter((u): u is string => !!u && u !== actor.auth.userId));
      for (const userId of recipients) {
        await notificationService.publish(
          { userId, type: NOTIFICATION_TYPES.HIRING_COMPLETED, source: { module: RECRUITMENT_WORKFLOW.module, entityType: 'RECRUITMENT_APPLICATION', entityId: applicationId }, data: { applicationId, employeeId: employee.id }, dedupeKey: `recruitment:application:${applicationId}:hired:${userId}` },
          { openingTitle: opening.titleSnapshot }, tx,
        );
      }
      await auditService.log(recruitmentAudit(actor, AUDIT_ACTIONS.HIRE_CANDIDATE, 'RecruitmentApplication', applicationId, {
        applicationNumber: application.applicationNumber, candidateNumber: candidate.candidateNumber, offerNumber: offer.offerNumber, employeeId: employee.id, employeeCode: employee.employeeCode,
        openingId: application.openingId, filledAfter: hired + 1, openingsCount: opening.openingsCount, userAccountCreated: false, payrollCompensationCreated: false,
      }), tx);

      return { employeeId: employee.id, employeeCode: employee.employeeCode, applicationId, candidateId: candidate.id, userAccountCreated: false, payrollCompensationCreated: false };
    });
  },
};
