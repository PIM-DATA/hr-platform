import { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import type { CompetencyScaleDto, ScaleLevelInput } from '@hr/shared';
import { Card, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Alert } from '@/components/ui/Alert';
import { Input } from '@/components/ui/Input';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { LoadingBlock } from '@/components/ui/Spinner';
import { EmptyState } from '@/components/ui/EmptyState';
import { useToast } from '@/components/ui/Toast';
import { errorMessage } from '@/features/organization/shared';
import { useCompetencyMutations, useCompetencyScales } from './competency.api';

/**
 * Proficiency scales.
 *
 * Nothing in the product assumes five levels or what they are called — a scale is configuration, and this is where a
 * customer writes theirs. Once competencies use a scale its rungs are frozen: an assessment recorded "3" on the
 * understanding of what 3 meant, and adding a level would silently rewrite every one of those.
 */
export function ScalesPage() {
  const scales = useCompetencyScales();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<CompetencyScaleDto | null>(null);

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> New scale</Button>
      </div>
      {scales.isLoading && <LoadingBlock />}
      {scales.isError && <Alert>Could not load the proficiency scales.</Alert>}
      {scales.data?.length === 0 && (
        <Card><EmptyState title="No scales yet" description="A scale is the set of levels every competency is measured on." /></Card>
      )}
      {(scales.data ?? []).map((scale) => (
        <Card key={scale.id}>
          <CardHeader title={scale.name} description={scale.description ?? scale.code} />
          <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 px-5 py-3">
            <StatusBadge status={scale.isActive ? 'Active' : 'Inactive'} tone={scale.isActive ? 'success' : 'neutral'} />
            {scale.inUse && <span className="text-xs text-slate-500">In use — the levels are fixed, the wording is not</span>}
            <Button variant="secondary" size="sm" className="ml-auto" onClick={() => setEditing(scale)}>Edit</Button>
          </div>
          <ul className="divide-y divide-slate-100 px-5 py-2">
            {scale.levels.map((level) => (
              <li key={level.id} className="flex items-baseline gap-3 py-2 text-sm">
                <span className="w-6 shrink-0 text-right font-semibold tabular-nums text-slate-900">{level.level}</span>
                <span>
                  <span className="text-slate-900">{level.label}</span>
                  {level.description && <span className="block text-xs text-slate-500">{level.description}</span>}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      ))}
      <ScaleModal open={creating} scale={null} onClose={() => setCreating(false)} />
      <ScaleModal open={!!editing} scale={editing} onClose={() => setEditing(null)} />
    </div>
  );
}

const EMPTY_LEVELS: ScaleLevelInput[] = [
  { level: 1, label: '' },
  { level: 2, label: '' },
  { level: 3, label: '' },
  { level: 4, label: '' },
  { level: 5, label: '' },
];

function ScaleModal({ open, scale, onClose }: { open: boolean; scale: CompetencyScaleDto | null; onClose: () => void }) {
  const m = useCompetencyMutations();
  const toast = useToast();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [levels, setLevels] = useState<ScaleLevelInput[]>(EMPTY_LEVELS);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setErr(null);
    setCode(scale?.code ?? '');
    setName(scale?.name ?? '');
    setLevels(scale ? scale.levels.map((l) => ({ level: l.level, label: l.label, description: l.description ?? undefined })) : EMPTY_LEVELS);
  }, [open, scale]);

  const setLevel = (index: number, patch: Partial<ScaleLevelInput>) =>
    setLevels((current) => current.map((l, i) => (i === index ? { ...l, ...patch } : l)));

  const filled = levels.filter((l) => l.label.trim());

  const submit = async () => {
    setErr(null);
    try {
      if (scale) {
        await m.updateScale.mutateAsync({ id: scale.id, input: { name, levels: filled } });
        toast.success('Scale updated');
      } else {
        await m.createScale.mutateAsync({ code, name, levels: filled });
        toast.success('Scale created');
      }
      onClose();
    } catch (e) {
      setErr(errorMessage(e));
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={scale ? scale.name : 'New proficiency scale'}
      description={scale?.inUse ? 'Competencies use this scale, so the wording can change but the levels cannot.' : 'At least two levels — a scale with one cannot express a gap.'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} loading={m.createScale.isPending || m.updateScale.isPending} disabled={!name || filled.length < 2 || (!scale && !code)}>
            {scale ? 'Save' : 'Create scale'}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {err && <Alert>{err}</Alert>}
        <div className="grid grid-cols-2 gap-3">
          <Input label="Code" required value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} disabled={!!scale} placeholder="STD5" />
          <Input label="Name" required value={name} onChange={(e) => setName(e.target.value)} placeholder="Standard five-level" />
        </div>
        <div className="space-y-2">
          <div className="text-sm font-medium text-slate-700">Levels</div>
          {levels.map((level, index) => (
            <div key={level.level} className="grid grid-cols-[2.5rem_1fr] gap-2">
              <span className="flex h-9 items-center justify-center rounded-md bg-slate-100 text-sm font-semibold tabular-nums text-slate-700">{level.level}</span>
              <Input aria-label={`Level ${level.level} label`} placeholder={`What level ${level.level} means`} value={level.label} onChange={(e) => setLevel(index, { label: e.target.value })} />
            </div>
          ))}
          <p className="text-xs text-slate-500">Leave a level blank to leave it out.</p>
        </div>
      </div>
    </Modal>
  );
}
