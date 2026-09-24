import {
  AUDIT_ACTIONS, NOTIFICATION_TYPES, PERMISSIONS, calculateGap,
  type AssessmentDetailDto, type AssessmentItemDto, type AssessmentListQuery, type AssessmentSummaryDto,
  type AssignAssessmentsInput, type AssignAssessmentsResultDto, type CompetencyCycleDto,
  type CompetencyCycleListQuery, type CreateCompetencyCycleInput, type ManagerAssessmentItemInput,
  type ReassignReviewerInput, type SelfAssessmentItemInput, type UpdateCompetencyCycleInput,
} from '@hr/shared';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { AppError } from '../../lib/errors';
import { auditService } from '../../services/audit/audit.service';
import { notificationService } from '../../services/notification/notification.service';
import { hasPermission } from '../../services/authorization/authorization.service';
import type { AuthContext } from '../auth/auth.types';
import { jobProfileService, assertLevelOnScale } from './job-profile.service';
import { competencyAudit, type Actor, type Db, type Tx } from './competency.types';

/**
 * Competency assessment: the cycle, the assessments inside it, and the two people who fill each one in.
 *
 * The shape deliberately mirrors performance reviews — a cycle somebody moves through stages by hand, a record per
 * employee with its organizational and reviewer snapshot, a self assessment and then the reviewer's, and a finalized
 * result nobody can edit afterwards. Two modules that behave the same way are two modules a customer only has to
 * learn once.
 *
 * What is different is what gets frozen: an assessment item snapshots **the requirement it was measured against**,
 * the scale's labels and the competency's indicators. Raising a job's requirement next month is a statement about
 * the future, and it must not turn a finished assessment into a gap retroactively.
 */
const cycleInclude = { _count: { select: { assessments: true } } } satisfies Prisma.CompetencyAssessmentCycleInclude;
type CycleRow = Prisma.CompetencyAssessmentCycleGetPayload<{ include: typeof cycleInclude }>;

const toCycleDto = (row: CycleRow): CompetencyCycleDto => ({
  id: row.id,
  code: row.code,
  name: row.name,
  description: row.description,
  periodStart: row.periodStart,
  periodEnd: row.periodEnd,
  selfAssessmentRequired: row.selfAssessmentRequired,
  status: row.status as CompetencyCycleDto['status'],
  assessmentCount: row._count.assessments,
  createdAt: row.createdAt.toISOString(),
});

export const competencyCycleService = {
  async list(q: CompetencyCycleListQuery): Promise<{ data: CompetencyCycleDto[]; meta: { page: number; pageSize: number; total: number } }> {
    const where: Prisma.CompetencyAssessmentCycleWhereInput = {
      status: q.status,
      ...(q.search ? { OR: [{ code: { contains: q.search, mode: 'insensitive' } }, { name: { contains: q.search, mode: 'insensitive' } }] } : {}),
    };
    const [total, rows] = await prisma.$transaction([
      prisma.competencyAssessmentCycle.count({ where }),
      prisma.competencyAssessmentCycle.findMany({ where, include: cycleInclude, orderBy: [{ periodStart: 'desc' }, { code: 'asc' }], skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
    ]);
    return { data: rows.map(toCycleDto), meta: { page: q.page, pageSize: q.pageSize, total } };
  },

  async get(id: string): Promise<CompetencyCycleDto> {
    const row = await prisma.competencyAssessmentCycle.findUnique({ where: { id }, include: cycleInclude });
    if (!row) throw new AppError(404, 'COMPETENCY_CYCLE_NOT_FOUND', 'Assessment cycle not found');
    return toCycleDto(row);
  },

  async create(input: CreateCompetencyCycleInput, actor: Actor): Promise<CompetencyCycleDto> {
    const duplicate = await prisma.competencyAssessmentCycle.findUnique({ where: { code: input.code }, select: { id: true } });
    if (duplicate) throw new AppError(409, 'COMPETENCY_CYCLE_CODE_TAKEN', `A cycle with the code ${input.code} already exists`);
    const row = await prisma.$transaction(async (tx) => {
      const created = await tx.competencyAssessmentCycle.create({
        data: { ...input, description: input.description ?? null, status: 'DRAFT', createdByUserId: actor.auth.userId },
        include: cycleInclude,
      });
      await auditService.log(competencyAudit(actor, AUDIT_ACTIONS.CREATE_COMPETENCY_CYCLE, 'CompetencyAssessmentCycle', created.id, {
        code: created.code, name: created.name, period: `${created.periodStart}→${created.periodEnd}`,
      }), tx);
      return created;
    });
    return toCycleDto(row);
  },

  async update(id: string, input: UpdateCompetencyCycleInput, actor: Actor): Promise<CompetencyCycleDto> {
    const row = await prisma.$transaction(async (tx) => {
      const before = await tx.competencyAssessmentCycle.findUnique({ where: { id }, include: cycleInclude });
      if (!before) throw new AppError(404, 'COMPETENCY_CYCLE_NOT_FOUND', 'Assessment cycle not found');
      if (before.status === 'CLOSED') throw new AppError(409, 'COMPETENCY_CYCLE_CLOSED', 'A closed cycle cannot be changed');
      if (input.selfAssessmentRequired !== undefined && before.status !== 'DRAFT') {
        throw new AppError(409, 'COMPETENCY_CYCLE_IN_PROGRESS', 'Whether a self assessment is required can only be changed while the cycle is a draft');
      }
      const after = await tx.competencyAssessmentCycle.update({ where: { id }, data: input, include: cycleInclude });
      await auditService.log(competencyAudit(actor, AUDIT_ACTIONS.UPDATE_COMPETENCY_CYCLE, 'CompetencyAssessmentCycle', id,
        { name: after.name, period: `${after.periodStart}→${after.periodEnd}` },
        { name: before.name, period: `${before.periodStart}→${before.periodEnd}` }), tx);
      return after;
    });
    return toCycleDto(row);
  },

  /**
   * `DRAFT → ACTIVE → REVIEW → CLOSED`, each step a decision somebody makes. Assessments follow their cycle: opening
   * the review hands each one to whoever owes the first assessment — the employee, or the reviewer directly when the
   * cycle asks for no self assessment.
   */
  async transition(id: string, to: 'ACTIVE' | 'REVIEW' | 'CLOSED', actor: Actor): Promise<CompetencyCycleDto> {
    const allowed: Record<string, string[]> = { ACTIVE: ['DRAFT'], REVIEW: ['ACTIVE'], CLOSED: ['ACTIVE', 'REVIEW'] };
    const row = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT "id" FROM "competency_assessment_cycles" WHERE "id" = ${id} FOR UPDATE`;
      const cycle = await tx.competencyAssessmentCycle.findUnique({ where: { id }, include: cycleInclude });
      if (!cycle) throw new AppError(404, 'COMPETENCY_CYCLE_NOT_FOUND', 'Assessment cycle not found');
      if (cycle.status === to) throw new AppError(409, 'COMPETENCY_CYCLE_ALREADY_IN_STATE', `This cycle is already ${to.toLowerCase()}`);
      if (!allowed[to].includes(cycle.status)) {
        throw new AppError(409, 'COMPETENCY_CYCLE_TRANSITION_INVALID', `A ${cycle.status.toLowerCase()} cycle cannot move to ${to.toLowerCase()}`);
      }

      const after = await tx.competencyAssessmentCycle.update({
        where: { id },
        data: {
          status: to,
          activatedAt: to === 'ACTIVE' ? new Date() : undefined,
          reviewOpenedAt: to === 'REVIEW' ? new Date() : undefined,
          closedAt: to === 'CLOSED' ? new Date() : undefined,
        },
        include: cycleInclude,
      });

      if (to === 'ACTIVE') await tx.competencyAssessment.updateMany({ where: { cycleId: id, status: 'DRAFT' }, data: { status: 'ACTIVE' } });
      if (to === 'REVIEW') {
        await tx.competencyAssessment.updateMany({
          where: { cycleId: id, status: { in: ['DRAFT', 'ACTIVE'] } },
          data: { status: cycle.selfAssessmentRequired ? 'SELF_REVIEW' : 'MANAGER_REVIEW' },
        });
        const assessments = await tx.competencyAssessment.findMany({
          where: { cycleId: id, status: { in: ['SELF_REVIEW', 'MANAGER_REVIEW'] } },
          select: { id: true, employeeNameSnapshot: true, reviewerUserId: true, employee: { select: { user: { select: { id: true } } } } },
        });
        for (const assessment of assessments) {
          await notificationService.publish(
            {
              userId: cycle.selfAssessmentRequired ? assessment.employee.user?.id ?? null : assessment.reviewerUserId,
              type: cycle.selfAssessmentRequired ? NOTIFICATION_TYPES.COMPETENCY_ASSESSMENT_OPENED : NOTIFICATION_TYPES.COMPETENCY_MANAGER_ASSESSMENT_REQUIRED,
              source: { module: 'competency', entityType: 'COMPETENCY_ASSESSMENT', entityId: assessment.id },
              data: { assessmentId: assessment.id, cycleId: id },
              dedupeKey: `competency:${assessment.id}:assessment-opened`,
            },
            { cycleName: cycle.name, employeeName: assessment.employeeNameSnapshot },
            tx,
          );
        }
      }

      await auditService.log(competencyAudit(actor, AUDIT_ACTIONS.UPDATE_COMPETENCY_CYCLE, 'CompetencyAssessmentCycle', id,
        { status: to, assessments: cycle._count.assessments }, { status: cycle.status }), tx);
      return after;
    });
    return toCycleDto(row);
  },
};

// ---------------------------------------------------------------------------
// assessments
// ---------------------------------------------------------------------------
const assessmentInclude = {
  cycle: { select: { id: true, code: true, name: true, status: true, selfAssessmentRequired: true } },
  employee: { select: { id: true, employeeCode: true, firstName: true, lastName: true, user: { select: { id: true, isActive: true } } } },
  items: { orderBy: [{ competencyCodeSnapshot: 'asc' as const }] },
} satisfies Prisma.CompetencyAssessmentInclude;
type AssessmentRow = Prisma.CompetencyAssessmentGetPayload<{ include: typeof assessmentInclude }>;

const toItemDto = (row: AssessmentRow['items'][number]): AssessmentItemDto => {
  const gap = calculateGap({ requiredLevel: row.requiredLevelSnapshot, currentLevel: row.finalLevel });
  return {
    id: row.id,
    competencyId: row.competencyId,
    competencyCode: row.competencyCodeSnapshot,
    competencyName: row.competencyNameSnapshot,
    category: row.categorySnapshot,
    scaleName: row.scaleNameSnapshot,
    levelLabels: (row.levelLabelsSnapshot as { level: number; label: string }[] | null) ?? [],
    indicators: (row.indicatorsSnapshot as { level: number; description: string }[] | null) ?? [],
    requiredLevel: row.requiredLevelSnapshot,
    weight: row.weightSnapshot === null ? null : Number(row.weightSnapshot),
    isMandatory: row.isMandatorySnapshot,
    selfLevel: row.selfLevel,
    managerLevel: row.managerLevel,
    finalLevel: row.finalLevel,
    selfComment: row.selfComment,
    managerComment: row.managerComment,
    gap: gap.gap,
    gapNeeded: gap.gapNeeded,
    gapStatus: gap.status,
  };
};

function toSummaryDto(row: AssessmentRow): AssessmentSummaryDto {
  const items = row.items.map(toItemDto);
  return {
    id: row.id,
    cycle: row.cycle,
    employee: { id: row.employee.id, employeeCode: row.employeeCodeSnapshot, firstName: row.employee.firstName, lastName: row.employee.lastName },
    snapshot: { organizationName: row.organizationName, departmentName: row.departmentName, positionTitle: row.positionTitle, jobTitle: row.jobTitle },
    reviewer: { employeeId: row.reviewerEmployeeId, name: row.reviewerNameSnapshot, hasAccount: !!row.reviewerUserId },
    status: row.status as AssessmentSummaryDto['status'],
    selfSubmittedAt: row.selfSubmittedAt?.toISOString() ?? null,
    managerSubmittedAt: row.managerSubmittedAt?.toISOString() ?? null,
    finalizedAt: row.finalizedAt?.toISOString() ?? null,
    itemCount: items.length,
    gapCount: items.filter((i) => i.gapStatus === 'GAP').length,
    selfAssessmentUnavailable: !row.employee.user?.isActive,
  };
}

const toDetailDto = (row: AssessmentRow): AssessmentDetailDto => ({ ...toSummaryDto(row), items: row.items.map(toItemDto) });

async function loadAssessment(db: Db, id: string): Promise<AssessmentRow> {
  const row = await db.competencyAssessment.findUnique({ where: { id }, include: assessmentInclude });
  if (!row) throw new AppError(404, 'COMPETENCY_ASSESSMENT_NOT_FOUND', 'Assessment not found');
  return row;
}

const lockAssessment = async (tx: Tx, id: string) => {
  await tx.$executeRaw`SELECT "id" FROM "competency_assessments" WHERE "id" = ${id} FOR UPDATE`;
};

/**
 * Who may read one assessment: the employee it is about, the reviewer it was assigned to, or somebody who manages
 * the framework. A manager's team scope is enough to see **aggregate** team numbers and nothing else — what a
 * reviewer wrote about somebody is not team data.
 */
function assertCanRead(auth: AuthContext, assessment: { employeeId: string; reviewerUserId: string | null }) {
  const isSubject = !!auth.employeeId && assessment.employeeId === auth.employeeId;
  const isReviewer = !!assessment.reviewerUserId && assessment.reviewerUserId === auth.userId;
  if (!isSubject && !isReviewer && !hasPermission(auth, PERMISSIONS.COMPETENCY_MANAGE)) throw AppError.forbidden();
}

function assertIsReviewer(auth: AuthContext, assessment: { reviewerUserId: string | null }) {
  if (!assessment.reviewerUserId || assessment.reviewerUserId !== auth.userId) throw AppError.forbidden();
  if (!hasPermission(auth, PERMISSIONS.COMPETENCY_ASSESS)) throw AppError.forbidden();
}

function assertIsSubject(auth: AuthContext, assessment: { employeeId: string }) {
  if (!auth.employeeId || assessment.employeeId !== auth.employeeId) throw AppError.forbidden();
}

const employeeForAssessment = {
  id: true, employeeCode: true, firstName: true, lastName: true, employmentStatus: true,
  organizationId: true, departmentId: true, positionId: true,
  organization: { select: { name: true } },
  department: { select: { name: true } },
  position: { select: { title: true, jobId: true, job: { select: { id: true, title: true } } } },
  manager: { select: { id: true, firstName: true, lastName: true, user: { select: { id: true, isActive: true } } } },
} satisfies Prisma.EmployeeSelect;

export const competencyAssessmentService = {
  /**
   * Assigning a cycle to a population, snapshotting each employee's job profile onto their assessment.
   *
   * An employee whose job has no competency requirements is **skipped with a reason**, never given an empty
   * assessment: an assessment with nothing in it looks like an oversight by the reviewer rather than a gap in the
   * framework, and the person who can fix it is HR.
   */
  async assign(cycleId: string, input: AssignAssessmentsInput, actor: Actor): Promise<AssignAssessmentsResultDto> {
    return prisma.$transaction(async (tx) => {
      const cycle = await tx.competencyAssessmentCycle.findUnique({ where: { id: cycleId }, select: { id: true, code: true, status: true } });
      if (!cycle) throw new AppError(404, 'COMPETENCY_CYCLE_NOT_FOUND', 'Assessment cycle not found');
      if (cycle.status === 'CLOSED') throw new AppError(409, 'COMPETENCY_CYCLE_CLOSED', 'A closed cycle cannot be assigned to');

      const where: Prisma.EmployeeWhereInput = input.employeeIds?.length
        ? { id: { in: input.employeeIds } }
        : {
            employmentStatus: 'ACTIVE',
            organizationId: input.organizationId,
            departmentId: input.departmentId,
            positionId: input.positionId,
            ...(input.jobId ? { position: { jobId: input.jobId } } : {}),
          };
      const employees = await tx.employee.findMany({ where, select: employeeForAssessment, orderBy: { employeeCode: 'asc' } });
      if (employees.length === 0) throw new AppError(409, 'COMPETENCY_NO_EMPLOYEES', 'No employee matches that selection');

      const existing = await tx.competencyAssessment.findMany({ where: { cycleId, employeeId: { in: employees.map((e) => e.id) } }, select: { employeeId: true } });
      const already = new Set(existing.map((e) => e.employeeId));

      // One query per distinct job in the population, rather than one per employee.
      const jobIds = [...new Set(employees.map((e) => e.position?.jobId).filter((id): id is string => !!id))];
      const requirementsByJob = new Map<string, Awaited<ReturnType<typeof jobProfileService.requirementsFor>>>();
      for (const jobId of jobIds) requirementsByJob.set(jobId, await jobProfileService.requirementsFor(tx, jobId));

      const skipped: AssignAssessmentsResultDto['skipped'] = [];
      let created = 0;
      for (const employee of employees) {
        if (already.has(employee.id)) continue;
        if (employee.employmentStatus !== 'ACTIVE') { skipped.push({ employeeCode: employee.employeeCode, reason: 'Not an active employee' }); continue; }
        const jobId = employee.position?.jobId ?? null;
        if (!jobId) { skipped.push({ employeeCode: employee.employeeCode, reason: 'Their position is not linked to a job' }); continue; }
        const jobRequirements = requirementsByJob.get(jobId) ?? [];
        if (jobRequirements.length === 0) {
          skipped.push({ employeeCode: employee.employeeCode, reason: `${employee.position?.job?.title ?? 'Their job'} has no competency profile yet` });
          continue;
        }

        await tx.competencyAssessment.create({
          data: {
            cycleId,
            employeeId: employee.id,
            employeeCodeSnapshot: employee.employeeCode,
            employeeNameSnapshot: `${employee.firstName} ${employee.lastName}`,
            organizationId: employee.organizationId,
            organizationName: employee.organization?.name ?? null,
            departmentId: employee.departmentId,
            departmentName: employee.department?.name ?? null,
            positionId: employee.positionId,
            positionTitle: employee.position?.title ?? null,
            jobId,
            jobTitle: employee.position?.job?.title ?? null,
            reviewerEmployeeId: employee.manager?.id ?? null,
            reviewerUserId: employee.manager?.user?.isActive ? employee.manager.user.id : null,
            reviewerNameSnapshot: employee.manager ? `${employee.manager.firstName} ${employee.manager.lastName}` : null,
            status: cycle.status === 'DRAFT' ? 'DRAFT' : 'ACTIVE',
            items: {
              create: jobRequirements.map((requirement) => ({
                competencyId: requirement.competencyId,
                competencyCodeSnapshot: requirement.competency.code,
                competencyNameSnapshot: requirement.competency.name,
                categorySnapshot: requirement.competency.category.name,
                scaleIdSnapshot: requirement.competency.scale.id,
                scaleNameSnapshot: requirement.competency.scale.name,
                levelLabelsSnapshot: requirement.competency.scale.levels.map((l) => ({ level: l.level, label: l.label })),
                indicatorsSnapshot: [],
                requiredLevelSnapshot: requirement.requiredLevel,
                weightSnapshot: requirement.weight,
                isMandatorySnapshot: requirement.isMandatory,
              })),
            },
          },
        });
        created += 1;
      }

      // Indicators are guidance the reviewer reads, so they are copied too — as they read today, frozen from now on.
      if (created > 0) {
        const newItems = await tx.competencyAssessmentItem.findMany({
          where: { assessment: { cycleId }, competencyId: { not: null }, indicatorsSnapshot: { equals: [] } },
          select: { id: true, competencyId: true },
        });
        const indicators = await tx.competencyLevelIndicator.findMany({
          where: { competencyId: { in: [...new Set(newItems.map((i) => i.competencyId!))] } },
          orderBy: { level: 'asc' },
        });
        const byCompetency = new Map<string, { level: number; description: string }[]>();
        for (const indicator of indicators) {
          byCompetency.set(indicator.competencyId, [...(byCompetency.get(indicator.competencyId) ?? []), { level: indicator.level, description: indicator.description }]);
        }
        for (const item of newItems) {
          const snapshot = byCompetency.get(item.competencyId!) ?? [];
          if (snapshot.length) await tx.competencyAssessmentItem.update({ where: { id: item.id }, data: { indicatorsSnapshot: snapshot } });
        }
      }

      await auditService.log(competencyAudit(actor, AUDIT_ACTIONS.ASSIGN_COMPETENCY_ASSESSMENT, 'CompetencyAssessmentCycle', cycleId, {
        cycle: cycle.code, created, alreadyAssigned: already.size, skipped: skipped.length,
      }), tx);
      return { created, alreadyAssigned: already.size, skipped };
    });
  },

  async list(auth: AuthContext, q: AssessmentListQuery): Promise<{ data: AssessmentSummaryDto[]; meta: { page: number; pageSize: number; total: number } }> {
    let scope: Prisma.CompetencyAssessmentWhereInput;
    if (q.view === 'all') {
      if (!hasPermission(auth, PERMISSIONS.COMPETENCY_MANAGE)) throw AppError.forbidden();
      scope = {};
    } else if (q.view === 'reviewing') {
      if (!hasPermission(auth, PERMISSIONS.COMPETENCY_ASSESS)) throw AppError.forbidden();
      scope = { reviewerUserId: auth.userId };
    } else {
      if (!auth.employeeId) return { data: [], meta: { page: q.page, pageSize: q.pageSize, total: 0 } };
      scope = { employeeId: auth.employeeId };
    }
    const where: Prisma.CompetencyAssessmentWhereInput = {
      ...scope,
      cycleId: q.cycleId,
      status: q.status,
      departmentId: q.departmentId,
      ...(q.search ? { OR: [{ employeeCodeSnapshot: { contains: q.search, mode: 'insensitive' } }, { employeeNameSnapshot: { contains: q.search, mode: 'insensitive' } }] } : {}),
    };
    const [total, rows] = await prisma.$transaction([
      prisma.competencyAssessment.count({ where }),
      prisma.competencyAssessment.findMany({ where, include: assessmentInclude, orderBy: [{ cycle: { periodStart: 'desc' } }, { employeeCodeSnapshot: 'asc' }], skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
    ]);
    return { data: rows.map(toSummaryDto), meta: { page: q.page, pageSize: q.pageSize, total } };
  },

  async get(auth: AuthContext, id: string): Promise<AssessmentDetailDto> {
    const row = await loadAssessment(prisma, id);
    assertCanRead(auth, row);
    return toDetailDto(row);
  },

  /** Reassigning a reviewer — audited, and the only way the snapshot changes. */
  async reassignReviewer(id: string, input: ReassignReviewerInput, actor: Actor): Promise<AssessmentDetailDto> {
    const row = await prisma.$transaction(async (tx) => {
      const assessment = await loadAssessment(tx, id);
      if (assessment.status === 'FINALIZED' || assessment.cycle.status === 'CLOSED') {
        throw new AppError(409, 'COMPETENCY_ASSESSMENT_FINALIZED', 'A finalized assessment cannot be changed');
      }
      let data: Prisma.CompetencyAssessmentUpdateInput;
      if (input.reviewerEmployeeId === null) {
        data = { reviewerEmployee: { disconnect: true }, reviewerUser: { disconnect: true }, reviewerNameSnapshot: null };
      } else {
        const reviewer = await tx.employee.findUnique({
          where: { id: input.reviewerEmployeeId },
          select: { id: true, firstName: true, lastName: true, user: { select: { id: true, isActive: true } } },
        });
        if (!reviewer) throw new AppError(404, 'EMPLOYEE_NOT_FOUND', 'That employee does not exist');
        if (reviewer.id === assessment.employeeId) throw new AppError(409, 'COMPETENCY_REVIEWER_IS_SUBJECT', 'Somebody cannot assess themselves');
        if (!reviewer.user?.isActive) throw new AppError(409, 'COMPETENCY_REVIEWER_REQUIRED', 'That reviewer has no active account, so they could not open the assessment');
        data = {
          reviewerEmployee: { connect: { id: reviewer.id } },
          reviewerUser: { connect: { id: reviewer.user.id } },
          reviewerNameSnapshot: `${reviewer.firstName} ${reviewer.lastName}`,
        };
      }
      const after = await tx.competencyAssessment.update({ where: { id }, data, include: assessmentInclude });
      await auditService.log(competencyAudit(actor, AUDIT_ACTIONS.REASSIGN_COMPETENCY_REVIEWER, 'CompetencyAssessment', id,
        { reviewerEmployeeId: after.reviewerEmployeeId, reviewerName: after.reviewerNameSnapshot },
        { reviewerEmployeeId: assessment.reviewerEmployeeId, reviewerName: assessment.reviewerNameSnapshot }), tx);
      return after;
    });
    return toDetailDto(row);
  },

  // -------------------------------------------------------------------------
  // the employee's side
  // -------------------------------------------------------------------------
  async selfAssess(auth: AuthContext, itemId: string, input: SelfAssessmentItemInput): Promise<AssessmentDetailDto> {
    const row = await prisma.$transaction(async (tx) => {
      const item = await tx.competencyAssessmentItem.findUnique({ where: { id: itemId }, select: { id: true, assessmentId: true, scaleIdSnapshot: true, levelLabelsSnapshot: true, scaleNameSnapshot: true } });
      if (!item) throw new AppError(404, 'COMPETENCY_ITEM_NOT_FOUND', 'Assessment item not found');
      const assessment = await loadAssessment(tx, item.assessmentId);
      assertIsSubject(auth, assessment);
      if (assessment.status !== 'SELF_REVIEW') {
        throw new AppError(409, 'COMPETENCY_SELF_ASSESSMENT_CLOSED', assessment.selfSubmittedAt ? 'Your self assessment has been submitted and can no longer be changed' : 'The self assessment is not open for this record');
      }
      if (input.selfLevel !== undefined && input.selfLevel !== null) assertItemLevel(item, input.selfLevel);
      await tx.competencyAssessmentItem.update({
        where: { id: itemId },
        data: { selfLevel: input.selfLevel === undefined ? undefined : input.selfLevel, selfComment: input.selfComment },
      });
      return loadAssessment(tx, item.assessmentId);
    });
    return toDetailDto(row);
  },

  async submitSelf(auth: AuthContext, assessmentId: string, actor: Actor): Promise<AssessmentDetailDto> {
    const row = await prisma.$transaction(async (tx) => {
      await lockAssessment(tx, assessmentId);
      const assessment = await loadAssessment(tx, assessmentId);
      assertIsSubject(auth, assessment);
      if (assessment.status !== 'SELF_REVIEW') {
        throw new AppError(409, 'COMPETENCY_SELF_ASSESSMENT_CLOSED', assessment.selfSubmittedAt ? 'Your self assessment has already been submitted' : 'The self assessment is not open for this record');
      }
      for (const item of assessment.items) {
        if (item.selfLevel === null) throw new AppError(422, 'COMPETENCY_SELF_LEVEL_MISSING', `${item.competencyNameSnapshot} has no level yet`);
      }
      if (!assessment.reviewerUserId) throw new AppError(409, 'COMPETENCY_REVIEWER_REQUIRED', 'This assessment has no reviewer with an account; ask HR to assign one');

      const after = await tx.competencyAssessment.update({ where: { id: assessmentId }, data: { status: 'MANAGER_REVIEW', selfSubmittedAt: new Date() }, include: assessmentInclude });
      await auditService.log(competencyAudit(actor, AUDIT_ACTIONS.SUBMIT_COMPETENCY_SELF_ASSESSMENT, 'CompetencyAssessment', assessmentId, {
        cycle: assessment.cycle.code, employee: assessment.employeeCodeSnapshot, items: assessment.items.length,
        commentedItems: assessment.items.filter((i) => !!i.selfComment).length,
      }), tx);
      for (const [type, key] of [
        [NOTIFICATION_TYPES.COMPETENCY_SELF_ASSESSMENT_SUBMITTED, 'self-submitted'],
        [NOTIFICATION_TYPES.COMPETENCY_MANAGER_ASSESSMENT_REQUIRED, 'manager-required'],
      ] as const) {
        await notificationService.publish(
          {
            userId: assessment.reviewerUserId,
            type,
            source: { module: 'competency', entityType: 'COMPETENCY_ASSESSMENT', entityId: assessmentId },
            data: { assessmentId, cycleId: assessment.cycleId },
            dedupeKey: `competency:${assessmentId}:${key}`,
          },
          { employeeName: assessment.employeeNameSnapshot, cycleName: assessment.cycle.name },
          tx,
        );
      }
      return after;
    });
    return toDetailDto(row);
  },

  // -------------------------------------------------------------------------
  // the reviewer's side
  // -------------------------------------------------------------------------
  async managerAssess(auth: AuthContext, itemId: string, input: ManagerAssessmentItemInput): Promise<AssessmentDetailDto> {
    const row = await prisma.$transaction(async (tx) => {
      const item = await tx.competencyAssessmentItem.findUnique({ where: { id: itemId }, select: { id: true, assessmentId: true, scaleIdSnapshot: true, levelLabelsSnapshot: true, scaleNameSnapshot: true } });
      if (!item) throw new AppError(404, 'COMPETENCY_ITEM_NOT_FOUND', 'Assessment item not found');
      const assessment = await loadAssessment(tx, item.assessmentId);
      assertIsReviewer(auth, assessment);
      if (assessment.status !== 'MANAGER_REVIEW') {
        throw new AppError(409, 'COMPETENCY_MANAGER_ASSESSMENT_CLOSED', assessment.status === 'FINALIZED' ? 'This assessment has been submitted and can no longer be changed' : 'This assessment is not waiting for you');
      }
      if (input.managerLevel !== undefined && input.managerLevel !== null) assertItemLevel(item, input.managerLevel);
      await tx.competencyAssessmentItem.update({
        where: { id: itemId },
        data: { managerLevel: input.managerLevel === undefined ? undefined : input.managerLevel, managerComment: input.managerComment },
      });
      return loadAssessment(tx, item.assessmentId);
    });
    return toDetailDto(row);
  },

  /**
   * Submitting the reviewer's assessment, which finalizes it.
   *
   * **The final level is the reviewer's level** — not an average of theirs and the employee's. A self assessment is
   * evidence a reviewer reads, not half a vote, and averaging the two would produce a number neither person said.
   */
  async submitManager(auth: AuthContext, assessmentId: string, actor: Actor): Promise<AssessmentDetailDto> {
    const row = await prisma.$transaction(async (tx) => {
      await lockAssessment(tx, assessmentId);
      const assessment = await loadAssessment(tx, assessmentId);
      assertIsReviewer(auth, assessment);
      if (assessment.status !== 'MANAGER_REVIEW') {
        throw new AppError(409, 'COMPETENCY_MANAGER_ASSESSMENT_CLOSED', assessment.status === 'FINALIZED' ? 'This assessment has already been submitted' : 'This assessment is not waiting for you');
      }
      if (assessment.cycle.status === 'CLOSED') throw new AppError(409, 'COMPETENCY_CYCLE_CLOSED', 'This cycle is closed');
      for (const item of assessment.items) {
        if (item.managerLevel === null) throw new AppError(422, 'COMPETENCY_MANAGER_LEVEL_MISSING', `${item.competencyNameSnapshot} has no level yet`);
        await tx.competencyAssessmentItem.update({ where: { id: item.id }, data: { finalLevel: item.managerLevel } });
      }

      const after = await tx.competencyAssessment.update({
        where: { id: assessmentId },
        data: { status: 'FINALIZED', managerSubmittedAt: new Date(), finalizedAt: new Date() },
        include: assessmentInclude,
      });
      const gaps = after.items.filter((i) => i.finalLevel !== null && i.finalLevel < i.requiredLevelSnapshot).length;
      await auditService.log(competencyAudit(actor, AUDIT_ACTIONS.SUBMIT_COMPETENCY_MANAGER_ASSESSMENT, 'CompetencyAssessment', assessmentId, {
        cycle: assessment.cycle.code, employee: assessment.employeeCodeSnapshot, items: assessment.items.length,
        commentedItems: assessment.items.filter((i) => !!i.managerComment).length,
      }), tx);
      await auditService.log(competencyAudit(actor, AUDIT_ACTIONS.FINALIZE_COMPETENCY_ASSESSMENT, 'CompetencyAssessment', assessmentId, {
        cycle: assessment.cycle.code, employee: assessment.employeeCodeSnapshot, competenciesBelowRequirement: gaps,
      }), tx);
      await notificationService.publish(
        {
          userId: assessment.employee.user?.id ?? null,
          type: NOTIFICATION_TYPES.COMPETENCY_ASSESSMENT_FINALIZED,
          source: { module: 'competency', entityType: 'COMPETENCY_ASSESSMENT', entityId: assessmentId },
          data: { assessmentId, cycleId: assessment.cycleId },
          dedupeKey: `competency:${assessmentId}:finalized`,
        },
        { cycleName: assessment.cycle.name },
        tx,
      );
      return after;
    });
    return toDetailDto(row);
  },
};

/** A level has to be one the scale actually had when this assessment was made. */
function assertItemLevel(item: { levelLabelsSnapshot: unknown; scaleNameSnapshot: string | null }, level: number) {
  const labels = (item.levelLabelsSnapshot as { level: number; label: string }[] | null) ?? [];
  assertLevelOnScale(level, labels.map((l) => l.level), item.scaleNameSnapshot ?? 'competency');
}

export { assertCanRead };
