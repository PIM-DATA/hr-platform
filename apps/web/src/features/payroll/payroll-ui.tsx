import { Outlet } from 'react-router-dom';
import { PERMISSIONS, formatMoney } from '@hr/shared';
import { PageHeader } from '@/components/layout/PageHeader';
import { Tabs } from '@/components/ui/Tabs';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { useAuth } from '@/hooks/useAuth';

export { formatMoney };

const PERIOD_LABEL: Record<string, string> = { OPEN: 'Open', PROCESSING: 'Calculating', REVIEW: 'In review', APPROVED: 'Approved', CLOSED: 'Closed' };
const PERIOD_TONE: Record<string, 'success' | 'neutral' | 'warning' | 'info'> = { OPEN: 'neutral', PROCESSING: 'warning', REVIEW: 'warning', APPROVED: 'info', CLOSED: 'success' };
export const PayrollStatusBadge = ({ status }: { status: string }) => (
  <StatusBadge status={PERIOD_LABEL[status] ?? status} tone={PERIOD_TONE[status] ?? 'neutral'} />
);

/**
 * A run is in review, approved or closed. "Waiting for approval" is not a fourth status: it is a run still in review
 * that has a workflow instance attached, which is what the server models.
 */
const RUN_LABEL: Record<string, string> = { REVIEW: 'In review', APPROVED: 'Approved', CLOSED: 'Closed' };
const RUN_TONE: Record<string, 'success' | 'neutral' | 'warning' | 'info'> = { REVIEW: 'warning', APPROVED: 'info', CLOSED: 'success' };
export const RunStatusBadge = ({ run }: { run: { status: string; workflowInstanceId: string | null } }) =>
  run.status === 'REVIEW' && run.workflowInstanceId
    ? <StatusBadge status="Waiting for approval" tone="warning" />
    : <StatusBadge status={RUN_LABEL[run.status] ?? run.status} tone={RUN_TONE[run.status] ?? 'neutral'} />;

/** Money is right-aligned and tabular so columns of figures line up and can be scanned down. */
export const Money = ({ amount, currency, className = '' }: { amount: string | null | undefined; currency?: string; className?: string }) => (
  <span className={`tabular-nums ${className}`}>{formatMoney(amount, currency)}</span>
);

/** A quantity or a rate as it reads on a payslip: 1000.000000 is noise, 2.083333 is the actual minute rate. */
export const formatFactor = (value: string | null | undefined) =>
  value === null || value === undefined ? null : value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value;

const SOURCE_LABEL: Record<string, string> = {
  BASE: 'Base salary',
  RECURRING: 'Recurring item',
  OT: 'Overtime',
  ATTENDANCE: 'Attendance',
  LEAVE: 'Leave',
  MANUAL: 'Manual adjustment',
  STATUTORY: 'Statutory',
};
export const sourceLabel = (source: string) => SOURCE_LABEL[source] ?? source;

/** Tab visibility follows capability, never a role name. The API enforces the same rules. */
export function usePayrollTabs() {
  const { user, hasPermission } = useAuth();
  const canManage = hasPermission(PERMISSIONS.PAYROLL_MANAGE);
  const canRun = hasPermission(PERMISSIONS.PAYROLL_RUN);
  const canRead = canManage || canRun || hasPermission(PERMISSIONS.PAYROLL_APPROVE);
  return [
    hasPermission(PERMISSIONS.PAYROLL_VIEW_OWN) && !!user?.employee && { label: 'My payslips', to: '/hrm/payroll', end: true },
    canRead && { label: 'Periods', to: '/hrm/payroll/periods' },
    canManage && { label: 'Compensation', to: '/hrm/payroll/compensation' },
    canRead && { label: 'Pay components', to: '/hrm/payroll/components' },
    canManage && { label: 'Recurring items', to: '/hrm/payroll/recurring' },
    canRead && { label: 'Policies', to: '/hrm/payroll/policies' },
  ].filter(Boolean) as { label: string; to: string; end?: boolean }[];
}

export function PayrollLayout() {
  const tabs = usePayrollTabs();
  return (
    <>
      <PageHeader
        title="Payroll"
        description="Salary, recurring pay, and what attendance, leave and approved overtime do to a month's pay. Amounts are calculated once, reviewed, approved and then closed for good."
      />
      {tabs.length > 1 && <div className="mb-5"><Tabs items={tabs} /></div>}
      <Outlet />
    </>
  );
}
