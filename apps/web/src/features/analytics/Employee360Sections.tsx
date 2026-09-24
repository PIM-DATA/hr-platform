import { Link } from 'react-router-dom';
import { CAREER_READINESS_LABEL, nineBoxLabel, type Employee360Dto } from '@hr/shared';
import { Card, CardHeader } from '@/components/ui/Card';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { formatDate, formatDateTime } from '@/lib/format';
import { GapBadge } from '@/features/competency/competency-ui';

/**
 * The Employee 360 tabs. Every block renders only when the server returned its section — the browser never hides
 * a value the API sent, because the API does not send values the viewer may not see.
 */
type S = Employee360Dto['sections'];
const titleCase = (s: string) => s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, ' ');
const hours = (m: number) => `${Math.round((m / 60) * 10) / 10} h`;
const Stat = ({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) => (
  <div className="rounded-lg border border-slate-200 bg-white p-3"><div className="text-xs text-slate-500">{label}</div><div className="mt-0.5 text-xl font-semibold tabular-nums text-slate-900">{value}</div>{hint && <div className="text-[11px] text-slate-400">{hint}</div>}</div>
);
const Empty = ({ text }: { text: string }) => <p className="px-5 py-4 text-sm text-slate-400">{text}</p>;

export function OverviewCards({ d }: { d: Employee360Dto }) {
  const s = d.sections;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        {s.leave && <Stat label="Leave approved" value={s.leave.summary.approvedUnits} hint={`${s.leave.summary.pending} pending · ${s.leave.year}`} />}
        {s.attendance?.totals && <Stat label="Present days" value={`${s.attendance.totals.presentDays} / ${s.attendance.totals.scheduledDays}`} hint={`this month · ${s.attendance.totals.lateDays} late`} />}
        {s.overtime && <Stat label="Overtime approved" value={hours(s.overtime.approvedMinutes)} hint={`${s.overtime.approvedRequests} claim(s) this year`} />}
        {s.performance && <Stat label="Latest review" value={s.performance.latest?.ratingLabel ?? '—'} hint={s.performance.latest ? `${s.performance.latest.weightedScore} · ${s.performance.latest.cycle.name}` : 'no finalized review'} />}
        {s.competency && <Stat label="Competency gaps" value={s.competency.summary.withGap} hint={`${s.competency.summary.assessed} of ${s.competency.summary.required} assessed`} />}
        {s.development && <Stat label="Open dev. needs" value={s.development.summary.openNeeds} hint={s.development.activeIdp ? s.development.activeIdp.title : 'no active plan'} />}
        {s.employeeRelations && <Stat label="Active warnings" value={s.employeeRelations.activeWarnings} hint={`${s.employeeRelations.awaitingAcknowledgement} awaiting acknowledgement`} />}
        {s.talent && <Stat label="Talent review" value={s.talent.latestTalentReview ? nineBoxLabel(s.talent.latestTalentReview.nineBoxCell) : '—'} hint={s.talent.latestTalentReview?.cycleName ?? 'none'} />}
      </div>
      <Card>
        <CardHeader title="Recent activity" description="Curated events across modules that you are allowed to see. This is not the audit log." />
        {d.activity.length === 0 ? <Empty text="Nothing recent." /> : (
          <ul className="divide-y divide-slate-100">{d.activity.map((a, i) => <li key={i} className="flex flex-wrap items-baseline gap-2 px-5 py-2 text-sm"><span className="w-24 shrink-0 tabular-nums text-slate-400">{a.date}</span><StatusBadge status={titleCase(a.domain)} tone="neutral" /><span className="text-slate-800">{a.title}</span>{a.detail && <span className="text-xs text-slate-500">{a.detail}</span>}</li>)}</ul>
        )}
      </Card>
    </div>
  );
}

export function TimelineSection({ e }: { e: NonNullable<S['employment']> }) {
  return (
    <Card>
      <CardHeader title="Employment timeline" description="From the position and manager histories — nothing is invented." />
      <ol className="divide-y divide-slate-100">{e.timeline.map((t, i) => <li key={i} className="flex flex-wrap items-baseline gap-2 px-5 py-2 text-sm"><span className="w-24 shrink-0 tabular-nums text-slate-400">{t.date}</span><span className="font-medium text-slate-900">{t.title}</span>{t.detail && <span className="text-xs text-slate-500">{t.detail}</span>}</li>)}</ol>
    </Card>
  );
}

export function TimeLeaveSection({ s, selfLinks }: { s: S; selfLinks: boolean }) {
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
      {s.leave && (
        <Card><CardHeader title={`Leave · ${s.leave.year}`} description={`${s.leave.summary.requests} requests · ${s.leave.summary.approved} approved · ${s.leave.summary.pending} pending`} />
          {s.leave.balances.length === 0 ? <Empty text="No entitlements for this year." /> : <ul className="divide-y divide-slate-100">{s.leave.balances.map((b) => <li key={b.id} className="flex justify-between px-5 py-2 text-sm"><span className="text-slate-800">{b.leaveType.name}</span><span className="tabular-nums text-slate-900">{b.available} <span className="text-xs text-slate-400">available · {b.used} used</span></span></li>)}</ul>}
          {s.leave.recent.length > 0 && <div className="border-t border-slate-100 px-5 py-2 text-xs text-slate-500">Recent: {s.leave.recent.slice(0, 3).map((r) => `${r.leaveType.name} ${r.startDate} (${titleCase(r.status)})`).join(' · ')}</div>}
          {selfLinks && <div className="px-5 pb-3 text-xs"><Link className="text-brand-700 underline" to="/hrm/leave">Open leave</Link></div>}
        </Card>
      )}
      {s.attendance && (
        <Card><CardHeader title="Attendance" description={`${s.attendance.from} → ${s.attendance.to}`} />
          {s.attendance.totals ? <div className="grid grid-cols-3 gap-2 px-5 py-3 text-center text-sm"><div><div className="text-lg font-semibold tabular-nums">{s.attendance.totals.presentDays}</div><div className="text-[11px] text-slate-500">present</div></div><div><div className="text-lg font-semibold tabular-nums">{s.attendance.totals.lateDays}</div><div className="text-[11px] text-slate-500">late</div></div><div><div className="text-lg font-semibold tabular-nums">{s.attendance.totals.absentDays}</div><div className="text-[11px] text-slate-500">absent</div></div><div><div className="text-lg font-semibold tabular-nums">{s.attendance.totals.leaveDays}</div><div className="text-[11px] text-slate-500">leave</div></div><div><div className="text-lg font-semibold tabular-nums">{s.attendance.totals.incompleteDays}</div><div className="text-[11px] text-slate-500">incomplete</div></div><div><div className="text-lg font-semibold tabular-nums">{hours(s.attendance.totals.workMinutes)}</div><div className="text-[11px] text-slate-500">worked</div></div></div> : <Empty text="No attendance records this month." />}
          {s.attendance.recent.length > 0 && <ul className="divide-y divide-slate-100 border-t border-slate-100 text-xs">{s.attendance.recent.slice(0, 5).map((r) => <li key={r.date} className="flex justify-between px-5 py-1.5"><span className="tabular-nums text-slate-500">{r.date}</span><span className="text-slate-700">{titleCase(r.status)}{r.lateMinutes ? ` · ${r.lateMinutes} min late` : ''}</span></li>)}</ul>}
          {selfLinks && <div className="px-5 pb-3 text-xs"><Link className="text-brand-700 underline" to="/hrm/attendance">Open attendance</Link></div>}
        </Card>
      )}
      {s.overtime && (
        <Card><CardHeader title="Overtime" description={`${s.overtime.from} → ${s.overtime.to}`} />
          <div className="grid grid-cols-3 gap-2 px-5 py-3 text-center text-sm"><div><div className="text-lg font-semibold tabular-nums">{s.overtime.requests}</div><div className="text-[11px] text-slate-500">claims</div></div><div><div className="text-lg font-semibold tabular-nums">{s.overtime.approvedRequests}</div><div className="text-[11px] text-slate-500">approved</div></div><div><div className="text-lg font-semibold tabular-nums">{hours(s.overtime.approvedMinutes)}</div><div className="text-[11px] text-slate-500">approved time</div></div></div>
          <p className="px-5 pb-3 text-xs text-slate-400">{s.overtime.note}</p>
        </Card>
      )}
      {s.payroll && (
        <Card><CardHeader title="Payslips" description={s.payroll.mode === 'SELF' ? 'Your closed payslips' : 'Closed payroll results (payroll permission)'} />
          {s.payroll.payslips.length === 0 ? <Empty text="No closed payroll yet." /> : <ul className="divide-y divide-slate-100">{s.payroll.payslips.map((p) => <li key={p.id} className="flex justify-between px-5 py-2 text-sm"><span className="text-slate-800">{p.periodLabel}{p.paymentDate && <span className="ml-1 text-xs text-slate-400">paid {p.paymentDate}</span>}</span><span className="tabular-nums text-slate-900">{p.netPay} {p.currencyCode}</span></li>)}</ul>}
          {selfLinks && <div className="px-5 pb-3 text-xs"><Link className="text-brand-700 underline" to="/hrm/payroll">Open payslips</Link></div>}
        </Card>
      )}
      {!s.leave && !s.attendance && !s.overtime && !s.payroll && <Card><Empty text="No time or leave sections are available to you for this employee." /></Card>}
    </div>
  );
}

export function PerformanceSection({ p }: { p: NonNullable<S['performance']> }) {
  return (
    <Card>
      <CardHeader title="Performance" description={p.latest ? `Latest finalized: ${p.latest.cycle.name} — ${p.latest.ratingLabel ?? '—'} (${p.latest.weightedScore ?? '—'} of ${p.latest.cycle.maxScore})` : 'No finalized review yet'} />
      {p.history.length === 0 ? <Empty text="No performance plans." /> : (
        <ul className="divide-y divide-slate-100">{p.history.map((h) => <li key={h.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-2 text-sm"><span><span className="font-medium text-slate-900">{h.cycle.name}</span><span className="ml-2 text-xs text-slate-400">{h.snapshot.departmentName ?? ''}{h.reviewer.name ? ` · reviewer ${h.reviewer.name}` : ''}</span></span><span className="flex items-center gap-2"><StatusBadge status={titleCase(h.status)} tone={h.status === 'FINALIZED' ? 'success' : 'neutral'} />{h.ratingLabel && <span className="tabular-nums text-slate-900">{h.ratingLabel} · {h.weightedScore}</span>}</span></li>)}</ul>
      )}
      <p className="px-5 pb-3 text-xs text-slate-400">Scores and ratings are the performance module's. Review comments stay in the performance module under its own rules.</p>
    </Card>
  );
}

export function DevelopmentSection({ s, selfLinks }: { s: S; selfLinks: boolean }) {
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      {s.competency && (
        <Card><CardHeader title={`Competency${s.competency.job ? ` · ${s.competency.job.title}` : ''}`} description={`${s.competency.summary.assessed} of ${s.competency.summary.required} assessed · ${s.competency.summary.withGap} gap(s) · ${s.competency.summary.unassessed} not assessed · ${s.competency.summary.exceeding} exceeding`} />
          {s.competency.entries.length === 0 ? <Empty text="No competency profile on this job." /> : <ul className="divide-y divide-slate-100">{s.competency.entries.map((e) => <li key={e.competencyId} className="flex items-center justify-between px-5 py-2 text-sm"><span className="text-slate-800">{e.competencyName}</span><span className="flex items-center gap-2 tabular-nums text-slate-600">{e.currentLevel ?? '—'} / {e.requiredLevel ?? '—'}<GapBadge status={e.gapStatus} gapNeeded={e.gapNeeded} /></span></li>)}</ul>}
          {selfLinks && <div className="px-5 pb-3 text-xs"><Link className="text-brand-700 underline" to="/hrd/competency">Open competencies</Link></div>}
        </Card>
      )}
      {s.development && (
        <Card><CardHeader title="Training & development" description={`${s.development.summary.openNeeds} open needs · ${s.development.summary.completedCourses} courses completed · ${s.development.summary.trainingHours} hours`} />
          <div className="space-y-3 px-5 py-3 text-sm">
            <div><span className="text-xs uppercase tracking-wide text-slate-500">Active plan</span><div className="text-slate-800">{s.development.activeIdp ? `${s.development.activeIdp.title} (${s.development.activeIdp.periodStart} → ${s.development.activeIdp.periodEnd})` : 'None'}</div></div>
            <div><span className="text-xs uppercase tracking-wide text-slate-500">Open needs</span>{s.development.openNeeds.length === 0 ? <div className="text-slate-400">None</div> : <ul className="mt-1 space-y-0.5">{s.development.openNeeds.map((n) => <li key={n.id} className="text-slate-800">{n.title} <span className="text-xs text-slate-400">{titleCase(n.status)} · {titleCase(n.priority)}{n.competencyName && ` · ${n.competencyName}`}</span></li>)}</ul>}</div>
            <div><span className="text-xs uppercase tracking-wide text-slate-500">Upcoming training</span>{s.development.upcoming.length === 0 ? <div className="text-slate-400">Nothing booked</div> : <ul className="mt-1 space-y-0.5">{s.development.upcoming.map((u, i) => <li key={i} className="text-slate-800">{u.courseTitle} <span className="text-xs text-slate-400">{formatDateTime(u.startAt)}</span></li>)}</ul>}</div>
            {s.development.recentCompleted.length > 0 && <div><span className="text-xs uppercase tracking-wide text-slate-500">Recently completed</span><ul className="mt-1 space-y-0.5">{s.development.recentCompleted.map((c, i) => <li key={i} className="text-slate-800">{c.courseTitle} <span className="text-xs text-slate-400">{c.completedAt ? formatDate(c.completedAt) : ''}</span></li>)}</ul></div>}
          </div>
          {selfLinks && <div className="px-5 pb-3 text-xs"><Link className="text-brand-700 underline" to="/hrd/training">Open development</Link></div>}
        </Card>
      )}
      {!s.competency && !s.development && <Card><Empty text="No development sections are available to you for this employee." /></Card>}
    </div>
  );
}

export function CareerTalentSection({ s, selfLinks }: { s: S; selfLinks: boolean }) {
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      {s.career && (
        <Card><CardHeader title="Career" description={s.career.currentJob ? `Current job: ${s.career.currentJob.title}` : 'No job linked'} />
          {s.career.nextJobs.length === 0 ? <Empty text="No next jobs on a defined path." /> : <ul className="divide-y divide-slate-100">{s.career.nextJobs.map((j) => <li key={j.targetJob.id} className="flex items-center justify-between px-5 py-2 text-sm"><span className="text-slate-800">{j.targetJob.title}</span><span className="text-xs text-slate-600">{CAREER_READINESS_LABEL[j.status]} · {j.summary.gaps} gap(s) · {j.summary.unassessed} not assessed</span></li>)}</ul>}
          <p className="px-5 pb-3 text-xs text-slate-400">Requirements met is a fact about competency levels, not a promotion decision.{selfLinks && <> <Link className="text-brand-700 underline" to="/hrd/career">Open My career</Link></>}</p>
        </Card>
      )}
      {s.talent && (
        <Card><CardHeader title="Talent & succession" description="Facts recorded by the organization — visible to the hiring line and HR only." />
          <dl className="grid grid-cols-2 gap-3 px-5 py-3 text-sm">
            <div><dt className="text-xs text-slate-500">Latest talent review</dt><dd className="text-slate-900">{s.talent.latestTalentReview ? `${nineBoxLabel(s.talent.latestTalentReview.nineBoxCell)} · ${s.talent.latestTalentReview.cycleName}` : '—'}</dd></div>
            <div><dt className="text-xs text-slate-500">Talent pools</dt><dd className="text-slate-900">{s.talent.talentPoolCount}</dd></div>
            <div><dt className="text-xs text-slate-500">Succession nominations</dt><dd className="text-slate-900">{s.talent.activeSuccessionNominations}</dd></div>
            <div><dt className="text-xs text-slate-500">Career targets</dt><dd className="text-slate-900">{s.talent.careerTargetCount}</dd></div>
          </dl>
          <p className="px-5 pb-3 text-xs text-slate-400">Reviewer comments and succession notes never appear here. <Link className="text-brand-700 underline" to="/hrd/career/talent">Open Career & talent</Link></p>
        </Card>
      )}
      {!s.career && !s.talent && <Card><Empty text="No career or talent sections are available to you for this employee." /></Card>}
    </div>
  );
}

export function RelationsSection({ s }: { s: S }) {
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      {s.employeeRelations && (
        <Card><CardHeader title="Employee relations" description="Counts and dates only. Narratives, letters and notes stay in the module." />
          <dl className="grid grid-cols-2 gap-3 px-5 py-3 text-sm">
            <div><dt className="text-xs text-slate-500">Active warnings</dt><dd className="text-slate-900">{s.employeeRelations.activeWarnings}</dd></div>
            <div><dt className="text-xs text-slate-500">Total issued</dt><dd className="text-slate-900">{s.employeeRelations.totalIssued}</dd></div>
            <div><dt className="text-xs text-slate-500">Awaiting acknowledgement</dt><dd className="text-slate-900">{s.employeeRelations.awaitingAcknowledgement}</dd></div>
            <div><dt className="text-xs text-slate-500">Latest action</dt><dd className="text-slate-900">{s.employeeRelations.latestActionDate ? formatDate(s.employeeRelations.latestActionDate) : '—'}</dd></div>
          </dl>
          <p className="px-5 pb-3 text-xs"><Link className="text-brand-700 underline" to="/hrm/employee-relations/cases">Open Employee relations</Link></p>
        </Card>
      )}
      {s.recruitment && (
        <Card><CardHeader title="Recruitment origin" description="How this employee joined, for HR. No feedback, no offer figures, no notes." />
          <dl className="grid grid-cols-2 gap-3 px-5 py-3 text-sm">
            <div><dt className="text-xs text-slate-500">Source</dt><dd className="text-slate-900">{titleCase(s.recruitment.source)}</dd></div>
            <div><dt className="text-xs text-slate-500">Opening</dt><dd className="text-slate-900">{s.recruitment.openingTitle}</dd></div>
            <div><dt className="text-xs text-slate-500">Application</dt><dd className="text-slate-900">{s.recruitment.applicationNumber} · applied {s.recruitment.appliedAt}</dd></div>
            <div><dt className="text-xs text-slate-500">Hired</dt><dd className="text-slate-900">{s.recruitment.hiredAt ? formatDate(s.recruitment.hiredAt) : '—'} · {s.recruitment.candidateNumber}</dd></div>
          </dl>
        </Card>
      )}
      {!s.employeeRelations && !s.recruitment && <Card><Empty text="No relations or recruitment sections are available to you for this employee." /></Card>}
    </div>
  );
}
