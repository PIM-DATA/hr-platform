import { useState } from 'react';
import type { AssessmentDetailDto, AssessmentItemDto, AssessmentSummaryDto } from '@hr/shared';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Alert } from '@/components/ui/Alert';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { Pagination } from '@/components/ui/Pagination';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { LoadingBlock } from '@/components/ui/Spinner';
import { useToast } from '@/components/ui/Toast';
import { errorMessage } from '@/features/organization/shared';
import { useAssessment, useAssessments, useCompetencyMutations } from './competency.api';
import { AssessmentStatusBadge, GapBadge, formatLevel } from './competency-ui';

/**
 * The assessments a reviewer was actually assigned — not everybody they manage.
 *
 * The server checks the same thing before it accepts a level, so a manager who has taken over a team cannot finish
 * a round that was assigned to their predecessor; HR reassigns it explicitly, and that is recorded.
 */
export function TeamAssessmentsPage() {
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [openId, setOpenId] = useState<string | null>(null);
  const assessments = useAssessments({ view: 'reviewing', status, page, pageSize: 20 });
  const rows = assessments.data?.data ?? [];

  const counts = {
    assigned: assessments.data?.meta?.total ?? rows.length,
    awaitingSelf: rows.filter((a) => a.status === 'SELF_REVIEW').length,
    waitingForMe: rows.filter((a) => a.status === 'MANAGER_REVIEW').length,
    finalized: rows.filter((a) => a.status === 'FINALIZED').length,
  };

  const columns: Column<AssessmentSummaryDto>[] = [
    { key: 'emp', header: 'Employee', render: (a) => (
      <div>
        <div className="font-medium text-slate-900">{a.employee.firstName} {a.employee.lastName}</div>
        <div className="text-xs text-slate-400">{a.employee.employeeCode}{a.snapshot.departmentName && ` · ${a.snapshot.departmentName}`}</div>
      </div>
    ) },
    { key: 'job', header: 'Job', hideBelow: 'md', render: (a) => a.snapshot.jobTitle ?? <span className="text-slate-400">—</span> },
    { key: 'cycle', header: 'Cycle', hideBelow: 'lg', render: (a) => a.cycle.name },
    { key: 'self', header: 'Self assessment', hideBelow: 'sm', render: (a) => (a.selfSubmittedAt ? 'Submitted' : a.selfAssessmentUnavailable ? <span className="text-slate-400">No account</span> : <span className="text-slate-400">Not yet</span>) },
    { key: 'status', header: 'Status', render: (a) => <AssessmentStatusBadge status={a.status} /> },
    { key: 'gaps', header: 'Gaps', className: 'text-right', render: (a) => (a.status === 'FINALIZED' ? <span className="tabular-nums">{a.gapCount}</span> : <span className="text-slate-400">—</span>) },
  ];

  return (
    <>
      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <CountCard label="Assigned to me" value={counts.assigned} />
        <CountCard label="Awaiting self assessment" value={counts.awaitingSelf} />
        <CountCard label="Waiting for me" value={counts.waitingForMe} tone="warning" />
        <CountCard label="Complete" value={counts.finalized} />
      </div>
      <Card>
        <div className="border-b border-slate-200 p-4">
          <Select
            options={[
              { value: 'SELF_REVIEW', label: 'Awaiting self assessment' },
              { value: 'MANAGER_REVIEW', label: 'Waiting for me' },
              { value: 'FINALIZED', label: 'Complete' },
              { value: 'ACTIVE', label: 'In progress' },
            ]}
            placeholder="All statuses"
            value={status}
            onChange={(e) => { setStatus(e.target.value); setPage(1); }}
            className="w-60"
          />
        </div>
        {assessments.isError && <Alert className="m-4">Could not load your assessments.</Alert>}
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(a) => a.id}
          loading={assessments.isLoading}
          onRowClick={(a) => setOpenId(a.id)}
          emptyTitle="Nothing assigned to you"
          emptyDescription="Assessments appear here when HR assigns you as the reviewer."
        />
        {assessments.data?.meta && <Pagination {...assessments.data.meta} onPageChange={setPage} />}
      </Card>
      <AssessmentModal assessmentId={openId} onClose={() => setOpenId(null)} />
    </>
  );
}

const CountCard = ({ label, value, tone }: { label: string; value: number; tone?: 'warning' }) => (
  <div className={`rounded-lg border p-3 ${tone === 'warning' ? 'border-amber-200 bg-amber-50' : 'border-slate-200 bg-white'}`}>
    <div className="text-xs text-slate-500">{label}</div>
    <div className="mt-0.5 text-xl font-semibold tabular-nums text-slate-900">{value}</div>
  </div>
);

function AssessmentModal({ assessmentId, onClose }: { assessmentId: string | null; onClose: () => void }) {
  const assessment = useAssessment(assessmentId);
  const m = useCompetencyMutations();
  const toast = useToast();
  const [confirm, setConfirm] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const a = assessment.data;

  const submit = async () => {
    setErr(null);
    try {
      await m.submitManager.mutateAsync(a!.id);
      toast.success('Assessment submitted');
      setConfirm(false);
      onClose();
    } catch (e) {
      setErr(errorMessage(e));
    }
  };

  return (
    <>
      <Modal
        open={!!assessmentId}
        onClose={onClose}
        title={a ? `${a.employee.firstName} ${a.employee.lastName}` : 'Assessment'}
        description={a ? `${a.cycle.name} · ${a.snapshot.jobTitle ?? '—'}` : undefined}
        size="lg"
        footer={
          <>
            <Button variant="secondary" onClick={onClose}>Close</Button>
            {a?.status === 'MANAGER_REVIEW' && <Button onClick={() => setConfirm(true)}>Submit assessment</Button>}
          </>
        }
      >
        {assessment.isLoading && <LoadingBlock />}
        {assessment.isError && <Alert>Could not load this assessment.</Alert>}
        {err && <Alert className="mb-3">{err}</Alert>}
        {a && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <AssessmentStatusBadge status={a.status} />
              {a.selfSubmittedAt && <span className="text-slate-500">Self assessment submitted</span>}
              {a.selfAssessmentUnavailable && <span className="text-slate-500">No account, so no self assessment</span>}
              {a.status === 'FINALIZED' && <span className="text-slate-700">{a.gapCount} below requirement</span>}
            </div>
            {a.status === 'SELF_REVIEW' && <Alert tone="info">Waiting for {a.employee.firstName} to submit their self assessment.</Alert>}
            <ul className="divide-y divide-slate-200">
              {a.items.map((item) => <ReviewRow key={item.id} assessment={a} item={item} />)}
            </ul>
          </div>
        )}
      </Modal>
      <ConfirmDialog
        open={confirm}
        title="Submit this assessment"
        message="Your levels become the assessed levels, the gaps are calculated from them, and the assessment cannot be changed afterwards."
        confirmLabel="Submit"
        loading={m.submitManager.isPending}
        error={err}
        onConfirm={submit}
        onCancel={() => setConfirm(false)}
      />
    </>
  );
}

function ReviewRow({ assessment, item }: { assessment: AssessmentDetailDto; item: AssessmentItemDto }) {
  const m = useCompetencyMutations();
  const [level, setLevel] = useState(item.managerLevel === null ? '' : String(item.managerLevel));
  const [comment, setComment] = useState(item.managerComment ?? '');
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const editable = assessment.status === 'MANAGER_REVIEW';
  const labelFor = (value: number | null) => item.levelLabels.find((l) => l.level === value)?.label;

  const save = async () => {
    setErr(null);
    setSaved(false);
    try {
      await m.managerAssess.mutateAsync({ itemId: item.id, input: { managerLevel: level === '' ? null : Number(level), managerComment: comment || null } });
      setSaved(true);
    } catch (e) {
      setErr(errorMessage(e));
    }
  };

  const indicator = item.indicators.find((i) => i.level === Number(level || item.requiredLevel));

  return (
    <li className="py-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-medium text-slate-900">{item.competencyName}</div>
          <div className="text-xs text-slate-500">
            {item.category} · required {formatLevel(item.requiredLevel, labelFor(item.requiredLevel))}
          </div>
        </div>
        <span className="text-xs text-slate-500">Self {formatLevel(item.selfLevel, labelFor(item.selfLevel))}</span>
      </div>
      {item.selfComment && <p className="mt-1 rounded-md bg-slate-50 p-2 text-xs text-slate-600">{item.selfComment}</p>}
      {err && <Alert className="mt-2">{err}</Alert>}
      {editable ? (
        <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-3">
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
            <Button variant="secondary" size="sm" onClick={save} loading={m.managerAssess.isPending}>Save</Button>
            {saved && <span className="text-xs text-emerald-700">Saved</span>}
          </div>
        </div>
      ) : (
        <div className="mt-2 flex flex-wrap items-center gap-3 text-sm">
          <span className="text-slate-600">Assessed <span className="font-medium text-slate-900">{formatLevel(item.finalLevel, labelFor(item.finalLevel))}</span></span>
          <GapBadge status={item.gapStatus} gapNeeded={item.gapNeeded} />
          {item.managerComment && <p className="w-full text-xs text-slate-600">{item.managerComment}</p>}
        </div>
      )}
    </li>
  );
}
