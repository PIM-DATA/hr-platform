import type { Prisma } from '@prisma/client';
import type { ExpenseDashboardDto, ExpenseReportsDto } from '@hr/shared';
import { prisma } from '../../lib/prisma';
import { ZERO, money, toMoneyString } from '../payroll/money';
import { today } from './expense.types';

/** Aggregates only: by policy, category and month, organization-wide. No person, number, merchant, description, receipt or reference. */
const DEFINITIONS = { pendingTotal: 'Σ totals of reports in PENDING_APPROVAL.', readyTotal: 'Σ totals of reports in READY_FOR_PAYMENT or SENT_TO_PAYROLL (approved, not yet recorded paid).', readyForPaymentTotal: 'Σ totals of reports in READY_FOR_PAYMENT only.', sentToPayrollTotal: 'Σ totals of reports in SENT_TO_PAYROLL only (handed to payroll, not yet recorded paid).', paidThisMonth: 'Σ totals of reports with a paid date in the current month.', paidYearToDate: 'Σ totals of reports with a paid date in the current year.', travel: 'Travel request counts by status; the estimate is what was requested, never what was spent.' };
const sum = (xs: Prisma.Decimal[]) => money(xs.reduce((a, b) => a.plus(b), ZERO));
export const expenseAnalyticsService = {
  /** Current state. With an organization, rows are those whose organization snapshot matches. */
  async dashboard(q: { organizationId?: string } = {}): Promise<ExpenseDashboardDto> {
    const t = today();
    const orgName = q.organizationId ? (await prisma.organization.findUnique({ where: { id: q.organizationId }, select: { name: true } }))?.name ?? '?' : null;
    const snap = orgName ? { organizationSnapshot: orgName } : {};
    const [travel, reports] = await Promise.all([prisma.travelRequest.groupBy({ by: ['status'], where: snap, _count: { _all: true } }), prisma.expenseReport.findMany({ where: snap, select: { status: true, currency: true, totalAmount: true, paidDate: true } })]);
    const count = (st: string) => travel.find((r) => r.status === st)?._count._all ?? 0;
    const currencies = [...new Set(reports.map((r) => r.currency))].sort();
    return {
      travel: { draft: count('DRAFT'), pendingApproval: count('PENDING_APPROVAL'), approved: count('APPROVED'), completed: count('COMPLETED') },
      reports: { draft: reports.filter((r) => r.status === 'DRAFT').length, pendingApproval: reports.filter((r) => r.status === 'PENDING_APPROVAL').length, readyForPayment: reports.filter((r) => r.status === 'READY_FOR_PAYMENT').length, sentToPayroll: reports.filter((r) => r.status === 'SENT_TO_PAYROLL').length, paid: reports.filter((r) => r.status === 'PAID').length, rejected: reports.filter((r) => r.status === 'REJECTED').length },
      money: currencies.map((currency) => { const rs = reports.filter((r) => r.currency === currency); return { currency, pendingTotal: toMoneyString(sum(rs.filter((r) => r.status === 'PENDING_APPROVAL').map((r) => r.totalAmount))), readyTotal: toMoneyString(sum(rs.filter((r) => r.status === 'READY_FOR_PAYMENT' || r.status === 'SENT_TO_PAYROLL').map((r) => r.totalAmount))), readyForPaymentTotal: toMoneyString(sum(rs.filter((r) => r.status === 'READY_FOR_PAYMENT').map((r) => r.totalAmount))), sentToPayrollTotal: toMoneyString(sum(rs.filter((r) => r.status === 'SENT_TO_PAYROLL').map((r) => r.totalAmount))), paidThisMonth: toMoneyString(sum(rs.filter((r) => r.status === 'PAID' && r.paidDate?.startsWith(t.slice(0, 7))).map((r) => r.totalAmount))), paidYearToDate: toMoneyString(sum(rs.filter((r) => r.status === 'PAID' && r.paidDate?.startsWith(t.slice(0, 4))).map((r) => r.totalAmount))) }; }),
      definitions: DEFINITIONS, generatedAt: new Date().toISOString(),
    };
  },
  async report(q: { from?: string; to?: string; organizationId?: string }): Promise<ExpenseReportsDto> {
    const t = today(); const from = q.from ?? `${t.slice(0, 4)}-01-01`; const to = q.to ?? t;
    const orgName = q.organizationId ? (await prisma.organization.findUnique({ where: { id: q.organizationId }, select: { name: true } }))?.name ?? '?' : null;
    const orgWhere = orgName ? { organizationSnapshot: orgName } : {};
    const [reports, items, travel] = await Promise.all([
      prisma.expenseReport.findMany({ where: { ...orgWhere, status: { not: 'DRAFT' }, submittedAt: { gte: new Date(`${from}T00:00:00Z`), lte: new Date(`${to}T23:59:59Z`) } }, select: { status: true, currency: true, totalAmount: true, submittedAt: true, paidDate: true, policyNameSnapshot: true, items: { select: { categoryNameSnapshot: true, amount: true } } } }),
      Promise.resolve(null), prisma.travelRequest.findMany({ where: { ...orgWhere, status: { not: 'DRAFT' }, submittedAt: { gte: new Date(`${from}T00:00:00Z`), lte: new Date(`${to}T23:59:59Z`) } }, select: { status: true, currency: true, estimatedAmount: true, submittedAt: true } }),
    ]);
    void items;
    const group = <T, K extends string>(rows: T[], key: (r: T) => K) => { const m = new Map<K, T[]>(); for (const r of rows) m.set(key(r), [...(m.get(key(r)) ?? []), r]); return m; };
    const approved = (s: string) => ['READY_FOR_PAYMENT', 'SENT_TO_PAYROLL', 'PAID'].includes(s);
    const byPolicy = [...group(reports, (r) => `${r.policyNameSnapshot}|${r.currency}`)].map(([k, rows]) => ({ policy: k.split('|')[0], currency: k.split('|')[1], reports: rows.length, submittedTotal: toMoneyString(sum(rows.map((r) => r.totalAmount))), readyTotal: toMoneyString(sum(rows.filter((r) => approved(r.status)).map((r) => r.totalAmount))), paidTotal: toMoneyString(sum(rows.filter((r) => r.status === 'PAID').map((r) => r.totalAmount))), rejected: rows.filter((r) => r.status === 'REJECTED').length })).sort((a, b) => a.policy.localeCompare(b.policy));
    const catRows = reports.flatMap((r) => r.items.map((i) => ({ category: i.categoryNameSnapshot, currency: r.currency, amount: i.amount })));
    const byCategory = [...group(catRows, (r) => `${r.category}|${r.currency}`)].map(([k, rows]) => ({ category: k.split('|')[0], currency: k.split('|')[1], items: rows.length, total: toMoneyString(sum(rows.map((r) => r.amount))) })).sort((a, b) => a.category.localeCompare(b.category));
    const byMonth = [...group(reports, (r) => `${r.submittedAt!.toISOString().slice(0, 7)}|${r.currency}`)].map(([k, rows]) => ({ month: k.split('|')[0], currency: k.split('|')[1], reports: rows.length, total: toMoneyString(sum(rows.map((r) => r.totalAmount))), paid: toMoneyString(sum(rows.filter((r) => r.status === 'PAID').map((r) => r.totalAmount))) })).sort((a, b) => a.month.localeCompare(b.month));
    // Task 48 (T44-P2-15): travel estimates are keyed by currency like every other money figure here.
    const travelByMonth = [...group(travel, (r) => `${r.submittedAt!.toISOString().slice(0, 7)}|${r.currency}`)].map(([k, rows]) => ({ month: k.split('|')[0]!, currency: k.split('|')[1]!, requests: rows.length, estimatedTotal: toMoneyString(sum(rows.map((r) => r.estimatedAmount))) })).sort((a, b) => a.month.localeCompare(b.month) || a.currency.localeCompare(b.currency));
    return { range: { from, to }, byPolicy, byCategory, byMonth, travel: { requests: travel.length, approved: travel.filter((r) => r.status === 'APPROVED' || r.status === 'COMPLETED').length, rejected: travel.filter((r) => r.status === 'REJECTED').length, estimatedByCurrency: [...group(travel, (r) => r.currency)].map(([currency, rows]) => ({ currency, requests: rows.length, estimatedTotal: toMoneyString(sum(rows.map((r) => r.estimatedAmount))) })).sort((a, b) => a.currency.localeCompare(b.currency)), byMonth: travelByMonth } };
  },
};
