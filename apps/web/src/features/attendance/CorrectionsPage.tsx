import { useState } from 'react';
import { PERMISSIONS, type CorrectionDto } from '@hr/shared';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Alert } from '@/components/ui/Alert';
import { Textarea } from '@/components/ui/Textarea';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { Pagination } from '@/components/ui/Pagination';
import { LoadingBlock } from '@/components/ui/Spinner';
import { useToast } from '@/components/ui/Toast';
import { useAuth } from '@/hooks/useAuth';
import { usePermission } from '@/hooks/usePermission';
import { ApiClientError } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import { useCorrection, useCorrectionMutations, useCorrections } from './attendance.api';
import { AttendanceStatusBadge, CorrectionStatusBadge, formatBusinessDate, formatClockTime } from './attendance-ui';

const PAGE_SIZE = 20;

/**
 * Correction requests: what I asked for, and (for approvers) what is waiting for me. Approving and rejecting go
 * through the shared workflow endpoint, so the inbox, the timeline and the notification all behave like Leave.
 */
export function CorrectionsPage() {
  const { scopeOf } = useAuth();
  const canApprove = usePermission(PERMISSIONS.WORKFLOW_APPROVE);
  const canSeeAll = scopeOf(PERMISSIONS.ATTENDANCE_VIEW) === 'ALL';
  const views = [
    { key: 'mine', label: 'My requests' },
    ...(canApprove ? [{ key: 'inbox', label: 'Waiting for me' }] : []),
    ...(canSeeAll ? [{ key: 'all', label: 'All' }] : []),
  ];
  const [view, setView] = useState(views[0].key);
  const [page, setPage] = useState(1);
  const [openId, setOpenId] = useState<string | null>(null);
  const corrections = useCorrections({ view, page, pageSize: PAGE_SIZE });

  const columns: Column<CorrectionDto>[] = [
    { key: 'date', header: 'Date', render: (c) => <span className="font-medium text-slate-900">{formatBusinessDate(c.attendanceDate)}</span> },
    ...(view === 'mine'
      ? []
      : [{ key: 'employee', header: 'Employee', render: (c: CorrectionDto) => `${c.employee.firstName} ${c.employee.lastName} (${c.employee.employeeCode})` }]),
    { key: 'in', header: 'Requested in', render: (c) => formatClockTime(c.requestedClockIn) },
    { key: 'out', header: 'Requested out', render: (c) => formatClockTime(c.requestedClockOut) },
    { key: 'reason', header: 'Reason', hideBelow: 'lg', render: (c) => <span className="line-clamp-1 text-slate-600">{c.reason}</span> },
    { key: 'status', header: 'Status', render: (c) => <CorrectionStatusBadge status={c.status} /> },
  ];

  return (
    <div className="space-y-4">
      {views.length > 1 && (
        <div className="flex gap-1 border-b border-slate-200">
          {views.map((v) => (
            <button
              key={v.key}
              onClick={() => { setView(v.key); setPage(1); }}
              className={cn('border-b-2 px-3 py-2 text-sm font-medium', view === v.key ? 'border-brand-600 text-brand-700' : 'border-transparent text-slate-500 hover:text-slate-700')}
            >
              {v.label}
            </button>
          ))}
        </div>
      )}
      <Card>
        {corrections.isError && <Alert className="m-4">Could not load correction requests.</Alert>}
        <DataTable
          columns={columns}
          rows={corrections.data?.data ?? []}
          rowKey={(c) => c.id}
          loading={corrections.isLoading}
          onRowClick={(c) => setOpenId(c.id)}
          emptyTitle="Nothing here"
          emptyDescription={view === 'inbox' ? 'No correction is waiting for your decision.' : 'Request a correction from My attendance when a day is wrong.'}
        />
        {corrections.data?.meta && <Pagination page={corrections.data.meta.page} pageSize={corrections.data.meta.pageSize} total={corrections.data.meta.total} onPageChange={setPage} />}
      </Card>

      <CorrectionDetailModal id={openId} onClose={() => setOpenId(null)} />
    </div>
  );
}

function CorrectionDetailModal({ id, onClose }: { id: string | null; onClose: () => void }) {
  const correction = useCorrection(id);
  const { decide, cancel } = useCorrectionMutations();
  const { user, hasPermission } = useAuth();
  const toast = useToast();
  const [comment, setComment] = useState('');
  const [error, setError] = useState<string | null>(null);
  const data = correction.data;

  const isMine = !!data && data.employee.id === user?.employee?.id;
  const canDecide = !!data && data.status === 'PENDING' && !!data.workflowInstanceId && hasPermission(PERMISSIONS.WORKFLOW_APPROVE) && !isMine;

  const act = async (action: 'APPROVE' | 'REJECT') => {
    if (!data?.workflowInstanceId) return;
    setError(null);
    try {
      await decide.mutateAsync({ instanceId: data.workflowInstanceId, action, comment: comment.trim() || undefined });
      toast.success(action === 'APPROVE' ? 'Correction approved' : 'Correction rejected');
      setComment('');
      onClose();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.error.message : 'Something went wrong.');
    }
  };

  const withdraw = async () => {
    if (!data) return;
    setError(null);
    try {
      await cancel.mutateAsync(data.id);
      toast.success('Request withdrawn');
      onClose();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.error.message : 'Something went wrong.');
    }
  };

  return (
    <Modal
      open={!!id}
      onClose={() => { setError(null); onClose(); }}
      title="Correction request"
      description={data ? formatBusinessDate(data.attendanceDate) : undefined}
      footer={<Button variant="secondary" onClick={onClose}>Close</Button>}
    >
      {correction.isLoading || !data ? (
        <LoadingBlock />
      ) : (
        <div className="space-y-4 text-sm">
          {error && <Alert>{error}</Alert>}
          <dl className="grid grid-cols-[10rem_1fr] gap-y-2">
            <dt className="text-slate-500">Employee</dt><dd className="text-slate-800">{data.employee.firstName} {data.employee.lastName} ({data.employee.employeeCode})</dd>
            <dt className="text-slate-500">Status</dt><dd><CorrectionStatusBadge status={data.status} /></dd>
            <dt className="text-slate-500">Requested clock in</dt><dd className="text-slate-800">{formatClockTime(data.requestedClockIn)}</dd>
            <dt className="text-slate-500">Requested clock out</dt><dd className="text-slate-800">{formatClockTime(data.requestedClockOut)}</dd>
          </dl>

          <div>
            <div className="text-slate-500">Reason</div>
            <p className="mt-1 whitespace-pre-wrap rounded-md bg-slate-50 p-3 text-slate-800">{data.reason}</p>
          </div>

          {data.current && (
            <div>
              <div className="text-slate-500">The day as it stands</div>
              <div className="mt-1 flex items-center gap-3 rounded-md border border-slate-200 p-3">
                <AttendanceStatusBadge status={data.current.status} />
                <span className="text-slate-700">In {formatClockTime(data.current.firstClockIn)} · Out {formatClockTime(data.current.lastClockOut)}</span>
              </div>
            </div>
          )}

          {canDecide && (
            <div className="space-y-2 border-t border-slate-200 pt-4">
              <Textarea label="Comment (optional)" value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Kept in the approval timeline, not in the notification." />
              <div className="flex gap-2">
                <Button loading={decide.isPending} onClick={() => act('APPROVE')}>Approve</Button>
                <Button variant="danger" loading={decide.isPending} onClick={() => act('REJECT')}>Reject</Button>
              </div>
              <p className="text-xs text-slate-500">Approving recalculates the day from the requested times. The original clock events are kept untouched.</p>
            </div>
          )}

          {isMine && data.status === 'PENDING' && (
            <div className="border-t border-slate-200 pt-4">
              <Button variant="secondary" loading={cancel.isPending} onClick={withdraw}>Withdraw request</Button>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
