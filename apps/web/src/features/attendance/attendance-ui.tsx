import { Outlet } from 'react-router-dom';
import { PERMISSIONS, formatWorkMinutes } from '@hr/shared';
import { PageHeader } from '@/components/layout/PageHeader';
import { Tabs } from '@/components/ui/Tabs';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { useAuth } from '@/hooks/useAuth';
import { formatBusinessDate } from '@/features/leave/leave-ui';

export { formatWorkMinutes, formatBusinessDate };

const STATUS_LABEL: Record<string, string> = {
  NOT_SCHEDULED: 'Not scheduled',
  SCHEDULED: 'Not clocked yet',
  NORMAL: 'Normal',
  LATE: 'Late',
  EARLY_LEAVE: 'Left early',
  LATE_AND_EARLY: 'Late + left early',
  INCOMPLETE: 'Incomplete',
  ABSENT: 'Absent',
  ON_LEAVE: 'On leave',
};
const STATUS_TONE: Record<string, 'success' | 'neutral' | 'warning' | 'danger' | 'info'> = {
  NOT_SCHEDULED: 'neutral',
  SCHEDULED: 'neutral',
  NORMAL: 'success',
  LATE: 'warning',
  EARLY_LEAVE: 'warning',
  LATE_AND_EARLY: 'warning',
  INCOMPLETE: 'danger',
  ABSENT: 'danger',
  ON_LEAVE: 'info',
};

/** Status as words plus colour — never colour alone. */
export function AttendanceStatusBadge({ status }: { status: string }) {
  return <StatusBadge status={STATUS_LABEL[status] ?? status} tone={STATUS_TONE[status] ?? 'neutral'} />;
}

const CORRECTION_LABEL: Record<string, string> = { PENDING: 'Pending', APPROVED: 'Approved', REJECTED: 'Rejected', CANCELLED: 'Cancelled' };
const CORRECTION_TONE: Record<string, 'success' | 'neutral' | 'warning' | 'danger'> = { PENDING: 'warning', APPROVED: 'success', REJECTED: 'danger', CANCELLED: 'neutral' };
export function CorrectionStatusBadge({ status }: { status: string }) {
  return <StatusBadge status={CORRECTION_LABEL[status] ?? status} tone={CORRECTION_TONE[status] ?? 'neutral'} />;
}

/**
 * Clock times are UTC instants; they are displayed in the **organization's** timezone, which the server sends with
 * every clock status. Rendering them in the browser's timezone would show a night shift on the wrong day.
 */
export function formatClockTime(iso: string | null | undefined, timezone?: string): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: timezone });
}

/** Minutes → `7h 30m`, or a dash when there is nothing to show. */
export const formatMinutes = (minutes: number | null | undefined) => (minutes ? formatWorkMinutes(minutes) : '—');

/** Tab visibility follows capability, never a role name. The API enforces the same rules. */
export function useAttendanceTabs() {
  const { user, hasPermission } = useAuth();
  const canView = hasPermission(PERMISSIONS.ATTENDANCE_VIEW);
  const scope = user?.dataScope;
  const teamOrAll = scope === 'TEAM' || scope === 'ALL';
  return [
    hasPermission(PERMISSIONS.ATTENDANCE_CLOCK) && !!user?.employee && { label: 'My attendance', to: '/hrm/attendance', end: true },
    canView && teamOrAll && { label: 'Team', to: '/hrm/attendance/team' },
    canView && scope === 'ALL' && { label: 'Daily', to: '/hrm/attendance/daily' },
    canView && teamOrAll && { label: 'Schedule', to: '/hrm/attendance/schedule' },
    canView && { label: 'Corrections', to: '/hrm/attendance/corrections' },
    hasPermission(PERMISSIONS.OT_VIEW) && { label: 'Overtime', to: '/hrm/attendance/overtime' },
    hasPermission(PERMISSIONS.OT_VIEW) && { label: 'OT policies', to: '/hrm/attendance/overtime-policies' },
    hasPermission(PERMISSIONS.ATTENDANCE_MANAGE) && { label: 'Shifts', to: '/hrm/attendance/shifts' },
    canView && teamOrAll && { label: 'Reports', to: '/hrm/attendance/reports' },
  ].filter(Boolean) as { label: string; to: string; end?: boolean }[];
}

export function AttendanceLayout() {
  const tabs = useAttendanceTabs();
  return (
    <>
      <PageHeader
        title="Time & attendance"
        description="Clock in and out, see the day as it stands, and fix the days that went wrong. Shifts, schedules and the work calendar decide what is expected."
      />
      {tabs.length > 1 && <div className="mb-5"><Tabs items={tabs} /></div>}
      <Outlet />
    </>
  );
}
