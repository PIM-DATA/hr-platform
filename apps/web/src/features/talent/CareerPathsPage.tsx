import { useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import type { CareerPathDto } from '@hr/shared';
import { Card, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Alert } from '@/components/ui/Alert';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { Checkbox } from '@/components/ui/Checkbox';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingBlock } from '@/components/ui/Spinner';
import { useToast } from '@/components/ui/Toast';
import { errorMessage } from '@/features/organization/shared';
import { useRecruitmentOptions } from '@/features/recruitment/recruitment.api';
import { useCareerPaths, useJobOptions, useTalentMutations } from './talent.api';

/** Career architecture: paths as cards, each a list of job → job steps. Requirements live on the job profile (Competency). */
export function CareerPathsPage() {
  const paths = useCareerPaths(true);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<CareerPathDto | null>(null);
  const [addingTo, setAddingTo] = useState<CareerPathDto | null>(null);
  const m = useTalentMutations();
  const toast = useToast();
  const removeStep = async (path: CareerPathDto, stepId: string) => { try { await m.removeStep.mutateAsync({ id: path.id, stepId }); toast.success('Step removed'); } catch (e) { toast.error(errorMessage(e)); } };
  return (
    <div className="space-y-4">
      <div className="flex justify-end"><Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> Career path</Button></div>
      {paths.isLoading && <LoadingBlock />}
      {paths.isError && <Alert>Could not load career paths.</Alert>}
      {paths.data?.length === 0 && <Card><EmptyState title="No career paths" description="A path is a set of job-to-job transitions the organization considers possible. Requirements come from each job's competency profile." /></Card>}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {(paths.data ?? []).map((p) => (
          <Card key={p.id}>
            <CardHeader title={`${p.name}${p.isActive ? '' : ' (inactive)'}`} description={`${p.code}${p.organization ? ` · ${p.organization.name}` : ' · all organizations'}${p.description ? ` · ${p.description}` : ''}`} />
            <div className="space-y-2 p-4 text-sm">
              {p.steps.length === 0 ? <p className="text-slate-500">No steps yet.</p> : (
                <ol className="space-y-1.5">
                  {p.steps.map((s) => (
                    <li key={s.id} className="flex flex-wrap items-center gap-2">
                      <span className="rounded-full border border-slate-200 bg-white px-2 py-0.5">{s.fromJob.title}</span><span className="text-slate-400">→</span><span className="rounded-full border border-slate-200 bg-white px-2 py-0.5">{s.toJob.title}</span>
                      {s.stepOrder && <span className="text-xs text-slate-400">step {s.stepOrder}</span>}{s.description && <span className="text-xs text-slate-500">{s.description}</span>}
                      <button type="button" aria-label="Remove step" className="ml-auto text-slate-400 hover:text-red-600" onClick={() => removeStep(p, s.id)}><Trash2 className="h-4 w-4" /></button>
                    </li>
                  ))}
                </ol>
              )}
              <div className="flex gap-2 pt-1"><Button size="sm" variant="secondary" onClick={() => setAddingTo(p)}>Add step</Button><Button size="sm" variant="ghost" onClick={() => setEditing(p)}>Edit</Button></div>
            </div>
          </Card>
        ))}
      </div>
      <p className="text-xs text-slate-500">A path defines what is possible, not who is entitled to what. It never promotes anybody.</p>
      <PathFormModal open={creating || !!editing} onClose={() => { setCreating(false); setEditing(null); }} existing={editing} />
      <AddStepModal path={addingTo} onClose={() => setAddingTo(null)} />
    </div>
  );
}

function PathFormModal({ open, onClose, existing }: { open: boolean; onClose: () => void; existing: CareerPathDto | null }) {
  const m = useTalentMutations();
  const toast = useToast();
  const options = useRecruitmentOptions();
  const [code, setCode] = useState(''); const [name, setName] = useState(''); const [organizationId, setOrg] = useState(''); const [description, setDesc] = useState(''); const [isActive, setActive] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (open) { setErr(null); setCode(existing?.code ?? ''); setName(existing?.name ?? ''); setOrg(existing?.organization?.id ?? ''); setDesc(existing?.description ?? ''); setActive(existing?.isActive ?? true); } }, [open, existing]);
  const submit = async () => {
    setErr(null);
    try {
      if (existing) await m.updatePath.mutateAsync({ id: existing.id, input: { name, organizationId: organizationId || null, description: description || null, isActive } });
      else await m.createPath.mutateAsync({ code, name, organizationId: organizationId || null, description: description || null, isActive });
      toast.success(existing ? 'Path updated' : 'Path created'); onClose();
    } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <Modal open={open} onClose={onClose} title={existing ? `Edit ${existing.code}` : 'New career path'} size="md" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={submit} loading={m.createPath.isPending || m.updatePath.isPending} disabled={(!existing && !code.trim()) || !name.trim()}>{existing ? 'Save' : 'Create'}</Button></>}>
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

function AddStepModal({ path, onClose }: { path: CareerPathDto | null; onClose: () => void }) {
  const m = useTalentMutations();
  const toast = useToast();
  const jobs = useJobOptions();
  const [fromJobId, setFrom] = useState(''); const [toJobId, setTo] = useState(''); const [stepOrder, setOrder] = useState(''); const [description, setDesc] = useState('');
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (path) { setErr(null); setFrom(''); setTo(''); setOrder(String(path.steps.length + 1)); setDesc(''); } }, [path]);
  const submit = async () => { setErr(null); try { await m.addStep.mutateAsync({ id: path!.id, input: { fromJobId, toJobId, stepOrder: stepOrder ? Number(stepOrder) : null, description: description || null } }); toast.success('Step added'); onClose(); } catch (e) { setErr(errorMessage(e)); } };
  const opts = (jobs.data ?? []).map((j) => ({ value: j.id, label: `${j.title} (${j.code})` }));
  return (
    <Modal open={!!path} onClose={onClose} title={path ? `Add a step to ${path.name}` : 'Add step'} description="From one job to another. The target job's competency profile is what the employee is compared against." size="md" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={submit} loading={m.addStep.isPending} disabled={!fromJobId || !toJobId || fromJobId === toJobId}>Add step</Button></>}>
      <div className="space-y-3">
        {err && <Alert>{err}</Alert>}
        <Select label="From job" required options={opts} placeholder="Select…" value={fromJobId} onChange={(e) => setFrom(e.target.value)} />
        <Select label="To job" required options={opts} placeholder="Select…" value={toJobId} onChange={(e) => setTo(e.target.value)} />
        <div className="grid grid-cols-2 gap-3"><Input label="Step order" type="number" min={1} value={stepOrder} onChange={(e) => setOrder(e.target.value)} /><Input label="Description" value={description} onChange={(e) => setDesc(e.target.value)} /></div>
      </div>
    </Modal>
  );
}
