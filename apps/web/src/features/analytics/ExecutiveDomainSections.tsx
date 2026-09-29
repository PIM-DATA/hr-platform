import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { ExecutiveOverviewDto, ExecutiveSectionStatus } from '@hr/shared';
import { Card, CardHeader } from '@/components/ui/Card';
import { BarList } from './charts';

/**
 * Task 42 sections of the executive dashboard: benefits, expenses & travel, employee services, and the people-
 * operations roll-ups (lifecycle, workforce planning, engagement, OJT / learning / certifications).
 *
 * Money arrives as exact decimal strings per currency and is only re-punctuated here — never parsed into a Number,
 * never added across currencies. A section the viewer may not see, that failed, or that the department/job filter
 * does not apply to says so instead of showing zeros.
 */
type Sections = ExecutiveOverviewDto['sections'];
type Status = ExecutiveOverviewDto['sectionStatus'];

const n = (v: number | null | undefined) => (v === null || v === undefined ? '—' : new Intl.NumberFormat('en-US').format(v));
/** "1234567.50" → "1,234,567.50" by string handling only. */
export const money = (amount: string, currency?: string | null) => {
  const neg = amount.startsWith('-');
  const [int = '0', frac] = (neg ? amount.slice(1) : amount).split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${neg ? '-' : ''}${grouped}${frac !== undefined ? `.${frac}` : ''}${currency ? ` ${currency}` : ''}`;
};

const Stat = ({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) => (
  <div className="rounded-lg border border-slate-200 bg-white p-3"><div className="text-xs text-slate-500">{label}</div><div className="mt-0.5 break-words text-xl font-semibold tabular-nums text-slate-900">{value}</div>{hint && <div className="text-[11px] text-slate-400">{hint}</div>}</div>
);

const STATUS_TEXT: Record<Exclude<ExecutiveSectionStatus, 'OK'>, string> = {
  NOT_AUTHORIZED: 'Not included: your account does not hold this module\'s reporting permission.',
  UNAVAILABLE: 'This section could not be loaded. The other sections are unaffected; try again later.',
  NOT_APPLICABLE_TO_FILTER: 'Not split by department or job, so a small group cannot reveal an individual. Clear the department and job filters to see organization-level figures.',
};
function Unavailable({ status }: { status: ExecutiveSectionStatus }) {
  if (status === 'OK') return null;
  return <Card><p className={`p-4 text-sm ${status === 'UNAVAILABLE' ? 'text-amber-700' : 'text-slate-500'}`} role={status === 'UNAVAILABLE' ? 'alert' : undefined}>{STATUS_TEXT[status]}</p></Card>;
}

function SectionHead({ title, to, label }: { title: string; to?: string | null; label?: string }) {
  return <div className="mb-2 flex items-center justify-between gap-2"><h2 className="text-sm font-semibold text-slate-900">{title}</h2>{to && label && <Link to={to} className="text-xs text-brand-700 underline">{label}</Link>}</div>;
}

/** Per-currency amounts: one row per metric, one column per currency (usually one or two), every cell the server's decimal string. */
function MoneyTable({ caption, columns, rows }: { caption: string; columns: string[]; rows: { currency: string; cells: string[] }[] }) {
  if (rows.length === 0) return <p className="text-sm text-slate-400">No amounts recorded.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead><tr className="text-left text-xs text-slate-500"><th scope="col" className="py-1 pr-3 font-medium">Amount</th>{rows.map((r) => <th key={r.currency} scope="col" className="py-1 pl-3 text-right font-medium">{r.currency}</th>)}</tr></thead>
        <tbody>{columns.map((c, i) => <tr key={c} className="border-t border-slate-100"><th scope="row" className="py-1 pr-3 text-left font-normal text-slate-600">{c}</th>{rows.map((r) => <td key={r.currency} className="whitespace-nowrap py-1 pl-3 text-right tabular-nums text-slate-900">{money(r.cells[i]!)}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}

export function BenefitsSection({ data, status, reportLink }: { data: Sections['benefits']; status: Status['benefits']; reportLink: string | null }) {
  return (
    <section>
      <SectionHead title="Benefits" to={reportLink} label="Benefits reports" />
      {!data ? <Unavailable status={status} /> : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
            <Stat label="Enrolled" value={n(data.current.enrolled)} hint={`${n(data.current.activePlans)} active plans`} />
            <Stat label="Coverage-only" value={n(data.current.coverageOnlyEnrolled)} hint="enrolments" />
            <Stat label="Claims pending" value={n(data.current.claims.pendingApproval)} hint="awaiting approval" />
            <Stat label="Ready for payment" value={n(data.current.claims.readyForPayment)} hint="approved, not paid" />
            <Stat label="Sent to payroll" value={n(data.current.claims.sentToPayroll)} hint="not yet recorded paid" />
            <Stat label="Paid" value={n(data.current.claims.paid)} hint="claims, all time" />
          </div>
          <div className="mt-3 grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card><CardHeader title="Amounts now" description="Per currency · consumed = approved claims, not paid" /><div className="p-4"><MoneyTable caption="Benefit amounts now, per currency" columns={['Granted', 'Consumed', 'Available', 'Pending', 'Ready', 'Sent to payroll', 'Paid']} rows={data.current.money.map((m) => ({ currency: m.currency, cells: [m.granted, m.consumed, m.available, m.claimedPending, m.readyForPayment, m.sentToPayroll, m.paid] }))} /></div></Card>
            <Card><CardHeader title="Approved and paid in range" description={`${data.range.from} → ${data.range.to} · by claim submitted / paid date`} /><div className="space-y-4 p-4"><MoneyTable caption="Benefit amounts approved and paid in range" columns={['Approved', 'Paid']} rows={data.inRange.money.map((m) => ({ currency: m.currency, cells: [m.approvedAmount, m.paidAmount] }))} /><BarList rows={data.inRange.byCategory.map((c) => ({ label: c.currency ? `${c.category} (${c.currency})` : c.category, value: c.claims, hint: c.currency ? `approved ${money(c.approvedAmount)}` : 'coverage only' }))} /></div></Card>
          </div>
        </>
      )}
    </section>
  );
}

export function ExpenseSection({ data, status, reportLink }: { data: Sections['expense']; status: Status['expense']; reportLink: string | null }) {
  return (
    <section>
      <SectionHead title="Expenses & travel" to={reportLink} label="Expense analytics" />
      {!data ? <Unavailable status={status} /> : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
            <Stat label="Reports pending" value={n(data.current.reports.pendingApproval)} hint="awaiting approval" />
            <Stat label="Ready for payment" value={n(data.current.reports.readyForPayment)} hint="approved, not paid" />
            <Stat label="Sent to payroll" value={n(data.current.reports.sentToPayroll)} hint="not yet recorded paid" />
            <Stat label="Paid" value={n(data.current.reports.paid)} hint="reports, all time" />
            <Stat label="Travel pending" value={n(data.current.travel.pendingApproval)} hint="requests awaiting approval" />
            <Stat label="Travel submitted" value={n(data.inRange.travel.requests)} hint={`${n(data.inRange.travel.approved)} approved in range`} />
          </div>
          <div className="mt-3 grid grid-cols-1 gap-4 lg:grid-cols-3">
            <Card><CardHeader title="Amounts now" description="Per currency · separate states" /><div className="p-4"><MoneyTable caption="Expense amounts now, per currency" columns={['Pending', 'Ready', 'Sent to payroll']} rows={data.current.money.map((m) => ({ currency: m.currency, cells: [m.pendingTotal, m.readyForPaymentTotal, m.sentToPayrollTotal] }))} /></div></Card>
            <Card><CardHeader title="Submitted in range" description={`${data.range.from} → ${data.range.to} · by report submitted date`} /><div className="p-4"><MoneyTable caption="Expense reports submitted in range, per currency" columns={['Submitted', 'Approved', 'Paid']} rows={data.inRange.money.map((m) => ({ currency: m.currency, cells: [m.submittedTotal, m.approvedTotal, m.paidTotal] }))} /></div></Card>
            <Card><CardHeader title="By category" description="Items on reports submitted in range" /><div className="p-4"><BarList rows={data.inRange.byCategory.slice(0, 8).map((c) => ({ label: `${c.category} (${c.currency})`, value: c.items, hint: money(c.total) }))} /></div></Card>
          </div>
        </>
      )}
    </section>
  );
}

export function EmployeeServicesSection({ data, status, reportLink }: { data: Sections['employeeServices']; status: Status['employeeServices']; reportLink: string | null }) {
  return (
    <section>
      <SectionHead title="Employee services" to={reportLink} label="Service reports" />
      {!data ? <Unavailable status={status} /> : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
            <Stat label="Open requests" value={n(data.current.open)} hint="now" />
            <Stat label="Overdue" value={n(data.current.overdue)} hint="open, past due date" />
            <Stat label="Waiting on employee" value={n(data.current.waitingEmployee)} hint="now" />
            <Stat label="Fulfilled" value={n(data.inRange.totals.fulfilled)} hint={`of ${n(data.inRange.totals.submitted)} submitted in range`} />
            <Stat label="Avg. fulfilment" value={data.inRange.totals.averageFulfillmentDays === null ? '—' : `${data.inRange.totals.averageFulfillmentDays} d`} hint="calendar days" />
            <Stat label="Letters issued" value={n(data.inRange.letters.issued)} hint={`${n(data.inRange.letters.voided)} voided in range`} />
          </div>
          <div className="mt-3 grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card><CardHeader title="Requests by category" description="Submitted in range" /><div className="p-4"><BarList rows={data.inRange.byCategory.map((c) => ({ label: c.category.replace(/_/g, ' ').toLowerCase(), value: c.submitted, hint: `${c.fulfilled} fulfilled` }))} /></div></Card>
            <Card><CardHeader title="Letters by type" description="Issue date in range" /><div className="p-4"><BarList rows={data.inRange.letters.byType.map((l) => ({ label: l.letterType.replace(/_/g, ' ').toLowerCase(), value: l.issued, hint: l.voided ? `${l.voided} voided` : undefined }))} /></div></Card>
          </div>
        </>
      )}
    </section>
  );
}

export function PeopleOperationsSection({ s, status, links }: { s: Sections; status: Status; links: { lifecycle: string | null; workforce: string | null; engagement: string | null; learning: string | null } }) {
  const card = (title: string, st: ExecutiveSectionStatus, link: string | null, body: ReactNode | null) => (
    <Card><CardHeader title={title} /><div className="p-4">{body ?? <p className={`text-sm ${st === 'UNAVAILABLE' ? 'text-amber-700' : 'text-slate-500'}`}>{st === 'OK' ? '—' : STATUS_TEXT[st]}</p>}{body && link && <Link to={link} className="mt-3 inline-block text-xs text-brand-700 underline">Open {title.toLowerCase()}</Link>}</div></Card>
  );
  const row = (items: [string, ReactNode][]) => <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-sm">{items.map(([k, v]) => <div key={k}><dt className="text-xs text-slate-500">{k}</dt><dd className="font-semibold tabular-nums text-slate-900">{v}</dd></div>)}</dl>;
  const l = s.lifecycle, w = s.workforcePlanning, e = s.engagement, o = s.learning;
  return (
    <section>
      <SectionHead title="People operations" />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        {card('Onboarding, probation, offboarding', status.lifecycle, links.lifecycle, l && row([['Onboarding started', n(l.onboarding.plansStarted)], ['Onboarding completed', n(l.onboarding.plansCompleted)], ['Probation active', n(l.probation.active)], ['Probation due ≤ 14 d', n(l.probation.dueSoon)], ['Offboarding active', n(l.offboarding.active)], ['Separations completed', n(l.offboarding.completedSeparations)]]))}
        {card('Workforce plan', status.workforcePlanning, links.workforce, w && row([['Cycle', w.cycle ? w.cycle.name : 'No active cycle'], ['Current', n(w.currentHeadcount)], ['Planned', n(w.plannedHeadcount)], ['Net delta', w.netDelta > 0 ? `+${n(w.netDelta)}` : n(w.netDelta)], ['Vacant positions', n(w.vacantPositions)], ['Remaining demand', n(w.remainingDemand)]]))}
        {card('Engagement', status.engagement, links.engagement, e && row([['Open surveys', n(e.openSurveys)], ['Response rate (open)', e.openResponseRate === null ? '—' : `${e.openResponseRate}%`], ['Latest eNPS', e.latestEnps ? (e.latestEnps.suppressed ? 'Suppressed' : n(e.latestEnps.score)) : 'None yet'], ['Closed surveys', n(e.closedSurveys)]]))}
        {card('OJT, paths & certifications', status.learning, links.learning, o && row([['OJT active', n(o.ojt.active)], ['OJT completed', n(o.ojt.completed)], ['Paths in progress', n(o.paths.inProgress)], ['Paths completed', n(o.paths.completed)], ['Certs active', n(o.certifications.active)], ['Expiring soon', n(o.certifications.expiringSoon)]]))}
      </div>
      {e?.latestEnps?.suppressed && <p className="mt-1 text-xs text-slate-500">The latest eNPS is suppressed: its responses are below the survey's minimum group size.</p>}
    </section>
  );
}
