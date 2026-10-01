import { useState } from 'react';
import { Outlet } from 'react-router-dom';
import { PERMISSIONS, type LifecycleTaskDto } from '@hr/shared';
import { PageHeader } from '@/components/layout/PageHeader';
import { Tabs } from '@/components/ui/Tabs';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Alert } from '@/components/ui/Alert';
import { Textarea } from '@/components/ui/Textarea';
import { Input } from '@/components/ui/Input';
import { useToast } from '@/components/ui/Toast';
import { useAuth } from '@/hooks/useAuth';
import { errorMessage } from '@/features/organization/shared';

export const titleCase = (s: string) => s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, ' ');
const TONE: Record<string, 'success' | 'neutral' | 'warning' | 'danger' | 'info'> = { DRAFT: 'neutral', ACTIVE: 'info', COMPLETED: 'success', CANCELLED: 'neutral', READY_TO_COMPLETE: 'warning', PENDING_REVIEW: 'warning', PASSED: 'success', EXTENDED: 'warning', NOT_PASSED: 'danger', PENDING: 'neutral', IN_PROGRESS: 'info', SKIPPED: 'neutral' };
export function LifecycleBadge({ status }: { status: string }) { return <StatusBadge status={titleCase(status)} tone={TONE[status] ?? 'neutral'} />; }
export function Stat({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return <div className="rounded-lg border border-slate-200 bg-white p-4"><div className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</div><div className="mt-1 text-2xl font-semibold tabular-nums text-slate-900">{value}</div>{hint && <div className="mt-0.5 text-xs text-slate-400">{hint}</div>}</div>;
}
export function Progress({ pct, hint }: { pct: number; hint?: string }) { return <div className="flex items-center gap-2"><div className="h-2 w-28 rounded bg-slate-100"><div className="h-2 rounded bg-brand-500" style={{ width: `${pct}%` }} /></div><span className="tabular-nums text-xs text-slate-600">{pct}%{hint ? ` · ${hint}` : ''}</span></div>; }
export function SnapshotVsCurrent({ snapshot, current }: { snapshot: { department: string | null; manager: { name: string; employeeCode: string } | null }; current: { department: string | null; manager: string | null; employmentStatus: string } | null }) {
  const differs = current && (current.department !== snapshot.department || (current.manager ?? null) !== (snapshot.manager ? `${snapshot.manager.name} (${snapshot.manager.employeeCode})` : null));
  return <div className="text-xs text-slate-500">At creation: {snapshot.department ?? '—'} · manager {snapshot.manager ? `${snapshot.manager.name} (${snapshot.manager.employeeCode})` : '—'}{differs && <span className="ml-2 rounded bg-amber-50 px-1.5 py-0.5 text-amber-800">now: {current!.department ?? '—'} · manager {current!.manager ?? '—'} · {titleCase(current!.employmentStatus)}</span>}</div>;
}

/** Tabs by capability. Managers get their team screens; HR the administration; employees their own lifecycle. */
export function useLifecycleTabs() {
  const { hasPermission, user, scopeOf } = useAuth();
  const P = PERMISSIONS;
  const manage = hasPermission(P.ONBOARDING_MANAGE) || hasPermission(P.PROBATION_MANAGE) || hasPermission(P.OFFBOARDING_MANAGE);
  const view = manage || hasPermission(P.ONBOARDING_VIEW) || hasPermission(P.PROBATION_VIEW) || hasPermission(P.OFFBOARDING_VIEW);
  const reports = hasPermission(P.LIFECYCLE_VIEW_REPORTS) || manage;
  const lifecycleScope = scopeOf(P.ONBOARDING_VIEW, P.PROBATION_VIEW, P.OFFBOARDING_VIEW, P.ONBOARDING_MANAGE, P.PROBATION_MANAGE, P.OFFBOARDING_MANAGE);
  const team = view && lifecycleScope === 'TEAM';
  const selfOnly = view && lifecycleScope === 'SELF';
  return [
    (selfOnly || team) && !!user?.employee && { label: 'My lifecycle', to: '/hrm/lifecycle', end: true },
    (manage || (view && !selfOnly)) && { label: team ? 'Team' : 'Dashboard', to: '/hrm/lifecycle/dashboard' },
    (manage || (view && !selfOnly)) && (hasPermission(P.ONBOARDING_VIEW) || hasPermission(P.ONBOARDING_MANAGE)) && { label: team ? 'Team onboarding' : 'Onboarding', to: '/hrm/lifecycle/onboarding' },
    (manage || (view && !selfOnly)) && (hasPermission(P.PROBATION_VIEW) || hasPermission(P.PROBATION_MANAGE)) && { label: team ? 'Probation reviews' : 'Probation', to: '/hrm/lifecycle/probation' },
    (manage || (view && !selfOnly)) && (hasPermission(P.OFFBOARDING_VIEW) || hasPermission(P.OFFBOARDING_MANAGE)) && { label: team ? 'Team offboarding' : 'Offboarding', to: '/hrm/lifecycle/offboarding' },
    manage && { label: 'Templates', to: '/hrm/lifecycle/templates' },
    reports && { label: 'Reports', to: '/hrm/lifecycle/reports' },
  ].filter(Boolean) as { label: string; to: string; end?: boolean }[];
}
export function LifecycleLayout() {
  const tabs = useLifecycleTabs();
  return (
    <>
      <PageHeader title="Employee lifecycle" description="Onboarding checklists, probation reviews and offboarding cases beside the employee master. Checklists track work; people decide outcomes; only the explicit separation changes employment." />
      {tabs.length > 1 && <div className="mb-5"><Tabs items={tabs} /></div>}
      <Outlet />
    </>
  );
}

/** One task row with the actions the actor may take. Used by every checklist screen. */
export function TaskRow({ task, onUpdate, manage }: { task: LifecycleTaskDto; onUpdate: (input: { status?: string; note?: string | null; documentId?: string | null; assigneeUserId?: string | null; dueDate?: string }) => Promise<unknown>; manage: boolean }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState(task.note ?? '');
  const [documentId, setDocumentId] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const toast = useToast();
  const act = async (input: Parameters<typeof onUpdate>[0]) => { setErr(null); try { await onUpdate(input); toast.success('Task updated'); setOpen(false); } catch (e) { setErr(errorMessage(e)); } };
  return (
    <li className="flex flex-wrap items-start justify-between gap-2 px-4 py-2.5 text-sm">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2"><span className={`font-medium ${task.status === 'COMPLETED' || task.status === 'SKIPPED' ? 'text-slate-400 line-through' : 'text-slate-900'}`}>{task.title}</span><LifecycleBadge status={task.status} />{task.required && <span className="text-[10px] uppercase text-slate-400">required</span>}{task.requiresDocument && <span className="text-[10px] uppercase text-brand-700">document</span>}{task.overdue && <span className="rounded bg-red-50 px-1.5 text-[10px] text-red-700">overdue</span>}{task.unassigned && <span className="rounded bg-amber-50 px-1.5 text-[10px] text-amber-800">unassigned — no account yet</span>}</div>
        <div className="text-xs text-slate-500">{titleCase(task.category)} · due {task.dueDate} · {titleCase(task.assigneeType)}{task.assigneeName && ` — ${task.assigneeName}`}{task.documentTitle && ` · document: ${task.documentTitle}`}{task.completedByName && ` · done by ${task.completedByName}`}</div>
        {task.note !== null && task.note && <div className="mt-0.5 text-xs text-slate-600">Note: {task.note}</div>}
      </div>
      {task.can.update && <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>Update</Button>}
      <Modal open={open} onClose={() => setOpen(false)} title={task.title} description={`${titleCase(task.category)} · due ${task.dueDate}. Completing a task records that it was done; it performs no action in another system.`} footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Close</Button>{(task.status === 'PENDING') && <Button variant="ghost" onClick={() => act({ status: 'IN_PROGRESS', note: note || null })}>Start</Button>}{(!task.required || manage) && <Button variant="ghost" onClick={() => act({ status: 'SKIPPED', note: note || null })}>Skip</Button>}<Button onClick={() => act({ status: 'COMPLETED', note: note || null, documentId: documentId || undefined })}>Mark completed</Button></>}>
        <div className="space-y-3">
          {err && <Alert>{err}</Alert>}
          {task.description && <p className="text-sm text-slate-600">{task.description}</p>}
          <Textarea label="Note (operational only — do not enter passwords or secrets)" value={note} onChange={(e) => setNote(e.target.value)} />
          {task.requiresDocument && <Input label="Document id from the Document Center (upload there first)" value={documentId} onChange={(e) => setDocumentId(e.target.value)} placeholder={task.documentId ? `Linked: ${task.documentTitle ?? task.documentId}` : 'Paste the document id'} />}
          <Button size="sm" variant="ghost" onClick={() => act({ note: note || null })}>Save note only</Button>
        </div>
      </Modal>
    </li>
  );
}
