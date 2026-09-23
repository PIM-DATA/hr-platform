import { useMemo, useState } from 'react';
import { CalendarPlus } from 'lucide-react';
import { PERMISSIONS, WEEKDAYS, addDays, enumerateDates, weekdayOf, type ScheduleRowDto, type Weekday } from '@hr/shared';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Alert } from '@/components/ui/Alert';
import { Select } from '@/components/ui/Select';
import { SearchInput } from '@/components/ui/SearchInput';
import { Checkbox } from '@/components/ui/Checkbox';
import { LoadingBlock } from '@/components/ui/Spinner';
import { Pagination } from '@/components/ui/Pagination';
import { EmptyState } from '@/components/ui/EmptyState';
import { useToast } from '@/components/ui/Toast';
import { usePermission } from '@/hooks/usePermission';
import { useDebounce } from '@/hooks/useDebounce';
import { ApiClientError } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import { useDepartments } from '@/features/organization/organization.api';
import { EmployeeSelect } from '@/features/employees/EmployeeSelect';
import { useAttendanceMutations, useScheduleGrid, useShiftOptions, useToday } from './attendance.api';
import { formatBusinessDate } from './attendance-ui';

const PAGE_SIZE = 20;
const CELL_TONE: Record<string, string> = {
  WORK: 'bg-brand-50 text-brand-700 ring-brand-600/20',
  OFF: 'bg-slate-100 text-slate-500 ring-slate-400/20',
  HOLIDAY: 'bg-amber-50 text-amber-700 ring-amber-600/20',
};

/** Employees down the side, dates across the top — the grid HR fills in before a month starts. */
export function SchedulePage() {
  const today = useToday();
  const canAssign = usePermission(PERMISSIONS.ATTENDANCE_SCHEDULE_MANAGE);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [assigning, setAssigning] = useState(false);
  const debouncedSearch = useDebounce(search);

  const start = from || today.data?.date || '';
  const end = to || (start ? addDays(start, 13) : '');
  const dates = useMemo(() => (start && end && start <= end ? enumerateDates(start, end) : []), [start, end]);
  const departments = useDepartments({ page: 1, pageSize: 100 });
  const grid = useScheduleGrid(
    { from: start, to: end, departmentId: departmentId || undefined, search: debouncedSearch || undefined, page, pageSize: PAGE_SIZE },
    dates.length > 0,
  );

  return (
    <div className="space-y-5">
      <Card>
        <div className="flex flex-col gap-3 border-b border-slate-200 p-4 lg:flex-row lg:items-center">
          <div className="flex items-center gap-2">
            <input type="date" value={start} onChange={(e) => { setFrom(e.target.value); setPage(1); }} className="h-9 rounded-md border border-slate-300 bg-white px-3 text-sm shadow-sm" aria-label="From" />
            <span className="text-slate-400">→</span>
            <input type="date" value={end} onChange={(e) => { setTo(e.target.value); setPage(1); }} className="h-9 rounded-md border border-slate-300 bg-white px-3 text-sm shadow-sm" aria-label="To" />
          </div>
          <SearchInput value={search} onChange={(v) => { setSearch(v); setPage(1); }} placeholder="Search employee…" className="lg:w-56" />
          <Select
            options={(departments.data?.data ?? []).map((d) => ({ value: d.id, label: d.name }))}
            placeholder="All departments"
            value={departmentId}
            onChange={(e) => { setDepartmentId(e.target.value); setPage(1); }}
            className="w-48"
          />
          {canAssign && (
            <Button className="lg:ml-auto" onClick={() => setAssigning(true)}>
              <CalendarPlus className="h-4 w-4" /> Assign shift
            </Button>
          )}
        </div>

        {grid.isError && <Alert className="m-4">Could not load the schedule.</Alert>}
        {grid.isLoading ? (
          <LoadingBlock />
        ) : (grid.data?.data ?? []).length === 0 ? (
          <EmptyState title="No employees in this view" description="Widen the search, or check the date range." />
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full border-separate border-spacing-0 text-sm">
              <thead>
                <tr>
                  <th className="sticky left-0 z-10 border-b border-slate-200 bg-slate-50 px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">Employee</th>
                  {dates.map((d) => (
                    <th key={d} className={cn('border-b border-slate-200 bg-slate-50 px-2 py-2.5 text-center text-xs font-medium text-slate-500', ['SAT', 'SUN'].includes(weekdayOf(d)) && 'text-slate-400')}>
                      <div>{d.slice(8)}</div>
                      <div className="text-[10px] uppercase">{weekdayOf(d).slice(0, 2)}</div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(grid.data?.data ?? []).map((row: ScheduleRowDto) => (
                  <tr key={row.employee.id}>
                    <td className="sticky left-0 z-10 border-b border-slate-100 bg-white px-4 py-2">
                      <div className="font-medium text-slate-900">{row.employee.firstName} {row.employee.lastName}</div>
                      <div className="text-xs text-slate-500">{row.employee.employeeCode}</div>
                    </td>
                    {row.days.map((cell) => (
                      <td key={cell.date} className="border-b border-slate-100 px-1 py-2 text-center">
                        <span className={cn('inline-flex min-w-[2.75rem] justify-center rounded px-1.5 py-0.5 text-xs font-medium ring-1 ring-inset', CELL_TONE[cell.dayType] ?? CELL_TONE.OFF)}>
                          {cell.dayType === 'WORK' ? cell.shift?.code ?? 'WORK' : cell.dayType === 'HOLIDAY' ? 'HOL' : 'OFF'}
                        </span>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {grid.data?.meta && <Pagination page={grid.data.meta.page} pageSize={grid.data.meta.pageSize} total={grid.data.meta.total} onPageChange={setPage} />}
      </Card>

      <AssignShiftModal open={assigning} onClose={() => setAssigning(false)} defaultFrom={start} defaultTo={end} />
    </div>
  );
}

function AssignShiftModal({ open, onClose, defaultFrom, defaultTo }: { open: boolean; onClose: () => void; defaultFrom: string; defaultTo: string }) {
  const { assignSchedule } = useAttendanceMutations();
  const shifts = useShiftOptions();
  const toast = useToast();
  const [employees, setEmployees] = useState<{ id: string; employeeCode: string; firstName: string; lastName: string }[]>([]);
  const [shiftId, setShiftId] = useState('');
  const [from, setFrom] = useState(defaultFrom);
  const [to, setTo] = useState(defaultTo);
  const [weekdays, setWeekdays] = useState<Weekday[]>(['MON', 'TUE', 'WED', 'THU', 'FRI']);
  const [includeHolidays, setIncludeHolidays] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    if (employees.length === 0) return setError('Choose at least one employee.');
    if (!from || !to || from > to) return setError('Choose a date range that starts before it ends.');
    try {
      const result = await assignSchedule.mutateAsync({
        employeeIds: employees.map((e) => e.id),
        from,
        to,
        shiftId: shiftId || null,
        weekdays,
        includeHolidays,
        overwriteExisting: true,
      });
      toast.success(`Schedule updated`, `${result.created} created, ${result.updated} changed, ${result.skipped} unchanged`);
      setEmployees([]);
      onClose();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.error.message : 'Something went wrong.');
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Assign a shift"
      description={`${formatBusinessDate(from)} → ${formatBusinessDate(to)}`}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={submit} loading={assignSchedule.isPending}>Assign</Button></>}
    >
      <div className="space-y-4">
        {error && <Alert>{error}</Alert>}
        <div className="space-y-1.5">
          <span className="block text-sm font-medium text-slate-700">Employees</span>
          <EmployeeSelect
            value={null}
            onChange={(e) => e && setEmployees((prev) => (prev.some((p) => p.id === e.id) ? prev : [...prev, e]))}
            placeholder="Search and add employees…"
          />
          {employees.length > 0 && (
            <div className="flex flex-wrap gap-1.5 pt-1">
              {employees.map((e) => (
                <button key={e.id} type="button" onClick={() => setEmployees((prev) => prev.filter((p) => p.id !== e.id))} className="rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-700 hover:bg-slate-200">
                  {e.employeeCode} ✕
                </button>
              ))}
            </div>
          )}
        </div>
        <Select
          label="Shift"
          options={(shifts.data ?? []).map((s) => ({ value: s.id, label: `${s.code} · ${s.name} (${s.startTime}–${s.endTime})` }))}
          placeholder="No shift — mark the days off"
          value={shiftId}
          onChange={(e) => setShiftId(e.target.value)}
        />
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <label htmlFor="assign-from" className="block text-sm font-medium text-slate-700">From</label>
            <input id="assign-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="h-9 w-full rounded-md border border-slate-300 px-3 text-sm shadow-sm" />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="assign-to" className="block text-sm font-medium text-slate-700">To</label>
            <input id="assign-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} className="h-9 w-full rounded-md border border-slate-300 px-3 text-sm shadow-sm" />
          </div>
        </div>
        <div className="space-y-1.5">
          <span className="block text-sm font-medium text-slate-700">Working days</span>
          <div className="flex flex-wrap gap-1.5">
            {WEEKDAYS.map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => setWeekdays((prev) => (prev.includes(d) ? prev.filter((p) => p !== d) : [...prev, d]))}
                className={cn('rounded-md border px-2.5 py-1 text-xs font-medium', weekdays.includes(d) ? 'border-brand-500 bg-brand-50 text-brand-700' : 'border-slate-300 text-slate-600')}
              >
                {d}
              </button>
            ))}
          </div>
        </div>
        <Checkbox label="Also schedule work on public holidays" checked={includeHolidays} onChange={(e) => setIncludeHolidays(e.target.checked)} />
        <p className="text-xs text-slate-500">
          Days outside the chosen weekdays become days off, and holidays from the organization&apos;s work calendar stay
          holidays unless you tick the box. Approved leave is not written here — it is read when the day is calculated.
        </p>
      </div>
    </Modal>
  );
}
