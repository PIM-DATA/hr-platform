import { useState } from 'react';
import { Outlet } from 'react-router-dom';
import { PERMISSIONS, type StageHistoryDto } from '@hr/shared';
import { PageHeader } from '@/components/layout/PageHeader';
import { Tabs } from '@/components/ui/Tabs';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { Input } from '@/components/ui/Input';
import { useAuth } from '@/hooks/useAuth';
import { useDebounce } from '@/hooks/useDebounce';
import { useInterviewerOptions, type InterviewerOption } from './recruitment.api';

type Tone = 'success' | 'neutral' | 'warning' | 'danger' | 'info';
const titleCase = (s: string) => s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, ' ');

const REQ_TONE: Record<string, Tone> = { DRAFT: 'neutral', PENDING_APPROVAL: 'warning', APPROVED: 'success', REJECTED: 'danger', CANCELLED: 'neutral', CLOSED: 'neutral' };
export const RequisitionStatusBadge = ({ status }: { status: string }) => <StatusBadge status={status === 'PENDING_APPROVAL' ? 'Awaiting approval' : titleCase(status)} tone={REQ_TONE[status] ?? 'neutral'} />;

const OPENING_TONE: Record<string, Tone> = { DRAFT: 'neutral', OPEN: 'success', ON_HOLD: 'warning', CLOSED: 'neutral', CANCELLED: 'neutral' };
export const OpeningStatusBadge = ({ status }: { status: string }) => <StatusBadge status={titleCase(status)} tone={OPENING_TONE[status] ?? 'neutral'} />;

const STAGE_TONE: Record<string, Tone> = { APPLIED: 'neutral', SCREENING: 'info', INTERVIEW: 'info', OFFER: 'warning', HIRED: 'success', REJECTED: 'danger', WITHDRAWN: 'neutral' };
export const StageBadge = ({ stage }: { stage: string }) => <StatusBadge status={titleCase(stage)} tone={STAGE_TONE[stage] ?? 'neutral'} />;

const CANDIDATE_TONE: Record<string, Tone> = { ACTIVE: 'success', HIRED: 'info', ARCHIVED: 'neutral' };
export const CandidateStatusBadge = ({ status }: { status: string }) => <StatusBadge status={titleCase(status)} tone={CANDIDATE_TONE[status] ?? 'neutral'} />;

const INTERVIEW_TONE: Record<string, Tone> = { SCHEDULED: 'info', COMPLETED: 'success', CANCELLED: 'neutral' };
export const InterviewStatusBadge = ({ status }: { status: string }) => <StatusBadge status={titleCase(status)} tone={INTERVIEW_TONE[status] ?? 'neutral'} />;

const OFFER_TONE: Record<string, Tone> = { DRAFT: 'neutral', PENDING_APPROVAL: 'warning', APPROVED: 'info', SENT: 'info', ACCEPTED: 'success', DECLINED: 'danger', WITHDRAWN: 'neutral' };
export const OfferStatusBadge = ({ status }: { status: string }) => <StatusBadge status={status === 'PENDING_APPROVAL' ? 'Awaiting approval' : titleCase(status)} tone={OFFER_TONE[status] ?? 'neutral'} />;

const RECOMMENDATION_TONE: Record<string, Tone> = { PROCEED: 'success', HOLD: 'warning', DO_NOT_PROCEED: 'danger' };
export const RecommendationBadge = ({ value }: { value: string }) => <StatusBadge status={titleCase(value)} tone={RECOMMENDATION_TONE[value] ?? 'neutral'} />;

export const SOURCE_LABEL: Record<string, string> = { MANUAL: 'Manual entry', REFERRAL: 'Referral', JOB_BOARD: 'Job board', AGENCY: 'Agency', INTERNAL: 'Internal', WALK_IN: 'Walk-in', OTHER: 'Other' };
export const REASON_LABEL: Record<string, string> = { NEW_HEADCOUNT: 'New headcount', REPLACEMENT: 'Replacement', TEMPORARY: 'Temporary', OTHER: 'Other' };
export const REJECTION_LABEL: Record<string, string> = { NOT_A_FIT: 'Not a fit for the role', EXPERIENCE: 'Experience', COMPENSATION: 'Compensation', POSITION_FILLED: 'Position filled', NO_RESPONSE: 'No response', OTHER: 'Other' };
export const label = (map: Record<string, string>, key: string | null | undefined) => (key ? map[key] ?? titleCase(key) : '—');

export const fmtDateTime = (iso: string, timezone: string) => {
  try { return new Intl.DateTimeFormat('en-GB', { timeZone: timezone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso)); } catch { return iso; }
};

export const Section = ({ title, children, action }: { title: string; children: React.ReactNode; action?: React.ReactNode }) => (
  <section>
    <div className="mb-1 flex items-center justify-between"><h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">{title}</h3>{action}</div>
    {children}
  </section>
);

export const Stat = ({ label, value }: { label: string; value: React.ReactNode }) => (
  <div className="rounded-lg border border-slate-200 bg-white p-3"><div className="text-xs text-slate-500">{label}</div><div className="mt-0.5 text-xl font-semibold tabular-nums text-slate-900">{value}</div></div>
);

/** The pipeline as a row of counts. A picture of where applications are, not of who is ahead. */
export function Funnel({ funnel }: { funnel: { stage: string; count: number }[] }) {
  const max = Math.max(1, ...funnel.map((f) => f.count));
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
      {funnel.map((f) => (
        <div key={f.stage} className="rounded-md border border-slate-200 bg-white p-2">
          <div className="text-[11px] uppercase tracking-wide text-slate-500">{titleCase(f.stage)}</div>
          <div className="text-lg font-semibold tabular-nums text-slate-900">{f.count}</div>
          <div className="mt-1 h-1.5 rounded bg-slate-100"><div className="h-1.5 rounded bg-brand-500" style={{ width: `${Math.round((f.count / max) * 100)}%` }} /></div>
        </div>
      ))}
    </div>
  );
}

/** Append-only history, oldest first: who moved the application, when, and why. */
export function StageTimeline({ history }: { history: StageHistoryDto[] }) {
  if (!history.length) return <p className="text-sm text-slate-500">No history.</p>;
  return (
    <ol className="space-y-1.5 text-sm">
      {history.map((h, i) => (
        <li key={i} className="flex flex-wrap items-baseline gap-x-2 text-slate-700">
          <span className="text-xs tabular-nums text-slate-400">{h.changedAt.slice(0, 16).replace('T', ' ')}</span>
          <span>{h.fromStage ? `${titleCase(h.fromStage)} → ` : ''}<span className="font-medium">{titleCase(h.toStage)}</span></span>
          <span className="text-xs text-slate-500">by {h.changedBy ?? 'unknown'}</span>
          {h.reason && <span className="text-xs text-slate-500">· {h.reason}</span>}
        </li>
      ))}
    </ol>
  );
}

/** Pick interviewers by name or employee code. Only users who can sign in appear — feedback needs a login. */
export function InterviewerPicker({ value, onChange }: { value: InterviewerOption[]; onChange: (next: InterviewerOption[]) => void }) {
  const [term, setTerm] = useState('');
  const search = useDebounce(term, 250);
  const options = useInterviewerOptions(search, search.trim().length > 0);
  const add = (o: InterviewerOption) => { if (!value.some((v) => v.userId === o.userId)) onChange([...value, o]); setTerm(''); };
  return (
    <div className="space-y-2">
      <Input label="Interviewers" placeholder="Search by name or employee code…" value={term} onChange={(e) => setTerm(e.target.value)} />
      {options.data && term && (
        <ul className="max-h-40 divide-y divide-slate-100 overflow-auto rounded-md border border-slate-200 bg-white text-sm">
          {options.data.length === 0 && <li className="px-3 py-2 text-slate-500">No matching users</li>}
          {options.data.map((o) => (
            <li key={o.userId}><button type="button" className="flex w-full items-center justify-between px-3 py-2 text-left hover:bg-slate-50" onClick={() => add(o)}><span>{o.name}</span><span className="text-xs text-slate-400">{o.employeeCode}{o.departmentName && ` · ${o.departmentName}`}</span></button></li>
          ))}
        </ul>
      )}
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {value.map((v) => (
            <span key={v.userId} className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2.5 py-1 text-xs text-slate-700">{v.name}<button type="button" aria-label={`Remove ${v.name}`} className="text-slate-400 hover:text-slate-700" onClick={() => onChange(value.filter((x) => x.userId !== v.userId))}>×</button></span>
          ))}
        </div>
      )}
    </div>
  );
}

/** Tab visibility follows capability, never a role name. The API enforces the same rules. */
export function useRecruitmentTabs() {
  const { hasPermission } = useAuth();
  const view = hasPermission(PERMISSIONS.RECRUITMENT_VIEW) || hasPermission(PERMISSIONS.RECRUITMENT_MANAGE);
  const manage = hasPermission(PERMISSIONS.RECRUITMENT_MANAGE);
  return [
    view && { label: 'Dashboard', to: '/hrm/recruitment', end: true },
    hasPermission(PERMISSIONS.WORKFLOW_APPROVE) && { label: 'Approvals', to: '/hrm/recruitment/approvals' },
    view && { label: 'Requisitions', to: '/hrm/recruitment/requisitions' },
    view && { label: 'Openings', to: '/hrm/recruitment/openings' },
    view && { label: 'Candidates', to: '/hrm/recruitment/candidates' },
    view && { label: 'Applications', to: '/hrm/recruitment/applications' },
    (hasPermission(PERMISSIONS.RECRUITMENT_INTERVIEW) || manage) && { label: 'Interviews', to: '/hrm/recruitment/interviews' },
    view && { label: 'Offers', to: '/hrm/recruitment/offers' },
    manage && { label: 'Reports', to: '/hrm/recruitment/reports' },
  ].filter(Boolean) as { label: string; to: string; end?: boolean }[];
}

export function RecruitmentLayout() {
  const tabs = useRecruitmentTabs();
  return (
    <>
      <PageHeader title="Recruitment" description="Requisitions, openings, candidates and the pipeline between them. Every stage move, offer and hire is a person's decision — the system records it and ranks nobody." />
      {tabs.length > 1 && <div className="mb-5"><Tabs items={tabs} /></div>}
      <Outlet />
    </>
  );
}
