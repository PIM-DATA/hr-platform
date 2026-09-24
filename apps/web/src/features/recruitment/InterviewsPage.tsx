import { useEffect, useState } from 'react';
import { INTERVIEW_RECOMMENDATIONS, INTERVIEW_STATUSES, PERMISSIONS, type InterviewDto } from '@hr/shared';
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
import { useAuth } from '@/hooks/useAuth';
import { errorMessage } from '@/features/organization/shared';
import { useInterview, useInterviews, useRecruitmentMutations } from './recruitment.api';
import { InterviewStatusBadge, RecommendationBadge, Section, fmtDateTime } from './recruitment-ui';

const titleCase = (s: string) => s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, ' ');

export function InterviewsPage() {
  const { hasPermission } = useAuth();
  const canManage = hasPermission(PERMISSIONS.RECRUITMENT_MANAGE);
  const [view, setView] = useState<'mine' | 'all'>(canManage ? 'all' : 'mine');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [openId, setOpenId] = useState<string | null>(null);
  const list = useInterviews({ view, status, page, pageSize: 20 });
  const columns: Column<InterviewDto>[] = [
    { key: 'when', header: 'When', render: (i) => <div><div className="font-medium text-slate-900">{fmtDateTime(i.scheduledStart, i.timezone)}</div><div className="text-xs text-slate-400">{i.timezone}</div></div> },
    { key: 'who', header: 'Candidate', render: (i) => <div className="text-slate-800">{i.candidate.firstName} {i.candidate.lastName}<div className="text-xs text-slate-400">{i.opening.title}</div></div> },
    { key: 'title', header: 'Interview', hideBelow: 'md', render: (i) => i.title },
    { key: 'panel', header: 'Panel', hideBelow: 'lg', render: (i) => i.interviewers.map((x) => x.name).join(', ') },
    { key: 'fb', header: 'Feedback', hideBelow: 'sm', render: (i) => <span className="tabular-nums">{i.interviewers.filter((x) => x.feedbackSubmitted).length} / {i.interviewers.length}</span> },
    { key: 'status', header: 'Status', render: (i) => <InterviewStatusBadge status={i.status} /> },
  ];
  return (
    <>
      <Card>
        <div className="grid grid-cols-1 gap-3 border-b border-slate-200 p-4 sm:grid-cols-3">
          <Select options={[{ value: 'mine', label: 'My interviews' }, ...(canManage ? [{ value: 'all', label: 'All interviews' }] : [])]} value={view} onChange={(e) => { setView(e.target.value as 'mine' | 'all'); setPage(1); }} />
          <Select options={INTERVIEW_STATUSES.map((s) => ({ value: s, label: titleCase(s) }))} placeholder="All statuses" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} />
        </div>
        {list.isError && <Alert className="m-4">Could not load interviews.</Alert>}
        <DataTable columns={columns} rows={list.data?.data ?? []} rowKey={(i) => i.id} loading={list.isLoading} onRowClick={(i) => setOpenId(i.id)} emptyTitle="No interviews" emptyDescription={view === 'mine' ? 'Interviews you are assigned to appear here.' : 'Interviews are scheduled from an application.'} />
        {list.data?.meta && <Pagination {...list.data.meta} onPageChange={setPage} />}
      </Card>
      <InterviewDetailModal id={openId} onClose={() => setOpenId(null)} />
    </>
  );
}

export function InterviewDetailModal({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { user, hasPermission } = useAuth();
  const canManage = hasPermission(PERMISSIONS.RECRUITMENT_MANAGE);
  const q = useInterview(id);
  const m = useRecruitmentMutations();
  const toast = useToast();
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [confirm, setConfirm] = useState<'complete' | 'cancel' | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const i = q.data;
  const isPanel = !!i && i.interviewers.some((x) => x.userId === user?.id);
  const run = async (status: 'COMPLETED' | 'CANCELLED') => { setErr(null); try { await m.updateInterview.mutateAsync({ id: id!, input: { status } }); toast.success(status === 'COMPLETED' ? 'Marked completed' : 'Interview cancelled'); } catch (e) { setErr(errorMessage(e)); } setConfirm(null); };
  return (
    <>
      <Modal open={!!id && !feedbackOpen} onClose={onClose} title={i ? `${i.title} · ${i.candidate.firstName} ${i.candidate.lastName}` : 'Interview'} description={i ? `${i.opening.title} · ${i.applicationNumber}` : undefined} size="lg"
        footer={i ? (
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="secondary" onClick={onClose}>Close</Button>
            {canManage && i.status === 'SCHEDULED' && <><Button variant="danger" onClick={() => setConfirm('cancel')}>Cancel interview</Button><Button variant="secondary" onClick={() => setConfirm('complete')}>Mark completed</Button></>}
            {isPanel && i.status !== 'CANCELLED' && !i.myFeedback && <Button onClick={() => setFeedbackOpen(true)}>Submit my feedback</Button>}
          </div>
        ) : undefined}>
        {q.isLoading && <LoadingBlock />}
        {q.isError && <Alert>Could not load this interview.</Alert>}
        {err && <Alert className="mb-3">{err}</Alert>}
        {i && (
          <div className="space-y-4 text-sm">
            <div className="flex flex-wrap items-center gap-3"><InterviewStatusBadge status={i.status} />{i.roundNumber && <span className="text-slate-500">round {i.roundNumber}</span>}<span className="text-slate-700">{fmtDateTime(i.scheduledStart, i.timezone)} – {fmtDateTime(i.scheduledEnd, i.timezone).split(', ').pop()} ({i.timezone})</span></div>
            {(i.location || i.meetingUrl) && <Section title="Where"><p className="text-slate-700">{i.location ?? ''}{i.location && i.meetingUrl ? ' · ' : ''}{i.meetingUrl && <a className="text-brand-700 underline" href={i.meetingUrl} target="_blank" rel="noreferrer">{i.meetingUrl}</a>}</p></Section>}
            <Section title="Panel"><ul className="space-y-0.5">{i.interviewers.map((x) => <li key={x.userId} className="flex items-center gap-2 text-slate-700">{x.name}{x.roleLabel && <span className="text-xs text-slate-400">{x.roleLabel}</span>}<span className={`text-xs ${x.feedbackSubmitted ? 'text-emerald-700' : 'text-slate-400'}`}>{x.feedbackSubmitted ? 'feedback submitted' : 'no feedback yet'}</span></li>)}</ul></Section>
            <Section title={canManage || i.feedback.length > 1 ? 'Feedback' : 'My feedback'}>
              {i.feedback.length === 0 ? <p className="text-slate-500">{isPanel ? 'You have not submitted feedback for this interview.' : 'No feedback submitted yet.'}</p> : (
                <ul className="space-y-3">{i.feedback.map((f) => (
                  <li key={f.interviewerUserId} className="rounded-md border border-slate-200 p-3">
                    <div className="flex flex-wrap items-center gap-2"><span className="font-medium text-slate-900">{f.interviewerName}</span><RecommendationBadge value={f.recommendation} />{f.overallScore != null && <span className="text-xs text-slate-500">overall {f.overallScore}/5</span>}<span className="text-xs text-slate-400">{f.submittedAt.slice(0, 10)}</span></div>
                    {f.strengths && <p className="mt-1 text-slate-700"><span className="text-xs uppercase text-slate-400">Strengths</span><br />{f.strengths}</p>}
                    {f.concerns && <p className="mt-1 text-slate-700"><span className="text-xs uppercase text-slate-400">Concerns</span><br />{f.concerns}</p>}
                    {f.comments && <p className="mt-1 text-slate-700"><span className="text-xs uppercase text-slate-400">Comments</span><br />{f.comments}</p>}
                  </li>
                ))}</ul>
              )}
              <p className="mt-2 text-xs text-slate-500">Each interviewer's feedback is one view, shown side by side. Nothing adds these up into a score or a ranking.</p>
            </Section>
          </div>
        )}
      </Modal>
      <FeedbackModal open={feedbackOpen} onClose={() => setFeedbackOpen(false)} interviewId={id} />
      <ConfirmDialog open={confirm === 'complete'} title="Mark completed?" message="Records that the interview took place. Interviewers can still submit feedback." confirmLabel="Mark completed" onConfirm={() => run('COMPLETED')} onCancel={() => setConfirm(null)} loading={m.updateInterview.isPending} />
      <ConfirmDialog open={confirm === 'cancel'} title="Cancel this interview?" message="The interview is kept as a record. No feedback can be submitted for a cancelled interview." confirmLabel="Cancel interview" variant="danger" onConfirm={() => run('CANCELLED')} onCancel={() => setConfirm(null)} loading={m.updateInterview.isPending} />
    </>
  );
}

function FeedbackModal({ open, onClose, interviewId }: { open: boolean; onClose: () => void; interviewId: string | null }) {
  const m = useRecruitmentMutations();
  const toast = useToast();
  const [recommendation, setRec] = useState('PROCEED');
  const [overallScore, setScore] = useState('');
  const [strengths, setStrengths] = useState('');
  const [concerns, setConcerns] = useState('');
  const [comments, setComments] = useState('');
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (open) { setErr(null); setRec('PROCEED'); setScore(''); setStrengths(''); setConcerns(''); setComments(''); } }, [open]);
  const submit = async () => {
    setErr(null);
    try { await m.submitFeedback.mutateAsync({ id: interviewId!, input: { recommendation: recommendation as never, overallScore: overallScore ? Number(overallScore) : null, strengths: strengths || null, concerns: concerns || null, comments: comments || null } }); toast.success('Feedback submitted'); onClose(); } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <Modal open={open} onClose={onClose} title="My interview feedback" description="Submitted once. It informs the hiring team; it decides nothing by itself." size="lg"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={submit} loading={m.submitFeedback.isPending}>Submit feedback</Button></>}>
      <div className="space-y-3">
        {err && <Alert>{err}</Alert>}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Select label="Recommendation" options={INTERVIEW_RECOMMENDATIONS.map((r) => ({ value: r, label: titleCase(r) }))} value={recommendation} onChange={(e) => setRec(e.target.value)} />
          <Select label="Overall impression (optional)" options={['1', '2', '3', '4', '5'].map((s) => ({ value: s, label: `${s} of 5` }))} placeholder="Not given" value={overallScore} onChange={(e) => setScore(e.target.value)} />
        </div>
        <Textarea label="Strengths" rows={3} value={strengths} onChange={(e) => setStrengths(e.target.value)} />
        <Textarea label="Concerns" rows={3} value={concerns} onChange={(e) => setConcerns(e.target.value)} />
        <Textarea label="Other comments" rows={2} value={comments} onChange={(e) => setComments(e.target.value)} />
        <p className="text-xs text-slate-500">Write about the role and the conversation. Nothing here should refer to protected characteristics.</p>
      </div>
    </Modal>
  );
}
