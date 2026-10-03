import { PERMISSIONS, payrollPeriodLabel, type Employee360Dto, type EmploymentTimelineEventDto, type ManagerHistoryItem, type PositionHistoryItem, checklistProgress, certificationStatus, CERTIFICATION_EXPIRY_WINDOW_DAYS } from '@hr/shared';
import { prisma } from '../../lib/prisma';
import { balanceDto, sumsOf } from '../benefits/benefit-ledger';
import { logger } from '../../lib/logger';
import { hasPermission, narrowAuth, scopeFor } from '../../services/authorization/authorization.service';
import type { AuthContext } from '../auth/auth.types';
import { employeesService } from '../employees/employees.service';
import { entitlementsService } from '../leave/entitlements.service';
import { leaveRequestsService } from '../leave/leave-requests.service';
import { attendanceRecordsService } from '../attendance/attendance-records.service';
import { overtimeService } from '../attendance/overtime.service';
import { payslipService } from '../payroll/payslip.service';
import { skillGapService } from '../competency/skill-gap.service';
import { trainingReportService } from '../training/training-report.service';
import { erCaseService } from '../employee-relations/er-case.service';
import { careerService } from '../talent/career.service';
import { developmentService } from '../talent/development.service';

type Actor = { auth: AuthContext; ipAddress: string | null; userAgent: string | null };
type Sections = Employee360Dto['sections'];
type Activity = Employee360Dto['activity'][number];

/**
 * Employee 360 — one screen, many owners.
 *
 * Every section here is produced by the module that owns the data, and shown only when the caller could open that
 * module's own screen for this employee. `employee360.view` opens the page and grants nothing else: a manager's
 * TEAM scope never unlocks salary, a disciplinary summary or a potential judgment, and an employee's own page never
 * shows what the organization has recorded about them in talent or succession. An unauthorized section is absent —
 * null in the payload, not hidden by the browser. A section that fails is logged and returned as null so one
 * optional domain cannot take the page down. Nothing is recalculated and nothing is written.
 */
const log = logger.child({ module: 'employee360' });
const has = (auth: AuthContext, p: string) => hasPermission(auth, p);
/**
 * Task 50 (T44-P1-21): every section is judged with the scope of ITS OWN permission — the widest among the roles that
 * grant that permission — never with the scope of whatever opened the 360 page or of an unrelated role.
 */
const inScopeFor = (auth: AuthContext, employeeId: string, managerId: string | null, ...perms: string[]) => {
  const s = scopeFor(auth, ...perms);
  return s === 'ALL' || (s !== null && employeeId === auth.employeeId) || (s === 'TEAM' && !!auth.employeeId && managerId === auth.employeeId);
};

async function section<T>(name: string, run: () => Promise<T>): Promise<T | null> {
  try { return await run(); } catch (e) { log.warn({ section: name, error: e instanceof Error ? e.message : String(e) }, 'employee 360 section failed'); return null; }
}

function timelineFrom(positions: PositionHistoryItem[], managers: ManagerHistoryItem[], hireDate: string, terminationDate: string | null, status: string): EmploymentTimelineEventDto[] {
  const events: EmploymentTimelineEventDto[] = [{ date: hireDate.slice(0, 10), type: 'JOINED', title: 'Joined', detail: null }];
  const byStart = [...positions].sort((a, b) => a.startDate.localeCompare(b.startDate));
  byStart.forEach((p, i) => {
    if (i === 0) return; // the first assignment is the hire itself
    const prev = byStart[i - 1]!;
    const deptMoved = prev.department.id !== p.department.id;
    events.push({ date: p.startDate.slice(0, 10), type: deptMoved ? 'DEPARTMENT_MOVED' : 'POSITION_CHANGED', title: deptMoved ? `Moved to ${p.department.name}` : `Position changed to ${p.position.title}`, detail: deptMoved ? `${p.position.title} (from ${prev.position.title}, ${prev.department.name})` : `from ${prev.position.title}` });
  });
  const mgrs = [...managers].sort((a, b) => a.startDate.localeCompare(b.startDate));
  mgrs.forEach((m, i) => { if (i === 0 && m.startDate.slice(0, 10) === hireDate.slice(0, 10)) return; events.push({ date: m.startDate.slice(0, 10), type: 'MANAGER_CHANGED', title: `Manager: ${m.manager.firstName} ${m.manager.lastName}`, detail: i > 0 ? `previously ${mgrs[i - 1]!.manager.firstName} ${mgrs[i - 1]!.manager.lastName}` : null }); });
  if (terminationDate) events.push({ date: terminationDate.slice(0, 10), type: 'TERMINATED', title: 'Employment ended', detail: null });
  else if (status === 'INACTIVE') events.push({ date: '', type: 'DEACTIVATED', title: 'Deactivated', detail: 'Date not recorded' });
  return events.filter((e) => e.date).sort((a, b) => a.date.localeCompare(b.date));
}

export const employee360Service = {
  async getOverview({ employeeId, actor }: { employeeId: string; actor: Actor }): Promise<Employee360Dto> {
    const { auth } = actor;
    // The employee master decides whether the caller may see this person at all (404 outside the scope).
    // (the 360 route's own guard has narrowed `auth` to employee360.view; the profile is the employee master's call)
    const profile = await employeesService.getById(narrowAuth(auth, PERMISSIONS.EMPLOYEES_VIEW), employeeId);
    const self = auth.employeeId === employeeId;
    const managerId = profile.manager?.id ?? null;
    const scoped = (...perms: string[]) => inScopeFor(auth, employeeId, managerId, ...perms);
    const isManagerOf = (...perms: string[]) => scopeFor(auth, ...perms) === 'TEAM' && managerId === auth.employeeId && !self;
    const as = (...perms: string[]) => narrowAuth(auth, ...perms);
    const year = new Date().getUTCFullYear();
    const today = new Date().toISOString().slice(0, 10);
    const monthStart = `${today.slice(0, 7)}-01`;
    const ninetyDaysAgo = new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10);
    const activity: Activity[] = [];

    // ---- which sections may this caller see? (source-module rules, restated, never widened) ----
    const may = {
      employment: true,
      leave: self || scoped(PERMISSIONS.LEAVE_VIEW),
      attendance: self || scoped(PERMISSIONS.ATTENDANCE_VIEW),
      overtime: self || scoped(PERMISSIONS.OT_VIEW),
      payroll: (self && has(auth, PERMISSIONS.PAYROLL_VIEW_OWN)) || (!self && has(auth, PERMISSIONS.PAYROLL_MANAGE)),
      performance: self || has(auth, PERMISSIONS.PERFORMANCE_MANAGE_CYCLES) || scoped(PERMISSIONS.PERFORMANCE_VIEW),
      competency: self || has(auth, PERMISSIONS.COMPETENCY_MANAGE) || isManagerOf(PERMISSIONS.COMPETENCY_VIEW),
      development: self || has(auth, PERMISSIONS.TRAINING_MANAGE) || isManagerOf(PERMISSIONS.TRAINING_VIEW),
      employeeRelations: !self && (has(auth, PERMISSIONS.EMPLOYEE_RELATIONS_VIEW) || has(auth, PERMISSIONS.EMPLOYEE_RELATIONS_MANAGE)),
      recruitment: !self && has(auth, PERMISSIONS.RECRUITMENT_MANAGE),
      career: self ? has(auth, PERMISSIONS.CAREER_VIEW) : has(auth, PERMISSIONS.CAREER_MANAGE) || has(auth, PERMISSIONS.TALENT_MANAGE) || isManagerOf(PERMISSIONS.TALENT_VIEW),
      talent: !self && (has(auth, PERMISSIONS.TALENT_MANAGE) || has(auth, PERMISSIONS.SUCCESSION_MANAGE) || isManagerOf(PERMISSIONS.TALENT_VIEW)),
      // Lifecycle (Task 34): statuses and dates only, under each process's own view permission. Never a note, a comment or a reason note.
      // Benefits (Task 36): the subject's own view, or an organization-wide benefits administrator. A manager's TEAM scope never opens it.
      benefits: self ? has(auth, PERMISSIONS.BENEFITS_VIEW_OWN) : scopeFor(auth, PERMISSIONS.BENEFITS_VIEW, PERMISSIONS.BENEFITS_MANAGE) === 'ALL',
      // Task 50: within the lifecycle permissions' own scope (before: any holder saw anybody whose profile was visible)
      lifecycle: scoped(PERMISSIONS.ONBOARDING_VIEW, PERMISSIONS.PROBATION_VIEW, PERMISSIONS.OFFBOARDING_VIEW, PERMISSIONS.ONBOARDING_MANAGE, PERMISSIONS.PROBATION_MANAGE, PERMISSIONS.OFFBOARDING_MANAGE),
    };

    const [employment, leave, attendance, overtime, payroll, performance, competency, development, employeeRelations, recruitment, career, talent, lifecycle, benefits] = await Promise.all([
      section('employment', async () => {
        const [positions, managers] = await Promise.all([employeesService.positionHistory(as(PERMISSIONS.EMPLOYEES_VIEW), employeeId), employeesService.managerHistory(as(PERMISSIONS.EMPLOYEES_VIEW), employeeId)]);
        const timeline = timelineFrom(positions, managers, profile.hireDate, profile.terminationDate, profile.employmentStatus);
        for (const t of timeline.filter((e) => e.type !== 'JOINED')) activity.push({ date: t.date, domain: 'employment', title: t.title, detail: t.detail });
        return { positions, managers, timeline };
      }),
      may.leave ? section('leave', async () => {
        const [balances, requests] = await Promise.all([
          entitlementsService.list({ employeeId, year, page: 1, pageSize: 20 }),
          leaveRequestsService.list(as(PERMISSIONS.LEAVE_VIEW), { employeeId, from: `${year}-01-01`, to: `${year}-12-31`, page: 1, pageSize: 100 }),
        ]);
        const rows = requests.data;
        const approved = rows.filter((r) => r.status === 'APPROVED');
        for (const r of approved.slice(0, 5)) activity.push({ date: r.startDate, domain: 'leave', title: `${r.leaveType.name} approved`, detail: `${r.startDate} → ${r.endDate} · ${r.units} unit(s)` });
        return { year, balances: balances.data, summary: { requests: rows.filter((r) => r.status !== 'DRAFT').length, approved: approved.length, pending: rows.filter((r) => r.status === 'PENDING').length, approvedUnits: approved.reduce((n, r) => n + r.units, 0) }, recent: rows.slice(0, 5) };
      }) : null,
      may.attendance ? section('attendance', async () => {
        const report = await attendanceRecordsService.report(as(PERMISSIONS.ATTENDANCE_VIEW), { from: monthStart, to: today, employeeId });
        const totals = report.rows[0] ? (({ employee: _e, ...rest }) => rest)(report.rows[0]) : null;
        const recent = await prisma.attendanceRecord.findMany({ where: { employeeId }, select: { attendanceDate: true, dayType: true, status: true, workMinutes: true, lateMinutes: true }, orderBy: { attendanceDate: 'desc' }, take: 10 });
        return { from: monthStart, to: today, totals, recent: recent.map((r) => ({ date: r.attendanceDate, dayType: r.dayType, status: r.status, workMinutes: r.workMinutes, lateMinutes: r.lateMinutes })) };
      }) : null,
      may.overtime ? section('overtime', async () => {
        const [report, recent] = await Promise.all([
          overtimeService.report(as(PERMISSIONS.OT_VIEW), { from: `${year}-01-01`, to: today, employeeId }),
          overtimeService.list(as(PERMISSIONS.OT_VIEW), { employeeId, view: self ? 'mine' : 'all', page: 1, pageSize: 5 }),
        ]);
        const row = report.rows[0];
        return { from: `${year}-01-01`, to: today, requests: row?.requests ?? 0, approvedRequests: row?.approvedRequests ?? 0, approvedMinutes: row?.approvedMinutes ?? 0, recent: recent.data, note: report.note };
      }) : null,
      may.payroll ? section('payroll', async () => {
        if (self) {
          const mine = await payslipService.listMine(auth);
          return { mode: 'SELF' as const, payslips: mine.slice(0, 6).map((p) => ({ id: p.id, periodLabel: p.period.label, paymentDate: p.period.paymentDate, netPay: p.netPay, currencyCode: p.currencyCode })) };
        }
        const rows = await prisma.payrollResult.findMany({ where: { employeeId, run: { status: 'CLOSED' } }, select: { id: true, netPay: true, currencyCode: true, run: { select: { period: { select: { year: true, month: true, paymentDate: true } } } } }, orderBy: [{ run: { period: { year: 'desc' } } }, { run: { period: { month: 'desc' } } }], take: 6 });
        return { mode: 'ADMIN' as const, payslips: rows.map((r) => ({ id: r.id, periodLabel: payrollPeriodLabel(r.run.period.year, r.run.period.month), paymentDate: r.run.period.paymentDate, netPay: r.netPay.toFixed(2), currencyCode: r.currencyCode })) };
      }) : null,
      may.performance ? section('performance', async () => {
        // The performance module's own rule: the employee, the snapshot reviewer, or somebody who manages cycles.
        const where = self || has(auth, PERMISSIONS.PERFORMANCE_MANAGE_CYCLES) ? { employeeId } : { employeeId, reviewerUserId: auth.userId };
        const plans = await prisma.performancePlan.findMany({ where, include: { cycle: { select: { id: true, code: true, name: true, status: true, minScore: true, maxScore: true } } }, orderBy: { createdAt: 'desc' }, take: 10 });
        const history = plans.map((p) => ({
          id: p.id, cycle: { id: p.cycle.id, code: p.cycle.code, name: p.cycle.name, status: p.cycle.status, minScore: p.cycle.minScore.toFixed(2), maxScore: p.cycle.maxScore.toFixed(2) },
          snapshot: { departmentName: p.departmentName, positionTitle: p.positionTitle, jobTitle: p.jobTitle },
          reviewer: { employeeId: p.reviewerEmployeeId, name: p.reviewerNameSnapshot },
          status: p.status, finalizedAt: p.finalizedAt?.toISOString() ?? null,
          weightedScore: p.weightedScore?.toFixed(2) ?? null, ratingCode: p.ratingCode, ratingLabel: p.ratingLabelSnapshot,
        }));
        const finalized = history.filter((h) => h.status === 'FINALIZED');
        for (const h of finalized.slice(0, 3)) activity.push({ date: (h.finalizedAt ?? '').slice(0, 10), domain: 'performance', title: `Performance review finalized — ${h.cycle.name}`, detail: h.ratingLabel ? `${h.ratingLabel} (${h.weightedScore})` : null });
        return { latest: finalized[0] ?? null, history };
      }) : null,
      may.competency ? section('competency', () => skillGapService.profileFor(employeeId)) : null,
      may.development ? section('development', async () => {
        const d = await trainingReportService.myDevelopment(employeeId);
        const active = d.idps.find((p) => p.status === 'ACTIVE') ?? null;
        const completed = d.history.filter((e) => e.status === 'COMPLETED');
        for (const e of completed.slice(0, 3)) activity.push({ date: e.session.startAt.slice(0, 10), domain: 'training', title: `Training completed — ${e.course.title}`, detail: null });
        return {
          summary: d.summary,
          activeIdp: active ? { id: active.id, title: active.title, status: active.status, periodStart: active.periodStart, periodEnd: active.periodEnd } : null,
          openNeeds: d.needs.filter((n) => ['OPEN', 'PLANNED', 'IN_PROGRESS'].includes(n.status)).slice(0, 10).map((n) => ({ id: n.id, title: n.title, status: n.status, priority: n.priority, competencyName: n.competency?.name ?? null })),
          upcoming: d.upcoming.slice(0, 5).map((e) => ({ courseTitle: e.course.title, startAt: e.session.startAt, timezone: e.session.timezone })),
          recentCompleted: completed.slice(0, 5).map((e) => ({ courseTitle: e.course.title, completedAt: e.session.startAt })),
          // Learning (Task 35): statuses and dates only. No trainer comment, reflection, evidence or certificate number.
          learning: await (async () => {
            const [ojt, paths, certs] = await Promise.all([
              prisma.ojtPlan.findMany({ where: { employeeId, status: { not: 'CANCELLED' } }, select: { id: true, planNumber: true, programNameSnapshot: true, status: true, startDate: true, completedAt: true, activities: { select: { status: true } } }, orderBy: { startDate: 'desc' }, take: 10 }),
              prisma.learningPathAssignment.findMany({ where: { employeeId, status: { not: 'CANCELLED' } }, select: { id: true, pathNameSnapshot: true, status: true, steps: { select: { fulfilledAt: true } } }, orderBy: { assignedAt: 'desc' }, take: 10 }),
              prisma.employeeCertification.findMany({ where: { employeeId }, select: { id: true, definitionNameSnapshot: true, issuedDate: true, expiryDate: true, revokedAt: true, definition: { select: { expiryWindowDays: true } } }, orderBy: { issuedDate: 'desc' }, take: 20 }),
            ]);
            const t = new Date().toISOString().slice(0, 10);
            return {
              ojt: ojt.map((p) => ({ id: p.id, planNumber: p.planNumber, program: p.programNameSnapshot, status: p.status, startDate: p.startDate, completedAt: p.completedAt?.toISOString() ?? null, activitiesCompleted: p.activities.filter((a) => a.status === 'COMPLETED').length, activities: p.activities.length })),
              learningPaths: paths.map((a) => ({ id: a.id, path: a.pathNameSnapshot, status: a.status, stepsFulfilled: a.steps.filter((x) => x.fulfilledAt).length, steps: a.steps.length })),
              certifications: certs.map((c) => ({ id: c.id, name: c.definitionNameSnapshot, issuedDate: c.issuedDate, expiryDate: c.expiryDate, status: certificationStatus({ expiryDate: c.expiryDate, revokedAt: c.revokedAt }, t, c.definition.expiryWindowDays ?? CERTIFICATION_EXPIRY_WINDOW_DAYS) })),
            };
          })(),
        };
      }) : null,
      may.employeeRelations ? section('employeeRelations', async () => {
        const s = await erCaseService.summaryFor(auth, employeeId);
        if (s.latestActionDate) activity.push({ date: s.latestActionDate.slice(0, 10), domain: 'employee_relations', title: 'Employee relations action issued', detail: 'Open Employee relations for the record' });
        return s;
      }) : null,
      may.recruitment ? section('recruitment', async () => {
        const app = await prisma.recruitmentApplication.findFirst({ where: { hiredEmployeeId: employeeId }, select: { applicationNumber: true, appliedAt: true, hiredAt: true, sourceSnapshot: true, candidate: { select: { candidateNumber: true } }, opening: { select: { titleSnapshot: true } } } });
        return app ? { candidateNumber: app.candidate.candidateNumber, source: app.sourceSnapshot, openingTitle: app.opening.titleSnapshot, applicationNumber: app.applicationNumber, appliedAt: app.appliedAt, hiredAt: app.hiredAt?.toISOString() ?? null } : null;
      }) : null,
      may.career ? section('career', () => careerService.myCareer(employeeId)) : null,
      may.talent ? section('talent', async () => {
        const s = await developmentService.getTalentSummary(employeeId);
        if (s.latestTalentReview?.finalizedAt) activity.push({ date: s.latestTalentReview.finalizedAt.slice(0, 10), domain: 'talent', title: `Talent review finalized — ${s.latestTalentReview.cycleName}`, detail: null });
        return s;
      }) : null,
      may.lifecycle ? section('lifecycle', async () => {
        const [plan, probation, offboarding] = await Promise.all([
          has(auth, PERMISSIONS.ONBOARDING_VIEW) || has(auth, PERMISSIONS.ONBOARDING_MANAGE) ? prisma.onboardingPlan.findFirst({ where: { employeeId }, orderBy: { createdAt: 'desc' }, select: { id: true, status: true, startDate: true, completedAt: true, tasks: { select: { status: true, required: true } } } }) : null,
          has(auth, PERMISSIONS.PROBATION_VIEW) || has(auth, PERMISSIONS.PROBATION_MANAGE) ? prisma.probationCase.findFirst({ where: { employeeId, status: { not: 'CANCELLED' } }, orderBy: { createdAt: 'desc' }, select: { id: true, status: true, startDate: true, currentEndDate: true, finalOutcome: true } }) : null,
          has(auth, PERMISSIONS.OFFBOARDING_VIEW) || has(auth, PERMISSIONS.OFFBOARDING_MANAGE) ? prisma.offboardingCase.findFirst({ where: { employeeId, status: { not: 'CANCELLED' } }, orderBy: { createdAt: 'desc' }, select: { id: true, status: true, plannedLastWorkingDate: true, actualLastWorkingDate: true } }) : null,
        ]);
        const progress = plan ? checklistProgress(plan.tasks) : null;
        return {
          onboarding: plan ? { id: plan.id, status: plan.status, startDate: plan.startDate, progressPct: progress!.pct, completedAt: plan.completedAt?.toISOString() ?? null } : null,
          probation: probation ? { id: probation.id, status: probation.status, startDate: probation.startDate, currentEndDate: probation.currentEndDate, finalOutcome: probation.finalOutcome } : null,
          offboarding: offboarding ? { id: offboarding.id, status: offboarding.status, plannedLastWorkingDate: offboarding.plannedLastWorkingDate, actualLastWorkingDate: offboarding.actualLastWorkingDate } : null,
        };
      }) : null,
      may.benefits ? section('benefits', async () => {
        const [enrollments, entitlements, claims] = await Promise.all([
          prisma.benefitEnrollment.findMany({ where: { employeeId, status: { in: ['ENROLLED', 'WAIVED'] } }, select: { planId: true, status: true, coverageStart: true, coverageEnd: true, plan: { select: { name: true, planType: true } } } }),
          prisma.benefitEntitlement.findMany({ where: { employeeId, period: { status: 'OPEN' } }, select: { planId: true, currency: true, grantedAmount: true, adjustmentAmount: true, reservedAmount: true, consumedAmount: true, plan: { select: { name: true } }, period: { select: { name: true } } } }),
          prisma.benefitClaim.groupBy({ by: ['status'], where: { employeeId }, _count: { _all: true } }),
        ]);
        // statuses, plan names and balances — never a description, a document or a payment reference
        return {
          enrollments: enrollments.map((e) => ({ plan: e.plan.name, planType: e.plan.planType, status: e.status, coverageStart: e.coverageStart, coverageEnd: e.coverageEnd })),
          balances: entitlements.map((e) => ({ plan: e.plan.name, period: e.period.name, ...balanceDto(e.currency, sumsOf(e)) })),
          claims: claims.map((c) => ({ status: c.status, count: c._count._all })),
        };
      }) : null,
    ]);

    const sections: Sections = { employment, leave, attendance, overtime, payroll, performance, competency, development, employeeRelations, recruitment, career, talent, lifecycle, benefits };
    const visibleSections = (Object.keys(sections) as (keyof Sections)[]).filter((k) => sections[k] !== null || (k === 'recruitment' && may.recruitment));
    return {
      profile, visibleSections, sections,
      activity: activity.filter((a) => a.date && a.date >= ninetyDaysAgo.slice(0, 4) + '-01-01').sort((a, b) => b.date.localeCompare(a.date)).slice(0, 20),
      generatedAt: new Date().toISOString(),
    };
  },
};

