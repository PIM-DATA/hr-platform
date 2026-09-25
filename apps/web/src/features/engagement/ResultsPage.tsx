import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { PERMISSIONS } from '@hr/shared';
import { Card } from '@/components/ui/Card';
import { Select } from '@/components/ui/Select';
import { Alert } from '@/components/ui/Alert';
import { LoadingBlock } from '@/components/ui/Spinner';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { Pagination } from '@/components/ui/Pagination';
import { useAuth } from '@/hooks/useAuth';
import { useComments, useIdentifiedResponses, useParticipation, useSurvey, useSurveys } from './engagement.api';
import { ResultsView } from './ResultsView';
import { ModeBadge, titleCase } from './engagement-ui';
import type { CommentDto, ParticipationRowDto } from '@hr/shared';

function useSurveyPicker(statuses: string[]) {
  const [params, setParams] = useSearchParams();
  const surveys = useSurveys({ page: 1, pageSize: 100 });
  const list = (surveys.data?.data ?? []).filter((s) => statuses.includes(s.status));
  const fromUrl = params.get('survey');
  const selected = fromUrl && list.some((s) => s.id === fromUrl) ? fromUrl : list[0]?.id ?? '';
  const set = (id: string) => { const n = new URLSearchParams(params); if (id) n.set('survey', id); else n.delete('survey'); setParams(n, { replace: true }); };
  return { list, selected, survey: list.find((s) => s.id === selected) ?? null, set, loading: surveys.isLoading };
}
const Picker = ({ p, hint }: { p: ReturnType<typeof useSurveyPicker>; hint: string }) => (
  <Card className="mb-4"><div className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2"><Select label="Survey" options={p.list.map((s) => ({ value: s.id, label: `${s.name} · ${s.status.toLowerCase()} · ${s.responseMode.toLowerCase()}` }))} placeholder={p.loading ? 'Loading…' : 'No surveys'} value={p.selected} onChange={(e) => p.set(e.target.value)} /><p className="self-end text-xs text-slate-500">{hint}</p></div></Card>
);

export function EngagementResultsPage() {
  const { hasPermission } = useAuth();
  const p = useSurveyPicker(['OPEN', 'CLOSED', 'ARCHIVED']);
  return (<>
    <Picker p={p} hint="Aggregates only. Any group below the survey's minimum is hidden — after every filter, for everyone." />
    {p.survey && <ResultsView surveyId={p.survey.id} code={p.survey.code} allowFilters allowCsv={hasPermission(PERMISSIONS.ENGAGEMENT_VIEW_RESULTS) || hasPermission(PERMISSIONS.ENGAGEMENT_MANAGE)} />}
  </>);
}

export function EngagementCommentsPage() {
  const p = useSurveyPicker(['OPEN', 'CLOSED', 'ARCHIVED']);
  const s = useSurvey(p.selected || null);
  const anonymous = s.data?.responseMode === 'ANONYMOUS';
  const ready = !!s.data && (!anonymous || s.data.status !== 'OPEN');
  const comments = useComments(p.selected || null, ready);
  const identified = useIdentifiedResponses(p.selected || null, !!s.data && !anonymous);
  const columns: Column<CommentDto>[] = [{ key: 'q', header: 'Question', hideBelow: 'md', render: (c) => s.data?.questions.find((q) => q.id === c.questionId)?.text ?? '' }, { key: 't', header: 'Comment', render: (c) => <span className="whitespace-pre-wrap">{c.text}</span> }, { key: 'who', header: 'Respondent', render: (c) => (c.respondent ? `${c.respondent.firstName} ${c.respondent.lastName} (${c.respondent.employeeCode})` : <span className="text-slate-400">anonymous</span>) }];
  return (<>
    <Picker p={p} hint="Free text is read here only. Anonymous comments open after the survey closes and only when the whole survey meets its threshold; they carry no department, time or name." />
    {s.data && anonymous && s.data.status === 'OPEN' && <Card className="p-6 text-sm text-slate-600">Anonymous comments become readable once the survey is closed.</Card>}
    {comments.isError && <Alert>{(comments.error as { message?: string })?.message ?? 'Comments are not available for this survey.'}</Alert>}
    {comments.data && <Card><div className="border-b border-slate-200 px-4 py-3 text-sm font-semibold text-slate-900">Comments <span className="text-xs font-normal text-slate-400">{comments.data.length}</span></div><DataTable columns={columns} rows={comments.data} rowKey={(c) => `${c.questionId}-${c.text.length}-${c.text.slice(0, 24)}-${c.respondent?.employeeCode ?? ''}`} emptyTitle="No comments" /></Card>}
    {identified.data && (
      <Card className="mt-4"><div className="border-b border-slate-200 px-4 py-3 text-sm font-semibold text-slate-900">Respondent detail <ModeBadge mode="IDENTIFIED" /></div>
        <ul className="divide-y divide-slate-100 text-sm">{identified.data.map((r) => <li key={r.responseId} className="px-4 py-3"><div className="font-medium text-slate-900">{r.employee.firstName} {r.employee.lastName} <span className="text-xs text-slate-400">{r.employee.employeeCode} · {new Date(r.submittedAt).toLocaleString()}</span></div><ul className="mt-1 space-y-0.5 text-xs text-slate-600">{r.answers.map((a) => <li key={a.questionId}>{s.data?.questions.find((q) => q.id === a.questionId)?.text}: <b>{a.numericValue ?? (a.booleanValue === null ? null : a.booleanValue ? 'Yes' : 'No') ?? a.textValue ?? (a.choiceValues ?? []).join(', ')}</b></li>)}</ul></li>)}</ul>
      </Card>
    )}
  </>);
}

export function EngagementParticipationPage() {
  const p = useSurveyPicker(['OPEN', 'CLOSED', 'ARCHIVED']);
  const [completed, setCompleted] = useState('');
  const [page, setPage] = useState(1);
  const rows = useParticipation(p.selected || null, { completed, page, pageSize: 25 });
  const columns: Column<ParticipationRowDto>[] = [
    { key: 'e', header: 'Employee', render: (r) => <span>{r.employee.firstName} {r.employee.lastName} <span className="text-xs text-slate-400">{r.employee.employeeCode}</span></span> },
    { key: 'd', header: 'Department (at opening)', hideBelow: 'sm', render: (r) => r.departmentName ?? '—' },
    { key: 'j', header: 'Job', hideBelow: 'md', render: (r) => r.jobTitle ?? '—' },
    { key: 'c', header: 'Completed', render: (r) => (r.completed ? <span className="text-emerald-700">Yes</span> : <span className="text-slate-400">No</span>) },
  ];
  return (<>
    <Picker p={p} hint="Who was invited and who completed — for follow-up only. There is no link from a person to their answers in an anonymous survey." />
    {p.survey && <Card><div className="border-b border-slate-200 p-4"><Select options={[{ value: 'false', label: 'Not completed' }, { value: 'true', label: 'Completed' }]} placeholder="Everyone" value={completed} onChange={(e) => { setCompleted(e.target.value); setPage(1); }} /></div>{rows.isLoading && <LoadingBlock />}<DataTable columns={columns} rows={rows.data?.data ?? []} rowKey={(r) => r.assignmentId} emptyTitle="Nobody matches" />{rows.data?.meta && <Pagination {...rows.data.meta} onPageChange={setPage} />}</Card>}
  </>);
}

export function EngagementReportsPage() {
  const { hasPermission } = useAuth();
  const p = useSurveyPicker(['CLOSED', 'ARCHIVED', 'OPEN']);
  return (<>
    <Picker p={p} hint="Survey history and aggregate reports. The Report Center datasets apply the same suppression." />
    <Card className="mb-4"><div className="border-b border-slate-200 px-4 py-3 text-sm font-semibold text-slate-900">Survey history</div><ul className="divide-y divide-slate-100 text-sm">{p.list.map((s) => <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2"><span><Link to={`/hrod/engagement/results?survey=${s.id}`} className="font-medium text-brand-700 underline">{s.name}</Link> <span className="text-xs text-slate-400">{s.code} · {titleCase(s.surveyType)} · {titleCase(s.responseMode)} · {titleCase(s.status)}{s.closedAt && ` · closed ${new Date(s.closedAt).toLocaleDateString()}`}</span></span><span className="tabular-nums text-slate-600">{s.completedCount}/{s.audienceCount}{s.responseRate !== null && ` · ${s.responseRate}%`}</span></li>)}</ul></Card>
    {hasPermission(PERMISSIONS.REPORTS_VIEW) && <p className="text-xs text-slate-500">Report Center datasets: <Link to="/hrm/reports/builder" className="text-brand-700 underline">Engagement survey summary</Link>, <Link to="/hrm/reports/builder" className="text-brand-700 underline">Engagement question summary</Link>, <Link to="/hrm/reports/builder" className="text-brand-700 underline">Engagement department summary</Link>. Aggregate only; suppressed groups carry no figures.</p>}
  </>);
}
