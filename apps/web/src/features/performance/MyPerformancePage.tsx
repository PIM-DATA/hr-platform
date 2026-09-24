import { useEffect, useState } from 'react';
import { Target } from 'lucide-react';
import type { PlanDetailDto, PlanItemDto } from '@hr/shared';
import { Card, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Alert';
import { Input } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/Textarea';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingBlock } from '@/components/ui/Spinner';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { useToast } from '@/components/ui/Toast';
import { errorMessage } from '@/features/organization/shared';
import { usePerformanceMutations, usePlan, usePlans } from './performance.api';
import { formatMeasure, measurementLabel, PlanStatusBadge, ProgressBar, Score, formatWeight } from './performance-ui';

/**
 * An employee's own plan: what they are measured on, where they have got to, and — once the review opens — their own
 * assessment.
 *
 * Nothing here calculates a score. The weighted result appears when the reviewer has submitted, and it is whatever
 * the server says it is.
 */
export function MyPerformancePage() {
  const plans = usePlans({ view: 'mine', pageSize: 20 });
  const [openId, setOpenId] = useState<string | null>(null);
  const rows = plans.data?.data ?? [];
  const current = openId ?? rows[0]?.id ?? null;

  if (plans.isLoading) return <LoadingBlock />;
  if (plans.isError) return <Alert>Could not load your performance plans.</Alert>;
  if (rows.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={<Target className="h-6 w-6" />}
          title="No performance plan yet"
          description="A plan appears here once HR has assigned you to a performance cycle."
        />
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {rows.length > 1 && (
        <div className="flex flex-wrap gap-2">
          {rows.map((plan) => (
            <button
              key={plan.id}
              onClick={() => setOpenId(plan.id)}
              className={`rounded-md border px-3 py-1.5 text-sm ${plan.id === current ? 'border-brand-500 bg-brand-50 text-brand-800' : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'}`}
            >
              {plan.cycle.name}
            </button>
          ))}
        </div>
      )}
      <PlanCard planId={current} />
    </div>
  );
}

function PlanCard({ planId }: { planId: string | null }) {
  const plan = usePlan(planId);
  const m = usePerformanceMutations();
  const toast = useToast();
  const [confirmSubmit, setConfirmSubmit] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const p = plan.data;

  if (plan.isLoading) return <LoadingBlock />;
  if (!p) return <Alert>Could not load this plan.</Alert>;

  const inSelfReview = p.status === 'SELF_REVIEW';
  const canRecordProgress = p.status === 'ACTIVE' || inSelfReview;

  const submit = async () => {
    setErr(null);
    try {
      await m.submitSelf.mutateAsync(p.id);
      toast.success('Self review submitted');
      setConfirmSubmit(false);
    } catch (e) {
      setErr(errorMessage(e));
    }
  };

  return (
    <>
      <Card>
        <CardHeader title={p.cycle.name} description={`${p.snapshot.positionTitle ?? '—'}${p.snapshot.departmentName ? ` · ${p.snapshot.departmentName}` : ''}`} />
        <div className="grid grid-cols-2 gap-3 border-b border-slate-200 p-4 sm:grid-cols-4">
          <Figure label="Status" value={<PlanStatusBadge status={p.status} />} />
          <Figure label="Progress" value={<ProgressBar percent={p.progressPercent} />} />
          <Figure label="Reviewer" value={<span className="text-sm text-slate-900">{p.reviewer.name ?? 'Not assigned'}</span>} />
          <Figure
            label="Final score"
            value={p.status === 'FINALIZED'
              ? <span className="text-sm font-semibold text-slate-900"><Score value={p.weightedScore} /> · {p.ratingLabel ?? 'No rating'}</span>
              : <span className="text-sm text-slate-400">After your review is complete</span>}
          />
        </div>

        {err && <Alert className="m-4">{err}</Alert>}
        {p.totalWeight !== '100.00' && (
          <Alert className="m-4">The KPI weights on this plan add up to {formatWeight(p.totalWeight)}, not 100%. Ask HR to correct it before the review.</Alert>
        )}
        {inSelfReview && <p className="px-4 pt-4 text-sm text-slate-600">Score each KPI and add your own comments, then submit. After that your assessment cannot be changed.</p>}

        <ul className="divide-y divide-slate-200">
          {p.items.map((item) => (
            <ItemRow key={item.id} plan={p} item={item} canRecordProgress={canRecordProgress} inSelfReview={inSelfReview} />
          ))}
        </ul>

        {inSelfReview && (
          <div className="flex justify-end border-t border-slate-200 p-4">
            <Button onClick={() => setConfirmSubmit(true)}>Submit self review</Button>
          </div>
        )}
      </Card>

      <ConfirmDialog
        open={confirmSubmit}
        title="Submit your self review"
        message="Your scores and comments go to your reviewer and cannot be changed afterwards."
        confirmLabel="Submit"
        loading={m.submitSelf.isPending}
        error={err}
        onConfirm={submit}
        onCancel={() => setConfirmSubmit(false)}
      />
    </>
  );
}

const Figure = ({ label, value }: { label: string; value: React.ReactNode }) => (
  <div>
    <div className="text-xs text-slate-500">{label}</div>
    <div className="mt-1">{value}</div>
  </div>
);

function ItemRow({ plan, item, canRecordProgress, inSelfReview }: {
  plan: PlanDetailDto; item: PlanItemDto; canRecordProgress: boolean; inSelfReview: boolean;
}) {
  const m = usePerformanceMutations();
  const [actual, setActual] = useState(item.actualValue ?? item.actualText ?? '');
  const [percent, setPercent] = useState(item.progressPercent === null ? '' : String(item.progressPercent));
  const [comment, setComment] = useState(item.employeeComment ?? '');
  const [selfScore, setSelfScore] = useState(item.selfScore ?? '');
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => { setSaved(false); }, [actual, percent, comment, selfScore]);

  const numeric = item.measurementType === 'NUMBER' || item.measurementType === 'PERCENTAGE';

  const save = async () => {
    setErr(null);
    try {
      if (inSelfReview) {
        await m.selfAssess.mutateAsync({ itemId: item.id, input: { selfScore: selfScore || null, employeeComment: comment || null } });
      } else {
        await m.updateProgress.mutateAsync({
          itemId: item.id,
          input: {
            actualValue: numeric ? (actual || null) : null,
            actualText: numeric ? null : (actual || null),
            progressPercent: percent === '' ? null : Number(percent),
            employeeComment: comment || null,
          },
        });
      }
      setSaved(true);
    } catch (e) {
      setErr(errorMessage(e));
    }
  };

  return (
    <li className="p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-medium text-slate-900">{item.kpiName}</div>
          <div className="text-xs text-slate-500">
            {formatWeight(item.weight)} · {measurementLabel(item.measurementType)}
            {(item.targetValue || item.targetText) && ` · target ${formatMeasure(item.targetValue) ?? item.targetText}`}
          </div>
          {item.description && <div className="mt-1 text-xs text-slate-500">{item.description}</div>}
        </div>
        {item.progressPercent !== null && <ProgressBar percent={item.progressPercent} />}
      </div>

      {err && <Alert className="mt-2">{err}</Alert>}

      {(canRecordProgress || inSelfReview) && (
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
          {inSelfReview ? (
            <Input
              label={`Your score (${plan.cycle.minScore}–${plan.cycle.maxScore})`}
              inputMode="decimal"
              value={selfScore}
              onChange={(e) => setSelfScore(e.target.value)}
            />
          ) : (
            <>
              <Input label={numeric ? 'Actual' : 'What happened'} inputMode={numeric ? 'decimal' : undefined} value={actual} onChange={(e) => setActual(e.target.value)} />
              <Input label="Progress %" inputMode="numeric" value={percent} onChange={(e) => setPercent(e.target.value)} />
            </>
          )}
          <div className={inSelfReview ? 'sm:col-span-2' : ''}>
            <Textarea label="Your comment" rows={2} value={comment} onChange={(e) => setComment(e.target.value)} />
          </div>
        </div>
      )}

      {(canRecordProgress || inSelfReview) && (
        <div className="mt-2 flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={save} loading={m.updateProgress.isPending || m.selfAssess.isPending}>Save</Button>
          {saved && <span className="text-xs text-emerald-700">Saved</span>}
        </div>
      )}

      {plan.status === 'FINALIZED' && (
        <div className="mt-3 grid grid-cols-1 gap-3 rounded-md bg-slate-50 p-3 text-sm sm:grid-cols-2">
          <div>
            <div className="text-xs text-slate-500">Your score</div>
            <Score value={item.selfScore} className="font-medium text-slate-900" />
            {item.employeeComment && <p className="mt-1 text-xs text-slate-600">{item.employeeComment}</p>}
          </div>
          <div>
            <div className="text-xs text-slate-500">Reviewer's score</div>
            <Score value={item.managerScore} className="font-medium text-slate-900" />
            {item.managerComment && <p className="mt-1 text-xs text-slate-600">{item.managerComment}</p>}
          </div>
        </div>
      )}
    </li>
  );
}
