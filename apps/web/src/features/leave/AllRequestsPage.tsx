import { useState } from 'react';
import { LEAVE_REQUEST_STATUSES, type LeaveRequestDto } from '@hr/shared';
import { Alert } from '@/components/ui/Alert';
import { Card } from '@/components/ui/Card';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { Input } from '@/components/ui/Input';
import { Pagination } from '@/components/ui/Pagination';
import { SearchInput } from '@/components/ui/SearchInput';
import { Select } from '@/components/ui/Select';
import { useDebounce } from '@/hooks/useDebounce';
import { useOrganizationOptions } from '@/features/organization/organization.api';
import { formatDateTime } from '@/lib/format';
import { useAllLeaveRequests, useLeaveTypeOptions } from './leave.api';
import { LeaveRequestDetailDialog } from './LeaveRequestDetailDialog';
import { LeaveStatusBadge, formatLeavePeriod, formatLeaveUnits } from './leave-ui';

/**
 * Organization-wide leave requests (data scope ALL). Summary columns only — reason and attachment stay in the detail
 * dialog. All filtering and pagination happen in the database.
 */
export function AllRequestsPage() {
  const [filters, setFilters] = useState({ status: '', leaveTypeId: '', organizationId: '', from: '', to: '' });
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const debounced = useDebounce(search, 300);
  const [detailId, setDetailId] = useState<string | null>(null);
  const types = useLeaveTypeOptions();
  const orgs = useOrganizationOptions();
  const set = (key: keyof typeof filters, value: string) => { setFilters((f) => ({ ...f, [key]: value })); setPage(1); };
  const list = useAllLeaveRequests({ ...filters, search: debounced || undefined, page, pageSize: 20 });

  const columns: Column<LeaveRequestDto>[] = [
    { key: 'employee', header: 'Employee', render: (r) => <div><div className="font-medium text-slate-900">{r.employee.firstName} {r.employee.lastName}</div><div className="text-xs text-slate-500">{r.employee.employeeCode}</div></div> },
    { key: 'type', header: 'Leave type', hideBelow: 'sm', render: (r) => r.leaveType.name },
    { key: 'dates', header: 'Dates', render: (r) => <span className="whitespace-nowrap">{formatLeavePeriod(r)}</span> },
    { key: 'units', header: 'Days', className: 'text-right', render: (r) => <span className="tabular-nums">{formatLeaveUnits(r.units)}</span> },
    { key: 'status', header: 'Status', render: (r) => <LeaveStatusBadge status={r.status} /> },
    { key: 'submitted', header: 'Submitted', hideBelow: 'lg', render: (r) => <span className="text-slate-500">{r.submittedAt ? formatDateTime(r.submittedAt) : '—'}</span> },
  ];

  return (
    <>
      <Card>
        <div className="grid grid-cols-1 gap-3 border-b border-slate-200 p-4 sm:grid-cols-2 xl:grid-cols-6">
          <SearchInput placeholder="Search employee…" value={search} onChange={(v) => { setSearch(v); setPage(1); }} />
          <Select aria-label="Filter by status" placeholder="All statuses" value={filters.status} onChange={(e) => set('status', e.target.value)}
            options={LEAVE_REQUEST_STATUSES.map((s) => ({ value: s, label: s.charAt(0) + s.slice(1).toLowerCase() }))} />
          <Select aria-label="Filter by leave type" placeholder="All leave types" value={filters.leaveTypeId} onChange={(e) => set('leaveTypeId', e.target.value)}
            options={(types.data ?? []).map((t) => ({ value: t.id, label: t.name }))} />
          <Select aria-label="Filter by organization" placeholder="All organizations" value={filters.organizationId} onChange={(e) => set('organizationId', e.target.value)}
            options={(orgs.data?.data ?? []).map((o) => ({ value: o.id, label: o.name }))} />
          <Input aria-label="From date" type="date" value={filters.from} onChange={(e) => set('from', e.target.value)} />
          <Input aria-label="To date" type="date" value={filters.to} onChange={(e) => set('to', e.target.value)} />
        </div>
        {list.isError && <Alert className="m-4">Could not load leave requests.</Alert>}
        <DataTable
          columns={columns}
          rows={list.data?.data ?? []}
          rowKey={(r) => r.id}
          loading={list.isLoading}
          onRowClick={(r) => setDetailId(r.id)}
          emptyTitle="No leave requests"
          emptyDescription="No requests match these filters."
        />
        {list.data?.meta && <Pagination {...list.data.meta} onPageChange={setPage} />}
      </Card>
      <LeaveRequestDetailDialog id={detailId} onClose={() => setDetailId(null)} />
    </>
  );
}
