import { useState } from 'react';
import type { PlanDetailDto, PlanItemDto, PlanSummaryDto } from '@hr/shared';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Alert } from '@/components/ui/Alert';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { Pagination } from '@/components/ui/Pagination';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { LoadingBlock } from '@/components/ui/Spinner';
import { useToast } from '@/components/ui/Toast';
import { errorMessage } from '@/features/organization/shared';
import { usePerformanceMutations, usePlan, usePlans } from './performance.api';
import { formatMeasure, measurementLabel, PlanStatusBadge, ProgressBar, Score, formatWeight } from './performance-ui';

/**
 * The plans a manager is the **assigned reviewer** for — not their whole team.
 *
 * Those are different populations on purpose: being somebody's manager today does not give you a review that was
 * assigned to somebody else, and the server checks the same thing before it accepts a score.
 */
export function TeamReviewsPage() {
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [openId, setOpenId] = useState<string | null>(null);
  const plans = usePlans({ view: 'reviewing', status, page, pageSize: 20 });
  const rows = plans.data?.data ?? [];

  const counts = {
    assigned: plans.data?.meta?.total ?? rows.length,
    awaitingSelf: rows.filter((p) => p.status === 'SELF_REVIEW').length,
    waitingForMe: rows.filter((p) => p.status === 'MANAGER_REVIEW').length,
    completed: rows.filter((p) => p.status === 'FINALIZED').length,
  };

  const columns: Column<PlanSummaryDto>[] = [
    { key: 'emp', header: 'Employee', render: (p) => (
      <div>
        <div className="font-medium text-slate-900">{p.employee.firstName} {p.employee.lastName}</div>
        <div className="text-xs text-slate-400">{p.employee.employeeCode}{p.snapshot.departmentName && ` · ${p.snapshot.departmentName}`}</div>
      </div>
    ) },
    { key: 'cycle', header: 'Cycle', hideBelow: 'md', render: (p) => p.cycle.name },
    { key: 'progress', header: 'Progress', hideBelow: 'lg', render: (p) => <ProgressBar percent={p.progressPercent} /> },
    { key: 'self', header: 'Self review', hideBelow: 'sm', render: (p) => (p.selfSubmittedAt ? 'Submitted' : p.selfReviewUnavailable ? <span className="text-slate-400">No account</span> : <span className="text-slate-400">Not yet</span>) },
    { key: 'status', header: 'Status', render: (p) => <PlanStatusBadge status={p.status} /> },
    { key: 'rating', header: 'Result', className: 'text-right', render: (p) => (p.status === 'FINALIZED' ? <span><Score value={p.weightedScore} className="font-medium" /> <span className="text-xs text-slate-500">{p.ratingLabel}</span></span> : <span className="text-slate-400">—</span>) },
  ];

  return (
    <>
      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <CountCard label="Assigned to me" value={counts.assigned} />
        <CountCard label="Awaiting self review" value={counts.awaitingSelf} />
        <CountCard label="Waiting for my review" value={counts.waitingForMe} tone="warning" />
        <CountCard label="Completed" value={counts.completed} />
      </div>
      <Card>
        <div className="border-b border-slate-200 p-4">
          <Select
            options={[
              { value: 'SELF_REVIEW', label: 'Awaiting self review' },
              { value: 'MANAGER_REVIEW', label: 'Waiting for my review' },
              { value: 'FINALIZED', label: 'Complete' },
              { value: 'ACTIVE', label: 'In progress' },
            ]}
            placeholder="All statuses"
            value={status}
            onChange={(e) => { setStatus(e.target.value); setPage(1); }}
            className="w-56"
          />
        </div>
        {plans.isError && <Alert className="m-4">Could not load your reviews.</Alert>}
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(p) => p.id}
          loading={plans.isLoading}
          onRowClick={(p) => setOpenId(p.id)}
          emptyTitle="No reviews assigned to you"
          emptyDescription="Plans appear here when HR assigns you as the reviewer."
        />
        {plans.data?.meta && <Pagination {...plans.data.meta} onPageChange={setPage} />}
      </Card>
      <ReviewModal planId={openId} onClose={() => setOpenId(null)} />
    </>
  );
}

const CountCard = ({ label, value, tone }: { label: string; value: number; tone?: 'warning' }) => (
  <div className={`rounded-lg border p-3 ${tone === 'warning' ? 'border-amber-200 bg-amber-50' : 'border-slate-200 bg-white'}`}>
    <div className="text-xs text-slate-500">{label}</div>
    <div className="mt-0.5 text-xl font-semibold tabular-nums text-slate-900">{value}</div>
  </div>
);

/** The review form: what was agreed, what happened, what the employee said, and the reviewer's own verdict. */
function ReviewModal({ planId, onClose }: { planId: string | null; onClose: () => void }) {
  const plan = usePlan(planId);
  const m = usePerformanceMutations();
  const toast = useToast();
  const [confirm, setConfirm] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const p = plan.data;

  const submit = async () => {
    setErr(null);
    try {
      await m.submitManager.mutateAsync(p!.id);
      toast.success('Review submitted');
      setConfirm(false);
      onClose();
    } catch (e) {
      setErr(errorMessage(e));
    }
  };

  return (
    <>
      <Modal
        open={!!planId}
        onClose={onClose}
        title={p ? `${p.employee.firstName} ${p.employee.lastName}` : 'Review'}
        description={p ? `${p.cycle.name} · ${p.snapshot.positionTitle ?? '—'}` : undefined}
        size="lg"
        footer={
          <>
            <Button variant="secondary" onClick={onClose}>Close</Button>
            {p?.status === 'MANAGER_REVIEW' && <Button onClick={() => setConfirm(true)}>Submit review</Button>}
          </>
        }
      >
        {plan.isLoading && <LoadingBlock />}
        {plan.isError && <Alert>Could not load this plan.</Alert>}
        {err && <Alert className="mb-3">{err}</Alert>}
        {p && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <PlanStatusBadge status={p.status} />
              <span className="text-slate-500">Weights {formatWeight(p.totalWeight)}</span>
              {p.selfSubmittedAt && <span className="text-slate-500">Self review submitted</span>}
              {p.status === 'FINALIZED' && <span className="font-medium text-slate-900">Final <Score value={p.weightedScore} /> · {p.ratingLabel}</span>}
            </div>
            {p.status === 'SELF_REVIEW' && <Alert tone="info">Waiting for {p.employee.firstName} to submit their self review.</Alert>}
            <ul className="divide-y divide-slate-200">
              {p.items.map((item) => <ReviewItem key={item.id} plan={p} item={item} />)}
            </ul>
          </div>
        )}
      </Modal>
      <ConfirmDialog
        open={confirm}
        title="Submit this review"
        message="The weighted score and rating are calculated and the review is complete. It cannot be changed afterwards."
        confirmLabel="Submit review"
        loading={m.submitManager.isPending}
        error={err}
        onConfirm={submit}
        onCancel={() => setConfirm(false)}
      />
    </>
  );
}

function ReviewItem({ plan, item }: { plan: PlanDetailDto; item: PlanItemDto }) {
  const m = usePerformanceMutations();
  const [score, setScore] = useState(item.managerScore ?? '');
  const [comment, setComment] = useState(item.managerComment ?? '');
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const editable = plan.status === 'MANAGER_REVIEW';

  const save = async () => {
    setErr(null);
    setSaved(false);
    try {
      await m.managerAssess.mutateAsync({ itemId: item.id, input: { managerScore: score || null, managerComment: comment || null } });
      setSaved(true);
    } catch (e) {
      setErr(errorMessage(e));
    }
  };

  return (
    <li className="py-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-medium text-slate-900">{item.kpiName}</div>
          <div className="text-xs text-slate-500">
            {formatWeight(item.weight)} · {measurementLabel(item.measurementType)}
            {(item.targetValue || item.targetText) && ` · target ${formatMeasure(item.targetValue) ?? item.targetText}`}
            {(item.actualValue || item.actualText) && ` · actual ${formatMeasure(item.actualValue) ?? item.actualText}`}
          </div>
        </div>
        <span className="text-xs text-slate-500">Self <Score value={item.selfScore} /></span>
      </div>
      {item.employeeComment && <p className="mt-1 rounded-md bg-slate-50 p-2 text-xs text-slate-600">{item.employeeComment}</p>}
      {err && <Alert className="mt-2">{err}</Alert>}
      {editable ? (
        <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Input label={`Your score (${plan.cycle.minScore}–${plan.cycle.maxScore})`} inputMode="decimal" value={score} onChange={(e) => setScore(e.target.value)} />
          <div className="sm:col-span-2"><Textarea label="Your comment" rows={2} value={comment} onChange={(e) => setComment(e.target.value)} /></div>
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={save} loading={m.managerAssess.isPending}>Save</Button>
            {saved && <span className="text-xs text-emerald-700">Saved</span>}
          </div>
        </div>
      ) : (
        <div className="mt-2 text-sm">
          <span className="text-slate-500">Reviewer's score </span><Score value={item.managerScore} className="font-medium text-slate-900" />
          {item.managerComment && <p className="mt-1 text-xs text-slate-600">{item.managerComment}</p>}
        </div>
      )}
    </li>
  );
}
