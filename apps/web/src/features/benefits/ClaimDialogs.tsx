import { useState } from 'react';
import { PERMISSIONS, type BenefitClaimDetailDto } from '@hr/shared';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Alert } from '@/components/ui/Alert';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { LoadingBlock } from '@/components/ui/Spinner';
import { useToast } from '@/components/ui/Toast';
import { useAuth } from '@/hooks/useAuth';
import { errorMessage } from '@/features/organization/shared';
import { useMyDocuments } from '@/features/documents/documents.api';
import { useBenefitClaim, useBenefitsMutations, useBenefitsOptions, useClaimReview, usePayrollPeriodOptions } from './benefits.api';
import { BalanceBar, BenefitBadge, fmtDate, money } from './benefits-ui';

/** A claim as its owner or an administrator sees it: facts, balance, documents, history, and the actions the API allows. */
export function ClaimModal({ id, onClose }: { id: string; onClose: () => void }) {
  const q = useBenefitClaim(id); const m = useBenefitsMutations(); const toast = useToast(); const { user, hasPermission } = useAuth();
  const [confirm, setConfirm] = useState<'submit' | 'cancel' | null>(null); const [paying, setPaying] = useState(false); const [payroll, setPayroll] = useState(false); const [error, setError] = useState<string | null>(null);
  const [pay, setPay] = useState({ paymentMethod: 'EXTERNAL', paymentReference: '', paidDate: new Date().toISOString().slice(0, 10) }); const [pr, setPr] = useState({ payrollPeriodId: '', componentId: '' }); const [docId, setDocId] = useState('');
  const options = useBenefitsOptions(); const periods = usePayrollPeriodOptions(payroll);
  const isOwner = !!user?.employee && q.data?.employeeId === user.employee.id;
  const myDocs = useMyDocuments(isOwner && !!q.data && (q.data.status === 'DRAFT' || q.data.status === 'PENDING_APPROVAL'));
  const act = async (fn: () => Promise<unknown>, ok: string) => { setError(null); try { await fn(); toast.success(ok); setConfirm(null); setPaying(false); setPayroll(false); } catch (e) { setError(errorMessage(e)); } };
  if (!q.data) return <Modal open onClose={onClose} title="Claim">{q.isError ? <Alert>Could not load this claim.</Alert> : <LoadingBlock />}</Modal>;
  const d: BenefitClaimDetailDto = q.data;
  return (
    <Modal open onClose={onClose} size="lg" title={`${d.claimNumber} — ${d.planName}`} description={`${d.snapshot.employeeName} (${d.snapshot.employeeCode}) · ${d.snapshot.department ?? '—'} · service ${d.serviceDate}${d.submittedDate ? ` · submitted ${d.submittedDate}` : ''}`}
      footer={<>{d.can.submit && <Button disabled={d.blockers.length > 0} onClick={() => setConfirm('submit')}>Submit claim</Button>}{d.can.recordPayment && <Button onClick={() => setPaying(true)}>Record payment</Button>}{d.can.sendToPayroll && <Button variant="secondary" onClick={() => setPayroll(true)}>Send to payroll</Button>}{d.can.cancel && <Button variant="danger" onClick={() => setConfirm('cancel')}>Cancel claim</Button>}<Button variant="secondary" onClick={onClose}>Close</Button></>}>
      <div className="space-y-4 text-sm">
        {error && <Alert>{error}</Alert>}
        <div className="flex flex-wrap items-center gap-3"><BenefitBadge status={d.status} /><span className="text-lg font-semibold tabular-nums text-slate-900">{money(d.claimedAmount, d.currency)}</span>{d.approvedAmount && <span className="text-slate-600">approved {money(d.approvedAmount)}</span>}{d.perClaimMaximum && <span className="text-xs text-slate-500">per-claim maximum {money(d.perClaimMaximum)}</span>}</div>
        {d.balance && <div className="rounded-lg border border-slate-200 bg-slate-50 p-3"><BalanceBar balance={d.balance} /></div>}
        {d.description !== null && <p className="text-slate-700">{d.description || <span className="text-slate-400">No description.</span>}</p>}
        {d.blockers.length > 0 && <ul className="list-disc rounded-lg border border-amber-200 bg-amber-50 p-3 pl-7 text-xs text-amber-900">{d.blockers.map((b) => <li key={b}>{b}</li>)}</ul>}
        <div>
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Documents {d.requiresDocument && <span className="font-normal normal-case text-slate-400">(required for this plan)</span>}</div>
          {d.documents.length === 0 ? <p className="text-xs text-slate-400">None attached.</p> : <ul className="mt-1 space-y-1">{d.documents.map((x) => <li key={x.documentId} className="text-slate-700">{x.documentNumber} · {x.title}{!x.accessible && <span className="ml-2 text-xs text-slate-400">(no access to the file itself)</span>}</li>)}</ul>}
          {isOwner && (d.status === 'DRAFT' || d.status === 'PENDING_APPROVAL') && <div className="mt-2 flex flex-wrap items-end gap-2"><Select label="Attach one of my documents" options={(myDocs.data ?? []).map((x) => ({ value: x.id, label: `${x.documentNumber} · ${x.title}` }))} placeholder="Choose a document" value={docId} onChange={(e) => setDocId(e.target.value)} /><Button size="sm" variant="secondary" disabled={!docId} onClick={() => act(() => m.attachDocument.mutateAsync({ id, documentId: docId }), 'Document attached.')}>Attach</Button></div>}
        </div>
        {(d.paidDate || d.paymentMethod) && <p className="text-slate-700">Payment: {d.paymentMethod ?? '—'}{d.paidDate ? ` on ${d.paidDate}` : ''}{d.paymentReference ? ` · ref ${d.paymentReference}` : ''}</p>}
        <div><div className="text-xs font-semibold uppercase tracking-wide text-slate-500">History</div><ol className="mt-1 space-y-1 text-xs text-slate-600">{d.history.map((h, i) => <li key={i}>{fmtDate(h.at)} · {h.from ? `${h.from} → ` : ''}{h.to}{h.actorName ? ` · ${h.actorName}` : ''}{h.reasonCode ? ` · ${h.reasonCode}` : ''}</li>)}</ol></div>
        <p className="text-xs text-slate-400">Approval reserves and then consumes your entitlement; it does not move money. "Paid" is recorded by HR when the reimbursement was actually made.</p>
      </div>
      <ConfirmDialog open={confirm === 'submit'} title="Submit this claim?" message={`${money(d.claimedAmount, d.currency)} will be reserved from your entitlement while the claim is reviewed. The amount cannot be changed afterwards.`} confirmLabel="Submit" loading={m.submitClaim.isPending} onConfirm={() => act(() => m.submitClaim.mutateAsync(id), 'Claim submitted.')} onCancel={() => setConfirm(null)} error={error} />
      <ConfirmDialog open={confirm === 'cancel'} title="Cancel this claim?" message="Any reserved amount returns to your available balance." confirmLabel="Cancel claim" variant="danger" loading={m.cancelClaim.isPending} onConfirm={() => act(() => m.cancelClaim.mutateAsync(id), 'Claim cancelled.')} onCancel={() => setConfirm(null)} error={error} />
      <Modal open={paying} onClose={() => setPaying(false)} title="Record payment" description="Bookkeeping only: this records that the reimbursement was paid. No transfer is made here." footer={<><Button variant="secondary" onClick={() => setPaying(false)}>Cancel</Button><Button loading={m.recordPayment.isPending} onClick={() => act(() => m.recordPayment.mutateAsync({ id, input: { paymentMethod: pay.paymentMethod as 'EXTERNAL', paymentReference: pay.paymentReference || null, paidDate: pay.paidDate } }), 'Payment recorded.')}>Record as paid</Button></>}>
        <div className="space-y-3"><Select label="Method" options={[{ value: 'EXTERNAL', label: 'External transfer' }, { value: 'PAYROLL', label: 'Through payroll' }, { value: 'OTHER', label: 'Other' }]} value={pay.paymentMethod} onChange={(e) => setPay({ ...pay, paymentMethod: e.target.value })} /><Input label="Reference (optional)" value={pay.paymentReference} onChange={(e) => setPay({ ...pay, paymentReference: e.target.value })} /><Input label="Paid date" type="date" value={pay.paidDate} onChange={(e) => setPay({ ...pay, paidDate: e.target.value })} /></div>
      </Modal>
      <Modal open={payroll} onClose={() => setPayroll(false)} title="Send to payroll" description="Adds one manual earning line to the employee's result in a payroll run that is still in review. The claim becomes 'sent to payroll'; record it as paid when payroll is done. Payroll decides nothing about tax here." footer={<><Button variant="secondary" onClick={() => setPayroll(false)}>Cancel</Button><Button loading={m.sendToPayroll.isPending} disabled={!pr.payrollPeriodId || !pr.componentId} onClick={() => act(() => m.sendToPayroll.mutateAsync({ id, input: pr }), 'Sent to payroll.')}>Send</Button></>}>
        <div className="space-y-3"><Select label="Payroll period" options={(periods.data ?? []).map((p) => ({ value: p.id, label: `${p.year}-${String(p.month).padStart(2, '0')} · ${p.status}` }))} placeholder="Choose a period with a calculated run" value={pr.payrollPeriodId} onChange={(e) => setPr({ ...pr, payrollPeriodId: e.target.value })} /><Select label="Earning component" options={(options.data?.payComponents ?? []).map((c) => ({ value: c.id, label: `${c.code} · ${c.name}` }))} placeholder="Choose" value={pr.componentId} onChange={(e) => setPr({ ...pr, componentId: e.target.value })} />{!hasPermission(PERMISSIONS.PAYROLL_MANAGE) && <Alert tone="info">This needs the payroll permission as well.</Alert>}</div>
      </Modal>
    </Modal>
  );
}

/** The approver's purpose-specific view, with approve / reject through the generic workflow. */
export function ReviewModal({ id, onClose }: { id: string; onClose: () => void }) {
  const q = useClaimReview(id); const m = useBenefitsMutations(); const toast = useToast();
  const [comment, setComment] = useState(''); const [error, setError] = useState<string | null>(null);
  const act = async (action: 'APPROVE' | 'REJECT') => { if (!q.data?.workflowInstanceId) return; setError(null); try { await m.act.mutateAsync({ instanceId: q.data.workflowInstanceId, action, comment }); toast.success(action === 'APPROVE' ? 'Claim approved.' : 'Claim rejected.'); onClose(); } catch (e) { setError(errorMessage(e)); } };
  if (!q.data) return <Modal open onClose={onClose} title="Claim review">{q.isError ? <Alert>Could not load this claim.</Alert> : <LoadingBlock />}</Modal>;
  const { claim: d, myStepPending, descriptionVisible } = q.data;
  return (
    <Modal open onClose={onClose} size="lg" title={`Review ${d.claimNumber}`} description={`${d.snapshot.employeeName} (${d.snapshot.employeeCode}) · ${d.planName} · service ${d.serviceDate}`}
      footer={<>{myStepPending && <Button variant="danger" onClick={() => act('REJECT')} loading={m.act.isPending}>Reject</Button>}{myStepPending && <Button onClick={() => act('APPROVE')} loading={m.act.isPending}>Approve</Button>}<Button variant="secondary" onClick={onClose}>Close</Button></>}>
      <div className="space-y-4 text-sm">
        {error && <Alert>{error}</Alert>}
        <div className="flex flex-wrap items-center gap-3"><BenefitBadge status={d.status} /><span className="text-lg font-semibold tabular-nums text-slate-900">{money(d.claimedAmount, d.currency)}</span>{d.perClaimMaximum && <span className="text-xs text-slate-500">per-claim maximum {money(d.perClaimMaximum)}</span>}</div>
        {d.balance && <div className="rounded-lg border border-slate-200 bg-slate-50 p-3"><div className="mb-1 text-xs text-slate-500">Remaining entitlement (this claim is already reserved)</div><BalanceBar balance={d.balance} /></div>}
        {descriptionVisible ? <p className="text-slate-700">{d.description || <span className="text-slate-400">No description.</span>}</p> : <p className="text-xs text-slate-400">The description of this confidential benefit is visible to the benefits team only.</p>}
        <div><div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Documents</div>{d.documents.length === 0 ? <p className="text-xs text-slate-400">None attached.</p> : <ul className="mt-1 space-y-1">{d.documents.map((x) => <li key={x.documentId}>{x.documentNumber} · {x.title}{!x.accessible && <span className="ml-2 text-xs text-slate-400">(the file follows Document Center rules)</span>}</li>)}</ul>}</div>
        {myStepPending && <Textarea label="Comment (kept on the approval timeline; the claimant sees the decision, not the words)" rows={2} value={comment} onChange={(e) => setComment(e.target.value)} />}
        <p className="text-xs text-slate-400">You see this claim only: no other benefit history, salary, performance or relations record of the person.</p>
      </div>
    </Modal>
  );
}
