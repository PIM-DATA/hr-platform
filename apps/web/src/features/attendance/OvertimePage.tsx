import { useState } from 'react';
import { Plus } from 'lucide-react';
import { PERMISSIONS, formatOvertimeMinutes, type OvertimeRequestDto } from '@hr/shared';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Alert } from '@/components/ui/Alert';
import { Input } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/Textarea';
import { Select } from '@/components/ui/Select';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { Pagination } from '@/components/ui/Pagination';
import { LoadingBlock } from '@/components/ui/Spinner';
import { useToast } from '@/components/ui/Toast';
import { useAuth } from '@/hooks/useAuth';
import { usePermission } from '@/hooks/usePermission';
import { ApiClientError } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import { useOvertimeMutations, useOvertimeRequest, useOvertimeRequests } from './overtime.api';
import { formatBusinessDate, formatClockTime } from './attendance-ui';

const PAGE_SIZE = 20;

const STATUS_TONE: Record<string, 'success' | 'neutral' | 'warning' | 'danger' | 'info'> = {
  DRAFT: 'neutral', PENDING: 'warning', APPROVED: 'success', REJECTED: 'danger', CANCELLED: 'neutral',
};
const DAY_TYPE_LABEL: Record<string, string> = { WORKDAY: 'Workday', OFF_DAY: 'Off day', HOLIDAY: 'Holiday' };

export const OvertimeStatusBadge = ({ status }: { status: string }) => (
  <StatusBadge status={status.charAt(0) + status.slice(1).toLowerCase()} tone={STATUS_TONE[status] ?? 'neutral'} />
);

/**
 * Overtime claims: mine, the ones waiting for my decision, and (with a wide enough scope) everyone's.
 *
 * Every number on this screen comes from the server — eligibility, the multiplier, what may be claimed. Nothing here
 * recomputes any of it, and nothing here turns minutes into money: that is payroll's job and it does not exist yet.
 */
export function OvertimePage() {
  const { user, scopeOf } = useAuth();
  const canRequest = usePermission(PERMISSIONS.OT_REQUEST);
  const canApprove = usePermission(PERMISSIONS.WORKFLOW_APPROVE);
  const scope = scopeOf(PERMISSIONS.OT_VIEW);
  const views = [
    { key: 'mine', label: 'My overtime' },
    ...(canApprove ? [{ key: 'inbox', label: 'Waiting for me' }] : []),
    ...(scope === 'TEAM' || scope === 'ALL' ? [{ key: 'all', label: scope === 'ALL' ? 'Everyone' : 'My team' }] : []),
  ];
  const [view, setView] = useState(views[0].key);
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const requests = useOvertimeRequests({ view, status: status || undefined, page, pageSize: PAGE_SIZE });

  const columns: Column<OvertimeRequestDto>[] = [
    { key: 'date', header: 'Date', render: (r) => <span className="font-medium text-slate-900">{formatBusinessDate(r.attendanceDate)}</span> },
    ...(view === 'mine'
      ? []
      : [{ key: 'employee', header: 'Employee', render: (r: OvertimeRequestDto) => `${r.employee.firstName} ${r.employee.lastName} (${r.employee.employeeCode})` }]),
    { key: 'dayType', header: 'Day type', hideBelow: 'sm', render: (r) => DAY_TYPE_LABEL[r.dayType] ?? r.dayType },
    { key: 'claimed', header: 'Claimed', render: (r) => formatOvertimeMinutes(r.claimedMinutes) },
    { key: 'approved', header: 'Approved', render: (r) => (r.approvedMinutes ? formatOvertimeMinutes(r.approvedMinutes) : <span className="text-slate-400">—</span>) },
    { key: 'multiplier', header: 'Rate', hideBelow: 'md', render: (r) => (r.rateMultiplierSnapshot ? `×${r.rateMultiplierSnapshot}` : <span className="text-slate-400">—</span>) },
    { key: 'status', header: 'Status', render: (r) => <OvertimeStatusBadge status={r.status} /> },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        {views.length > 1 ? (
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
        ) : <div />}
        {canRequest && !!user?.employee && (
          <Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> Claim overtime</Button>
        )}
      </div>

      <Card>
        <div className="border-b border-slate-200 p-4">
          <Select
            options={['DRAFT', 'PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'].map((s) => ({ value: s, label: s.charAt(0) + s.slice(1).toLowerCase() }))}
            placeholder="All statuses"
            value={status}
            onChange={(e) => { setStatus(e.target.value); setPage(1); }}
            className="w-44"
          />
        </div>
        {requests.isError && <Alert className="m-4">Could not load overtime claims.</Alert>}
        <DataTable
          columns={columns}
          rows={requests.data?.data ?? []}
          rowKey={(r) => r.id}
          loading={requests.isLoading}
          onRowClick={(r) => setOpenId(r.id)}
          emptyTitle="No overtime claims"
          emptyDescription={view === 'inbox' ? 'No claim is waiting for your decision.' : 'Claim overtime for a day you worked beyond your shift.'}
        />
        {requests.data?.meta && <Pagination page={requests.data.meta.page} pageSize={requests.data.meta.pageSize} total={requests.data.meta.total} onPageChange={setPage} />}
      </Card>

      <ClaimOvertimeModal open={creating} onClose={() => setCreating(false)} />
      <OvertimeDetailModal id={openId} onClose={() => setOpenId(null)} />
    </div>
  );
}

/** Claiming: pick a day, see what it allows, claim some or all of it. */
function ClaimOvertimeModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { preview, create, submit } = useOvertimeMutations();
  const toast = useToast();
  const [date, setDate] = useState('');
  const [minutes, setMinutes] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const day = preview.data;

  const runPreview = async (value: string) => {
    setDate(value);
    setError(null);
    preview.reset();
    if (!value) return;
    try {
      const result = await preview.mutateAsync(value);
      setMinutes(result.maximumClaimableMinutes > 0 ? String(result.maximumClaimableMinutes) : '');
    } catch (err) {
      setError(err instanceof ApiClientError ? err.error.message : 'Could not read that day.');
    }
  };

  const onSubmit = async () => {
    setError(null);
    const claimedMinutes = Number(minutes);
    if (!date) return setError('Choose the day you worked.');
    if (!Number.isInteger(claimedMinutes) || claimedMinutes <= 0) return setError('Claim a whole number of minutes.');
    try {
      const created = await create.mutateAsync({ attendanceDate: date, claimedMinutes, reason: reason.trim() || null });
      await submit.mutateAsync(created.id);
      toast.success('Overtime claim sent for approval');
      setDate(''); setMinutes(''); setReason(''); preview.reset();
      onClose();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.error.message : 'Something went wrong.');
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Claim overtime"
      description="For a day that has already finished"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={onSubmit} loading={create.isPending || submit.isPending} disabled={!day?.claimable}>Send for approval</Button></>}
    >
      <div className="space-y-4">
        {error && <Alert>{error}</Alert>}
        <div className="space-y-1.5">
          <label htmlFor="ot-date" className="block text-sm font-medium text-slate-700">Day</label>
          <input id="ot-date" type="date" value={date} onChange={(e) => runPreview(e.target.value)} className="h-9 w-full rounded-md border border-slate-300 px-3 text-sm shadow-sm" />
        </div>

        {preview.isPending && <LoadingBlock />}
        {day && (
          <div className="rounded-md border border-slate-200 p-3 text-sm">
            <dl className="grid grid-cols-2 gap-y-1.5">
              <dt className="text-slate-500">Day type</dt><dd className="text-slate-800">{DAY_TYPE_LABEL[day.dayType] ?? day.dayType}</dd>
              <dt className="text-slate-500">Clocked</dt><dd className="text-slate-800">{formatClockTime(day.firstClockIn)} – {formatClockTime(day.lastClockOut)}</dd>
              <dt className="text-slate-500">Worked</dt><dd className="text-slate-800">{formatOvertimeMinutes(day.workedMinutes)}</dd>
              <dt className="text-slate-500">Eligible overtime</dt><dd className="font-medium text-slate-900">{formatOvertimeMinutes(day.eligibleMinutes)}</dd>
              <dt className="text-slate-500">Most you can claim</dt><dd className="text-slate-800">{formatOvertimeMinutes(day.maximumClaimableMinutes)}</dd>
              {day.policy && (<><dt className="text-slate-500">Rate</dt><dd className="text-slate-800">×{day.policy.multiplier} ({day.policy.name})</dd></>)}
            </dl>
            {!day.claimable && <p className="mt-2 text-xs text-amber-700">{day.reason}</p>}
          </div>
        )}

        <Input
          label="Minutes to claim"
          type="number"
          min={1}
          value={minutes}
          onChange={(e) => setMinutes(e.target.value)}
          hint={minutes && Number(minutes) > 0 ? formatOvertimeMinutes(Number(minutes)) : 'Whole minutes — 150 means 2h 30m'}
          disabled={!day?.claimable}
        />
        <Textarea label="Reason (optional)" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why the extra time was needed." />
        <p className="text-xs text-slate-500">
          The day type, the rate and how much of the day is eligible are decided by the server from your attendance and
          the overtime policy. This screen shows minutes — no pay is calculated anywhere in the system yet.
        </p>
      </div>
    </Modal>
  );
}

function OvertimeDetailModal({ id, onClose }: { id: string | null; onClose: () => void }) {
  const request = useOvertimeRequest(id);
  const { decide, cancel } = useOvertimeMutations();
  const { user, hasPermission } = useAuth();
  const toast = useToast();
  const [comment, setComment] = useState('');
  const [error, setError] = useState<string | null>(null);
  const data = request.data;

  const isMine = !!data && data.employee.id === user?.employee?.id;
  const canDecide = !!data && data.status === 'PENDING' && !!data.workflowInstanceId && hasPermission(PERMISSIONS.WORKFLOW_APPROVE) && !isMine;

  const act = async (action: 'APPROVE' | 'REJECT') => {
    if (!data?.workflowInstanceId) return;
    setError(null);
    try {
      await decide.mutateAsync({ instanceId: data.workflowInstanceId, action, comment: comment.trim() || undefined });
      toast.success(action === 'APPROVE' ? 'Overtime approved' : 'Overtime rejected');
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
      toast.success('Claim withdrawn');
      onClose();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.error.message : 'Something went wrong.');
    }
  };

  return (
    <Modal
      open={!!id}
      onClose={() => { setError(null); onClose(); }}
      title="Overtime claim"
      description={data ? formatBusinessDate(data.attendanceDate) : undefined}
      footer={<Button variant="secondary" onClick={onClose}>Close</Button>}
    >
      {request.isLoading || !data ? (
        <LoadingBlock />
      ) : (
        <div className="space-y-4 text-sm">
          {error && <Alert>{error}</Alert>}
          <dl className="grid grid-cols-[11rem_1fr] gap-y-2">
            <dt className="text-slate-500">Employee</dt><dd className="text-slate-800">{data.employee.firstName} {data.employee.lastName} ({data.employee.employeeCode})</dd>
            <dt className="text-slate-500">Day type</dt><dd className="text-slate-800">{DAY_TYPE_LABEL[data.dayType] ?? data.dayType}</dd>
            <dt className="text-slate-500">Claimed</dt><dd className="text-slate-800">{formatOvertimeMinutes(data.claimedMinutes)} ({data.claimedMinutes} minutes)</dd>
            <dt className="text-slate-500">Eligible at submit</dt><dd className="text-slate-800">{data.eligibleMinutesSnapshot ? formatOvertimeMinutes(data.eligibleMinutesSnapshot) : '—'}</dd>
            <dt className="text-slate-500">Approved</dt><dd className="text-slate-800">{data.approvedMinutes ? formatOvertimeMinutes(data.approvedMinutes) : '—'}</dd>
            <dt className="text-slate-500">Rate</dt><dd className="text-slate-800">{data.rateMultiplierSnapshot ? `×${data.rateMultiplierSnapshot}` : '—'}{data.policy ? ` (${data.policy.name})` : ''}</dd>
            <dt className="text-slate-500">Status</dt><dd><OvertimeStatusBadge status={data.status} /></dd>
          </dl>

          {data.reason && (
            <div>
              <div className="text-slate-500">Reason</div>
              <p className="mt-1 whitespace-pre-wrap rounded-md bg-slate-50 p-3 text-slate-800">{data.reason}</p>
            </div>
          )}

          {canDecide && (
            <div className="space-y-2 border-t border-slate-200 pt-4">
              <Textarea label="Comment (optional)" value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Kept in the approval timeline, not in the notification." />
              <div className="flex gap-2">
                <Button loading={decide.isPending} onClick={() => act('APPROVE')}>Approve</Button>
                <Button variant="danger" loading={decide.isPending} onClick={() => act('REJECT')}>Reject</Button>
              </div>
              <p className="text-xs text-slate-500">
                Approving re-checks the claim against the attendance as it stands now. If the day has changed since it
                was submitted, approval is refused rather than granting overtime the attendance no longer supports.
              </p>
            </div>
          )}

          {isMine && ['DRAFT', 'PENDING'].includes(data.status) && (
            <div className="border-t border-slate-200 pt-4">
              <Button variant="secondary" loading={cancel.isPending} onClick={withdraw}>Withdraw claim</Button>
            </div>
          )}
          {isMine && data.status === 'APPROVED' && (
            <p className="border-t border-slate-200 pt-4 text-xs text-slate-500">
              An approved claim is payroll input and cannot be withdrawn here. Ask HR if it is wrong.
            </p>
          )}
        </div>
      )}
    </Modal>
  );
}
