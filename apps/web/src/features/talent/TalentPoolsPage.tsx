import { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { PERMISSIONS, type TalentPoolDto, type TalentPoolMemberDto } from '@hr/shared';
import { Card, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Alert } from '@/components/ui/Alert';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { Checkbox } from '@/components/ui/Checkbox';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingBlock } from '@/components/ui/Spinner';
import { useToast } from '@/components/ui/Toast';
import { useAuth } from '@/hooks/useAuth';
import { errorMessage } from '@/features/organization/shared';
import { useRecruitmentOptions } from '@/features/recruitment/recruitment.api';
import { EmployeePicker, type PayrollEmployeeOption } from '@/features/payroll/employee-picker';
import { usePoolMembers, useTalentMutations, useTalentPools } from './talent.api';
import { StatusBadge } from '@/components/ui/StatusBadge';

/** Pools the organization names; members HR adds by hand, with a reason and history. Nothing joins a pool because of a cell. */
export function TalentPoolsPage() {
  const { hasPermission } = useAuth();
  const manage = hasPermission(PERMISSIONS.TALENT_MANAGE);
  const pools = useTalentPools(manage);
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState<TalentPoolDto | null>(null);
  return (
    <div className="space-y-4">
      {manage && <div className="flex justify-end"><Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> Pool</Button></div>}
      {pools.isLoading && <LoadingBlock />}
      {pools.isError && <Alert>Could not load talent pools.</Alert>}
      {pools.data?.length === 0 && <Card><EmptyState title="No talent pools" description="A pool is a named group the organization is watching or developing — Leadership Pipeline, Critical Tech Talent, whatever fits. Members are added by hand." /></Card>}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {(pools.data ?? []).map((p) => (
          <Card key={p.id}>
            <button type="button" className="w-full text-left" onClick={() => setOpen(p)} disabled={!manage}>
              <CardHeader title={`${p.name}${p.isActive ? '' : ' (inactive)'}`} description={`${p.code}${p.organization ? ` · ${p.organization.name}` : ''}`} />
              <div className="px-5 pb-4 text-sm text-slate-700"><span className="text-2xl font-semibold tabular-nums text-slate-900">{p.activeMembers}</span> active member(s){p.description && <p className="mt-1 text-xs text-slate-500">{p.description}</p>}</div>
            </button>
          </Card>
        ))}
      </div>
      <PoolFormModal open={creating} onClose={() => setCreating(false)} />
      <PoolDetailModal pool={open} onClose={() => setOpen(null)} />
    </div>
  );
}

function PoolFormModal({ open, onClose, existing }: { open: boolean; onClose: () => void; existing?: TalentPoolDto | null }) {
  const m = useTalentMutations();
  const toast = useToast();
  const options = useRecruitmentOptions();
  const [code, setCode] = useState(''); const [name, setName] = useState(''); const [description, setDesc] = useState(''); const [organizationId, setOrg] = useState(''); const [isActive, setActive] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (open) { setErr(null); setCode(existing?.code ?? ''); setName(existing?.name ?? ''); setDesc(existing?.description ?? ''); setOrg(existing?.organization?.id ?? ''); setActive(existing?.isActive ?? true); } }, [open, existing]);
  const submit = async () => { setErr(null); try { if (existing) await m.updatePool.mutateAsync({ id: existing.id, input: { name, description: description || null, organizationId: organizationId || null, isActive } }); else await m.createPool.mutateAsync({ code, name, description: description || null, organizationId: organizationId || null, isActive }); toast.success(existing ? 'Pool updated' : 'Pool created'); onClose(); } catch (e) { setErr(errorMessage(e)); } };
  return (
    <Modal open={open} onClose={onClose} title={existing ? `Edit ${existing.code}` : 'New talent pool'} size="md" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={submit} loading={m.createPool.isPending || m.updatePool.isPending} disabled={(!existing && !code.trim()) || !name.trim()}>{existing ? 'Save' : 'Create'}</Button></>}>
      <div className="space-y-3">
        {err && <Alert>{err}</Alert>}
        {!existing && <Input label="Code" required value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} />}
        <Input label="Name" required value={name} onChange={(e) => setName(e.target.value)} />
        <Select label="Organization" options={(options.data?.organizations ?? []).map((o) => ({ value: o.id, label: o.name }))} placeholder="All organizations" value={organizationId} onChange={(e) => setOrg(e.target.value)} />
        <Textarea label="Description" rows={2} value={description} onChange={(e) => setDesc(e.target.value)} />
        <Checkbox label="Active" checked={isActive} onChange={(e) => setActive(e.target.checked)} />
      </div>
    </Modal>
  );
}

function PoolDetailModal({ pool, onClose }: { pool: TalentPoolDto | null; onClose: () => void }) {
  const [includeRemoved, setIncludeRemoved] = useState(false);
  const members = usePoolMembers(pool?.id ?? null, includeRemoved);
  const m = useTalentMutations();
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(false);
  const [employee, setEmployee] = useState<PayrollEmployeeOption | null>(null);
  const [reason, setReason] = useState('');
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (pool) { setErr(null); setAdding(false); setEmployee(null); setReason(''); setIncludeRemoved(false); } }, [pool]);
  const add = async () => { setErr(null); try { await m.addMember.mutateAsync({ id: pool!.id, input: { employeeId: employee!.id, reason: reason || null } }); toast.success('Member added'); setAdding(false); setEmployee(null); setReason(''); } catch (e) { setErr(errorMessage(e)); } };
  const remove = async (member: TalentPoolMemberDto) => { setErr(null); try { await m.removeMember.mutateAsync({ id: pool!.id, memberId: member.id, input: {} }); toast.success('Member removed — the record is kept'); } catch (e) { setErr(errorMessage(e)); } };
  const columns: Column<TalentPoolMemberDto>[] = [
    { key: 'who', header: 'Member', render: (r) => <div><div className="font-medium text-slate-900">{r.employee.firstName} {r.employee.lastName}</div><div className="text-xs text-slate-400">{r.employee.employeeCode} · {r.employee.jobTitle ?? '—'}{r.employee.departmentName && ` · ${r.employee.departmentName}`}</div></div> },
    { key: 'added', header: 'Added', hideBelow: 'sm', render: (r) => <span className="text-slate-600">{r.addedAt.slice(0, 10)}{r.addedBy && ` by ${r.addedBy}`}</span> },
    { key: 'reason', header: 'Reason', hideBelow: 'md', render: (r) => <span className="text-slate-600">{r.reason ?? '—'}{r.sourceTalentReview && <span className="block text-xs text-slate-400">from {r.sourceTalentReview.cycleName}</span>}</span> },
    { key: 'status', header: 'Status', render: (r) => (r.status === 'ACTIVE' ? <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); remove(r); }}>Remove</Button> : <span className="text-xs text-slate-500"><StatusBadge status="Removed" tone="neutral" /> {r.removedAt?.slice(0, 10)}{r.removalReason && ` · ${r.removalReason}`}</span>) },
  ];
  return (
    <>
      <Modal open={!!pool && !editing} onClose={onClose} title={pool?.name ?? 'Pool'} description={pool ? `${pool.code}${pool.description ? ` · ${pool.description}` : ''}` : undefined} size="lg"
        footer={<div className="flex flex-wrap justify-end gap-2"><Button variant="secondary" onClick={onClose}>Close</Button><Button variant="secondary" onClick={() => setEditing(true)}>Edit pool</Button><Button onClick={() => setAdding(true)}>Add member</Button></div>}>
        {err && <Alert className="mb-3">{err}</Alert>}
        {adding && (
          <div className="mb-4 space-y-2 rounded-md border border-slate-200 bg-slate-50 p-3">
            <EmployeePicker value={employee} onChange={setEmployee} endpoint="/talent/employee-options" />
            <Input label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why this person is in the pool" />
            <div className="flex gap-2"><Button size="sm" onClick={add} loading={m.addMember.isPending} disabled={!employee}>Add</Button><Button size="sm" variant="ghost" onClick={() => setAdding(false)}>Cancel</Button></div>
          </div>
        )}
        <div className="mb-2"><Checkbox label="Show removed members" checked={includeRemoved} onChange={(e) => setIncludeRemoved(e.target.checked)} /></div>
        <DataTable columns={columns} rows={members.data ?? []} rowKey={(r) => r.id} loading={members.isLoading} emptyTitle="No members" emptyDescription="Members are added by hand. No 9-box cell adds anybody." />
        <p className="mt-2 text-xs text-slate-500">Removal keeps the record with who removed it and when. Employees are not notified of pool membership.</p>
      </Modal>
      <PoolFormModal open={editing} onClose={() => setEditing(false)} existing={pool} />
    </>
  );
}
