import type { ReactNode } from 'react';
import { CalendarOff, Check, CircleDashed, Clock, MinusCircle, X } from 'lucide-react';
import { formatLeaveUnits, skipReasonLabel, type LeaveWorkflowTimelineDto, type MyBalanceDto } from '@hr/shared';
import { Card } from '@/components/ui/Card';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { EmptyState } from '@/components/ui/EmptyState';
import { formatDateTime } from '@/lib/format';
import { ApiClientError } from '@/lib/api-client';
import { cn } from '@/lib/utils';

export { formatLeaveUnits };

/**
 * Business dates are plain `YYYY-MM-DD` strings. `new Date('2026-09-22')` parses as UTC midnight and can render as the
 * previous day west of UTC, so dates are formatted from their parts — never through a UTC Date.
 */
export function formatBusinessDate(date: string | null | undefined, opts: Intl.DateTimeFormatOptions = { dateStyle: 'medium' }): string {
  if (!date) return '—';
  const [y, m, d] = date.split('-').map(Number);
  if (!y || !m || !d) return date;
  return new Date(y, m - 1, d).toLocaleDateString(undefined, opts);
}

const PART_SUFFIX: Record<string, string> = { PM: ' (PM)', AM: ' (AM)' };
/** "12 Mar 2026", "12 Mar 2026 (PM) → 14 Mar 2026 (AM)". */
export function formatLeavePeriod(r: { startDate: string; endDate: string; startPart: string; endPart: string }): string {
  const start = formatBusinessDate(r.startDate) + (PART_SUFFIX[r.startPart] ?? '');
  if (r.startDate === r.endDate && r.startPart === r.endPart) return start;
  if (r.startDate === r.endDate) return `${formatBusinessDate(r.startDate)}${r.startPart === 'PM' ? ' (PM)' : r.endPart === 'AM' ? ' (AM)' : ''}`;
  return `${start} → ${formatBusinessDate(r.endDate)}${PART_SUFFIX[r.endPart] ?? ''}`;
}

const STATUS_LABEL: Record<string, string> = { DRAFT: 'Draft', PENDING: 'Pending', APPROVED: 'Approved', REJECTED: 'Rejected', CANCELLED: 'Cancelled' };
const STATUS_TONE: Record<string, 'success' | 'neutral' | 'warning' | 'danger' | 'info'> = { DRAFT: 'neutral', PENDING: 'warning', APPROVED: 'success', REJECTED: 'danger', CANCELLED: 'neutral' };

/** Status as text + colour (never colour alone). */
export function LeaveStatusBadge({ status }: { status: string }) {
  return <StatusBadge status={STATUS_LABEL[status] ?? status} tone={STATUS_TONE[status] ?? 'neutral'} />;
}

/** Business errors the API can return on the leave screens, in the user's words. */
const ERROR_MESSAGES: Record<string, string> = {
  LEAVE_REQUEST_OVERLAP: 'You already have leave that overlaps these dates.',
  INSUFFICIENT_LEAVE_BALANCE: 'Not enough leave balance for this request.',
  LEAVE_REASON_REQUIRED: 'This leave type requires a reason.',
  LEAVE_ATTACHMENT_REQUIRED: 'This leave type requires an attachment reference.',
  LEAVE_HALF_DAY_NOT_ALLOWED: 'Half-day leave is not allowed for this leave type.',
  LEAVE_HALF_DAY_INVALID: 'That half-day combination is not valid for these dates.',
  LEAVE_BACKDATE_NOT_ALLOWED: 'This leave type cannot start in the past.',
  LEAVE_NOTICE_NOT_MET: 'This request does not meet the minimum notice required.',
  LEAVE_MAX_CONSECUTIVE_EXCEEDED: 'This request exceeds the maximum consecutive days allowed.',
  LEAVE_UNITS_ZERO: 'The selected dates contain no working days.',
  WORK_CALENDAR_NOT_CONFIGURED: 'Your organization has no work calendar yet. Please contact HR.',
  LEAVE_ENTITLEMENT_NOT_FOUND: 'You have no leave entitlement covering these dates. Please contact HR.',
  LEAVE_CROSSES_ENTITLEMENT_PERIOD: 'A request cannot span two entitlement periods. Please split it.',
  LEAVE_CROSSES_POLICY_PERIOD: 'These dates fall under two different leave policies. Please split the request.',
  LEAVE_POLICY_NOT_FOUND: 'No leave policy applies to you for this leave type and date.',
  LEAVE_TYPE_INACTIVE: 'This leave type is no longer available.',
  LEAVE_REQUEST_NOT_DRAFT: 'This request has already been submitted and can no longer be edited.',
  LEAVE_REQUEST_NOT_CANCELLABLE: 'This request can no longer be cancelled.',
  LEAVE_REQUEST_NOT_PENDING: 'This request is no longer pending.',
  LEAVE_ASSIGNMENT_REQUIRED: 'Your employee record has no current organization assignment. Please contact HR.',
  EMPLOYEE_PROFILE_REQUIRED: 'This account is not linked to an employee profile.',
  APPROVER_UNRESOLVED: 'No approver could be resolved for this request. Please contact HR.',
  SELF_APPROVAL_NOT_ALLOWED: 'You cannot approve your own request.',
  WORKFLOW_NOT_PENDING: 'This request was already decided by someone else.',
  WORKFLOW_STEP_NOT_PENDING: 'This approval step is no longer waiting for a decision.',
  NOT_STEP_APPROVER: 'You are not the approver for the current step.',
};

/** Business error → user-facing sentence; unknown/5xx never leak backend details. */
export function leaveErrorMessage(err: unknown, fallback = 'Something went wrong. Please try again.'): string {
  if (err instanceof ApiClientError) {
    if (err.status >= 500) return fallback;
    return ERROR_MESSAGES[err.error.code] ?? err.error.message ?? fallback;
  }
  return fallback;
}

const STEP_ICON: Record<string, ReactNode> = {
  APPROVED: <Check className="h-3.5 w-3.5" />,
  REJECTED: <X className="h-3.5 w-3.5" />,
  PENDING: <Clock className="h-3.5 w-3.5" />,
  WAITING: <CircleDashed className="h-3.5 w-3.5" />,
  SKIPPED: <MinusCircle className="h-3.5 w-3.5" />,
  CANCELLED: <MinusCircle className="h-3.5 w-3.5" />,
};
const STEP_STYLE: Record<string, string> = {
  APPROVED: 'bg-emerald-100 text-emerald-700',
  REJECTED: 'bg-red-100 text-red-700',
  PENDING: 'bg-amber-100 text-amber-700',
  WAITING: 'bg-slate-100 text-slate-400',
  SKIPPED: 'bg-slate-100 text-slate-400',
  CANCELLED: 'bg-slate-100 text-slate-400',
};

/**
 * Workflow steps exactly as snapshotted at submit — the approver shown is the one recorded then, even if the
 * employee's manager has changed since. Nothing is re-resolved for display.
 */
export function StepTimeline({ workflow }: { workflow: LeaveWorkflowTimelineDto }) {
  return (
    <ol className="space-y-3">
      {workflow.steps.map((s) => {
        const approver = s.approverEmployee ? `${s.approverEmployee.firstName} ${s.approverEmployee.lastName}` : (s.approver?.email ?? 'Unassigned');
        return (
          <li key={s.stepOrder} className="flex gap-3">
            <span className={cn('mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full', STEP_STYLE[s.status] ?? 'bg-slate-100 text-slate-400')} aria-hidden>
              {STEP_ICON[s.status] ?? <CircleDashed className="h-3.5 w-3.5" />}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="text-sm font-medium text-slate-900">{s.name}</span>
                <StatusBadge status={STATUS_LABEL[s.status] ?? s.status.charAt(0) + s.status.slice(1).toLowerCase()} tone={s.status === 'APPROVED' ? 'success' : s.status === 'REJECTED' ? 'danger' : s.status === 'PENDING' ? 'warning' : 'neutral'} />
              </div>
              <p className="text-xs text-slate-500">
                {approver}
                {s.actedAt && <> · acted {formatDateTime(s.actedAt)}</>}
              </p>
              {s.skipReason && <p className="text-xs text-slate-500">{skipReasonLabel(s.skipReason)}</p>}
              {s.comment && <p className="mt-1 rounded-md bg-slate-50 px-2 py-1 text-sm text-slate-700">“{s.comment}”</p>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * Balance cards per leave type. `reserved` is shown to employees as "Pending" — the accounting term stays `reserved`
 * in the API and ledger. With no entitlement at all we say so instead of showing a fake zero balance.
 */
export function BalanceCards({ balances, loading }: { balances: MyBalanceDto[] | undefined; loading?: boolean }) {
  if (loading) return <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{[0, 1, 2].map((i) => <Card key={i} className="h-28 animate-pulse bg-slate-50" />)}</div>;
  if (!balances?.length) {
    return <Card><EmptyState icon={<CalendarOff className="h-6 w-6" />} title="No leave entitlement available" description="No entitlement covers today. HR generates entitlements per leave type and period." /></Card>;
  }
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {balances.map((b) => (
        <Card key={b.entitlementId} className="p-4">
          <div className="flex items-baseline justify-between gap-2">
            <h3 className="truncate text-sm font-semibold text-slate-900">{b.leaveType.name}</h3>
            <span className="shrink-0 font-mono text-[11px] text-slate-400">{b.leaveType.code}</span>
          </div>
          <p className="mt-0.5 text-xs text-slate-500">{formatBusinessDate(b.periodStart)} → {formatBusinessDate(b.periodEnd)}</p>
          <p className="mt-3 flex items-baseline gap-1.5">
            <span className={cn('text-3xl font-semibold tabular-nums', b.available < 0 ? 'text-red-600' : 'text-slate-900')}>{formatLeaveUnits(b.available)}</span>
            <span className="text-sm text-slate-500">days available</span>
          </p>
          <dl className="mt-3 grid grid-cols-3 gap-2 border-t border-slate-100 pt-2 text-center text-xs">
            {([['Used', b.used], ['Pending', b.reserved], ['Granted', b.granted + b.carriedForward + b.adjustment]] as const).map(([label, value]) => (
              <div key={label}>
                <dt className="text-slate-500">{label}</dt>
                <dd className="font-medium tabular-nums text-slate-900">{formatLeaveUnits(value)}</dd>
              </div>
            ))}
          </dl>
        </Card>
      ))}
    </div>
  );
}
