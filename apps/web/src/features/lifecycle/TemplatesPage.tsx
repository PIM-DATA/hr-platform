import { useState } from 'react';
import { Plus } from 'lucide-react';
import { LIFECYCLE_TASK_CATEGORIES, TASK_ASSIGNEE_TYPES, type LifecycleTemplateDto, type TemplateTaskInput } from '@hr/shared';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Alert } from '@/components/ui/Alert';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { Checkbox } from '@/components/ui/Checkbox';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { useToast } from '@/components/ui/Toast';
import { errorMessage } from '@/features/organization/shared';
import { useLifecycleMutations, useTemplates } from './lifecycle.api';
import { titleCase } from './lifecycle-ui';

export function TemplatesPage() {
  const [type, setType] = useState('');
  const list = useTemplates({ type, includeInactive: true });
  const [editing, setEditing] = useState<LifecycleTemplateDto | null>(null);
  const [creating, setCreating] = useState(false);
  const columns: Column<LifecycleTemplateDto>[] = [
    { key: 'n', header: 'Template', render: (t) => <div><div className="font-medium text-slate-900">{t.name}</div><div className="text-xs text-slate-400">{t.code}{t.organizationName && ` · ${t.organizationName}`}</div></div> },
    { key: 't', header: 'Type', render: (t) => titleCase(t.type) },
    { key: 'c', header: 'Tasks', hideBelow: 'sm', render: (t) => <span className="tabular-nums">{t.taskCount}</span> },
    { key: 's', header: 'Status', render: (t) => <StatusBadge status={t.isActive ? 'Active' : 'Inactive'} tone={t.isActive ? 'success' : 'neutral'} /> },
  ];
  return (
    <>
      <Card>
        <div className="grid grid-cols-1 gap-3 border-b border-slate-200 p-4 sm:grid-cols-3"><Select options={[{ value: 'ONBOARDING', label: 'Onboarding' }, { value: 'OFFBOARDING', label: 'Offboarding' }]} placeholder="All types" value={type} onChange={(e) => setType(e.target.value)} /><div /><div className="flex justify-end"><Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> Template</Button></div></div>
        {list.isError && <Alert className="m-4">Could not load templates.</Alert>}
        <DataTable columns={columns} rows={list.data ?? []} rowKey={(t) => t.id} loading={list.isLoading} onRowClick={setEditing} emptyTitle="No templates" emptyDescription="A template is a checklist starting point; plans copy it, so later edits never change existing plans." />
      </Card>
      {(creating || editing) && <TemplateModal t={editing} onClose={() => { setCreating(false); setEditing(null); }} />}
    </>
  );
}

type Row = TemplateTaskInput & { key: number };
function TemplateModal({ t, onClose }: { t: LifecycleTemplateDto | null; onClose: () => void }) {
  const m = useLifecycleMutations();
  const toast = useToast();
  const [form, setForm] = useState({ code: t?.code ?? '', name: t?.name ?? '', description: t?.description ?? '', type: t?.type ?? 'ONBOARDING', isActive: t?.isActive ?? true });
  const [rows, setRows] = useState<Row[]>((t?.tasks ?? []).map((x, i) => ({ key: i, title: x.title, description: x.description, category: x.category, assigneeType: x.assigneeType, specificUserId: x.specificUserId, dueOffsetDays: x.dueOffsetDays, relativeTo: x.relativeTo, required: x.required, sortOrder: x.sortOrder, requiresDocument: x.requiresDocument })));
  const [err, setErr] = useState<string | null>(null);
  const relatives = form.type === 'ONBOARDING' ? ['START_DATE', 'HIRE_DATE'] : ['LAST_WORKING_DATE', 'CASE_START'];
  const add = () => setRows([...rows, { key: Date.now(), title: '', description: null, category: form.type === 'ONBOARDING' ? 'DAY_1' : 'HANDOVER', assigneeType: 'HR', dueOffsetDays: 0, relativeTo: relatives[0] as never, required: true, sortOrder: rows.length, requiresDocument: false }]);
  const set = (k: number, patch: Partial<Row>) => setRows(rows.map((r) => (r.key === k ? { ...r, ...patch } : r)));
  const submit = async () => {
    setErr(null);
    const tasks = rows.filter((r) => r.title.trim()).map(({ key: _k, ...r }, i) => ({ ...r, sortOrder: i, description: r.description || null }));
    try { if (t) await m.updateTemplate.mutateAsync({ id: t.id, input: { name: form.name, description: form.description || null, isActive: form.isActive, tasks } }); else await m.createTemplate.mutateAsync({ code: form.code, name: form.name, description: form.description || null, type: form.type as never, tasks }); toast.success('Template saved'); onClose(); } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <Modal open onClose={onClose} title={t ? `Edit ${t.name}` : 'New template'} description="Offsets are calendar days relative to the chosen date; negative values fall before it. Plans copy the tasks when they are created." size="lg" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={submit} loading={m.createTemplate.isPending || m.updateTemplate.isPending} disabled={!form.name || (!t && !form.code)}>Save</Button></>}>
      <div className="space-y-3">
        {err && <Alert>{err}</Alert>}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">{!t && <Input label="Code" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} />}<Input label="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /><Select label="Type" options={[{ value: 'ONBOARDING', label: 'Onboarding' }, { value: 'OFFBOARDING', label: 'Offboarding' }]} value={form.type} disabled={!!t} onChange={(e) => setForm({ ...form, type: e.target.value as never })} /></div>
        <Textarea label="Description" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        {t && <Checkbox label="Active" checked={form.isActive} onChange={(e) => setForm({ ...form, isActive: e.target.checked })} />}
        <div className="flex items-center justify-between"><div className="text-xs font-semibold uppercase text-slate-500">Tasks</div><Button size="sm" variant="ghost" onClick={add}><Plus className="h-3.5 w-3.5" /> Task</Button></div>
        <div className="space-y-2" data-testid="template-tasks">
          {rows.map((r) => (
            <div key={r.key} className="grid grid-cols-2 gap-2 rounded-md border border-slate-200 p-2 sm:grid-cols-6">
              <div className="col-span-2"><Input label="Title" value={r.title} onChange={(e) => set(r.key, { title: e.target.value })} /></div>
              <Select label="Category" options={LIFECYCLE_TASK_CATEGORIES.map((c) => ({ value: c, label: titleCase(c) }))} value={r.category} onChange={(e) => set(r.key, { category: e.target.value })} />
              <Select label="Assignee" options={TASK_ASSIGNEE_TYPES.filter((a) => a !== 'SPECIFIC_USER').map((a) => ({ value: a, label: titleCase(a) }))} value={r.assigneeType} onChange={(e) => set(r.key, { assigneeType: e.target.value as never })} />
              <Input label="Offset (days)" type="number" value={String(r.dueOffsetDays)} onChange={(e) => set(r.key, { dueOffsetDays: Number(e.target.value) })} />
              <Select label="Relative to" options={relatives.map((x) => ({ value: x, label: titleCase(x) }))} value={r.relativeTo} onChange={(e) => set(r.key, { relativeTo: e.target.value as never })} />
              <div className="col-span-2 flex flex-wrap gap-4 sm:col-span-6"><Checkbox label="Required" checked={r.required ?? true} onChange={(e) => set(r.key, { required: e.target.checked })} /><Checkbox label="Needs a document" checked={r.requiresDocument ?? false} onChange={(e) => set(r.key, { requiresDocument: e.target.checked })} /><button type="button" className="text-xs text-red-600 underline" onClick={() => setRows(rows.filter((x) => x.key !== r.key))}>remove</button></div>
            </div>
          ))}
          {rows.length === 0 && <p className="text-sm text-slate-400">No tasks yet.</p>}
        </div>
      </div>
    </Modal>
  );
}
