import { useEffect, useState } from 'react';
import { Plus, Printer } from 'lucide-react';
import { PERMISSIONS, type CaseDetailDto, type CaseSummaryDto, type DisciplinaryActionDto } from '@hr/shared';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Alert } from '@/components/ui/Alert';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { SearchInput } from '@/components/ui/SearchInput';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { Pagination } from '@/components/ui/Pagination';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { LoadingBlock } from '@/components/ui/Spinner';
import { useToast } from '@/components/ui/Toast';
import { useAuth } from '@/hooks/useAuth';
import { useDebounce } from '@/hooks/useDebounce';
import { useDepartmentOptions } from '@/features/organization/organization.api';
import { errorMessage } from '@/features/organization/shared';
import { EmployeePicker, type PayrollEmployeeOption } from '@/features/payroll/employee-picker';
import { useActionTypes, useCase, useCaseCategories, useCases, useErMutations, useLetterTemplates } from './er.api';
import { ActionStatusBadge, CaseStatusBadge, ValidityBadge, WarningLetterView } from './er-ui';

/** The HR case list. Everything sensitive is behind the click; the list itself shows status and numbers. */
export function CasesPage() {
  const { hasPermission } = useAuth();
  const canManage = hasPermission(PERMISSIONS.EMPLOYEE_RELATIONS_MANAGE);
  const departments = useDepartmentOptions();
  const actionTypes = useActionTypes(true);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [actionTypeId, setActionTypeId] = useState('');
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const cases = useCases({ search: useDebounce(search), status, departmentId, actionTypeId, page, pageSize: 20 });

  const columns: Column<CaseSummaryDto>[] = [
    { key: 'number', header: 'Case', render: (c) => <div><div className="font-medium text-slate-900">{c.caseNumber}</div><div className="text-xs text-slate-400">{c.title}</div></div> },
    { key: 'emp', header: 'Employee', render: (c) => <div><div className="text-slate-900">{c.employee.firstName} {c.employee.lastName}</div><div className="text-xs text-slate-400">{c.employee.employeeCode}{c.snapshot.departmentName && ` · ${c.snapshot.departmentName}`}</div></div> },
    { key: 'incident', header: 'Incident', hideBelow: 'md', render: (c) => c.incidentDate },
    { key: 'category', header: 'Category', hideBelow: 'lg', render: (c) => c.category?.name ?? <span className="text-slate-400">—</span> },
    { key: 'action', header: 'Action', hideBelow: 'sm', render: (c) => (c.currentAction ? <span className="flex items-center gap-2">{c.currentAction.actionTypeName}<ValidityBadge validity={c.currentAction.validity} /></span> : <span className="text-slate-400">—</span>) },
    { key: 'ack', header: 'Receipt', hideBelow: 'lg', render: (c) => (c.currentAction?.status === 'ACKNOWLEDGED' ? 'Acknowledged' : c.currentAction?.status === 'ISSUED' ? <span className="text-amber-700">Awaiting</span> : <span className="text-slate-400">—</span>) },
    { key: 'status', header: 'Status', render: (c) => <CaseStatusBadge status={c.status} /> },
  ];

  return (
    <>
      <Card>
        <div className="grid grid-cols-1 gap-3 border-b border-slate-200 p-4 sm:grid-cols-3 xl:grid-cols-5">
          <SearchInput placeholder="Case number, title or employee…" value={search} onChange={(v) => { setSearch(v); setPage(1); }} />
          <Select options={['DRAFT', 'UNDER_REVIEW', 'PENDING_APPROVAL', 'ACTION_ISSUED', 'CLOSED', 'CANCELLED'].map((s) => ({ value: s, label: s.charAt(0) + s.slice(1).toLowerCase().replace('_', ' ') }))} placeholder="All statuses" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} />
          <Select options={(departments.data?.data ?? []).map((d) => ({ value: d.id, label: d.name }))} placeholder="All departments" value={departmentId} onChange={(e) => { setDepartmentId(e.target.value); setPage(1); }} />
          <Select options={(actionTypes.data ?? []).map((t) => ({ value: t.id, label: t.name }))} placeholder="All action types" value={actionTypeId} onChange={(e) => { setActionTypeId(e.target.value); setPage(1); }} />
          {canManage && <div className="flex justify-end"><Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> Case</Button></div>}
        </div>
        {cases.isError && <Alert className="m-4">Could not load cases.</Alert>}
        <DataTable columns={columns} rows={cases.data?.data ?? []} rowKey={(c) => c.id} loading={cases.isLoading} onRowClick={(c) => setOpenId(c.id)} emptyTitle="No cases" />
        {cases.data?.meta && <Pagination {...cases.data.meta} onPageChange={setPage} />}
      </Card>
      <CreateCaseModal open={creating} onClose={() => setCreating(false)} />
      <CaseDetailModal caseId={openId} onClose={() => setOpenId(null)} />
    </>
  );
}

function CreateCaseModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const m = useErMutations();
  const toast = useToast();
  const categories = useCaseCategories();
  const [employee, setEmployee] = useState<PayrollEmployeeOption | null>(null);
  const [incidentDate, setIncidentDate] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [internalNotes, setNotes] = useState('');
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (open) { setErr(null); setEmployee(null); setIncidentDate(''); setCategoryId(''); setTitle(''); setDescription(''); setNotes(''); } }, [open]);

  const submit = async () => {
    setErr(null);
    try {
      await m.createCase.mutateAsync({ employeeId: employee!.id, incidentDate, categoryId: categoryId || null, title, description, internalNotes: internalNotes || null });
      toast.success('Case opened');
      onClose();
    } catch (e) { setErr(errorMessage(e)); }
  };

  return (
    <Modal open={open} onClose={onClose} title="Open a case" description="Record what was reported. The employee's department, position and job are frozen on the case as they are today." size="lg"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={submit} loading={m.createCase.isPending} disabled={!employee || !incidentDate || !title || !description}>Open case</Button></>}>
      <div className="space-y-3">
        {err && <Alert>{err}</Alert>}
        <EmployeePicker value={employee} onChange={setEmployee} endpoint="/employee-relations/employee-options" />
        <div className="grid grid-cols-2 gap-3">
          <Input label="Incident date" required type="date" value={incidentDate} onChange={(e) => setIncidentDate(e.target.value)} />
          <Select label="Category" options={(categories.data ?? []).map((c) => ({ value: c.id, label: c.name }))} placeholder="Uncategorised" value={categoryId} onChange={(e) => setCategoryId(e.target.value)} />
        </div>
        <Input label="Title" required value={title} onChange={(e) => setTitle(e.target.value)} />
        <Textarea label="What was reported" required rows={4} value={description} onChange={(e) => setDescription(e.target.value)} />
        <Textarea label="Internal notes (HR only)" rows={2} value={internalNotes} onChange={(e) => setNotes(e.target.value)} />
      </div>
    </Modal>
  );
}

/** Everything about one case, in sections. Internal notes appear only when the server included them. */
function CaseDetailModal({ caseId, onClose }: { caseId: string | null; onClose: () => void }) {
  const { hasPermission } = useAuth();
  const canManage = hasPermission(PERMISSIONS.EMPLOYEE_RELATIONS_MANAGE);
  const canIssue = hasPermission(PERMISSIONS.EMPLOYEE_RELATIONS_ISSUE);
  const erCase = useCase(caseId);
  const m = useErMutations();
  const toast = useToast();
  const [confirm, setConfirm] = useState<'submit' | 'close' | 'cancel' | 'withdraw' | null>(null);
  const [declineNote, setDeclineNote] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const c = erCase.data;
  const current = c?.actions.find((a) => !['REJECTED', 'CANCELLED'].includes(a.status)) ?? null;

  const run = async (fn: () => Promise<unknown>, done: string) => {
    setErr(null);
    try { await fn(); toast.success(done); setConfirm(null); } catch (e) { setErr(errorMessage(e)); }
  };

  return (
    <>
      <Modal open={!!caseId} onClose={onClose} title={c ? `${c.caseNumber} · ${c.title}` : 'Case'} description={c ? `${c.employee.firstName} ${c.employee.lastName} · ${c.employee.employeeCode}` : undefined} size="lg">
        {erCase.isLoading && <LoadingBlock />}
        {erCase.isError && <Alert>Could not load this case.</Alert>}
        {err && <Alert className="mb-3">{err}</Alert>}
        {c && (
          <div className="space-y-5 text-sm">
            <div className="flex flex-wrap items-center gap-3"><CaseStatusBadge status={c.status} /><span className="text-slate-500">incident {c.incidentDate}</span>{c.category && <span className="text-slate-500">{c.category.name}</span>}</div>

            <Section title="Employee, as they were">
              <p className="text-slate-700">{c.snapshot.positionTitle ?? '—'}{c.snapshot.jobTitle && ` (${c.snapshot.jobTitle})`} · {c.snapshot.departmentName ?? '—'} · {c.snapshot.organizationName ?? '—'}</p>
            </Section>
            <Section title="What was reported"><p className="whitespace-pre-wrap text-slate-700">{c.description}</p></Section>
            {'internalNotes' in c && <Section title="Internal notes (HR only)"><p className="whitespace-pre-wrap text-slate-700">{c.internalNotes || <span className="text-slate-400">None</span>}</p></Section>}

            <Section title="Already on record">
              {c.priorActiveActions.length === 0 ? <p className="text-slate-500">Nothing currently stands against this employee.</p> : (
                <ul className="divide-y divide-slate-100">{c.priorActiveActions.map((a) => <li key={a.actionId} className="flex items-center justify-between py-1.5"><span>{a.actionTypeName} · {a.caseNumber}</span><span className="flex items-center gap-2 text-xs text-slate-500">{a.issuedDate}{a.validUntil && ` → ${a.validUntil}`}<ValidityBadge validity={a.validity} /></span></li>)}</ul>
              )}
              <p className="mt-1 text-xs text-slate-500">Shown so a person can decide. The system recommends nothing.</p>
            </Section>

            <Section title="Action">
              {current ? <ActionPanel action={current} canManage={canManage} canIssue={canIssue} onSubmit={() => setConfirm('submit')} onWithdraw={() => setConfirm('withdraw')} /> : (
                canManage && ['DRAFT', 'UNDER_REVIEW'].includes(c.status) ? <ProposeForm caseId={c.id} /> : <p className="text-slate-500">No proposal.</p>
              )}
              {c.actions.filter((a) => ['REJECTED', 'CANCELLED'].includes(a.status)).length > 0 && (
                <p className="mt-2 text-xs text-slate-500">Earlier proposals: {c.actions.filter((a) => ['REJECTED', 'CANCELLED'].includes(a.status)).map((a) => `${a.actionType.name} (${a.status.toLowerCase()})`).join(', ')}</p>
              )}
            </Section>

            {current?.letter && (
              <Section title="Issued letter">
                <WarningLetterView letter={current.letter} printId="payslip-print" />
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <Button variant="secondary" size="sm" onClick={() => window.print()}><Printer className="h-4 w-4" /> Print</Button>
                  {current.acknowledgedAt ? <span className="text-xs text-emerald-700">Receipt acknowledged {current.acknowledgedAt.slice(0, 10)}</span> : current.declinedAt ? <span className="text-xs text-slate-500">Employee declined to acknowledge (recorded {current.declinedAt.slice(0, 10)})</span> : current.requiresAcknowledgement ? <span className="text-xs text-amber-700">Awaiting receipt{current.acknowledgementDueDate && ` · requested by ${current.acknowledgementDueDate}`}</span> : null}
                </div>
                {canManage && current.status === 'ISSUED' && !current.declinedAt && current.requiresAcknowledgement && (
                  <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-end">
                    <div className="flex-1"><Input label="Employee declined to sign — note" value={declineNote} onChange={(e) => setDeclineNote(e.target.value)} /></div>
                    <Button variant="secondary" size="sm" disabled={!declineNote} onClick={() => run(() => m.recordDeclined.mutateAsync({ id: current.id, input: { note: declineNote } }), 'Recorded')}>Record</Button>
                  </div>
                )}
              </Section>
            )}

            <Section title="Timeline">
              <ul className="divide-y divide-slate-100">{c.timeline.map((t, i) => <li key={i} className="flex items-start justify-between gap-3 py-1.5"><span><span className="block text-slate-900">{t.label}</span>{t.comment && <span className="block text-xs text-slate-500">{t.comment}</span>}</span><span className="shrink-0 text-xs text-slate-500">{t.at.slice(0, 16).replace('T', ' ')}{t.actor && ` · ${t.actor}`}</span></li>)}</ul>
            </Section>

            {canManage && (
              <div className="flex flex-wrap gap-2 border-t border-slate-200 pt-3">
                {['ACTION_ISSUED', 'UNDER_REVIEW', 'DRAFT'].includes(c.status) && <Button variant="secondary" onClick={() => setConfirm('close')}>Close case</Button>}
                {['DRAFT', 'UNDER_REVIEW'].includes(c.status) && <Button variant="ghost" onClick={() => setConfirm('cancel')}>Cancel case</Button>}
              </div>
            )}
          </div>
        )}
      </Modal>
      <ConfirmDialog open={confirm === 'submit'} title="Submit for approval" message="The proposal and the case facts are frozen while the approver decides. Nothing is issued until they approve." confirmLabel="Submit" loading={m.actionOp.isPending} error={err} onConfirm={() => run(() => m.actionOp.mutateAsync({ id: current!.id, op: 'submit' }), 'Submitted for approval')} onCancel={() => setConfirm(null)} />
      <ConfirmDialog open={confirm === 'withdraw'} title="Withdraw this proposal" message="The draft is withdrawn. A new proposal can be drafted on the case." confirmLabel="Withdraw" loading={m.actionOp.isPending} error={err} onConfirm={() => run(() => m.actionOp.mutateAsync({ id: current!.id, op: 'cancel' }), 'Withdrawn')} onCancel={() => setConfirm(null)} />
      <ConfirmDialog open={confirm === 'close'} title="Close this case" message="The operational work is done. Anything issued stays issued; a pending acknowledgement can still be given." confirmLabel="Close case" loading={m.caseAction.isPending} error={err} onConfirm={() => run(() => m.caseAction.mutateAsync({ id: c!.id, action: 'close' }), 'Case closed')} onCancel={() => setConfirm(null)} />
      <ConfirmDialog open={confirm === 'cancel'} title="Cancel this case" message="Only a case with nothing issued can be cancelled. Any draft proposal is withdrawn with it." confirmLabel="Cancel case" variant="danger" loading={m.caseAction.isPending} error={err} onConfirm={() => run(() => m.caseAction.mutateAsync({ id: c!.id, action: 'cancel' }), 'Case cancelled')} onCancel={() => setConfirm(null)} />
    </>
  );
}

const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <section><h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">{title}</h3>{children}</section>
);

function ActionPanel({ action, canManage, canIssue, onSubmit, onWithdraw }: { action: DisciplinaryActionDto; canManage: boolean; canIssue: boolean; onSubmit: () => void; onWithdraw: () => void }) {
  const m = useErMutations();
  const [reason, setReason] = useState(action.reason);
  const [validityDays, setValidity] = useState(action.validityDays === null ? '' : String(action.validityDays));
  const [subject, setSubject] = useState(action.letterSubject ?? '');
  const [body, setBody] = useState(action.letterBody ?? '');
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const editable = canManage && action.status === 'DRAFT';

  const save = async () => {
    setErr(null); setSaved(false);
    try {
      await m.updateAction.mutateAsync({ id: action.id, input: { reason, validityDays: validityDays === '' ? null : Number(validityDays), letterSubject: subject || null, letterBody: body || null } });
      setSaved(true);
    } catch (e) { setErr(errorMessage(e)); }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3"><span className="font-medium text-slate-900">{action.actionType.name}</span><ActionStatusBadge status={action.status} /><ValidityBadge validity={action.validity} />{action.issuedDate && <span className="text-xs text-slate-500">issued {action.issuedDate}{action.validUntil && ` · until ${action.validUntil}`}</span>}</div>
      {err && <Alert>{err}</Alert>}
      {editable ? (
        <div className="space-y-3">
          <Textarea label="Reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
          <Input label="On record for (days)" inputMode="numeric" value={validityDays} onChange={(e) => setValidity(e.target.value)} hint="Blank means no end date. The action type's default is a starting point, not a rule." />
          {action.requiresWarningLetter && (<><Input label="Letter subject" value={subject} onChange={(e) => setSubject(e.target.value)} /><Textarea label="Letter body" rows={8} value={body} onChange={(e) => setBody(e.target.value)} /><p className="text-xs text-slate-500">Plain text. {'{{issuedDate}}'} and {'{{validUntil}}'} are filled in when the letter is issued.</p></>)}
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" size="sm" onClick={save} loading={m.updateAction.isPending}>Save draft</Button>
            {saved && <span className="text-xs text-emerald-700">Saved</span>}
            <span className="flex-1" />
            <Button variant="ghost" size="sm" onClick={onWithdraw}>Withdraw</Button>
            {canIssue && <Button size="sm" onClick={onSubmit}>Submit for approval</Button>}
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          <p className="whitespace-pre-wrap text-slate-700">{action.reason}</p>
          {action.status === 'PENDING_APPROVAL' && <p className="text-xs text-slate-500">With the approver. Nothing here can change until they decide.</p>}
          {action.letterBody && !action.letter && <div className="rounded-md border border-slate-200 bg-slate-50 p-3"><p className="font-medium text-slate-900">{action.letterSubject}</p><p className="mt-1 whitespace-pre-wrap text-slate-700">{action.letterBody}</p></div>}
        </div>
      )}
    </div>
  );
}

function ProposeForm({ caseId }: { caseId: string }) {
  const m = useErMutations();
  const types = useActionTypes();
  const templates = useLetterTemplates();
  const [actionTypeId, setTypeId] = useState('');
  const [reason, setReason] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const chosen = (types.data ?? []).find((t) => t.id === actionTypeId);

  const propose = async () => {
    setErr(null);
    try { await m.createAction.mutateAsync({ caseId, input: { actionTypeId, reason, letterTemplateId: templateId || null } }); } catch (e) { setErr(errorMessage(e)); }
  };

  return (
    <div className="space-y-3 rounded-md border border-slate-200 p-3">
      {err && <Alert>{err}</Alert>}
      <Select label="Proposed action" options={(types.data ?? []).map((t) => ({ value: t.id, label: `${t.name}${t.defaultValidityDays ? ` · default ${t.defaultValidityDays} days` : ''}` }))} placeholder="Choose an action type" value={actionTypeId} onChange={(e) => setTypeId(e.target.value)} />
      {chosen?.requiresWarningLetter && <Select label="Letter template" options={(templates.data ?? []).filter((t) => t.isActive).map((t) => ({ value: t.id, label: t.name }))} placeholder="Draft the letter by hand" value={templateId} onChange={(e) => setTemplateId(e.target.value)} />}
      <Textarea label="Reason" required rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
      <div className="flex justify-end"><Button onClick={propose} loading={m.createAction.isPending} disabled={!actionTypeId || !reason}>Draft proposal</Button></div>
      <p className="text-xs text-slate-500">Choosing an action is a person's decision under the organization's policy. The system suggests nothing.</p>
    </div>
  );
}

export type { CaseDetailDto };
