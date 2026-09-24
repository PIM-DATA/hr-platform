import type { Prisma } from '@prisma/client';
import { AUDIT_ACTIONS, careerReadinessStatus, type AddCareerStepInput, type CareerPathDto, type CareerReadinessDto, type CareerStepDto, type CreateCareerPathInput, type MyCareerDto, type UpdateCareerPathInput } from '@hr/shared';
import { prisma } from '../../lib/prisma';
import { AppError } from '../../lib/errors';
import { auditService } from '../../services/audit/audit.service';
import type { AuthContext } from '../auth/auth.types';
import { skillGapService } from '../competency/skill-gap.service';
import { developmentContext, employeeRef, jobRef, lockRow, notFound, talentAudit, textAudit, type Actor, type Db } from './talent.types';

/**
 * Career paths and readiness.
 *
 * A career path is a set of job-to-job transitions the organization says are possible. It is not a promise and it
 * is not an entitlement: an employee sees where they could go and what the target job asks for; the decision to
 * move anybody is the organization's, made elsewhere. Readiness is the Task 24 gap service applied to a different
 * job's profile — same levels, same rule, same "unassessed is not zero" — and it never says "promote".
 */
const include = { organization: { select: { id: true, name: true } }, steps: { include: { fromJob: jobRef, toJob: jobRef }, orderBy: [{ stepOrder: 'asc' as const }, { fromJob: { title: 'asc' as const } }] } } satisfies Prisma.CareerPathInclude;
type Row = Prisma.CareerPathGetPayload<{ include: typeof include }>;

const stepDto = (s: Row['steps'][number]): CareerStepDto => ({ id: s.id, pathId: s.pathId, fromJob: s.fromJob, toJob: s.toJob, stepOrder: s.stepOrder, description: s.description });
const toDto = (r: Row): CareerPathDto => ({ id: r.id, code: r.code, name: r.name, organization: r.organization, description: r.description, isActive: r.isActive, steps: r.steps.map(stepDto), createdAt: r.createdAt.toISOString() });

async function load(db: Db, id: string) {
  const row = await db.careerPath.findUnique({ where: { id }, include });
  if (!row) throw notFound('career path');
  return row;
}

async function employeeWithJob(db: Db, employeeId: string) {
  const employee = await db.employee.findUnique({ where: { id: employeeId }, select: { id: true, employeeCode: true, firstName: true, lastName: true, organizationId: true, position: { select: { job: jobRef } } } });
  if (!employee) throw new AppError(404, 'EMPLOYEE_NOT_FOUND', 'Employee not found');
  return employee;
}

export const careerService = {
  async listPaths(includeInactive: boolean, organizationId?: string): Promise<CareerPathDto[]> {
    const rows = await prisma.careerPath.findMany({ where: { ...(includeInactive ? {} : { isActive: true }), ...(organizationId ? { OR: [{ organizationId }, { organizationId: null }] } : {}) }, include, orderBy: { name: 'asc' } });
    return rows.map(toDto);
  },
  async getPath(id: string): Promise<CareerPathDto> { return toDto(await load(prisma, id)); },

  async createPath(input: CreateCareerPathInput, actor: Actor): Promise<CareerPathDto> {
    if (await prisma.careerPath.findUnique({ where: { code: input.code }, select: { id: true } })) throw new AppError(409, 'CAREER_PATH_CODE_EXISTS', `Career path ${input.code} already exists`);
    if (input.organizationId && !(await prisma.organization.findUnique({ where: { id: input.organizationId }, select: { id: true } }))) throw new AppError(404, 'ORGANIZATION_NOT_FOUND', 'Organization not found');
    const row = await prisma.$transaction(async (tx) => {
      const created = await tx.careerPath.create({ data: { code: input.code, name: input.name, organizationId: input.organizationId ?? null, description: input.description ?? null, isActive: input.isActive }, include });
      await auditService.log(talentAudit(actor, AUDIT_ACTIONS.CREATE_CAREER_PATH, 'CareerPath', created.id, { code: created.code, name: created.name, organizationId: created.organizationId }), tx);
      return created;
    });
    return toDto(row);
  },

  async updatePath(id: string, input: UpdateCareerPathInput, actor: Actor): Promise<CareerPathDto> {
    const row = await prisma.$transaction(async (tx) => {
      const before = await load(tx, id);
      const updated = await tx.careerPath.update({ where: { id }, data: { name: input.name, organizationId: input.organizationId, description: input.description, isActive: input.isActive }, include });
      await auditService.log(talentAudit(actor, AUDIT_ACTIONS.UPDATE_CAREER_PATH, 'CareerPath', id, { fields: Object.keys(input), name: updated.name, isActive: updated.isActive, ...textAudit('description', before.description, updated.description) }, { name: before.name, isActive: before.isActive }), tx);
      return updated;
    });
    return toDto(row);
  },

  /** A step is an edge in the graph; the same from→to pair appears once per path. */
  async addStep(pathId: string, input: AddCareerStepInput, actor: Actor): Promise<CareerPathDto> {
    await prisma.$transaction(async (tx) => {
      await lockRow(tx, 'career_paths', pathId);
      await load(tx, pathId);
      const jobs = await tx.job.findMany({ where: { id: { in: [input.fromJobId, input.toJobId] } }, select: { id: true, title: true } });
      if (jobs.length !== 2) throw new AppError(404, 'JOB_NOT_FOUND', 'One of the jobs does not exist');
      if (await tx.careerPathStep.findUnique({ where: { pathId_fromJobId_toJobId: { pathId, fromJobId: input.fromJobId, toJobId: input.toJobId } } })) throw new AppError(409, 'CAREER_STEP_EXISTS', 'This transition is already on the path');
      const created = await tx.careerPathStep.create({ data: { pathId, fromJobId: input.fromJobId, toJobId: input.toJobId, stepOrder: input.stepOrder ?? null, description: input.description ?? null } });
      await auditService.log(talentAudit(actor, AUDIT_ACTIONS.UPDATE_CAREER_PATH, 'CareerPath', pathId, { stepAdded: created.id, fromJobId: input.fromJobId, toJobId: input.toJobId, stepOrder: input.stepOrder ?? null }), tx);
    });
    return toDto(await load(prisma, pathId));
  },

  async removeStep(pathId: string, stepId: string, actor: Actor): Promise<CareerPathDto> {
    await prisma.$transaction(async (tx) => {
      await lockRow(tx, 'career_paths', pathId);
      const step = await tx.careerPathStep.findFirst({ where: { id: stepId, pathId } });
      if (!step) throw notFound('career step');
      await tx.careerPathStep.delete({ where: { id: stepId } });
      await auditService.log(talentAudit(actor, AUDIT_ACTIONS.UPDATE_CAREER_PATH, 'CareerPath', pathId, { stepRemoved: stepId, fromJobId: step.fromJobId, toJobId: step.toJobId }), tx);
    });
    return toDto(await load(prisma, pathId));
  },

  /**
   * Readiness against a target job: the Task 24 gap rows for that job's profile, summarised. The status describes
   * competency requirements only — "requirements met" is a fact about levels, not a recommendation about anybody.
   */
  async getCareerReadiness(q: { employeeId: string; targetJobId: string }): Promise<CareerReadinessDto> {
    const employee = await employeeWithJob(prisma, q.employeeId);
    const targetJob = await prisma.job.findUnique({ where: { id: q.targetJobId }, ...jobRef });
    if (!targetJob) throw new AppError(404, 'JOB_NOT_FOUND', 'Target job not found');
    const rows = await skillGapService.getGapsAgainstJob({ employeeId: q.employeeId, jobId: q.targetJobId });
    const competencies = rows.map((r) => ({ competencyId: r.competencyId, competencyCode: r.competencyCode, competencyName: r.competencyName, currentLevel: r.currentLevel, requiredLevel: r.requiredLevel, gapNeeded: r.gapNeeded, status: r.gapStatus, assessmentDate: r.assessmentDate }));
    const summary = {
      requirements: rows.length,
      assessed: rows.filter((r) => r.gapStatus !== 'UNASSESSED').length,
      met: rows.filter((r) => r.gapStatus === 'NO_GAP' || r.gapStatus === 'EXCEEDS_REQUIREMENT').length,
      gaps: rows.filter((r) => r.gapStatus === 'GAP').length,
      unassessed: rows.filter((r) => r.gapStatus === 'UNASSESSED').length,
    };
    return {
      employee: { id: employee.id, employeeCode: employee.employeeCode, firstName: employee.firstName, lastName: employee.lastName },
      currentJob: employee.position?.job ?? null,
      targetJob,
      competencies,
      summary,
      status: careerReadinessStatus(rows.map((r) => ({ gapStatus: r.gapStatus }))),
      development: await developmentContext(prisma, employee.id),
    };
  },

  /** Jobs one step away from the current job, across active paths (the current organization's and global ones). */
  async nextJobIds(db: Db, employee: { organizationId: string | null; position: { job: { id: string } | null } | null }): Promise<string[]> {
    const jobId = employee.position?.job?.id;
    if (!jobId) return [];
    const steps = await db.careerPathStep.findMany({ where: { fromJobId: jobId, path: { isActive: true, OR: [{ organizationId: null }, { organizationId: employee.organizationId ?? '__none__' }] } }, select: { toJobId: true } });
    return [...new Set(steps.map((s) => s.toJobId))];
  },

  async myCareer(employeeId: string): Promise<MyCareerDto> {
    const employee = await employeeWithJob(prisma, employeeId);
    const jobId = employee.position?.job?.id ?? null;
    const paths = jobId
      ? await prisma.careerPath.findMany({ where: { isActive: true, OR: [{ organizationId: null }, { organizationId: employee.organizationId ?? '__none__' }], steps: { some: { OR: [{ fromJobId: jobId }, { toJobId: jobId }] } } }, include, orderBy: { name: 'asc' } })
      : [];
    const nextIds = await this.nextJobIds(prisma, employee);
    const nextJobs = await Promise.all(nextIds.map((targetJobId) => this.getCareerReadiness({ employeeId, targetJobId })));
    return {
      employee: { id: employee.id, employeeCode: employee.employeeCode, firstName: employee.firstName, lastName: employee.lastName },
      currentJob: employee.position?.job ?? null,
      paths: paths.map((p) => ({ id: p.id, code: p.code, name: p.name, description: p.description, steps: p.steps.map(stepDto) })),
      nextJobs,
    };
  },

  /** A manager's team, with each person's current job and how many next jobs the paths offer — no readiness verdicts in a list. */
  async teamSummary(auth: AuthContext) {
    if (!auth.employeeId) return [];
    const team = await prisma.employee.findMany({ where: { managerId: auth.employeeId, employmentStatus: 'ACTIVE' }, select: { ...employeeRef.select, organizationId: true, position: { select: { job: jobRef } }, department: { select: { name: true } } }, orderBy: { employeeCode: 'asc' } });
    return Promise.all(team.map(async (e) => ({ employee: { id: e.id, employeeCode: e.employeeCode, firstName: e.firstName, lastName: e.lastName }, currentJob: e.position?.job ?? null, departmentName: e.department?.name ?? null, nextJobCount: (await this.nextJobIds(prisma, e)).length, development: await developmentContext(prisma, e.id) })));
  },
};
