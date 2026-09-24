import { Outlet } from 'react-router-dom';
import { PERMISSIONS, formatScore, formatWeight } from '@hr/shared';
import { PageHeader } from '@/components/layout/PageHeader';
import { Tabs } from '@/components/ui/Tabs';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { useAuth } from '@/hooks/useAuth';

export { formatScore, formatWeight };

const CYCLE_LABEL: Record<string, string> = { DRAFT: 'Draft', ACTIVE: 'Active', REVIEW: 'In review', CLOSED: 'Closed' };
const CYCLE_TONE: Record<string, 'success' | 'neutral' | 'warning' | 'info'> = { DRAFT: 'neutral', ACTIVE: 'info', REVIEW: 'warning', CLOSED: 'success' };
export const CycleStatusBadge = ({ status }: { status: string }) => (
  <StatusBadge status={CYCLE_LABEL[status] ?? status} tone={CYCLE_TONE[status] ?? 'neutral'} />
);

const PLAN_LABEL: Record<string, string> = {
  DRAFT: 'Not started',
  ACTIVE: 'In progress',
  SELF_REVIEW: 'Self review',
  MANAGER_REVIEW: 'Waiting for manager',
  FINALIZED: 'Complete',
};
const PLAN_TONE: Record<string, 'success' | 'neutral' | 'warning' | 'info'> = {
  DRAFT: 'neutral', ACTIVE: 'info', SELF_REVIEW: 'warning', MANAGER_REVIEW: 'warning', FINALIZED: 'success',
};
export const PlanStatusBadge = ({ status }: { status: string }) => (
  <StatusBadge status={PLAN_LABEL[status] ?? status} tone={PLAN_TONE[status] ?? 'neutral'} />
);

/**
 * A target or an actual as it reads: grouped thousands, and no `.00` tail on a whole number. A sales target of a
 * million should not be printed as `1000000.00`.
 */
export function formatMeasure(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (!/^\d+(\.\d+)?$/.test(value)) return value; // free text targets pass through untouched
  const [whole, fraction = ''] = value.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const trimmed = fraction.replace(/0+$/, '');
  return trimmed ? `${grouped}.${trimmed}` : grouped;
}

const MEASUREMENT_LABEL: Record<string, string> = {
  NUMBER: 'Number', PERCENTAGE: 'Percentage', BOOLEAN: 'Yes / no', MILESTONE: 'Milestone', QUALITATIVE: 'Qualitative',
};
export const measurementLabel = (type: string) => MEASUREMENT_LABEL[type] ?? type;

/** A score as it reads: two places, or a dash. Nothing in the UI ever calculates one. */
export const Score = ({ value, className = '' }: { value: string | null | undefined; className?: string }) => (
  <span className={`tabular-nums ${className}`}>{formatScore(value)}</span>
);

/** A slim progress bar with the number beside it — colour alone never carries the meaning. */
export function ProgressBar({ percent }: { percent: number }) {
  return (
    <span className="flex items-center gap-2">
      <span className="h-1.5 w-20 overflow-hidden rounded-full bg-slate-200" aria-hidden>
        <span className="block h-full rounded-full bg-brand-500" style={{ width: `${Math.min(100, Math.max(0, percent))}%` }} />
      </span>
      <span className="tabular-nums text-xs text-slate-600">{percent}%</span>
    </span>
  );
}

/** Tab visibility follows capability, never a role name. The API enforces the same rules. */
export function usePerformanceTabs() {
  const { user, hasPermission } = useAuth();
  const canReview = hasPermission(PERMISSIONS.PERFORMANCE_REVIEW);
  const managesCycles = hasPermission(PERMISSIONS.PERFORMANCE_MANAGE_CYCLES);
  const managesKpis = hasPermission(PERMISSIONS.PERFORMANCE_MANAGE_KPIS);
  return [
    !!user?.employee && { label: 'My performance', to: '/hrm/performance', end: true },
    canReview && { label: 'Team reviews', to: '/hrm/performance/reviews' },
    managesCycles && { label: 'Cycles', to: '/hrm/performance/cycles' },
    (managesKpis || managesCycles) && { label: 'KPI library', to: '/hrm/performance/kpis' },
    { label: 'Reports', to: '/hrm/performance/reports' },
  ].filter(Boolean) as { label: string; to: string; end?: boolean }[];
}

export function PerformanceLayout() {
  const tabs = usePerformanceTabs();
  return (
    <>
      <PageHeader
        title="Performance"
        description="What each person is measured on for a cycle, how far they have got, and the two assessments that close it. Scores are calculated once, on the server, from the weights agreed at the start."
      />
      {tabs.length > 1 && <div className="mb-5"><Tabs items={tabs} /></div>}
      <Outlet />
    </>
  );
}
