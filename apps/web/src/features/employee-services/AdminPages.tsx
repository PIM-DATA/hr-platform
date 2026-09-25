import { useState } from 'react';
import { Plus } from 'lucide-react';
import {
  HR_LETTER_TYPES, SERVICE_CATEGORIES, SERVICE_FIELD_TYPES, SERVICE_REQUEST_STATUSES, type HrLetterDto, type HrLetterTemplateDto, type ServiceFieldType, type ServiceRequestDto, type ServiceRequestTypeDto,
} from '@hr/shared';
import { Card, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Alert } from '@/components/ui/Alert';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { Checkbox } from '@/components/ui/Checkbox';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { Pagination } from '@/components/ui/Pagination';
import { LoadingBlock } from '@/components/ui/Spinner';
import { useToast } from '@/components/ui/Toast';
import { errorMessage } from '@/features/organization/shared';
import { EmployeePicker, type PayrollEmployeeOption } from '@/features/payroll/employee-picker';
import { useHrLetters, useLetterTemplates, useRequestTypes, useServiceDashboard, useServiceMutations, useServiceOptions, useServiceReports, useServiceRequests } from './services.api';
import { ServiceBadge, Stat, Table, fmtDate, titleCase } from './services-ui';
import { LetterModal, RequestModal } from './ServiceDialogs';

const emp = (s: { employeeName: string; employeeCode: string; department: string | null }) => <div><div className="font-medium text-slate-900">{s.employeeName}</div><div className="text-xs text-slate-400">{s.employeeCode} · {s.department ?? '—'}</div></div>;

// ---------- HR queue ----------
export function RequestQueuePage() {
  const [f, setF] = useState({ status: '', category: '', assignedToUserId: '', overdue: '', search: '' });
  const [page, setPage] = useState(1); const [open, setOpen] = useState<string | null>(null); const [letter, setLetter] = useState<string | null>(null);
  const list = useServiceRequests({ ...f, overdue: f.overdue || undefined, page, pageSize: 20 });
  const options = useServiceOptions();
  const set = (patch: Partial<typeof f>) => { setF({ ...f, ...patch }); setPage(1); };
  const columns: Column<ServiceRequestDto>[] = [
    { key: 'n', header: 'Request', render: (r) => <span className="font-medium text-brand-700">{r.requestNumber}<span className="block text-xs font-normal text-slate-400">{r.subject}</span></span> },
    { key: 'e', header: 'Employee', render: (r) => emp(r.snapshot) },
    { key: 't', header: 'Type', hideBelow: 'md', render: (r) => <span>{r.requestTypeName}<span className="block text-xs text-slate-400">{titleCase(r.category)}</span></span> },
    { key: 'a', header: 'Assigned', hideBelow: 'sm', render: (r) => r.assignedToName ?? <span className="text-slate-400">Nobody</span> },
    { key: 'd', header: 'Target', hideBelow: 'sm', render: (r) => (r.dueDate ? <span className={r.overdue ? 'font-semibold text-red-700' : ''}>{r.dueDate}</span> : '—') },
    { key: 's', header: 'Status', render: (r) => <span><ServiceBadge status={r.status} />{r.workflowStatus && r.workflowStatus !== 'APPROVED' && <span className="block text-xs text-slate-400">approval {titleCase(r.workflowStatus)}</span>}</span> },
  ];
  return (
    <Card>
      <div className="border-b border-slate-200 p-4"><CardHeader title="Request queue" description="Everything employees have asked for. A request is a record of the ask and the answer; changing an employee's data still happens in the module that owns it." /></div>
      <div className="grid grid-cols-1 gap-3 border-b border-slate-200 p-4 sm:grid-cols-5">
        <Select options={SERVICE_REQUEST_STATUSES.map((s) => ({ value: s, label: titleCase(s) }))} placeholder="All statuses" value={f.status} onChange={(e) => set({ status: e.target.value })} />
        <Select options={SERVICE_CATEGORIES.map((c) => ({ value: c, label: titleCase(c) }))} placeholder="All categories" value={f.category} onChange={(e) => set({ category: e.target.value })} />
        <Select options={(options.data?.fulfillers ?? []).map((u) => ({ value: u.id, label: u.name }))} placeholder="Anyone" value={f.assignedToUserId} onChange={(e) => set({ assignedToUserId: e.target.value })} />
        <Select options={[{ value: 'true', label: 'Past target only' }]} placeholder="Any target" value={f.overdue} onChange={(e) => set({ overdue: e.target.value })} />
        <Input placeholder="Search number, subject or employee" value={f.search} onChange={(e) => set({ search: e.target.value })} />
      </div>
      <DataTable columns={columns} rows={list.data?.data ?? []} rowKey={(r) => r.id} loading={list.isLoading} onRowClick={(r) => setOpen(r.id)} emptyTitle="Nothing in the queue" />
      {list.data?.meta && <Pagination {...list.data.meta} onPageChange={setPage} />}
      {open && <RequestModal id={open} onClose={() => setOpen(null)} onOpenLetter={(id) => { setOpen(null); setLetter(id); }} />}
      {letter && <LetterModal id={letter} onClose={() => setLetter(null)} />}
    </Card>
  );
}

// ---------- service catalogue ----------
type FieldDraft = { key: string; label: string; fieldType: ServiceFieldType; required: boolean; options: string; maxLength: string; employeeVisible: boolean };
const emptyType = { code: '', name: '', description: '', category: 'GENERAL_HR', organizationId: '', workflowCode: '', targetDays: '', requiresAttachment: false, employeeSelectable: true, fulfillmentType: 'GENERAL', letterTemplateId: '' };
export function CatalogPage() {
  const types = useRequestTypes(true); const templates = useLetterTemplates(false); const options = useServiceOptions(); const m = useServiceMutations(); const toast = useToast();
  const [editing, setEditing] = useState<ServiceRequestTypeDto | 'new' | null>(null); const [d, setD] = useState({ ...emptyType }); const [fields, setFields] = useState<FieldDraft[]>([]); const [error, setError] = useState<string | null>(null);
  const start = (t: ServiceRequestTypeDto | 'new') => {
    setError(null);
    if (t === 'new') { setD({ ...emptyType }); setFields([]); }
    else {
      setD({ code: t.code, name: t.name, description: t.description ?? '', category: t.category, organizationId: t.organizationId ?? '', workflowCode: t.workflowCode ?? '', targetDays: t.targetDays ? String(t.targetDays) : '', requiresAttachment: t.requiresAttachment, employeeSelectable: t.employeeSelectable, fulfillmentType: t.fulfillmentType, letterTemplateId: t.letterTemplateId ?? '' });
      setFields(t.fields.map((f) => ({ key: f.key, label: f.label, fieldType: f.fieldType, required: f.required, options: f.options.join(', '), maxLength: f.maxLength ? String(f.maxLength) : '', employeeVisible: f.employeeVisible })));
    }
    setEditing(t);
  };
  const save = async () => {
    setError(null);
    const body = {
      name: d.name, description: d.description || null, category: d.category as 'GENERAL_HR', organizationId: d.organizationId || null, workflowCode: d.workflowCode || null,
      targetDays: d.targetDays ? Number(d.targetDays) : null, requiresAttachment: d.requiresAttachment, employeeSelectable: d.employeeSelectable,
      fulfillmentType: d.fulfillmentType as 'GENERAL', letterTemplateId: d.letterTemplateId || null,
      fields: fields.filter((f) => f.key && f.label).map((f, i) => ({ key: f.key, label: f.label, fieldType: f.fieldType, required: f.required, displayOrder: i, employeeVisible: f.employeeVisible, maxLength: f.maxLength ? Number(f.maxLength) : null, options: ['SELECT', 'MULTI_SELECT'].includes(f.fieldType) ? f.options.split(',').map((o) => o.trim()).filter(Boolean) : undefined })),
    };
    try { if (editing === 'new') await m.createType.mutateAsync({ code: d.code, ...body }); else if (editing) await m.updateType.mutateAsync({ id: editing.id, input: body }); toast.success('Saved.'); setEditing(null); } catch (e) { setError(errorMessage(e)); }
  };
  const columns: Column<ServiceRequestTypeDto>[] = [
    { key: 't', header: 'Request type', render: (t) => <span className="font-medium text-slate-900">{t.name}<span className="block text-xs font-normal text-slate-400">{t.code} · {titleCase(t.category)}{t.targetDays ? ` · target ${t.targetDays} days` : ''}{t.workflowCode ? ` · approval ${t.workflowCode}` : ''}</span></span> },
    { key: 'f', header: 'Fulfilment', hideBelow: 'sm', render: (t) => <span>{titleCase(t.fulfillmentType)}{t.letterTemplateName ? <span className="block text-xs text-slate-400">{t.letterTemplateName}</span> : null}</span> },
    { key: 'q', header: 'Fields', hideBelow: 'md', render: (t) => (t.fields.length === 0 ? <span className="text-slate-400">None</span> : <span className="text-xs text-slate-600">{t.fields.map((f) => `${f.label} (${titleCase(f.fieldType)})`).join(' · ')}</span>) },
    { key: 'n', header: 'Requests', hideBelow: 'md', render: (t) => t.requestCount },
    { key: 's', header: 'Active', render: (t) => (t.isActive ? 'Yes' : 'No') },
    { key: 'a', header: '', render: (t) => <span className="flex gap-2"><Button size="sm" variant="secondary" onClick={() => start(t)}>Edit</Button><Button size="sm" variant="secondary" onClick={async () => { try { await m.updateType.mutateAsync({ id: t.id, input: { isActive: !t.isActive } }); toast.success('Saved.'); } catch (e) { toast.error(errorMessage(e)); } }}>{t.isActive ? 'Deactivate' : 'Activate'}</Button></span> },
  ];
  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 p-4"><CardHeader title="Service catalog" description="What employees may ask for, the questions they answer and how each request is fulfilled. Fields are plain data: no code, expressions or formulas." /><Button onClick={() => start('new')}><Plus className="h-4 w-4" /> New request type</Button></div>
      <DataTable columns={columns} rows={types.data ?? []} rowKey={(t) => t.id} loading={types.isLoading} emptyTitle="No request types yet" />
      <Modal open={!!editing} onClose={() => setEditing(null)} size="lg" title={editing === 'new' ? 'New request type' : 'Edit request type'} footer={<><Button variant="secondary" onClick={() => setEditing(null)}>Cancel</Button><Button loading={m.createType.isPending || m.updateType.isPending} disabled={!d.name || (editing === 'new' && !d.code)} onClick={save}>Save</Button></>}>
        <div className="space-y-3">
          {error && <Alert>{error}</Alert>}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3"><Input label="Code" placeholder="EMP-CERT-REQ" value={d.code} disabled={editing !== 'new'} onChange={(e) => setD({ ...d, code: e.target.value.toUpperCase() })} /><Input label="Name" value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} /><Select label="Category" options={SERVICE_CATEGORIES.map((c) => ({ value: c, label: titleCase(c) }))} value={d.category} onChange={(e) => setD({ ...d, category: e.target.value })} /></div>
          <Textarea label="Description shown to the employee" rows={2} maxLength={1000} value={d.description} onChange={(e) => setD({ ...d, description: e.target.value })} />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Select label="Fulfilment" options={[{ value: 'GENERAL', label: 'General (record the outcome)' }, { value: 'HR_LETTER', label: 'HR letter (issue a letter)' }]} value={d.fulfillmentType} onChange={(e) => setD({ ...d, fulfillmentType: e.target.value })} />
            <Select label="Letter template" options={(templates.data ?? []).map((t) => ({ value: t.id, label: `${t.name}${t.requiresSalaryAccess ? ' · needs payroll authority' : ''}` }))} placeholder={d.fulfillmentType === 'HR_LETTER' ? 'Required' : 'Not used'} value={d.letterTemplateId} onChange={(e) => setD({ ...d, letterTemplateId: e.target.value })} />
            <Input label="Target (calendar days)" inputMode="numeric" value={d.targetDays} onChange={(e) => setD({ ...d, targetDays: e.target.value })} />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2"><Select label="Approval workflow (optional)" options={(options.data?.workflows ?? []).map((w) => ({ value: w.code, label: `${w.code} · ${w.name}` }))} placeholder="No approval" value={d.workflowCode} onChange={(e) => setD({ ...d, workflowCode: e.target.value })} /><Select label="Organization (optional)" options={(options.data?.organizations ?? []).map((o) => ({ value: o.id, label: o.name }))} placeholder="Any" value={d.organizationId} onChange={(e) => setD({ ...d, organizationId: e.target.value })} /></div>
          <div className="flex flex-wrap gap-4"><Checkbox label="Needs an attachment before submitting" checked={d.requiresAttachment} onChange={(e) => setD({ ...d, requiresAttachment: e.target.checked })} /><Checkbox label="Employees may choose this themselves" checked={d.employeeSelectable} onChange={(e) => setD({ ...d, employeeSelectable: e.target.checked })} /></div>
          <div>
            <div className="flex items-center justify-between"><span className="text-xs font-semibold uppercase tracking-wide text-slate-500">Form fields</span><Button size="sm" variant="secondary" onClick={() => setFields([...fields, { key: '', label: '', fieldType: 'TEXT', required: false, options: '', maxLength: '', employeeVisible: true }])}>Add field</Button></div>
            {fields.map((f, i) => { const set = (patch: Partial<FieldDraft>) => setFields(fields.map((x, j) => (j === i ? { ...x, ...patch } : x))); return (
              <div key={i} className="mt-2 space-y-2 rounded-lg border border-slate-200 p-3">
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-4"><Input label="Key" placeholder="purpose" value={f.key} onChange={(e) => set({ key: e.target.value.replace(/[^A-Za-z0-9_]/g, '') })} /><Input label="Label" value={f.label} onChange={(e) => set({ label: e.target.value })} /><Select label="Type" options={SERVICE_FIELD_TYPES.map((t) => ({ value: t, label: titleCase(t) }))} value={f.fieldType} onChange={(e) => set({ fieldType: e.target.value as ServiceFieldType })} /><Input label="Max length" inputMode="numeric" value={f.maxLength} onChange={(e) => set({ maxLength: e.target.value })} /></div>
                {['SELECT', 'MULTI_SELECT'].includes(f.fieldType) && <Input label="Options (comma separated)" placeholder="Visa application, Bank loan" value={f.options} onChange={(e) => set({ options: e.target.value })} />}
                <div className="flex flex-wrap gap-4"><Checkbox label="Required" checked={f.required} onChange={(e) => set({ required: e.target.checked })} /><Checkbox label="Shown to the approver" checked={f.employeeVisible} onChange={(e) => set({ employeeVisible: e.target.checked })} /><button className="text-xs text-red-700 underline" onClick={() => setFields(fields.filter((_, j) => j !== i))}>Remove</button></div>
              </div>); })}
            <p className="mt-1 text-xs text-slate-400">Editing fields changes future requests only. What an answer meant is frozen on each request when it is submitted.</p>
          </div>
        </div>
      </Modal>
    </Card>
  );
}

// ---------- issued letters ----------
export function LettersPage() {
  const [f, setF] = useState({ letterType: '', status: '', search: '' }); const [page, setPage] = useState(1); const [open, setOpen] = useState<string | null>(null); const [issuing, setIssuing] = useState(false);
  const list = useHrLetters({ ...f, page, pageSize: 20 }); const templates = useLetterTemplates(false); const m = useServiceMutations(); const toast = useToast();
  const [issue, setIssue] = useState({ employeeId: '', templateId: '' }); const [employee, setEmployee] = useState<PayrollEmployeeOption | null>(null); const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<typeof f>) => { setF({ ...f, ...patch }); setPage(1); };
  const columns: Column<HrLetterDto>[] = [
    { key: 'n', header: 'Letter', render: (l) => <span className="font-medium text-brand-700">{l.letterNumber}<span className="block text-xs font-normal text-slate-400">{titleCase(l.letterType)}{l.serviceRequestNumber ? ` · ${l.serviceRequestNumber}` : ''}</span></span> },
    { key: 'e', header: 'Employee', render: (l) => emp(l.snapshot) },
    { key: 't', header: 'Template', hideBelow: 'md', render: (l) => l.templateName },
    { key: 'd', header: 'Issued', hideBelow: 'sm', render: (l) => `${l.issuedDate}${l.issuedByName ? ` · ${l.issuedByName}` : ''}` },
    { key: 's', header: 'Status', render: (l) => <ServiceBadge status={l.status} /> },
  ];
  const selected = (templates.data ?? []).find((t) => t.id === issue.templateId);
  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 p-4"><CardHeader title="Issued HR letters" description="Every letter ever issued, including voided ones. A letter is frozen at issue; a mistake is voided and replaced, never edited." /><Button onClick={() => { setError(null); setIssuing(true); }}><Plus className="h-4 w-4" /> Issue a letter</Button></div>
      <div className="grid grid-cols-1 gap-3 border-b border-slate-200 p-4 sm:grid-cols-3">
        <Select options={HR_LETTER_TYPES.map((t) => ({ value: t, label: titleCase(t) }))} placeholder="All types" value={f.letterType} onChange={(e) => set({ letterType: e.target.value })} />
        <Select options={[{ value: 'ISSUED', label: 'Issued' }, { value: 'VOID', label: 'Void' }]} placeholder="All statuses" value={f.status} onChange={(e) => set({ status: e.target.value })} />
        <Input placeholder="Search number or employee" value={f.search} onChange={(e) => set({ search: e.target.value })} />
      </div>
      <DataTable columns={columns} rows={list.data?.data ?? []} rowKey={(l) => l.id} loading={list.isLoading} onRowClick={(l) => setOpen(l.id)} emptyTitle="No letters issued yet" />
      {list.data?.meta && <Pagination {...list.data.meta} onPageChange={setPage} />}
      {open && <LetterModal id={open} onClose={() => setOpen(null)} />}
      <Modal open={issuing} onClose={() => setIssuing(false)} title="Issue a letter" description="The letter is rendered on the server from the template and the employee's current record, then frozen. A salary letter also needs the payroll authority."
        footer={<><Button variant="secondary" onClick={() => setIssuing(false)}>Cancel</Button><Button loading={m.issueLetter.isPending} disabled={!issue.employeeId || !issue.templateId} onClick={async () => { setError(null); try { const l = await m.issueLetter.mutateAsync(issue); toast.success('Letter issued.'); setIssuing(false); setOpen(l.id); } catch (e) { setError(errorMessage(e)); } }}>Issue</Button></>}>
        <div className="space-y-3">
          {error && <Alert>{error}</Alert>}
          <EmployeePicker label="Employee" value={employee} onChange={(e) => { setEmployee(e); setIssue({ ...issue, employeeId: e?.id ?? '' }); }} endpoint="/workforce/employee-options" />
          <Select label="Template" options={(templates.data ?? []).map((t) => ({ value: t.id, label: `${t.name} · ${titleCase(t.letterType)}` }))} placeholder="Choose" value={issue.templateId} onChange={(e) => setIssue({ ...issue, templateId: e.target.value })} />
          {selected?.requiresSalaryAccess && <Alert tone="info">This template includes salary figures. Issuing it needs the payroll authority as well as the letter permission, and the employee must have an authoritative compensation record in effect today.</Alert>}
        </div>
      </Modal>
    </Card>
  );
}

// ---------- letter templates ----------
export function TemplatesPage() {
  const list = useLetterTemplates(true); const options = useServiceOptions(); const m = useServiceMutations(); const toast = useToast();
  const [editing, setEditing] = useState<HrLetterTemplateDto | 'new' | null>(null); const [error, setError] = useState<string | null>(null);
  const [d, setD] = useState({ code: '', name: '', letterType: 'GENERAL', organizationId: '', subjectTemplate: '', bodyTemplate: '' });
  const start = (t: HrLetterTemplateDto | 'new') => { setError(null); setD(t === 'new' ? { code: '', name: '', letterType: 'GENERAL', organizationId: '', subjectTemplate: '', bodyTemplate: '' } : { code: t.code, name: t.name, letterType: t.letterType, organizationId: t.organizationId ?? '', subjectTemplate: t.subjectTemplate ?? '', bodyTemplate: t.bodyTemplate }); setEditing(t); };
  const save = async () => {
    setError(null);
    const body = { name: d.name, letterType: d.letterType as 'GENERAL', organizationId: d.organizationId || null, subjectTemplate: d.subjectTemplate || null, bodyTemplate: d.bodyTemplate };
    try { if (editing === 'new') await m.createTemplate.mutateAsync({ code: d.code, ...body }); else if (editing) await m.updateTemplate.mutateAsync({ id: editing.id, input: body }); toast.success('Template saved.'); setEditing(null); } catch (e) { setError(errorMessage(e)); }
  };
  const columns: Column<HrLetterTemplateDto>[] = [
    { key: 't', header: 'Template', render: (t) => <span className="font-medium text-slate-900">{t.name}<span className="block text-xs font-normal text-slate-400">{t.code} · {titleCase(t.letterType)}</span></span> },
    { key: 'k', header: 'Tokens used', hideBelow: 'md', render: (t) => <span className="text-xs text-slate-600">{t.tokens.join(', ') || 'None'}</span> },
    { key: 'p', header: 'Payroll authority', render: (t) => (t.requiresSalaryAccess ? <span className="text-xs font-semibold text-amber-700">Required</span> : <span className="text-xs text-slate-400">Not needed</span>) },
    { key: 'n', header: 'Issued', hideBelow: 'sm', render: (t) => t.letterCount },
    { key: 's', header: 'Active', render: (t) => (t.isActive ? 'Yes' : 'No') },
    { key: 'a', header: '', render: (t) => <span className="flex gap-2"><Button size="sm" variant="secondary" onClick={() => start(t)}>Edit</Button><Button size="sm" variant="secondary" onClick={async () => { try { await m.updateTemplate.mutateAsync({ id: t.id, input: { isActive: !t.isActive } }); toast.success('Saved.'); } catch (e) { toast.error(errorMessage(e)); } }}>{t.isActive ? 'Deactivate' : 'Activate'}</Button></span> },
  ];
  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 p-4"><CardHeader title="Letter templates" description="Plain text with allow-listed tokens. There are no formulas, conditions or code: an unknown token is refused when you save, and an issued letter keeps the wording it had." /><Button onClick={() => start('new')}><Plus className="h-4 w-4" /> New template</Button></div>
      <DataTable columns={columns} rows={list.data ?? []} rowKey={(t) => t.id} loading={list.isLoading} emptyTitle="No templates yet" />
      <Modal open={!!editing} onClose={() => setEditing(null)} size="lg" title={editing === 'new' ? 'New letter template' : 'Edit letter template'} footer={<><Button variant="secondary" onClick={() => setEditing(null)}>Cancel</Button><Button loading={m.createTemplate.isPending || m.updateTemplate.isPending} disabled={!d.name || d.bodyTemplate.length < 10 || (editing === 'new' && !d.code)} onClick={save}>Save</Button></>}>
        <div className="space-y-3">
          {error && <Alert>{error}</Alert>}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3"><Input label="Code" placeholder="EMP-CERT" value={d.code} disabled={editing !== 'new'} onChange={(e) => setD({ ...d, code: e.target.value.toUpperCase() })} /><Input label="Name" value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} /><Select label="Letter type" options={HR_LETTER_TYPES.map((t) => ({ value: t, label: titleCase(t) }))} value={d.letterType} onChange={(e) => setD({ ...d, letterType: e.target.value })} /></div>
          <Select label="Organization (optional)" options={(options.data?.organizations ?? []).map((o) => ({ value: o.id, label: o.name }))} placeholder="Any" value={d.organizationId} onChange={(e) => setD({ ...d, organizationId: e.target.value })} />
          <Input label="Subject line (optional)" value={d.subjectTemplate} onChange={(e) => setD({ ...d, subjectTemplate: e.target.value })} />
          <Textarea label="Letter body" rows={10} maxLength={8000} value={d.bodyTemplate} onChange={(e) => setD({ ...d, bodyTemplate: e.target.value })} />
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Tokens you may use</div>
            <div className="mt-2 flex flex-wrap gap-1">{(options.data?.letterTokens ?? []).map((t) => (
              <button key={t.token} className={`rounded border px-2 py-1 text-xs ${t.sensitive ? 'border-amber-300 bg-amber-50 text-amber-900' : 'border-slate-300 bg-white text-slate-700'}`} title={`${t.label}${t.sensitive ? ' — needs the payroll authority to issue' : ''}`} onClick={() => setD({ ...d, bodyTemplate: `${d.bodyTemplate}{{${t.token}}}` })}>{`{{${t.token}}}`}</button>
            ))}</div>
            <p className="mt-2 text-xs text-slate-500">Anything else between double braces is refused when you save. Amber tokens read salary and make the payroll authority mandatory for whoever issues the letter.</p>
          </div>
        </div>
      </Modal>
    </Card>
  );
}

// ---------- dashboard and reports ----------
export function ServicesDashboardPage() {
  const q = useServiceDashboard();
  if (q.isLoading) return <LoadingBlock />;
  if (q.isError || !q.data) return <Alert>Could not load the dashboard.</Alert>;
  const d = q.data;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="New" value={d.requests.submitted} hint={`${d.requests.draft} still drafts`} />
        <Stat label="In progress" value={d.requests.inProgress} hint={`${d.requests.waitingEmployee} waiting on the employee`} tone={d.requests.inProgress > 0 ? 'warning' : undefined} />
        <Stat label="Past target" value={d.requests.overdue} tone={d.requests.overdue > 0 ? 'danger' : undefined} />
        <Stat label="Completed" value={d.requests.fulfilled} hint={`${d.requests.rejected} declined · ${d.requests.cancelled} withdrawn`} />
      </div>
      <Card><CardHeader title="Letters" description="Issued and voided, by type. A voided letter keeps its row." /><Table head={['Letter type', 'Issued']} rows={d.letters.byType.map((l) => [titleCase(l.letterType), l.count])} /><p className="px-4 py-3 text-xs text-slate-500">{d.letters.issued} issued · {d.letters.voided} void{d.averageFulfillmentDays !== null ? ` · average ${d.averageFulfillmentDays} calendar days to complete a request` : ''}</p></Card>
      <Card><CardHeader title="Definitions" /><dl className="grid grid-cols-1 gap-2 p-4 text-xs text-slate-600 sm:grid-cols-2">{Object.entries(d.definitions).map(([k, v]) => <div key={k}><dt className="font-semibold text-slate-800">{k}</dt><dd>{v}</dd></div>)}</dl></Card>
      <p className="text-xs text-slate-400">Generated {fmtDate(d.generatedAt)}. Counts only; no employee, subject, answer, message or letter text appears here. Nothing escalates automatically.</p>
    </div>
  );
}
export function ServicesReportsPage() {
  const y = new Date().getFullYear(); const [range, setRange] = useState({ from: `${y}-01-01`, to: `${y}-12-31`, organizationId: '' });
  const options = useServiceOptions(); const q = useServiceReports(range); const d = q.data;
  return (
    <div className="space-y-4">
      <Card><div className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-4"><Input label="From" type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} /><Input label="To" type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} /><Select label="Organization" options={(options.data?.organizations ?? []).map((o) => ({ value: o.id, label: o.name }))} placeholder="All" value={range.organizationId} onChange={(e) => setRange({ ...range, organizationId: e.target.value })} /><p className="self-end text-xs text-slate-500">Aggregates by request type, category and month. No person, subject or letter text by design.</p></div></Card>
      {q.isLoading && <LoadingBlock />}
      {d && <>
        <Card><div className="border-b border-slate-200 px-4 py-3 text-sm font-semibold text-slate-900">By request type</div><Table head={['Request type', 'Category', 'Submitted', 'Completed', 'Declined', 'Open', 'Average days']} rows={d.byType.map((r) => [r.requestType, titleCase(r.category), r.submitted, r.fulfilled, r.rejected, r.open, r.averageFulfillmentDays ?? '—'])} /></Card>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Card><div className="border-b border-slate-200 px-4 py-3 text-sm font-semibold text-slate-900">By category</div><Table head={['Category', 'Submitted', 'Completed']} rows={d.byCategory.map((r) => [titleCase(r.category), r.submitted, r.fulfilled])} /></Card>
          <Card><div className="border-b border-slate-200 px-4 py-3 text-sm font-semibold text-slate-900">By month</div><Table head={['Month', 'Submitted', 'Completed']} rows={d.byMonth.map((r) => [r.month, r.submitted, r.fulfilled])} /></Card>
        </div>
        <Card><div className="border-b border-slate-200 px-4 py-3 text-sm font-semibold text-slate-900">Letters</div><Table head={['Letter type', 'Issued', 'Void']} rows={d.letters.byType.map((l) => [titleCase(l.letterType), l.issued, l.voided])} /><Table head={['Month', 'Issued']} rows={d.letters.byMonth.map((l) => [l.month, l.issued])} /></Card>
      </>}
    </div>
  );
}
