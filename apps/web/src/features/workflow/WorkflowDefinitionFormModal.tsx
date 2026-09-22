import { useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { APPROVER_TYPES, SUPPORTED_APPROVER_TYPES, type WorkflowDefinitionDto } from '@hr/shared';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Alert } from '@/components/ui/Alert';
import { useToast } from '@/components/ui/Toast';
import { useDebounce } from '@/hooks/useDebounce';
import { errorMessage } from '@/features/organization/shared';
import { useUserSearch } from '@/features/audit/audit.api';
import { useWorkflowDefinitionMutations } from './workflow.api';

interface StepDraft { name: string; approverType: string; approverUserId: string | null; approverEmail: string; onSelf: 'FAIL' | 'SKIP'; onUnresolved: 'FAIL' | 'SKIP' }
const blankStep = (): StepDraft => ({ name: '', approverType: APPROVER_TYPES.DIRECT_MANAGER, approverUserId: null, approverEmail: '', onSelf: 'FAIL', onUnresolved: 'FAIL' });
const TYPE_OPTIONS = SUPPORTED_APPROVER_TYPES.map((t) => ({ value: t, label: t.replace('_', ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase()) }));
const POLICY = [{ value: 'FAIL', label: 'FAIL (block submit)' }, { value: 'SKIP', label: 'SKIP (skip this step)' }];

/** Creates a new definition version. When `base` is given the form is pre-filled from that version (code/module/entity locked). */
export function WorkflowDefinitionFormModal({ open, onClose, base }: { open: boolean; onClose: () => void; base?: WorkflowDefinitionDto }) {
  const { createVersion } = useWorkflowDefinitionMutations();
  const toast = useToast();
  const [serverError, setServerError] = useState<string | null>(null);
  const [head, setHead] = useState({ code: '', name: '', description: '', module: '', entityType: '' });
  const [steps, setSteps] = useState<StepDraft[]>([blankStep()]);

  useEffect(() => {
    if (!open) return;
    setServerError(null);
    setHead({ code: base?.code ?? '', name: base?.name ?? '', description: base?.description ?? '', module: base?.module ?? '', entityType: base?.entityType ?? '' });
    setSteps(base ? base.steps.map((s) => ({ name: s.name, approverType: s.approverType, approverUserId: s.approverUser?.id ?? null, approverEmail: s.approverUser?.email ?? '', onSelf: s.onSelf as 'FAIL' | 'SKIP', onUnresolved: s.onUnresolved as 'FAIL' | 'SKIP' })) : [blankStep()]);
  }, [open, base]);

  const update = (i: number, patch: Partial<StepDraft>) => setSteps((prev) => prev.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));
  const move = (i: number, dir: -1 | 1) => setSteps((prev) => { const next = [...prev]; const j = i + dir; if (j < 0 || j >= next.length) return prev; [next[i], next[j]] = [next[j], next[i]]; return next; });

  const submit = async () => {
    setServerError(null);
    try {
      const created = await createVersion.mutateAsync({
        code: head.code, name: head.name, description: head.description || null, module: head.module, entityType: head.entityType,
        steps: steps.map((s) => ({ name: s.name, approverType: s.approverType, approverUserId: s.approverType === APPROVER_TYPES.SPECIFIC_USER ? s.approverUserId : null, onSelf: s.onSelf, onUnresolved: s.onUnresolved })),
      });
      toast.success(`Created ${created.code} v${created.version}`, 'Inactive until you activate it.');
      onClose();
    } catch (err) {
      setServerError(errorMessage(err));
    }
  };

  return (
    <Modal open={open} onClose={onClose} size="lg" title={base ? `New version of ${base.code}` : 'New workflow definition'} description="Steps run in order. Approvers are resolved from the requester's organization data at submit time and snapshotted."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={submit} loading={createVersion.isPending}>Create version</Button></>}>
      <div className="space-y-5">
        {serverError && <Alert>{serverError}</Alert>}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Input label="Code" required disabled={!!base} placeholder="LEAVE_STANDARD" value={head.code} onChange={(e) => setHead({ ...head, code: e.target.value })} />
          <Input label="Name" required placeholder="Leave — manager then HR" value={head.name} onChange={(e) => setHead({ ...head, name: e.target.value })} />
          <Input label="Module" required disabled={!!base} placeholder="leave" hint="business module key (lowercase)" value={head.module} onChange={(e) => setHead({ ...head, module: e.target.value })} />
          <Input label="Entity type" required disabled={!!base} placeholder="LeaveRequest" value={head.entityType} onChange={(e) => setHead({ ...head, entityType: e.target.value })} />
          <div className="sm:col-span-2"><Input label="Description" value={head.description} onChange={(e) => setHead({ ...head, description: e.target.value })} /></div>
        </div>

        <div className="space-y-3">
          <div className="flex items-center justify-between"><h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Steps</h3><Button size="sm" variant="secondary" onClick={() => setSteps([...steps, blankStep()])}><Plus className="h-4 w-4" /> Add step</Button></div>
          {steps.map((s, i) => (
            <div key={i} className="rounded-md border border-slate-200 p-3">
              <div className="mb-3 flex items-center justify-between">
                <span className="text-sm font-semibold text-slate-700">Step {i + 1}</span>
                <div className="flex gap-1">
                  <Button variant="ghost" size="sm" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp className="h-4 w-4" /></Button>
                  <Button variant="ghost" size="sm" aria-label="Move down" disabled={i === steps.length - 1} onClick={() => move(i, 1)}><ArrowDown className="h-4 w-4" /></Button>
                  <Button variant="ghost" size="sm" className="text-red-600" aria-label="Remove" disabled={steps.length === 1} onClick={() => setSteps(steps.filter((_, idx) => idx !== i))}><Trash2 className="h-4 w-4" /></Button>
                </div>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Input label="Step name" required value={s.name} onChange={(e) => update(i, { name: e.target.value })} />
                <Select label="Approver" options={TYPE_OPTIONS} value={s.approverType} onChange={(e) => update(i, { approverType: e.target.value, approverUserId: null, approverEmail: '' })} />
                {s.approverType === APPROVER_TYPES.SPECIFIC_USER && <div className="sm:col-span-2"><UserPicker value={s.approverEmail} onPick={(id, email) => update(i, { approverUserId: id, approverEmail: email })} onClear={() => update(i, { approverUserId: null, approverEmail: '' })} /></div>}
                <Select label="If approver is the requester" options={POLICY} value={s.onSelf} onChange={(e) => update(i, { onSelf: e.target.value as 'FAIL' | 'SKIP' })} />
                <Select label="If approver cannot be resolved" options={POLICY} value={s.onUnresolved} onChange={(e) => update(i, { onUnresolved: e.target.value as 'FAIL' | 'SKIP' })} />
              </div>
            </div>
          ))}
          <p className="text-xs text-slate-500">Defaults are FAIL: a request whose approver is the requester or cannot be resolved is refused at submit. Choose SKIP only when the step is intentionally optional.</p>
        </div>
      </div>
    </Modal>
  );
}

function UserPicker({ value, onPick, onClear }: { value: string; onPick: (id: string, email: string) => void; onClear: () => void }) {
  const [term, setTerm] = useState('');
  const debounced = useDebounce(term, 250);
  const users = useUserSearch(debounced, debounced.length > 0);
  if (value) return <div className="flex h-9 items-center justify-between rounded-md border border-slate-300 bg-slate-50 px-3 text-sm"><span>{value}</span><button onClick={onClear} className="text-xs text-slate-500 hover:text-slate-800">change</button></div>;
  return (
    <div className="relative">
      <Input label="Approver user" placeholder="Search user email…" value={term} onChange={(e) => setTerm(e.target.value)} />
      {debounced && (users.data?.length ?? 0) > 0 && (
        <ul className="absolute z-20 mt-1 w-full rounded-md border border-slate-200 bg-white py-1 shadow-lg">
          {users.data!.map((u) => <li key={u.id}><button type="button" onClick={() => { onPick(u.id, u.email); setTerm(''); }} className="w-full px-3 py-1.5 text-left text-sm hover:bg-slate-50">{u.email}</button></li>)}
        </ul>
      )}
    </div>
  );
}
