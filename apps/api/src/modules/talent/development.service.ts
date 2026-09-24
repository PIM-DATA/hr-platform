import { AUDIT_ACTIONS, type CreateDevelopmentActionInput, type TalentSummaryDto, type TrainingNeedDto } from '@hr/shared';
import { prisma } from '../../lib/prisma';
import { AppError } from '../../lib/errors';
import { auditService } from '../../services/audit/audit.service';
import { trainingNeedService } from '../training/training-need.service';
import { careerService } from './career.service';
import { developmentContext, talentAudit, type Actor } from './talent.types';

/**
 * The handoff into development, and the minimal talent summary other modules reuse.
 *
 * A development action is a training need created through Task 25's own service — the same table, the same audit,
 * the same statuses — with a second audit line saying it came from a career, succession or talent-review context.
 * It is a person's explicit act: nothing here enrols anybody, and creating a need changes no competency level.
 */
export const developmentService = {
  async createAction(input: CreateDevelopmentActionInput, actor: Actor): Promise<TrainingNeedDto> {
    if (input.source.id) {
      const exists = input.source.type === 'SUCCESSION'
        ? await prisma.successionCandidate.findFirst({ where: { id: input.source.id, employeeId: input.employeeId }, select: { id: true } })
        : input.source.type === 'TALENT_REVIEW'
          ? await prisma.talentReview.findFirst({ where: { id: input.source.id, employeeId: input.employeeId }, select: { id: true } })
          : await prisma.job.findUnique({ where: { id: input.source.id }, select: { id: true } });
      if (!exists) throw new AppError(422, 'DEVELOPMENT_SOURCE_MISMATCH', 'The source record does not belong to this employee');
    }
    const need = await trainingNeedService.create({ employeeId: input.employeeId, title: input.title, description: input.description ?? null, competencyId: input.competencyId ?? null, priority: input.priority }, actor);
    await auditService.log(talentAudit(actor, AUDIT_ACTIONS.CREATE_DEVELOPMENT_ACTION_FROM_TALENT, 'TrainingNeed', need.id, { employeeId: input.employeeId, competencyId: input.competencyId ?? null, sourceType: input.source.type, sourceId: input.source.id ?? null, priority: input.priority }));
    return need;
  },

  /** Facts a 360 page (Task 29) can show. No potential level, no comment, no notes. */
  async getTalentSummary(employeeId: string): Promise<TalentSummaryDto> {
    const employee = await prisma.employee.findUnique({ where: { id: employeeId }, select: { id: true, organizationId: true, position: { select: { job: { select: { id: true } } } } } });
    if (!employee) throw new AppError(404, 'EMPLOYEE_NOT_FOUND', 'Employee not found');
    const [nextIds, latest, pools, nominations, development] = await Promise.all([
      careerService.nextJobIds(prisma, employee),
      prisma.talentReview.findFirst({ where: { employeeId }, select: { status: true, nineBoxCell: true, finalizedAt: true, cycle: { select: { name: true } } }, orderBy: { createdAt: 'desc' } }),
      prisma.talentPoolMember.count({ where: { employeeId, status: 'ACTIVE' } }),
      prisma.successionCandidate.count({ where: { employeeId, status: 'ACTIVE', plan: { status: { not: 'CLOSED' } } } }),
      developmentContext(prisma, employeeId),
    ]);
    return {
      employeeId, careerTargetCount: nextIds.length,
      latestTalentReview: latest ? { cycleName: latest.cycle.name, status: latest.status, nineBoxCell: latest.status === 'FINALIZED' ? latest.nineBoxCell : null, finalizedAt: latest.finalizedAt?.toISOString() ?? null } : null,
      talentPoolCount: pools, activeSuccessionNominations: nominations, development,
    };
  },
};
