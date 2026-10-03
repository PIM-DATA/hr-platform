import {
  AUDIT_ACTIONS,
  type CourseDto, type CourseListQuery, type CreateCourseInput, type CreateSessionInput, type SessionDto,
  type SessionListQuery, type UpdateCourseInput, type UpdateSessionInput,
} from '@hr/shared';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { AppError } from '../../lib/errors';
import { auditService } from '../../services/audit/audit.service';
import { addDays, businessDayStart } from '@hr/shared';
import { referenceZone } from '../../services/business-time/business-time';
import { trainingAudit, type Actor, type Db } from './training.types';

/**
 * The course catalogue and the sessions that run it.
 *
 * A course records that something exists, roughly how long it takes and **which competencies it is relevant to
 * developing**. That last part is a pointer for whoever is choosing a course, not a promise: finishing a course does
 * not set anybody's level, and the mapping deliberately carries no authority to.
 *
 * A session freezes the course's code and title, so a catalogue tidy-up next year never makes an old training record
 * unreadable. Instants are UTC and the session carries its own IANA timezone — nothing here assumes an offset.
 */
const courseInclude = {
  competencies: { include: { competency: { select: { id: true, code: true, name: true } } } },
  _count: { select: { sessions: true } },
} satisfies Prisma.TrainingCourseInclude;
type CourseRow = Prisma.TrainingCourseGetPayload<{ include: typeof courseInclude }>;

const toCourseDto = (row: CourseRow): CourseDto => ({
  id: row.id,
  code: row.code,
  title: row.title,
  description: row.description,
  category: row.category,
  deliveryMethod: row.deliveryMethod as CourseDto['deliveryMethod'],
  durationMinutes: row.durationMinutes,
  providerName: row.providerName,
  providerType: row.providerType as CourseDto['providerType'],
  competencies: row.competencies.map((c) => c.competency),
  isActive: row.isActive,
  sessionCount: row._count.sessions,
});

export const courseService = {
  async list(q: CourseListQuery): Promise<{ data: CourseDto[]; meta: { page: number; pageSize: number; total: number } }> {
    const where: Prisma.TrainingCourseWhereInput = {
      category: q.category,
      deliveryMethod: q.deliveryMethod,
      ...(q.competencyId ? { competencies: { some: { competencyId: q.competencyId } } } : {}),
      ...(q.status ? { isActive: q.status === 'active' } : {}),
      ...(q.search ? { OR: [{ code: { contains: q.search, mode: 'insensitive' } }, { title: { contains: q.search, mode: 'insensitive' } }] } : {}),
    };
    const [total, rows] = await prisma.$transaction([
      prisma.trainingCourse.count({ where }),
      prisma.trainingCourse.findMany({ where, include: courseInclude, orderBy: [{ code: 'asc' }], skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
    ]);
    return { data: rows.map(toCourseDto), meta: { page: q.page, pageSize: q.pageSize, total } };
  },

  async get(id: string): Promise<CourseDto> {
    const row = await prisma.trainingCourse.findUnique({ where: { id }, include: courseInclude });
    if (!row) throw new AppError(404, 'TRAINING_COURSE_NOT_FOUND', 'Course not found');
    return toCourseDto(row);
  },

  async create(input: CreateCourseInput, actor: Actor): Promise<CourseDto> {
    const duplicate = await prisma.trainingCourse.findUnique({ where: { code: input.code }, select: { id: true } });
    if (duplicate) throw new AppError(409, 'TRAINING_COURSE_CODE_TAKEN', `A course with the code ${input.code} already exists`);
    const row = await prisma.$transaction(async (tx) => {
      await assertCompetenciesExist(tx, input.competencyIds);
      const created = await tx.trainingCourse.create({
        data: {
          code: input.code, title: input.title, description: input.description ?? null, category: input.category ?? null,
          deliveryMethod: input.deliveryMethod, durationMinutes: input.durationMinutes ?? null,
          providerName: input.providerName ?? null, providerType: input.providerType,
          createdByUserId: actor.auth.userId,
          competencies: { create: input.competencyIds.map((competencyId) => ({ competencyId })) },
        },
        include: courseInclude,
      });
      await auditService.log(trainingAudit(actor, AUDIT_ACTIONS.CREATE_TRAINING_COURSE, 'TrainingCourse', created.id, {
        code: created.code, title: created.title, deliveryMethod: created.deliveryMethod, competencies: input.competencyIds.length,
      }), tx);
      return created;
    });
    return toCourseDto(row);
  },

  async update(id: string, input: UpdateCourseInput, actor: Actor): Promise<CourseDto> {
    const row = await prisma.$transaction(async (tx) => {
      const before = await tx.trainingCourse.findUnique({ where: { id }, include: courseInclude });
      if (!before) throw new AppError(404, 'TRAINING_COURSE_NOT_FOUND', 'Course not found');
      if (input.competencyIds) {
        await assertCompetenciesExist(tx, input.competencyIds);
        await tx.trainingCourseCompetency.deleteMany({ where: { courseId: id } });
        await tx.trainingCourseCompetency.createMany({ data: input.competencyIds.map((competencyId) => ({ courseId: id, competencyId })) });
      }
      const after = await tx.trainingCourse.update({
        where: { id },
        data: {
          title: input.title, description: input.description, category: input.category,
          durationMinutes: input.durationMinutes, providerName: input.providerName, providerType: input.providerType,
          isActive: input.isActive,
        },
        include: courseInclude,
      });
      await auditService.log(trainingAudit(actor, AUDIT_ACTIONS.UPDATE_TRAINING_COURSE, 'TrainingCourse', id,
        { title: after.title, isActive: after.isActive, competencies: after.competencies.length },
        { title: before.title, isActive: before.isActive, competencies: before.competencies.length }), tx);
      return after;
    });
    return toCourseDto(row);
  },

  /** Courses relevant to a competency — what a training need offers as suggestions. Deterministic, never ranked. */
  async suggestionsFor(competencyId: string): Promise<CourseDto[]> {
    const rows = await prisma.trainingCourse.findMany({
      where: { isActive: true, competencies: { some: { competencyId } } },
      include: courseInclude,
      orderBy: { code: 'asc' },
      take: 20,
    });
    return rows.map(toCourseDto);
  },
};

async function assertCompetenciesExist(db: Db, ids: string[]) {
  if (ids.length === 0) return;
  const found = await db.competency.count({ where: { id: { in: ids } } });
  if (found !== new Set(ids).size) throw new AppError(404, 'COMPETENCY_NOT_FOUND', 'One of those competencies does not exist');
}

// ---------------------------------------------------------------------------
// sessions
// ---------------------------------------------------------------------------
const sessionInclude = {
  course: { select: { id: true, code: true, title: true, deliveryMethod: true, durationMinutes: true } },
  organization: { select: { id: true, code: true, name: true } },
  _count: { select: { enrollments: true } },
} satisfies Prisma.TrainingSessionInclude;
type SessionRow = Prisma.TrainingSessionGetPayload<{ include: typeof sessionInclude }>;

/** Seats taken are the enrolments that still hold one: a cancelled place is free again. */
async function activeEnrollmentCount(db: Db, sessionId: string) {
  return db.trainingEnrollment.count({ where: { sessionId, status: { not: 'CANCELLED' } } });
}

const toSessionDto = (row: SessionRow, enrolledCount: number): SessionDto => ({
  id: row.id,
  course: row.course,
  organization: row.organization,
  startAt: row.startAt.toISOString(),
  endAt: row.endAt.toISOString(),
  timezone: row.timezone,
  location: row.location,
  meetingUrl: row.meetingUrl,
  capacity: row.capacity,
  instructorName: row.instructorName,
  status: row.status as SessionDto['status'],
  enrolledCount,
  seatsLeft: row.capacity === null ? null : Math.max(0, row.capacity - enrolledCount),
});

export const sessionService = {
  async list(q: SessionListQuery): Promise<{ data: SessionDto[]; meta: { page: number; pageSize: number; total: number } }> {
    const zone = q.from || q.to ? await referenceZone(prisma) : 'UTC'; // Task 53: business days in the reference organization's zone
    const where: Prisma.TrainingSessionWhereInput = {
      courseId: q.courseId,
      status: q.status,
      ...(q.from ? { startAt: { gte: businessDayStart(q.from, zone) } } : {}),
      ...(q.to ? { endAt: { lt: businessDayStart(addDays(q.to, 1), zone) } } : {}),
      ...(q.search ? { courseTitleSnapshot: { contains: q.search, mode: 'insensitive' } } : {}),
    };
    const [total, rows] = await prisma.$transaction([
      prisma.trainingSession.count({ where }),
      prisma.trainingSession.findMany({ where, include: sessionInclude, orderBy: { startAt: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
    ]);
    // The active count differs from the raw relation count when places have been cancelled.
    const counts = await prisma.trainingEnrollment.groupBy({
      by: ['sessionId'],
      where: { sessionId: { in: rows.map((r) => r.id) }, status: { not: 'CANCELLED' } },
      _count: { _all: true },
    });
    const byId = new Map(counts.map((c) => [c.sessionId, c._count._all]));
    return { data: rows.map((row) => toSessionDto(row, byId.get(row.id) ?? 0)), meta: { page: q.page, pageSize: q.pageSize, total } };
  },

  async get(id: string): Promise<SessionDto> {
    const row = await prisma.trainingSession.findUnique({ where: { id }, include: sessionInclude });
    if (!row) throw new AppError(404, 'TRAINING_SESSION_NOT_FOUND', 'Session not found');
    return toSessionDto(row, await activeEnrollmentCount(prisma, id));
  },

  async create(input: CreateSessionInput, actor: Actor): Promise<SessionDto> {
    const row = await prisma.$transaction(async (tx) => {
      const course = await tx.trainingCourse.findUnique({ where: { id: input.courseId }, select: { id: true, code: true, title: true, isActive: true } });
      if (!course) throw new AppError(404, 'TRAINING_COURSE_NOT_FOUND', 'Course not found');
      // A retired course keeps its history but takes no new bookings.
      if (!course.isActive) throw new AppError(409, 'TRAINING_COURSE_INACTIVE', `${course.code} is inactive, so no new session can be scheduled from it`);

      const created = await tx.trainingSession.create({
        data: {
          courseId: course.id,
          courseCodeSnapshot: course.code,
          courseTitleSnapshot: course.title,
          organizationId: input.organizationId ?? null,
          startAt: new Date(input.startAt),
          endAt: new Date(input.endAt),
          timezone: input.timezone,
          location: input.location ?? null,
          meetingUrl: input.meetingUrl ?? null,
          capacity: input.capacity ?? null,
          instructorName: input.instructorName ?? null,
          status: 'DRAFT',
          createdByUserId: actor.auth.userId,
        },
        include: sessionInclude,
      });
      await auditService.log(trainingAudit(actor, AUDIT_ACTIONS.CREATE_TRAINING_SESSION, 'TrainingSession', created.id, {
        course: course.code, startAt: created.startAt.toISOString(), timezone: created.timezone, capacity: created.capacity,
      }), tx);
      return created;
    });
    return toSessionDto(row, 0);
  },

  async update(id: string, input: UpdateSessionInput, actor: Actor): Promise<SessionDto> {
    const row = await prisma.$transaction(async (tx) => {
      const before = await tx.trainingSession.findUnique({ where: { id }, include: sessionInclude });
      if (!before) throw new AppError(404, 'TRAINING_SESSION_NOT_FOUND', 'Session not found');
      if (['COMPLETED', 'CANCELLED'].includes(before.status)) {
        throw new AppError(409, 'TRAINING_SESSION_FINISHED', `This session is ${before.status.toLowerCase()} and can no longer be changed`);
      }
      const startAt = input.startAt ? new Date(input.startAt) : before.startAt;
      const endAt = input.endAt ? new Date(input.endAt) : before.endAt;
      if (startAt >= endAt) throw new AppError(422, 'TRAINING_SESSION_DATES_INVALID', 'The session ends before it starts');
      if (input.capacity !== undefined && input.capacity !== null) {
        const taken = await activeEnrollmentCount(tx, id);
        if (input.capacity < taken) throw new AppError(409, 'TRAINING_SESSION_CAPACITY_BELOW_ENROLLED', `${taken} people are already booked on this session`);
      }

      const after = await tx.trainingSession.update({
        where: { id },
        data: {
          startAt: input.startAt ? startAt : undefined,
          endAt: input.endAt ? endAt : undefined,
          timezone: input.timezone,
          location: input.location,
          meetingUrl: input.meetingUrl,
          capacity: input.capacity,
          instructorName: input.instructorName,
        },
        include: sessionInclude,
      });
      await auditService.log(trainingAudit(actor, AUDIT_ACTIONS.UPDATE_TRAINING_SESSION, 'TrainingSession', id,
        { startAt: after.startAt.toISOString(), capacity: after.capacity, location: after.location },
        { startAt: before.startAt.toISOString(), capacity: before.capacity, location: before.location }), tx);
      return after;
    });
    return toSessionDto(row, await activeEnrollmentCount(prisma, id));
  },
};

export { activeEnrollmentCount, sessionInclude, toSessionDto };
