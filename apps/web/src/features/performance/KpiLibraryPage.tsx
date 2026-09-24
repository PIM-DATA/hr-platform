import { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { KPI_MEASUREMENT_TYPES, PERMISSIONS, type KpiDto } from '@hr/shared';
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
import { useKpis, usePerformanceMutations } from './performance.api';
import { measurementLabel } from './performance-ui';

/**
 * The KPI library: definitions plans are built from.
 *
 * Editing one changes the library, never a finished review — a plan item keeps the code and name it snapshotted, so a
 * rename today leaves last year's appraisals reading exactly as they did.
 */
export function KpiLibraryPage() {
  const canManage = usePermission(PERMISSIONS.PERFORMANCE_MANAGE_KPIS);
  const [search, setSearch] = useState('');
  const [measurementType, setMeasurementType] = useState('');
  const [status, setStatus] = useState('active');
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<KpiDto | null>(null);
  const kpis = useKpis({ search: useDebounce(search), measurementType, status, page, pageSize: 20 });

  const columns: Column<KpiDto>[] = [
    { key: 'name', header: 'KPI', render: (k) => (
      <div>
        <div className="font-medium text-slate-900">{k.name}</div>
        <div className="text-xs text-slate-400">{k.code}{k.category && ` · ${k.category}`}</div>
      </div>
    ) },
    { key: 'measurement', header: 'Measured as', render: (k) => measurementLabel(k.measurementType) },
    { key: 'unit', header: 'Unit', hideBelow: 'md', render: (k) => k.unit ?? <span className="text-slate-400">—</span> },
    { key: 'weight', header: 'Default weight', className: 'text-right', hideBelow: 'lg', render: (k) => (k.defaultWeight ? `${k.defaultWeight}%` : <span className="text-slate-400">—</span>) },
    { key: 'status', header: 'Status', render: (k) => <StatusBadge status={k.isActive ? 'Active' : 'Inactive'} tone={k.isActive ? 'success' : 'neutral'} /> },
  ];

  return (
    <>
      <Card>
        <div className="grid grid-cols-1 gap-3 border-b border-slate-200 p-4 sm:grid-cols-4">
          <SearchInput placeholder="Search KPIs…" value={search} onChange={(value) => { setSearch(value); setPage(1); }} />
          <Select options={KPI_MEASUREMENT_TYPES.map((t) => ({ value: t, label: measurementLabel(t) }))} placeholder="All measurements" value={measurementType} onChange={(e) => { setMeasurementType(e.target.value); setPage(1); }} />
          <Select options={[{ value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' }]} placeholder="All statuses" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} />
          {canManage && <div className="flex justify-end"><Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> Add KPI</Button></div>}
        </div>
        {kpis.isError && <Alert className="m-4">Could not load the KPI library.</Alert>}
        <DataTable
          columns={columns}
          rows={kpis.data?.data ?? []}
          rowKey={(k) => k.id}
          loading={kpis.isLoading}
          onRowClick={canManage ? (k) => setEditing(k) : undefined}
          emptyTitle="No KPIs yet"
          emptyDescription="A KPI is a reusable definition; what somebody is actually measured on is copied onto their plan."
        />
        {kpis.data?.meta && <Pagination {...kpis.data.meta} onPageChange={setPage} />}
      </Card>
      <KpiModal open={creating} kpi={null} onClose={() => setCreating(false)} />
      <KpiModal open={!!editing} kpi={editing} onClose={() => setEditing(null)} />
    </>
  );
}

function KpiModal({ open, kpi, onClose }: { open: boolean; kpi: KpiDto | null; onClose: () => void }) {
  const m = usePerformanceMutations();
  const toast = useToast();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [category, setCategory] = useState('');
  const [measurementType, setMeasurementType] = useState<(typeof KPI_MEASUREMENT_TYPES)[number]>('NUMBER');
  const [unit, setUnit] = useState('');
  const [defaultWeight, setDefaultWeight] = useState('');
  const [description, setDescription] = useState('');
  const [isActive, setIsActive] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setErr(null);
    setCode(kpi?.code ?? '');
    setName(kpi?.name ?? '');
    setCategory(kpi?.category ?? '');
    setMeasurementType((kpi?.measurementType ?? 'NUMBER') as (typeof KPI_MEASUREMENT_TYPES)[number]);
    setUnit(kpi?.unit ?? '');
    setDefaultWeight(kpi?.defaultWeight ?? '');
    setDescription(kpi?.description ?? '');
    setIsActive(kpi?.isActive ?? true);
  }, [open, kpi]);

  const submit = async () => {
    setErr(null);
    try {
      if (kpi) {
        await m.updateKpi.mutateAsync({
          id: kpi.id,
          input: { name, category: category || null, unit: unit || null, defaultWeight: defaultWeight || null, description: description || null, isActive },
        });
        toast.success('KPI updated');
      } else {
        await m.createKpi.mutateAsync({
          code, name, category: category || null, measurementType, unit: unit || null,
          defaultWeight: defaultWeight || null, description: description || null,
        });
        toast.success('KPI added');
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
      title={kpi ? kpi.name : 'Add a KPI'}
      description={kpi ? 'Renaming a KPI never changes a review that already used it.' : 'A reusable definition. How it is measured is fixed once it exists.'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} loading={m.createKpi.isPending || m.updateKpi.isPending} disabled={!name || (!kpi && !code)}>{kpi ? 'Save' : 'Add KPI'}</Button>
        </>
      }
    >
      <div className="space-y-3">
        {err && <Alert>{err}</Alert>}
        <div className="grid grid-cols-2 gap-3">
          <Input label="Code" required value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} disabled={!!kpi} placeholder="SALES_RESULT" />
          <Input label="Name" required value={name} onChange={(e) => setName(e.target.value)} placeholder="Sales / business result" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Select label="Measured as" options={KPI_MEASUREMENT_TYPES.map((t) => ({ value: t, label: measurementLabel(t) }))} value={measurementType} onChange={(e) => setMeasurementType(e.target.value as (typeof KPI_MEASUREMENT_TYPES)[number])} disabled={!!kpi} />
          <Input label="Category" value={category} onChange={(e) => setCategory(e.target.value)} placeholder="Core" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Input label="Unit" value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="THB, %, projects" />
          <Input label="Default weight %" inputMode="decimal" value={defaultWeight} onChange={(e) => setDefaultWeight(e.target.value)} hint="A suggestion when it is added to a plan." />
        </div>
        <Textarea label="Description" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
        {kpi && (
          <Select label="Status" options={[{ value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' }]} value={isActive ? 'active' : 'inactive'} onChange={(e) => setIsActive(e.target.value === 'active')} />
        )}
      </div>
    </Modal>
  );
}
