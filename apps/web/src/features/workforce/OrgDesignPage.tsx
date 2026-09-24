import { useState } from 'react';
import { ChevronDown, ChevronRight, Copy, Plus } from 'lucide-react';
import { PERMISSIONS, type OrgDesignNodeDto, type OrgDesignScenarioDto } from '@hr/shared';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Alert } from '@/components/ui/Alert';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { LoadingBlock } from '@/components/ui/Spinner';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { useToast } from '@/components/ui/Toast';
import { useAuth } from '@/hooks/useAuth';
import { errorMessage } from '@/features/organization/shared';
import { useScenarioComparison, useScenarioTree, useScenarios, useWorkforceCycles, useWorkforceMutations, useWorkforceOptions } from './workforce.api';
import { Delta, titleCase } from './workforce-ui';

/**
 * Organization design: scenarios of a target structure beside the live one. A simple tree — units with planned
 * headcount per job — with "current" shown for units that point at a real department and 0 for planned-only ones.
 * Finalizing freezes the target; it never creates a department, a position or a job.
 */
export function OrgDesignPage() {
  const { hasPermission } = useAuth();
  const manage = hasPermission(PERMISSIONS.ORG_DESIGN_MANAGE);
  const [status, setStatus] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const list = useScenarios({ status, page: 1, pageSize: 100 });
  const columns: Column<OrgDesignScenarioDto>[] = [
    { key: 'name', header: 'Scenario', render: (s) => <div><div className="font-medium text-slate-900">{s.name}</div><div className="text-xs text-slate-400">{s.organizationName}{s.planningCycleName && ` · ${s.planningCycleName}`}</div></div> },
    { key: 'units', header: 'Units', hideBelow: 'sm', render: (s) => <span className="tabular-nums">{s.nodeCount}</span> },
    { key: 'hc', header: 'Planned HC', render: (s) => <span className="tabular-nums">{s.plannedHeadcount}</span> },
    { key: 'status', header: 'Status', render: (s) => <StatusBadge status={titleCase(s.status)} tone={s.status === 'FINALIZED' ? 'success' : 'neutral'} /> },
  ];
  return (
    <>
      <Card>
        <div className="grid grid-cols-1 gap-3 border-b border-slate-200 p-4 sm:grid-cols-3">
          <Select options={['DRAFT', 'FINALIZED', 'ARCHIVED'].map((s) => ({ value: s, label: titleCase(s) }))} placeholder="All statuses" value={status} onChange={(e) => setStatus(e.target.value)} />
          <div />
          {manage && <div className="flex justify-end"><Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> Scenario</Button></div>}
        </div>
        {list.isError && <Alert className="m-4">Could not load scenarios.</Alert>}
        <DataTable columns={columns} rows={list.data?.data ?? []} rowKey={(s) => s.id} loading={list.isLoading} onRowClick={(s) => setOpenId(s.id)} emptyTitle="No scenarios" emptyDescription='A scenario answers "what would the organization look like if…" — e.g. 2027 Target Org, Sales restructure.' />
      </Card>
      {creating && <ScenarioFormModal onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); setOpenId(id); }} />}
      {openId && <ScenarioModal id={openId} onClose={() => setOpenId(null)} />}
    </>
  );
}

function ScenarioFormModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const m = useWorkforceMutations();
  const options = useWorkforceOptions();
  const cycles = useWorkforceCycles({ page: 1, pageSize: 100 });
  const [form, setForm] = useState({ name: '', organizationId: '', planningCycleId: '', description: '' });
  const [err, setErr] = useState<string | null>(null);
  const submit = async () => { setErr(null); try { const s = await m.createScenario.mutateAsync({ name: form.name, organizationId: form.organizationId, planningCycleId: form.planningCycleId || null, description: form.description || null }); onCreated(s.id); } catch (e) { setErr(errorMessage(e)); } };
  return (
    <Modal open onClose={onClose} title="New organization-design scenario" description="Starts with the organization as its root. Import the current departments, then add planned units and headcount." footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={submit} loading={m.createScenario.isPending} disabled={!form.name || !form.organizationId}>Create</Button></>}>
      <div className="space-y-3">
        {err && <Alert>{err}</Alert>}
        <Input label="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="2027 Target Organization" />
        <Select label="Organization" options={(options.data?.organizations ?? []).map((o) => ({ value: o.id, label: o.name }))} placeholder="Choose" value={form.organizationId} onChange={(e) => setForm({ ...form, organizationId: e.target.value })} />
        <Select label="Planning cycle (optional)" options={(cycles.data?.data ?? []).map((c) => ({ value: c.id, label: c.name }))} placeholder="None" value={form.planningCycleId} onChange={(e) => setForm({ ...form, planningCycleId: e.target.value })} />
        <Textarea label="Description" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
      </div>
    </Modal>
  );
}

function NodeRow({ node, depth, editable, onAddUnit, onAddPosition, onEditPosition, onDelete }: { node: OrgDesignNodeDto; depth: number; editable: boolean; onAddUnit: (parent: OrgDesignNodeDto) => void; onAddPosition: (node: OrgDesignNodeDto) => void; onEditPosition: (node: OrgDesignNodeDto, positionId: string) => void; onDelete: (node: OrgDesignNodeDto) => void }) {
  const [open, setOpen] = useState(true);
  return (
    <li>
      <div className="flex flex-wrap items-center gap-2 py-1.5" style={{ paddingLeft: depth * 20 }}>
        <button type="button" className="text-slate-400" onClick={() => setOpen(!open)} aria-label={open ? 'Collapse' : 'Expand'}>{node.children.length || node.positions.length ? (open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />) : <span className="inline-block h-4 w-4" />}</button>
        <span className={`font-medium ${node.plannedOnly ? 'text-brand-700' : 'text-slate-900'}`}>{node.name}</span>
        <span className="text-xs text-slate-400">{titleCase(node.nodeType)}{node.code && ` · ${node.code}`}</span>
        {node.plannedOnly && node.nodeType !== 'ORGANIZATION' && <span className="rounded bg-brand-50 px-1.5 text-[10px] font-medium text-brand-700">planned only</span>}
        <span className="ml-auto text-xs tabular-nums text-slate-600">current {node.currentHeadcount} · planned {node.plannedHeadcount} · <Delta value={node.plannedHeadcount - node.currentHeadcount} /></span>
        {editable && <span className="flex gap-1"><Button size="sm" variant="ghost" onClick={() => onAddUnit(node)}>+ Unit</Button>{node.nodeType !== 'ORGANIZATION' && <Button size="sm" variant="ghost" onClick={() => onAddPosition(node)}>+ Headcount</Button>}{node.nodeType !== 'ORGANIZATION' && node.children.length === 0 && <Button size="sm" variant="ghost" onClick={() => onDelete(node)}>Remove</Button>}</span>}
      </div>
      {open && node.positions.length > 0 && (
        <ul style={{ paddingLeft: depth * 20 + 28 }} className="mb-1 space-y-0.5 text-xs text-slate-600">
          {node.positions.map((p) => <li key={p.id} className="flex items-center gap-2"><span>{p.jobTitle ?? <span className="italic">{p.plannedJobTitle} (new job title — no Job master created)</span>}</span><span className="tabular-nums font-medium">× {p.plannedHeadcount}</span>{editable && <button type="button" className="text-brand-700 underline" onClick={() => onEditPosition(node, p.id)}>edit</button>}</li>)}
        </ul>
      )}
      {open && node.children.length > 0 && <ul>{node.children.map((c) => <NodeRow key={c.id} node={c} depth={depth + 1} editable={editable} onAddUnit={onAddUnit} onAddPosition={onAddPosition} onEditPosition={onEditPosition} onDelete={onDelete} />)}</ul>}
    </li>
  );
}

function ScenarioModal({ id, onClose }: { id: string; onClose: () => void }) {
  const tree = useScenarioTree(id);
  const cmp = useScenarioComparison(id);
  const m = useWorkforceMutations();
  const toast = useToast();
  const options = useWorkforceOptions();
  const [view, setView] = useState<'target' | 'compare'>('target');
  const [unitFor, setUnitFor] = useState<OrgDesignNodeDto | null>(null);
  const [posFor, setPosFor] = useState<{ node: OrgDesignNodeDto; positionId: string | null } | null>(null);
  const [confirm, setConfirm] = useState<'FINALIZED' | 'ARCHIVED' | 'duplicate' | null>(null);
  const [copyName, setCopyName] = useState('');
  const [deleting, setDeleting] = useState<OrgDesignNodeDto | null>(null);
  const s = tree.data?.scenario;
  const editable = !!s?.can.edit;
  const act = async (fn: () => Promise<unknown>, ok: string) => { try { await fn(); toast.success(ok); } catch (e) { toast.error(errorMessage(e)); } };
  return (
    <Modal open onClose={onClose} title={s?.name ?? 'Scenario'} description={s ? `${s.organizationName} · ${titleCase(s.status)}${s.finalizedAt ? ` · frozen ${new Date(s.finalizedAt).toLocaleDateString()}` : ''}` : undefined} size="lg"
      footer={<>
        {editable && <Button variant="ghost" onClick={() => act(async () => { const r = await m.importCurrent.mutateAsync(id); return r; }, 'Current departments imported')} loading={m.importCurrent.isPending}>Import current departments</Button>}
        {s && <Button variant="ghost" onClick={() => { setCopyName(`${s.name} (copy)`); setConfirm('duplicate'); }}><Copy className="h-3.5 w-3.5" /> Duplicate</Button>}
        {editable && <Button variant="secondary" onClick={() => setConfirm('FINALIZED')}>Finalize target</Button>}
        {s && s.status !== 'ARCHIVED' && s.can.edit === false && s.status === 'FINALIZED' && <Button variant="ghost" onClick={() => setConfirm('ARCHIVED')}>Archive</Button>}
        <Button variant="secondary" onClick={onClose}>Close</Button>
      </>}>
      {tree.isLoading && <LoadingBlock />}
      {tree.isError && <Alert>Could not load the scenario.</Alert>}
      {tree.data && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <div className="inline-flex rounded-md border border-slate-200 p-0.5"><button type="button" className={`rounded px-3 py-1 ${view === 'target' ? 'bg-slate-900 text-white' : 'text-slate-600'}`} onClick={() => setView('target')}>Target structure</button><button type="button" className={`rounded px-3 py-1 ${view === 'compare' ? 'bg-slate-900 text-white' : 'text-slate-600'}`} onClick={() => setView('compare')}>Current vs target</button></div>
            <span className="ml-auto text-xs tabular-nums text-slate-600">current {tree.data.totals.current} · planned {tree.data.totals.planned} · <Delta value={tree.data.totals.delta} /> · {tree.data.totals.plannedOnlyNodes} planned-only unit(s)</span>
          </div>
          {view === 'target' && <ul className="rounded-md border border-slate-200 px-3 py-1" data-testid="org-design-tree">{tree.data.roots.map((n) => <NodeRow key={n.id} node={n} depth={0} editable={editable} onAddUnit={setUnitFor} onAddPosition={(node) => setPosFor({ node, positionId: null })} onEditPosition={(node, positionId) => setPosFor({ node, positionId })} onDelete={setDeleting} />)}</ul>}
          {view === 'compare' && cmp.data && (
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              <div className="rounded-md border border-slate-200"><div className="px-3 py-2 text-xs font-semibold uppercase text-slate-500">Units</div><table className="min-w-full text-sm"><tbody className="divide-y divide-slate-100">{cmp.data.byDepartment.map((d) => <tr key={d.name}><td className="px-3 py-1.5">{d.name}{d.plannedOnly && <span className="ml-1 text-[10px] text-brand-700">planned only</span>}</td><td className="px-3 py-1.5 tabular-nums">{d.current}</td><td className="px-3 py-1.5 tabular-nums">{d.planned}</td><td className="px-3 py-1.5"><Delta value={d.delta} /></td></tr>)}</tbody></table></div>
              <div className="rounded-md border border-slate-200"><div className="px-3 py-2 text-xs font-semibold uppercase text-slate-500">Jobs</div><table className="min-w-full text-sm"><tbody className="divide-y divide-slate-100">{cmp.data.byJob.map((j) => <tr key={j.jobTitle}><td className="px-3 py-1.5">{j.jobTitle}</td><td className="px-3 py-1.5 tabular-nums">{j.current}</td><td className="px-3 py-1.5 tabular-nums">{j.planned}</td><td className="px-3 py-1.5"><Delta value={j.delta} /></td></tr>)}</tbody></table></div>
            </div>
          )}
          <p className="text-xs text-slate-400">Planned-only units and new job titles exist in this scenario only. Nothing here creates or changes a live department, position or job.</p>
        </div>
      )}
      {unitFor && <UnitModal scenarioId={id} parent={unitFor} departments={(options.data?.departments ?? []).filter((d) => d.organizationId === s?.organizationId)} onClose={() => setUnitFor(null)} />}
      {posFor && tree.data && <PositionModal scenarioId={id} node={posFor.node} positionId={posFor.positionId} jobs={options.data?.jobs ?? []} onClose={() => setPosFor(null)} />}
      <ConfirmDialog open={!!deleting} title={`Remove ${deleting?.name}?`} message="Only this planned unit and its planned headcount are removed from the scenario. No live department is affected." confirmLabel="Remove" variant="danger" loading={m.deleteNode.isPending} onConfirm={() => { if (deleting) act(() => m.deleteNode.mutateAsync({ scenarioId: id, nodeId: deleting.id }), 'Unit removed'); setDeleting(null); }} onCancel={() => setDeleting(null)} />
      <ConfirmDialog open={confirm === 'FINALIZED' || confirm === 'ARCHIVED'} title={confirm === 'FINALIZED' ? 'Finalize this target organization?' : 'Archive this scenario?'} message={confirm === 'FINALIZED' ? 'An immutable snapshot of the target is stored. The live organization is not changed; restructuring is executed through the Organization pages when decided.' : 'The scenario becomes historical.'} confirmLabel={confirm === 'FINALIZED' ? 'Finalize' : 'Archive'} loading={m.transitionScenario.isPending} onConfirm={() => { if (confirm && confirm !== 'duplicate') act(() => m.transitionScenario.mutateAsync({ id, status: confirm }), `Scenario ${confirm.toLowerCase()}`); setConfirm(null); }} onCancel={() => setConfirm(null)} />
      <Modal open={confirm === 'duplicate'} onClose={() => setConfirm(null)} title="Duplicate scenario" description="A copy with the same structure and headcount. Editing the copy never changes the original." footer={<><Button variant="secondary" onClick={() => setConfirm(null)}>Cancel</Button><Button onClick={() => { act(() => m.duplicateScenario.mutateAsync({ id, name: copyName }), 'Scenario duplicated'); setConfirm(null); }} loading={m.duplicateScenario.isPending}>Duplicate</Button></>}><Input label="Name of the copy" value={copyName} onChange={(e) => setCopyName(e.target.value)} /></Modal>
    </Modal>
  );
}

function UnitModal({ scenarioId, parent, departments, onClose }: { scenarioId: string; parent: OrgDesignNodeDto; departments: { id: string; name: string }[]; onClose: () => void }) {
  const m = useWorkforceMutations();
  const toast = useToast();
  const [form, setForm] = useState({ nodeType: parent.nodeType === 'ORGANIZATION' ? 'DEPARTMENT' : 'TEAM', name: '', code: '', sourceDepartmentId: '' });
  const [err, setErr] = useState<string | null>(null);
  const submit = async () => { setErr(null); try { await m.createNode.mutateAsync({ scenarioId, input: { nodeType: form.nodeType as 'DEPARTMENT' | 'TEAM', name: form.name || (departments.find((d) => d.id === form.sourceDepartmentId)?.name ?? ''), code: form.code || null, parentNodeId: parent.id, sourceDepartmentId: form.sourceDepartmentId || null } }); toast.success('Unit added'); onClose(); } catch (e) { setErr(errorMessage(e)); } };
  return (
    <Modal open onClose={onClose} title={`Add a unit under ${parent.name}`} description="Reference a current department (its headcount shows as current) or add a planned-only unit that does not exist yet." footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={submit} loading={m.createNode.isPending} disabled={!form.name && !form.sourceDepartmentId}>Add</Button></>}>
      <div className="space-y-3">
        {err && <Alert>{err}</Alert>}
        <Select label="Type" options={[{ value: 'DEPARTMENT', label: 'Department' }, { value: 'TEAM', label: 'Team' }]} value={form.nodeType} onChange={(e) => setForm({ ...form, nodeType: e.target.value })} />
        <Select label="Current department (optional)" options={departments.map((d) => ({ value: d.id, label: d.name }))} placeholder="Planned-only unit" value={form.sourceDepartmentId} onChange={(e) => setForm({ ...form, sourceDepartmentId: e.target.value })} />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3"><div className="sm:col-span-2"><Input label="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={form.sourceDepartmentId ? 'Defaults to the department name' : 'e.g. AI Team'} /></div><Input label="Code" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} /></div>
      </div>
    </Modal>
  );
}

function PositionModal({ scenarioId, node, positionId, jobs, onClose }: { scenarioId: string; node: OrgDesignNodeDto; positionId: string | null; jobs: { id: string; title: string }[]; onClose: () => void }) {
  const m = useWorkforceMutations();
  const toast = useToast();
  const existing = positionId ? node.positions.find((p) => p.id === positionId) : null;
  const [form, setForm] = useState({ jobId: existing?.jobId ?? '', plannedJobTitle: existing?.plannedJobTitle ?? '', plannedHeadcount: String(existing?.plannedHeadcount ?? 1), notes: existing?.notes ?? '' });
  const [err, setErr] = useState<string | null>(null);
  const submit = async () => {
    setErr(null);
    try {
      if (existing) await m.updatePosition.mutateAsync({ scenarioId, positionId: existing.id, input: { jobId: form.jobId || null, plannedJobTitle: form.jobId ? null : form.plannedJobTitle || null, plannedHeadcount: Number(form.plannedHeadcount), notes: form.notes || null } });
      else await m.createPosition.mutateAsync({ scenarioId, input: { nodeId: node.id, jobId: form.jobId || null, plannedJobTitle: form.jobId ? null : form.plannedJobTitle || null, plannedHeadcount: Number(form.plannedHeadcount), notes: form.notes || null } });
      toast.success('Planned headcount saved'); onClose();
    } catch (e) { setErr(errorMessage(e)); }
  };
  const remove = async () => { if (!existing) return; try { await m.deletePosition.mutateAsync({ scenarioId, positionId: existing.id }); toast.success('Removed'); onClose(); } catch (e) { setErr(errorMessage(e)); } };
  return (
    <Modal open onClose={onClose} title={`Planned headcount in ${node.name}`} description="Choose an existing job, or type a job title that does not exist yet (nothing is added to the Job master)." footer={<>{existing && <Button variant="ghost" onClick={remove}>Remove</Button>}<Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={submit} loading={m.createPosition.isPending || m.updatePosition.isPending} disabled={!form.jobId && !form.plannedJobTitle}>Save</Button></>}>
      <div className="space-y-3">
        {err && <Alert>{err}</Alert>}
        <Select label="Job" options={jobs.map((j) => ({ value: j.id, label: j.title }))} placeholder="New job title (below)" value={form.jobId} onChange={(e) => setForm({ ...form, jobId: e.target.value })} />
        {!form.jobId && <Input label="Planned job title" value={form.plannedJobTitle} onChange={(e) => setForm({ ...form, plannedJobTitle: e.target.value })} placeholder="e.g. AI Engineer" />}
        <Input label="Planned headcount" type="number" min={0} value={form.plannedHeadcount} onChange={(e) => setForm({ ...form, plannedHeadcount: e.target.value })} />
        <Textarea label="Notes" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
      </div>
    </Modal>
  );
}
