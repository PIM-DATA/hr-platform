import { Outlet } from 'react-router-dom';
import { PERMISSIONS } from '@hr/shared';
import { PageHeader } from '@/components/layout/PageHeader';
import { Tabs } from '@/components/ui/Tabs';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { useAuth } from '@/hooks/useAuth';

export const titleCase = (s: string) => s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, ' ');
export function SurveyStatusBadge({ status }: { status: string }) { return <StatusBadge status={titleCase(status)} tone={status === 'OPEN' ? 'info' : status === 'CLOSED' ? 'success' : 'neutral'} />; }
export function ModeBadge({ mode }: { mode: string }) { return <StatusBadge status={mode === 'ANONYMOUS' ? 'Anonymous' : 'Identified'} tone={mode === 'ANONYMOUS' ? 'success' : 'warning'} />; }
export function Stat({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return <div className="rounded-lg border border-slate-200 bg-white p-4"><div className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</div><div className="mt-1 text-2xl font-semibold tabular-nums text-slate-900">{value}</div>{hint && <div className="mt-0.5 text-xs text-slate-400">{hint}</div>}</div>;
}
export const SUPPRESSED_TEXT = 'ผลลัพธ์ถูกซ่อนเพื่อรักษาความเป็นส่วนตัว (results hidden to protect respondents)';

/** Tabs follow capability. Everyone with respond sees "My surveys"; results readers see the aggregate screens; managers see their team. */
export function useEngagementTabs() {
  const { hasPermission, user } = useAuth();
  const respond = hasPermission(PERMISSIONS.ENGAGEMENT_RESPOND) && !!user?.employee;
  const manage = hasPermission(PERMISSIONS.ENGAGEMENT_MANAGE);
  const view = hasPermission(PERMISSIONS.ENGAGEMENT_VIEW_RESULTS) || manage;
  const team = view && user?.dataScope === 'TEAM';
  return [
    respond && { label: 'My surveys', to: '/hrod/engagement', end: true },
    team && { label: 'Team engagement', to: '/hrod/engagement/team' },
    view && !team && { label: 'Dashboard', to: '/hrod/engagement/dashboard' },
    view && !team && { label: 'Surveys', to: '/hrod/engagement/surveys' },
    manage && { label: 'Question bank', to: '/hrod/engagement/questions' },
    view && !team && { label: 'Results', to: '/hrod/engagement/results' },
    manage && { label: 'Comments', to: '/hrod/engagement/comments' },
    manage && { label: 'Participation', to: '/hrod/engagement/participation' },
    view && !team && { label: 'Reports', to: '/hrod/engagement/reports' },
  ].filter(Boolean) as { label: string; to: string; end?: boolean }[];
}
export function EngagementLayout() {
  const tabs = useEngagementTabs();
  return (
    <>
      <PageHeader title="Engagement" description="Surveys, pulse checks and eNPS. Feedback is collected, aggregated and reported; it is never a performance score, a talent rating or evidence in any HR process." />
      {tabs.length > 1 && <div className="mb-5"><Tabs items={tabs} /></div>}
      <Outlet />
    </>
  );
}
