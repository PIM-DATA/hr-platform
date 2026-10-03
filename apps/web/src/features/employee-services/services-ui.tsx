import type { ReactNode } from 'react';
import { Outlet } from 'react-router-dom';
import { PERMISSIONS, type HrLetterDto } from '@hr/shared';
import { PageHeader } from '@/components/layout/PageHeader';
import { Tabs } from '@/components/ui/Tabs';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { ModuleIndex } from '@/components/guards/ModuleIndex';
import { localToday, formatDate } from '@/lib/format';
import { useAuth } from '@/hooks/useAuth';

type Tone = 'success' | 'neutral' | 'warning' | 'danger' | 'info';
export const titleCase = (s: string) => s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, ' ');
const TONE: Record<string, Tone> = {
  DRAFT: 'neutral', SUBMITTED: 'info', IN_PROGRESS: 'warning', WAITING_EMPLOYEE: 'warning', FULFILLED: 'success', REJECTED: 'danger', CANCELLED: 'neutral',
  ISSUED: 'success', VOID: 'danger', APPROVED: 'success', PENDING: 'warning', EMPLOYMENT_CERTIFICATE: 'info', SALARY_CERTIFICATE: 'warning', GENERAL: 'neutral', HR_LETTER: 'info',
};
export function ServiceBadge({ status }: { status: string }) { return <StatusBadge status={titleCase(status)} tone={TONE[status] ?? 'neutral'} />; }
/** Task 53: business dates as calendar dates in any browser zone; instants in the viewer's zone. */
export const fmtDate = (iso: string | null | undefined) => formatDate(iso);
export const fmtDateTime = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—');
export const todayIso = () => localToday();
/** A frozen answer is shown as it was stored; a boolean reads as yes or no. */
export const answerText = (fieldType: string, value: string) => (fieldType === 'BOOLEAN' ? (value === 'true' ? 'Yes' : 'No') : value);

export function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: string; tone?: 'warning' | 'danger' }) {
  return <div className={`rounded-lg border p-4 ${tone === 'danger' ? 'border-red-200 bg-red-50' : tone === 'warning' ? 'border-amber-200 bg-amber-50' : 'border-slate-200 bg-white'}`}><div className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</div><div className="mt-1 text-2xl font-semibold tabular-nums text-slate-900">{value}</div>{hint && <div className="mt-1 text-xs text-slate-500">{hint}</div>}</div>;
}
export const Table = ({ head, rows }: { head: string[]; rows: ReactNode[][] }) => (
  <div className="overflow-x-auto"><table className="min-w-full text-sm"><thead className="bg-slate-50"><tr>{head.map((h) => <th key={h} className="px-4 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">{h}</th>)}</tr></thead><tbody className="divide-y divide-slate-100">{rows.length === 0 ? <tr><td colSpan={head.length} className="px-4 py-4 text-sm text-slate-400">Nothing here.</td></tr> : rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} className="px-4 py-2 tabular-nums">{c}</td>)}</tr>)}</tbody></table></div>
);
export function History({ rows }: { rows: { from: string | null; to: string; actorName: string | null; reasonCode: string | null; at: string }[] }) {
  return <div><div className="text-xs font-semibold uppercase tracking-wide text-slate-500">History</div><ol className="mt-1 space-y-1 text-xs text-slate-600">{rows.map((h, i) => <li key={i}>{fmtDateTime(h.at)} · {h.from ? `${titleCase(h.from)} → ` : ''}{titleCase(h.to)}{h.actorName ? ` · ${h.actorName}` : ''}{h.reasonCode ? ` · ${h.reasonCode}` : ''}</li>)}</ol></div>;
}

/**
 * The letter as it prints. The body is plain text rendered by the server and is placed in the DOM as text, never as
 * markup: React escapes it, and `white-space: pre-wrap` keeps the layout. Nothing here claims a signature.
 */
export function LetterSheet({ letter }: { letter: HrLetterDto }) {
  return (
    <article className="letter-sheet mx-auto max-w-[210mm] rounded-lg border border-slate-200 bg-white p-6 text-slate-900 sm:p-10">
      <header className="mb-6 border-b border-slate-200 pb-4">
        <div className="text-lg font-semibold">{letter.organizationName ?? ''}</div>
        <div className="mt-1 flex flex-wrap justify-between gap-2 text-xs text-slate-500"><span>Reference {letter.letterNumber}</span><span>Issued {letter.issuedDate}</span></div>
      </header>
      {letter.subject && <h1 className="mb-4 text-center text-base font-semibold">{letter.subject}</h1>}
      {letter.contentRestricted
        ? <p className="rounded border border-slate-200 bg-slate-50 p-3 text-sm text-slate-600">This letter contains salary information. Its content is shown only to the employee and to payroll-authorized staff.</p>
        : <div className="whitespace-pre-wrap text-sm leading-7">{letter.body}</div>}
      {letter.status === 'VOID' && <p className="mt-6 rounded border border-red-200 bg-red-50 p-3 text-sm font-semibold text-red-800">VOID — this letter was withdrawn{letter.voidReasonCode ? ` (${titleCase(letter.voidReasonCode)})` : ''} and must not be relied upon.</p>}
      <footer className="mt-10 text-xs text-slate-500">Issued by {letter.issuedByName ?? 'HR'}. This is a printed record produced by the HR system; it carries no electronic signature and makes no statutory certification.</footer>
    </article>
  );
}

/** Tabs by capability. The queue and the catalogue need an organization-wide scope; the employee tabs need a record. */
export function useServiceTabs() {
  const { hasPermission, user, scopeOf } = useAuth();
  const admin = scopeOf(PERMISSIONS.SERVICE_REQUEST_VIEW, PERMISSIONS.SERVICE_REQUEST_FULFILL, PERMISSIONS.SERVICE_REQUEST_MANAGE) === 'ALL';
  const letters = hasPermission(PERMISSIONS.HR_LETTER_ISSUE) || hasPermission(PERMISSIONS.HR_LETTER_MANAGE_TEMPLATES);
  const reportsTab = hasPermission(PERMISSIONS.HR_LETTER_VIEW_REPORTS) || hasPermission(PERMISSIONS.SERVICE_REQUEST_MANAGE);
  return [
    (!!user?.employee && hasPermission(PERMISSIONS.SERVICE_REQUEST_VIEW_OWN)) && { label: 'My requests', to: '/hrm/services', end: true },
    (!!user?.employee && hasPermission(PERMISSIONS.HR_LETTER_VIEW_OWN)) && { label: 'My letters', to: '/hrm/services/my-letters' },
    reportsTab && { label: 'Dashboard', to: '/hrm/services/dashboard' },
    admin && { label: 'Requests', to: '/hrm/services/requests' },
    hasPermission(PERMISSIONS.SERVICE_REQUEST_MANAGE) && { label: 'Service catalog', to: '/hrm/services/catalog' },
    letters && { label: 'HR letters', to: '/hrm/services/letters' },
    hasPermission(PERMISSIONS.HR_LETTER_MANAGE_TEMPLATES) && { label: 'Letter templates', to: '/hrm/services/templates' },
    reportsTab && { label: 'Reports', to: '/hrm/services/reports' },
  ].filter(Boolean) as { label: string; to: string; end?: boolean }[];
}
export function ServicesLayout() {
  const tabs = useServiceTabs();
  return (
    <>
      <PageHeader title="Employee services" description="Ask HR for something and follow what happens to it, and receive employment and salary letters. A request is a record of what was asked and what HR did: it never changes your employee record, payroll, leave or benefits by itself." />
      {tabs.length > 1 && <div className="mb-5"><Tabs items={tabs} /></div>}
      <Outlet />
    </>
  );
}
export function ServicesIndex({ my }: { my: ReactNode }) {
  return <ModuleIndex own={my} ownPermission={PERMISSIONS.SERVICE_REQUEST_VIEW_OWN} fallbacks={[{ to: '/hrm/services/requests', permission: [PERMISSIONS.SERVICE_REQUEST_VIEW, PERMISSIONS.SERVICE_REQUEST_FULFILL] }, { to: '/hrm/services/dashboard', permission: [PERMISSIONS.HR_LETTER_VIEW_REPORTS, PERMISSIONS.SERVICE_REQUEST_MANAGE] }, { to: '/hrm/services/templates', permission: PERMISSIONS.HR_LETTER_MANAGE_TEMPLATES }]} />;
}
