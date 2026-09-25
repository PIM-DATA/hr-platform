import { Outlet } from 'react-router-dom';
import { PERMISSIONS, enrollmentStatusLabel, formatDuration, type TrainingEnrollmentStatus } from '@hr/shared';
import { PageHeader } from '@/components/layout/PageHeader';
import { Tabs } from '@/components/ui/Tabs';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { useAuth } from '@/hooks/useAuth';

export { formatDuration, enrollmentStatusLabel };

type Tone = 'success' | 'neutral' | 'warning' | 'danger' | 'info';

const NEED_LABEL: Record<string, string> = { OPEN: 'Open', PLANNED: 'Planned', IN_PROGRESS: 'In progress', FULFILLED: 'Fulfilled', CANCELLED: 'Cancelled' };
const NEED_TONE: Record<string, Tone> = { OPEN: 'warning', PLANNED: 'info', IN_PROGRESS: 'info', FULFILLED: 'success', CANCELLED: 'neutral' };
export const NeedStatusBadge = ({ status }: { status: string }) => <StatusBadge status={NEED_LABEL[status] ?? status} tone={NEED_TONE[status] ?? 'neutral'} />;

const SESSION_LABEL: Record<string, string> = { DRAFT: 'Draft', OPEN: 'Open for booking', IN_PROGRESS: 'Running', COMPLETED: 'Completed', CANCELLED: 'Cancelled' };
const SESSION_TONE: Record<string, Tone> = { DRAFT: 'neutral', OPEN: 'info', IN_PROGRESS: 'warning', COMPLETED: 'success', CANCELLED: 'danger' };
export const SessionStatusBadge = ({ status }: { status: string }) => <StatusBadge status={SESSION_LABEL[status] ?? status} tone={SESSION_TONE[status] ?? 'neutral'} />;

const ENROLLMENT_TONE: Record<TrainingEnrollmentStatus, Tone> = { ENROLLED: 'info', ATTENDED: 'info', COMPLETED: 'success', FAILED: 'danger', NO_SHOW: 'warning', CANCELLED: 'neutral' };
export const EnrollmentStatusBadge = ({ status }: { status: TrainingEnrollmentStatus }) => (
  <StatusBadge status={enrollmentStatusLabel(status)} tone={ENROLLMENT_TONE[status] ?? 'neutral'} />
);

const IDP_LABEL: Record<string, string> = { DRAFT: 'Draft', ACTIVE: 'Active', COMPLETED: 'Completed', CANCELLED: 'Cancelled' };
const IDP_TONE: Record<string, Tone> = { DRAFT: 'neutral', ACTIVE: 'info', COMPLETED: 'success', CANCELLED: 'neutral' };
export const IdpStatusBadge = ({ status }: { status: string }) => <StatusBadge status={IDP_LABEL[status] ?? status} tone={IDP_TONE[status] ?? 'neutral'} />;

const ITEM_LABEL: Record<string, string> = { PLANNED: 'Planned', IN_PROGRESS: 'In progress', COMPLETED: 'Completed', CANCELLED: 'Cancelled' };
const ITEM_TONE: Record<string, Tone> = { PLANNED: 'neutral', IN_PROGRESS: 'info', COMPLETED: 'success', CANCELLED: 'neutral' };
export const ItemStatusBadge = ({ status }: { status: string }) => <StatusBadge status={ITEM_LABEL[status] ?? status} tone={ITEM_TONE[status] ?? 'neutral'} />;

const DELIVERY_LABEL: Record<string, string> = { CLASSROOM: 'Classroom', VIRTUAL: 'Virtual', SELF_STUDY: 'Self-study', BLENDED: 'Blended', OTHER: 'Other' };
export const deliveryLabel = (method: string) => DELIVERY_LABEL[method] ?? method;

const DEVELOPMENT_LABEL: Record<string, string> = { TRAINING: 'Training', OJT: 'On the job', COACHING: 'Coaching', MENTORING: 'Mentoring', SELF_STUDY: 'Self-study', PROJECT: 'Project', OTHER: 'Other' };
export const developmentLabel = (type: string) => DEVELOPMENT_LABEL[type] ?? type;

/** A session's start, read in the session's own timezone — never the browser's, never a fixed offset. */
export function formatSessionTime(iso: string, timezone: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone: timezone });
}

export function ProgressBar({ percent }: { percent: number }) {
  return (
    <span className="flex items-center gap-2">
      <span className="h-1.5 w-20 overflow-hidden rounded-full bg-slate-200" aria-hidden>
        <span className="block h-full rounded-full bg-brand-500" style={{ width: `${Math.min(100, Math.max(0, percent))}%` }} />
      </span>
      <span className="tabular-nums text-xs text-slate-600">{percent}%</span>
    </span>
  );
}

/** Tab visibility follows capability, never a role name. The API enforces the same rules. */
export function useTrainingTabs() {
  const { user, hasPermission } = useAuth();
  const manage = hasPermission(PERMISSIONS.TRAINING_MANAGE);
  const teamScope = user?.dataScope === 'TEAM' || user?.dataScope === 'ALL';
  return [
    !!user?.employee && hasPermission(PERMISSIONS.TRAINING_VIEW) && { label: 'My development', to: '/hrd/training', end: true },
    hasPermission(PERMISSIONS.TRAINING_VIEW) && teamScope && !manage && { label: 'Team development', to: '/hrd/training/team' },
    manage && { label: 'Training needs', to: '/hrd/training/needs' },
    hasPermission(PERMISSIONS.TRAINING_VIEW) && { label: 'Courses', to: '/hrd/training/courses' },
    hasPermission(PERMISSIONS.TRAINING_VIEW) && { label: 'Sessions', to: '/hrd/training/sessions' },
    hasPermission(PERMISSIONS.IDP_MANAGE) && { label: 'Development plans', to: '/hrd/training/idps' },
    (hasPermission(PERMISSIONS.OJT_VIEW) || hasPermission(PERMISSIONS.OJT_MANAGE)) && { label: 'OJT', to: '/hrd/training/ojt' },
    (hasPermission(PERMISSIONS.LEARNING_PATH_VIEW) || hasPermission(PERMISSIONS.LEARNING_PATH_MANAGE)) && { label: 'Learning paths', to: '/hrd/training/paths' },
    (hasPermission(PERMISSIONS.CERTIFICATION_VIEW) || hasPermission(PERMISSIONS.CERTIFICATION_MANAGE)) && { label: 'Certifications', to: '/hrd/training/certifications' },
    (manage || hasPermission(PERMISSIONS.LEARNING_VIEW_REPORTS) || hasPermission(PERMISSIONS.OJT_MANAGE) || hasPermission(PERMISSIONS.LEARNING_PATH_MANAGE) || hasPermission(PERMISSIONS.CERTIFICATION_MANAGE)) && { label: 'Reports', to: '/hrd/training/reports' },
  ].filter(Boolean) as { label: string; to: string; end?: boolean }[];
}

export function TrainingLayout() {
  const tabs = useTrainingTabs();
  return (
    <>
      <PageHeader
        title="Training & development"
        description="From a competency gap to a development need, a course, on-the-job training, a learning path, a certification and a plan. Completing any of them is development history — it never changes a competency level by itself."
      />
      {tabs.length > 1 && <div className="mb-5"><Tabs items={tabs} /></div>}
      <Outlet />
    </>
  );
}
