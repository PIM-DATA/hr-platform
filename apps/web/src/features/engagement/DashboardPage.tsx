import { Link } from 'react-router-dom';
import { Card } from '@/components/ui/Card';
import { Alert } from '@/components/ui/Alert';
import { LoadingBlock } from '@/components/ui/Spinner';
import { useEngagementDashboard } from './engagement.api';
import { ModeBadge, Stat, SurveyStatusBadge } from './engagement-ui';

export function EngagementDashboardPage() {
  const d = useEngagementDashboard();
  if (d.isLoading) return <LoadingBlock />;
  if (d.isError || !d.data) return <Alert>Could not load the dashboard.</Alert>;
  const x = d.data;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Open surveys" value={x.openSurveys} /><Stat label="Closed surveys" value={x.closedSurveys} hint={`${x.draftSurveys} in draft`} />
        <Stat label="Participation (open)" value={x.openResponseRate === null ? '—' : `${x.openResponseRate}%`} hint={`${x.completedOpen} of ${x.assignedOpen} answered`} />
        <Stat label="Latest eNPS" value={x.latestEnps ? (x.latestEnps.suppressed ? 'hidden' : (x.latestEnps.score ?? '—')) : '—'} hint={x.latestEnps?.surveyName} />
      </div>
      <Card>
        <div className="border-b border-slate-200 px-4 py-3 text-sm font-semibold text-slate-900">Recent surveys</div>
        {x.recent.length === 0 && <p className="px-4 py-4 text-sm text-slate-400">No surveys have been opened yet.</p>}
        <ul className="divide-y divide-slate-100 text-sm">{x.recent.map((s) => <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2"><span className="flex items-center gap-2"><Link to={`/hrod/engagement/results?survey=${s.id}`} className="font-medium text-brand-700 underline">{s.name}</Link><ModeBadge mode={s.responseMode} /><SurveyStatusBadge status={s.status} /></span><span className="tabular-nums text-slate-600">{s.responseRate ?? '—'}% responded</span></li>)}</ul>
      </Card>
      <p className="text-xs text-slate-400">Figures are participation and aggregates. There is no employee leaderboard, no team ranking and no score that feeds performance, talent or pay.</p>
    </div>
  );
}
