import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { LeaveApprovalItemDto } from '@hr/shared';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { Pagination } from '@/components/ui/Pagination';
import { formatDateTime } from '@/lib/format';
import { useLeaveApprovals } from './leave.api';
import { LeaveRequestDetailDialog } from './LeaveRequestDetailDialog';
import { formatLeavePeriod, formatLeaveUnits } from './leave-ui';

/**
 * Approval inbox: one projection query (`/leave/approvals`) returns the pending steps where I am the snapshot approver
 * together with their request data — no per-row detail fetch. Data scope never widens this list.
 */
export function ApprovalsPage() {
  const [page, setPage] = useState(1);
  const list = useLeaveApprovals({ page, pageSize: 10 });
  // `?request=<id>` deep-links here from an APPROVAL_REQUIRED notification, even if the row already left the inbox.
  const [params, setParams] = useSearchParams();
  const [detailId, setDetailId] = useState<string | null>(params.get('request'));
  const closeDetail = () => { setDetailId(null); setParams((p) => { const next = new URLSearchParams(p); next.delete('request'); return next; }, { replace: true }); };

  const columns: Column<LeaveApprovalItemDto>[] = [
    {
      key: 'employee', header: 'Employee',
      render: (i) => (
        <div>
          <div className="font-medium text-slate-900">{i.request.employee.firstName} {i.request.employee.lastName}</div>
          <div className="text-xs text-slate-500">{i.request.employee.employeeCode}{i.request.employee.department ? ` · ${i.request.employee.department.name}` : ''}</div>
          <div className="mt-0.5 text-xs text-slate-500 md:hidden">{i.request.leaveType.name} · {formatLeavePeriod(i.request)} · {formatLeaveUnits(i.request.units)} d</div>
        </div>
      ),
    },
    { key: 'type', header: 'Leave type', hideBelow: 'md', render: (i) => i.request.leaveType.name },
    { key: 'dates', header: 'Dates', hideBelow: 'md', render: (i) => formatLeavePeriod(i.request) },
    { key: 'units', header: 'Days', className: 'text-right', render: (i) => <span className="tabular-nums">{formatLeaveUnits(i.request.units)}</span> },
    { key: 'step', header: 'Step', hideBelow: 'lg', render: (i) => <span className="text-slate-600">{i.stepName}</span> },
    { key: 'submitted', header: 'Submitted', hideBelow: 'lg', render: (i) => <span className="text-slate-500">{i.submittedAt ? formatDateTime(i.submittedAt) : '—'}</span> },
    {
      key: 'actions', header: <span className="sr-only">Actions</span>, className: 'text-right',
      render: (i) => <div onClick={(e) => e.stopPropagation()}><Button size="sm" onClick={() => setDetailId(i.request.id)}>Review</Button></div>,
    },
  ];

  return (
    <>
      <Card>
        {list.isError && <Alert className="m-4">Could not load your approvals.</Alert>}
        <DataTable
          columns={columns}
          rows={list.data?.data ?? []}
          rowKey={(i) => i.workflowStepId}
          loading={list.isLoading}
          onRowClick={(i) => setDetailId(i.request.id)}
          emptyTitle="No approvals waiting for you"
          emptyDescription="Leave requests appear here when you are the approver of the step that is currently pending."
        />
        {list.data?.meta && <Pagination {...list.data.meta} onPageChange={setPage} />}
      </Card>
      <LeaveRequestDetailDialog id={detailId} onClose={closeDetail} />
    </>
  );
}
