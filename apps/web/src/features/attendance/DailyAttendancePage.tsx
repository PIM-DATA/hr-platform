import { useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { PERMISSIONS, type AttendanceRecordDto } from '@hr/shared';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Alert';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { Pagination } from '@/components/ui/Pagination';
import { Select } from '@/components/ui/Select';
import { SearchInput } from '@/components/ui/SearchInput';
import { useToast } from '@/components/ui/Toast';
import { usePermission } from '@/hooks/usePermission';
import { useDebounce } from '@/hooks/useDebounce';
import { ApiClientError } from '@/lib/api-client';
import { useDepartments } from '@/features/organization/organization.api';
import { useAttendanceMutations, useAttendanceRecords, useDailySummary, useToday } from './attendance.api';
import { AttendanceStatusBadge, formatBusinessDate, formatClockTime, formatMinutes } from './attendance-ui';

const PAGE_SIZE = 25;
const STATUS_OPTIONS = ['NORMAL', 'LATE', 'EARLY_LEAVE', 'LATE_AND_EARLY', 'INCOMPLETE', 'ABSENT', 'ON_LEAVE', 'SCHEDULED', 'NOT_SCHEDULED'];

/**
 * One day, everybody the caller may see. `scope` picks the audience: the Team tab is the same screen with the
 * manager's own data scope, which the server applies — there is no separate "team" query.
 */
export function DailyAttendancePage({ scope }: { scope: 'team' | 'all' }) {
  const today = useToday();
  const toast = useToast();
  const canManage = usePermission(PERMISSIONS.ATTENDANCE_MANAGE);
  const { recalculate } = useAttendanceMutations();

  const [date, setDate] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const debouncedSearch = useDebounce(search);

  const day = date || today.data?.date || '';
  const departments = useDepartments({ page: 1, pageSize: 100 });
  const summary = useDailySummary(day, departmentId || undefined);
  const records = useAttendanceRecords(
    { date: day, departmentId: departmentId || undefined, status: status || undefined, search: debouncedSearch || undefined, page, pageSize: PAGE_SIZE },
    !!day,
  );

  const onRecalculate = async () => {
    setError(null);
    try {
      const result = await recalculate.mutateAsync({ from: day, to: day, departmentId: departmentId || undefined });
      toast.success(`Recalculated ${result.records} day(s) for ${result.employees} employee(s)`);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.error.message : 'Something went wrong.');
    }
  };

  const columns: Column<AttendanceRecordDto>[] = [
    {
      key: 'employee',
      header: 'Employee',
      render: (r) => (
        <div>
          <div className="font-medium text-slate-900">{r.employee.firstName} {r.employee.lastName}</div>
          <div className="text-xs text-slate-500">{r.employee.employeeCode}{r.employee.department ? ` · ${r.employee.department.name}` : ''}</div>
        </div>
      ),
    },
    { key: 'shift', header: 'Shift', hideBelow: 'md', render: (r) => (r.shift ? `${r.shift.code} ${r.shift.startTime}–${r.shift.endTime}` : <span className="text-slate-400">—</span>) },
    { key: 'in', header: 'In', render: (r) => formatClockTime(r.firstClockIn, today.data?.timezone) },
    { key: 'out', header: 'Out', render: (r) => formatClockTime(r.lastClockOut, today.data?.timezone) },
    { key: 'worked', header: 'Worked', hideBelow: 'sm', render: (r) => formatMinutes(r.workMinutes) },
    { key: 'late', header: 'Late', hideBelow: 'lg', render: (r) => formatMinutes(r.lateMinutes) },
    { key: 'status', header: 'Status', render: (r) => <AttendanceStatusBadge status={r.status} /> },
  ];

  const kpis = summary.data
    ? [
        { label: 'Scheduled', value: summary.data.scheduled },
        { label: 'Normal', value: summary.data.normal },
        { label: 'Late', value: summary.data.late },
        { label: 'Absent', value: summary.data.absent },
        { label: 'On leave', value: summary.data.onLeave },
        { label: 'Incomplete', value: summary.data.incomplete },
        { label: 'Not clocked yet', value: summary.data.notClockedYet },
      ]
    : [];

  return (
    <div className="space-y-5">
      {error && <Alert>{error}</Alert>}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
        {kpis.map((k) => (
          <Card key={k.label} className="p-4">
            <div className="text-xs text-slate-500">{k.label}</div>
            <div className="mt-1 text-2xl font-semibold text-slate-900">{k.value}</div>
          </Card>
        ))}
      </div>

      <Card>
        <div className="flex flex-col gap-3 border-b border-slate-200 p-4 lg:flex-row lg:items-center">
          <input
            type="date"
            value={day}
            onChange={(e) => { setDate(e.target.value); setPage(1); }}
            className="h-9 rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-900 shadow-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
            aria-label="Date"
          />
          <SearchInput value={search} onChange={(v) => { setSearch(v); setPage(1); }} placeholder="Search name or code…" className="lg:w-64" />
          {scope === 'all' && (
            <Select
              options={(departments.data?.data ?? []).map((d) => ({ value: d.id, label: d.name }))}
              placeholder="All departments"
              value={departmentId}
              onChange={(e) => { setDepartmentId(e.target.value); setPage(1); }}
              className="w-48"
            />
          )}
          <Select
            options={STATUS_OPTIONS.map((s) => ({ value: s, label: s.replace(/_/g, ' ').toLowerCase() }))}
            placeholder="All statuses"
            value={status}
            onChange={(e) => { setStatus(e.target.value); setPage(1); }}
            className="w-44"
          />
          {canManage && (
            <Button variant="secondary" className="lg:ml-auto" onClick={onRecalculate} loading={recalculate.isPending}>
              <RefreshCw className="h-4 w-4" /> Recalculate {formatBusinessDate(day)}
            </Button>
          )}
        </div>

        {records.isError && <Alert className="m-4">Could not load attendance.</Alert>}
        <DataTable
          columns={columns}
          rows={records.data?.data ?? []}
          rowKey={(r) => r.id}
          loading={records.isLoading}
          emptyTitle="Nothing for this day"
          emptyDescription="Assign a schedule, or recalculate the day once it has ended."
        />
        {records.data?.meta && <Pagination page={records.data.meta.page} pageSize={records.data.meta.pageSize} total={records.data.meta.total} onPageChange={setPage} />}
      </Card>
    </div>
  );
}
