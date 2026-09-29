import type { Prisma } from '@prisma/client';
import type { BenefitsDashboardDto, BenefitsReportDto } from '@hr/shared';
import { prisma } from '../../lib/prisma';
import { ZERO, dec, money, toMoneyString } from '../payroll/money';
import { availableOf, sumsOf } from './benefit-ledger';
import { today } from './benefits.types';

/**
 * Aggregates only. Rows are grouped by plan and category, organization-wide: no employee, no department (a department
 * of three people with one health claim is a person), no description, no document, no payment reference, no claim
 * number. All money is Decimal summed and returned as strings.
 */
const DEFINITIONS = {
  granted: 'Σ GRANT rows on entitlement ledgers of the selected plans.', reserved: 'Σ RESERVE + Σ RELEASE (amounts held by claims still waiting for a decision).', consumed: 'Σ CONSUME rows (approved claims). Consumed is not paid.',
  available: 'granted + adjustment − reserved − consumed.', claimedPending: 'Claimed amounts of claims in PENDING_APPROVAL.', readyForPayment: 'Approved amounts of claims in READY_FOR_PAYMENT (approved, not yet paid or handed to payroll).', sentToPayroll: 'Approved amounts of claims in SENT_TO_PAYROLL (handed to a payroll run, not yet recorded paid).', approved: 'Approved amounts of claims approved in the range (READY_FOR_PAYMENT, SENT_TO_PAYROLL or PAID).', paid: 'Approved amounts of claims recorded PAID in the range.',
  claimsByStatus: 'Counts by current status; amounts are claimed amounts.',
};
const sum = (xs: Prisma.Decimal[]) => money(xs.reduce((a, b) => a.plus(b), ZERO));

export const benefitsReportService = {
  /** Current state. With an organization, rows are those whose organization snapshot matches (plans: that organization's or global). */
  async dashboard(q: { organizationId?: string } = {}): Promise<BenefitsDashboardDto> {
    const orgName = q.organizationId ? (await prisma.organization.findUnique({ where: { id: q.organizationId }, select: { name: true } }))?.name ?? '?' : null;
    const snap = orgName ? { organizationSnapshot: orgName } : {};
    const planWhere: Prisma.BenefitPlanWhereInput = q.organizationId ? { OR: [{ organizationId: q.organizationId }, { organizationId: null }] } : {};
    const [plans, enrollments, periods, claims, entitlements] = await Promise.all([
      prisma.benefitPlan.groupBy({ by: ['status'], where: planWhere, _count: { _all: true } }), prisma.benefitEnrollment.groupBy({ by: ['status'], where: snap, _count: { _all: true } }), prisma.benefitPeriod.count({ where: { status: 'OPEN', plan: planWhere } }),
      prisma.benefitClaim.findMany({ where: snap, select: { status: true, currency: true, claimedAmount: true, approvedAmount: true } }), prisma.benefitEntitlement.findMany({ where: snap, select: { currency: true, grantedAmount: true, adjustmentAmount: true, reservedAmount: true, consumedAmount: true } }),
    ]);
    const count = (rows: { status: string; _count: { _all: number } }[], st: string) => rows.find((r) => r.status === st)?._count._all ?? 0;
    const currencies = [...new Set([...claims.map((c) => c.currency), ...entitlements.map((e) => e.currency)])].sort();
    return {
      plans: { active: count(plans, 'ACTIVE'), draft: count(plans, 'DRAFT'), inactive: count(plans, 'INACTIVE') + count(plans, 'ARCHIVED') }, enrollments: { enrolled: count(enrollments, 'ENROLLED'), waived: count(enrollments, 'WAIVED'), eligible: count(enrollments, 'ELIGIBLE') }, periods: { open: periods },
      claims: { draft: claims.filter((c) => c.status === 'DRAFT').length, pendingApproval: claims.filter((c) => c.status === 'PENDING_APPROVAL').length, readyForPayment: claims.filter((c) => c.status === 'READY_FOR_PAYMENT').length, sentToPayroll: claims.filter((c) => c.status === 'SENT_TO_PAYROLL').length, paid: claims.filter((c) => c.status === 'PAID').length, rejected: claims.filter((c) => c.status === 'REJECTED').length, cancelled: claims.filter((c) => c.status === 'CANCELLED').length },
      money: currencies.map((currency) => { const ents = entitlements.filter((e) => e.currency === currency); const cl = claims.filter((c) => c.currency === currency); return { currency, granted: toMoneyString(sum(ents.map((e) => e.grantedAmount))), reserved: toMoneyString(sum(ents.map((e) => e.reservedAmount))), consumed: toMoneyString(sum(ents.map((e) => e.consumedAmount))), available: toMoneyString(sum(ents.map((e) => availableOf(sumsOf(e))))), claimedPending: toMoneyString(sum(cl.filter((c) => c.status === 'PENDING_APPROVAL').map((c) => c.claimedAmount))), approved: toMoneyString(sum(cl.filter((c) => ['READY_FOR_PAYMENT', 'SENT_TO_PAYROLL', 'PAID'].includes(c.status)).map((c) => c.approvedAmount ?? ZERO))), readyForPayment: toMoneyString(sum(cl.filter((c) => c.status === 'READY_FOR_PAYMENT').map((c) => c.approvedAmount ?? ZERO))), sentToPayroll: toMoneyString(sum(cl.filter((c) => c.status === 'SENT_TO_PAYROLL').map((c) => c.approvedAmount ?? ZERO))), paid: toMoneyString(sum(cl.filter((c) => c.status === 'PAID').map((c) => c.approvedAmount ?? ZERO))) }; }),
      definitions: DEFINITIONS, generatedAt: new Date().toISOString(),
    };
  },
  async report(q: { from?: string; to?: string; organizationId?: string }): Promise<BenefitsReportDto> {
    const t = today(); const from = q.from ?? `${t.slice(0, 4)}-01-01`; const to = q.to ?? t;
    const orgName = q.organizationId ? (await prisma.organization.findUnique({ where: { id: q.organizationId }, select: { name: true } }))?.name ?? '?' : null;
    const [plans, enrollments, entitlements, claims] = await Promise.all([
      prisma.benefitPlan.findMany({ where: q.organizationId ? { OR: [{ organizationId: q.organizationId }, { organizationId: null }] } : {}, include: { category: { select: { name: true } } } }),
      prisma.benefitEnrollment.findMany({ where: { status: 'ENROLLED', ...(orgName ? { organizationSnapshot: orgName } : {}) }, select: { planId: true } }),
      prisma.benefitEntitlement.findMany({ where: orgName ? { organizationSnapshot: orgName } : {}, select: { planId: true, currency: true, grantedAmount: true, adjustmentAmount: true, reservedAmount: true, consumedAmount: true } }),
      prisma.benefitClaim.findMany({ where: { ...(orgName ? { organizationSnapshot: orgName } : {}), OR: [{ submittedDate: { gte: from, lte: to } }, { paidDate: { gte: from, lte: to } }, { status: { in: ['DRAFT', 'PENDING_APPROVAL'] } }] }, select: { planId: true, status: true, currency: true, claimedAmount: true, approvedAmount: true, submittedDate: true, paidDate: true } }),
    ]);
    const inRange = (d: string | null) => !!d && d >= from && d <= to;
    const byPlan = plans.map((p) => {
      const ents = entitlements.filter((e) => e.planId === p.id); const cl = claims.filter((c) => c.planId === p.id && (inRange(c.submittedDate) || c.status === 'DRAFT'));
      const approved = cl.filter((c) => ['READY_FOR_PAYMENT', 'SENT_TO_PAYROLL', 'PAID'].includes(c.status));
      return { plan: p.name, category: p.category.name, planType: p.planType, currency: p.currency, enrolled: enrollments.filter((e) => e.planId === p.id).length, entitlements: ents.length, granted: toMoneyString(sum(ents.map((e) => e.grantedAmount))), consumed: toMoneyString(sum(ents.map((e) => e.consumedAmount))), available: toMoneyString(sum(ents.map((e) => availableOf(sumsOf(e))))), claims: cl.length, approvedClaims: approved.length, rejectedClaims: cl.filter((c) => c.status === 'REJECTED').length, approvedAmount: toMoneyString(sum(approved.map((c) => c.approvedAmount ?? ZERO))), paidAmount: toMoneyString(sum(cl.filter((c) => c.status === 'PAID' && inRange(c.paidDate)).map((c) => c.approvedAmount ?? ZERO))) };
    }).sort((a, b) => a.plan.localeCompare(b.plan));
    const cats = new Map<string, typeof byPlan>(); for (const r of byPlan) cats.set(r.category, [...(cats.get(r.category) ?? []), r]);
    const byCategory = [...cats].map(([category, rows]) => ({ category, plans: rows.length, enrolled: rows.reduce((n, r) => n + r.enrolled, 0), claims: rows.reduce((n, r) => n + r.claims, 0), approvedAmount: toMoneyString(sum(rows.map((r) => dec(r.approvedAmount)))) })).sort((a, b) => a.category.localeCompare(b.category));
    const statuses = new Map<string, Prisma.Decimal[]>(); for (const c of claims.filter((c) => inRange(c.submittedDate) || c.status === 'DRAFT' || c.status === 'PENDING_APPROVAL')) statuses.set(c.status, [...(statuses.get(c.status) ?? []), c.claimedAmount]);
    return { range: { from, to }, byPlan, byCategory, claimsByStatus: [...statuses].map(([status, amounts]) => ({ status, count: amounts.length, amount: toMoneyString(sum(amounts)) })).sort((a, b) => a.status.localeCompare(b.status)) };
  },
};
