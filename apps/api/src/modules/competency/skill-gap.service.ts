import { MIN_AGGREGATE_GROUP_SIZE, calculateGap, partitionSuppression, suppressedCell, type AggregateSuppression, type GapReportDto, type GapReportQuery, type SkillGapQuery, type SkillGapRowDto, type SkillProfileDto, type SkillProfileEntryDto } from '@hr/shared';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { AppError } from '../../lib/errors';
import { jobProfileService } from './job-profile.service';

/**
 * Where somebody is against what their job asks for.
 *
 * Two questions that look alike and are not:
 *
 * - **An assessment** answers "how did this come out at the time?" — measured against the requirement as it stood
 *   then, which is frozen on the assessment.
 * - **A skill profile** answers "where does this person stand today?" — their latest assessed level against their
 *   *current* job's requirement, which may have moved since, and may belong to a different job entirely.
 *
 * Both are true at once, and keeping them apart is the whole design. Raising a requirement creates a gap from today;
 * it does not retroactively turn last year's finished assessment into a failure.
 *
 * And throughout: **unassessed is not zero.** Somebody nobody has looked at has an unknown level, which is a
 * different fact from being assessed at the bottom of the scale.
 */

/** The latest finalized level per competency for a set of employees, in one query. */
async function latestLevels(employeeIds: string[]) {
  if (employeeIds.length === 0) return new Map<string, Map<string, { level: number; assessedAt: Date; cycle: { id: string; code: string; name: string } }>>();
  const items = await prisma.competencyAssessmentItem.findMany({
    where: {
      competencyId: { not: null },
      finalLevel: { not: null },
      assessment: { employeeId: { in: employeeIds }, status: 'FINALIZED' },
    },
    select: {
      competencyId: true,
      finalLevel: true,
      assessment: { select: { employeeId: true, finalizedAt: true, cycle: { select: { id: true, code: true, name: true } } } },
    },
    orderBy: { assessment: { finalizedAt: 'asc' } },
  });
  // Ordered oldest first, so the last write per (employee, competency) is the most recent assessment.
  const byEmployee = new Map<string, Map<string, { level: number; assessedAt: Date; cycle: { id: string; code: string; name: string } }>>();
  for (const item of items) {
    const employeeId = item.assessment.employeeId;
    if (!byEmployee.has(employeeId)) byEmployee.set(employeeId, new Map());
    byEmployee.get(employeeId)!.set(item.competencyId!, {
      level: item.finalLevel!,
      assessedAt: item.assessment.finalizedAt ?? new Date(0),
      cycle: item.assessment.cycle,
    });
  }
  return byEmployee;
}

export const skillGapService = {
  /**
   * One employee's current skill profile: their job's requirements, the latest level assessed for each, and the gap
   * between them. Competencies they have been assessed on that their current job does not require are listed too —
   * a skill does not stop existing because somebody changed jobs.
   */
  async profileFor(employeeId: string): Promise<SkillProfileDto> {
    const employee = await prisma.employee.findUnique({
      where: { id: employeeId },
      select: {
        id: true, employeeCode: true, firstName: true, lastName: true,
        position: { select: { job: { select: { id: true, code: true, title: true } } } },
      },
    });
    if (!employee) throw new AppError(404, 'EMPLOYEE_NOT_FOUND', 'Employee not found');

    const job = employee.position?.job ?? null;
    const requirements = job ? await jobProfileService.requirementsFor(prisma, job.id) : [];
    const levels = (await latestLevels([employeeId])).get(employeeId) ?? new Map();

    const entries: SkillProfileEntryDto[] = requirements.map((requirement) => {
      const assessed = levels.get(requirement.competencyId);
      const gap = calculateGap({ requiredLevel: requirement.requiredLevel, currentLevel: assessed?.level ?? null });
      const scaleLevels = requirement.competency.scale.levels;
      return {
        competencyId: requirement.competencyId,
        competencyCode: requirement.competency.code,
        competencyName: requirement.competency.name,
        category: requirement.competency.category.name,
        requiredLevel: requirement.requiredLevel,
        requiredLevelLabel: scaleLevels.find((l) => l.level === requirement.requiredLevel)?.label ?? null,
        currentLevel: assessed?.level ?? null,
        currentLevelLabel: assessed ? scaleLevels.find((l) => l.level === assessed.level)?.label ?? null : null,
        gap: gap.gap,
        gapNeeded: gap.gapNeeded,
        gapStatus: gap.status,
        lastAssessedAt: assessed?.assessedAt.toISOString() ?? null,
        sourceCycle: assessed?.cycle ?? null,
        isMandatory: requirement.isMandatory,
      };
    });

    // Assessed but not required by the current job — kept, with no requirement to measure against.
    const requiredIds = new Set(requirements.map((r) => r.competencyId));
    const extras = [...levels.entries()].filter(([competencyId]) => !requiredIds.has(competencyId));
    if (extras.length > 0) {
      const competencies = await prisma.competency.findMany({
        where: { id: { in: extras.map(([id]) => id) } },
        include: { category: { select: { name: true } }, scale: { include: { levels: true } } },
      });
      for (const [competencyId, assessed] of extras) {
        const competency = competencies.find((c) => c.id === competencyId);
        if (!competency) continue;
        entries.push({
          competencyId,
          competencyCode: competency.code,
          competencyName: competency.name,
          category: competency.category.name,
          requiredLevel: null,
          requiredLevelLabel: null,
          currentLevel: assessed.level,
          currentLevelLabel: competency.scale.levels.find((l) => l.level === assessed.level)?.label ?? null,
          gap: null,
          gapNeeded: null,
          gapStatus: 'NO_GAP',
          lastAssessedAt: assessed.assessedAt.toISOString(),
          sourceCycle: assessed.cycle,
          isMandatory: false,
        });
      }
    }

    return {
      employee: { id: employee.id, employeeCode: employee.employeeCode, firstName: employee.firstName, lastName: employee.lastName },
      job,
      entries,
      summary: {
        required: requirements.length,
        assessed: entries.filter((e) => e.currentLevel !== null).length,
        withGap: entries.filter((e) => e.gapStatus === 'GAP').length,
        unassessed: entries.filter((e) => e.gapStatus === 'UNASSESSED').length,
        exceeding: entries.filter((e) => e.gapStatus === 'EXCEEDS_REQUIREMENT').length,
      },
    };
  },

  /**
   * **The hand-off to development planning (Task 25).**
   *
   * Everything that needs to act on a skill gap — training needs analysis, an individual development plan — reads it
   * from here rather than recomputing it from the tables. One definition of a gap, one place it can be wrong, one
   * place to fix it.
   *
   * Rows are returned for competencies that have never been assessed as well, with `currentLevel: null` and
   * `gapStatus: UNASSESSED`: planning may well decide that "nobody has looked" is itself a need, but that is its
   * decision to make, not an assumption buried in this query.
   */
  async getSkillGapsForDevelopment(q: SkillGapQuery): Promise<SkillGapRowDto[]> {
    const where: Prisma.EmployeeWhereInput = {
      employmentStatus: 'ACTIVE',
      id: q.employeeId,
      organizationId: q.organizationId,
      departmentId: q.departmentId,
      ...(q.jobId ? { position: { jobId: q.jobId } } : {}),
    };
    const employees = await prisma.employee.findMany({
      where,
      select: {
        id: true, employeeCode: true, firstName: true, lastName: true, departmentId: true,
        department: { select: { name: true } },
        position: { select: { job: { select: { id: true, title: true } } } },
      },
      orderBy: { employeeCode: 'asc' },
    });
    if (employees.length === 0) return [];

    const jobIds = [...new Set(employees.map((e) => e.position?.job?.id).filter((id): id is string => !!id))];
    const requirements = await prisma.jobCompetencyRequirement.findMany({
      where: { jobId: { in: jobIds } },
      include: { competency: { select: { id: true, code: true, name: true } } },
    });
    const byJob = new Map<string, typeof requirements>();
    for (const requirement of requirements) byJob.set(requirement.jobId, [...(byJob.get(requirement.jobId) ?? []), requirement]);

    const levels = await latestLevels(employees.map((e) => e.id));

    const rows: SkillGapRowDto[] = [];
    for (const employee of employees) {
      const jobId = employee.position?.job?.id ?? null;
      if (!jobId) continue;
      const employeeLevels = levels.get(employee.id) ?? new Map();
      for (const requirement of byJob.get(jobId) ?? []) {
        const assessed = employeeLevels.get(requirement.competencyId);
        const gap = calculateGap({ requiredLevel: requirement.requiredLevel, currentLevel: assessed?.level ?? null });
        if (q.gapOnly && gap.status !== 'GAP') continue;
        rows.push({
          employeeId: employee.id,
          employeeCode: employee.employeeCode,
          employeeName: `${employee.firstName} ${employee.lastName}`,
          competencyId: requirement.competencyId,
          competencyCode: requirement.competency.code,
          competencyName: requirement.competency.name,
          currentLevel: assessed?.level ?? null,
          requiredLevel: requirement.requiredLevel,
          gapNeeded: gap.gapNeeded,
          gapStatus: gap.status,
          jobId,
          jobTitle: employee.position?.job?.title ?? null,
          departmentId: employee.departmentId,
          departmentName: employee.department?.name ?? null,
          assessmentDate: assessed?.assessedAt.toISOString() ?? null,
        });
      }
    }
    return rows;
  },

  /**
   * The HR gap report — aggregates only, over **finalized assessments**, using each assessment's own snapshots so a
   * historical cycle reads as it did at the time.
   *
   * Coverage is measured against what the cycle actually assigned, never against the whole employee master: a cycle
   * that deliberately covered one department is not 4% complete.
   */
  /**
   * One employee's latest levels against ANOTHER job's requirements — the career question "what would I still need
   * for that role?" (Task 28). Same levels, same gap rule, same unassessed-is-not-zero semantics as the profile;
   * only the requirement set differs. Career and succession code calls this and never recomputes a gap itself.
   */
  async getGapsAgainstJob(q: { employeeId: string; jobId: string }): Promise<Omit<SkillGapRowDto, 'employeeCode' | 'employeeName' | 'departmentId' | 'departmentName'>[]> {
    const requirements = await jobProfileService.requirementsFor(prisma, q.jobId);
    if (requirements.length === 0) return [];
    const levels = (await latestLevels([q.employeeId])).get(q.employeeId) ?? new Map();
    const job = await prisma.job.findUnique({ where: { id: q.jobId }, select: { title: true } });
    return requirements.map((requirement) => {
      const assessed = levels.get(requirement.competencyId);
      const gap = calculateGap({ requiredLevel: requirement.requiredLevel, currentLevel: assessed?.level ?? null });
      return {
        employeeId: q.employeeId,
        competencyId: requirement.competencyId,
        competencyCode: requirement.competency.code,
        competencyName: requirement.competency.name,
        currentLevel: assessed?.level ?? null,
        requiredLevel: requirement.requiredLevel,
        gapNeeded: gap.gapNeeded,
        gapStatus: gap.status,
        jobId: q.jobId,
        jobTitle: job?.title ?? null,
        assessmentDate: assessed?.assessedAt.toISOString() ?? null,
      };
    });
  },

  async gapReport(q: GapReportQuery): Promise<GapReportDto> {
    const assessmentWhere: Prisma.CompetencyAssessmentWhereInput = {
      cycleId: q.cycleId,
      organizationId: q.organizationId,
      departmentId: q.departmentId,
      jobId: q.jobId,
    };
    const [assigned, selfSubmitted, finalized] = await prisma.$transaction([
      prisma.competencyAssessment.count({ where: assessmentWhere }),
      prisma.competencyAssessment.count({ where: { ...assessmentWhere, selfSubmittedAt: { not: null } } }),
      prisma.competencyAssessment.count({ where: { ...assessmentWhere, status: 'FINALIZED' } }),
    ]);

    const items = await prisma.competencyAssessmentItem.findMany({
      where: {
        competencyId: q.competencyId,
        finalLevel: { not: null },
        assessment: { ...assessmentWhere, status: 'FINALIZED' },
      },
      select: {
        competencyId: true, competencyCodeSnapshot: true, competencyNameSnapshot: true,
        requiredLevelSnapshot: true, finalLevel: true,
        assessment: { select: { employeeId: true, departmentName: true, jobTitle: true } },
      },
    });

    const gapRows = items.map((item) => ({
      ...item,
      gap: item.requiredLevelSnapshot - (item.finalLevel ?? 0),
    }));
    const withGap = gapRows.filter((row) => row.gap > 0);

    const employeesAssessed = new Set(gapRows.map((row) => row.assessment.employeeId));
    const employeesWithGap = new Set(withGap.map((row) => row.assessment.employeeId));

    const group = <T extends string>(rows: typeof gapRows, key: (row: (typeof gapRows)[number]) => T) => {
      const map = new Map<T, { assessed: Set<string>; withGap: Set<string>; gapItems: number }>();
      for (const row of rows) {
        const k = key(row);
        if (!map.has(k)) map.set(k, { assessed: new Set(), withGap: new Set(), gapItems: 0 });
        const bucket = map.get(k)!;
        bucket.assessed.add(row.assessment.employeeId);
        if (row.gap > 0) { bucket.withGap.add(row.assessment.employeeId); bucket.gapItems += 1; }
      }
      return map;
    };

    const byCompetency = new Map<string, { code: string; name: string; assessed: number; below: number; gapSum: number; maxGap: number }>();
    for (const row of gapRows) {
      const key = row.competencyId ?? row.competencyCodeSnapshot;
      if (!byCompetency.has(key)) byCompetency.set(key, { code: row.competencyCodeSnapshot, name: row.competencyNameSnapshot, assessed: 0, below: 0, gapSum: 0, maxGap: 0 });
      const bucket = byCompetency.get(key)!;
      bucket.assessed += 1;
      if (row.gap > 0) {
        bucket.below += 1;
        bucket.gapSum += row.gap;
        bucket.maxGap = Math.max(bucket.maxGap, row.gap);
      }
    }

    const departments = group(gapRows, (row) => row.assessment.departmentName ?? 'Unassigned');
    const jobs = group(gapRows, (row) => row.assessment.jobTitle ?? 'Unassigned');
    const average = (sum: number, count: number) => (count === 0 ? null : (sum / count).toFixed(2));

    // Task 47 (T44-P1-05/07): gap figures describe people's assessed levels. Groups of fewer than K people are
    // withheld; a department / job filter is released only if that cell survives complementary suppression across the
    // unfiltered population's departments / jobs; inside the result, the department and job rows get the same rule.
    const K = MIN_AGGREGATE_GROUP_SIZE;
    const base: Prisma.CompetencyAssessmentWhereInput = { cycleId: q.cycleId, organizationId: q.organizationId, status: 'FINALIZED', items: { some: { finalLevel: { not: null }, competencyId: q.competencyId } } };
    const filterReleased = async (dim: 'departmentId' | 'jobId', value: string | undefined) => {
      if (!value) return null;
      const people = await prisma.competencyAssessment.findMany({ where: base, select: { employeeId: true, departmentId: true, jobId: true } });
      const cells = new Map<string, Set<string>>();
      for (const p of people) { const k = String(p[dim] ?? ''); cells.set(k, (cells.get(k) ?? new Set()).add(p.employeeId)); }
      const hidden = partitionSuppression([...cells.entries()].map(([key, set]) => ({ key, count: set.size })), K);
      const r = hidden.get(value);
      return r ? suppressedCell(K, r) : null;
    };
    const overall: AggregateSuppression | null =
      employeesAssessed.size > 0 && employeesAssessed.size < K ? suppressedCell(K)
        : (await filterReleased('departmentId', q.departmentId)) ?? (await filterReleased('jobId', q.jobId));
    const rowsSuppressed = (m: Map<string, { assessed: Set<string> }>) => partitionSuppression([...m.entries()].map(([key, b]) => ({ key, count: b.assessed.size })), K);
    const deptHidden = rowsSuppressed(departments);
    const jobHidden = rowsSuppressed(jobs);
    const cell = (hidden: Map<string, AggregateSuppression['reason']>, key: string) => overall ?? (hidden.get(key) ? suppressedCell(K, hidden.get(key)!) : null);

    return {
      coverage: { assigned, selfSubmitted, finalized, coveragePercent: assigned === 0 ? 0 : Math.round((finalized / assigned) * 100) },
      suppression: overall,
      totals: {
        employeesAssessed: employeesAssessed.size,
        competenciesAssessed: gapRows.length,
        employeesWithGap: overall ? null : employeesWithGap.size,
        gapItems: overall ? null : withGap.length,
        averageGapNeeded: overall ? null : average(withGap.reduce((sum, row) => sum + row.gap, 0), withGap.length),
      },
      topGaps: [...byCompetency.entries()]
        .map(([competencyId, bucket]) => {
          const suppression = overall ?? (bucket.assessed > 0 && bucket.assessed < K ? suppressedCell(K) : null);
          return {
            competencyId,
            competencyCode: bucket.code,
            competencyName: bucket.name,
            assessed: bucket.assessed,
            belowRequirement: suppression ? null : bucket.below,
            averageGap: suppression ? null : average(bucket.gapSum, bucket.below),
            maxGap: suppression || bucket.below === 0 ? null : bucket.maxGap,
            suppression,
          };
        })
        .sort((a, b) => (b.belowRequirement ?? -1) - (a.belowRequirement ?? -1) || a.competencyCode.localeCompare(b.competencyCode)),
      byDepartment: [...departments.entries()]
        .map(([departmentName, bucket]) => { const suppression = cell(deptHidden, departmentName); return { departmentName, assessed: bucket.assessed.size, withGap: suppression ? null : bucket.withGap.size, gapItems: suppression ? null : bucket.gapItems, suppression }; })
        .sort((a, b) => a.departmentName.localeCompare(b.departmentName)),
      byJob: [...jobs.entries()]
        .map(([jobTitle, bucket]) => { const suppression = cell(jobHidden, jobTitle); return { jobTitle, assessed: bucket.assessed.size, withGap: suppression ? null : bucket.withGap.size, gapItems: suppression ? null : bucket.gapItems, suppression }; })
        .sort((a, b) => a.jobTitle.localeCompare(b.jobTitle)),
    };
  },
};
