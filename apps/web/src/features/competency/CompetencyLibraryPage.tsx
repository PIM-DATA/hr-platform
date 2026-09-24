import { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { PERMISSIONS, type CompetencyDto } from '@hr/shared';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Alert } from '@/components/ui/Alert';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { SearchInput } from '@/components/ui/SearchInput';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { Pagination } from '@/components/ui/Pagination';
import { useToast } from '@/components/ui/Toast';
import { usePermission } from '@/hooks/usePermission';
import { useDebounce } from '@/hooks/useDebounce';
import { errorMessage } from '@/features/organization/shared';
import { useCompetencies, useCompetencyCategories, useCompetencyMutations, useCompetencyScales } from './competency.api';

/**
 * The competency library, and the categories that organise it.
 *
 * A competency's scale is fixed when it is created: re-basing "level 3" onto a different scale would make every
 * recorded level ambiguous. Everything else can be improved, and none of it rewrites a finished assessment.
 */
export function CompetencyLibraryPage() {
  const canManage = usePermission(PERMISSIONS.COMPETENCY_MANAGE);
  const categories = useCompetencyCategories();
  const [search, setSearch] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [status, setStatus] = useState('active');
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<CompetencyDto | null>(null);
  const [addingCategory, setAddingCategory] = useState(false);
  const competencies = useCompetencies({ search: useDebounce(search), categoryId, status, page, pageSize: 20 });

  const columns: Column<CompetencyDto>[] = [
    { key: 'name', header: 'Competency', render: (c) => (
      <div>
        <div className="font-medium text-slate-900">{c.name}</div>
        <div className="text-xs text-slate-400">{c.code} · {c.category.name}</div>
      </div>
    ) },
    { key: 'scale', header: 'Scale', hideBelow: 'md', render: (c) => `${c.scale.name} (${c.scale.levels.length} levels)` },
    { key: 'indicators', header: 'Indicators', className: 'text-right', hideBelow: 'lg', render: (c) => <span className="tabular-nums">{c.indicators.length}</span> },
    { key: 'inUse', header: 'In use', hideBelow: 'lg', render: (c) => (c.inUse ? 'Yes' : <span className="text-slate-400">No</span>) },
    { key: 'status', header: 'Status', render: (c) => <StatusBadge status={c.isActive ? 'Active' : 'Inactive'} tone={c.isActive ? 'success' : 'neutral'} /> },
  ];

  return (
    <>
      <Card>
        <div className="grid grid-cols-1 gap-3 border-b border-slate-200 p-4 sm:grid-cols-4">
          <SearchInput placeholder="Search competencies…" value={search} onChange={(value) => { setSearch(value); setPage(1); }} />
          <Select options={(categories.data ?? []).map((c) => ({ value: c.id, label: c.name }))} placeholder="All categories" value={categoryId} onChange={(e) => { setCategoryId(e.target.value); setPage(1); }} />
          <Select options={[{ value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' }]} placeholder="All statuses" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} />
          {canManage && (
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setAddingCategory(true)}>Category</Button>
              <Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> Competency</Button>
            </div>
          )}
        </div>
        {competencies.isError && <Alert className="m-4">Could not load the competency library.</Alert>}
        <DataTable
          columns={columns}
          rows={competencies.data?.data ?? []}
          rowKey={(c) => c.id}
          loading={competencies.isLoading}
          onRowClick={canManage ? (c) => setEditing(c) : undefined}
          emptyTitle="No competencies yet"
          emptyDescription="A competency is something somebody can be more or less good at, measured on one scale."
        />
        {competencies.data?.meta && <Pagination {...competencies.data.meta} onPageChange={setPage} />}
      </Card>
      <CompetencyModal open={creating} competency={null} onClose={() => setCreating(false)} />
      <CompetencyModal open={!!editing} competency={editing} onClose={() => setEditing(null)} />
      <CategoryModal open={addingCategory} onClose={() => setAddingCategory(false)} />
    </>
  );
}

function CategoryModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const m = useCompetencyMutations();
  const toast = useToast();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (open) { setErr(null); setCode(''); setName(''); } }, [open]);

  const submit = async () => {
    setErr(null);
    try {
      await m.createCategory.mutateAsync({ code, name, sortOrder: 0 });
      toast.success('Category added');
      onClose();
    } catch (e) {
      setErr(errorMessage(e));
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add a category"
      description="How your framework groups competencies — core, leadership, technical, whatever fits."
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} loading={m.createCategory.isPending} disabled={!code || !name}>Add</Button>
        </>
      }
    >
      <div className="space-y-3">
        {err && <Alert>{err}</Alert>}
        <Input label="Code" required value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="TECHNICAL" />
        <Input label="Name" required value={name} onChange={(e) => setName(e.target.value)} placeholder="Technical" />
      </div>
    </Modal>
  );
}

function CompetencyModal({ open, competency, onClose }: { open: boolean; competency: CompetencyDto | null; onClose: () => void }) {
  const m = useCompetencyMutations();
  const toast = useToast();
  const categories = useCompetencyCategories();
  const scales = useCompetencyScales();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [scaleId, setScaleId] = useState('');
  const [isActive, setIsActive] = useState(true);
  const [indicators, setIndicators] = useState<{ level: number; description: string }[]>([]);
  const [err, setErr] = useState<string | null>(null);

  const scale = (scales.data ?? []).find((s) => s.id === (competency?.scale.id ?? scaleId));

  useEffect(() => {
    if (!open) return;
    setErr(null);
    setCode(competency?.code ?? '');
    setName(competency?.name ?? '');
    setDescription(competency?.description ?? '');
    setCategoryId(competency?.category.id ?? '');
    setScaleId(competency?.scale.id ?? '');
    setIsActive(competency?.isActive ?? true);
    setIndicators(competency?.indicators ?? []);
  }, [open, competency]);

  const setIndicator = (level: number, value: string) =>
    setIndicators((current) => {
      const rest = current.filter((i) => i.level !== level);
      return value.trim() ? [...rest, { level, description: value }].sort((a, b) => a.level - b.level) : rest;
    });

  const submit = async () => {
    setErr(null);
    try {
      if (competency) {
        await m.updateCompetency.mutateAsync({ id: competency.id, input: { name, description: description || null, categoryId, indicators, isActive } });
        toast.success('Competency updated');
      } else {
        await m.createCompetency.mutateAsync({ code, name, description: description || null, categoryId, scaleId, indicators });
        toast.success('Competency added');
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
      title={competency ? competency.name : 'Add a competency'}
      description={competency ? 'Renaming it never changes an assessment that already used it.' : 'The scale is fixed once the competency exists.'}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} loading={m.createCompetency.isPending || m.updateCompetency.isPending} disabled={!name || !categoryId || (!competency && (!code || !scaleId))}>
            {competency ? 'Save' : 'Add competency'}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {err && <Alert>{err}</Alert>}
        <div className="grid grid-cols-2 gap-3">
          <Input label="Code" required value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} disabled={!!competency} placeholder="SQL" />
          <Input label="Name" required value={name} onChange={(e) => setName(e.target.value)} placeholder="SQL" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Select label="Category" required options={(categories.data ?? []).map((c) => ({ value: c.id, label: c.name }))} placeholder="Choose a category" value={categoryId} onChange={(e) => setCategoryId(e.target.value)} />
          <Select
            label="Proficiency scale"
            required
            options={(scales.data ?? []).map((s) => ({ value: s.id, label: `${s.name} (${s.levels.length} levels)` }))}
            placeholder="Choose a scale"
            value={scaleId}
            onChange={(e) => setScaleId(e.target.value)}
            disabled={!!competency}
          />
        </div>
        <Textarea label="Description" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
        {scale && (
          <div>
            <div className="mb-1 text-sm font-medium text-slate-700">What each level looks like</div>
            <p className="mb-2 text-xs text-slate-500">Guidance for whoever assesses this, so two reviewers mean the same thing by the same number. Optional.</p>
            <div className="space-y-2">
              {scale.levels.map((level) => (
                <Input
                  key={level.level}
                  label={`${level.level} · ${level.label}`}
                  value={indicators.find((i) => i.level === level.level)?.description ?? ''}
                  onChange={(e) => setIndicator(level.level, e.target.value)}
                />
              ))}
            </div>
          </div>
        )}
        {competency && (
          <Select label="Status" options={[{ value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' }]} value={isActive ? 'active' : 'inactive'} onChange={(e) => setIsActive(e.target.value === 'active')} />
        )}
        {competency?.inUse && <p className="text-xs text-slate-500">This competency is used by a job profile or an assessment, so it can be deactivated but never deleted.</p>}
      </div>
    </Modal>
  );
}
