import { useState } from 'react';
import { Download } from 'lucide-react';
import type { BreakdownRowDto, ResultsFilter, SurveyResultsDto, VisibleResultDto } from '@hr/shared';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Alert';
import { Select } from '@/components/ui/Select';
import { LoadingBlock } from '@/components/ui/Spinner';
import { useToast } from '@/components/ui/Toast';
import { errorMessage } from '@/features/organization/shared';
import { downloadResultsCsv, useBreakdown, useEngagementOptions, useSurveyResults } from './engagement.api';
import { ModeBadge, Stat, SUPPRESSED_TEXT, SurveyStatusBadge } from './engagement-ui';

/** Shared results renderer: participation, eNPS, themes, per-question distributions and a breakdown. Suppression is whatever the server says. */
export function ResultsView({ surveyId, code, allowFilters, allowCsv }: { surveyId: string; code: string; allowFilters: boolean; allowCsv: boolean }) {
  const [filter, setFilter] = useState<ResultsFilter>({});
  const [by, setBy] = useState<'department' | 'job' | 'organization'>('department');
  const options = useEngagementOptions(allowFilters);
  const r = useSurveyResults(surveyId, filter);
  const bd = useBreakdown(surveyId, by, filter);
  const toast = useToast();
  const [exporting, setExporting] = useState(false);
  const csv = async () => { setExporting(true); try { await downloadResultsCsv(surveyId, code, filter); } catch (e) { toast.error(errorMessage(e)); } finally { setExporting(false); } };
  if (r.isLoading) return <LoadingBlock />;
  if (r.isError || !r.data) return <Alert>Could not load results.</Alert>;
  const d = r.data;
  return (
    <div className="space-y-4">
      <Card>
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 px-4 py-3 text-sm"><span className="font-semibold text-slate-900">{d.survey.name}</span><ModeBadge mode={d.survey.responseMode} /><SurveyStatusBadge status={d.survey.status} /><span className="text-xs text-slate-400">anonymity threshold {d.survey.minimumAnonymousGroupSize}{d.scope.teamScoped && ' · your team only'}</span>{allowCsv && <span className="ml-auto"><Button size="sm" variant="secondary" onClick={csv} loading={exporting}><Download className="h-3.5 w-3.5" /> CSV</Button></span>}</div>
        {allowFilters && (
          <div className="grid grid-cols-1 gap-3 border-b border-slate-200 p-4 sm:grid-cols-4">
            <Select label="Department" options={(options.data?.departments ?? []).map((x) => ({ value: x.id, label: x.name }))} placeholder="All" value={filter.departmentId ?? ''} onChange={(e) => setFilter({ ...filter, departmentId: e.target.value || undefined })} />
            <Select label="Job" options={(options.data?.jobs ?? []).map((x) => ({ value: x.id, label: x.title }))} placeholder="All" value={filter.jobId ?? ''} onChange={(e) => setFilter({ ...filter, jobId: e.target.value || undefined })} />
            <Select label="Organization" options={(options.data?.organizations ?? []).map((x) => ({ value: x.id, label: x.name }))} placeholder="All" value={filter.organizationId ?? ''} onChange={(e) => setFilter({ ...filter, organizationId: e.target.value || undefined })} />
            <Select label="Breakdown by" options={[{ value: 'department', label: 'Department' }, { value: 'job', label: 'Job' }, { value: 'organization', label: 'Organization' }]} value={by} onChange={(e) => setBy(e.target.value as typeof by)} />
          </div>
        )}
        <div className="grid grid-cols-2 gap-3 p-4 md:grid-cols-4">
          <Stat label="Assigned" value={d.result.suppressed && (d.scope.filtered || d.scope.teamScoped) ? '—' : d.participation.assigned} />
          <Stat label="Completed" value={d.result.suppressed && (d.scope.filtered || d.scope.teamScoped) ? '—' : d.participation.completed} />
          <Stat label="Response rate" value={d.participation.responseRate === null ? '—' : `${d.participation.responseRate}%`} />
          <Stat label="eNPS" value={d.result.suppressed ? '—' : d.result.enps ? (d.result.enps.score ?? '—') : 'n/a'} hint={d.result.suppressed ? 'hidden' : d.result.enps ? `${d.result.enps.promoters} promoters · ${d.result.enps.passives} passives · ${d.result.enps.detractors} detractors` : 'no eNPS question'} />
        </div>
      </Card>
      {d.result.suppressed ? <Card className="p-8 text-center text-sm text-slate-600" data-testid="suppressed">{SUPPRESSED_TEXT}<div className="mt-1 text-xs text-slate-400">{d.result.reason}</div></Card> : <VisibleResults r={d.result} />}
      <Card>
        <div className="border-b border-slate-200 px-4 py-3 text-sm font-semibold text-slate-900">By {by}</div>
        {bd.isLoading && <LoadingBlock />}
        {bd.data && <BreakdownTable rows={bd.data} />}
      </Card>
    </div>
  );
}

function VisibleResults({ r }: { r: VisibleResultDto }) {
  return (
    <div className="space-y-4">
      {r.themes.length > 0 && <Card><div className="border-b border-slate-200 px-4 py-3 text-sm font-semibold text-slate-900">Themes <span className="text-xs font-normal text-slate-400">averages of questions on the same scale only</span></div><ul className="divide-y divide-slate-100 text-sm">{r.themes.map((t) => <li key={`${t.theme}-${t.scale}`} className="flex items-center justify-between px-4 py-2"><span>{t.theme} <span className="text-xs text-slate-400">{t.scale} · {t.questionCount} question(s)</span></span><span className="tabular-nums font-semibold">{t.average ?? '—'}</span></li>)}</ul></Card>}
      <Card>
        <div className="border-b border-slate-200 px-4 py-3 text-sm font-semibold text-slate-900">Questions <span className="text-xs font-normal text-slate-400">{r.responseCount} responses</span></div>
        <ul className="divide-y divide-slate-100">
          {r.questions.map((q) => (
            <li key={q.questionId} className="px-4 py-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2"><span className="font-medium text-slate-900">{q.text}{q.isEnpsPrimary && <span className="ml-2 rounded bg-brand-50 px-1.5 text-[10px] text-brand-700">eNPS</span>}</span><span className="text-xs text-slate-500">{q.responseCount} answers{q.average !== null && <> · avg <b className="tabular-nums">{q.average}</b></>}{q.commentCount !== null && <> · {q.commentCount} comments</>}</span></div>
              {q.distribution.length > 0 && (
                <div className="mt-2 space-y-1">{q.distribution.map((b) => <div key={b.value} className="flex items-center gap-2 text-xs"><span className="w-24 shrink-0 truncate text-slate-500" title={b.label ?? b.value}>{b.label ?? b.value}</span><div className="h-2 flex-1 rounded bg-slate-100"><div className="h-2 rounded bg-brand-500" style={{ width: `${b.pct}%` }} /></div><span className="w-16 text-right tabular-nums text-slate-600">{b.count} · {b.pct}%</span></div>)}</div>
              )}
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

function BreakdownTable({ rows }: { rows: BreakdownRowDto[] }) {
  return (
    <div className="overflow-x-auto"><table className="min-w-full text-sm"><thead className="bg-slate-50"><tr>{['Group', 'Assigned', 'Completed', 'Rate', 'eNPS', 'Themes'].map((h) => <th key={h} className="px-4 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">{h}</th>)}</tr></thead>
      <tbody className="divide-y divide-slate-100">{rows.map((row) => <tr key={row.key}><td className="px-4 py-2 font-medium text-slate-900">{row.name}</td>{row.result.suppressed ? <td colSpan={5} className="px-4 py-2 text-slate-500">{SUPPRESSED_TEXT}</td> : <><td className="px-4 py-2 tabular-nums">{row.assigned}</td><td className="px-4 py-2 tabular-nums">{row.completed}</td><td className="px-4 py-2 tabular-nums">{row.responseRate ?? '—'}%</td><td className="px-4 py-2 tabular-nums">{row.result.enps?.score ?? '—'}</td><td className="px-4 py-2 text-xs text-slate-600">{row.result.themes.map((t) => `${t.theme} ${t.average ?? '—'}`).join(' · ') || '—'}</td></>}</tr>)}</tbody></table></div>
  );
}
export type { SurveyResultsDto };
