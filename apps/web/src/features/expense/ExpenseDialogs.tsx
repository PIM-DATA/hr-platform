import { useState } from 'react';
import { PERMISSIONS, type ExpenseItemDto, type ExpensePolicyResolutionDto, type ExpenseReportDetailDto, type TravelRequestDetailDto } from '@hr/shared';
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
import { useExpenseCategories, useExpenseMutations, useExpenseOptions, useExpenseReport, useExpenseReview, usePayrollPeriodOptions, useTravelRequest } from './expense.api';
import { ExpenseBadge, History, fmtDate, money, titleCase, todayIso } from './expense-ui';

// ---------- travel request ----------
export function NewTravelModal({ policies, onClose, onCreated }: { policies: { id: string; name: string; currency: string }[]; onClose: () => void; onCreated: (id: string) => void }) {
  const m = useExpenseMutations(); const toast = useToast();
  const [d, setD] = useState({ travelPolicyId: policies[0]?.id ?? '', purpose: '', destination: '', startDate: todayIso(), endDate: todayIso(), estimatedAmount: '' }); const [error, setError] = useState<string | null>(null);
  const policy = policies.find((p) => p.id === d.travelPolicyId);
  return (
    <Modal open onClose={onClose} title="New travel request" description="Where, when, why and the estimated cost. The purpose is seen by you, your approver and the expense team only." footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={m.createTravel.isPending} disabled={!d.travelPolicyId || !d.destination || !d.purpose || !d.estimatedAmount} onClick={async () => { setError(null); try { const t = await m.createTravel.mutateAsync(d); toast.success('Draft travel request created.'); onCreated(t.id); } catch (e) { setError(errorMessage(e)); } }}>Create draft</Button></>}>
      <div className="space-y-3">
        {error && <Alert>{error}</Alert>}
        {policies.length === 0 && <Alert tone="info">No travel policy applies to you yet. Ask HR.</Alert>}
        <Select label="Travel policy" options={policies.map((p) => ({ value: p.id, label: `${p.name} (${p.currency})` }))} value={d.travelPolicyId} onChange={(e) => setD({ ...d, travelPolicyId: e.target.value })} />
        <Input label="Destination" placeholder="Bangkok → Chiang Mai" value={d.destination} onChange={(e) => setD({ ...d, destination: e.target.value })} />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3"><Input label="Start" type="date" value={d.startDate} onChange={(e) => setD({ ...d, startDate: e.target.value })} /><Input label="End" type="date" value={d.endDate} onChange={(e) => setD({ ...d, endDate: e.target.value })} /><Input label={`Estimated cost (${policy?.currency ?? ''})`} inputMode="decimal" placeholder="12000.00" value={d.estimatedAmount} onChange={(e) => setD({ ...d, estimatedAmount: e.target.value })} /></div>
        <Textarea label="Purpose" rows={2} maxLength={300} value={d.purpose} onChange={(e) => setD({ ...d, purpose: e.target.value })} />
        <p className="text-xs text-slate-500">Keep the purpose to the business reason. It never appears in notifications or reports.</p>
      </div>
    </Modal>
  );
}

/** A travel request as its owner or an administrator sees it. */
export function TravelModal({ id, onClose, onCreateReport }: { id: string; onClose: () => void; onCreateReport?: (travel: TravelRequestDetailDto) => void }) {
  const q = useTravelRequest(id); const m = useExpenseMutations(); const toast = useToast();
  const [confirm, setConfirm] = useState<'submit' | 'cancel' | 'complete' | null>(null); const [error, setError] = useState<string | null>(null); const [editing, setEditing] = useState(false);
  const [e, setE] = useState({ purpose: '', destination: '', startDate: '', endDate: '', estimatedAmount: '' });
  const act = async (fn: () => Promise<unknown>, ok: string) => { setError(null); try { await fn(); toast.success(ok); setConfirm(null); setEditing(false); } catch (x) { setError(errorMessage(x)); } };
  if (!q.data) return <Modal open onClose={onClose} title="Travel request">{q.isError ? <Alert>Could not load this travel request.</Alert> : <LoadingBlock />}</Modal>;
  const d = q.data;
  return (
    <Modal open onClose={onClose} size="lg" title={`${d.requestNumber} — ${d.destination}`} description={`${d.snapshot.employeeName} (${d.snapshot.employeeCode}) · ${d.snapshot.department ?? '—'} · ${d.travelPolicyName}`}
      footer={<>{d.can.submit && <Button onClick={() => setConfirm('submit')}>Submit for approval</Button>}{d.can.createExpenseReport && onCreateReport && <Button onClick={() => onCreateReport(d)}>Create expense report</Button>}{d.can.complete && <Button variant="secondary" onClick={() => setConfirm('complete')}>Mark completed</Button>}{d.can.edit && !editing && <Button variant="secondary" onClick={() => { setE({ purpose: d.purpose ?? '', destination: d.destination, startDate: d.startDate, endDate: d.endDate, estimatedAmount: d.estimatedAmount }); setEditing(true); }}>Edit</Button>}{d.can.cancel && <Button variant="danger" onClick={() => setConfirm('cancel')}>Cancel request</Button>}<Button variant="secondary" onClick={onClose}>Close</Button></>}>
      <div className="space-y-4 text-sm">
        {error && <Alert>{error}</Alert>}
        <div className="flex flex-wrap items-center gap-3"><ExpenseBadge status={d.status} /><span className="text-slate-700">{d.startDate} → {d.endDate}</span><span className="text-lg font-semibold tabular-nums text-slate-900">est. {money(d.estimatedAmount, d.currency)}</span></div>
        {editing ? (
          <div className="space-y-3 rounded-lg border border-slate-200 p-3">
            <Input label="Destination" value={e.destination} onChange={(x) => setE({ ...e, destination: x.target.value })} />
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3"><Input label="Start" type="date" value={e.startDate} onChange={(x) => setE({ ...e, startDate: x.target.value })} /><Input label="End" type="date" value={e.endDate} onChange={(x) => setE({ ...e, endDate: x.target.value })} /><Input label="Estimated cost" inputMode="decimal" value={e.estimatedAmount} onChange={(x) => setE({ ...e, estimatedAmount: x.target.value })} /></div>
            <Textarea label="Purpose" rows={2} maxLength={300} value={e.purpose} onChange={(x) => setE({ ...e, purpose: x.target.value })} />
            <div className="flex justify-end gap-2"><Button size="sm" variant="secondary" onClick={() => setEditing(false)}>Discard</Button><Button size="sm" loading={m.updateTravel.isPending} onClick={() => act(() => m.updateTravel.mutateAsync({ id, input: e }), 'Travel request updated.')}>Save</Button></div>
          </div>
        ) : d.purpose !== null && <p className="text-slate-700"><span className="text-xs uppercase tracking-wide text-slate-500">Purpose</span><br />{d.purpose}</p>}
        {d.expenseReports.length > 0 && <div><div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Expense reports for this trip</div><ul className="mt-1 space-y-1">{d.expenseReports.map((r) => <li key={r.id} className="flex flex-wrap items-center gap-2">{r.reportNumber} · <span className="tabular-nums">{money(r.total, d.currency)}</span> <ExpenseBadge status={r.status} /></li>)}</ul><p className="mt-1 text-xs text-slate-400">The estimate is context for the approver; the actual total is not capped by it.</p></div>}
        <History rows={d.history} />
        <p className="text-xs text-slate-400">Approval of a trip books nothing and pays nothing. Expenses are claimed on an expense report you create from this trip.</p>
      </div>
      <ConfirmDialog open={confirm === 'submit'} title="Submit this travel request?" message="Your approver will see the destination, dates, estimate and purpose. You cannot edit it afterwards." confirmLabel="Submit" loading={m.submitTravel.isPending} onConfirm={() => act(() => m.submitTravel.mutateAsync(id), 'Travel request submitted.')} onCancel={() => setConfirm(null)} error={error} />
      <ConfirmDialog open={confirm === 'cancel'} title="Cancel this travel request?" message="A pending approval is withdrawn. Nothing else changes." confirmLabel="Cancel request" variant="danger" loading={m.cancelTravel.isPending} onConfirm={() => act(() => m.cancelTravel.mutateAsync(id), 'Travel request cancelled.')} onCancel={() => setConfirm(null)} error={error} />
      <ConfirmDialog open={confirm === 'complete'} title="Mark this trip as completed?" message="This is a record that the trip took place. Expense reports can still be created from it." confirmLabel="Mark completed" loading={m.completeTravel.isPending} onConfirm={() => act(() => m.completeTravel.mutateAsync(id), 'Trip marked completed.')} onCancel={() => setConfirm(null)} error={error} />
    </Modal>
  );
}

// ---------- expense report ----------
export function NewReportModal({ resolution, travel, onClose, onCreated }: { resolution: ExpensePolicyResolutionDto; travel: { id: string; requestNumber: string; destination: string; status: string; currency: string } | null; onClose: () => void; onCreated: (id: string) => void }) {
  const m = useExpenseMutations(); const toast = useToast();
  const [title, setTitle] = useState(travel ? `Trip ${travel.requestNumber} — ${travel.destination}` : ''); const [error, setError] = useState<string | null>(null);
  // The policy is never chosen here: the server resolves it (the travel policy's linked expense policy for a trip,
  // otherwise the unique most-specific applicable policy) and refuses ambiguity. This dialog only shows the outcome.
  const blocked = !travel && resolution.kind !== 'RESOLVED';
  return (
    <Modal open onClose={onClose} title={travel ? `New expense report for ${travel.requestNumber}` : 'New expense report'} description="Give the report a title. Items and receipts are added on the report. The expense policy is assigned by HR configuration, not chosen." footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={m.createReport.isPending} disabled={blocked || title.trim().length < 2} onClick={async () => { setError(null); try { const r = await m.createReport.mutateAsync({ title, travelRequestId: travel?.id ?? null }); toast.success('Draft report created. Add items, attach receipts, then submit.'); onCreated(r.id); } catch (e) { setError(errorMessage(e)); } }}>Create draft</Button></>}>
      <div className="space-y-3">
        {error && <Alert>{error}</Alert>}
        {travel ? <p className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">Linked to travel request {travel.requestNumber} ({travel.destination}, {titleCase(travel.status)}). The policy comes from the trip's travel policy when it names one, otherwise from your applicable policy.</p>
          : resolution.kind === 'RESOLVED' ? <p className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">Policy: <span className="font-medium text-slate-900">{resolution.policy!.name}</span> ({resolution.policy!.currency})</p>
          : <Alert tone="info">{resolution.message}</Alert>}
        <Input label="Title" placeholder="Client visit, October" value={title} onChange={(e) => setTitle(e.target.value)} />
      </div>
    </Modal>
  );
}

// A function, not a constant: the default date is taken when the dialog opens, not when the module loads.
const blank = () => ({ categoryId: '', expenseDate: todayIso(), amount: '', merchant: '', description: '' });
function ItemForm({ reportId, item, onDone }: { reportId: string; item: ExpenseItemDto | null; onDone: () => void }) {
  const cats = useExpenseCategories(); const m = useExpenseMutations(); const toast = useToast();
  const [d, setD] = useState(item ? { categoryId: item.categoryId, expenseDate: item.expenseDate, amount: item.amount, merchant: item.merchant ?? '', description: item.description ?? '' } : blank()); const [error, setError] = useState<string | null>(null);
  const save = async () => { setError(null); const input = { categoryId: d.categoryId, expenseDate: d.expenseDate, amount: d.amount, merchant: d.merchant || null, description: d.description || null }; try { if (item) await m.updateItem.mutateAsync({ id: reportId, itemId: item.id, input }); else await m.addItem.mutateAsync({ id: reportId, input }); toast.success(item ? 'Item updated.' : 'Item added.'); onDone(); } catch (e) { setError(errorMessage(e)); } };
  return (
    <div className="space-y-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
      {error && <Alert>{error}</Alert>}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3"><Select label="Category" options={(cats.data ?? []).map((c) => ({ value: c.id, label: c.name }))} placeholder="Choose" value={d.categoryId} onChange={(e) => setD({ ...d, categoryId: e.target.value })} /><Input label="Date" type="date" value={d.expenseDate} onChange={(e) => setD({ ...d, expenseDate: e.target.value })} /><Input label="Amount" inputMode="decimal" placeholder="450.00" value={d.amount} onChange={(e) => setD({ ...d, amount: e.target.value })} /></div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2"><Input label="Merchant (optional)" maxLength={120} value={d.merchant} onChange={(e) => setD({ ...d, merchant: e.target.value })} /><Input label="Description (optional unless the policy requires it)" maxLength={300} value={d.description} onChange={(e) => setD({ ...d, description: e.target.value })} /></div>
      <div className="flex justify-end gap-2"><Button size="sm" variant="secondary" onClick={onDone}>Discard</Button><Button size="sm" loading={m.addItem.isPending || m.updateItem.isPending} disabled={!d.categoryId || !d.amount || !d.expenseDate} onClick={save}>{item ? 'Save item' : 'Add item'}</Button></div>
    </div>
  );
}

/** An expense report as its owner or an administrator sees it: items, receipts, blockers, the exact total, history and the actions the API allows. */
export function ReportModal({ id, onClose }: { id: string; onClose: () => void }) {
  const q = useExpenseReport(id); const m = useExpenseMutations(); const toast = useToast(); const { user, hasPermission } = useAuth();
  const [confirm, setConfirm] = useState<'submit' | 'cancel' | null>(null); const [paying, setPaying] = useState(false); const [payroll, setPayroll] = useState(false); const [error, setError] = useState<string | null>(null);
  const [editingItem, setEditingItem] = useState<string | 'new' | null>(null); const [receiptFor, setReceiptFor] = useState<string | null>(null); const [docId, setDocId] = useState('');
  const [pay, setPay] = useState({ paymentMethod: 'EXTERNAL', paymentReference: '', paidDate: todayIso() }); const [pr, setPr] = useState({ payrollPeriodId: '', componentId: '' });
  const options = useExpenseOptions(payroll); const periods = usePayrollPeriodOptions(payroll);
  const isOwner = !!user?.employee && q.data?.employeeId === user.employee.id;
  const editable = isOwner && q.data?.status === 'DRAFT';
  const myDocs = useMyDocuments(editable);
  const act = async (fn: () => Promise<unknown>, ok: string) => { setError(null); try { await fn(); toast.success(ok); setConfirm(null); setPaying(false); setPayroll(false); setReceiptFor(null); setDocId(''); } catch (e) { setError(errorMessage(e)); } };
  if (!q.data) return <Modal open onClose={onClose} title="Expense report">{q.isError ? <Alert>Could not load this report.</Alert> : <LoadingBlock />}</Modal>;
  const d: ExpenseReportDetailDto = q.data;
  return (
    <Modal open onClose={onClose} size="lg" title={`${d.reportNumber} — ${d.title}`} description={`${d.snapshot.employeeName} (${d.snapshot.employeeCode}) · ${d.snapshot.department ?? '—'} · ${d.policyName}${d.submittedAt ? ` · submitted ${fmtDate(d.submittedAt)}` : ''}`}
      footer={<>{d.can.submit && <Button disabled={d.blockers.length > 0} onClick={() => setConfirm('submit')}>Submit report</Button>}{d.can.recordPayment && <Button onClick={() => setPaying(true)}>Record payment</Button>}{d.can.sendToPayroll && <Button variant="secondary" onClick={() => setPayroll(true)}>Send to payroll</Button>}{d.can.cancel && <Button variant="danger" onClick={() => setConfirm('cancel')}>Cancel report</Button>}<Button variant="secondary" onClick={onClose}>Close</Button></>}>
      <div className="space-y-4 text-sm">
        {error && <Alert>{error}</Alert>}
        <div className="flex flex-wrap items-center gap-3"><ExpenseBadge status={d.status} /><span className="text-lg font-semibold tabular-nums text-slate-900">Total {money(d.total, d.currency)}</span><span className="text-xs text-slate-500">{d.itemCount} item(s){d.maximumReportAmount ? ` · report maximum ${money(d.maximumReportAmount)}` : ''}</span></div>
        {d.travel && <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">Trip {d.travel.requestNumber} · {d.travel.destination} · {d.travel.startDate} → {d.travel.endDate} · estimate <span className="tabular-nums">{money(d.travel.estimatedAmount, d.currency)}</span> · actual <span className="tabular-nums font-semibold text-slate-900">{money(d.total)}</span></div>}
        {d.blockers.length > 0 && <ul className="list-disc rounded-lg border border-amber-200 bg-amber-50 p-3 pl-7 text-xs text-amber-900">{d.blockers.map((b) => <li key={b}>{b}</li>)}</ul>}
        <div>
          <div className="flex items-center justify-between"><div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Items</div>{editable && editingItem === null && <Button size="sm" variant="secondary" onClick={() => setEditingItem('new')}>Add item</Button>}</div>
          {editingItem === 'new' && <div className="mt-2"><ItemForm reportId={id} item={null} onDone={() => setEditingItem(null)} /></div>}
          {d.items.length === 0 ? <p className="mt-1 text-xs text-slate-400">No items yet.</p> : <ul className="mt-2 divide-y divide-slate-100 rounded-lg border border-slate-200">{d.items.map((i) => (
            <li key={i.id} className="p-3">
              {editingItem === i.id ? <ItemForm reportId={id} item={i} onDone={() => setEditingItem(null)} /> : (
                <>
                  <div className="flex flex-wrap items-start justify-between gap-2"><div className="min-w-0"><div className="font-medium text-slate-900">{i.categoryName} · {i.expenseDate}</div><div className="text-xs text-slate-500">{[i.merchant, i.description].filter(Boolean).join(' · ') || 'No description'}{i.perItemMaximum ? ` · max ${money(i.perItemMaximum)}` : ''}{i.receiptRequired ? ' · receipt required' : ''}</div></div><div className="text-right"><div className="font-semibold tabular-nums text-slate-900">{money(i.amount, d.currency)}</div>{editable && <div className="mt-1 flex justify-end gap-2"><button className="text-xs text-brand-700 underline" onClick={() => setEditingItem(i.id)}>Edit</button><button className="text-xs text-brand-700 underline" onClick={() => setReceiptFor(receiptFor === i.id ? null : i.id)}>Receipt</button><button className="text-xs text-red-700 underline" onClick={() => act(() => m.removeItem.mutateAsync({ id, itemId: i.id }), 'Item removed.')}>Remove</button></div>}</div></div>
                  {i.documents.length > 0 && <ul className="mt-1 text-xs text-slate-600">{i.documents.map((x) => <li key={x.documentId}>Receipt: {x.documentNumber} · {x.title}{!x.accessible && <span className="ml-1 text-slate-400">(no access to the file itself)</span>}</li>)}</ul>}
                  {i.blockers.length > 0 && <ul className="mt-1 list-disc pl-5 text-xs text-amber-800">{i.blockers.map((b) => <li key={b}>{b}</li>)}</ul>}
                  {receiptFor === i.id && editable && <div className="mt-2 flex flex-wrap items-end gap-2"><Select label="Attach one of my documents as the receipt" options={(myDocs.data ?? []).map((x) => ({ value: x.id, label: `${x.documentNumber} · ${x.title}` }))} placeholder="Choose a document" value={docId} onChange={(e) => setDocId(e.target.value)} /><Button size="sm" variant="secondary" disabled={!docId} loading={m.attachReceipt.isPending} onClick={() => act(() => m.attachReceipt.mutateAsync({ id, itemId: i.id, documentId: docId }), 'Receipt attached.')}>Attach</Button></div>}
                </>
              )}
            </li>
          ))}</ul>}
          {editable && <p className="mt-1 text-xs text-slate-400">Upload receipts in the Document Center first, then attach them here. Do not enter card numbers or unnecessary personal information.</p>}
        </div>
        {(d.paidDate || d.paymentMethod) && <p className="text-slate-700">Payment: {titleCase(d.paymentMethod ?? '')}{d.paidDate ? ` on ${d.paidDate}` : d.status === 'SENT_TO_PAYROLL' ? ' (in a payroll run; not yet paid)' : ''}{d.paymentReference ? ` · ref ${d.paymentReference}` : ''}</p>}
        <History rows={d.history} />
        <p className="text-xs text-slate-400">The total is the sum of the items computed by the server. Approval makes the report ready for payment; "Paid" is recorded by the expense team when money actually moved.</p>
      </div>
      <ConfirmDialog open={confirm === 'submit'} title="Submit this report?" message={`${money(d.total, d.currency)} across ${d.itemCount} item(s) will go to your approver. Items and the policy rules are frozen at submission.`} confirmLabel="Submit" loading={m.submitReport.isPending} onConfirm={() => act(() => m.submitReport.mutateAsync(id), 'Report submitted.')} onCancel={() => setConfirm(null)} error={error} />
      <ConfirmDialog open={confirm === 'cancel'} title="Cancel this report?" message="A pending approval is withdrawn. Items stay on the record." confirmLabel="Cancel report" variant="danger" loading={m.cancelReport.isPending} onConfirm={() => act(() => m.cancelReport.mutateAsync(id), 'Report cancelled.')} onCancel={() => setConfirm(null)} error={error} />
      <Modal open={paying} onClose={() => setPaying(false)} title="Record payment" description="Bookkeeping only: this records that the reimbursement was paid. No transfer is made here." footer={<><Button variant="secondary" onClick={() => setPaying(false)}>Cancel</Button><Button loading={m.recordPayment.isPending} onClick={() => act(() => m.recordPayment.mutateAsync({ id, input: { paymentMethod: pay.paymentMethod as 'EXTERNAL', paymentReference: pay.paymentReference || null, paidDate: pay.paidDate } }), 'Payment recorded.')}>Record as paid</Button></>}>
        <div className="space-y-3"><Select label="Method" options={[{ value: 'EXTERNAL', label: 'External transfer' }, { value: 'PAYROLL', label: 'Through payroll' }, { value: 'OTHER', label: 'Other' }]} value={pay.paymentMethod} onChange={(e) => setPay({ ...pay, paymentMethod: e.target.value })} /><Input label="Reference (optional; not written to the audit log)" value={pay.paymentReference} onChange={(e) => setPay({ ...pay, paymentReference: e.target.value })} /><Input label="Paid date" type="date" value={pay.paidDate} onChange={(e) => setPay({ ...pay, paidDate: e.target.value })} /></div>
      </Modal>
      <Modal open={payroll} onClose={() => setPayroll(false)} title="Send to payroll" description="Adds one manual earning line to the employee's result in a payroll run that is still in review. The report becomes 'sent to payroll'; record it as paid when payroll is done. Payroll decides nothing about tax here." footer={<><Button variant="secondary" onClick={() => setPayroll(false)}>Cancel</Button><Button loading={m.sendToPayroll.isPending} disabled={!pr.payrollPeriodId || !pr.componentId} onClick={() => act(() => m.sendToPayroll.mutateAsync({ id, input: pr }), 'Sent to payroll.')}>Send</Button></>}>
        <div className="space-y-3"><Select label="Payroll period" options={(periods.data ?? []).map((p) => ({ value: p.id, label: `${p.year}-${String(p.month).padStart(2, '0')} · ${p.status}` }))} placeholder="Choose a period with a calculated run" value={pr.payrollPeriodId} onChange={(e) => setPr({ ...pr, payrollPeriodId: e.target.value })} /><Select label="Earning component" options={(options.data?.payComponents ?? []).map((c) => ({ value: c.id, label: `${c.code} · ${c.name}` }))} placeholder="Choose" value={pr.componentId} onChange={(e) => setPr({ ...pr, componentId: e.target.value })} />{!hasPermission(PERMISSIONS.PAYROLL_MANAGE) && <Alert tone="info">This needs the payroll permission as well.</Alert>}</div>
      </Modal>
    </Modal>
  );
}

/** The approver's purpose-specific view of a travel request or an expense report, with approve / reject through the generic workflow. */
export function ReviewModal({ kind, id, onClose }: { kind: 'report' | 'travel'; id: string; onClose: () => void }) {
  const q = useExpenseReview(kind, id); const m = useExpenseMutations(); const toast = useToast();
  const [comment, setComment] = useState(''); const [error, setError] = useState<string | null>(null);
  const act = async (action: 'APPROVE' | 'REJECT') => { if (!q.data?.workflowInstanceId) return; setError(null); try { await m.act.mutateAsync({ instanceId: q.data.workflowInstanceId, action, comment }); toast.success(action === 'APPROVE' ? 'Approved.' : 'Rejected.'); onClose(); } catch (e) { setError(errorMessage(e)); } };
  if (!q.data) return <Modal open onClose={onClose} title="Review">{q.isError ? <Alert>Could not load this item.</Alert> : <LoadingBlock />}</Modal>;
  const { report, travel, myStepPending } = q.data;
  const head = report ? `Review ${report.reportNumber}` : `Review ${travel?.requestNumber ?? ''}`;
  const snap = (report ?? travel)!.snapshot;
  return (
    <Modal open onClose={onClose} size="lg" title={head} description={`${snap.employeeName} (${snap.employeeCode}) · ${snap.department ?? '—'}`}
      footer={<>{myStepPending && <Button variant="danger" onClick={() => act('REJECT')} loading={m.act.isPending}>Reject</Button>}{myStepPending && <Button onClick={() => act('APPROVE')} loading={m.act.isPending}>Approve</Button>}<Button variant="secondary" onClick={onClose}>Close</Button></>}>
      <div className="space-y-4 text-sm">
        {error && <Alert>{error}</Alert>}
        {travel && <>
          <div className="flex flex-wrap items-center gap-3"><ExpenseBadge status={travel.status} /><span className="text-slate-700">{travel.destination} · {travel.startDate} → {travel.endDate}</span><span className="text-lg font-semibold tabular-nums text-slate-900">est. {money(travel.estimatedAmount, travel.currency)}</span></div>
          <p className="text-slate-700"><span className="text-xs uppercase tracking-wide text-slate-500">Purpose</span><br />{travel.purpose}</p>
          <p className="text-xs text-slate-400">Approving a trip books nothing and pays nothing.</p>
        </>}
        {report && <>
          <div className="flex flex-wrap items-center gap-3"><ExpenseBadge status={report.status} /><span className="text-lg font-semibold tabular-nums text-slate-900">Total {money(report.total, report.currency)}</span><span className="text-xs text-slate-500">{report.policyName}{report.maximumReportAmount ? ` · report maximum ${money(report.maximumReportAmount)}` : ''}</span></div>
          {report.travel && <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">Trip {report.travel.requestNumber} · {report.travel.destination} · {report.travel.startDate} → {report.travel.endDate} · estimate <span className="tabular-nums">{money(report.travel.estimatedAmount)}</span> · actual <span className="tabular-nums font-semibold text-slate-900">{money(report.total)}</span> (the estimate is context, not a cap)</div>}
          <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">{report.items.map((i) => <li key={i.id} className="p-3"><div className="flex flex-wrap items-start justify-between gap-2"><div><div className="font-medium text-slate-900">{i.categoryName} · {i.expenseDate}</div><div className="text-xs text-slate-500">{[i.merchant, i.description].filter(Boolean).join(' · ') || 'No description'}{i.perItemMaximum ? ` · max ${money(i.perItemMaximum)}` : ''}{i.receiptRequired ? ' · receipt required' : ''}</div></div><div className="font-semibold tabular-nums text-slate-900">{money(i.amount, report.currency)}</div></div>{i.documents.length > 0 ? <ul className="mt-1 text-xs text-slate-600">{i.documents.map((x) => <li key={x.documentId}>Receipt: {x.documentNumber} · {x.title}{!x.accessible && <span className="ml-1 text-slate-400">(the file follows Document Center rules)</span>}</li>)}</ul> : i.receiptRequired && <p className="mt-1 text-xs text-amber-800">No receipt attached.</p>}</li>)}</ul>
          <p className="text-xs text-slate-400">Approval is all-or-nothing: reject with a comment to have the report corrected and resubmitted as a new report.</p>
        </>}
        {myStepPending && <Textarea label="Comment (kept on the approval timeline; the requester sees the decision, not the words)" rows={2} value={comment} onChange={(e) => setComment(e.target.value)} />}
        <p className="text-xs text-slate-400">You see this request only: no other expense history, salary, performance or relations record of the person.</p>
      </div>
    </Modal>
  );
}
