import { useState } from 'react';
import { Link } from 'react-router-dom';
import { WORKFLOW_SOURCE_MODULES, type WorkflowMonitorRowDto } from '@hr/shared';
import { Card, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Alert } from '@/components/ui/Alert';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { Pagination } from '@/components/ui/Pagination';
import { LoadingBlock } from '@/components/ui/Spinner';
import { PageHeader } from '@/components/layout/PageHeader';
import { useWorkflowMonitor, useWorkflowMonitorInstance, useWorkflowMonitorSummary } from './admin.api';

const titleCase = (s: string) => s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, ' ');
const tone = (s: string) => (s === 'APPROVED' ? 'success' : s === 'REJECTED' ? 'danger' : s === 'PENDING' ? 'warning' : 'neutral');
const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—');

/**
 * Administration → Workflow monitor. Read only, on purpose: an administrator can see what is waiting and on whom,
 * and cannot approve, reject, skip or reassign from here. Every decision stays with the approver the workflow named.
 */
export function WorkflowMonitorPage() {
  const [f, setF] = useState({ module: '', status: '', entityType: '', stalledDays: '', search: '' });
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<string | null>(null);
  const list = useWorkflowMonitor({ ...f, page, pageSize: 20 });
  const summary = useWorkflowMonitorSummary();
  const set = (patch: Partial<typeof f>) => { setF({ ...f, ...patch }); setPage(1); };

  const columns: Column<WorkflowMonitorRowDto>[] = [
    { key: 'd', header: 'Workflow', render: (r) => <span className="font-medium text-slate-900">{r.definition.name}<span className="block text-xs font-normal text-slate-400">{r.definition.code} v{r.definition.version} · {r.moduleLabel}</span></span> },
    { key: 'e', header: 'Record', render: (r) => <span>{titleCase(r.entityType)}<span className="block font-mono text-xs text-slate-400">{r.entityId}</span></span> },
    { key: 'r', header: 'Requested by', hideBelow: 'md', render: (r) => <span>{r.requesterName}<span className="block text-xs text-slate-400">{r.requesterEmployeeCode}</span></span> },
    { key: 'w', header: 'Waiting on', hideBelow: 'sm', render: (r) => (r.status === 'PENDING' ? <span>{r.currentStepName ?? '—'}<span className="block text-xs text-slate-400">{r.currentApproverName ?? 'unresolved'}</span></span> : <span className="text-slate-400">—</span>) },
    { key: 't', header: 'Age', className: 'text-right', render: (r) => (r.waitingDays === null ? <span className="text-slate-400">—</span> : <span className={`tabular-nums ${r.waitingDays >= 7 ? 'font-semibold text-amber-700' : ''}`}>{r.waitingDays}d</span>) },
    { key: 's', header: 'Status', render: (r) => <StatusBadge status={titleCase(r.status)} tone={tone(r.status)} /> },
  ];

  return (
    <>
      <PageHeader title="Workflow monitor" description="Every approval the engine is running, across all modules. Read only: the monitor shows what is waiting and on whom, and never approves, rejects, skips or reassigns anything." />
      {summary.data && (
        <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
          {summary.data.byStatus.map((s) => <div key={s.status} className="rounded-lg border border-slate-200 bg-white p-4"><div className="text-xs font-medium uppercase tracking-wide text-slate-500">{titleCase(s.status)}</div><div className="mt-1 text-2xl font-semibold tabular-nums text-slate-900">{s.count}</div></div>)}
        </div>
      )}
      {summary.data && summary.data.byModule.some((m) => m.pending > 0) && (
        <Card className="mb-4">
          <CardHeader title="Waiting by module" description="The oldest pending approval in each module. Nothing escalates automatically." />
          <div className="overflow-x-auto"><table className="min-w-full text-sm"><thead className="bg-slate-50"><tr>{['Module', 'Pending', 'Total', 'Oldest'].map((h) => <th key={h} className="px-4 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">{h}</th>)}</tr></thead>
            <tbody className="divide-y divide-slate-100">{summary.data.byModule.filter((m) => m.total > 0).map((m) => (
              <tr key={m.module}><td className="px-4 py-2">{m.moduleLabel}</td><td className="px-4 py-2 tabular-nums">{m.pending}</td><td className="px-4 py-2 tabular-nums">{m.total}</td><td className="px-4 py-2 tabular-nums">{m.oldestPendingDays === null ? '—' : `${m.oldestPendingDays}d`}</td></tr>
            ))}</tbody></table></div>
        </Card>
      )}
      <Card>
        <div className="grid grid-cols-1 gap-3 border-b border-slate-200 p-4 sm:grid-cols-5">
          <Select options={Object.entries(WORKFLOW_SOURCE_MODULES).map(([value, m]) => ({ value, label: m.label }))} placeholder="All modules" value={f.module} onChange={(e) => set({ module: e.target.value })} />
          <Select options={['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'].map((s) => ({ value: s, label: titleCase(s) }))} placeholder="All statuses" value={f.status} onChange={(e) => set({ status: e.target.value })} />
          <Input placeholder="Entity type" value={f.entityType} onChange={(e) => set({ entityType: e.target.value })} />
          <Select options={[{ value: '3', label: 'Waiting over 3 days' }, { value: '7', label: 'Waiting over 7 days' }, { value: '14', label: 'Waiting over 14 days' }]} placeholder="Any age" value={f.stalledDays} onChange={(e) => set({ stalledDays: e.target.value })} />
          <Input placeholder="Requester or record id" value={f.search} onChange={(e) => set({ search: e.target.value })} />
        </div>
        {list.isError && <Alert className="m-4">Could not load workflow instances.</Alert>}
        <DataTable columns={columns} rows={list.data?.data ?? []} rowKey={(r) => r.id} loading={list.isLoading} onRowClick={(r) => setOpen(r.id)} emptyTitle="No workflow instances" emptyDescription="Nothing matches these filters." />
        {list.data?.meta && <Pagination {...list.data.meta} onPageChange={setPage} />}
      </Card>
      {open && <InstanceModal id={open} onClose={() => setOpen(null)} />}
    </>
  );
}

/**
 * One instance. Approver comments are the approver's confidential words about a business record, so they are shown
 * only to a caller who already holds a permission that opens that module; otherwise the monitor says a comment
 * exists and how long it was. The same rule decides whether the link to the record is offered.
 */
function InstanceModal({ id, onClose }: { id: string; onClose: () => void }) {
  const q = useWorkflowMonitorInstance(id);
  if (!q.data) return <Modal open onClose={onClose} title="Workflow instance">{q.isError ? <Alert>Could not load this instance.</Alert> : <LoadingBlock />}</Modal>;
  const d = q.data;
  return (
    <Modal open onClose={onClose} size="lg" title={`${d.definition.name} · ${titleCase(d.status)}`} description={`${d.moduleLabel} · ${titleCase(d.entityType)} · requested by ${d.requesterName} (${d.requesterEmployeeCode}) on ${fmt(d.submittedAt)}`}
      footer={<>{d.canOpenSource && d.sourcePath && <Link to={d.sourcePath}><Button variant="secondary">Open {d.moduleLabel}</Button></Link>}<Button variant="secondary" onClick={onClose}>Close</Button></>}>
      <div className="space-y-4 text-sm">
        <div className="flex flex-wrap items-center gap-3">
          <StatusBadge status={titleCase(d.status)} tone={tone(d.status)} />
          <span className="text-xs text-slate-500">{d.definition.code} v{d.definition.version}</span>
          {d.waitingDays !== null && <span className="text-xs text-slate-500">waiting {d.waitingDays} day(s)</span>}
          {d.completedAt && <span className="text-xs text-slate-500">completed {fmt(d.completedAt)}</span>}
        </div>
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
          Record identifier <span className="font-mono text-slate-900">{d.entityId}</span>
          <span className="mt-1 block">{d.canOpenSource ? `You hold a permission for ${d.moduleLabel}, so the record can be opened there.` : `Opening this record needs a ${d.moduleLabel} permission, which this account does not hold. The monitor shows workflow metadata only.`}</span>
        </div>
        <div>
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Steps</div>
          <ul className="mt-1 divide-y divide-slate-100 rounded-lg border border-slate-200">{d.steps.map((s) => (
            <li key={s.stepOrder} className="p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span><span className="font-medium text-slate-900">{s.stepOrder}. {s.name}</span><span className="block text-xs text-slate-500">{titleCase(s.approverType)}{s.approverName ? ` · ${s.approverName}` : ' · not resolved'}</span></span>
                <span className="text-right"><StatusBadge status={titleCase(s.status)} tone={tone(s.status)} /><span className="mt-1 block text-xs text-slate-400">{s.actedAt ? `${fmt(s.actedAt)}${s.actedByName ? ` · ${s.actedByName}` : ''}` : ''}</span></span>
              </div>
              {s.skipReason && <p className="mt-1 text-xs text-slate-500">Skipped: {s.skipReason}</p>}
              {s.comment && <p className="mt-1 whitespace-pre-wrap text-slate-700">{s.comment}</p>}
              {s.commentRedacted && <p className="mt-1 text-xs italic text-slate-400">A decision comment of {s.commentLength} characters is recorded. Reading it needs a {d.moduleLabel} permission.</p>}
            </li>
          ))}</ul>
        </div>
        {d.history.length > 0 && (
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Timeline</div>
            <ol className="mt-1 space-y-1 text-xs text-slate-600">{d.history.map((h, i) => (
              <li key={i}>{fmt(h.at)} · {titleCase(h.action)}{h.stepOrder ? ` · step ${h.stepOrder}` : ''}{h.actorName ? ` · ${h.actorName}` : ''}{h.comment ? ` · ${h.comment}` : h.commentRedacted ? ' · comment recorded (not shown)' : ''}</li>
            ))}</ol>
          </div>
        )}
        <p className="text-xs text-slate-400">The monitor never reads the business record behind an instance, so no amount, description, narrative or answer from the source module can appear here.</p>
      </div>
    </Modal>
  );
}
