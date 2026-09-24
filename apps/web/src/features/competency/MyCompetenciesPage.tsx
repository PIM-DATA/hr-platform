import { useState } from 'react';
import { GraduationCap } from 'lucide-react';
import type { AssessmentDetailDto, AssessmentItemDto, SkillProfileEntryDto } from '@hr/shared';
import { Card, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Alert';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingBlock } from '@/components/ui/Spinner';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { useToast } from '@/components/ui/Toast';
import { errorMessage } from '@/features/organization/shared';
import { useAssessment, useAssessments, useCompetencyMutations, useMySkillProfile } from './competency.api';
import { AssessmentStatusBadge, GapBadge, formatLevel } from './competency-ui';

/**
 * What an employee sees: where they stand against their current job, and — when a cycle is open — the self
 * assessment they owe.
 *
 * The two are deliberately separate. The profile answers "where am I today?" against today's requirements; an
 * assessment answers "how did that round come out?" against the requirements as they stood then.
 */
export function MyCompetenciesPage() {
  const profile = useMySkillProfile();
  const assessments = useAssessments({ view: 'mine', pageSize: 20 });
  const [openId, setOpenId] = useState<string | null>(null);
  const rows = assessments.data?.data ?? [];
  const openAssessment = rows.find((a) => a.status === 'SELF_REVIEW') ?? null;
  const current = openId ?? openAssessment?.id ?? rows[0]?.id ?? null;

  if (profile.isLoading) return <LoadingBlock />;
  if (profile.isError) return <Alert>Could not load your competency profile.</Alert>;
  const p = profile.data;

  return (
    <div className="space-y-4">
      {p && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Figure label="Required by your job" value={p.summary.required} />
            <Figure label="Assessed" value={p.summary.assessed} />
            <Figure label="Below requirement" value={p.summary.withGap} tone={p.summary.withGap > 0 ? 'warning' : undefined} />
            <Figure label="Not assessed yet" value={p.summary.unassessed} />
          </div>

          <Card>
            <CardHeader
              title="Current skill profile"
              description={p.job ? `Against ${p.job.title}, as it is defined today.` : 'Your position is not linked to a job, so there is nothing to compare against yet.'}
            />
            {p.entries.length === 0 ? (
              <EmptyState icon={<GraduationCap className="h-6 w-6" />} title="Nothing to show yet" description="Your job has no competency profile, or nothing has been assessed." />
            ) : (
              <ul className="divide-y divide-slate-200">
                {p.entries.map((entry) => <ProfileRow key={entry.competencyId} entry={entry} />)}
              </ul>
            )}
          </Card>
        </>
      )}

      {rows.length > 0 && (
        <>
          {rows.length > 1 && (
            <div className="flex flex-wrap gap-2">
              {rows.map((assessment) => (
                <button
                  key={assessment.id}
                  onClick={() => setOpenId(assessment.id)}
                  className={`rounded-md border px-3 py-1.5 text-sm ${assessment.id === current ? 'border-brand-500 bg-brand-50 text-brand-800' : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'}`}
                >
                  {assessment.cycle.name}
                </button>
              ))}
            </div>
          )}
          <AssessmentCard assessmentId={current} />
        </>
      )}
    </div>
  );
}

const Figure = ({ label, value, tone }: { label: string; value: number; tone?: 'warning' }) => (
  <div className={`rounded-lg border p-3 ${tone === 'warning' ? 'border-amber-200 bg-amber-50' : 'border-slate-200 bg-white'}`}>
    <div className="text-xs text-slate-500">{label}</div>
    <div className="mt-0.5 text-xl font-semibold tabular-nums text-slate-900">{value}</div>
  </div>
);

function ProfileRow({ entry }: { entry: SkillProfileEntryDto }) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 p-4">
      <span className="min-w-0">
        <span className="block font-medium text-slate-900">{entry.competencyName}</span>
        <span className="block text-xs text-slate-500">
          {entry.category}
          {entry.lastAssessedAt && ` · assessed ${entry.lastAssessedAt.slice(0, 10)}`}
          {entry.sourceCycle && ` · ${entry.sourceCycle.name}`}
        </span>
      </span>
      <span className="flex flex-wrap items-center gap-3 text-sm">
        <span className="text-slate-600">
          Required <span className="font-medium text-slate-900">{entry.requiredLevel === null ? 'not required' : formatLevel(entry.requiredLevel, entry.requiredLevelLabel)}</span>
        </span>
        <span className="text-slate-600">
          You <span className="font-medium text-slate-900">{formatLevel(entry.currentLevel, entry.currentLevelLabel)}</span>
        </span>
        <GapBadge status={entry.gapStatus} gapNeeded={entry.gapNeeded} />
      </span>
    </li>
  );
}

function AssessmentCard({ assessmentId }: { assessmentId: string | null }) {
  const assessment = useAssessment(assessmentId);
  const m = useCompetencyMutations();
  const toast = useToast();
  const [confirm, setConfirm] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const a = assessment.data;

  if (assessment.isLoading) return <LoadingBlock />;
  if (!a) return null;
  const inSelfAssessment = a.status === 'SELF_REVIEW';

  const submit = async () => {
    setErr(null);
    try {
      await m.submitSelf.mutateAsync(a.id);
      toast.success('Self assessment submitted');
      setConfirm(false);
    } catch (e) {
      setErr(errorMessage(e));
    }
  };

  return (
    <>
      <Card>
        <CardHeader title={a.cycle.name} description={`${a.snapshot.jobTitle ?? '—'} · reviewer ${a.reviewer.name ?? 'not assigned'}`} />
        <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 p-4">
          <AssessmentStatusBadge status={a.status} />
          {a.status === 'FINALIZED' && <span className="text-sm text-slate-600">{a.gapCount} competenc{a.gapCount === 1 ? 'y' : 'ies'} below requirement</span>}
        </div>
        {err && <Alert className="m-4">{err}</Alert>}
        {inSelfAssessment && <p className="px-4 pt-4 text-sm text-slate-600">Choose the level that best describes you for each competency. After you submit, your assessment cannot be changed.</p>}
        <ul className="divide-y divide-slate-200">
          {a.items.map((item) => <AssessmentRow key={item.id} assessment={a} item={item} editable={inSelfAssessment} />)}
        </ul>
        {inSelfAssessment && (
          <div className="flex justify-end border-t border-slate-200 p-4">
            <Button onClick={() => setConfirm(true)}>Submit self assessment</Button>
          </div>
        )}
      </Card>
      <ConfirmDialog
        open={confirm}
        title="Submit your self assessment"
        message="Your levels and comments go to your reviewer and cannot be changed afterwards."
        confirmLabel="Submit"
        loading={m.submitSelf.isPending}
        error={err}
        onConfirm={submit}
        onCancel={() => setConfirm(false)}
      />
    </>
  );
}

function AssessmentRow({ assessment, item, editable }: { assessment: AssessmentDetailDto; item: AssessmentItemDto; editable: boolean }) {
  const m = useCompetencyMutations();
  const [level, setLevel] = useState(item.selfLevel === null ? '' : String(item.selfLevel));
  const [comment, setComment] = useState(item.selfComment ?? '');
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const save = async () => {
    setErr(null);
    setSaved(false);
    try {
      await m.selfAssess.mutateAsync({ itemId: item.id, input: { selfLevel: level === '' ? null : Number(level), selfComment: comment || null } });
      setSaved(true);
    } catch (e) {
      setErr(errorMessage(e));
    }
  };

  const indicator = item.indicators.find((i) => i.level === Number(level || item.requiredLevel));

  return (
    <li className="p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-medium text-slate-900">{item.competencyName}</div>
          <div className="text-xs text-slate-500">
            {item.category}
            {` · required ${formatLevel(item.requiredLevel, item.levelLabels.find((l) => l.level === item.requiredLevel)?.label)}`}
            {!item.isMandatory && ' · optional'}
          </div>
        </div>
        {assessment.status === 'FINALIZED' && <GapBadge status={item.gapStatus} gapNeeded={item.gapNeeded} />}
      </div>

      {err && <Alert className="mt-2">{err}</Alert>}

      {editable ? (
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Select
            label="Your level"
            options={item.levelLabels.map((l) => ({ value: String(l.level), label: `${l.level} · ${l.label}` }))}
            placeholder="Choose a level"
            value={level}
            onChange={(e) => setLevel(e.target.value)}
          />
          <div className="sm:col-span-2"><Textarea label="Your comment" rows={2} value={comment} onChange={(e) => setComment(e.target.value)} /></div>
          {indicator && <p className="text-xs text-slate-500 sm:col-span-3">Level {indicator.level}: {indicator.description}</p>}
          <div className="flex items-center gap-2 sm:col-span-3">
            <Button variant="secondary" size="sm" onClick={save} loading={m.selfAssess.isPending}>Save</Button>
            {saved && <span className="text-xs text-emerald-700">Saved</span>}
          </div>
        </div>
      ) : (
        <div className="mt-2 grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
          <div>
            <div className="text-xs text-slate-500">Your level</div>
            <div className="font-medium text-slate-900">{formatLevel(item.selfLevel, item.levelLabels.find((l) => l.level === item.selfLevel)?.label)}</div>
            {item.selfComment && <p className="mt-1 text-xs text-slate-600">{item.selfComment}</p>}
          </div>
          <div>
            <div className="text-xs text-slate-500">Reviewer's level</div>
            <div className="font-medium text-slate-900">{formatLevel(item.finalLevel, item.levelLabels.find((l) => l.level === item.finalLevel)?.label)}</div>
            {item.managerComment && <p className="mt-1 text-xs text-slate-600">{item.managerComment}</p>}
          </div>
        </div>
      )}
    </li>
  );
}
