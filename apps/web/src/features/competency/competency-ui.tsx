import { Outlet } from 'react-router-dom';
import { PERMISSIONS, formatLevel, gapStatusLabel, type GapStatus } from '@hr/shared';
import { PageHeader } from '@/components/layout/PageHeader';
import { Tabs } from '@/components/ui/Tabs';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { useAuth } from '@/hooks/useAuth';

export { formatLevel, gapStatusLabel };

const CYCLE_LABEL: Record<string, string> = { DRAFT: 'Draft', ACTIVE: 'Active', REVIEW: 'In review', CLOSED: 'Closed' };
const CYCLE_TONE: Record<string, 'success' | 'neutral' | 'warning' | 'info'> = { DRAFT: 'neutral', ACTIVE: 'info', REVIEW: 'warning', CLOSED: 'success' };
export const CycleStatusBadge = ({ status }: { status: string }) => (
  <StatusBadge status={CYCLE_LABEL[status] ?? status} tone={CYCLE_TONE[status] ?? 'neutral'} />
);

const ASSESSMENT_LABEL: Record<string, string> = {
  DRAFT: 'Not started', ACTIVE: 'In progress', SELF_REVIEW: 'Self assessment', MANAGER_REVIEW: 'Waiting for reviewer', FINALIZED: 'Complete',
};
const ASSESSMENT_TONE: Record<string, 'success' | 'neutral' | 'warning' | 'info'> = {
  DRAFT: 'neutral', ACTIVE: 'info', SELF_REVIEW: 'warning', MANAGER_REVIEW: 'warning', FINALIZED: 'success',
};
export const AssessmentStatusBadge = ({ status }: { status: string }) => (
  <StatusBadge status={ASSESSMENT_LABEL[status] ?? status} tone={ASSESSMENT_TONE[status] ?? 'neutral'} />
);

const GAP_TONE: Record<GapStatus, 'success' | 'neutral' | 'warning' | 'info'> = {
  UNASSESSED: 'neutral', GAP: 'warning', NO_GAP: 'success', EXCEEDS_REQUIREMENT: 'info',
};
/**
 * A gap always reads in words as well as colour — and "not assessed" is its own thing, never shown as a shortfall.
 */
export const GapBadge = ({ status, gapNeeded }: { status: GapStatus; gapNeeded: number | null }) => (
  <StatusBadge
    status={status === 'GAP' && gapNeeded ? `${gapStatusLabel(status)} by ${gapNeeded}` : gapStatusLabel(status)}
    tone={GAP_TONE[status] ?? 'neutral'}
  />
);

/** Tab visibility follows capability, never a role name. The API enforces the same rules. */
export function useCompetencyTabs() {
  const { user, hasPermission } = useAuth();
  const canAssess = hasPermission(PERMISSIONS.COMPETENCY_ASSESS);
  const canManage = hasPermission(PERMISSIONS.COMPETENCY_MANAGE);
  return [
    !!user?.employee && { label: 'My competencies', to: '/hrd/competency', end: true },
    canAssess && { label: 'Team assessments', to: '/hrd/competency/assessments' },
    { label: 'Competencies', to: '/hrd/competency/library' },
    canManage && { label: 'Scales', to: '/hrd/competency/scales' },
    canManage && { label: 'Job profiles', to: '/hrd/competency/job-profiles' },
    canManage && { label: 'Cycles', to: '/hrd/competency/cycles' },
    { label: 'Skill gaps', to: '/hrd/competency/gaps' },
  ].filter(Boolean) as { label: string; to: string; end?: boolean }[];
}

export function CompetencyLayout() {
  const tabs = useCompetencyTabs();
  return (
    <>
      <PageHeader
        title="Competency"
        description="What each job needs, where people actually are, and the difference between the two. A level that nobody has assessed is unknown — never counted as zero."
      />
      {tabs.length > 1 && <div className="mb-5"><Tabs items={tabs} /></div>}
      <Outlet />
    </>
  );
}
