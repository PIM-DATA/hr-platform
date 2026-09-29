import { Prisma } from '@prisma/client';
import { PERMISSIONS, type BenefitsExecutiveDto, type EmployeeServicesExecutiveDto, type EngagementExecutiveDto, type ExpenseExecutiveDto, type LearningExecutiveDto, type LifecycleExecutiveDto, type WorkforcePlanningExecutiveDto } from '@hr/shared';
import { prisma } from '../../lib/prisma';
import { hasPermission } from '../../services/authorization/authorization.service';
import type { AuthContext } from '../auth/auth.types';
import { benefitsReportService } from '../benefits/benefits-report.service';
import { expenseAnalyticsService } from '../expense/expense-analytics.service';
import { serviceAnalyticsService } from '../employee-services/services-analytics.service';
import { lifecycleReportService } from '../lifecycle/lifecycle-report.service';
import { learningReportService } from '../learning/learning-report.service';
import { workforcePlanService } from '../workforce/plan.service';
import { resultsService } from '../engagement/results.service';

/**
 * Task 42 — organization-level roll-ups of the newer domains, shared by the executive dashboard and the copilot.
 *
 * Every figure comes from the domain's own report service (the same one its reports page uses); this file only
 * picks, regroups by currency and discards. Nothing here reads a benefit claim, expense report or service request
 * row directly, and nothing leaves with an employee, a number, a description, a merchant, a purpose, a message, a
 * letter body, a salary, a document or a payment reference. Money stays an exact decimal string per currency.
 *
 * Permission: each roll-up needs the permission its module's report route needs. The executive permission alone
 * opens none of them, and a copilot tool that wraps one is offered only to holders of the same permission.
 */
export type RollupKey = 'benefits' | 'expense' | 'employeeServices' | 'lifecycle' | 'learning' | 'workforcePlanning' | 'engagement';
export const ROLLUP_PERMISSIONS: Record<RollupKey, string[]> = {
  benefits: [PERMISSIONS.BENEFITS_VIEW_REPORTS, PERMISSIONS.BENEFITS_MANAGE],
  expense: [PERMISSIONS.EXPENSE_VIEW_REPORTS, PERMISSIONS.EXPENSE_MANAGE],
  employeeServices: [PERMISSIONS.HR_LETTER_VIEW_REPORTS, PERMISSIONS.SERVICE_REQUEST_MANAGE],
  lifecycle: [PERMISSIONS.LIFECYCLE_VIEW_REPORTS, PERMISSIONS.ONBOARDING_MANAGE, PERMISSIONS.PROBATION_MANAGE, PERMISSIONS.OFFBOARDING_MANAGE],
  learning: [PERMISSIONS.LEARNING_VIEW_REPORTS, PERMISSIONS.OJT_MANAGE, PERMISSIONS.LEARNING_PATH_MANAGE, PERMISSIONS.CERTIFICATION_MANAGE],
  workforcePlanning: [PERMISSIONS.WORKFORCE_VIEW, PERMISSIONS.WORKFORCE_PLAN, PERMISSIONS.WORKFORCE_MANAGE],
  engagement: [PERMISSIONS.ENGAGEMENT_VIEW_RESULTS, PERMISSIONS.ENGAGEMENT_MANAGE],
};
export const mayRollup = (auth: AuthContext, key: RollupKey) => ROLLUP_PERMISSIONS[key].some((p) => hasPermission(auth, p));

export interface RollupFilter { from: string; to: string; organizationId?: string }

/** Decimal sums of source-produced decimal strings, grouped by a key. Never a Number. */
function sumBy<T>(rows: T[], key: (r: T) => string, fields: (keyof T)[]) {
  const out = new Map<string, { count: number; sums: Map<keyof T, Prisma.Decimal> }>();
  for (const r of rows) {
    const k = key(r);
    const g = out.get(k) ?? { count: 0, sums: new Map(fields.map((f) => [f, new Prisma.Decimal(0)])) };
    g.count += 1;
    for (const f of fields) g.sums.set(f, g.sums.get(f)!.plus(String(r[f] ?? '0')));
    out.set(k, g);
  }
  return [...out.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, g]) => ({ key: k, count: g.count, sum: (f: keyof T) => g.sums.get(f)!.toFixed(2) }));
}

export const domainRollups = {
  async benefits(f: RollupFilter): Promise<BenefitsExecutiveDto> {
    const [d, r] = await Promise.all([benefitsReportService.dashboard({ organizationId: f.organizationId }), benefitsReportService.report({ from: f.from, to: f.to, organizationId: f.organizationId })]);
    // Plans carry their own currency; the report's per-category total is regrouped by currency here so two currencies are never added.
    const priced = r.byPlan.filter((p) => p.currency);
    return {
      range: r.range,
      current: {
        activePlans: d.plans.active, enrolled: d.enrollments.enrolled,
        coverageOnlyEnrolled: r.byPlan.filter((p) => p.planType === 'COVERAGE_ONLY').reduce((n, p) => n + p.enrolled, 0),
        claims: { pendingApproval: d.claims.pendingApproval, readyForPayment: d.claims.readyForPayment, sentToPayroll: d.claims.sentToPayroll, paid: d.claims.paid, rejected: d.claims.rejected },
        money: d.money.map((m) => ({ currency: m.currency, granted: m.granted, consumed: m.consumed, available: m.available, claimedPending: m.claimedPending, readyForPayment: m.readyForPayment, sentToPayroll: m.sentToPayroll, paid: m.paid })),
      },
      inRange: {
        claimsByStatus: r.claimsByStatus.map((c) => ({ status: c.status, count: c.count })),
        money: sumBy(priced, (p) => p.currency!, ['approvedAmount', 'paidAmount']).map((g) => ({ currency: g.key, approvedAmount: g.sum('approvedAmount'), paidAmount: g.sum('paidAmount') })),
        byCategory: sumBy(r.byPlan, (p) => `${p.category}\u0000${p.currency ?? ''}`, ['approvedAmount']).map((g) => {
          const [category, currency] = g.key.split('\u0000');
          const rows = r.byPlan.filter((p) => p.category === category && (p.currency ?? '') === currency);
          return { category: category!, currency: currency || null, plans: g.count, enrolled: rows.reduce((n, p) => n + p.enrolled, 0), claims: rows.reduce((n, p) => n + p.claims, 0), approvedAmount: g.sum('approvedAmount') };
        }),
      },
    };
  },

  async expense(f: RollupFilter): Promise<ExpenseExecutiveDto> {
    const [d, r] = await Promise.all([expenseAnalyticsService.dashboard({ organizationId: f.organizationId }), expenseAnalyticsService.report({ from: f.from, to: f.to, organizationId: f.organizationId })]);
    return {
      range: r.range,
      current: {
        travel: { pendingApproval: d.travel.pendingApproval, approved: d.travel.approved },
        reports: { pendingApproval: d.reports.pendingApproval, readyForPayment: d.reports.readyForPayment, sentToPayroll: d.reports.sentToPayroll, paid: d.reports.paid, rejected: d.reports.rejected },
        money: d.money.map((m) => ({ currency: m.currency, pendingTotal: m.pendingTotal, readyForPaymentTotal: m.readyForPaymentTotal, sentToPayrollTotal: m.sentToPayrollTotal })),
      },
      inRange: {
        reports: r.byPolicy.reduce((n, p) => n + p.reports, 0),
        // The report's `readyTotal` per policy counts every approved report (ready, sent to payroll or paid): here it is named approvedTotal.
        money: sumBy(r.byPolicy, (p) => p.currency, ['submittedTotal', 'readyTotal', 'paidTotal']).map((g) => ({ currency: g.key, reports: r.byPolicy.filter((p) => p.currency === g.key).reduce((n, p) => n + p.reports, 0), submittedTotal: g.sum('submittedTotal'), approvedTotal: g.sum('readyTotal'), paidTotal: g.sum('paidTotal') })),
        travel: { requests: r.travel.requests, approved: r.travel.approved, rejected: r.travel.rejected, estimated: r.travel.estimatedByCurrency },
        byCategory: r.byCategory,
        byMonth: r.byMonth,
      },
    };
  },

  async employeeServices(f: RollupFilter): Promise<EmployeeServicesExecutiveDto> {
    const [d, r] = await Promise.all([serviceAnalyticsService.dashboard({ organizationId: f.organizationId }), serviceAnalyticsService.report({ from: f.from, to: f.to, organizationId: f.organizationId })]);
    return {
      range: r.range,
      current: { open: d.requests.submitted + d.requests.inProgress + d.requests.waitingEmployee, submitted: d.requests.submitted, inProgress: d.requests.inProgress, waitingEmployee: d.requests.waitingEmployee, overdue: d.requests.overdue },
      inRange: {
        totals: r.totals,
        byCategory: r.byCategory,
        byMonth: r.byMonth,
        letters: { issued: r.letters.byType.reduce((n, l) => n + l.issued, 0), voided: r.letters.byType.reduce((n, l) => n + l.voided, 0), byType: r.letters.byType },
      },
    };
  },

  async lifecycle(auth: AuthContext, f: RollupFilter): Promise<LifecycleExecutiveDto> {
    const r = await lifecycleReportService.report(auth, f);
    return {
      range: r.range,
      onboarding: { plansStarted: r.onboarding.plansStarted, plansCompleted: r.onboarding.plansCompleted, completionRate: r.onboarding.completionRate, overdueTasks: r.onboarding.overdueTasks },
      probation: { active: r.probation.active, dueSoon: r.probation.dueSoon, passed: r.probation.passed, extended: r.probation.extended, notPassed: r.probation.notPassed },
      offboarding: { active: r.offboarding.active, upcomingDepartures: r.offboarding.upcomingDepartures, completedSeparations: r.offboarding.completedSeparations },
    };
  },

  async learning(auth: AuthContext, f: RollupFilter): Promise<LearningExecutiveDto> {
    const r = await learningReportService.report(auth, f);
    return {
      range: r.range,
      ojt: { plans: r.ojt.plans, active: r.ojt.active, completed: r.ojt.completed, avgCompletionDays: r.ojt.avgCompletionDays },
      paths: { assigned: r.paths.assigned, inProgress: r.paths.inProgress, completed: r.paths.completed },
      certifications: { active: r.certifications.active, expiringSoon: r.certifications.expiringSoon, expired: r.certifications.expired, revoked: r.certifications.revoked },
    };
  },

  /** The latest ACTIVE or FINALIZED cycle of the organization filter (any organization when none); live headcount only when there is none. */
  async workforcePlanning(auth: AuthContext, f: { organizationId?: string }): Promise<WorkforcePlanningExecutiveDto> {
    const cycle = await prisma.workforcePlanningCycle.findFirst({ where: { status: { in: ['ACTIVE', 'FINALIZED'] }, ...(f.organizationId ? { organizationId: f.organizationId } : {}) }, orderBy: [{ updatedAt: 'desc' }], select: { id: true } });
    const d = await workforcePlanService.dashboard(auth, cycle?.id ?? null);
    return { cycle: d.cycle ? { name: d.cycle.name, status: d.cycle.status } : null, currentHeadcount: d.currentHeadcount, plannedHeadcount: d.plannedHeadcount, netDelta: d.netDelta, expansionDemand: d.expansionDemand, plannedReductions: d.plannedReductions, vacantPositions: d.vacantPositions, remainingDemand: d.remainingDemand };
  },

  /** The engagement module applies its anonymity threshold inside `dashboard`; a suppressed eNPS stays null here. */
  async engagement(auth: AuthContext): Promise<EngagementExecutiveDto> {
    const d = await resultsService.dashboard(auth);
    return { openSurveys: d.openSurveys, closedSurveys: d.closedSurveys, openResponseRate: d.openResponseRate, latestEnps: d.latestEnps ? { surveyName: d.latestEnps.surveyName, score: d.latestEnps.suppressed ? null : d.latestEnps.score, suppressed: d.latestEnps.suppressed } : null };
  },
};
