import { useState } from 'react';
import { RECRUITMENT_WORKFLOW, type WorkflowInboxItemDto } from '@hr/shared';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Alert } from '@/components/ui/Alert';
import { Textarea } from '@/components/ui/Textarea';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { LoadingBlock } from '@/components/ui/Spinner';
import { useToast } from '@/components/ui/Toast';
import { errorMessage } from '@/features/organization/shared';
import { useOffer, useRecruitmentInbox, useRecruitmentMutations, useRequisition } from './recruitment.api';
import { REASON_LABEL, Section, label } from './recruitment-ui';

/** Requisitions and offers waiting for the signed-in approver. The decision goes through the shared workflow endpoint. */
export function RecruitmentApprovalsPage() {
  const inbox = useRecruitmentInbox(true);
  const [open, setOpen] = useState<WorkflowInboxItemDto | null>(null);
  const columns: Column<WorkflowInboxItemDto>[] = [
    { key: 'what', header: 'Request', render: (r) => <div><div className="font-medium text-slate-900">{r.entityType === RECRUITMENT_WORKFLOW.offer ? 'Job offer' : 'Requisition'}</div><div className="text-xs text-slate-400">{r.definitionName}</div></div> },
    { key: 'who', header: 'Submitted by', render: (r) => `${r.requesterEmployee.firstName} ${r.requesterEmployee.lastName}` },
    { key: 'step', header: 'Step', hideBelow: 'sm', render: (r) => r.stepName },
    { key: 'when', header: 'Submitted', hideBelow: 'sm', render: (r) => r.submittedAt.slice(0, 10) },
  ];
  return (
    <>
      <Card>
        {inbox.isError && <Alert className="m-4">Could not load your approvals.</Alert>}
        <DataTable columns={columns} rows={inbox.data ?? []} rowKey={(r) => r.instanceId} loading={inbox.isLoading} onRowClick={setOpen} emptyTitle="Nothing waiting for you" emptyDescription="Requisitions and offers appear here when you are their approver." />
      </Card>
      <DecisionModal item={open} onClose={() => setOpen(null)} />
    </>
  );
}

function DecisionModal({ item, onClose }: { item: WorkflowInboxItemDto | null; onClose: () => void }) {
  const isOffer = item?.entityType === RECRUITMENT_WORKFLOW.offer;
  const requisition = useRequisition(item && !isOffer ? item.entityId : null);
  const offer = useOffer(item && isOffer ? item.entityId : null);
  const m = useRecruitmentMutations();
  const toast = useToast();
  const [comment, setComment] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const loading = requisition.isLoading || offer.isLoading;
  const decide = async (action: 'APPROVE' | 'REJECT') => {
    setErr(null);
    try { await m.decide.mutateAsync({ instanceId: item!.instanceId, action, comment: comment || undefined }); toast.success(action === 'APPROVE' ? 'Approved' : 'Rejected'); setComment(''); onClose(); } catch (e) { setErr(errorMessage(e)); }
  };
  const r = requisition.data;
  const o = offer.data;
  return (
    <Modal open={!!item} onClose={onClose} title={isOffer ? (o ? `Offer ${o.offerNumber}` : 'Job offer') : (r ? `Requisition ${r.requisitionNumber}` : 'Requisition')} size="lg"
      footer={<><Button variant="secondary" onClick={onClose}>Close</Button><Button variant="danger" onClick={() => decide('REJECT')} loading={m.decide.isPending}>Reject</Button><Button onClick={() => decide('APPROVE')} loading={m.decide.isPending}>Approve</Button></>}>
      {loading && <LoadingBlock />}
      {(requisition.isError || offer.isError) && <Alert>Could not load this request.</Alert>}
      {err && <Alert className="mb-3">{err}</Alert>}
      {r && (
        <div className="space-y-4 text-sm">
          <Section title="What is requested"><p className="text-slate-800"><span className="font-medium">{r.requestedOpenings}</span> × {r.snapshot?.jobTitle ?? r.job.title}{r.snapshot?.positionTitle && ` (${r.snapshot.positionTitle})`} · {label(REASON_LABEL, r.reason)}{r.employmentType && ` · ${r.employmentType.toLowerCase().replace('_', ' ')}`}</p></Section>
          <Section title="Where"><p className="text-slate-700">{r.snapshot?.departmentName ?? r.department?.name ?? '—'} · {r.snapshot?.organizationName ?? r.organization?.name ?? '—'} · hiring manager {r.snapshot?.hiringManagerName ?? r.hiringManager.name ?? '—'}</p></Section>
          {r.desiredStartDate && <Section title="Desired start"><p className="text-slate-700">{r.desiredStartDate}</p></Section>}
          {r.justification && <Section title="Justification"><p className="whitespace-pre-wrap text-slate-700">{r.justification}</p></Section>}
        </div>
      )}
      {o && (
        <div className="space-y-4 text-sm">
          <Section title="Candidate and opening"><p className="text-slate-800">{o.candidate.firstName} {o.candidate.lastName} · {o.opening.title}{o.position && ` · ${o.position.title}`}</p></Section>
          <Section title="Terms">
            <p className="text-slate-700">Start {o.proposedStartDate}{o.employmentType && ` · ${o.employmentType.toLowerCase().replace('_', ' ')}`}</p>
            <p className="text-slate-900">{o.compensationVisible ? <>Base salary proposal <span className="font-medium tabular-nums">{o.baseSalaryProposal ?? '—'} {o.currencyCode}</span></> : <span className="text-slate-500">Compensation is not visible to you.</span>}</p>
            {o.otherTermsText && <p className="mt-1 whitespace-pre-wrap text-slate-700">{o.otherTermsText}</p>}
          </Section>
        </div>
      )}
      <div className="mt-4"><Textarea label="Comment (optional)" rows={2} value={comment} onChange={(e) => setComment(e.target.value)} /></div>
    </Modal>
  );
}
