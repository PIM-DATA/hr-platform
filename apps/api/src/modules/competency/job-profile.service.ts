import { AUDIT_ACTIONS, type JobProfileDto, type JobRequirementDto, type SetJobRequirementInput } from '@hr/shared';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { AppError } from '../../lib/errors';
import { auditService } from '../../services/audit/audit.service';
import { competencyAudit, type Actor, type Db } from './competency.types';

/**
 * What a job asks for: the competencies somebody in that job is expected to have, and to what level.
 *
 * Requirements belong to the **job**, not to the employee and not to the position. A position already names a job,
 * and an employee holds a position, so the chain is `employee → position → job → requirements`. Writing requirements
 * per employee would create a second master of what work needs, and the two would disagree within a month.
 *
 * Changing a requirement changes what is expected **from now on**. It never rewrites an assessment that has already
 * been made, because each assessment froze the requirement it was measured against.
 */
const requirementInclude = {
  competency: {
    include: {
      category: { select: { name: true } },
      scale: { include: { levels: { orderBy: { level: 'asc' as const } } } },
    },
  },
} satisfies Prisma.JobCompetencyRequirementInclude;
type RequirementRow = Prisma.JobCompetencyRequirementGetPayload<{ include: typeof requirementInclude }>;

const toRequirementDto = (row: RequirementRow): JobRequirementDto => {
  const levels = row.competency.scale.levels;
  return {
    id: row.id,
    competency: {
      id: row.competency.id,
      code: row.competency.code,
      name: row.competency.name,
      category: row.competency.category.name,
      scaleName: row.competency.scale.name,
      maxLevel: levels.length ? levels[levels.length - 1].level : 0,
    },
    requiredLevel: row.requiredLevel,
    requiredLevelLabel: levels.find((l) => l.level === row.requiredLevel)?.label ?? null,
    weight: row.weight === null ? null : Number(row.weight),
    isMandatory: row.isMandatory,
  };
};

export const jobProfileService = {
  async get(jobId: string): Promise<JobProfileDto> {
    const job = await prisma.job.findUnique({ where: { id: jobId }, select: { id: true, code: true, title: true, level: true } });
    if (!job) throw new AppError(404, 'JOB_NOT_FOUND', 'Job not found');
    const [requirements, employeeCount] = await Promise.all([
      prisma.jobCompetencyRequirement.findMany({ where: { jobId }, include: requirementInclude, orderBy: [{ competency: { code: 'asc' } }] }),
      prisma.employee.count({ where: { employmentStatus: 'ACTIVE', position: { jobId } } }),
    ]);
    return { job, employeeCount, requirements: requirements.map(toRequirementDto) };
  },

  /** One row per job and competency: setting the same competency again updates it rather than duplicating it. */
  async setRequirement(jobId: string, input: SetJobRequirementInput, actor: Actor): Promise<JobProfileDto> {
    await prisma.$transaction(async (tx) => {
      const job = await tx.job.findUnique({ where: { id: jobId }, select: { id: true, code: true } });
      if (!job) throw new AppError(404, 'JOB_NOT_FOUND', 'Job not found');
      const competency = await tx.competency.findUnique({
        where: { id: input.competencyId },
        include: { scale: { include: { levels: { select: { level: true } } } } },
      });
      if (!competency) throw new AppError(404, 'COMPETENCY_NOT_FOUND', 'Competency not found');
      if (!competency.isActive) throw new AppError(409, 'COMPETENCY_INACTIVE', `${competency.code} is inactive`);
      assertLevelOnScale(input.requiredLevel, competency.scale.levels.map((l) => l.level), competency.scale.name);

      const before = await tx.jobCompetencyRequirement.findUnique({ where: { jobId_competencyId: { jobId, competencyId: input.competencyId } } });
      await tx.jobCompetencyRequirement.upsert({
        where: { jobId_competencyId: { jobId, competencyId: input.competencyId } },
        create: { jobId, competencyId: input.competencyId, requiredLevel: input.requiredLevel, weight: input.weight ?? null, isMandatory: input.isMandatory },
        update: { requiredLevel: input.requiredLevel, weight: input.weight ?? null, isMandatory: input.isMandatory },
      });
      await auditService.log(competencyAudit(actor, AUDIT_ACTIONS.UPDATE_JOB_COMPETENCY_PROFILE, 'Job', jobId,
        { job: job.code, competency: competency.code, requiredLevel: input.requiredLevel, isMandatory: input.isMandatory },
        before ? { requiredLevel: before.requiredLevel, isMandatory: before.isMandatory } : undefined), tx);
    });
    return jobProfileService.get(jobId);
  },

  async removeRequirement(jobId: string, competencyId: string, actor: Actor): Promise<JobProfileDto> {
    await prisma.$transaction(async (tx) => {
      const row = await tx.jobCompetencyRequirement.findUnique({
        where: { jobId_competencyId: { jobId, competencyId } },
        include: { competency: { select: { code: true } }, job: { select: { code: true } } },
      });
      if (!row) throw new AppError(404, 'COMPETENCY_REQUIREMENT_NOT_FOUND', 'That competency is not on this job profile');
      await tx.jobCompetencyRequirement.delete({ where: { id: row.id } });
      await auditService.log(competencyAudit(actor, AUDIT_ACTIONS.UPDATE_JOB_COMPETENCY_PROFILE, 'Job', jobId, {
        job: row.job.code, removed: row.competency.code,
      }), tx);
    });
    return jobProfileService.get(jobId);
  },

  /** The requirements an assessment or a skill profile is built from, with everything needed to snapshot them. */
  async requirementsFor(db: Db, jobId: string) {
    return db.jobCompetencyRequirement.findMany({ where: { jobId }, include: requirementInclude, orderBy: [{ competency: { code: 'asc' } }] });
  },
};

export function assertLevelOnScale(level: number, levels: number[], scaleName: string) {
  if (!levels.includes(level)) {
    const range = levels.length ? `${levels[0]}–${levels[levels.length - 1]}` : 'none';
    throw new AppError(422, 'COMPETENCY_LEVEL_INVALID', `Level ${level} is not on the ${scaleName} scale (${range})`);
  }
}
