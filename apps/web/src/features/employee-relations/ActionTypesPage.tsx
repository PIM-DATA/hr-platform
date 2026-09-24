import { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import type { ActionTypeDto } from '@hr/shared';
import { Card, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Alert } from '@/components/ui/Alert';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { Checkbox } from '@/components/ui/Checkbox';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { useToast } from '@/components/ui/Toast';
import { useOrganizationOptions } from '@/features/organization/organization.api';
import { errorMessage } from '@/features/organization/shared';
import { useActionTypes, useDisciplinaryPolicies, useErMutations, useLetterTemplates } from './er.api';

/** Configuration: the action types, the per-organization policy and the letter templates. No legal text anywhere. */
export function ActionTypesPage() {
  const types = useActionTypes(true);
  const policies = useDisciplinaryPolicies();
  const templates = useLetterTemplates();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<ActionTypeDto | null>(null);
  const [policyOpen, setPolicyOpen] = useState(false);
  const [templateOpen, setTemplateOpen] = useState(false);

  const columns: Column<ActionTypeDto>[] = [
    { key: 'name', header: 'Action type', render: (t) => <div><div className="font-medium text-slate-900">{t.name}</div><div className="text-xs text-slate-400">{t.code}</div></div> },
    { key: 'letter', header: 'Letter', hideBelow: 'sm', render: (t) => (t.requiresWarningLetter ? 'Required' : <span className="text-slate-400">No</span>) },
    { key: 'ack', header: 'Acknowledgement', hideBelow: 'md', render: (t) => (t.requiresAcknowledgement ? 'Required' : <span className="text-slate-400">No</span>) },
    { key: 'validity', header: 'Default validity', className: 'text-right', render: (t) => (t.defaultValidityDays ? `${t.defaultValidityDays} days` : <span className="text-slate-400">No end date</span>) },
    { key: 'status', header: 'Status', render: (t) => <StatusBadge status={t.isActive ? 'Active' : 'Inactive'} tone={t.isActive ? 'success' : 'neutral'} /> },
  ];

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex items-center justify-between border-b border-slate-200 p-4">
          <p className="text-xs text-slate-500">The order is for display. The system never moves from one action to the next on its own.</p>
          <Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> Action type</Button>
        </div>
        {types.isError && <Alert className="m-4">Could not load action types.</Alert>}
        <DataTable columns={columns} rows={types.data ?? []} rowKey={(t) => t.id} loading={types.isLoading} onRowClick={(t) => setEditing(t)} emptyTitle="No action types" emptyDescription="Define what can be done — the codes and names are yours." />
      </Card>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Approval policy" description="Which workflow approves a proposal, per organization, and how long an employee is given to acknowledge." />
          <ul className="divide-y divide-slate-100 px-5 py-2 text-sm">
            {(policies.data ?? []).length === 0 && <li className="py-2 text-slate-400">No policy yet — nothing can be submitted until one exists.</li>}
            {(policies.data ?? []).map((p) => <li key={p.id} className="flex justify-between py-2"><span className="text-slate-900">{p.organization.name} · {p.name}</span><span className="text-xs text-slate-500">{p.workflowDefinitionCode}{p.defaultAcknowledgementDueDays && ` · ${p.defaultAcknowledgementDueDays} days to acknowledge`}</span></li>)}
          </ul>
          <div className="border-t border-slate-200 px-5 py-3"><Button variant="secondary" size="sm" onClick={() => setPolicyOpen(true)}>Set policy</Button></div>
        </Card>
        <Card>
          <CardHeader title="Letter templates" description="Plain text with allow-listed placeholders. Nothing in a template can run." />
          <ul className="divide-y divide-slate-100 px-5 py-2 text-sm">
            {(templates.data ?? []).length === 0 && <li className="py-2 text-slate-400">No template — letters can still be drafted by hand.</li>}
            {(templates.data ?? []).map((t) => <li key={t.id} className="flex justify-between py-2"><span className="text-slate-900">{t.name}</span><span className="text-xs text-slate-500">{t.code}{!t.isActive && ' · inactive'}</span></li>)}
          </ul>
          <div className="border-t border-slate-200 px-5 py-3"><Button variant="secondary" size="sm" onClick={() => setTemplateOpen(true)}>Add or replace template</Button></div>
        </Card>
      </div>
      <ActionTypeModal open={creating} type={null} onClose={() => setCreating(false)} />
      <ActionTypeModal open={!!editing} type={editing} onClose={() => setEditing(null)} />
      <PolicyModal open={policyOpen} onClose={() => setPolicyOpen(false)} />
      <TemplateModal open={templateOpen} onClose={() => setTemplateOpen(false)} />
    </div>
  );
}

function ActionTypeModal({ open, type, onClose }: { open: boolean; type: ActionTypeDto | null; onClose: () => void }) {
  const m = useErMutations();
  const toast = useToast();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [severityOrder, setOrder] = useState('0');
  const [requiresWarningLetter, setLetter] = useState(true);
  const [requiresAcknowledgement, setAck] = useState(true);
  const [defaultValidityDays, setValidity] = useState('');
  const [isActive, setIsActive] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setErr(null); setCode(type?.code ?? ''); setName(type?.name ?? ''); setDescription(type?.description ?? ''); setOrder(String(type?.severityOrder ?? 0));
    setLetter(type?.requiresWarningLetter ?? true); setAck(type?.requiresAcknowledgement ?? true); setValidity(type?.defaultValidityDays ? String(type.defaultValidityDays) : ''); setIsActive(type?.isActive ?? true);
  }, [open, type]);

  const submit = async () => {
    setErr(null);
    try {
      const common = { name, description: description || null, severityOrder: Number(severityOrder), requiresWarningLetter, requiresAcknowledgement, defaultValidityDays: defaultValidityDays ? Number(defaultValidityDays) : null };
      if (type) { await m.updateActionType.mutateAsync({ id: type.id, input: { ...common, isActive } }); toast.success('Action type updated'); }
      else { await m.createActionType.mutateAsync({ code, ...common }); toast.success('Action type added'); }
      onClose();
    } catch (e) { setErr(errorMessage(e)); }
  };

  return (
    <Modal open={open} onClose={onClose} title={type ? type.name : 'Add an action type'} description="Renaming a type never changes an action already issued under the old name." footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={submit} loading={m.createActionType.isPending || m.updateActionType.isPending} disabled={!name || (!type && !code)}>{type ? 'Save' : 'Add'}</Button></>}>
      <div className="space-y-3">
        {err && <Alert>{err}</Alert>}
        <div className="grid grid-cols-2 gap-3">
          <Input label="Code" required value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} disabled={!!type} placeholder="WRITTEN_WARNING" />
          <Input label="Name" required value={name} onChange={(e) => setName(e.target.value)} placeholder="Written warning" />
        </div>
        <Textarea label="Description" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
        <div className="grid grid-cols-2 gap-3">
          <Input label="Display order" inputMode="numeric" value={severityOrder} onChange={(e) => setOrder(e.target.value)} />
          <Input label="Default validity (days)" inputMode="numeric" value={defaultValidityDays} onChange={(e) => setValidity(e.target.value)} hint="Blank means no end date. HR can override per proposal." />
        </div>
        <Checkbox label="Produces a warning letter" checked={requiresWarningLetter} onChange={(e) => setLetter(e.target.checked)} />
        <Checkbox label="Employee acknowledges receipt" checked={requiresAcknowledgement} onChange={(e) => setAck(e.target.checked)} />
        {type && <Select label="Status" options={[{ value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' }]} value={isActive ? 'active' : 'inactive'} onChange={(e) => setIsActive(e.target.value === 'active')} />}
      </div>
    </Modal>
  );
}

function PolicyModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const m = useErMutations();
  const toast = useToast();
  const orgs = useOrganizationOptions();
  const [organizationId, setOrg] = useState('');
  const [name, setName] = useState('Standard');
  const [workflowDefinitionCode, setCode] = useState('');
  const [days, setDays] = useState('');
  const [effectiveFrom, setFrom] = useState('');
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (open) { setErr(null); setOrg(''); setCode(''); setDays(''); setFrom(''); } }, [open]);
  const submit = async () => {
    setErr(null);
    try { await m.upsertPolicy.mutateAsync({ organizationId, name, workflowDefinitionCode, defaultAcknowledgementDueDays: days ? Number(days) : null, effectiveFrom }); toast.success('Policy saved'); onClose(); } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <Modal open={open} onClose={onClose} title="Approval policy" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={submit} loading={m.upsertPolicy.isPending} disabled={!organizationId || !name || !workflowDefinitionCode || !effectiveFrom}>Save</Button></>}>
      <div className="space-y-3">
        {err && <Alert>{err}</Alert>}
        <Select label="Organization" required options={(orgs.data?.data ?? []).map((o) => ({ value: o.id, label: o.name }))} placeholder="Choose" value={organizationId} onChange={(e) => setOrg(e.target.value)} />
        <Input label="Name" required value={name} onChange={(e) => setName(e.target.value)} />
        <Input label="Workflow definition code" required value={workflowDefinitionCode} onChange={(e) => setCode(e.target.value.toUpperCase())} hint="An active workflow for module employee_relations." />
        <div className="grid grid-cols-2 gap-3">
          <Input label="Days to acknowledge" inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} hint="Display and reporting only; nothing is sent." />
          <Input label="Effective from" required type="date" value={effectiveFrom} onChange={(e) => setFrom(e.target.value)} />
        </div>
      </div>
    </Modal>
  );
}

function TemplateModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const m = useErMutations();
  const toast = useToast();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [subjectTemplate, setSubject] = useState('{{actionName}} — {{employeeName}}');
  const [bodyTemplate, setBody] = useState('Dear {{employeeName}},\n\nThis letter concerns the incident of {{incidentDate}}.\n\n');
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (open) { setErr(null); setCode(''); setName(''); } }, [open]);
  const submit = async () => {
    setErr(null);
    try { await m.upsertTemplate.mutateAsync({ code, name, subjectTemplate, bodyTemplate, isActive: true }); toast.success('Template saved'); onClose(); } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <Modal open={open} onClose={onClose} title="Letter template" description="Placeholders: employeeName, employeeCode, incidentDate, actionName, department, position, organization, issuedDate, validUntil — written as {{name}}. Anything else is left as typed." size="lg" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={submit} loading={m.upsertTemplate.isPending} disabled={!code || !name || !subjectTemplate || !bodyTemplate}>Save</Button></>}>
      <div className="space-y-3">
        {err && <Alert>{err}</Alert>}
        <div className="grid grid-cols-2 gap-3"><Input label="Code" required value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="STD" /><Input label="Name" required value={name} onChange={(e) => setName(e.target.value)} /></div>
        <Input label="Subject" required value={subjectTemplate} onChange={(e) => setSubject(e.target.value)} />
        <Textarea label="Body" required rows={10} value={bodyTemplate} onChange={(e) => setBody(e.target.value)} />
      </div>
    </Modal>
  );
}
