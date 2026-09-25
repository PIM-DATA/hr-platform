import { useState } from 'react';
import { PERMISSIONS, SERVICE_REJECT_REASONS, type ServiceFieldDto, type ServiceRequestDetailDto } from '@hr/shared';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Alert } from '@/components/ui/Alert';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { Checkbox } from '@/components/ui/Checkbox';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { LoadingBlock } from '@/components/ui/Spinner';
import { useToast } from '@/components/ui/Toast';
import { useAuth } from '@/hooks/useAuth';
import { errorMessage } from '@/features/organization/shared';
import { useMyDocuments } from '@/features/documents/documents.api';
import { useHrLetter, useServiceMutations, useServiceOptions, useServiceRequest, useServiceReview } from './services.api';
import { History, LetterSheet, ServiceBadge, answerText, fmtDate, fmtDateTime, titleCase } from './services-ui';

type AnswerMap = Record<string, string | boolean | string[]>;

/** Renders one configured field. Only the allow-listed types exist; nothing a customer configures is ever executed. */
function FieldInput({ f, value, onChange }: { f: ServiceFieldDto; value: string | boolean | string[] | undefined; onChange: (v: string | boolean | string[]) => void }) {
  const label = f.required ? `${f.label} *` : f.label;
  switch (f.fieldType) {
    case 'TEXTAREA': return <Textarea label={label} rows={3} maxLength={f.maxLength ?? 2000} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} />;
    case 'DATE': return <Input label={label} type="date" value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} />;
    case 'NUMBER': return <Input label={label} inputMode="decimal" value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} />;
    case 'BOOLEAN': return <Checkbox label={label} description={f.helpText ?? undefined} checked={value === true} onChange={(e) => onChange(e.target.checked)} />;
    case 'SELECT': return <Select label={label} options={f.options.map((o) => ({ value: o, label: o }))} placeholder="Choose" value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} />;
    case 'MULTI_SELECT': return (
      <div><div className="mb-1 text-sm font-medium text-slate-700">{label}</div><div className="space-y-1">{f.options.map((o) => {
        const list = Array.isArray(value) ? value : [];
        return <Checkbox key={o} label={o} checked={list.includes(o)} onChange={(e) => onChange(e.target.checked ? [...list, o] : list.filter((x) => x !== o))} />;
      })}</div></div>
    );
    default: return <Input label={label} maxLength={f.maxLength ?? 2000} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} />;
  }
}
const toAnswers = (fields: ServiceFieldDto[], answers: AnswerMap) => fields.map((f) => ({ key: f.key, value: answers[f.key] })).filter((a) => a.value !== undefined && a.value !== '' && !(Array.isArray(a.value) && a.value.length === 0)) as { key: string; value: string | boolean | number | string[] }[];

export function NewRequestModal({ catalog, onClose, onCreated }: { catalog: { id: string; code: string; name: string; description: string | null; category: string; requiresAttachment: boolean; targetDays: number | null; fields: ServiceFieldDto[] }[]; onClose: () => void; onCreated: (id: string) => void }) {
  const m = useServiceMutations(); const toast = useToast();
  const [typeId, setTypeId] = useState(catalog[0]?.id ?? ''); const [subject, setSubject] = useState(''); const [description, setDescription] = useState(''); const [answers, setAnswers] = useState<AnswerMap>({}); const [error, setError] = useState<string | null>(null);
  const type = catalog.find((c) => c.id === typeId);
  return (
    <Modal open onClose={onClose} size="lg" title="New request" description="Tell HR what you need. Your request is tracked here; HR updates your records separately under their own authority."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={m.createRequest.isPending} disabled={!type || subject.trim().length < 2} onClick={async () => { setError(null); try { const r = await m.createRequest.mutateAsync({ requestTypeId: typeId, subject, description: description || null, answers: toAnswers(type?.fields ?? [], answers) }); toast.success('Draft request created. Add anything else, then submit.'); onCreated(r.id); } catch (e) { setError(errorMessage(e)); } }}>Create draft</Button></>}>
      <div className="space-y-3">
        {error && <Alert>{error}</Alert>}
        {catalog.length === 0 && <Alert tone="info">No request types are open to you yet. Ask HR.</Alert>}
        <Select label="What do you need?" options={catalog.map((c) => ({ value: c.id, label: `${c.name} · ${titleCase(c.category)}` }))} value={typeId} onChange={(e) => { setTypeId(e.target.value); setAnswers({}); }} />
        {type && <p className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">{type.description ?? 'No description.'}{type.targetDays ? ` · HR aims to answer within ${type.targetDays} calendar days.` : ''}{type.requiresAttachment ? ' · At least one attachment is needed before you can submit.' : ''}</p>}
        <Input label="Subject" placeholder="Employment certificate for my visa" value={subject} onChange={(e) => setSubject(e.target.value)} />
        {(type?.fields ?? []).map((f) => <FieldInput key={f.key} f={f} value={answers[f.key]} onChange={(v) => setAnswers({ ...answers, [f.key]: v })} />)}
        <Textarea label="Anything else (optional)" rows={2} maxLength={2000} value={description} onChange={(e) => setDescription(e.target.value)} />
        <p className="text-xs text-slate-500">Do not enter passwords, secrets, medical diagnosis or unnecessary sensitive information.</p>
      </div>
    </Modal>
  );
}

/** A request as its owner or the fulfilment team sees it. Internal notes are visibly separated from the conversation. */
export function RequestModal({ id, onClose, onOpenLetter }: { id: string; onClose: () => void; onOpenLetter?: (letterId: string) => void }) {
  const q = useServiceRequest(id); const m = useServiceMutations(); const toast = useToast(); const { user, hasPermission } = useAuth();
  const [confirm, setConfirm] = useState<'submit' | 'cancel' | null>(null); const [error, setError] = useState<string | null>(null);
  const [answers, setAnswers] = useState<AnswerMap | null>(null); const [body, setBody] = useState(''); const [internal, setInternal] = useState(false); const [docId, setDocId] = useState('');
  const [fulfilling, setFulfilling] = useState(false); const [rejecting, setRejecting] = useState(false);
  const [result, setResult] = useState(''); const [reject, setReject] = useState({ reasonCode: 'NOT_ELIGIBLE', explanation: '' });
  const isOwner = !!user?.employee && q.data?.employeeId === user.employee.id;
  const myDocs = useMyDocuments(isOwner && !!q.data && q.data.status !== 'FULFILLED');
  const options = useServiceOptions(hasPermission(PERMISSIONS.SERVICE_REQUEST_FULFILL));
  const act = async (fn: () => Promise<unknown>, ok: string) => { setError(null); try { await fn(); toast.success(ok); setConfirm(null); setFulfilling(false); setRejecting(false); setBody(''); setDocId(''); setAnswers(null); } catch (e) { setError(errorMessage(e)); } };
  if (!q.data) return <Modal open onClose={onClose} title="Request">{q.isError ? <Alert>Could not load this request.</Alert> : <LoadingBlock />}</Modal>;
  const d: ServiceRequestDetailDto = q.data;
  const fields = answers === null ? null : d.answers;
  void fields;
  return (
    <Modal open onClose={onClose} size="lg" title={`${d.requestNumber} — ${d.subject}`} description={`${d.snapshot.employeeName} (${d.snapshot.employeeCode}) · ${d.requestTypeName}${d.submittedAt ? ` · submitted ${fmtDate(d.submittedAt)}` : ''}${d.assignedToName ? ` · with ${d.assignedToName}` : ''}`}
      footer={<>
        {d.can.submit && <Button disabled={d.blockers.length > 0} onClick={() => setConfirm('submit')}>Submit request</Button>}
        {d.can.fulfill && <Button onClick={() => setFulfilling(true)}>{d.fulfillmentType === 'HR_LETTER' ? 'Issue letter & complete' : 'Mark completed'}</Button>}
        {d.can.reject && <Button variant="secondary" onClick={() => setRejecting(true)}>Decline</Button>}
        {d.can.cancel && <Button variant="danger" onClick={() => setConfirm('cancel')}>Withdraw</Button>}
        <Button variant="secondary" onClick={onClose}>Close</Button>
      </>}>
      <div className="space-y-4 text-sm">
        {error && <Alert>{error}</Alert>}
        <div className="flex flex-wrap items-center gap-3">
          <ServiceBadge status={d.status} />
          {d.workflowStatus && <span className="text-xs text-slate-500">Approval: {titleCase(d.workflowStatus)}</span>}
          {d.dueDate && <span className={`text-xs ${d.overdue ? 'font-semibold text-red-700' : 'text-slate-500'}`}>Target {d.dueDate}{d.overdue ? ' · past target' : ''}</span>}
        </div>
        {d.blockers.length > 0 && <ul className="list-disc rounded-lg border border-amber-200 bg-amber-50 p-3 pl-7 text-xs text-amber-900">{d.blockers.map((b) => <li key={b}>{b}</li>)}</ul>}
        {d.description && <p className="whitespace-pre-wrap text-slate-700">{d.description}</p>}
        {d.answers.length > 0 && <dl className="grid grid-cols-1 gap-2 rounded-lg border border-slate-200 p-3 sm:grid-cols-2">{d.answers.map((a) => <div key={a.key}><dt className="text-xs uppercase tracking-wide text-slate-500">{a.label}</dt><dd className="whitespace-pre-wrap text-slate-800">{answerText(a.fieldType, a.value)}</dd></div>)}</dl>}
        {d.can.assign && <div className="flex flex-wrap items-end gap-2"><Select label="Assigned to" options={(options.data?.fulfillers ?? []).map((f) => ({ value: f.id, label: f.name }))} placeholder="Nobody yet" value={d.assignedToUserId ?? ''} onChange={(e) => act(() => m.assign.mutateAsync({ id, input: { assignedToUserId: e.target.value || null } }), 'Assigned.')} />{d.status !== 'WAITING_EMPLOYEE' && <Button size="sm" variant="secondary" onClick={() => act(() => m.setStatus.mutateAsync({ id, status: 'WAITING_EMPLOYEE' }), 'Waiting for the employee.')}>Ask the employee</Button>}{d.status === 'WAITING_EMPLOYEE' && <Button size="sm" variant="secondary" onClick={() => act(() => m.setStatus.mutateAsync({ id, status: 'IN_PROGRESS' }), 'Back in progress.')}>Resume</Button>}</div>}
        <div>
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Attachments</div>
          {d.documents.length === 0 ? <p className="text-xs text-slate-400">None attached.</p> : <ul className="mt-1 space-y-1">{d.documents.map((x) => <li key={x.documentId} className="text-slate-700">{x.documentNumber} · {x.title}{!x.accessible && <span className="ml-2 text-xs text-slate-400">(no access to the file itself)</span>}</li>)}</ul>}
          {isOwner && d.status !== 'FULFILLED' && d.status !== 'REJECTED' && d.status !== 'CANCELLED' && <div className="mt-2 flex flex-wrap items-end gap-2"><Select label="Attach one of my documents" options={(myDocs.data ?? []).map((x) => ({ value: x.id, label: `${x.documentNumber} · ${x.title}` }))} placeholder="Choose a document" value={docId} onChange={(e) => setDocId(e.target.value)} /><Button size="sm" variant="secondary" disabled={!docId} onClick={() => act(() => m.attachDocument.mutateAsync({ id, documentId: docId }), 'Attached.')}>Attach</Button></div>}
        </div>
        {d.letters.length > 0 && <div><div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Letters</div><ul className="mt-1 space-y-1">{d.letters.map((l) => <li key={l.id} className="flex flex-wrap items-center gap-2"><button className="font-medium text-brand-700 underline" onClick={() => onOpenLetter?.(l.id)}>{l.letterNumber}</button><span className="text-xs text-slate-500">{titleCase(l.letterType)} · {l.issuedDate}</span><ServiceBadge status={l.status} /></li>)}</ul></div>}
        <div>
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Conversation</div>
          {d.messages.length === 0 ? <p className="text-xs text-slate-400">Nothing yet.</p> : <ul className="mt-1 space-y-2">{d.messages.map((msg) => (
            <li key={msg.id} className={`rounded-lg border p-3 ${msg.visibility === 'INTERNAL' ? 'border-amber-300 bg-amber-50' : 'border-slate-200 bg-white'}`}>
              <div className="mb-1 flex flex-wrap items-center gap-2 text-xs"><span className="font-medium text-slate-700">{msg.authorName ?? 'HR'}</span><span className="text-slate-400">{fmtDateTime(msg.createdAt)}</span>{msg.visibility === 'INTERNAL' && <span className="rounded bg-amber-200 px-1.5 py-0.5 font-semibold uppercase tracking-wide text-amber-900">Internal note — the employee never sees this</span>}</div>
              <p className="whitespace-pre-wrap text-slate-800">{msg.body}</p>
            </li>
          ))}</ul>}
          {d.can.message && <div className="mt-2 space-y-2">
            <Textarea label={internal ? 'Internal note (HR only)' : 'Reply to the employee'} rows={2} maxLength={2000} value={body} onChange={(e) => setBody(e.target.value)} />
            <div className="flex flex-wrap items-center justify-between gap-2">
              {d.can.internalMessage ? <Checkbox label="Internal note" description="Kept inside the fulfilment team. The employee never sees it and it is not exported to them." checked={internal} onChange={(e) => setInternal(e.target.checked)} /> : <span className="text-xs text-slate-400">HR will see your reply.</span>}
              <Button size="sm" disabled={!body.trim()} loading={m.addMessage.isPending} onClick={() => act(() => m.addMessage.mutateAsync({ id, input: { body, visibility: internal ? 'INTERNAL' : 'REQUESTER_VISIBLE' } }), internal ? 'Internal note added.' : 'Message sent.')}>{internal ? 'Add internal note' : 'Send'}</Button>
            </div>
          </div>}
        </div>
        {d.resultNote && <p className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-slate-800"><span className="text-xs font-semibold uppercase tracking-wide text-emerald-800">Outcome</span><br />{d.resultNote}</p>}
        {d.rejectReasonCode && <p className="rounded-lg border border-red-200 bg-red-50 p-3 text-slate-800"><span className="text-xs font-semibold uppercase tracking-wide text-red-800">Declined — {titleCase(d.rejectReasonCode)}</span><br />{d.rejectExplanation ?? 'No further explanation was given.'}</p>}
        <History rows={d.history} />
        <p className="text-xs text-slate-400">Completing a request records what HR did. It does not change your employee record, payroll, leave or benefits by itself.</p>
      </div>
      <ConfirmDialog open={confirm === 'submit'} title="Submit this request?" message="HR will see the request, your answers and any attachments. You cannot edit it afterwards." confirmLabel="Submit" loading={m.submitRequest.isPending} onConfirm={() => act(() => m.submitRequest.mutateAsync(id), 'Request submitted.')} onCancel={() => setConfirm(null)} error={error} />
      <ConfirmDialog open={confirm === 'cancel'} title="Withdraw this request?" message="It stays on the record as withdrawn. You can raise a new one at any time." confirmLabel="Withdraw" variant="danger" loading={m.cancelRequest.isPending} onConfirm={() => act(() => m.cancelRequest.mutateAsync(id), 'Request withdrawn.')} onCancel={() => setConfirm(null)} error={error} />
      <Modal open={fulfilling} onClose={() => setFulfilling(false)} title={d.fulfillmentType === 'HR_LETTER' ? 'Issue the letter and complete' : 'Complete this request'}
        description={d.fulfillmentType === 'HR_LETTER' ? 'The letter is rendered and issued, and the request is completed, in one step. A salary letter also needs the payroll authority.' : 'Record what was done. Nothing in the employee master, payroll or any other module changes here.'}
        footer={<><Button variant="secondary" onClick={() => setFulfilling(false)}>Cancel</Button><Button loading={m.fulfill.isPending} onClick={() => act(() => m.fulfill.mutateAsync({ id, input: { resultNote: result || null } }), d.fulfillmentType === 'HR_LETTER' ? 'Letter issued and request completed.' : 'Request completed.')}>{d.fulfillmentType === 'HR_LETTER' ? 'Issue and complete' : 'Complete'}</Button></>}>
        <Textarea label="Outcome the employee will see (optional)" rows={3} maxLength={2000} value={result} onChange={(e) => setResult(e.target.value)} />
      </Modal>
      <Modal open={rejecting} onClose={() => setRejecting(false)} title="Decline this request" description="The employee sees the reason and your explanation. Internal notes stay internal."
        footer={<><Button variant="secondary" onClick={() => setRejecting(false)}>Cancel</Button><Button variant="danger" loading={m.reject.isPending} onClick={() => act(() => m.reject.mutateAsync({ id, input: { reasonCode: reject.reasonCode as 'OTHER', explanation: reject.explanation || null } }), 'Request declined.')}>Decline</Button></>}>
        <div className="space-y-3"><Select label="Reason" options={SERVICE_REJECT_REASONS.map((r) => ({ value: r, label: titleCase(r) }))} value={reject.reasonCode} onChange={(e) => setReject({ ...reject, reasonCode: e.target.value })} /><Textarea label="Explanation for the employee (optional)" rows={3} maxLength={2000} value={reject.explanation} onChange={(e) => setReject({ ...reject, explanation: e.target.value })} /></div>
      </Modal>
    </Modal>
  );
}

/** The approver's purpose-specific view: the facts and the employee-visible answers, never an internal note. */
export function ReviewModal({ id, onClose }: { id: string; onClose: () => void }) {
  const q = useServiceReview(id); const m = useServiceMutations(); const toast = useToast();
  const [comment, setComment] = useState(''); const [error, setError] = useState<string | null>(null);
  const act = async (action: 'APPROVE' | 'REJECT') => { if (!q.data?.workflowInstanceId) return; setError(null); try { await m.act.mutateAsync({ instanceId: q.data.workflowInstanceId, action, comment }); toast.success(action === 'APPROVE' ? 'Approved.' : 'Declined.'); onClose(); } catch (e) { setError(errorMessage(e)); } };
  if (!q.data) return <Modal open onClose={onClose} title="Review">{q.isError ? <Alert>Could not load this request.</Alert> : <LoadingBlock />}</Modal>;
  const { request: d, myStepPending } = q.data;
  return (
    <Modal open onClose={onClose} size="lg" title={`Review ${d.requestNumber}`} description={`${d.snapshot.employeeName} (${d.snapshot.employeeCode}) · ${d.requestTypeName}`}
      footer={<>{myStepPending && <Button variant="danger" loading={m.act.isPending} onClick={() => act('REJECT')}>Decline</Button>}{myStepPending && <Button loading={m.act.isPending} onClick={() => act('APPROVE')}>Approve</Button>}<Button variant="secondary" onClick={onClose}>Close</Button></>}>
      <div className="space-y-4 text-sm">
        {error && <Alert>{error}</Alert>}
        <div className="flex flex-wrap items-center gap-3"><ServiceBadge status={d.status} /><span className="text-slate-700">{d.subject}</span></div>
        {d.description && <p className="whitespace-pre-wrap text-slate-700">{d.description}</p>}
        {d.answers.length > 0 && <dl className="grid grid-cols-1 gap-2 rounded-lg border border-slate-200 p-3 sm:grid-cols-2">{d.answers.map((a) => <div key={a.key}><dt className="text-xs uppercase tracking-wide text-slate-500">{a.label}</dt><dd className="text-slate-800">{answerText(a.fieldType, a.value)}</dd></div>)}</dl>}
        {d.documents.length > 0 && <div><div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Attachments</div><ul className="mt-1 space-y-1">{d.documents.map((x) => <li key={x.documentId}>{x.documentNumber} · {x.title}{!x.accessible && <span className="ml-2 text-xs text-slate-400">(the file follows Document Center rules)</span>}</li>)}</ul></div>}
        {myStepPending && <Textarea label="Comment (kept on the approval timeline; the requester sees the decision, not the words)" rows={2} value={comment} onChange={(e) => setComment(e.target.value)} />}
        <p className="text-xs text-slate-400">Approving authorises the request. HR still carries it out. You see this request only: no internal notes, no other ticket, no salary.</p>
      </div>
    </Modal>
  );
}

/** A letter, print-ready. Printing uses the browser; there is no server-generated PDF and no electronic signature. */
export function LetterModal({ id, onClose }: { id: string; onClose: () => void }) {
  const q = useHrLetter(id); const m = useServiceMutations(); const toast = useToast(); const { hasPermission } = useAuth();
  const [voiding, setVoiding] = useState(false); const [reasonCode, setReasonCode] = useState('ISSUED_IN_ERROR'); const [error, setError] = useState<string | null>(null);
  if (!q.data) return <Modal open onClose={onClose} title="Letter">{q.isError ? <Alert>Could not load this letter.</Alert> : <LoadingBlock />}</Modal>;
  const d = q.data;
  return (
    <Modal open onClose={onClose} size="lg" title={`${d.letterNumber} — ${titleCase(d.letterType)}`} description={`${d.snapshot.employeeName} (${d.snapshot.employeeCode}) · issued ${d.issuedDate} by ${d.issuedByName ?? 'HR'}${d.serviceRequestNumber ? ` · from request ${d.serviceRequestNumber}` : ''}`}
      footer={<><Button variant="secondary" onClick={() => window.print()}>Print</Button>{d.can.void && hasPermission(PERMISSIONS.HR_LETTER_ISSUE) && <Button variant="danger" onClick={() => setVoiding(true)}>Void</Button>}<Button variant="secondary" onClick={onClose}>Close</Button></>}>
      <div className="space-y-3">
        {error && <Alert>{error}</Alert>}
        <LetterSheet letter={d} />
        {d.documents.length > 0 && <div className="text-sm"><div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Signed or scanned copies</div><ul className="mt-1 space-y-1">{d.documents.map((x) => <li key={x.documentId}>{x.documentNumber} · {x.title}{!x.accessible && <span className="ml-2 text-xs text-slate-400">(no access to the file itself)</span>}</li>)}</ul></div>}
        <p className="text-xs text-slate-400">The wording was frozen when the letter was issued. Editing the template later does not change this letter; a mistake is voided and a new letter issued.</p>
      </div>
      <Modal open={voiding} onClose={() => setVoiding(false)} title="Void this letter" description="The letter stays on the record, marked void, and the employee is told. Issue a corrected letter afterwards if one is needed."
        footer={<><Button variant="secondary" onClick={() => setVoiding(false)}>Cancel</Button><Button variant="danger" loading={m.voidLetter.isPending} onClick={async () => { setError(null); try { await m.voidLetter.mutateAsync({ id, input: { reasonCode: reasonCode as 'OTHER' } }); toast.success('Letter voided.'); setVoiding(false); } catch (e) { setError(errorMessage(e)); } }}>Void letter</Button></>}>
        <Select label="Reason" options={['ISSUED_IN_ERROR', 'INCORRECT_DATA', 'SUPERSEDED', 'EMPLOYEE_REQUEST', 'OTHER'].map((r) => ({ value: r, label: titleCase(r) }))} value={reasonCode} onChange={(e) => setReasonCode(e.target.value)} />
      </Modal>
    </Modal>
  );
}
