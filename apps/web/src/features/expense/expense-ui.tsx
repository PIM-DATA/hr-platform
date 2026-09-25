import type { ReactNode } from 'react';
import { Outlet } from 'react-router-dom';
import { PERMISSIONS } from '@hr/shared';
import { PageHeader } from '@/components/layout/PageHeader';
import { Tabs } from '@/components/ui/Tabs';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { ModuleIndex } from '@/components/guards/ModuleIndex';
import { useAuth } from '@/hooks/useAuth';

type Tone = 'success' | 'neutral' | 'warning' | 'danger' | 'info';
export const titleCase = (s: string) => s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, ' ');
const TONE: Record<string, Tone> = { DRAFT: 'neutral', ACTIVE: 'info', INACTIVE: 'neutral', ARCHIVED: 'neutral', PENDING_APPROVAL: 'warning', APPROVED: 'success', COMPLETED: 'success', READY_FOR_PAYMENT: 'info', SENT_TO_PAYROLL: 'info', PAID: 'success', REJECTED: 'danger', CANCELLED: 'neutral', GENERAL: 'neutral', TRAVEL: 'info' };
const LABEL: Record<string, string> = { PENDING_APPROVAL: 'Pending approval', READY_FOR_PAYMENT: 'Ready for payment', SENT_TO_PAYROLL: 'Sent to payroll' };
export function ExpenseBadge({ status }: { status: string }) { return <StatusBadge status={LABEL[status] ?? titleCase(status)} tone={TONE[status] ?? 'neutral'} />; }
/** Money arrives as a decimal string and is shown as a decimal string: no arithmetic, no float, no rounding in the browser. The total is the API's Σ of the items. */
export const money = (v: string | null | undefined, currency?: string | null) => (v === null || v === undefined ? '—' : `${v}${currency ? ` ${currency}` : ''}`);
export const fmtDate = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' }) : '—');
export const todayIso = () => new Date().toISOString().slice(0, 10);
export function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: string; tone?: 'warning' | 'danger' }) {
  return <div className={`rounded-lg border p-4 ${tone === 'danger' ? 'border-red-200 bg-red-50' : tone === 'warning' ? 'border-amber-200 bg-amber-50' : 'border-slate-200 bg-white'}`}><div className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</div><div className="mt-1 text-2xl font-semibold tabular-nums text-slate-900">{value}</div>{hint && <div className="mt-1 text-xs text-slate-500">{hint}</div>}</div>;
}
export const Table = ({ head, rows }: { head: string[]; rows: ReactNode[][] }) => (
  <div className="overflow-x-auto"><table className="min-w-full text-sm"><thead className="bg-slate-50"><tr>{head.map((h) => <th key={h} className="px-4 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">{h}</th>)}</tr></thead><tbody className="divide-y divide-slate-100">{rows.length === 0 ? <tr><td colSpan={head.length} className="px-4 py-4 text-sm text-slate-400">Nothing here.</td></tr> : rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} className="px-4 py-2 tabular-nums">{c}</td>)}</tr>)}</tbody></table></div>
);
export function History({ rows }: { rows: { from: string | null; to: string; actorName: string | null; reasonCode: string | null; at: string }[] }) {
  return <div><div className="text-xs font-semibold uppercase tracking-wide text-slate-500">History</div><ol className="mt-1 space-y-1 text-xs text-slate-600">{rows.map((h, i) => <li key={i}>{fmtDate(h.at)} · {h.from ? `${titleCase(h.from)} → ` : ''}{titleCase(h.to)}{h.actorName ? ` · ${h.actorName}` : ''}{h.reasonCode ? ` · ${h.reasonCode}` : ''}</li>)}</ol></div>;
}

/** Tabs by capability. Administration needs the expense permissions and an organization-wide scope; the employee tab needs only an employee record. */
export function useExpenseTabs() {
  const { hasPermission, user } = useAuth();
  const admin = (hasPermission(PERMISSIONS.EXPENSE_VIEW) || hasPermission(PERMISSIONS.EXPENSE_MANAGE)) && user?.dataScope === 'ALL';
  const reports = hasPermission(PERMISSIONS.EXPENSE_VIEW_REPORTS) || hasPermission(PERMISSIONS.EXPENSE_MANAGE);
  return [
    (!!user?.employee && hasPermission(PERMISSIONS.EXPENSE_VIEW_OWN)) && { label: 'My expenses', to: '/hrm/expenses', end: true },
    reports && { label: 'Dashboard', to: '/hrm/expenses/dashboard' },
    admin && { label: 'Travel requests', to: '/hrm/expenses/travel' },
    admin && { label: 'Expense reports', to: '/hrm/expenses/reports' },
    admin && { label: 'Policies', to: '/hrm/expenses/policies' },
    admin && { label: 'Categories', to: '/hrm/expenses/categories' },
    admin && hasPermission(PERMISSIONS.EXPENSE_RECORD_PAYMENT) && { label: 'Payments', to: '/hrm/expenses/payments' },
    reports && { label: 'Reports', to: '/hrm/expenses/analytics' },
  ].filter(Boolean) as { label: string; to: string; end?: boolean }[];
}
export function ExpenseLayout() {
  const tabs = useExpenseTabs();
  return (
    <>
      <PageHeader title="Expenses & travel" description="Travel requests, expense reports with receipts, policy checks and reimbursement. Approval makes a report ready for payment; only a recorded payment or a payroll handoff says money moved. No tax decision is made here." />
      {tabs.length > 1 && <div className="mb-5"><Tabs items={tabs} /></div>}
      <Outlet />
    </>
  );
}
/** The index is My expenses for anyone with an employee record; a report-only user lands on the dashboard; an administrator without a record on Expense reports. */
export function ExpenseIndex({ my }: { my: ReactNode }) {
  return <ModuleIndex own={my} ownPermission={PERMISSIONS.EXPENSE_VIEW_OWN} fallbacks={[{ to: '/hrm/expenses/dashboard', permission: [PERMISSIONS.EXPENSE_VIEW_REPORTS, PERMISSIONS.EXPENSE_MANAGE] }, { to: '/hrm/expenses/reports', permission: PERMISSIONS.EXPENSE_VIEW }]} />;
}
