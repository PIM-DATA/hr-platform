import { useState } from 'react';
import { Link } from 'react-router-dom';
import { BookOpen } from 'lucide-react';
import type { EnrollmentDto, IdpDetailDto, IdpItemDto } from '@hr/shared';
import { Card, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Alert';
import { Input } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/Textarea';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingBlock } from '@/components/ui/Spinner';
import { errorMessage } from '@/features/organization/shared';
import { useIdp, useMyDevelopment, useTrainingMutations } from './training.api';
import { MyLearningSections } from '@/features/learning/MyLearningSections';
import { EnrollmentStatusBadge, IdpStatusBadge, ItemStatusBadge, NeedStatusBadge, ProgressBar, developmentLabel, formatDuration, formatSessionTime } from './training-ui';

/**
 * What an employee sees about their own development: the needs raised for them, the training they are booked on,
 * what they have done, and their plan.
 *
 * The competency numbers here are the competency module's, linked rather than recalculated. And a completed course
 * shows as history, not as a new level — that distinction is the module boundary made visible.
 */
export function MyDevelopmentPage() {
  const me = useMyDevelopment();
  const [openIdp, setOpenIdp] = useState<string | null>(null);
  if (me.isLoading) return <LoadingBlock />;
  if (me.isError) return <Alert>Could not load your development record.</Alert>;
  const d = me.data!;
  const currentIdp = openIdp ?? d.idps.find((p) => p.status === 'ACTIVE')?.id ?? d.idps[0]?.id ?? null;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Figure label="Open development needs" value={d.summary.openNeeds} tone={d.summary.openNeeds > 0 ? 'warning' : undefined} />
        <Figure label="Upcoming training" value={d.summary.upcomingSessions} />
        <Figure label="Courses completed" value={d.summary.completedCourses} />
        <Figure label="Training hours" value={d.summary.trainingHours} />
      </div>

      {d.idps.length > 0 && (
        <>
          {d.idps.length > 1 && (
            <div className="flex flex-wrap gap-2">
              {d.idps.map((p) => (
                <button key={p.id} onClick={() => setOpenIdp(p.id)} className={`rounded-md border px-3 py-1.5 text-sm ${p.id === currentIdp ? 'border-brand-500 bg-brand-50 text-brand-800' : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'}`}>{p.title}</button>
              ))}
            </div>
          )}
          <IdpCard idpId={currentIdp} />
        </>
      )}

      <Card>
        <CardHeader title="Upcoming training" description="Places HR has booked for you." />
        {d.upcoming.length === 0 ? <p className="px-5 py-4 text-sm text-slate-400">Nothing booked.</p> : <ul className="divide-y divide-slate-200">{d.upcoming.map((e) => <EnrollmentRow key={e.id} enrollment={e} />)}</ul>}
      </Card>

      <Card>
        <CardHeader title="Development needs" description="Raised from your competency gaps, or by HR. A need is fulfilled when the planned development is done — your competency level changes only through an assessment." />
        {d.needs.length === 0 ? (
          <EmptyState
            icon={<BookOpen className="h-6 w-6" />}
            title="No open needs"
            description="Nothing has been raised for you."
            action={<Link className="text-sm text-brand-700 underline" to="/hrd/competency">See where you stand on your competency profile</Link>}
          />
        ) : (
          <ul className="divide-y divide-slate-200">
            {d.needs.map((need) => (
              <li key={need.id} className="flex flex-wrap items-center justify-between gap-2 p-4">
                <span className="min-w-0">
                  <span className="block font-medium text-slate-900">{need.title}</span>
                  <span className="block text-xs text-slate-500">
                    {need.gapSnapshot ? `Assessed ${need.gapSnapshot.currentLevel} of ${need.gapSnapshot.requiredLevel} required when raised` : 'Raised by HR'}
                    {need.enrollments.length > 0 && ` · ${need.enrollments[0].courseTitle}`}
                  </span>
                </span>
                <NeedStatusBadge status={need.status} />
              </li>
            ))}
          </ul>
        )}
      </Card>

      <MyLearningSections />

      <Card>
        <CardHeader title="Training history" />
        {d.history.length === 0 ? <p className="px-5 py-4 text-sm text-slate-400">No training recorded yet.</p> : <ul className="divide-y divide-slate-200">{d.history.map((e) => <EnrollmentRow key={e.id} enrollment={e} />)}</ul>}
      </Card>
    </div>
  );
}

const Figure = ({ label, value, tone }: { label: string; value: number; tone?: 'warning' }) => (
  <div className={`rounded-lg border p-3 ${tone === 'warning' ? 'border-amber-200 bg-amber-50' : 'border-slate-200 bg-white'}`}>
    <div className="text-xs text-slate-500">{label}</div>
    <div className="mt-0.5 text-xl font-semibold tabular-nums text-slate-900">{value}</div>
  </div>
);

export function EnrollmentRow({ enrollment: e }: { enrollment: EnrollmentDto }) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 p-4">
      <span className="min-w-0">
        <span className="block font-medium text-slate-900">{e.course.title}</span>
        <span className="block text-xs text-slate-500">
          {formatSessionTime(e.session.startAt, e.session.timezone)}{e.session.location && ` · ${e.session.location}`} · {formatDuration(e.course.durationMinutes)}
          {e.score && ` · score ${e.score}`}
        </span>
      </span>
      <EnrollmentStatusBadge status={e.status} />
    </li>
  );
}

function IdpCard({ idpId }: { idpId: string | null }) {
  const idp = useIdp(idpId);
  const p = idp.data;
  if (idp.isLoading) return <LoadingBlock />;
  if (!p) return null;
  return (
    <Card>
      <CardHeader title={p.title} description={`${p.periodStart} → ${p.periodEnd}${p.manager.name ? ` · manager ${p.manager.name}` : ''}`} />
      <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 p-4">
        <IdpStatusBadge status={p.status} />
        <ProgressBar percent={p.progressPercent} />
        <span className="text-xs text-slate-500">{p.completedItemCount} of {p.itemCount} activities complete</span>
      </div>
      <ul className="divide-y divide-slate-200">
        {p.items.map((item) => <IdpItemRow key={item.id} idp={p} item={item} />)}
      </ul>
    </Card>
  );
}

function IdpItemRow({ idp, item }: { idp: IdpDetailDto; item: IdpItemDto }) {
  const m = useTrainingMutations();
  const [percent, setPercent] = useState(String(item.progressPercent));
  const [comment, setComment] = useState(item.employeeComment ?? '');
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const editable = idp.status === 'ACTIVE' && !['COMPLETED', 'CANCELLED'].includes(item.status) && item.developmentType !== 'TRAINING';

  const save = async () => {
    setErr(null); setSaved(false);
    try {
      await m.updateProgress.mutateAsync({ id: item.id, input: { progressPercent: Number(percent), employeeComment: comment || null } });
      setSaved(true);
    } catch (e) { setErr(errorMessage(e)); }
  };

  return (
    <li className="p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <span className="min-w-0">
          <span className="block font-medium text-slate-900">{item.title}</span>
          <span className="block text-xs text-slate-500">
            {developmentLabel(item.developmentType)}{item.competency && ` · ${item.competency.name}`}{item.linkedCourse && ` · ${item.linkedCourse.title}`}{item.targetDate && ` · by ${item.targetDate}`}
          </span>
        </span>
        <span className="flex items-center gap-3"><ProgressBar percent={item.status === 'COMPLETED' ? 100 : item.progressPercent} /><ItemStatusBadge status={item.status} /></span>
      </div>
      {item.managerComment && <p className="mt-2 rounded-md bg-slate-50 p-2 text-xs text-slate-600">Manager: {item.managerComment}</p>}
      {err && <Alert className="mt-2">{err}</Alert>}
      {editable ? (
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Input label="Progress %" inputMode="numeric" value={percent} onChange={(e) => setPercent(e.target.value)} />
          <div className="sm:col-span-2"><Textarea label="Your note" rows={2} value={comment} onChange={(e) => setComment(e.target.value)} /></div>
          <div className="flex items-center gap-2 sm:col-span-3">
            <Button variant="secondary" size="sm" onClick={save} loading={m.updateProgress.isPending}>Save</Button>
            {saved && <span className="text-xs text-emerald-700">Saved</span>}
          </div>
        </div>
      ) : item.developmentType === 'TRAINING' && item.status !== 'COMPLETED' ? (
        <p className="mt-2 text-xs text-slate-500">This activity completes when the training it is booked against is recorded as complete.</p>
      ) : null}
    </li>
  );
}
