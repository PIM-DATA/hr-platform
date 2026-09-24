import { useEffect, useState } from 'react';
import { Outlet } from 'react-router-dom';
import { CAREER_READINESS_LABEL, NINE_BOX_CELLS, PERMISSIONS, nineBoxLabel, type CareerReadinessDto, type CareerReadinessStatus, type NineBoxDto } from '@hr/shared';
import { PageHeader } from '@/components/layout/PageHeader';
import { Tabs } from '@/components/ui/Tabs';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Alert } from '@/components/ui/Alert';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { useToast } from '@/components/ui/Toast';
import { useAuth } from '@/hooks/useAuth';
import { errorMessage } from '@/features/organization/shared';
import { GapBadge } from '@/features/competency/competency-ui';
import { useTalentMutations } from './talent.api';

type Tone = 'success' | 'neutral' | 'warning' | 'danger' | 'info';
const titleCase = (s: string) => s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, ' ');

const READINESS_TONE: Record<CareerReadinessStatus, Tone> = { READY_REQUIREMENTS_MET: 'success', GAPS_EXIST: 'warning', ASSESSMENT_REQUIRED: 'info', NO_REQUIREMENTS_DEFINED: 'neutral' };
export const ReadinessBadge = ({ status }: { status: CareerReadinessStatus }) => <StatusBadge status={CAREER_READINESS_LABEL[status]} tone={READINESS_TONE[status]} />;
const CYCLE_TONE: Record<string, Tone> = { DRAFT: 'neutral', ACTIVE: 'success', REVIEW: 'warning', CLOSED: 'neutral' };
export const CycleStatusBadge = ({ status }: { status: string }) => <StatusBadge status={titleCase(status)} tone={CYCLE_TONE[status] ?? 'neutral'} />;
const REVIEW_TONE: Record<string, Tone> = { ASSIGNED: 'warning', SUBMITTED: 'info', FINALIZED: 'success' };
export const ReviewStatusBadge = ({ status }: { status: string }) => <StatusBadge status={status === 'ASSIGNED' ? 'Waiting review' : titleCase(status)} tone={REVIEW_TONE[status] ?? 'neutral'} />;
const BUCKET_TONE: Record<string, Tone> = { LOW: 'neutral', MEDIUM: 'info', HIGH: 'success' };
export const BucketBadge = ({ value, label }: { value: string | null; label?: string }) => (value ? <StatusBadge status={label ?? titleCase(value)} tone={BUCKET_TONE[value] ?? 'neutral'} /> : <span className="text-slate-400">—</span>);
const READY_TONE: Record<string, Tone> = { READY_NOW: 'success', READY_SOON: 'info', DEVELOPING: 'warning' };
export const READINESS_LABEL: Record<string, string> = { READY_NOW: 'Ready now', READY_SOON: 'Ready soon', DEVELOPING: 'Developing' };
export const SuccessorReadinessBadge = ({ value }: { value: string }) => <StatusBadge status={READINESS_LABEL[value] ?? value} tone={READY_TONE[value] ?? 'neutral'} />;
const CRIT_TONE: Record<string, Tone> = { NORMAL: 'neutral', IMPORTANT: 'info', CRITICAL: 'danger' };
export const CriticalityBadge = ({ value }: { value: string }) => <StatusBadge status={titleCase(value)} tone={CRIT_TONE[value] ?? 'neutral'} />;
const PLAN_TONE: Record<string, Tone> = { DRAFT: 'neutral', ACTIVE: 'success', CLOSED: 'neutral' };
export const PlanStatusBadge = ({ status }: { status: string }) => <StatusBadge status={titleCase(status)} tone={PLAN_TONE[status] ?? 'neutral'} />;

export const Section = ({ title, children, action }: { title: string; children: React.ReactNode; action?: React.ReactNode }) => (
  <section><div className="mb-1 flex items-center justify-between"><h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">{title}</h3>{action}</div>{children}</section>
);
export const Stat = ({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) => (
  <div className="rounded-lg border border-slate-200 bg-white p-3"><div className="text-xs text-slate-500">{label}</div><div className="mt-0.5 text-xl font-semibold tabular-nums text-slate-900">{value}</div>{hint && <div className="text-[11px] text-slate-400">{hint}</div>}</div>
);

/** A target job's requirements against the person's latest levels. The wording says "requirements met", never "eligible". */
export function ReadinessTable({ readiness, compact }: { readiness: CareerReadinessDto; compact?: boolean }) {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <ReadinessBadge status={readiness.status} />
        <span className="text-slate-500">{readiness.summary.met} of {readiness.summary.requirements} requirements met · {readiness.summary.gaps} gap(s) · {readiness.summary.unassessed} not assessed</span>
      </div>
      {readiness.competencies.length === 0 ? <p className="text-sm text-slate-500">This job has no competency profile yet, so there is nothing to compare against.</p> : (
        <table className="w-full text-sm">
          <thead><tr className="text-left text-xs uppercase tracking-wide text-slate-500"><th className="py-1 pr-2">Competency</th><th className="py-1 pr-2">Current</th><th className="py-1 pr-2">Required</th><th className="py-1">Status</th></tr></thead>
          <tbody className="divide-y divide-slate-100">
            {readiness.competencies.map((c) => (
              <tr key={c.competencyId}>
                <td className="py-1.5 pr-2 text-slate-800">{c.competencyName}{!compact && <div className="text-xs text-slate-400">{c.competencyCode}</div>}</td>
                <td className="py-1.5 pr-2 tabular-nums">{c.currentLevel ?? <span className="text-slate-400">not assessed</span>}</td>
                <td className="py-1.5 pr-2 tabular-nums">{c.requiredLevel}</td>
                <td className="py-1.5"><GapBadge status={c.status} gapNeeded={c.gapNeeded} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="text-xs text-slate-500">Competency requirements only. "Requirements met" is a fact about assessed levels — it is not a promotion decision, and "not assessed" is not a gap.</p>
    </div>
  );
}

/** The 3×3 grid of counts. Potential rows top-down, performance columns left-right. Counts, never an order of people. */
export function NineBoxGrid({ box, onCell }: { box: NineBoxDto; onCell?: (cell: string) => void }) {
  const potentialRows = ['HIGH', 'MEDIUM', 'LOW'];
  const perfCols = ['LOW', 'MEDIUM', 'HIGH'];
  const count = (cell: string) => box.cells.find((c) => c.cell === cell)?.count ?? 0;
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-[auto_repeat(3,minmax(0,1fr))] gap-1.5 text-sm">
        <div />
        {perfCols.map((p) => <div key={p} className="text-center text-[11px] font-semibold uppercase tracking-wide text-slate-500">{titleCase(p)} performance</div>)}
        {potentialRows.map((pot) => (
          <>
            <div key={`${pot}-label`} className="flex items-center pr-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">{titleCase(pot)} potential</div>
            {perfCols.map((perf) => {
              const cell = `${perf}_PERFORMANCE_${pot}_POTENTIAL`;
              const n = count(cell);
              return (
                <button key={cell} type="button" disabled={!onCell || n === 0} onClick={() => onCell?.(cell)} title={nineBoxLabel(cell)} className={`flex h-16 flex-col items-center justify-center rounded-md border text-slate-900 ${n > 0 ? 'border-brand-200 bg-brand-50 hover:bg-brand-100' : 'border-slate-200 bg-white'} disabled:cursor-default`}>
                  <span className="text-xl font-semibold tabular-nums">{n}</span>
                </button>
              );
            })}
          </>
        ))}
      </div>
      <p className="text-xs text-slate-500">{box.total} review(s) in the cycle · {box.unplaced.noPotential} without a potential assessment yet · {box.unplaced.noPerformance} without finalized performance. Each cell is a count; nobody is ranked within or across cells.</p>
    </div>
  );
}
export { NINE_BOX_CELLS };

/** "Create development need": the handoff into Task 25, by explicit action. */
export function DevelopmentActionModal({ open, onClose, employeeId, employeeName, competencies, source }: { open: boolean; onClose: () => void; employeeId: string; employeeName: string; competencies: { id: string; name: string; gapNeeded: number | null }[]; source: { type: 'CAREER' | 'SUCCESSION' | 'TALENT_REVIEW'; id: string | null } }) {
  const m = useTalentMutations();
  const toast = useToast();
  const [competencyId, setCompetency] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState('NORMAL');
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (open) { setErr(null); const first = competencies[0]; setCompetency(first?.id ?? ''); setTitle(first ? `Develop ${first.name}` : ''); setDescription(''); setPriority('NORMAL'); } }, [open, competencies]);
  const submit = async () => {
    setErr(null);
    try { await m.createDevelopmentAction.mutateAsync({ employeeId, title, description: description || null, competencyId: competencyId || null, priority: priority as never, source }); toast.success('Development need created'); onClose(); } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <Modal open={open} onClose={onClose} title="Create development need" description={`For ${employeeName}. This raises a training need through Training & development; it enrols nobody and changes no competency level.`} size="md"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={submit} loading={m.createDevelopmentAction.isPending} disabled={!title.trim()}>Create need</Button></>}>
      <div className="space-y-3">
        {err && <Alert>{err}</Alert>}
        <Select label="Competency" options={competencies.map((c) => ({ value: c.id, label: c.gapNeeded ? `${c.name} (gap ${c.gapNeeded})` : c.name }))} placeholder="Not tied to a competency" value={competencyId} onChange={(e) => { setCompetency(e.target.value); const c = competencies.find((x) => x.id === e.target.value); if (c) setTitle(`Develop ${c.name}`); }} />
        <Input label="Title" required value={title} onChange={(e) => setTitle(e.target.value)} />
        <Textarea label="Description" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
        <Select label="Priority" options={['LOW', 'NORMAL', 'HIGH'].map((p) => ({ value: p, label: titleCase(p) }))} value={priority} onChange={(e) => setPriority(e.target.value)} />
      </div>
    </Modal>
  );
}

/** Tab visibility follows capability, never a role name. The API enforces the same rules. */
export function useTalentTabs() {
  const { user, hasPermission } = useAuth();
  const teamScope = user?.dataScope === 'TEAM' || user?.dataScope === 'ALL';
  const talentView = hasPermission(PERMISSIONS.TALENT_VIEW) || hasPermission(PERMISSIONS.TALENT_MANAGE);
  return [
    hasPermission(PERMISSIONS.CAREER_VIEW) && !!user?.employee && { label: 'My career', to: '/hrd/career', end: true },
    talentView && teamScope && !hasPermission(PERMISSIONS.TALENT_MANAGE) && { label: 'Team', to: '/hrd/career/team' },
    hasPermission(PERMISSIONS.CAREER_MANAGE) && { label: 'Career paths', to: '/hrd/career/paths' },
    talentView && { label: 'Talent reviews', to: '/hrd/career/talent' },
    talentView && { label: 'Talent pools', to: '/hrd/career/pools' },
    (hasPermission(PERMISSIONS.SUCCESSION_VIEW) || hasPermission(PERMISSIONS.SUCCESSION_MANAGE)) && { label: 'Succession', to: '/hrd/career/succession' },
    hasPermission(PERMISSIONS.TALENT_VIEW_REPORTS) && { label: 'Reports', to: '/hrd/career/reports' },
  ].filter(Boolean) as { label: string; to: string; end?: boolean }[];
}

export function TalentLayout() {
  const tabs = useTalentTabs();
  return (
    <>
      <PageHeader title="Career & talent" description="Where people could go, what the target roles ask for, and what the organization has recorded about potential and succession. Decision support: the system shows facts and records people's judgments; it promotes nobody, ranks nobody and picks no successor." />
      {tabs.length > 1 && <div className="mb-5"><Tabs items={tabs} /></div>}
      <Outlet />
    </>
  );
}
