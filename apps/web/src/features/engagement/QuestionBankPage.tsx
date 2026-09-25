import { useState } from 'react';
import { Plus } from 'lucide-react';
import { QUESTION_TYPES, type QuestionBankDto } from '@hr/shared';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Alert } from '@/components/ui/Alert';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { Checkbox } from '@/components/ui/Checkbox';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { SearchInput } from '@/components/ui/SearchInput';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { useToast } from '@/components/ui/Toast';
import { useDebounce } from '@/hooks/useDebounce';
import { errorMessage } from '@/features/organization/shared';
import { useEngagementMutations, useQuestionBank } from './engagement.api';
import { titleCase } from './engagement-ui';

export function QuestionBankPage() {
  const [search, setSearch] = useState('');
  const [includeInactive, setInactive] = useState(false);
  const list = useQuestionBank({ search: useDebounce(search, 250), includeInactive });
  const [editing, setEditing] = useState<QuestionBankDto | null>(null);
  const [creating, setCreating] = useState(false);
  const columns: Column<QuestionBankDto>[] = [
    { key: 'text', header: 'Question', render: (q) => <div><div className="font-medium text-slate-900">{q.text}</div><div className="text-xs text-slate-400">{q.code}{q.theme && ` · ${q.theme}`}</div></div> },
    { key: 'type', header: 'Type', hideBelow: 'sm', render: (q) => titleCase(q.questionType) },
    { key: 'used', header: 'Used by', hideBelow: 'md', render: (q) => <span className="tabular-nums">{q.usedBySurveys} survey(s)</span> },
    { key: 'status', header: 'Status', render: (q) => <StatusBadge status={q.isActive ? 'Active' : 'Inactive'} tone={q.isActive ? 'success' : 'neutral'} /> },
  ];
  return (
    <>
      <Card>
        <div className="grid grid-cols-1 gap-3 border-b border-slate-200 p-4 sm:grid-cols-3">
          <SearchInput value={search} onChange={setSearch} placeholder="Search questions" />
          <Checkbox label="Include inactive" checked={includeInactive} onChange={(e) => setInactive(e.target.checked)} />
          <div className="flex justify-end"><Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> Question</Button></div>
        </div>
        {list.isError && <Alert className="m-4">Could not load the question bank.</Alert>}
        <DataTable columns={columns} rows={list.data ?? []} rowKey={(q) => q.id} loading={list.isLoading} onRowClick={setEditing} emptyTitle="No questions yet" emptyDescription="Questions are your own wording; surveys take a frozen copy of them." />
      </Card>
      {(creating || editing) && <QuestionModal q={editing} onClose={() => { setCreating(false); setEditing(null); }} />}
    </>
  );
}

function QuestionModal({ q, onClose }: { q: QuestionBankDto | null; onClose: () => void }) {
  const m = useEngagementMutations();
  const toast = useToast();
  const [form, setForm] = useState({ code: q?.code ?? '', text: q?.text ?? '', theme: q?.theme ?? '', questionType: q?.questionType ?? 'LIKERT', required: q?.defaultRequired ?? true, scaleMin: String(q?.config.scaleMin ?? ''), scaleMax: String(q?.config.scaleMax ?? ''), options: (q?.config.options ?? []).map((o) => `${o.code}=${o.label}`).join('\n'), isActive: q?.isActive ?? true });
  const [err, setErr] = useState<string | null>(null);
  const config = () => { const c: Record<string, unknown> = {}; if (form.scaleMin) c.scaleMin = Number(form.scaleMin); if (form.scaleMax) c.scaleMax = Number(form.scaleMax); if (form.questionType === 'SINGLE_CHOICE' || form.questionType === 'MULTI_CHOICE') c.options = form.options.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => { const [code, ...rest] = l.split('='); return { code: code.trim().toUpperCase(), label: rest.join('=').trim() || code.trim() }; }); return c; };
  const submit = async () => { setErr(null); try { if (q) await m.updateQuestion.mutateAsync({ id: q.id, input: { text: form.text, theme: form.theme || null, required: form.required, config: config() as never, isActive: form.isActive } }); else await m.createQuestion.mutateAsync({ code: form.code, text: form.text, theme: form.theme || null, questionType: form.questionType as never, required: form.required, config: config() as never }); toast.success('Question saved'); onClose(); } catch (e) { setErr(errorMessage(e)); } };
  const scaled = form.questionType === 'LIKERT' || form.questionType === 'SCALE';
  return (
    <Modal open onClose={onClose} title={q ? 'Edit question' : 'New question'} description="Wording is yours. Editing later never changes a survey that already used it." footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={submit} loading={m.createQuestion.isPending || m.updateQuestion.isPending}>Save</Button></>}>
      <div className="space-y-3">
        {err && <Alert>{err}</Alert>}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">{!q && <Input label="Code" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} />}<Select label="Type" options={QUESTION_TYPES.map((t) => ({ value: t, label: titleCase(t) }))} value={form.questionType} disabled={!!q} onChange={(e) => setForm({ ...form, questionType: e.target.value as never })} /><Input label="Theme" value={form.theme} onChange={(e) => setForm({ ...form, theme: e.target.value })} placeholder="e.g. Clarity" /></div>
        <Textarea label="Text" value={form.text} onChange={(e) => setForm({ ...form, text: e.target.value })} />
        {scaled && <div className="grid grid-cols-2 gap-3"><Input label="Scale min" type="number" value={form.scaleMin} onChange={(e) => setForm({ ...form, scaleMin: e.target.value })} placeholder={form.questionType === 'LIKERT' ? '1' : '1'} /><Input label="Scale max" type="number" value={form.scaleMax} onChange={(e) => setForm({ ...form, scaleMax: e.target.value })} placeholder={form.questionType === 'LIKERT' ? '5' : '10'} /></div>}
        {form.questionType === 'ENPS' && <p className="text-xs text-slate-500">eNPS is always 0–10: promoters 9–10, passives 7–8, detractors 0–6.</p>}
        {(form.questionType === 'SINGLE_CHOICE' || form.questionType === 'MULTI_CHOICE') && <Textarea label="Options (one per line, CODE=Label)" value={form.options} onChange={(e) => setForm({ ...form, options: e.target.value })} />}
        <div className="flex flex-wrap gap-4"><Checkbox label="Required by default" checked={form.required} onChange={(e) => setForm({ ...form, required: e.target.checked })} />{q && <Checkbox label="Active" checked={form.isActive} onChange={(e) => setForm({ ...form, isActive: e.target.checked })} />}</div>
      </div>
    </Modal>
  );
}
