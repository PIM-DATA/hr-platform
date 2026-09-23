import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { LEAVE_REQUEST_STATUSES, PERMISSIONS, type LeaveRequestDto } from '@hr/shared';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { Pagination } from '@/components/ui/Pagination';
import { Select } from '@/components/ui/Select';
import { useAuth } from '@/hooks/useAuth';
import { formatDateTime } from '@/lib/format';
import { useMyBalances, useMyLeaveRequests } from './leave.api';
import { BalanceCards, LeaveStatusBadge, formatLeavePeriod, formatLeaveUnits } from './leave-ui';
import { LeaveRequestDialog } from './LeaveRequestDialog';
import { LeaveRequestDetailDialog } from './LeaveRequestDetailDialog';

/** My Leave: the caller's own balances and requests. `/leave/requests/me` never widens with data scope. */
export function MyLeavePage() {
  const { user, hasPermission } = useAuth();
  const [params, setParams] = useSearchParams();
  const status = params.get('status') ?? '';
  const page = Number(params.get('page') ?? 1);
  const setParam = (key: string, value: string) => setParams((p) => { const next = new URLSearchParams(p); if (value) next.set(key, value); else next.delete(key); if (key !== 'page') next.delete('page'); return next; }, { replace: true });
  const [editing, setEditing] = useState<{ open: boolean; request?: LeaveRequestDto }>({ open: false });
  // `?request=<id>` deep-links here from a notification; closing the dialog drops the parameter again.
  const [detailId, setDetailId] = useState<string | null>(params.get('request'));
  const closeDetail = () => { setDetailId(null); setParams((p) => { const next = new URLSearchParams(p); next.delete('request'); return next; }, { replace: true }); };

  const hasProfile = !!user?.employee;
  const balances = useMyBalances();
  const list = useMyLeaveRequests({ status, page, pageSize: 10 });

  const columns: Column<LeaveRequestDto>[] = [
    { key: 'period', header: 'Dates', render: (r) => <div><div className="font-medium text-slate-900">{formatLeavePeriod(r)}</div><div className="text-xs text-slate-500 sm:hidden">{r.leaveType.name} · {formatLeaveUnits(r.units)} d</div></div> },
    { key: 'type', header: 'Leave type', hideBelow: 'sm', render: (r) => r.leaveType.name },
    { key: 'units', header: 'Days', hideBelow: 'sm', className: 'text-right', render: (r) => <span className="tabular-nums">{formatLeaveUnits(r.units)}</span> }, // phones read the days from the subtitle under the dates
    { key: 'status', header: 'Status', render: (r) => <LeaveStatusBadge status={r.status} /> },
    { key: 'submitted', header: 'Submitted', hideBelow: 'lg', render: (r) => <span className="text-slate-500">{r.submittedAt ? formatDateTime(r.submittedAt) : '—'}</span> },
    {
      key: 'actions', header: <span className="sr-only">Actions</span>, className: 'text-right',
      render: (r) => (
        <div className="flex justify-end gap-1" onClick={(e) => e.stopPropagation()}>
          {r.status === 'DRAFT' && <Button size="sm" variant="secondary" onClick={() => setEditing({ open: true, request: r })}>Edit</Button>}
          <Button size="sm" variant="ghost" onClick={() => setDetailId(r.id)}>View</Button>
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <section>
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-slate-900">My balances</h2>
          {hasProfile && hasPermission(PERMISSIONS.LEAVE_REQUEST) && (
            <Button onClick={() => setEditing({ open: true })}><Plus className="h-4 w-4" /> New leave request</Button>
          )}
        </div>
        {!hasProfile ? (
          <Alert>No employee profile is linked to this account, so leave balances and requests are not available. Administration → Leave settings is unaffected.</Alert>
        ) : (
          <BalanceCards balances={balances.data} loading={balances.isLoading} />
        )}
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold text-slate-900">My requests</h2>
        <Card>
          <div className="flex flex-wrap gap-3 border-b border-slate-200 p-4">
            <Select
              aria-label="Filter by status"
              className="w-full sm:w-52"
              options={LEAVE_REQUEST_STATUSES.map((s) => ({ value: s, label: s.charAt(0) + s.slice(1).toLowerCase() }))}
              placeholder="All statuses"
              value={status}
              onChange={(e) => setParam('status', e.target.value)}
            />
          </div>
          {list.isError && <Alert className="m-4">Could not load your leave requests.</Alert>}
          <DataTable
            columns={columns}
            rows={list.data?.data ?? []}
            rowKey={(r) => r.id}
            loading={list.isLoading}
            onRowClick={(r) => setDetailId(r.id)}
            emptyTitle="No leave requests yet"
            emptyDescription={hasProfile ? 'Create a request to see it here.' : 'This account has no employee profile.'}
          />
          {list.data?.meta && <Pagination {...list.data.meta} onPageChange={(p) => setParam('page', String(p))} />}
        </Card>
      </section>

      <LeaveRequestDialog open={editing.open} request={editing.request} onClose={() => setEditing({ open: false })} onOpenDetail={setDetailId} />
      <LeaveRequestDetailDialog id={detailId} onClose={closeDetail} onEditDraft={(r) => { closeDetail(); setEditing({ open: true, request: r }); }} />
    </div>
  );
}
