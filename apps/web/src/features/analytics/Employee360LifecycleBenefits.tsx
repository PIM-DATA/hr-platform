import { Link } from 'react-router-dom';
import type { Employee360Dto } from '@hr/shared';
import { Card, CardHeader } from '@/components/ui/Card';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { formatDate } from '@/lib/format';

/**
 * Lifecycle (Task 34) and benefits (Task 36) panels of the Employee 360. Both render only the section the server
 * returned: the API applies each module's own rule (the subject, an organization-wide administrator; never a
 * manager's team scope for benefits) and never sends a note, a reason, a comment, a description or a reference.
 */
type S = Employee360Dto['sections'];
const titleCase = (s: string) => s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, ' ');
type Tone = 'success' | 'neutral' | 'warning' | 'danger' | 'info';
const TONE: Record<string, Tone> = { DRAFT: 'neutral', ACTIVE: 'info', COMPLETED: 'success', CANCELLED: 'neutral', PENDING_REVIEW: 'warning', EXTENDED: 'warning', PASSED: 'success', NOT_PASSED: 'danger', ENROLLED: 'success', WAIVED: 'neutral', ENDED: 'neutral', PENDING_APPROVAL: 'warning', READY_FOR_PAYMENT: 'info', SENT_TO_PAYROLL: 'info', PAID: 'success', REJECTED: 'danger' };
const Badge = ({ status }: { status: string }) => <StatusBadge status={titleCase(status)} tone={TONE[status] ?? 'neutral'} />;
const Empty = ({ text }: { text: string }) => <p className="px-5 py-4 text-sm text-slate-400">{text}</p>;

export function LifecycleSection({ s, selfLinks }: { s: S; selfLinks: boolean }) {
  const l = s.lifecycle;
  if (!l) return <Card><Empty text="No lifecycle section is available to you for this employee." /></Card>;
  const base = selfLinks ? '/hrm/lifecycle' : '/hrm/lifecycle';
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
      <Card><CardHeader title="Onboarding" description="Checklist progress is bookkeeping, not a readiness verdict." />
        {l.onboarding ? <dl className="grid grid-cols-2 gap-3 px-5 py-3 text-sm"><div><dt className="text-xs text-slate-500">Status</dt><dd><Badge status={l.onboarding.status} /></dd></div><div><dt className="text-xs text-slate-500">Start</dt><dd className="text-slate-900">{l.onboarding.startDate}</dd></div><div><dt className="text-xs text-slate-500">Progress</dt><dd className="tabular-nums text-slate-900">{l.onboarding.progressPct}%</dd></div><div><dt className="text-xs text-slate-500">Completed</dt><dd className="text-slate-900">{l.onboarding.completedAt ? formatDate(l.onboarding.completedAt) : '—'}</dd></div></dl> : <Empty text="No onboarding plan." />}
        {l.onboarding && <p className="px-5 pb-3 text-xs"><Link className="text-brand-700 underline" to={selfLinks ? base : `${base}/onboarding?open=${l.onboarding.id}`}>Open onboarding</Link></p>}
      </Card>
      <Card><CardHeader title="Probation" description="Status, dates and the recorded outcome. Review comments stay in the module." />
        {l.probation ? <dl className="grid grid-cols-2 gap-3 px-5 py-3 text-sm"><div><dt className="text-xs text-slate-500">Status</dt><dd><Badge status={l.probation.status} /></dd></div><div><dt className="text-xs text-slate-500">Started</dt><dd className="text-slate-900">{l.probation.startDate}</dd></div><div><dt className="text-xs text-slate-500">Current end</dt><dd className="text-slate-900">{l.probation.currentEndDate}</dd></div><div><dt className="text-xs text-slate-500">Outcome</dt><dd className="text-slate-900">{l.probation.finalOutcome ? titleCase(l.probation.finalOutcome) : '—'}</dd></div></dl> : <Empty text="No probation case." />}
        {l.probation && <p className="px-5 pb-3 text-xs"><Link className="text-brand-700 underline" to={selfLinks ? base : `${base}/probation?open=${l.probation.id}`}>Open probation</Link></p>}
      </Card>
      <Card><CardHeader title="Offboarding" description="Dates and status only. Reason notes and exit interviews stay in the module." />
        {l.offboarding ? <dl className="grid grid-cols-2 gap-3 px-5 py-3 text-sm"><div><dt className="text-xs text-slate-500">Status</dt><dd><Badge status={l.offboarding.status} /></dd></div><div><dt className="text-xs text-slate-500">Planned last day</dt><dd className="text-slate-900">{l.offboarding.plannedLastWorkingDate}</dd></div><div><dt className="text-xs text-slate-500">Actual last day</dt><dd className="text-slate-900">{l.offboarding.actualLastWorkingDate ?? '—'}</dd></div></dl> : <Empty text="No offboarding case." />}
        {l.offboarding && !selfLinks && <p className="px-5 pb-3 text-xs"><Link className="text-brand-700 underline" to={`${base}/offboarding?open=${l.offboarding.id}`}>Open offboarding</Link></p>}
      </Card>
    </div>
  );
}

export function BenefitsSection({ s, selfLinks }: { s: S; selfLinks: boolean }) {
  const b = s.benefits;
  if (!b) return <Card><Empty text="No benefits section is available to you for this employee." /></Card>;
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Card><CardHeader title="Enrolments" description="Plans and coverage dates. No claim description, document or payment reference anywhere on this page." />
        {b.enrollments.length === 0 ? <Empty text="No enrolment." /> : <ul className="divide-y divide-slate-100 px-5 text-sm">{b.enrollments.map((e, i) => <li key={`${e.plan}-${i}`} className="flex flex-wrap items-center justify-between gap-2 py-2"><span>{e.plan}<span className="block text-xs text-slate-500">{titleCase(e.planType)}{e.coverageStart ? ` · from ${e.coverageStart}` : ''}{e.coverageEnd ? ` to ${e.coverageEnd}` : ''}</span></span><Badge status={e.status} /></li>)}</ul>}
      </Card>
      <Card><CardHeader title="Claims" description="Counts by status." />
        {b.claims.length === 0 ? <Empty text="No claims." /> : <dl className="grid grid-cols-2 gap-3 px-5 py-3 text-sm">{b.claims.map((c) => <div key={c.status}><dt className="text-xs text-slate-500">{titleCase(c.status)}</dt><dd className="tabular-nums text-slate-900">{c.count}</dd></div>)}</dl>}
        <p className="px-5 pb-3 text-xs"><Link className="text-brand-700 underline" to={selfLinks ? '/hrm/benefits' : '/hrm/benefits/claims'}>Open Benefits</Link></p>
      </Card>
      <Card className="lg:col-span-2"><CardHeader title="Entitlement balances (open periods)" description="Exact decimal strings from the entitlement ledger." />
        {b.balances.length === 0 ? <Empty text="No open entitlement." /> : <div className="overflow-x-auto"><table className="min-w-full text-sm"><thead className="bg-slate-50"><tr>{['Plan', 'Period', 'Granted', 'Adjustments', 'Reserved', 'Used', 'Available'].map((h) => <th key={h} className="px-4 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">{h}</th>)}</tr></thead><tbody className="divide-y divide-slate-100">{b.balances.map((x, i) => <tr key={`${x.plan}-${x.period}-${i}`}><td className="px-4 py-2">{x.plan}</td><td className="px-4 py-2">{x.period}</td><td className="px-4 py-2 tabular-nums">{x.granted}</td><td className="px-4 py-2 tabular-nums">{x.adjustment}</td><td className="px-4 py-2 tabular-nums">{x.reserved}</td><td className="px-4 py-2 tabular-nums">{x.consumed}</td><td className="px-4 py-2 font-semibold tabular-nums">{x.available} {x.currency}</td></tr>)}</tbody></table></div>}
      </Card>
    </div>
  );
}
