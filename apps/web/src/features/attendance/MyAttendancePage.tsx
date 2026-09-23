import { useMemo, useState } from 'react';
import { Clock, LogIn, LogOut, PenLine } from 'lucide-react';
import type { AttendanceRecordDto } from '@hr/shared';
import { Card, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Alert';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { LoadingBlock } from '@/components/ui/Spinner';
import { useToast } from '@/components/ui/Toast';
import { ApiClientError } from '@/lib/api-client';
import { useClockMutations, useClockStatus, useMyAttendance } from './attendance.api';
import { AttendanceStatusBadge, formatBusinessDate, formatClockTime, formatMinutes } from './attendance-ui';
import { CorrectionDialog } from './CorrectionDialog';

/** First and last day of the month a date belongs to, as business dates. */
function monthRange(date: string) {
  const [y, m] = date.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${date.slice(0, 7)}-01`, to: `${date.slice(0, 7)}-${String(last).padStart(2, '0')}` };
}

export function MyAttendancePage() {
  const status = useClockStatus();
  const { clockIn, clockOut } = useClockMutations();
  const toast = useToast();
  const [error, setError] = useState<string | null>(null);
  const [correctionDate, setCorrectionDate] = useState<string | null>(null);

  const today = status.data?.attendanceDate ?? '';
  const [month, setMonth] = useState<string>('');
  const range = useMemo(() => monthRange(month || today || '2026-01-01'), [month, today]);
  const history = useMyAttendance(range.from, range.to);

  const act = async (kind: 'in' | 'out') => {
    setError(null);
    try {
      await (kind === 'in' ? clockIn : clockOut).mutateAsync(undefined);
      toast.success(kind === 'in' ? 'Clocked in' : 'Clocked out');
    } catch (err) {
      setError(err instanceof ApiClientError ? err.error.message : 'Something went wrong.');
    }
  };

  const columns: Column<AttendanceRecordDto>[] = [
    { key: 'date', header: 'Date', render: (r) => <span className="font-medium text-slate-900">{formatBusinessDate(r.attendanceDate)}</span> },
    { key: 'shift', header: 'Shift', hideBelow: 'sm', render: (r) => (r.shift ? `${r.shift.code} ${r.shift.startTime}–${r.shift.endTime}` : <span className="text-slate-400">—</span>) },
    { key: 'in', header: 'In', render: (r) => formatClockTime(r.firstClockIn, status.data?.timezone) },
    { key: 'out', header: 'Out', render: (r) => formatClockTime(r.lastClockOut, status.data?.timezone) },
    { key: 'worked', header: 'Worked', hideBelow: 'sm', render: (r) => formatMinutes(r.workMinutes) },
    { key: 'late', header: 'Late', hideBelow: 'md', render: (r) => formatMinutes(r.lateMinutes) },
    { key: 'status', header: 'Status', render: (r) => <AttendanceStatusBadge status={r.status} /> },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      className: 'text-right',
      render: (r) => (
        <Button variant="ghost" size="sm" onClick={() => setCorrectionDate(r.attendanceDate)} aria-label={`Request a correction for ${r.attendanceDate}`}>
          <PenLine className="h-4 w-4" />
        </Button>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      {error && <Alert>{error}</Alert>}

      <Card>
        <CardHeader title="Today" description={status.data ? `${formatBusinessDate(status.data.attendanceDate)} · ${status.data.timezone}` : undefined} />
        <div className="p-5">
          {status.isLoading ? (
            <LoadingBlock />
          ) : status.isError ? (
            <Alert>Could not load today&apos;s attendance.</Alert>
          ) : status.data ? (
            <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Clock className="h-4 w-4 text-slate-400" />
                  <span className="text-sm text-slate-700">
                    {status.data.shift
                      ? `${status.data.shift.name} (${status.data.shift.code}) ${status.data.shift.startTime}–${status.data.shift.endTime}${status.data.shift.isOvernight ? ' +1d' : ''}`
                      : 'No shift scheduled for today'}
                  </span>
                  <AttendanceStatusBadge status={status.data.status} />
                </div>
                <dl className="flex gap-6 text-sm">
                  <div>
                    <dt className="text-xs text-slate-500">Clocked in</dt>
                    <dd className="font-medium text-slate-900">{formatClockTime(status.data.firstClockIn, status.data.timezone)}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-slate-500">Clocked out</dt>
                    <dd className="font-medium text-slate-900">{formatClockTime(status.data.lastClockOut, status.data.timezone)}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-slate-500">Worked</dt>
                    <dd className="font-medium text-slate-900">{formatMinutes(status.data.workMinutes)}</dd>
                  </div>
                </dl>
              </div>
              <div className="flex gap-2">
                <Button onClick={() => act('in')} disabled={!status.data.canClockIn} loading={clockIn.isPending}>
                  <LogIn className="h-4 w-4" /> Clock in
                </Button>
                <Button variant="secondary" onClick={() => act('out')} disabled={!status.data.canClockOut} loading={clockOut.isPending}>
                  <LogOut className="h-4 w-4" /> Clock out
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      </Card>

      <Card>
        <div className="flex flex-col gap-3 border-b border-slate-200 p-4 sm:flex-row sm:items-center sm:justify-between">
          <h2 className="text-sm font-semibold text-slate-900">History</h2>
          <input
            type="month"
            value={month || today.slice(0, 7)}
            onChange={(e) => setMonth(e.target.value ? `${e.target.value}-01` : '')}
            className="h-9 rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-900 shadow-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
            aria-label="Month"
          />
        </div>
        {history.isError && <Alert className="m-4">Could not load your attendance history.</Alert>}
        <DataTable
          columns={columns}
          rows={history.data ?? []}
          rowKey={(r) => r.id}
          loading={history.isLoading}
          emptyTitle="Nothing recorded yet"
          emptyDescription="Days appear here once they are scheduled or you clock in."
        />
      </Card>

      <CorrectionDialog date={correctionDate} timezone={status.data?.timezone} onClose={() => setCorrectionDate(null)} />
    </div>
  );
}
