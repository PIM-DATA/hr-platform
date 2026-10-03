import {
  AUDIT_ACTIONS, NOTIFICATION_TYPES, PERMISSIONS, TRAINING_ENROLLMENT_TERMINAL, fulfilsNeed,
  type EnrollInput, type EnrollResultDto, type EnrollmentDto, type EnrollmentListQuery, type RecordAttendanceInput,
  type RecordResultInput, type SessionDto,
} from '@hr/shared';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { AppError } from '../../lib/errors';
import { auditService } from '../../services/audit/audit.service';
import { notificationService } from '../../services/notification/notification.service';
import { hasPermission } from '../../services/authorization/authorization.service';
import { employeeScopeWhere } from '../employees/employees.scope';
import type { AuthContext } from '../auth/auth.types';
import { activeEnrollmentCount, sessionInclude, toSessionDto } from './training-catalog.service';
import { businessDateIn } from '../../services/business-time/business-time';
import { trainingAudit, type Actor, type Db, type Tx } from './training.types';

/**
 * Who is on which session, whether they turned up, and what came of it.
 *
 * The rule that shapes everything here: **a session's status says nothing about any individual.** A session can be
 * complete while one attendee completed it, another failed and a third never arrived — so nothing bulk-completes
 * enrolments, and every person's outcome is recorded deliberately.
 *
 * Completing an enrolment fulfils the training need it came from, and completes the development-plan item it was
 * booked against. It does **not** move anybody's competency level: finishing Advanced SQL is evidence that
 * development happened, and whether somebody's SQL is actually better is a question only a competency assessment
 * answers. Nothing in this file writes to a competency table.
 */
const enrollmentInclude = {
  employee: { select: { id: true, employeeCode: true, firstName: true, lastName: true } },
  session: {
    select: {
      id: true, startAt: true, endAt: true, timezone: true, status: true, location: true,
      course: { select: { id: true, code: true, title: true, deliveryMethod: true, durationMinutes: true } },
    },
  },
} satisfies Prisma.TrainingEnrollmentInclude;
type EnrollmentRow = Prisma.TrainingEnrollmentGetPayload<{ include: typeof enrollmentInclude }>;

const toDto = (row: EnrollmentRow): EnrollmentDto => ({
  id: row.id,
  employee: {
    id: row.employee.id, employeeCode: row.employeeCodeSnapshot,
    firstName: row.employee.firstName, lastName: row.employee.lastName,
    departmentName: row.departmentNameSnapshot,
  },
  session: {
    id: row.session.id, startAt: row.session.startAt.toISOString(), endAt: row.session.endAt.toISOString(),
    timezone: row.session.timezone, status: row.session.status, location: row.session.location,
  },
  course: row.session.course,
  status: row.status as EnrollmentDto['status'],
  source: row.source as EnrollmentDto['source'],
  trainingNeedId: row.trainingNeedId,
  idpItemId: row.idpItemId,
  enrolledAt: row.enrolledAt.toISOString(),
  completionAt: row.completionAt?.toISOString() ?? null,
  score: row.score === null ? null : row.score.toFixed(2),
  resultNote: row.resultNote,
});

/** Every capacity decision takes this lock first, so two administrators cannot both take the last seat. */
const lockSession = async (tx: Tx, sessionId: string) => {
  await tx.$executeRaw`SELECT "id" FROM "training_sessions" WHERE "id" = ${sessionId} FOR UPDATE`;
};

export const enrollmentService = {
  /**
   * Booking people onto a session. Capacity is checked under the session's row lock, so a session with one seat
   * cannot end up with two people on it however simultaneous the requests are.
   *
   * Already-booked people are counted rather than failed — re-running an enrolment after adding names is normal.
   */
  async enroll(sessionId: string, input: EnrollInput, actor: Actor): Promise<EnrollResultDto> {
    return prisma.$transaction(async (tx) => {
      await lockSession(tx, sessionId);
      const session = await tx.trainingSession.findUnique({ where: { id: sessionId }, select: { id: true, status: true, capacity: true, courseTitleSnapshot: true, startAt: true, timezone: true } });
      if (!session) throw new AppError(404, 'TRAINING_SESSION_NOT_FOUND', 'Session not found');
      if (['COMPLETED', 'CANCELLED'].includes(session.status)) {
        throw new AppError(409, 'TRAINING_SESSION_FINISHED', `This session is ${session.status.toLowerCase()}`);
      }

      if (input.trainingNeedId) {
        const need = await tx.trainingNeed.findUnique({ where: { id: input.trainingNeedId }, select: { id: true, status: true } });
        if (!need) throw new AppError(404, 'TRAINING_NEED_NOT_FOUND', 'Training need not found');
      }

      const employees = await tx.employee.findMany({
        where: { id: { in: input.employeeIds } },
        select: { id: true, employeeCode: true, firstName: true, lastName: true, employmentStatus: true, department: { select: { name: true } } },
        orderBy: { employeeCode: 'asc' },
      });
      const existing = await tx.trainingEnrollment.findMany({
        where: { sessionId, employeeId: { in: input.employeeIds } },
        select: { employeeId: true, status: true },
      });
      const booked = new Map(existing.map((e) => [e.employeeId, e.status]));

      let taken = await activeEnrollmentCount(tx, sessionId);
      const skipped: EnrollResultDto['skipped'] = [];
      let enrolled = 0;
      let alreadyEnrolled = 0;

      for (const employee of employees) {
        const current = booked.get(employee.id);
        if (current && current !== 'CANCELLED') { alreadyEnrolled += 1; continue; }
        if (employee.employmentStatus !== 'ACTIVE') { skipped.push({ employeeCode: employee.employeeCode, reason: 'Not an active employee' }); continue; }
        if (session.capacity !== null && taken >= session.capacity) {
          skipped.push({ employeeCode: employee.employeeCode, reason: 'The session is full' });
          continue;
        }

        const data = {
          sessionId,
          employeeId: employee.id,
          employeeCodeSnapshot: employee.employeeCode,
          employeeNameSnapshot: `${employee.firstName} ${employee.lastName}`,
          departmentNameSnapshot: employee.department?.name ?? null,
          source: input.source,
          trainingNeedId: input.trainingNeedId ?? null,
          idpItemId: input.idpItemId ?? null,
          status: 'ENROLLED',
          enrolledAt: new Date(),
          completionAt: null,
          score: null,
          resultNote: null,
          createdByUserId: actor.auth.userId,
        };
        // Somebody who was cancelled earlier is re-booked onto the same row rather than given a second one.
        if (current === 'CANCELLED') {
          await tx.trainingEnrollment.update({ where: { sessionId_employeeId: { sessionId, employeeId: employee.id } }, data });
        } else {
          await tx.trainingEnrollment.create({ data });
        }
        taken += 1;
        enrolled += 1;

        await notificationService.publish(
          {
            userId: (await tx.user.findFirst({ where: { employeeId: employee.id }, select: { id: true } }))?.id ?? null,
            type: NOTIFICATION_TYPES.TRAINING_ENROLLED,
            source: { module: 'training', entityType: 'TRAINING_SESSION', entityId: sessionId },
            data: { sessionId },
            dedupeKey: `training:${sessionId}:${employee.id}:enrolled:${Date.now()}`,
          },
          { courseTitle: session.courseTitleSnapshot, date: businessDateIn(session.startAt, session.timezone) },
          tx,
        );
      }

      // Booking somebody against a need means the development is now planned.
      if (input.trainingNeedId && enrolled > 0) {
        await tx.trainingNeed.update({ where: { id: input.trainingNeedId }, data: { status: 'IN_PROGRESS' } });
      }
      if (input.idpItemId && enrolled > 0) {
        await tx.idpItem.update({ where: { id: input.idpItemId }, data: { status: 'IN_PROGRESS', linkedSessionId: sessionId } });
      }

      await auditService.log(trainingAudit(actor, AUDIT_ACTIONS.ENROLL_TRAINING, 'TrainingSession', sessionId, {
        course: session.courseTitleSnapshot, enrolled, alreadyEnrolled, skipped: skipped.length, source: input.source,
      }), tx);

      return { enrolled, alreadyEnrolled, skipped };
    });
  },

  async list(auth: AuthContext, q: EnrollmentListQuery): Promise<{ data: EnrollmentDto[]; meta: { page: number; pageSize: number; total: number } }> {
    const where: Prisma.TrainingEnrollmentWhereInput = {
      sessionId: q.sessionId,
      employeeId: q.employeeId,
      status: q.status,
      ...(q.search ? { employeeNameSnapshot: { contains: q.search, mode: 'insensitive' } } : {}),
    };
    if (q.view === 'all') {
      if (!hasPermission(auth, PERMISSIONS.TRAINING_MANAGE) && !hasPermission(auth, PERMISSIONS.TRAINING_ENROLL)) throw AppError.forbidden();
    } else if (q.view === 'team') {
      where.employee = employeeScopeWhere(auth);
    } else {
      if (!auth.employeeId) return { data: [], meta: { page: q.page, pageSize: q.pageSize, total: 0 } };
      where.employeeId = auth.employeeId;
    }
    const [total, rows] = await prisma.$transaction([
      prisma.trainingEnrollment.count({ where }),
      prisma.trainingEnrollment.findMany({ where, include: enrollmentInclude, orderBy: [{ session: { startAt: 'desc' } }, { employeeCodeSnapshot: 'asc' }], skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
    ]);
    return { data: rows.map(toDto), meta: { page: q.page, pageSize: q.pageSize, total } };
  },

  /** Attendance: did they turn up. Not the work-attendance module — a different thing entirely. */
  async recordAttendance(id: string, input: RecordAttendanceInput, actor: Actor): Promise<EnrollmentDto> {
    const row = await prisma.$transaction(async (tx) => {
      const enrollment = await loadForUpdate(tx, id);
      assertNotTerminal(enrollment.status);
      const after = await tx.trainingEnrollment.update({
        where: { id },
        data: { status: input.status, resultNote: input.note ?? undefined, completionAt: input.status === 'NO_SHOW' ? new Date() : null },
        include: enrollmentInclude,
      });
      // Not turning up leaves the need where it was: the development has not happened.
      await auditService.log(trainingAudit(actor, AUDIT_ACTIONS.RECORD_TRAINING_ATTENDANCE, 'TrainingEnrollment', id, {
        employee: enrollment.employeeCodeSnapshot, course: enrollment.session.courseTitleSnapshot, status: input.status,
      }, { status: enrollment.status }), tx);
      return after;
    });
    return toDto(row);
  },

  /**
   * The result. Completing fulfils the linked need and the linked plan item; failing does neither, and the person
   * can be booked onto another session.
   */
  async recordResult(id: string, input: RecordResultInput, actor: Actor): Promise<EnrollmentDto> {
    const row = await prisma.$transaction(async (tx) => {
      const enrollment = await loadForUpdate(tx, id);
      assertNotTerminal(enrollment.status);

      const after = await tx.trainingEnrollment.update({
        where: { id },
        data: {
          status: input.status,
          score: input.score === undefined || input.score === null ? null : new Prisma.Decimal(input.score),
          resultNote: input.resultNote ?? undefined,
          completionAt: new Date(),
        },
        include: enrollmentInclude,
      });

      if (fulfilsNeed(input.status)) {
        if (enrollment.trainingNeedId) {
          await tx.trainingNeed.update({ where: { id: enrollment.trainingNeedId }, data: { status: 'FULFILLED', fulfilledAt: new Date() } });
        }
        if (enrollment.idpItemId) {
          await tx.idpItem.update({ where: { id: enrollment.idpItemId }, data: { status: 'COMPLETED', progressPercent: 100, completedAt: new Date() } });
        }
      }

      await auditService.log(trainingAudit(actor, AUDIT_ACTIONS.RECORD_TRAINING_RESULT, 'TrainingEnrollment', id, {
        employee: enrollment.employeeCodeSnapshot, course: enrollment.session.courseTitleSnapshot, status: input.status,
        score: input.score ?? null, needFulfilled: fulfilsNeed(input.status) && !!enrollment.trainingNeedId,
      }, { status: enrollment.status }), tx);

      await notificationService.publish(
        {
          userId: (await tx.user.findFirst({ where: { employeeId: enrollment.employeeId }, select: { id: true } }))?.id ?? null,
          type: NOTIFICATION_TYPES.TRAINING_COMPLETED,
          source: { module: 'training', entityType: 'TRAINING_ENROLLMENT', entityId: id },
          data: { enrollmentId: id, sessionId: enrollment.sessionId },
          dedupeKey: `training:${id}:result`,
        },
        { courseTitle: enrollment.session.courseTitleSnapshot },
        tx,
      );
      return after;
    });
    return toDto(row);
  },

  /** Cancelling a place. The row stays — a training record is history — and the need goes back to being planned. */
  async cancel(id: string, actor: Actor): Promise<EnrollmentDto> {
    const row = await prisma.$transaction(async (tx) => {
      const enrollment = await loadForUpdate(tx, id);
      if (enrollment.status === 'CANCELLED') throw new AppError(409, 'TRAINING_ENROLLMENT_CANCELLED', 'This place is already cancelled');
      if (['COMPLETED', 'FAILED', 'NO_SHOW'].includes(enrollment.status)) {
        throw new AppError(409, 'TRAINING_ENROLLMENT_FINISHED', 'This training has already been recorded and cannot be cancelled');
      }
      const after = await tx.trainingEnrollment.update({ where: { id }, data: { status: 'CANCELLED', completionAt: null }, include: enrollmentInclude });
      if (enrollment.trainingNeedId) await revertNeed(tx, enrollment.trainingNeedId);
      if (enrollment.idpItemId) await tx.idpItem.update({ where: { id: enrollment.idpItemId }, data: { status: 'PLANNED', linkedSessionId: null } });
      await auditService.log(trainingAudit(actor, AUDIT_ACTIONS.CANCEL_TRAINING_ENROLLMENT, 'TrainingEnrollment', id, {
        employee: enrollment.employeeCodeSnapshot, course: enrollment.session.courseTitleSnapshot,
      }, { status: enrollment.status }), tx);
      return after;
    });
    return toDto(row);
  },
};

/**
 * Session state changes that reach across to everybody on it.
 *
 * Cancelling is the one that has to be atomic: every place is cancelled, every need that was waiting on it goes back
 * to planned, every plan item is un-linked, and everybody is told — all or nothing.
 */
export const sessionLifecycleService = {
  async transition(sessionId: string, to: 'OPEN' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED', actor: Actor): Promise<SessionDto> {
    const allowed: Record<string, string[]> = {
      OPEN: ['DRAFT'],
      IN_PROGRESS: ['OPEN'],
      COMPLETED: ['OPEN', 'IN_PROGRESS'],
      CANCELLED: ['DRAFT', 'OPEN', 'IN_PROGRESS'],
    };
    const row = await prisma.$transaction(async (tx) => {
      await lockSession(tx, sessionId);
      const session = await tx.trainingSession.findUnique({ where: { id: sessionId }, include: sessionInclude });
      if (!session) throw new AppError(404, 'TRAINING_SESSION_NOT_FOUND', 'Session not found');
      if (session.status === to) throw new AppError(409, 'TRAINING_SESSION_ALREADY_IN_STATE', `This session is already ${to.toLowerCase()}`);
      if (!allowed[to].includes(session.status)) {
        throw new AppError(409, 'TRAINING_SESSION_TRANSITION_INVALID', `A ${session.status.toLowerCase()} session cannot move to ${to.toLowerCase()}`);
      }

      const after = await tx.trainingSession.update({
        where: { id: sessionId },
        data: {
          status: to,
          completedAt: to === 'COMPLETED' ? new Date() : undefined,
          cancelledAt: to === 'CANCELLED' ? new Date() : undefined,
        },
        include: sessionInclude,
      });

      if (to === 'CANCELLED') {
        const places = await tx.trainingEnrollment.findMany({
          where: { sessionId, status: { notIn: ['CANCELLED', 'COMPLETED', 'FAILED', 'NO_SHOW'] } },
          select: { id: true, employeeId: true, trainingNeedId: true, idpItemId: true },
        });
        for (const place of places) {
          await tx.trainingEnrollment.update({ where: { id: place.id }, data: { status: 'CANCELLED', completionAt: null } });
          if (place.trainingNeedId) await revertNeed(tx, place.trainingNeedId);
          if (place.idpItemId) await tx.idpItem.update({ where: { id: place.idpItemId }, data: { status: 'PLANNED', linkedSessionId: null } });
          await notificationService.publish(
            {
              userId: (await tx.user.findFirst({ where: { employeeId: place.employeeId }, select: { id: true } }))?.id ?? null,
              type: NOTIFICATION_TYPES.TRAINING_SESSION_UPDATED,
              source: { module: 'training', entityType: 'TRAINING_SESSION', entityId: sessionId },
              data: { sessionId },
              dedupeKey: `training:${sessionId}:${place.employeeId}:cancelled`,
            },
            { courseTitle: session.courseTitleSnapshot, date: businessDateIn(session.startAt, session.timezone) },
            tx,
          );
        }
      }

      // Completing a session completes nothing for anybody: each person's outcome is recorded deliberately.
      await auditService.log(trainingAudit(actor, AUDIT_ACTIONS.UPDATE_TRAINING_SESSION, 'TrainingSession', sessionId,
        { status: to }, { status: session.status }), tx);
      return after;
    });
    return toSessionDto(row, await activeEnrollmentCount(prisma, sessionId));
  },
};

/** A need that was being worked on goes back to planned when the training falls through — never to fulfilled. */
async function revertNeed(db: Db, needId: string) {
  const need = await db.trainingNeed.findUnique({ where: { id: needId }, select: { status: true } });
  if (!need || need.status === 'FULFILLED' || need.status === 'CANCELLED') return;
  await db.trainingNeed.update({ where: { id: needId }, data: { status: 'PLANNED' } });
}

async function loadForUpdate(tx: Tx, id: string) {
  const enrollment = await tx.trainingEnrollment.findUnique({
    where: { id },
    include: { session: { select: { id: true, status: true, courseTitleSnapshot: true } } },
  });
  if (!enrollment) throw new AppError(404, 'TRAINING_ENROLLMENT_NOT_FOUND', 'Enrolment not found');
  await lockSession(tx, enrollment.sessionId);
  return enrollment;
}

/** A recorded outcome is final: there is no correction workflow in this release, so nothing silently overwrites one. */
function assertNotTerminal(status: string) {
  if (TRAINING_ENROLLMENT_TERMINAL.includes(status as never)) {
    throw new AppError(409, 'TRAINING_ENROLLMENT_FINISHED', `This enrolment is already recorded as ${status.toLowerCase().replace('_', ' ')}`);
  }
}

export { enrollmentInclude, toDto as toEnrollmentDto };
