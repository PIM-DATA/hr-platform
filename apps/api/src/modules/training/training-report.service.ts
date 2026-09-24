import { completionRate, trainingHours, type MyDevelopmentDto, type TeamDevelopmentDto, type TrainingReportDto, type TrainingReportQuery } from '@hr/shared';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { employeeScopeWhere } from '../employees/employees.scope';
import type { AuthContext } from '../auth/auth.types';
import { enrollmentInclude, toEnrollmentDto } from './enrollment.service';

/**
 * Training and development reporting.
 *
 * Two definitions are stated rather than implied, because every number below rests on them:
 *
 * - **Completion rate** = completed ÷ (completed + failed + no-show). Cancelled enrolments are excluded — a session
 *   that was called off says nothing about whether training works — and people still enrolled have not finished.
 * - **Training hours** come from the course's own duration and count only enrolments that were **attended or
 *   completed**. Somebody who was booked and never turned up did not spend the hours.
 *
 * Nothing here reports that a skill improved. No competency was reassessed, so there is no evidence for it, and a
 * number that looks like proof would be worse than no number at all.
 */
export const trainingReportService = {
  async report(q: TrainingReportQuery): Promise<TrainingReportDto> {
    const where: Prisma.TrainingEnrollmentWhereInput = {
      ...(q.courseId ? { session: { courseId: q.courseId } } : {}),
      ...(q.departmentId ? { employee: { departmentId: q.departmentId } } : {}),
      ...(q.from || q.to
        ? {
            session: {
              ...(q.courseId ? { courseId: q.courseId } : {}),
              ...(q.from ? { startAt: { gte: new Date(`${q.from}T00:00:00.000Z`) } } : {}),
              ...(q.to ? { endAt: { lte: new Date(`${q.to}T23:59:59.999Z`) } } : {}),
            },
          }
        : {}),
    };

    const rows = await prisma.trainingEnrollment.findMany({
      where,
      select: {
        status: true,
        departmentNameSnapshot: true,
        session: { select: { courseId: true, courseCodeSnapshot: true, courseTitleSnapshot: true, course: { select: { durationMinutes: true, deliveryMethod: true, competencies: { select: { competency: { select: { code: true } } } } } } } },
      },
    });

    const count = (status: string) => rows.filter((row) => row.status === status).length;
    const counts = { completed: count('COMPLETED'), failed: count('FAILED'), noShow: count('NO_SHOW') };
    const hoursOf = (subset: typeof rows) =>
      trainingHours(subset.map((row) => ({ status: row.status as never, durationMinutes: row.session.course.durationMinutes })));

    const group = <T extends string>(key: (row: (typeof rows)[number]) => T) => {
      const map = new Map<T, typeof rows>();
      for (const row of rows) map.set(key(row), [...(map.get(key(row)) ?? []), row]);
      return map;
    };
    const byDepartment = group((row) => row.departmentNameSnapshot ?? 'Unassigned');
    const byCourse = group((row) => row.session.courseId);
    const byDelivery = group((row) => row.session.course.deliveryMethod);

    const [needRows, idpRows] = await Promise.all([
      prisma.trainingNeed.groupBy({ by: ['status', 'source'], where: q.departmentId ? { departmentId: q.departmentId } : {}, _count: { _all: true }, orderBy: { status: 'asc' } }),
      prisma.individualDevelopmentPlan.groupBy({ by: ['status'], where: q.departmentId ? { employee: { departmentId: q.departmentId } } : {}, _count: { _all: true }, orderBy: { status: 'asc' } }),
    ]);
    const needCount = (status: string) => needRows.filter((r) => r.status === status).reduce((sum, r) => sum + r._count._all, 0);
    const idpCount = (status: string) => idpRows.find((r) => r.status === status)?._count._all ?? 0;

    const topNeeds = await prisma.trainingNeed.groupBy({
      by: ['competencyCodeSnapshot', 'competencyNameSnapshot'],
      where: { competencyId: { not: null }, status: { in: ['OPEN', 'PLANNED', 'IN_PROGRESS'] }, ...(q.departmentId ? { departmentId: q.departmentId } : {}) },
      _count: { _all: true },
      orderBy: { _count: { competencyCodeSnapshot: 'desc' } },
      take: 10,
    });

    return {
      enrollments: {
        total: rows.length,
        completed: counts.completed,
        failed: counts.failed,
        noShow: counts.noShow,
        cancelled: count('CANCELLED'),
        enrolled: count('ENROLLED') + count('ATTENDED'),
      },
      completionRate: completionRate(counts),
      trainingHours: hoursOf(rows),
      byDepartment: [...byDepartment.entries()]
        .map(([departmentName, subset]) => ({
          departmentName,
          enrollments: subset.length,
          completed: subset.filter((r) => r.status === 'COMPLETED').length,
          noShow: subset.filter((r) => r.status === 'NO_SHOW').length,
          hours: hoursOf(subset),
        }))
        .sort((a, b) => a.departmentName.localeCompare(b.departmentName)),
      byCourse: [...byCourse.entries()]
        .map(([courseId, subset]) => ({
          courseId,
          courseCode: subset[0].session.courseCodeSnapshot,
          courseTitle: subset[0].session.courseTitleSnapshot,
          enrollments: subset.length,
          completed: subset.filter((r) => r.status === 'COMPLETED').length,
          // Which competencies the course is relevant to — not a claim that any of them improved.
          competencies: subset[0].session.course.competencies.map((c) => c.competency.code),
        }))
        .sort((a, b) => b.enrollments - a.enrollments),
      byDeliveryMethod: [...byDelivery.entries()]
        .map(([deliveryMethod, subset]) => ({
          deliveryMethod,
          enrollments: subset.length,
          completed: subset.filter((r) => r.status === 'COMPLETED').length,
          hours: hoursOf(subset),
        }))
        .sort((a, b) => a.deliveryMethod.localeCompare(b.deliveryMethod)),
      needs: {
        open: needCount('OPEN'),
        planned: needCount('PLANNED'),
        inProgress: needCount('IN_PROGRESS'),
        fulfilled: needCount('FULFILLED'),
        cancelled: needCount('CANCELLED'),
        fromGap: needRows.filter((r) => r.source === 'COMPETENCY_GAP').reduce((sum, r) => sum + r._count._all, 0),
        manual: needRows.filter((r) => r.source === 'MANUAL').reduce((sum, r) => sum + r._count._all, 0),
      },
      topNeedCompetencies: topNeeds
        .filter((row) => !!row.competencyCodeSnapshot)
        .map((row) => ({ competencyCode: row.competencyCodeSnapshot!, competencyName: row.competencyNameSnapshot ?? row.competencyCodeSnapshot!, needs: row._count._all })),
      idps: { draft: idpCount('DRAFT'), active: idpCount('ACTIVE'), completed: idpCount('COMPLETED'), cancelled: idpCount('CANCELLED') },
    };
  },

  /** Everything an employee sees about their own development, in one call. */
  async myDevelopment(employeeId: string): Promise<MyDevelopmentDto> {
    const now = new Date();
    const [needs, enrollments, idps] = await Promise.all([
      prisma.trainingNeed.findMany({
        where: { employeeId, status: { in: ['OPEN', 'PLANNED', 'IN_PROGRESS'] } },
        include: {
          employee: { select: { id: true, employeeCode: true, firstName: true, lastName: true } },
          competency: { select: { id: true, code: true, name: true } },
          enrollments: { select: { id: true, sessionId: true, status: true, session: { select: { courseTitleSnapshot: true } } }, orderBy: { createdAt: 'desc' } },
        },
        orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
      }),
      prisma.trainingEnrollment.findMany({ where: { employeeId }, include: enrollmentInclude, orderBy: { session: { startAt: 'desc' } } }),
      prisma.individualDevelopmentPlan.findMany({
        where: { employeeId },
        include: { employee: { select: { id: true, employeeCode: true, firstName: true, lastName: true } }, items: { include: { competency: { select: { id: true, code: true, name: true } }, linkedCourse: { select: { id: true, code: true, title: true } } } } },
        orderBy: { periodStart: 'desc' },
      }),
    ]);

    const dtos = enrollments.map(toEnrollmentDto);
    const upcoming = dtos.filter((e) => e.status === 'ENROLLED' && new Date(e.session.endAt) >= now);
    const history = dtos.filter((e) => !upcoming.some((u) => u.id === e.id));

    return {
      needs: needs.map((row) => ({
        id: row.id,
        employee: { id: row.employee.id, employeeCode: row.employeeCodeSnapshot, firstName: row.employee.firstName, lastName: row.employee.lastName },
        snapshot: { departmentName: row.departmentNameSnapshot, jobTitle: row.jobTitleSnapshot },
        source: row.source as 'COMPETENCY_GAP' | 'MANUAL',
        title: row.title,
        description: row.description,
        competency: row.competency,
        gapSnapshot: row.source === 'COMPETENCY_GAP' ? { currentLevel: row.currentLevelSnapshot, requiredLevel: row.requiredLevelSnapshot, gap: row.gapSnapshot } : null,
        sourceAssessmentDate: row.sourceAssessmentDate?.toISOString() ?? null,
        priority: row.priority as 'NORMAL' | 'HIGH',
        status: row.status as 'OPEN' | 'PLANNED' | 'IN_PROGRESS' | 'FULFILLED' | 'CANCELLED',
        currentGapStatus: null,
        enrollments: row.enrollments.map((e) => ({ id: e.id, sessionId: e.sessionId, courseTitle: e.session.courseTitleSnapshot, status: e.status })),
        createdAt: row.createdAt.toISOString(),
      })),
      upcoming,
      history,
      idps: idps.map((row) => {
        const active = row.items.filter((item) => item.status !== 'CANCELLED');
        return {
          id: row.id,
          employee: { id: row.employee.id, employeeCode: row.employeeCodeSnapshot, firstName: row.employee.firstName, lastName: row.employee.lastName, departmentName: row.departmentNameSnapshot },
          title: row.title,
          periodStart: row.periodStart,
          periodEnd: row.periodEnd,
          status: row.status as 'DRAFT' | 'ACTIVE' | 'COMPLETED' | 'CANCELLED',
          manager: { employeeId: row.managerEmployeeId, name: row.managerNameSnapshot },
          itemCount: active.length,
          completedItemCount: active.filter((item) => item.status === 'COMPLETED').length,
          progressPercent: active.length === 0 ? 0 : Math.round(active.reduce((sum, item) => sum + (item.status === 'COMPLETED' ? 100 : item.progressPercent), 0) / active.length),
          activatedAt: row.activatedAt?.toISOString() ?? null,
          completedAt: row.completedAt?.toISOString() ?? null,
        };
      }),
      summary: {
        openNeeds: needs.length,
        upcomingSessions: upcoming.length,
        completedCourses: dtos.filter((e) => e.status === 'COMPLETED').length,
        trainingHours: trainingHours(enrollments.map((row) => ({ status: row.status as never, durationMinutes: row.session.course.durationMinutes }))),
      },
    };
  },

  /**
   * A manager's team summary: counts, not contents. Who has open needs and an active plan is a management view;
   * what their plan says is not, and nothing in this shape leaks a comment or a result.
   */
  async teamDevelopment(auth: AuthContext): Promise<TeamDevelopmentDto> {
    const team = await prisma.employee.findMany({
      where: { AND: [employeeScopeWhere(auth), { employmentStatus: 'ACTIVE' }] },
      select: { id: true, employeeCode: true, firstName: true, lastName: true },
      orderBy: { employeeCode: 'asc' },
      take: 200,
    });
    const ids = team.map((member) => member.id);
    if (ids.length === 0) return { teamSize: 0, openNeeds: 0, activeIdps: 0, upcomingSessions: 0, completedTraining: 0, members: [] };

    const now = new Date();
    const [needs, idps, enrollments] = await Promise.all([
      prisma.trainingNeed.groupBy({ by: ['employeeId'], where: { employeeId: { in: ids }, status: { in: ['OPEN', 'PLANNED', 'IN_PROGRESS'] } }, _count: { _all: true }, orderBy: { employeeId: 'asc' } }),
      prisma.individualDevelopmentPlan.findMany({ where: { employeeId: { in: ids }, status: 'ACTIVE' }, select: { employeeId: true } }),
      prisma.trainingEnrollment.findMany({ where: { employeeId: { in: ids } }, select: { employeeId: true, status: true, session: { select: { endAt: true } } } }),
    ]);

    const needsBy = new Map(needs.map((row) => [row.employeeId, row._count._all]));
    const activeIdp = new Set(idps.map((row) => row.employeeId));
    const upcomingBy = new Map<string, number>();
    const completedBy = new Map<string, number>();
    for (const row of enrollments) {
      if (row.status === 'ENROLLED' && row.session.endAt >= now) upcomingBy.set(row.employeeId, (upcomingBy.get(row.employeeId) ?? 0) + 1);
      if (row.status === 'COMPLETED') completedBy.set(row.employeeId, (completedBy.get(row.employeeId) ?? 0) + 1);
    }

    const members = team.map((member) => ({
      employeeId: member.id,
      employeeCode: member.employeeCode,
      name: `${member.firstName} ${member.lastName}`,
      openNeeds: needsBy.get(member.id) ?? 0,
      activeIdp: activeIdp.has(member.id),
      upcoming: upcomingBy.get(member.id) ?? 0,
      completed: completedBy.get(member.id) ?? 0,
    }));

    return {
      teamSize: members.length,
      openNeeds: members.reduce((sum, member) => sum + member.openNeeds, 0),
      activeIdps: members.filter((member) => member.activeIdp).length,
      upcomingSessions: members.reduce((sum, member) => sum + member.upcoming, 0),
      completedTraining: members.reduce((sum, member) => sum + member.completed, 0),
      members,
    };
  },
};
