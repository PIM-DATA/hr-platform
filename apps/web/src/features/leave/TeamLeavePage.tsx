import { useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, CalendarOff } from 'lucide-react';
import { LEAVE_BLOCKING_STATUSES, type LeaveCalendarEntryDto } from '@hr/shared';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { SearchInput } from '@/components/ui/SearchInput';
import { Select } from '@/components/ui/Select';
import { Spinner } from '@/components/ui/Spinner';
import { useAuth } from '@/hooks/useAuth';
import { useDebounce } from '@/hooks/useDebounce';
import { useLeaveCalendar, useLeaveTypeOptions } from './leave.api';
import { LeaveRequestDetailDialog } from './LeaveRequestDetailDialog';
import { LeaveStatusBadge, formatBusinessDate, formatLeavePeriod, formatLeaveUnits } from './leave-ui';

const pad = (n: number) => String(n).padStart(2, '0');
const monthRange = (month: string) => {
  const [y, m] = month.split('-').map(Number);
  const last = new Date(y, m, 0).getDate();
  return { from: `${month}-01`, to: `${month}-${pad(last)}` };
};
const shiftMonth = (month: string, by: number) => {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(y, m - 1 + by, 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
};
const thisMonth = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; };

/**
 * Who is away, grouped by day. A deliberately dependency-free month list (no calendar library): the server returns a
 * summary projection inside the caller's data scope — never reasons, attachments, policy internals or ledger figures.
 */
export function TeamLeavePage() {
  const { user } = useAuth();
  const [month, setMonth] = useState(thisMonth);
  const [status, setStatus] = useState('');
  const [leaveTypeId, setLeaveTypeId] = useState('');
  const [search, setSearch] = useState('');
  const debounced = useDebounce(search, 300);
  const [detailId, setDetailId] = useState<string | null>(null);
  const range = monthRange(month);
  const types = useLeaveTypeOptions();
  const q = useLeaveCalendar({ ...range, status: status || undefined, leaveTypeId: leaveTypeId || undefined, search: debounced || undefined });

  /** One row per day the person is away, so a multi-day request appears on each of its days. */
  const byDay = useMemo(() => {
    const map = new Map<string, LeaveCalendarEntryDto[]>();
    for (const e of q.data ?? []) {
      for (let d = e.startDate > range.from ? e.startDate : range.from; d <= (e.endDate < range.to ? e.endDate : range.to); d = nextDay(d)) {
        if (!map.has(d)) map.set(d, []);
        map.get(d)!.push(e);
      }
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [q.data, range.from, range.to]);

  return (
    <>
      <Card>
        <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 p-4">
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="sm" aria-label="Previous month" onClick={() => setMonth(shiftMonth(month, -1))}><ChevronLeft className="h-4 w-4" /></Button>
            <span className="min-w-[9rem] text-center text-sm font-semibold text-slate-900">{formatBusinessDate(`${month}-01`, { month: 'long', year: 'numeric' })}</span>
            <Button variant="ghost" size="sm" aria-label="Next month" onClick={() => setMonth(shiftMonth(month, 1))}><ChevronRight className="h-4 w-4" /></Button>
          </div>
          <Select aria-label="Filter by status" className="w-full sm:w-40" placeholder="Pending + approved" value={status} onChange={(e) => setStatus(e.target.value)}
            options={LEAVE_BLOCKING_STATUSES.map((s) => ({ value: s, label: s.charAt(0) + s.slice(1).toLowerCase() }))} />
          <Select aria-label="Filter by leave type" className="w-full sm:w-44" placeholder="All leave types" value={leaveTypeId} onChange={(e) => setLeaveTypeId(e.target.value)}
            options={(types.data ?? []).map((t) => ({ value: t.id, label: t.name }))} />
          {user?.dataScope === 'ALL' && <SearchInput className="w-full sm:w-52" placeholder="Search employee…" value={search} onChange={setSearch} />}
        </div>
        {q.isError && <Alert className="m-4">Could not load the team calendar.</Alert>}
        {q.isLoading ? (
          <div className="flex justify-center py-12"><Spinner /></div>
        ) : byDay.length === 0 ? (
          <EmptyState icon={<CalendarOff className="h-6 w-6" />} title="No leave found for this period" description="Nobody in your scope is away with these filters." />
        ) : (
          <ul className="divide-y divide-slate-100">
            {byDay.map(([day, entries]) => (
              <li key={day} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:gap-4">
                <div className="sm:w-40 sm:shrink-0">
                  <div className="text-sm font-semibold text-slate-900">{formatBusinessDate(day, { weekday: 'short', day: 'numeric', month: 'short' })}</div>
                  <div className="text-xs text-slate-500">{entries.length} away</div>
                </div>
                <ul className="flex-1 space-y-1.5">
                  {entries.map((e) => (
                    <li key={`${day}-${e.requestId}`}>
                      <button type="button" onClick={() => setDetailId(e.requestId)} className="flex w-full flex-wrap items-center gap-x-2 gap-y-1 rounded-md px-2 py-1 text-left text-sm hover:bg-slate-50">
                        <span className="font-medium text-slate-900">{e.employee.firstName} {e.employee.lastName}</span>
                        <span className="text-xs text-slate-500">{e.employee.employeeCode}</span>
                        <span className="text-slate-600">· {e.leaveType.name}</span>
                        <span className="text-xs text-slate-500">({formatLeavePeriod(e)} · {formatLeaveUnits(e.units)} d)</span>
                        <LeaveStatusBadge status={e.status} />
                      </button>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <LeaveRequestDetailDialog id={detailId} onClose={() => setDetailId(null)} />
    </>
  );
}

function nextDay(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const next = new Date(y, m - 1, d + 1);
  return `${next.getFullYear()}-${pad(next.getMonth() + 1)}-${pad(next.getDate())}`;
}
