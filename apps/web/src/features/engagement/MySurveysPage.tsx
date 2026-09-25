import { useState } from 'react';
import { CheckCircle2, ShieldCheck, UserCheck } from 'lucide-react';
import type { MySurveyDto, SurveyQuestionDto } from '@hr/shared';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Alert';
import { LoadingBlock } from '@/components/ui/Spinner';
import { EmptyState } from '@/components/ui/EmptyState';
import { useToast } from '@/components/ui/Toast';
import { errorMessage } from '@/features/organization/shared';
import { useEngagementMutations, useMySurveys, useSurveyForm } from './engagement.api';
import { ModeBadge, SurveyStatusBadge } from './engagement-ui';

/** Open and completed surveys for the signed-in employee, and the form. The draft lives in this component only. */
export function MySurveysPage() {
  const list = useMySurveys();
  const [openId, setOpenId] = useState<string | null>(null);
  if (openId) return <SurveyForm id={openId} onDone={() => setOpenId(null)} />;
  const open = (list.data ?? []).filter((s) => s.status === 'OPEN' && !s.completed);
  const done = (list.data ?? []).filter((s) => s.completed || s.status !== 'OPEN');
  const row = (s: MySurveyDto, action?: boolean) => (
    <li key={s.surveyId} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
      <div><div className="font-medium text-slate-900">{s.name}</div><div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-slate-500"><ModeBadge mode={s.responseMode} /><SurveyStatusBadge status={s.status} />{s.questionCount} questions{s.periodEnd && ` · until ${s.periodEnd}`}{s.completed && <span className="inline-flex items-center gap-1 text-emerald-700"><CheckCircle2 className="h-3.5 w-3.5" /> answered</span>}</div></div>
      {action && <Button size="sm" onClick={() => setOpenId(s.surveyId)}>Answer</Button>}
    </li>
  );
  return (
    <div className="space-y-4">
      <Card><div className="border-b border-slate-200 px-4 py-3 text-sm font-semibold text-slate-900">Open for you</div>{list.isLoading && <LoadingBlock />}{list.isError && <Alert className="m-4">Could not load surveys.</Alert>}{list.data && open.length === 0 && <EmptyState title="No open surveys" description="You will be notified when a survey is opened for you." />}<ul className="divide-y divide-slate-100 text-sm">{open.map((s) => row(s, true))}</ul></Card>
      <Card><div className="border-b border-slate-200 px-4 py-3 text-sm font-semibold text-slate-900">Completed and closed</div>{list.data && done.length === 0 && <p className="px-4 py-4 text-sm text-slate-400">Nothing yet.</p>}<ul className="divide-y divide-slate-100 text-sm">{done.map((s) => row(s))}</ul></Card>
    </div>
  );
}

function SurveyForm({ id, onDone }: { id: string; onDone: () => void }) {
  const form = useSurveyForm(id);
  const m = useEngagementMutations();
  const toast = useToast();
  const [values, setValues] = useState<Record<string, { numericValue?: number; booleanValue?: boolean; textValue?: string; choiceValues?: string[] }>>({});
  const [err, setErr] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const set = (qid: string, v: (typeof values)[string]) => setValues((prev) => ({ ...prev, [qid]: { ...prev[qid], ...v } }));
  const submit = async () => {
    setErr(null); setFieldErrors({});
    try {
      await m.submit.mutateAsync({ id, input: { answers: (form.data?.questions ?? []).map((q) => ({ questionId: q.id, ...values[q.id] })) } });
      toast.success('Thank you — your answers were submitted'); onDone();
    } catch (e) {
      const details = (e as { details?: { field?: string; message: string }[] }).details;
      if (details?.length) setFieldErrors(Object.fromEntries(details.map((d) => [d.field ?? '', d.message])));
      setErr(errorMessage(e));
    }
  };
  if (form.isLoading) return <LoadingBlock />;
  if (form.isError || !form.data) return <Alert>Could not load this survey.</Alert>;
  const s = form.data.survey;
  const anonymous = s.responseMode === 'ANONYMOUS';
  return (
    <Card>
      <div className="border-b border-slate-200 p-4">
        <div className="flex flex-wrap items-center gap-2"><h2 className="text-base font-semibold text-slate-900">{s.name}</h2><ModeBadge mode={s.responseMode} /></div>
        {s.description && <p className="mt-1 text-sm text-slate-600">{s.description}</p>}
        <div className={`mt-3 flex items-start gap-2 rounded-md border p-3 text-sm ${anonymous ? 'border-emerald-200 bg-emerald-50 text-emerald-900' : 'border-amber-200 bg-amber-50 text-amber-900'}`} data-testid="survey-notice">{anonymous ? <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" /> : <UserCheck className="mt-0.5 h-4 w-4 shrink-0" />}<span>{form.data.notice}</span></div>
      </div>
      {s.completed ? <p className="p-4 text-sm text-slate-600">You have already answered this survey.</p> : (
        <form className="space-y-5 p-4" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          {err && <Alert>{err}</Alert>}
          {form.data.questions.map((q, i) => <QuestionField key={q.id} index={i + 1} q={q} value={values[q.id] ?? {}} onChange={(v) => set(q.id, v)} error={fieldErrors[q.id]} />)}
          <div className="flex flex-wrap justify-end gap-2"><Button variant="secondary" type="button" onClick={onDone}>Back</Button><Button type="submit" loading={m.submit.isPending}>Submit answers</Button></div>
          <p className="text-xs text-slate-400">Answers are sent once, when you submit. Nothing is saved before that.</p>
        </form>
      )}
    </Card>
  );
}

function QuestionField({ index, q, value, onChange, error }: { index: number; q: SurveyQuestionDto; value: { numericValue?: number; booleanValue?: boolean; textValue?: string; choiceValues?: string[] }; onChange: (v: { numericValue?: number; booleanValue?: boolean; textValue?: string; choiceValues?: string[] }) => void; error?: string }) {
  const scale = q.questionType === 'LIKERT' || q.questionType === 'SCALE' || q.questionType === 'ENPS';
  const points = scale ? Array.from({ length: (q.scaleMax ?? 5) - (q.scaleMin ?? 1) + 1 }, (_, i) => (q.scaleMin ?? 1) + i) : [];
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium text-slate-900">{index}. {q.text}{q.required && <span className="text-red-600"> *</span>}{q.theme && <span className="ml-2 text-xs font-normal text-slate-400">{q.theme}</span>}</legend>
      {scale && (
        <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={q.text}>
          {points.map((p) => <button type="button" key={p} role="radio" aria-checked={value.numericValue === p} className={`min-w-[2.5rem] rounded-md border px-2 py-1.5 text-sm ${value.numericValue === p ? 'border-brand-600 bg-brand-600 text-white' : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'}`} onClick={() => onChange({ numericValue: p })} title={q.scaleLabels?.[String(p)] ?? undefined}>{p}</button>)}
          {q.scaleLabels && <div className="basis-full text-xs text-slate-400">{q.scaleMin}: {q.scaleLabels[String(q.scaleMin)] ?? '—'} · {q.scaleMax}: {q.scaleLabels[String(q.scaleMax)] ?? '—'}</div>}
        </div>
      )}
      {q.questionType === 'YES_NO' && <div className="flex gap-2">{[true, false].map((b) => <button type="button" key={String(b)} className={`rounded-md border px-3 py-1.5 text-sm ${value.booleanValue === b ? 'border-brand-600 bg-brand-600 text-white' : 'border-slate-300 bg-white text-slate-700'}`} onClick={() => onChange({ booleanValue: b })}>{b ? 'Yes' : 'No'}</button>)}</div>}
      {(q.questionType === 'SINGLE_CHOICE' || q.questionType === 'MULTI_CHOICE') && (
        <div className="space-y-1">{q.options.map((o) => { const sel = (value.choiceValues ?? []).includes(o.code); return <label key={o.code} className="flex items-center gap-2 text-sm"><input type={q.questionType === 'SINGLE_CHOICE' ? 'radio' : 'checkbox'} checked={sel} onChange={() => onChange({ choiceValues: q.questionType === 'SINGLE_CHOICE' ? [o.code] : sel ? (value.choiceValues ?? []).filter((c) => c !== o.code) : [...(value.choiceValues ?? []), o.code] })} />{o.label}</label>; })}</div>
      )}
      {q.questionType === 'TEXT' && <textarea rows={3} maxLength={q.maxLength ?? 2000} value={value.textValue ?? ''} onChange={(e) => onChange({ textValue: e.target.value })} className="block w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500" aria-label={q.text} />}
      {error && <p className="text-xs text-red-600">{error}</p>}
    </fieldset>
  );
}
