import type { ReactNode } from 'react';
import { StatusBadge } from '@/components/ui/StatusBadge';

type Tone = 'success' | 'neutral' | 'warning' | 'danger' | 'info';
export const titleCase = (s: string) => s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, ' ');
const TONE: Record<string, Tone> = {
  DRAFT: 'neutral', ACTIVE: 'info', COMPLETED: 'success', CANCELLED: 'neutral', PENDING: 'neutral', IN_PROGRESS: 'info', SKIPPED: 'neutral',
  MEETS: 'success', NEEDS_PRACTICE: 'warning', NOT_OBSERVED: 'neutral', MORE_PRACTICE_REQUIRED: 'warning',
  LOCKED: 'neutral', AVAILABLE: 'info', FULFILLED: 'success', EXPIRING_SOON: 'warning', EXPIRED: 'danger', REVOKED: 'danger',
};
const LABEL: Record<string, string> = { NEEDS_PRACTICE: 'Needs practice', NOT_OBSERVED: 'Not observed', MEETS: 'Meets', EXPIRING_SOON: 'Expiring soon', MORE_PRACTICE_REQUIRED: 'More practice required', IN_PROGRESS: 'In progress' };
export function LearningBadge({ status }: { status: string }) { return <StatusBadge status={LABEL[status] ?? titleCase(status)} tone={TONE[status] ?? 'neutral'} />; }
export const ACTIVITY_TYPE_LABEL: Record<string, string> = { OBSERVE: 'Observe', PRACTICE: 'Practice', PERFORM: 'Perform', REVIEW: 'Review', OTHER: 'Other' };
export const STEP_TYPE_LABEL: Record<string, string> = { COURSE: 'Course', OJT_PROGRAM: 'OJT program', IDP_ACTIVITY: 'IDP activity', CERTIFICATION: 'Certification' };
export function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: string; tone?: 'warning' | 'danger' }) {
  return <div className={`rounded-lg border p-4 ${tone === 'danger' ? 'border-red-200 bg-red-50' : tone === 'warning' ? 'border-amber-200 bg-amber-50' : 'border-slate-200 bg-white'}`}><div className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</div><div className="mt-1 text-2xl font-semibold tabular-nums text-slate-900">{value}</div>{hint && <div className="mt-1 text-xs text-slate-500">{hint}</div>}</div>;
}
export function Progress({ pct, hint }: { pct: number; hint?: string }) { return <div className="flex items-center gap-2"><div className="h-2 w-28 rounded bg-slate-100"><div className="h-2 rounded bg-brand-500" style={{ width: `${Math.min(100, pct)}%` }} /></div><span className="text-xs tabular-nums text-slate-600">{pct}%{hint ? ` · ${hint}` : ''}</span></div>; }
export const Table = ({ head, rows }: { head: string[]; rows: ReactNode[][] }) => (
  <div className="overflow-x-auto"><table className="min-w-full text-sm"><thead className="bg-slate-50"><tr>{head.map((h) => <th key={h} className="px-4 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">{h}</th>)}</tr></thead><tbody className="divide-y divide-slate-100">{rows.length === 0 ? <tr><td colSpan={head.length} className="px-4 py-4 text-sm text-slate-400">Nothing in this range.</td></tr> : rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} className="px-4 py-2 tabular-nums">{c}</td>)}</tr>)}</tbody></table></div>
);
export const fmtDate = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' }) : '—');
