import { useState } from 'react';
import { Copy, Plus } from 'lucide-react';
import { ANONYMITY_GROUP_SIZE, PERMISSIONS, RESPONSE_MODES, SURVEY_TYPES, type SurveyDetailDto, type SurveyDto } from '@hr/shared';
import { Card } from '@/components/ui/Card';
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
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { useToast } from '@/components/ui/Toast';
import { useAuth } from '@/hooks/useAuth';
import { errorMessage } from '@/features/organization/shared';
import { useEngagementMutations, useEngagementOptions, useQuestionBank, useSurvey, useSurveys } from './engagement.api';
import { ModeBadge, SurveyStatusBadge, titleCase } from './engagement-ui';

export function SurveysPage() {
  const { hasPermission } = useAuth();
  const manage = hasPermission(PERMISSIONS.ENGAGEMENT_MANAGE);
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const list = useSurveys({ status, page, pageSize: 20 });
  const columns: Column<SurveyDto>[] = [
    { key: 'name', header: 'Survey', render: (s) => <div><div className="font-medium text-slate-900">{s.name}</div><div className="text-xs text-slate-400">{s.code} · {titleCase(s.surveyType)}{s.organizationName && ` · ${s.organizationName}`}</div></div> },
    { key: 'mode', header: 'Mode', hideBelow: 'sm', render: (s) => <div className="flex items-center gap-1"><ModeBadge mode={s.responseMode} />{s.responseMode === 'ANONYMOUS' && <span className="text-xs text-slate-400">min {s.minimumAnonymousGroupSize}</span>}</div> },
    { key: 'q', header: 'Questions', hideBelow: 'md', render: (s) => <span className="tabular-nums">{s.questionCount}</span> },
    { key: 'rate', header: 'Participation', hideBelow: 'md', render: (s) => <span className="tabular-nums">{s.completedCount}/{s.audienceCount}{s.responseRate !== null && ` · ${s.responseRate}%`}</span> },
    { key: 'status', header: 'Status', render: (s) => <SurveyStatusBadge status={s.status} /> },
  ];
  return (
    <>
      <Card>
        <div className="grid grid-cols-1 gap-3 border-b border-slate-200 p-4 sm:grid-cols-3">
          <Select options={['DRAFT', 'OPEN', 'CLOSED', 'ARCHIVED'].map((s) => ({ value: s, label: titleCase(s) }))} placeholder="All statuses" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} />
          <div />
          {manage && <div className="flex justify-end"><Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> Survey</Button></div>}
        </div>
        {list.isError && <Alert className="m-4">Could not load surveys.</Alert>}
        <DataTable columns={columns} rows={list.data?.data ?? []} rowKey={(s) => s.id} loading={list.isLoading} onRowClick={(s) => setOpenId(s.id)} emptyTitle="No surveys" emptyDescription="Create a survey, add questions from the bank, assign an audience and open it." />
        {list.data?.meta && <Pagination {...list.data.meta} onPageChange={setPage} />}
      </Card>
      {creating && <SurveyFormModal onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); setOpenId(id); }} />}
      {openId && <SurveyModal id={openId} onClose={() => setOpenId(null)} />}
    </>
  );
}

function SurveyFormModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const m = useEngagementMutations();
  const options = useEngagementOptions();
  const [form, setForm] = useState({ code: '', name: '', description: '', organizationId: '', surveyType: 'ENGAGEMENT', responseMode: 'ANONYMOUS', minimumAnonymousGroupSize: String(ANONYMITY_GROUP_SIZE.default), periodStart: '', periodEnd: '' });
  const [err, setErr] = useState<string | null>(null);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setForm({ ...form, [k]: e.target.value });
  const submit = async () => { setErr(null); try { const s = await m.createSurvey.mutateAsync({ code: form.code, name: form.name, description: form.description || null, organizationId: form.organizationId || null, surveyType: form.surveyType as never, responseMode: form.responseMode as never, minimumAnonymousGroupSize: Number(form.minimumAnonymousGroupSize), periodStart: form.periodStart || null, periodEnd: form.periodEnd || null }); onCreated(s.id); } catch (e) { setErr(errorMessage(e)); } };
  return (
    <Modal open onClose={onClose} title="New survey" description="Choose the response mode now: it cannot change once the survey opens." footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={submit} loading={m.createSurvey.isPending} disabled={!form.code || !form.name}>Create</Button></>}>
      <div className="space-y-3">
        {err && <Alert>{err}</Alert>}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3"><Input label="Code" value={form.code} onChange={set('code')} /><div className="sm:col-span-2"><Input label="Name" value={form.name} onChange={set('name')} /></div></div>
        <Textarea label="Description" value={form.description} onChange={set('description')} />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Select label="Type" options={SURVEY_TYPES.map((t) => ({ value: t, label: titleCase(t) }))} value={form.surveyType} onChange={set('surveyType')} />
          <Select label="Response mode" options={RESPONSE_MODES.map((t) => ({ value: t, label: titleCase(t) }))} value={form.responseMode} onChange={set('responseMode')} />
          {form.responseMode === 'ANONYMOUS' && <Input label={`Minimum group size (${ANONYMITY_GROUP_SIZE.min}–${ANONYMITY_GROUP_SIZE.max})`} type="number" min={ANONYMITY_GROUP_SIZE.min} max={ANONYMITY_GROUP_SIZE.max} value={form.minimumAnonymousGroupSize} onChange={set('minimumAnonymousGroupSize')} />}
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3"><Select label="Organization" options={(options.data?.organizations ?? []).map((o) => ({ value: o.id, label: o.name }))} placeholder="All" value={form.organizationId} onChange={set('organizationId')} /><Input label="Period start" type="date" value={form.periodStart} onChange={set('periodStart')} /><Input label="Period end (informational)" type="date" value={form.periodEnd} onChange={set('periodEnd')} /></div>
        <p className="text-xs text-slate-500">{form.responseMode === 'ANONYMOUS' ? 'Anonymous: answers are stored without employee or user identifiers; groups smaller than the minimum are hidden in every report. Opening needs an audience at least that large.' : 'Identified: answers are stored with the respondent. Employees are told so before they answer.'}</p>
      </div>
    </Modal>
  );
}

function SurveyModal({ id, onClose }: { id: string; onClose: () => void }) {
  const s = useSurvey(id);
  const m = useEngagementMutations();
  const toast = useToast();
  const bank = useQuestionBank({});
  const options = useEngagementOptions();
  const [bankId, setBankId] = useState('');
  const [audience, setAudience] = useState<{ departmentIds: string[]; jobIds: string[]; organizationIds: string[] }>({ departmentIds: [], jobIds: [], organizationIds: [] });
  const [confirm, setConfirm] = useState<'open' | 'close' | 'archive' | 'delete' | null>(null);
  const [dup, setDup] = useState<{ code: string; name: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const act = async (fn: () => Promise<unknown>, ok: string) => { setErr(null); try { await fn(); toast.success(ok); } catch (e) { setErr(errorMessage(e)); toast.error(errorMessage(e)); } };
  if (s.isLoading) return <Modal open onClose={onClose} title="Survey"><LoadingBlock /></Modal>;
  if (!s.data) return <Modal open onClose={onClose} title="Survey"><Alert>Could not load this survey.</Alert></Modal>;
  const d: SurveyDetailDto = s.data;
  const editable = d.can.edit;
  const toggle = (k: keyof typeof audience, v: string) => setAudience({ ...audience, [k]: audience[k].includes(v) ? audience[k].filter((x) => x !== v) : [...audience[k], v] });
  return (
    <Modal open onClose={onClose} title={d.name} description={`${d.code} · ${titleCase(d.surveyType)} · ${titleCase(d.responseMode)}${d.responseMode === 'ANONYMOUS' ? ` · minimum group ${d.minimumAnonymousGroupSize}` : ''}`} size="lg"
      footer={<>
        {editable && <Button variant="ghost" onClick={() => setConfirm('delete')}>Delete draft</Button>}
        <Button variant="ghost" onClick={() => setDup({ code: `${d.code}-COPY`, name: `${d.name} (copy)` })}><Copy className="h-3.5 w-3.5" /> Duplicate</Button>
        {d.can.open && <Button onClick={() => setConfirm('open')}>Open survey</Button>}
        {d.can.close && <Button variant="secondary" onClick={() => setConfirm('close')}>Close survey</Button>}
        {(d.status === 'CLOSED') && <Button variant="ghost" onClick={() => setConfirm('archive')}>Archive</Button>}
        <Button variant="secondary" onClick={onClose}>Close</Button>
      </>}>
      <div className="space-y-4">
        {err && <Alert>{err}</Alert>}
        <div className="flex flex-wrap items-center gap-2 text-sm"><SurveyStatusBadge status={d.status} /><ModeBadge mode={d.responseMode} /><span className="text-slate-500">{d.questionCount} questions · audience {d.audienceCount} · completed {d.completedCount}{d.responseRate !== null && ` (${d.responseRate}%)`}</span></div>
        <section>
          <div className="mb-1 text-xs font-semibold uppercase text-slate-500">Questions {d.status !== 'DRAFT' && <span className="font-normal normal-case">(frozen)</span>}</div>
          <ol className="space-y-1 rounded-md border border-slate-200 p-3 text-sm" data-testid="survey-questions">
            {d.questions.map((q, i) => <li key={q.id} className="flex flex-wrap items-center justify-between gap-2"><span>{i + 1}. {q.text} <span className="text-xs text-slate-400">{titleCase(q.questionType)}{q.scaleMin !== null && ` ${q.scaleMin}–${q.scaleMax}`}{q.isEnpsPrimary && ' · primary eNPS'}{q.theme && ` · ${q.theme}`}{!q.required && ' · optional'}</span></span>{editable && <button type="button" className="text-xs text-red-600 underline" onClick={() => act(() => m.removeQuestion.mutateAsync({ id, qid: q.id }), 'Question removed')}>remove</button>}</li>)}
            {d.questions.length === 0 && <li className="text-slate-400">No questions yet.</li>}
          </ol>
          {editable && <div className="mt-2 flex flex-wrap items-end gap-2"><div className="min-w-[16rem] flex-1"><Select label="Add from the question bank" options={(bank.data ?? []).map((b) => ({ value: b.id, label: `${b.text} (${titleCase(b.questionType)})` }))} placeholder="Choose a question" value={bankId} onChange={(e) => setBankId(e.target.value)} /></div><Button size="sm" disabled={!bankId} onClick={() => act(async () => { await m.addQuestion.mutateAsync({ id, input: { sourceQuestionId: bankId } }); setBankId(''); }, 'Question added')}>Add</Button></div>}
        </section>
        <section>
          <div className="mb-1 text-xs font-semibold uppercase text-slate-500">Audience {d.status !== 'DRAFT' ? <span className="font-normal normal-case">(frozen at opening: {d.audienceCount} people)</span> : <span className="font-normal normal-case">({d.audienceCount} people assigned)</span>}</div>
          {editable && (
            <div className="space-y-2 rounded-md border border-slate-200 p-3 text-sm">
              <div><div className="mb-1 text-xs text-slate-500">Departments</div><div className="flex flex-wrap gap-1">{(options.data?.departments ?? []).filter((x) => !d.organizationId || x.organizationId === d.organizationId).map((x) => <button type="button" key={x.id} className={`rounded-full border px-2.5 py-0.5 text-xs ${audience.departmentIds.includes(x.id) ? 'border-brand-600 bg-brand-600 text-white' : 'border-slate-300 bg-white text-slate-700'}`} onClick={() => toggle('departmentIds', x.id)}>{x.name}</button>)}</div></div>
              <div><div className="mb-1 text-xs text-slate-500">Jobs</div><div className="flex flex-wrap gap-1">{(options.data?.jobs ?? []).map((x) => <button type="button" key={x.id} className={`rounded-full border px-2.5 py-0.5 text-xs ${audience.jobIds.includes(x.id) ? 'border-brand-600 bg-brand-600 text-white' : 'border-slate-300 bg-white text-slate-700'}`} onClick={() => toggle('jobIds', x.id)}>{x.title}</button>)}</div></div>
              <div className="flex flex-wrap items-center gap-2"><Checkbox label="Whole organization" checked={audience.organizationIds.length > 0} onChange={(e) => setAudience({ ...audience, organizationIds: e.target.checked ? (options.data?.organizations ?? []).filter((o) => !d.organizationId || o.id === d.organizationId).map((o) => o.id) : [] })} /><Button size="sm" variant="secondary" onClick={() => act(async () => { const r = await m.assignAudience.mutateAsync({ id, input: { departmentIds: audience.departmentIds.length ? audience.departmentIds : undefined, jobIds: audience.jobIds.length ? audience.jobIds : undefined, organizationIds: audience.organizationIds.length ? audience.organizationIds : undefined } }); toast.success(`${r.assigned} people assigned`); }, 'Audience assigned')} disabled={!audience.departmentIds.length && !audience.jobIds.length && !audience.organizationIds.length}>Assign audience</Button></div>
              <p className="text-xs text-slate-400">Active employees matching any criterion, snapshotted with their department, job and position when the survey opens. Nobody is added later.</p>
            </div>
          )}
        </section>
      </div>
      <ConfirmDialog open={confirm === 'open'} title="Open this survey?" message={d.responseMode === 'ANONYMOUS' ? `Questions and the audience of ${d.audienceCount} freeze now. Anonymous answers will be stored without identifiers and groups smaller than ${d.minimumAnonymousGroupSize} will be hidden. Assigned employees are notified.` : `Questions and the audience of ${d.audienceCount} freeze now. This is an identified survey: employees are told their answers carry their name.`} confirmLabel="Open" loading={m.open.isPending} onConfirm={() => { act(() => m.open.mutateAsync(id), 'Survey opened'); setConfirm(null); }} onCancel={() => setConfirm(null)} />
      <ConfirmDialog open={confirm === 'close'} title="Close this survey?" message="No more answers are accepted. Results are frozen as history; anonymous comments become readable to engagement managers if the threshold is met." confirmLabel="Close survey" loading={m.close.isPending} onConfirm={() => { act(() => m.close.mutateAsync(id), 'Survey closed'); setConfirm(null); }} onCancel={() => setConfirm(null)} />
      <ConfirmDialog open={confirm === 'archive'} title="Archive this survey?" message="The survey stays readable as history." confirmLabel="Archive" loading={m.archive.isPending} onConfirm={() => { act(() => m.archive.mutateAsync(id), 'Survey archived'); setConfirm(null); }} onCancel={() => setConfirm(null)} />
      <ConfirmDialog open={confirm === 'delete'} title="Delete this draft?" message="A draft has no answers; only its questions and audience list are removed." confirmLabel="Delete" variant="danger" loading={m.deleteSurvey.isPending} onConfirm={() => { act(async () => { await m.deleteSurvey.mutateAsync(id); onClose(); }, 'Draft deleted'); setConfirm(null); }} onCancel={() => setConfirm(null)} />
      <Modal open={!!dup} onClose={() => setDup(null)} title="Duplicate survey" description="Copies the questionnaire only — not the audience, answers or results." footer={<><Button variant="secondary" onClick={() => setDup(null)}>Cancel</Button><Button onClick={() => { if (dup) act(() => m.duplicateSurvey.mutateAsync({ id, ...dup }), 'Survey duplicated'); setDup(null); }} loading={m.duplicateSurvey.isPending}>Duplicate</Button></>}>{dup && <div className="space-y-3"><Input label="Code" value={dup.code} onChange={(e) => setDup({ ...dup, code: e.target.value })} /><Input label="Name" value={dup.name} onChange={(e) => setDup({ ...dup, name: e.target.value })} /></div>}</Modal>
    </Modal>
  );
}
