import type { ReactNode } from 'react';
import { Navigate, Outlet } from 'react-router-dom';
import { PERMISSIONS } from '@hr/shared';
import { PageHeader } from '@/components/layout/PageHeader';
import { Tabs } from '@/components/ui/Tabs';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { useAuth } from '@/hooks/useAuth';

type Tone = 'success' | 'neutral' | 'warning' | 'danger' | 'info';
export const titleCase = (s: string) => s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, ' ');
const TONE: Record<string, Tone> = { DRAFT: 'neutral', ACTIVE: 'info', INACTIVE: 'neutral', ARCHIVED: 'neutral', OPEN: 'info', CLOSED: 'neutral', ELIGIBLE: 'neutral', ENROLLED: 'success', WAIVED: 'neutral', ENDED: 'neutral', PENDING_APPROVAL: 'warning', READY_FOR_PAYMENT: 'info', SENT_TO_PAYROLL: 'info', PAID: 'success', REJECTED: 'danger', CANCELLED: 'neutral', REIMBURSEMENT: 'info', ALLOWANCE: 'info', COVERAGE_ONLY: 'neutral' };
const LABEL: Record<string, string> = { PENDING_APPROVAL: 'Pending approval', READY_FOR_PAYMENT: 'Ready for payment', SENT_TO_PAYROLL: 'Sent to payroll', COVERAGE_ONLY: 'Coverage only' };
export function BenefitBadge({ status }: { status: string }) { return <StatusBadge status={LABEL[status] ?? titleCase(status)} tone={TONE[status] ?? 'neutral'} />; }
/** Money arrives as a decimal string and is shown as a decimal string: no arithmetic, no float, no rounding in the browser. */
export const money = (v: string | null | undefined, currency?: string | null) => (v === null || v === undefined ? '—' : `${v}${currency ? ` ${currency}` : ''}`);
export function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: string; tone?: 'warning' | 'danger' }) {
  return <div className={`rounded-lg border p-4 ${tone === 'danger' ? 'border-red-200 bg-red-50' : tone === 'warning' ? 'border-amber-200 bg-amber-50' : 'border-slate-200 bg-white'}`}><div className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</div><div className="mt-1 text-2xl font-semibold tabular-nums text-slate-900">{value}</div>{hint && <div className="mt-1 text-xs text-slate-500">{hint}</div>}</div>;
}
export const Table = ({ head, rows }: { head: string[]; rows: ReactNode[][] }) => (
  <div className="overflow-x-auto"><table className="min-w-full text-sm"><thead className="bg-slate-50"><tr>{head.map((h) => <th key={h} className="px-4 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">{h}</th>)}</tr></thead><tbody className="divide-y divide-slate-100">{rows.length === 0 ? <tr><td colSpan={head.length} className="px-4 py-4 text-sm text-slate-400">Nothing here.</td></tr> : rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} className="px-4 py-2 tabular-nums">{c}</td>)}</tr>)}</tbody></table></div>
);
export function BalanceBar({ balance }: { balance: { currency: string; granted: string; adjustment: string; reserved: string; consumed: string; available: string } }) {
  const item = (label: string, value: string, strong = false) => <div key={label} className="min-w-[7rem]"><div className="text-xs text-slate-500">{label}</div><div className={`tabular-nums ${strong ? 'font-semibold text-slate-900' : ''}`}>{value}</div></div>;
  return <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm">{item('Granted', money(balance.granted))}{item('Adjustments', money(balance.adjustment))}{item('Reserved', money(balance.reserved))}{item('Used', money(balance.consumed))}{item('Available', money(balance.available, balance.currency), true)}</div>;
}
export const fmtDate = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' }) : '—');

/** Tabs by capability. Administration needs the benefits permissions; the employee tab needs only an employee record. */
export function useBenefitsTabs() {
  const { hasPermission, user, scopeOf } = useAuth();
  const admin = scopeOf(PERMISSIONS.BENEFITS_VIEW, PERMISSIONS.BENEFITS_MANAGE) === 'ALL';
  const reports = hasPermission(PERMISSIONS.BENEFITS_VIEW_REPORTS) || hasPermission(PERMISSIONS.BENEFITS_MANAGE);
  return [
    (!!user?.employee && hasPermission(PERMISSIONS.BENEFITS_VIEW_OWN)) && { label: 'My benefits', to: '/hrm/benefits', end: true },
    reports && { label: 'Dashboard', to: '/hrm/benefits/dashboard' },
    admin && { label: 'Plans', to: '/hrm/benefits/plans' },
    admin && { label: 'Periods', to: '/hrm/benefits/periods' },
    admin && { label: 'Enrolments', to: '/hrm/benefits/enrollments' },
    admin && { label: 'Entitlements', to: '/hrm/benefits/entitlements' },
    admin && { label: 'Claims', to: '/hrm/benefits/claims' },
    admin && hasPermission(PERMISSIONS.BENEFITS_RECORD_PAYMENT) && { label: 'Payments', to: '/hrm/benefits/payments' },
    reports && { label: 'Reports', to: '/hrm/benefits/reports' },
  ].filter(Boolean) as { label: string; to: string; end?: boolean }[];
}
export function BenefitsLayout() {
  const tabs = useBenefitsTabs();
  return (
    <>
      <PageHeader title="Benefits & welfare" description="Benefit plans, eligibility, entitlement balances and reimbursement claims. A benefit amount is not salary, not a payroll component and not a tax decision; approval makes a claim ready for payment, and only a recorded payment says money moved." />
      {tabs.length > 1 && <div className="mb-5"><Tabs items={tabs} /></div>}
      <Outlet />
    </>
  );
}

/** The index is My benefits for anyone with an employee record; a report-only user (an executive) lands on the dashboard; an administrator without a record on Plans. */
export function BenefitsIndex({ my }: { my: ReactNode }) {
  const { user, hasPermission } = useAuth();
  if (user?.employee && hasPermission(PERMISSIONS.BENEFITS_VIEW_OWN)) return <>{my}</>;
  if (hasPermission(PERMISSIONS.BENEFITS_VIEW_REPORTS) || hasPermission(PERMISSIONS.BENEFITS_MANAGE)) return <Navigate to="/hrm/benefits/dashboard" replace />;
  if (hasPermission(PERMISSIONS.BENEFITS_VIEW)) return <Navigate to="/hrm/benefits/plans" replace />;
  return <>{my}</>;
}
