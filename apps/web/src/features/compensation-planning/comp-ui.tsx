import type { ReactNode } from 'react';
import { Navigate, Outlet } from 'react-router-dom';
import { PERMISSIONS } from '@hr/shared';
import { PageHeader } from '@/components/layout/PageHeader';
import { Tabs } from '@/components/ui/Tabs';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { LoadingBlock } from '@/components/ui/Spinner';
import { useAuth } from '@/hooks/useAuth';
import { useMyCycles } from './comp.api';

type Tone = 'success' | 'neutral' | 'warning' | 'danger' | 'info';
export const titleCase = (s: string) => s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, ' ');
const TONE: Record<string, Tone> = {
  DRAFT: 'neutral', ACTIVE: 'info', REVIEW: 'warning', FINALIZED: 'success', ARCHIVED: 'neutral',
  NOT_STARTED: 'neutral', SUBMITTED: 'info', HR_REVIEW: 'warning', APPROVED: 'success', RETURNED: 'danger',
  ELIGIBLE: 'success', MISSING_COMPENSATION: 'danger', CURRENCY_MISMATCH: 'warning',
};
const LABEL: Record<string, string> = { HR_REVIEW: 'HR review', NOT_STARTED: 'Not started', MISSING_COMPENSATION: 'No salary record', CURRENCY_MISMATCH: 'Other currency' };
export function CompBadge({ status }: { status: string }) { return <StatusBadge status={LABEL[status] ?? titleCase(status)} tone={TONE[status] ?? 'neutral'} />; }

/** Money arrives as a decimal string and is only re-punctuated here: never parsed, never added in the browser. */
export const money = (v: string | null | undefined, currency?: string | null) => {
  if (v === null || v === undefined) return '—';
  const neg = v.startsWith('-'); const [i = '0', f] = (neg ? v.slice(1) : v).split('.');
  return `${neg ? '-' : ''}${i.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${f !== undefined ? `.${f}` : ''}${currency ? ` ${currency}` : ''}`;
};
export function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: string; tone?: 'warning' | 'danger' }) {
  return <div className={`rounded-lg border p-4 ${tone === 'danger' ? 'border-red-200 bg-red-50' : tone === 'warning' ? 'border-amber-200 bg-amber-50' : 'border-slate-200 bg-white'}`}><div className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</div><div className="mt-1 text-xl font-semibold tabular-nums text-slate-900">{value}</div>{hint && <div className="mt-1 text-xs text-slate-500">{hint}</div>}</div>;
}
export const HIGH_IMPACT_NOTE = 'People decide every salary here. The system shows the facts, derives the increase from the number a person entered and checks the budget — it never suggests, ranks or scores anyone.';

export function useCompAccess() {
  const { hasPermission, scopeOf } = useAuth();
  const P = PERMISSIONS;
  const hr = scopeOf(P.COMP_PLAN_REVIEW, P.COMP_PLAN_MANAGE_CYCLES, P.COMP_PLAN_MANAGE_BUDGET, P.COMP_PLAN_FINALIZE, P.COMP_PLAN_APPLY) === 'ALL';
  const planner = hasPermission(P.COMP_PLAN_VIEW_TEAM) || hasPermission(P.COMP_PLAN_PLAN);
  const reports = hasPermission(P.COMP_PLAN_VIEW_REPORTS) || hr;
  return { hr, planner, reports, manage: hr && hasPermission(P.COMP_PLAN_MANAGE_CYCLES), budget: hr && hasPermission(P.COMP_PLAN_MANAGE_BUDGET), review: hr && hasPermission(P.COMP_PLAN_REVIEW), finalize: hr && hasPermission(P.COMP_PLAN_FINALIZE), apply: hr && hasPermission(P.COMP_PLAN_APPLY) && hasPermission(P.PAYROLL_MANAGE), plan: hasPermission(P.COMP_PLAN_PLAN) };
}

export function CompensationLayout() {
  const a = useCompAccess();
  const my = useMyCycles(a.planner);
  const hasPlanning = (my.data?.length ?? 0) > 0;
  const tabs = [
    a.planner && hasPlanning && { label: 'My planning', to: '/hrm/compensation/my' },
    a.hr && { label: 'Cycles', to: '/hrm/compensation/cycles' },
    a.reports && { label: 'Reports', to: '/hrm/compensation/reports' },
  ].filter(Boolean) as { label: string; to: string }[];
  return (
    <>
      <PageHeader title="Compensation planning" description="Salary review cycles: a frozen population, proposals entered by planners, HR review, a budget ceiling, and an explicit Apply that alone changes salary history." />
      {tabs.length > 1 && <div className="mb-5"><Tabs items={tabs} /></div>}
      <Outlet />
    </>
  );
}

/** HR lands on Cycles; a planner with an open cycle on My planning; a report reader (an executive) on Reports. */
export function CompensationIndex() {
  const a = useCompAccess();
  const my = useMyCycles(a.planner);
  if (a.planner && my.isLoading) return <LoadingBlock />;
  if (a.hr) return <Navigate to="/hrm/compensation/cycles" replace />;
  if (a.planner && (my.data?.length ?? 0) > 0) return <Navigate to="/hrm/compensation/my" replace />;
  if (a.reports) return <Navigate to="/hrm/compensation/reports" replace />;
  return <p className="text-sm text-slate-500">No salary review is assigned to you right now.</p>;
}
