import { Link } from 'react-router-dom';
import { Card, CardHeader } from '@/components/ui/Card';
import { Alert } from '@/components/ui/Alert';
import { useMyLearning } from './learning.api';
import { LearningBadge, Progress, STEP_TYPE_LABEL } from './learning-ui';

/** The learning half of "My development": own OJT, paths, certifications and evidence, plus the plans I train. Statuses and own reflections only — a trainer's comment never reaches the trainee. */
export function MyLearningSections() {
  const q = useMyLearning();
  if (q.isError) return <Alert>Could not load your learning record.</Alert>;
  const d = q.data;
  if (!d) return null;
  return (
    <>
      {d.trainerQueue.length > 0 && (
        <Card>
          <CardHeader title="My OJT trainees" description="Active plans where HR chose you as trainer. Open a plan to record observations and the final assessment." />
          <ul className="divide-y divide-slate-200">{d.trainerQueue.map((p) => <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 p-4"><span><Link to={`/hrd/training/ojt?open=${p.id}`} className="font-medium text-brand-700 underline">{p.snapshot.employeeName}</Link><span className="block text-xs text-slate-500">{p.programName} · {p.planNumber} · started {p.startDate}</span></span><Progress pct={p.progress.pct} hint={`${p.progress.completed}/${p.progress.total}`} /></li>)}</ul>
        </Card>
      )}
      <Card>
        <CardHeader title="On-the-job training" description="Programs HR has planned for you, with a trainer who observes your work. Completing OJT is a record of practice — your competency level changes only through an assessment." />
        {d.ojt.length === 0 ? <p className="px-5 py-4 text-sm text-slate-400">No OJT plan.</p> : <ul className="divide-y divide-slate-200">{d.ojt.map((p) => <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 p-4"><span className="min-w-0"><Link to={`/hrd/training/ojt?open=${p.id}`} className="font-medium text-brand-700 underline">{p.programName}</Link><span className="block text-xs text-slate-500">{p.planNumber} · trainer {p.trainer?.name ?? 'not set'} · {p.startDate}{p.targetEndDate ? ` → ${p.targetEndDate}` : ''}</span></span><span className="flex items-center gap-3"><Progress pct={p.progress.pct} hint={`${p.progress.completed}/${p.progress.total}`} /><LearningBadge status={p.status} /></span></li>)}</ul>}
      </Card>
      <Card>
        <CardHeader title="Learning paths" description="A sequence of courses, OJT, IDP activities and certifications. Progress is read from what you have actually completed. Finishing a path is a record, not a promotion." />
        {d.paths.length === 0 ? <p className="px-5 py-4 text-sm text-slate-400">No learning path assigned.</p> : <ul className="divide-y divide-slate-200">{d.paths.map((a) => <li key={a.id} className="p-4"><div className="flex flex-wrap items-center justify-between gap-2"><span><Link to={`/hrd/training/paths?open=${a.id}`} className="font-medium text-brand-700 underline">{a.pathName}</Link>{a.targetJobTitle && <span className="block text-xs text-slate-500">towards {a.targetJobTitle}{a.targetDate ? ` · target ${a.targetDate}` : ''}</span>}</span><span className="flex items-center gap-3"><Progress pct={a.progress.pct} hint={`${a.progress.fulfilled}/${a.progress.total}`} /><LearningBadge status={a.status} /></span></div><ol className="mt-2 flex flex-wrap gap-1 text-xs">{a.steps.map((s) => <li key={s.id} className={`rounded border px-2 py-0.5 ${s.state === 'FULFILLED' ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : s.state === 'LOCKED' ? 'border-slate-200 bg-slate-50 text-slate-400' : 'border-sky-200 bg-sky-50 text-sky-800'}`}>{s.sequence}. {s.title} <span className="text-slate-400">({STEP_TYPE_LABEL[s.stepType]})</span></li>)}</ol></li>)}</ul>}
      </Card>
      <Card>
        <CardHeader title="Certifications" description="What you hold, when it was issued and when it expires. Status is worked out from the dates each time you look." />
        {d.certifications.length === 0 ? <p className="px-5 py-4 text-sm text-slate-400">No certification recorded.</p> : <ul className="divide-y divide-slate-200">{d.certifications.map((c) => <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 p-4"><span><Link to={`/hrd/training/certifications?open=${c.id}`} className="font-medium text-brand-700 underline">{c.definitionName}</Link><span className="block text-xs text-slate-500">issued {c.issuedDate} · {c.expiryDate ? `expires ${c.expiryDate}` : 'no expiry'}{c.renewedFromId ? ' · renewal' : ''}</span></span><LearningBadge status={c.status} /></li>)}</ul>}
      </Card>
      {d.evidence.length > 0 && (
        <Card>
          <CardHeader title="Evidence for competency assessment" description="Pointers from completed OJT that your assessor can read. They change no level by themselves." />
          <ul className="divide-y divide-slate-200">{d.evidence.map((e) => <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 p-4 text-sm"><span>{e.competencyName}<span className="block text-xs text-slate-500">{e.sourceLabel}{e.observedLevel ? ` · evidence expected at level ${e.observedLevel}` : ''}</span></span></li>)}</ul>
        </Card>
      )}
    </>
  );
}
