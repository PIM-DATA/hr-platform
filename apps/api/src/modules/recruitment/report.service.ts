import type { Prisma } from '@prisma/client';
import { APPLICATION_STAGES, averageTimeToHireDays, type RecruitmentDashboardDto, type RecruitmentReportDto, type RecruitmentReportQuery } from '@hr/shared';
import { prisma } from '../../lib/prisma';
import type { AuthContext } from '../auth/auth.types';
import { applicationScopeWhere, isRecruitmentAdmin } from './recruitment.types';

/**
 * Dashboard and reports — counts and averages, nothing about any one candidate.
 *
 * There is no ranking anywhere: no "best candidates", no score table, no interviewer league. Rejection reasons are
 * aggregated by code (the note is never read here). Time to hire is applied → hired, in days, averaged; time to fill
 * is a different question and is deferred.
 */
const dateRange = (q: RecruitmentReportQuery): Prisma.RecruitmentApplicationWhereInput => ({
  ...(q.from ? { appliedAt: { gte: q.from } } : {}),
  ...(q.to ? { appliedAt: { ...(q.from ? { gte: q.from } : {}), lte: q.to } } : {}),
  ...(q.organizationId ? { opening: { requisition: { organizationId: q.organizationId } } } : {}),
});

const funnelOf = (rows: { stage: string; _count: { _all: number } }[]) => APPLICATION_STAGES.map((stage) => ({ stage, count: rows.find((r) => r.stage === stage)?._count._all ?? 0 }));

export const recruitmentReportService = {
  async dashboard(auth: AuthContext): Promise<RecruitmentDashboardDto> {
    const appScope = applicationScopeWhere(auth);
    const admin = isRecruitmentAdmin(auth);
    const [openRequisitions, openOpenings, activeApplications, interviewsScheduled, offersPending, hires, funnel] = await Promise.all([
      prisma.recruitmentRequisition.count({ where: { status: { in: ['PENDING_APPROVAL', 'APPROVED'] }, ...(admin ? {} : { hiringManagerUserId: auth.userId }) } }),
      prisma.recruitmentOpening.count({ where: { status: 'OPEN', ...(admin ? {} : { hiringManagerUserId: auth.userId }) } }),
      prisma.recruitmentApplication.count({ where: { ...appScope, stage: { in: ['APPLIED', 'SCREENING', 'INTERVIEW', 'OFFER'] } } }),
      prisma.recruitmentInterview.count({ where: { status: 'SCHEDULED', scheduledStart: { gte: new Date() }, ...(admin ? {} : { OR: [{ application: appScope }, { interviewers: { some: { userId: auth.userId } } }] }) } }),
      prisma.recruitmentOffer.count({ where: { status: { in: ['PENDING_APPROVAL', 'APPROVED', 'SENT'] }, application: appScope } }),
      prisma.recruitmentApplication.count({ where: { ...appScope, stage: 'HIRED' } }),
      prisma.recruitmentApplication.groupBy({ by: ['stage'], where: appScope, _count: { _all: true }, orderBy: { stage: 'asc' } }),
    ]);
    return { openRequisitions, openOpenings, activeApplications, interviewsScheduled, offersPending, hires, funnel: funnelOf(funnel) };
  },

  async report(q: RecruitmentReportQuery): Promise<RecruitmentReportDto> {
    const where = dateRange(q);
    const [funnel, apps, interviews, feedbackCount, offers, rejections] = await Promise.all([
      prisma.recruitmentApplication.groupBy({ by: ['stage'], where, _count: { _all: true }, orderBy: { stage: 'asc' } }),
      prisma.recruitmentApplication.findMany({ where, select: { id: true, sourceSnapshot: true, departmentNameSnapshot: true, jobTitleSnapshot: true, stage: true, appliedAt: true, hiredAt: true, _count: { select: { interviews: true, offers: true } } } }),
      prisma.recruitmentInterview.groupBy({ by: ['status'], where: { application: where }, _count: { _all: true }, orderBy: { status: 'asc' } }),
      prisma.recruitmentInterviewFeedback.count({ where: { interview: { application: where } } }),
      prisma.recruitmentOffer.groupBy({ by: ['status'], where: { application: where }, _count: { _all: true }, orderBy: { status: 'asc' } }),
      prisma.recruitmentApplication.groupBy({ by: ['rejectionReasonCode'], where: { ...where, stage: 'REJECTED' }, _count: { _all: true }, orderBy: { rejectionReasonCode: 'asc' } }),
    ]);

    const bucket = <K extends string>(key: (a: (typeof apps)[number]) => K) => {
      const map = new Map<K, { applications: number; interviews: number; offers: number; hires: number }>();
      for (const a of apps) {
        const k = key(a);
        const b = map.get(k) ?? { applications: 0, interviews: 0, offers: 0, hires: 0 };
        b.applications += 1;
        if (a._count.interviews > 0) b.interviews += 1;
        if (a._count.offers > 0) b.offers += 1;
        if (a.stage === 'HIRED') b.hires += 1;
        map.set(k, b);
      }
      return [...map.entries()].sort((x, y) => y[1].applications - x[1].applications);
    };
    const count = (rows: { status: string; _count: { _all: number } }[], status: string) => rows.find((r) => r.status === status)?._count._all ?? 0;
    const hired = apps.filter((a) => a.stage === 'HIRED' && a.hiredAt).map((a) => ({ appliedAt: a.appliedAt, hiredAt: a.hiredAt as Date }));

    return {
      funnel: funnelOf(funnel),
      bySource: bucket((a) => a.sourceSnapshot).map(([source, b]) => ({ source, ...b })),
      byDepartment: bucket((a) => a.departmentNameSnapshot ?? 'Unassigned').map(([departmentName, b]) => ({ departmentName, applications: b.applications, hires: b.hires })),
      byJob: bucket((a) => a.jobTitleSnapshot).map(([jobTitle, b]) => ({ jobTitle, applications: b.applications, hires: b.hires })),
      interviews: { scheduled: count(interviews, 'SCHEDULED'), completed: count(interviews, 'COMPLETED'), cancelled: count(interviews, 'CANCELLED'), feedbackSubmitted: feedbackCount },
      offers: { approved: count(offers, 'APPROVED') + count(offers, 'SENT') + count(offers, 'ACCEPTED') + count(offers, 'DECLINED'), accepted: count(offers, 'ACCEPTED'), declined: count(offers, 'DECLINED'), withdrawn: count(offers, 'WITHDRAWN') },
      hires: hired.length,
      averageTimeToHireDays: averageTimeToHireDays(hired),
      rejectionsByReason: rejections.map((r) => ({ reasonCode: r.rejectionReasonCode ?? 'OTHER', count: r._count._all })).sort((a, b) => b.count - a.count),
    };
  },
};
