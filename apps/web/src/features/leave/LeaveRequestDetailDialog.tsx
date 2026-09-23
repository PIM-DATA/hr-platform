import { useState } from 'react';
import type { LeaveRequestDetailDto, LeaveRequestDto } from '@hr/shared';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Modal } from '@/components/ui/Modal';
import { Spinner } from '@/components/ui/Spinner';
import { Textarea } from '@/components/ui/Textarea';
import { useToast } from '@/components/ui/Toast';
import { useAuth } from '@/hooks/useAuth';
import { formatDateTime } from '@/lib/format';
import { useLeaveMutations, useLeaveRequest } from './leave.api';
import { LeaveStatusBadge, StepTimeline, formatBusinessDate, formatLeavePeriod, formatLeaveUnits, leaveErrorMessage } from './leave-ui';

const Row = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="flex justify-between gap-4 py-1.5 text-sm">
    <dt className="shrink-0 text-slate-500">{label}</dt>
    <dd className="text-right text-slate-900">{children}</dd>
  </div>
);

/**
 * Leave request detail. Readable by the owner / anyone in data scope and by the snapshot approver (Task 11 rules), so the
 * same dialog serves My leave, Team leave, All requests and the approval inbox. Approve/Reject appear only when the
 * viewer is the approver of the step that is currently pending.
 */
export function LeaveRequestDetailDialog({ id, onClose, onEditDraft }: { id: string | null; onClose: () => void; onEditDraft?: (r: LeaveRequestDto) => void }) {
  const { user } = useAuth();
  const q = useLeaveRequest(id ?? undefined);
  const m = useLeaveMutations();
  const toast = useToast();
  const [comment, setComment] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [rejecting, setRejecting] = useState(false);

  const r = q.data as LeaveRequestDetailDto | undefined;
  const isOwner = !!r && !!user?.employee && r.employee.id === user.employee.id;
  const pendingStep = r?.workflow?.steps.find((s) => s.status === 'PENDING');
  const canDecide = !!r && r.status === 'PENDING' && !!pendingStep && pendingStep.approver?.id === user?.id;

  const decide = async (action: 'APPROVE' | 'REJECT') => {
    if (!r?.workflowInstanceId) return;
    setError(null);
    if (action === 'REJECT' && !comment.trim()) { setRejecting(true); setError('Please add a comment explaining the rejection.'); return; }
    try {
      await m.act.mutateAsync({ instanceId: r.workflowInstanceId, action, comment: comment.trim() });
      toast.success(action === 'APPROVE' ? 'Leave approved' : 'Leave rejected');
      setComment(''); setRejecting(false); onClose();
    } catch (e) { setError(leaveErrorMessage(e)); }
  };
  const doCancel = async () => {
    if (!r) return;
    setError(null);
    try { await m.cancel.mutateAsync(r.id); toast.success('Leave request cancelled'); setConfirmCancel(false); onClose(); }
    catch (e) { setError(leaveErrorMessage(e)); setConfirmCancel(false); }
  };

  return (
    <>
      <Modal
        open={!!id}
        onClose={onClose}
        size="lg"
        title={r ? `${r.leaveType.name} · ${formatLeaveUnits(r.units)} day(s)` : 'Leave request'}
        description={r ? `${r.employee.firstName} ${r.employee.lastName} (${r.employee.employeeCode})` : undefined}
        footer={
          r && (
            <div className="flex w-full flex-wrap items-center justify-end gap-2">
              {isOwner && r.status === 'DRAFT' && onEditDraft && <Button variant="secondary" onClick={() => onEditDraft(r)}>Edit draft</Button>}
              {isOwner && (r.status === 'DRAFT' || r.status === 'PENDING') && (
                <Button variant="danger" onClick={() => setConfirmCancel(true)} loading={m.cancel.isPending}>
                  {r.status === 'PENDING' ? 'Withdraw request' : 'Cancel draft'}
                </Button>
              )}
              {canDecide && (
                <>
                  <Button variant="danger" onClick={() => decide('REJECT')} loading={m.act.isPending}>Reject</Button>
                  <Button onClick={() => decide('APPROVE')} loading={m.act.isPending}>Approve</Button>
                </>
              )}
              <Button variant="secondary" onClick={onClose}>Close</Button>
            </div>
          )
        }
      >
        {q.isLoading && <div className="flex justify-center py-10"><Spinner /></div>}
        {q.isError && <Alert>{leaveErrorMessage(q.error, 'This leave request is not available.')}</Alert>}
        {r && (
          <div className="space-y-5">
            {error && <Alert>{error}</Alert>}
            <div className="flex flex-wrap items-center gap-2">
              <LeaveStatusBadge status={r.status} />
              {r.status === 'APPROVED' && <span className="text-xs text-slate-500">Cancelling approved leave is not supported yet.</span>}
            </div>

            <dl className="divide-y divide-slate-100">
              <Row label="Dates">{formatLeavePeriod(r)}</Row>
              <Row label="Days">{formatLeaveUnits(r.units)}</Row>
              {r.reason && <Row label="Reason"><span className="whitespace-pre-wrap">{r.reason}</span></Row>}
              {r.attachmentRef && <Row label="Attachment reference"><span className="font-mono text-xs">{r.attachmentRef}</span></Row>}
              {r.policy && <Row label="Policy applied">{r.policy.name}</Row>}
              <Row label="Submitted">{r.submittedAt ? formatDateTime(r.submittedAt) : '—'}</Row>
              {r.approvedAt && <Row label="Approved">{formatDateTime(r.approvedAt)}</Row>}
              {r.rejectedAt && <Row label="Rejected">{formatDateTime(r.rejectedAt)}</Row>}
              {r.cancelledAt && <Row label="Cancelled">{formatDateTime(r.cancelledAt)}</Row>}
            </dl>

            {r.balance && (
              <section>
                <h3 className="mb-2 text-sm font-semibold text-slate-900">Balance ({formatBusinessDate(r.balance.periodStart)} → {formatBusinessDate(r.balance.periodEnd)})</h3>
                <div className="grid grid-cols-3 gap-2 text-center">
                  {([['Available', r.balance.available], ['Used', r.balance.used], ['Pending', r.balance.reserved]] as const).map(([label, value]) => (
                    <div key={label} className="rounded-md border border-slate-200 p-2">
                      <div className="text-[11px] uppercase tracking-wide text-slate-500">{label}</div>
                      <div className="text-lg font-semibold tabular-nums text-slate-900">{formatLeaveUnits(value)}</div>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {r.workflow && (
              <section>
                <h3 className="mb-2 text-sm font-semibold text-slate-900">Approval</h3>
                <StepTimeline workflow={r.workflow} />
              </section>
            )}

            {canDecide && (
              <section>
                <Textarea label={`Comment${rejecting ? ' (required to reject)' : ' (optional)'}`} rows={2} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Add a note for the requester" />
                <p className="mt-1 text-xs text-slate-500">A comment is required by this screen when rejecting; the API accepts it as optional.</p>
              </section>
            )}
          </div>
        )}
      </Modal>
      <ConfirmDialog
        open={confirmCancel}
        title={r?.status === 'PENDING' ? 'Withdraw this request?' : 'Cancel this draft?'}
        message={r?.status === 'PENDING' ? 'Cancel this pending leave request? Any reserved days go back to your balance.' : 'This draft will be cancelled and can no longer be submitted.'}
        confirmLabel={r?.status === 'PENDING' ? 'Withdraw request' : 'Cancel draft'}
        variant="danger"
        loading={m.cancel.isPending}
        onConfirm={doCancel}
        onCancel={() => setConfirmCancel(false)}
      />
    </>
  );
}
