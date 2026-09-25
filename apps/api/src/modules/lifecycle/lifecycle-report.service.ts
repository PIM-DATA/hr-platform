import { addCalendarDays, checklistProgress, type LifecycleDashboardDto, type LifecycleReportDto } from '@hr/shared';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import type { AuthContext } from '../auth/auth.types';
import { lifecycleEmployeeWhere, today } from './lifecycle.types';

/**
 * Lifecycle reporting: counts, rates and upcoming dates. Names appear only on the HR dashboard's upcoming list
 * (within the reader's scope); the aggregate report carries departments, reasons and months — never a person,
 * a reason note, a review comment or a task note. No ranking of managers or employees.
 */
const monthOf = (d: string | Date | null) => (d ? (typeof d === 'string' ? d : d.toISOString()).slice(0, 7) : null);

export const lifecycleReportService = {
  async dashboard(auth: AuthContext, withNames: boolean): Promise<LifecycleDashboardDto> {
    const scope = await lifecycleEmployeeWhere(auth);
    const t = today(); const in14 = addCalendarDays(t, 14); const in30 = addCalendarDays(t, 30); const ago90 = new Date(Date.now() - 90 * 86_400_000);
    const [plans, cases, offs] = await Promise.all([
      prisma.onboardingPlan.findMany({ where: { ...scope, OR: [{ status: { in: ['DRAFT', 'ACTIVE'] } }, { status: 'COMPLETED', completedAt: { gte: ago90 } }] }, select: { id: true, status: true, startDate: true, employeeCodeSnapshot: true, employeeNameSnapshot: true, departmentSnapshot: true, tasks: { select: { status: true, required: true, dueDate: true, assigneeUserId: true } } } }),
      prisma.probationCase.findMany({ where: { ...(scope as Prisma.ProbationCaseWhereInput), OR: [{ status: { in: ['ACTIVE', 'PENDING_REVIEW', 'EXTENDED'] } }, { finalizedAt: { gte: ago90 } }] }, select: { id: true, status: true, currentEndDate: true, employeeCodeSnapshot: true, employeeNameSnapshot: true, departmentSnapshot: true } }),
      prisma.offboardingCase.findMany({ where: { ...(scope as Prisma.OffboardingCaseWhereInput), OR: [{ status: { in: ['ACTIVE', 'READY_TO_COMPLETE'] } }, { status: 'COMPLETED', completedAt: { gte: ago90 } }] }, select: { id: true, status: true, plannedLastWorkingDate: true, employeeCodeSnapshot: true, employeeNameSnapshot: true, departmentSnapshot: true, tasks: { select: { status: true, required: true, dueDate: true, assigneeUserId: true } } } }),
    ]);
    const openTasks = (tasks: { status: string; dueDate: string; assigneeUserId: string | null }[]) => tasks.filter((x) => x.status === 'PENDING' || x.status === 'IN_PROGRESS');
    const activePlans = plans.filter((p) => p.status === 'ACTIVE');
    const pcts = activePlans.map((p) => checklistProgress(p.tasks).pct);
    const upcoming: LifecycleDashboardDto['upcoming'] = withNames ? [
      ...plans.filter((p) => p.status !== 'COMPLETED' && p.startDate >= t && p.startDate <= in30).map((p) => ({ kind: 'START' as const, date: p.startDate, employeeCode: p.employeeCodeSnapshot, employeeName: p.employeeNameSnapshot, department: p.departmentSnapshot, id: p.id })),
      ...cases.filter((c) => ['ACTIVE', 'PENDING_REVIEW', 'EXTENDED'].includes(c.status) && c.currentEndDate <= in30).map((c) => ({ kind: 'PROBATION_END' as const, date: c.currentEndDate, employeeCode: c.employeeCodeSnapshot, employeeName: c.employeeNameSnapshot, department: c.departmentSnapshot, id: c.id })),
      ...offs.filter((o) => o.status !== 'COMPLETED' && o.plannedLastWorkingDate <= in30).map((o) => ({ kind: 'LAST_DAY' as const, date: o.plannedLastWorkingDate, employeeCode: o.employeeCodeSnapshot, employeeName: o.employeeNameSnapshot, department: o.departmentSnapshot, id: o.id })),
    ].sort((a, b) => a.date.localeCompare(b.date)).slice(0, 20) : [];
    return {
      onboarding: { active: activePlans.length, draft: plans.filter((p) => p.status === 'DRAFT').length, completedLast90Days: plans.filter((p) => p.status === 'COMPLETED').length, overdueTasks: activePlans.reduce((s, p) => s + openTasks(p.tasks).filter((x) => x.dueDate < t).length, 0), unassignedTasks: activePlans.reduce((s, p) => s + openTasks(p.tasks).filter((x) => !x.assigneeUserId).length, 0), avgProgressPct: pcts.length ? Math.round((pcts.reduce((a, b) => a + b, 0) / pcts.length) * 10) / 10 : null },
      probation: { active: cases.filter((c) => c.status === 'ACTIVE' || c.status === 'EXTENDED').length, pendingReview: cases.filter((c) => c.status === 'PENDING_REVIEW').length, dueWithin14Days: cases.filter((c) => ['ACTIVE', 'PENDING_REVIEW', 'EXTENDED'].includes(c.status) && c.currentEndDate <= in14).length, passedLast90Days: cases.filter((c) => c.status === 'PASSED').length, extendedLast90Days: cases.filter((c) => c.status === 'EXTENDED').length, notPassedLast90Days: cases.filter((c) => c.status === 'NOT_PASSED').length },
      offboarding: { active: offs.filter((o) => o.status === 'ACTIVE').length, readyToComplete: offs.filter((o) => o.status === 'READY_TO_COMPLETE').length, departuresNext30Days: offs.filter((o) => o.status !== 'COMPLETED' && o.plannedLastWorkingDate <= in30 && o.plannedLastWorkingDate >= t).length, completedLast90Days: offs.filter((o) => o.status === 'COMPLETED').length, overdueTasks: offs.filter((o) => o.status !== 'COMPLETED').reduce((s, o) => s + openTasks(o.tasks).filter((x) => x.dueDate < t).length, 0) },
      upcoming, generatedAt: new Date().toISOString(),
    };
  },

  async report(auth: AuthContext, q: { from?: string; to?: string; organizationId?: string }): Promise<LifecycleReportDto> {
    const scope = await lifecycleEmployeeWhere(auth);
    const t = today(); const from = q.from ?? `${t.slice(0, 4)}-01-01`; const to = q.to ?? t;
    const org = q.organizationId ? { organizationSnapshot: (await prisma.organization.findUnique({ where: { id: q.organizationId }, select: { name: true } }))?.name ?? '?' } : {};
    const [plans, cases, offs] = await Promise.all([
      prisma.onboardingPlan.findMany({ where: { ...scope, ...org, startDate: { gte: from, lte: to } }, select: { status: true, departmentSnapshot: true, tasks: { select: { status: true, required: true, dueDate: true } } } }),
      prisma.probationCase.findMany({ where: { ...(scope as Prisma.ProbationCaseWhereInput), ...org, OR: [{ startDate: { gte: from, lte: to } }, { finalizedAt: { gte: new Date(`${from}T00:00:00Z`), lte: new Date(`${to}T23:59:59Z`) } }, { status: { in: ['ACTIVE', 'PENDING_REVIEW', 'EXTENDED'] } }] }, select: { status: true, currentEndDate: true, departmentSnapshot: true, finalizedAt: true } }),
      prisma.offboardingCase.findMany({ where: { ...(scope as Prisma.OffboardingCaseWhereInput), ...org, OR: [{ plannedLastWorkingDate: { gte: from, lte: to } }, { status: { in: ['ACTIVE', 'READY_TO_COMPLETE'] } }] }, select: { status: true, reasonCode: true, departmentSnapshot: true, plannedLastWorkingDate: true, completedAt: true } }),
    ]);
    const group = <T, K extends string>(rows: T[], key: (r: T) => K) => { const m = new Map<K, T[]>(); for (const r of rows) { const k = key(r); m.set(k, [...(m.get(k) ?? []), r]); } return m; };
    const byDeptPlans = [...group(plans, (p) => p.departmentSnapshot ?? '—')].map(([department, rows]) => { const pcts = rows.filter((p) => p.status === 'ACTIVE').map((p) => checklistProgress(p.tasks).pct); return { department, plans: rows.length, completed: rows.filter((p) => p.status === 'COMPLETED').length, avgProgressPct: pcts.length ? Math.round((pcts.reduce((a, b) => a + b, 0) / pcts.length) * 10) / 10 : null }; }).sort((a, b) => a.department.localeCompare(b.department));
    const completedPlans = plans.filter((p) => p.status === 'COMPLETED').length;
    const open = ['ACTIVE', 'PENDING_REVIEW', 'EXTENDED'];
    const in14 = addCalendarDays(t, 14);
    const finalized = cases.filter((c) => c.finalizedAt);
    return {
      range: { from, to },
      onboarding: { plansStarted: plans.length, plansCompleted: completedPlans, completionRate: plans.length ? Math.round((completedPlans / plans.length) * 1000) / 10 : null, overdueTasks: plans.filter((p) => p.status === 'ACTIVE').reduce((s, p) => s + p.tasks.filter((x) => (x.status === 'PENDING' || x.status === 'IN_PROGRESS') && x.dueDate < t).length, 0), byDepartment: byDeptPlans },
      probation: {
        active: cases.filter((c) => open.includes(c.status)).length, dueSoon: cases.filter((c) => open.includes(c.status) && c.currentEndDate <= in14).length, passed: cases.filter((c) => c.status === 'PASSED').length, extended: cases.filter((c) => c.status === 'EXTENDED').length, notPassed: cases.filter((c) => c.status === 'NOT_PASSED').length,
        byDepartment: [...group(cases, (c) => c.departmentSnapshot ?? '—')].map(([department, rows]) => ({ department, active: rows.filter((c) => open.includes(c.status)).length, passed: rows.filter((c) => c.status === 'PASSED').length, extended: rows.filter((c) => c.status === 'EXTENDED').length, notPassed: rows.filter((c) => c.status === 'NOT_PASSED').length })).sort((a, b) => a.department.localeCompare(b.department)),
        byMonth: [...group(finalized, (c) => monthOf(c.finalizedAt) ?? '—')].map(([month, rows]) => ({ month, passed: rows.filter((c) => c.status === 'PASSED').length, extended: 0, notPassed: rows.filter((c) => c.status === 'NOT_PASSED').length })).sort((a, b) => a.month.localeCompare(b.month)),
      },
      offboarding: {
        active: offs.filter((o) => o.status === 'ACTIVE' || o.status === 'READY_TO_COMPLETE').length, upcomingDepartures: offs.filter((o) => o.status !== 'COMPLETED' && o.status !== 'CANCELLED' && o.plannedLastWorkingDate >= t).length, completedSeparations: offs.filter((o) => o.status === 'COMPLETED').length,
        byReason: [...group(offs.filter((o) => o.status !== 'CANCELLED'), (o) => o.reasonCode)].map(([reason, rows]) => ({ reason, count: rows.length })).sort((a, b) => b.count - a.count),
        byMonth: [...group(offs.filter((o) => o.status === 'COMPLETED'), (o) => monthOf(o.completedAt) ?? '—')].map(([month, rows]) => ({ month, completed: rows.length })).sort((a, b) => a.month.localeCompare(b.month)),
        byDepartment: [...group(offs.filter((o) => o.status !== 'CANCELLED'), (o) => o.departmentSnapshot ?? '—')].map(([department, rows]) => ({ department, active: rows.filter((o) => o.status === 'ACTIVE' || o.status === 'READY_TO_COMPLETE').length, completed: rows.filter((o) => o.status === 'COMPLETED').length })).sort((a, b) => a.department.localeCompare(b.department)),
      },
    };
  },
};
