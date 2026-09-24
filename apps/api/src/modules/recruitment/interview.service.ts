import type { Prisma } from '@prisma/client';
import { AUDIT_ACTIONS, NOTIFICATION_TYPES, RECRUITMENT_WORKFLOW, type InterviewDto, type InterviewFeedbackDto, type InterviewListQuery, type ScheduleInterviewInput, type SubmitFeedbackInput, type UpdateInterviewInput } from '@hr/shared';
import { prisma } from '../../lib/prisma';
import { AppError } from '../../lib/errors';
import { auditService } from '../../services/audit/audit.service';
import { notificationService } from '../../services/notification';
import type { AuthContext } from '../auth/auth.types';
import { applicationScopeWhere, isRecruitmentAdmin, lockRow, notFound, recruitmentAudit, textAudit, type Actor, type Db, type Tx } from './recruitment.types';

/**
 * Interviews and feedback.
 *
 * Being named as an interviewer is what opens one interview and its application to somebody — purpose-specific
 * access, for that conversation and nothing else. Feedback is one interviewer's view, written once. Recruiters and
 * the hiring manager read all of it, an interviewer reads only their own, and nothing anywhere adds it up into a
 * score or a ranking: it informs the person who decides.
 */
const include = {
  application: { select: { id: true, applicationNumber: true, hiringManagerUserId: true, stage: true, candidate: { select: { id: true, firstName: true, lastName: true } }, opening: { select: { id: true, titleSnapshot: true } } } },
  interviewers: { include: { user: { select: { id: true, email: true, employee: { select: { firstName: true, lastName: true } } } } }, orderBy: { id: 'asc' as const } },
  feedback: { include: { interviewer: { select: { id: true, email: true, employee: { select: { firstName: true, lastName: true } } } } }, orderBy: { submittedAt: 'asc' as const } },
} satisfies Prisma.RecruitmentInterviewInclude;
type Row = Prisma.RecruitmentInterviewGetPayload<{ include: typeof include }>;

const userName = (u: { email: string; employee: { firstName: string; lastName: string } | null }) => (u.employee ? `${u.employee.firstName} ${u.employee.lastName}` : u.email);

const feedbackDto = (f: Row['feedback'][number]): InterviewFeedbackDto => ({
  interviewerUserId: f.interviewerUserId, interviewerName: userName(f.interviewer), recommendation: f.recommendation as InterviewFeedbackDto['recommendation'],
  overallScore: f.overallScore, strengths: f.strengths, concerns: f.concerns, comments: f.comments, submittedAt: f.submittedAt.toISOString(),
});

/** Who may read every piece of feedback on this interview: an administrator or the application's hiring manager. */
const seesAllFeedback = (auth: AuthContext, row: Row) => isRecruitmentAdmin(auth) || row.application.hiringManagerUserId === auth.userId;

export const toInterviewDto = (auth: AuthContext, row: Row): InterviewDto => {
  const mine = row.feedback.find((f) => f.interviewerUserId === auth.userId) ?? null;
  return {
    id: row.id, applicationId: row.applicationId, applicationNumber: row.application.applicationNumber,
    candidate: row.application.candidate, opening: { id: row.application.opening.id, title: row.application.opening.titleSnapshot },
    roundNumber: row.roundNumber, title: row.title, scheduledStart: row.scheduledStart.toISOString(), scheduledEnd: row.scheduledEnd.toISOString(), timezone: row.timezone,
    location: row.location, meetingUrl: row.meetingUrl, status: row.status as InterviewDto['status'],
    interviewers: row.interviewers.map((i) => ({ userId: i.userId, name: userName(i.user), roleLabel: i.roleLabel, feedbackSubmitted: row.feedback.some((f) => f.interviewerUserId === i.userId) })),
    feedback: seesAllFeedback(auth, row) ? row.feedback.map(feedbackDto) : mine ? [feedbackDto(mine)] : [],
    myFeedback: mine ? feedbackDto(mine) : null,
    createdAt: row.createdAt.toISOString(),
  };
};

const scopeWhere = (auth: AuthContext, view: 'mine' | 'all'): Prisma.RecruitmentInterviewWhereInput =>
  view === 'mine' ? { interviewers: { some: { userId: auth.userId } } } : isRecruitmentAdmin(auth) ? {} : { application: applicationScopeWhere(auth) };

export async function interviewDtos(auth: AuthContext, where: Prisma.RecruitmentInterviewWhereInput): Promise<InterviewDto[]> {
  const rows = await prisma.recruitmentInterview.findMany({ where: { ...where, ...scopeWhere(auth, 'all') }, include, orderBy: { scheduledStart: 'asc' } });
  return rows.map((r) => toInterviewDto(auth, r));
}

async function load(db: Db, id: string) {
  const row = await db.recruitmentInterview.findUnique({ where: { id }, include });
  if (!row) throw notFound('interview');
  return row;
}

async function resolveInterviewers(db: Db, userIds: string[]) {
  const users = await db.user.findMany({ where: { id: { in: userIds }, isActive: true }, select: { id: true, employee: { select: { id: true } } } });
  const missing = userIds.filter((id) => !users.some((u) => u.id === id));
  if (missing.length) throw new AppError(422, 'INTERVIEWER_NOT_FOUND', 'One or more interviewers are not active users');
  return users.map((u) => ({ userId: u.id, employeeId: u.employee?.id ?? null }));
}

function assertTimezone(tz: string) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); } catch { throw new AppError(422, 'INVALID_TIMEZONE', `"${tz}" is not a known IANA timezone`); }
}

const dateLabel = (start: Date, tz: string) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, dateStyle: 'medium', timeStyle: 'short' }).format(start);

async function notifyAssigned(tx: Tx, row: { id: string; applicationId: string; scheduledStart: Date; timezone: string; application: { opening: { titleSnapshot: string } } }, userIds: string[]) {
  for (const userId of userIds) {
    await notificationService.publish(
      { userId, type: NOTIFICATION_TYPES.INTERVIEW_ASSIGNED, source: { module: RECRUITMENT_WORKFLOW.module, entityType: 'RECRUITMENT_INTERVIEW', entityId: row.id }, data: { interviewId: row.id, applicationId: row.applicationId }, dedupeKey: `recruitment:interview:${row.id}:assigned:${userId}:${row.scheduledStart.getTime()}` },
      { openingTitle: row.application.opening.titleSnapshot, date: dateLabel(row.scheduledStart, row.timezone) },
      tx,
    );
  }
}

export const interviewService = {
  async list(auth: AuthContext, q: InterviewListQuery) {
    const where: Prisma.RecruitmentInterviewWhereInput = { ...scopeWhere(auth, q.view), status: q.status, applicationId: q.applicationId };
    const [total, rows] = await prisma.$transaction([
      prisma.recruitmentInterview.count({ where }),
      prisma.recruitmentInterview.findMany({ where, include, orderBy: { scheduledStart: q.view === 'mine' ? 'asc' : 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
    ]);
    return { data: rows.map((r) => toInterviewDto(auth, r)), meta: { page: q.page, pageSize: q.pageSize, total } };
  },

  async get(auth: AuthContext, id: string): Promise<InterviewDto> {
    // The application scope already covers assigned interviewers, so one scope serves both the panel and the hiring team.
    const row = await prisma.recruitmentInterview.findFirst({ where: { id, ...scopeWhere(auth, 'all') }, include });
    if (!row) throw notFound('interview');
    return toInterviewDto(auth, row);
  },

  async schedule(applicationId: string, input: ScheduleInterviewInput, actor: Actor): Promise<InterviewDto> {
    const id = await prisma.$transaction(async (tx) => {
      await lockRow(tx, 'recruitment_applications', applicationId);
      const application = await tx.recruitmentApplication.findUnique({ where: { id: applicationId }, select: { stage: true, applicationNumber: true, opening: { select: { requisition: { select: { organization: { select: { timezone: true } } } } } } } });
      if (!application) throw notFound('application');
      if (!['APPLIED', 'SCREENING', 'INTERVIEW', 'OFFER'].includes(application.stage)) throw new AppError(409, 'APPLICATION_CLOSED', `This application is ${application.stage.toLowerCase()}`);
      const timezone = input.timezone ?? application.opening.requisition.organization.timezone;
      assertTimezone(timezone);
      const interviewers = await resolveInterviewers(tx, [...new Set(input.interviewerUserIds)]);
      const created = await tx.recruitmentInterview.create({
        data: {
          applicationId, roundNumber: input.roundNumber ?? null, title: input.title, scheduledStart: new Date(input.scheduledStart), scheduledEnd: new Date(input.scheduledEnd), timezone,
          location: input.location ?? null, meetingUrl: input.meetingUrl ?? null, createdByUserId: actor.auth.userId,
          interviewers: { create: interviewers },
        },
        include,
      });
      await notifyAssigned(tx, created, interviewers.map((i) => i.userId));
      await auditService.log(recruitmentAudit(actor, AUDIT_ACTIONS.SCHEDULE_INTERVIEW, 'RecruitmentInterview', created.id, { applicationNumber: application.applicationNumber, scheduledStart: created.scheduledStart.toISOString(), timezone, interviewerCount: interviewers.length }), tx);
      return created.id;
    });
    return toInterviewDto(actor.auth, await load(prisma, id));
  },

  /** Reschedule, change the panel, or mark COMPLETED / CANCELLED. A completed or cancelled interview is frozen. */
  async update(id: string, input: UpdateInterviewInput, actor: Actor): Promise<InterviewDto> {
    await prisma.$transaction(async (tx) => {
      await lockRow(tx, 'recruitment_interviews', id);
      const before = await load(tx, id);
      if (before.status !== 'SCHEDULED') throw new AppError(409, 'INTERVIEW_NOT_SCHEDULED', `This interview is ${before.status.toLowerCase()}`);
      const start = input.scheduledStart ? new Date(input.scheduledStart) : before.scheduledStart;
      const end = input.scheduledEnd ? new Date(input.scheduledEnd) : before.scheduledEnd;
      if (start >= end) throw new AppError(422, 'INTERVIEW_TIME_INVALID', 'The interview ends before it starts');
      if (input.timezone) assertTimezone(input.timezone);
      const newPanel = input.interviewerUserIds ? await resolveInterviewers(tx, [...new Set(input.interviewerUserIds)]) : null;
      if (newPanel) {
        const withFeedback = before.feedback.map((f) => f.interviewerUserId).filter((u) => !newPanel.some((p) => p.userId === u));
        if (withFeedback.length) throw new AppError(409, 'INTERVIEWER_HAS_FEEDBACK', 'An interviewer who has submitted feedback cannot be removed');
        await tx.recruitmentInterviewer.deleteMany({ where: { interviewId: id, userId: { notIn: newPanel.map((p) => p.userId) } } });
        for (const p of newPanel) await tx.recruitmentInterviewer.upsert({ where: { interviewId_userId: { interviewId: id, userId: p.userId } }, create: { interviewId: id, ...p }, update: {} });
      }
      const updated = await tx.recruitmentInterview.update({
        where: { id },
        data: {
          title: input.title, roundNumber: input.roundNumber, scheduledStart: start, scheduledEnd: end, timezone: input.timezone, location: input.location, meetingUrl: input.meetingUrl,
          ...(input.status === 'COMPLETED' ? { status: 'COMPLETED', completedAt: new Date() } : input.status === 'CANCELLED' ? { status: 'CANCELLED', cancelledAt: new Date() } : {}),
        },
        include,
      });
      const timeChanged = start.getTime() !== before.scheduledStart.getTime() || end.getTime() !== before.scheduledEnd.getTime();
      const added = newPanel ? newPanel.map((p) => p.userId).filter((u) => !before.interviewers.some((i) => i.userId === u)) : [];
      if (updated.status === 'SCHEDULED') await notifyAssigned(tx, updated, timeChanged ? updated.interviewers.map((i) => i.userId) : added);
      await auditService.log(recruitmentAudit(actor, AUDIT_ACTIONS.UPDATE_INTERVIEW, 'RecruitmentInterview', id,
        { fields: Object.keys(input), status: updated.status, scheduledStart: updated.scheduledStart.toISOString(), interviewerCount: updated.interviewers.length },
        { status: before.status, scheduledStart: before.scheduledStart.toISOString(), interviewerCount: before.interviewers.length }), tx);
    });
    return toInterviewDto(actor.auth, await load(prisma, id));
  },

  /** Feedback is written once by an assigned interviewer. Its content never reaches the audit log. */
  async submitFeedback(id: string, input: SubmitFeedbackInput, actor: Actor): Promise<InterviewDto> {
    await prisma.$transaction(async (tx) => {
      await lockRow(tx, 'recruitment_interviews', id);
      const row = await load(tx, id);
      if (!row.interviewers.some((i) => i.userId === actor.auth.userId)) throw notFound('interview');
      if (row.status === 'CANCELLED') throw new AppError(409, 'INTERVIEW_CANCELLED', 'This interview was cancelled');
      if (row.feedback.some((f) => f.interviewerUserId === actor.auth.userId)) throw new AppError(409, 'FEEDBACK_ALREADY_SUBMITTED', 'You have already submitted feedback for this interview');
      await tx.recruitmentInterviewFeedback.create({
        data: { interviewId: id, interviewerUserId: actor.auth.userId, recommendation: input.recommendation, overallScore: input.overallScore ?? null, strengths: input.strengths ?? null, concerns: input.concerns ?? null, comments: input.comments ?? null },
      });
      await auditService.log(recruitmentAudit(actor, AUDIT_ACTIONS.SUBMIT_INTERVIEW_FEEDBACK, 'RecruitmentInterview', id,
        { applicationNumber: row.application.applicationNumber, hasScore: input.overallScore != null, ...textAudit('strengths', null, input.strengths), ...textAudit('concerns', null, input.concerns), ...textAudit('comments', null, input.comments) }), tx);
    });
    return toInterviewDto(actor.auth, await load(prisma, id));
  },
};
