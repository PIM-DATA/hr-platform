import { useState } from 'react';
import type { WorkflowInboxItemDto } from '@hr/shared';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Alert } from '@/components/ui/Alert';
import { Textarea } from '@/components/ui/Textarea';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { LoadingBlock } from '@/components/ui/Spinner';
import { useToast } from '@/components/ui/Toast';
import { errorMessage } from '@/features/organization/shared';
import { useApprovalProjection, useErInbox, useErMutations } from './er.api';
import { ActionStatusBadge, ValidityBadge } from './er-ui';

/**
 * The approver's view: the one proposal waiting for their decision, with the case summary and what already stands
 * against the employee — and no internal notes. The decision itself goes through the shared workflow endpoint.
 */
export function ApprovalsPage() {
  const inbox = useErInbox(true);
  const [openId, setOpenId] = useState<string | null>(null);
  const rows = inbox.data ?? [];
  const columns: Column<WorkflowInboxItemDto>[] = [
    { key: 'who', header: 'Employee', render: (r) => <div><div className="font-medium text-slate-900">{r.requesterEmployee.firstName} {r.requesterEmployee.lastName}</div><div className="text-xs text-slate-400">submitted by · {r.requesterEmployee.employeeCode}</div></div> },
    { key: 'step', header: 'Step', render: (r) => r.stepName },
    { key: 'when', header: 'Submitted', hideBelow: 'sm', render: (r) => r.submittedAt.slice(0, 10) },
  ];
  return (
    <>
      <Card>
        {inbox.isError && <Alert className="m-4">Could not load your approvals.</Alert>}
        <DataTable columns={columns} rows={rows} rowKey={(r) => r.instanceId} loading={inbox.isLoading} onRowClick={(r) => setOpenId(r.entityId)} emptyTitle="Nothing waiting for you" emptyDescription="Employee relations proposals appear here when you are their approver." />
      </Card>
      <ApprovalModal actionId={openId} onClose={() => setOpenId(null)} />
    </>
  );
}

function ApprovalModal({ actionId, onClose }: { actionId: string | null; onClose: () => void }) {
  const projection = useApprovalProjection(actionId);
  const m = useErMutations();
  const toast = useToast();
  const [comment, setComment] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const p = projection.data;

  const decide = async (action: 'APPROVE' | 'REJECT') => {
    setErr(null);
    try {
      await m.decide.mutateAsync({ instanceId: p!.workflowInstanceId, action, comment: comment || undefined });
      toast.success(action === 'APPROVE' ? 'Approved and issued' : 'Rejected');
      onClose();
    } catch (e) { setErr(errorMessage(e)); }
  };

  return (
    <Modal open={!!actionId} onClose={onClose} title={p ? `${p.caseSummary.caseNumber} · ${p.action.actionType.name}` : 'Proposal'} description={p ? `${p.action.employee.firstName} ${p.action.employee.lastName} · ${p.action.employee.employeeCode}` : undefined} size="lg"
      footer={<><Button variant="secondary" onClick={onClose}>Close</Button>{p && <><Button variant="danger" onClick={() => decide('REJECT')} loading={m.decide.isPending}>Reject</Button><Button onClick={() => decide('APPROVE')} loading={m.decide.isPending}>Approve and issue</Button></>}</>}
    >
      {projection.isLoading && <LoadingBlock />}
      {projection.isError && <Alert>Could not load this proposal.</Alert>}
      {err && <Alert className="mb-3">{err}</Alert>}
      {p && (
        <div className="space-y-4 text-sm">
          <div className="flex flex-wrap items-center gap-3"><ActionStatusBadge status={p.action.status} /><span className="text-slate-500">{p.stepName}</span></div>
          <section>
            <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Case</h3>
            <p className="font-medium text-slate-900">{p.caseSummary.title}</p>
            <p className="text-xs text-slate-500">{p.caseSummary.category ?? 'Uncategorised'} · incident {p.caseSummary.incidentDate}</p>
            <p className="mt-2 whitespace-pre-wrap text-slate-700">{p.caseSummary.description}</p>
          </section>
          <section>
            <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Proposed action</h3>
            <p className="text-slate-900">{p.action.actionType.name}{p.action.validityDays && ` · on record for ${p.action.validityDays} days`}</p>
            <p className="mt-1 whitespace-pre-wrap text-slate-700">{p.action.reason}</p>
          </section>
          {p.action.letterBody && (
            <section>
              <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Draft letter</h3>
              <p className="font-medium text-slate-900">{p.action.letterSubject}</p>
              <p className="mt-1 whitespace-pre-wrap rounded-md border border-slate-200 bg-slate-50 p-3 text-slate-700">{p.action.letterBody}</p>
            </section>
          )}
          <section>
            <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Already on record</h3>
            {p.priorActiveActions.length === 0 ? <p className="text-slate-500">Nothing currently stands against this employee.</p> : (
              <ul className="divide-y divide-slate-100">{p.priorActiveActions.map((a) => <li key={a.actionId} className="flex items-center justify-between py-1.5"><span>{a.actionTypeName} · {a.caseNumber}</span><span className="flex items-center gap-2 text-xs text-slate-500">{a.issuedDate}{a.validUntil && ` → ${a.validUntil}`}<ValidityBadge validity={a.validity} /></span></li>)}</ul>
            )}
            <p className="mt-1 text-xs text-slate-500">Shown for context. The system recommends nothing.</p>
          </section>
          <Textarea label="Comment" rows={2} value={comment} onChange={(e) => setComment(e.target.value)} />
        </div>
      )}
    </Modal>
  );
}
