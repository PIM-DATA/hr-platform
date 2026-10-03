import { useEffect, useState } from 'react';
import { Outlet, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Copy, Download, Play, Plus, Save, Share2, Trash2 } from 'lucide-react';
import { OPERATORS_BY_TYPE, PERMISSIONS, REPORT_LIMITS, type ReportDefinition, type ReportFieldDto, type SavedReportDto } from '@hr/shared';
import { PageHeader } from '@/components/layout/PageHeader';
import { Tabs } from '@/components/ui/Tabs';
import { Card, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Alert } from '@/components/ui/Alert';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Checkbox } from '@/components/ui/Checkbox';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { Pagination } from '@/components/ui/Pagination';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { LoadingBlock } from '@/components/ui/Spinner';
import { useToast } from '@/components/ui/Toast';
import { useAuth } from '@/hooks/useAuth';
import { REPORT_DRAFT_KEY } from '@/features/copilot/copilot.api';
import { errorMessage } from '@/features/organization/shared';
import { businessDateToday } from '@/lib/format';
import { exportAdHoc, exportSaved, useReportDatasets, useReportMutations, useReportTemplates, useRunReport, useSavedReport, useSavedReports } from './reports.api';

const titleCase = (s: string) => s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, ' ');
const SectionHead = ({ title, description, action }: { title: string; description?: string; action?: React.ReactNode }) => <div className="flex flex-wrap items-start justify-between gap-2 border-b border-slate-200 px-5 py-3"><div><h3 className="text-sm font-semibold text-slate-900">{title}</h3>{description && <p className="text-xs text-slate-500">{description}</p>}</div>{action}</div>;
const EMPTY: ReportDefinition = { columns: [], filters: [], sort: [], groupBy: [], aggregations: [], pageSize: 50 };

export function ReportsLayout() {
  const { hasPermission } = useAuth();
  const tabs = [{ label: 'Saved reports', to: '/hrm/reports', end: true }, hasPermission(PERMISSIONS.REPORTS_VIEW) && { label: 'Report builder', to: '/hrm/reports/builder' }].filter(Boolean) as { label: string; to: string; end?: boolean }[];
  return (
    <>
      <PageHeader title="Report center" description="Reports built from a fixed set of datasets, each returning what its module would show you. There is no SQL, no join and no formula — choose fields, filters, grouping and export." />
      <div className="mb-5"><Tabs items={tabs} /></div>
      <Outlet />
    </>
  );
}

export function SavedReportsPage() {
  const navigate = useNavigate();
  const { hasPermission } = useAuth();
  const saved = useSavedReports();
  const templates = useReportTemplates();
  const m = useReportMutations();
  const toast = useToast();
  const [runId, setRunId] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const columns: Column<SavedReportDto>[] = [
    { key: 'name', header: 'Report', render: (r) => <div><div className="font-medium text-slate-900">{r.name}</div><div className="text-xs text-slate-400">{r.datasetName}{r.description && ` · ${r.description}`}</div></div> },
    { key: 'owner', header: 'Owner', hideBelow: 'sm', render: (r) => r.owner.name ?? '—' },
    { key: 'vis', header: 'Visibility', hideBelow: 'sm', render: (r) => <StatusBadge status={titleCase(r.visibility)} tone={r.visibility === 'SHARED' ? 'info' : 'neutral'} /> },
    { key: 'updated', header: 'Updated', hideBelow: 'md', render: (r) => r.updatedAt.slice(0, 10) },
    { key: 'actions', header: '', render: (r) => (
      <span className="flex flex-wrap justify-end gap-1" onClick={(e) => e.stopPropagation()}>
        <Button size="sm" variant="ghost" onClick={() => setRunId(r.id)}><Play className="h-3.5 w-3.5" /> Run</Button>
        <Button size="sm" variant="ghost" onClick={() => exportSaved(r.id, r.name).catch((e) => toast.error(errorMessage(e)))}><Download className="h-3.5 w-3.5" /> CSV</Button>
        {r.can.edit && <Button size="sm" variant="ghost" onClick={() => navigate(`/hrm/reports/builder?saved=${r.id}`)}>Edit</Button>}
        <Button size="sm" variant="ghost" onClick={() => navigate(`/hrm/reports/builder?duplicate=${r.id}`)}><Copy className="h-3.5 w-3.5" /> Duplicate</Button>
        {r.can.share && <Button size="sm" variant="ghost" onClick={async () => { try { await m.update.mutateAsync({ id: r.id, input: { visibility: r.visibility === 'SHARED' ? 'PRIVATE' : 'SHARED' } }); toast.success(r.visibility === 'SHARED' ? 'Unshared' : 'Shared'); } catch (e) { toast.error(errorMessage(e)); } }}><Share2 className="h-3.5 w-3.5" /> {r.visibility === 'SHARED' ? 'Unshare' : 'Share'}</Button>}
        {r.can.delete && <Button size="sm" variant="ghost" onClick={() => setDeleteId(r.id)}><Trash2 className="h-3.5 w-3.5" /></Button>}
      </span>
    ) },
  ];
  return (
    <div className="space-y-4">
      <Card>
        <div className="flex items-center justify-between border-b border-slate-200 p-4"><p className="text-sm text-slate-600">Your reports and the ones shared with you. A shared report runs in <em>your</em> scope; sharing never grants data.</p>{hasPermission(PERMISSIONS.REPORTS_CREATE) && <Button onClick={() => navigate('/hrm/reports/builder')}><Plus className="h-4 w-4" /> New report</Button>}</div>
        {saved.isError && <Alert className="m-4">Could not load reports.</Alert>}
        <DataTable columns={columns} rows={saved.data ?? []} rowKey={(r) => r.id} loading={saved.isLoading} onRowClick={(r) => setRunId(r.id)} emptyTitle="No saved reports" emptyDescription="Start from a template or build one." />
      </Card>
      <Card>
        <CardHeader title="Templates" description="Starting points on ordinary fields. Open one, adjust, save." />
        {templates.data?.length === 0 ? <p className="px-5 py-4 text-sm text-slate-400">No templates for the datasets you can use.</p> : (
          <ul className="grid grid-cols-1 gap-2 p-4 sm:grid-cols-2 lg:grid-cols-4">{(templates.data ?? []).map((t) => <li key={t.id}><button type="button" className="w-full rounded-md border border-slate-200 bg-white p-3 text-left hover:bg-slate-50" onClick={() => navigate(`/hrm/reports/builder?template=${t.id}`)}><div className="font-medium text-slate-900">{t.name}</div><div className="text-xs text-slate-500">{t.description}</div></button></li>)}</ul>
        )}
      </Card>
      <RunModal id={runId} onClose={() => setRunId(null)} />
      <ConfirmDialog open={!!deleteId} title="Delete this report definition?" message="Only the saved definition is removed. No business data is affected." confirmLabel="Delete" variant="danger" onConfirm={async () => { try { await m.remove.mutateAsync(deleteId!); toast.success('Report deleted'); } catch (e) { toast.error(errorMessage(e)); } setDeleteId(null); }} onCancel={() => setDeleteId(null)} loading={m.remove.isPending} />
    </div>
  );
}

function RunModal({ id, onClose }: { id: string | null; onClose: () => void }) {
  const saved = useSavedReport(id);
  const [page, setPage] = useState(1);
  useEffect(() => setPage(1), [id]);
  const run = useRunReport(saved.data?.datasetId ?? null, saved.data?.definition ?? null, page, !!saved.data);
  return (
    <Modal open={!!id} onClose={onClose} title={saved.data?.name ?? 'Report'} description={saved.data?.datasetName} size="lg" footer={<Button variant="secondary" onClick={onClose}>Close</Button>}>
      {(saved.isLoading || run.isLoading) && <LoadingBlock />}
      {run.isError && <Alert>{errorMessage(run.error)}</Alert>}
      {run.data && <ResultTable result={run.data} onPage={setPage} />}
    </Modal>
  );
}

export function ResultTable({ result, onPage }: { result: { columns: { id: string; label: string; type: string }[]; rows: Record<string, unknown>[]; meta: { page: number; pageSize: number; total: number } }; onPage: (p: number) => void }) {
  return (
    <div>
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead><tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">{result.columns.map((c) => <th key={c.id} className="px-3 py-2">{c.label}</th>)}</tr></thead>
          <tbody className="divide-y divide-slate-100">{result.rows.length === 0 ? <tr><td className="px-3 py-4 text-slate-400" colSpan={result.columns.length || 1}>No rows.</td></tr> : result.rows.map((r, i) => <tr key={i}>{result.columns.map((c) => <td key={c.id} className={`px-3 py-1.5 ${['NUMBER', 'DECIMAL'].includes(c.type) ? 'tabular-nums' : ''} text-slate-800`}>{r[c.id] === null || r[c.id] === undefined ? <span className="text-slate-300">—</span> : String(r[c.id]).replace('T00:00:00.000Z', '')}</td>)}</tr>)}</tbody>
        </table>
      </div>
      <Pagination page={result.meta.page} pageSize={result.meta.pageSize} total={result.meta.total} onPageChange={onPage} />
    </div>
  );
}

/** Left: fields. Centre: columns, filters, sort, grouping. Right: preview. Nothing here types a query. */
export function ReportBuilderPage() {
  const { hasPermission } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { id: routeId } = useParams();
  const datasets = useReportDatasets();
  const templates = useReportTemplates();
  const savedSource = useSavedReport(params.get('saved') ?? params.get('duplicate') ?? routeId ?? null);
  const m = useReportMutations();
  const toast = useToast();
  const [datasetId, setDataset] = useState('');
  const [def, setDef] = useState<ReportDefinition>(EMPTY);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [visibility, setVisibility] = useState<'PRIVATE' | 'SHARED'>('PRIVATE');
  const [page, setPage] = useState(1);
  const [previewOn, setPreviewOn] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const editingId = params.get('saved') ?? routeId ?? null;
  // A draft handed over by the HR Copilot: loaded once, never saved by itself — the user reviews and saves.
  useEffect(() => {
    if (params.get('draft') !== '1') return;
    try {
      const raw = sessionStorage.getItem(REPORT_DRAFT_KEY);
      if (!raw) return;
      const draft = JSON.parse(raw) as { datasetId: string; datasetName: string; definition: ReportDefinition };
      setDataset(draft.datasetId); setDef(draft.definition); setName(`${draft.datasetName} (copilot draft)`); setPreviewOn(true);
    } catch { /* an unreadable draft opens an empty builder */ }
  }, [params]);
  useEffect(() => {
    const t = params.get('template');
    if (t && templates.data) { const tpl = templates.data.find((x) => x.id === t); if (tpl) { setDataset(tpl.datasetId); setDef(tpl.definition); setName(tpl.name); setDescription(tpl.description); setPreviewOn(true); } }
  }, [params, templates.data]);
  useEffect(() => { if (savedSource.data) { setDataset(savedSource.data.datasetId); setDef(savedSource.data.definition); setName(editingId ? savedSource.data.name : `${savedSource.data.name} (copy)`); setDescription(savedSource.data.description ?? ''); setVisibility(editingId ? savedSource.data.visibility : 'PRIVATE'); setPreviewOn(true); } }, [savedSource.data, editingId]);
  const dataset = datasets.data?.find((d) => d.id === datasetId) ?? null;
  const field = (id: string) => dataset?.fields.find((f) => f.id === id);
  const grouped = def.groupBy.length > 0 || def.aggregations.length > 0;
  const run = useRunReport(datasetId || null, def, page, previewOn && def.columns.length > 0);
  const update = (patch: Partial<ReportDefinition>) => { setDef({ ...def, ...patch }); setPage(1); };
  const toggleColumn = (id: string) => update({ columns: def.columns.includes(id) ? def.columns.filter((c) => c !== id) : [...def.columns, id] });
  const save = async () => {
    setErr(null);
    try {
      if (editingId) await m.update.mutateAsync({ id: editingId, input: { name, description: description || null, visibility, definition: def } });
      else await m.create.mutateAsync({ name, description: description || null, datasetId, visibility, definition: def });
      toast.success('Report saved'); setSaveOpen(false); navigate('/hrm/reports');
    } catch (e) { setErr(errorMessage(e)); }
  };
  const selectDataset = (id: string) => { setDataset(id); setDef(EMPTY); setPreviewOn(false); const d = datasets.data?.find((x) => x.id === id); if (d?.requiredDateRange) { const to = businessDateToday(); const from = businessDateToday(new Date(Date.now() - 30 * 86_400_000)); setDef({ ...EMPTY, filters: [{ fieldId: d.requiredDateRange.fieldId, operator: 'BETWEEN', value: [from, to] }] }); } };
  const isDate = (v: unknown) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v);

  return (
    <div className="space-y-4">
      <Card><div className="grid grid-cols-1 gap-3 p-4 lg:grid-cols-3">
        <Select label="Dataset" options={(datasets.data ?? []).map((d) => ({ value: d.id, label: `${d.name}${d.aggregateOnly ? ' (aggregate)' : ''}` }))} placeholder="Choose a dataset…" value={datasetId} onChange={(e) => selectDataset(e.target.value)} />
        {dataset && <p className="text-sm text-slate-600 lg:col-span-2">{dataset.description}{dataset.requiredDateRange && <span className="block text-xs text-amber-700">Needs a date range on "{field(dataset.requiredDateRange.fieldId)?.label}" of at most {dataset.requiredDateRange.maxMonths} months.</span>}</p>}
      </div></Card>
      {dataset && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[260px_1fr]">
          <Card>
            <CardHeader title="Fields" description={`Tick to add a column (max ${REPORT_LIMITS.columns}).`} />
            <ul className="max-h-[520px] divide-y divide-slate-100 overflow-auto">{dataset.fields.filter((f) => f.selectable).map((f) => <li key={f.id} className="px-4 py-1.5"><Checkbox label={f.label} description={`${f.type.toLowerCase()}${f.sensitivity !== 'NORMAL' ? ` · ${f.sensitivity.toLowerCase()}` : ''}`} checked={def.columns.includes(f.id)} onChange={() => toggleColumn(f.id)} disabled={grouped && !def.groupBy.includes(f.id) && !def.columns.includes(f.id)} /></li>)}</ul>
          </Card>
          <div className="space-y-4">
            <Card>
              <SectionHead title="Filters" description={`Up to ${REPORT_LIMITS.filters}. Values are validated by the server.`} action={<Button size="sm" variant="secondary" onClick={() => update({ filters: [...def.filters, { fieldId: dataset.fields.find((f) => f.filterable)!.id, operator: 'EQ', value: '' }] })} disabled={def.filters.length >= REPORT_LIMITS.filters}><Plus className="h-3.5 w-3.5" /> Filter</Button>} />
              <div className="space-y-2 p-4">
                {def.filters.length === 0 && <p className="text-sm text-slate-400">No filters.</p>}
                {def.filters.map((flt, i) => {
                  const f = field(flt.fieldId) as ReportFieldDto | undefined;
                  const ops = f ? OPERATORS_BY_TYPE[f.type] : [];
                  const set = (patch: Partial<typeof flt>) => update({ filters: def.filters.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
                  const needsValue = !['IS_NULL', 'IS_NOT_NULL'].includes(flt.operator);
                  return (
                    <div key={i} className="grid grid-cols-1 gap-2 rounded-md border border-slate-200 p-2 sm:grid-cols-[1fr_140px_1fr_auto]">
                      <Select options={dataset.fields.filter((x) => x.filterable).map((x) => ({ value: x.id, label: x.label }))} value={flt.fieldId} onChange={(e) => { const nf = field(e.target.value)!; set({ fieldId: e.target.value, operator: OPERATORS_BY_TYPE[nf.type][0]!, value: '' }); }} />
                      <Select options={ops.map((o) => ({ value: o, label: titleCase(o) }))} value={flt.operator} onChange={(e) => set({ operator: e.target.value as never, value: e.target.value === 'BETWEEN' ? ['', ''] : e.target.value === 'IN' ? [] : '' })} />
                      {!needsValue ? <span /> : flt.operator === 'BETWEEN' ? <span className="flex gap-1"><Input type="date" value={(flt.value as string[])?.[0] ?? ''} onChange={(e) => set({ value: [e.target.value, (flt.value as string[])?.[1] ?? ''] })} /><Input type="date" value={(flt.value as string[])?.[1] ?? ''} onChange={(e) => set({ value: [(flt.value as string[])?.[0] ?? '', e.target.value] })} /></span>
                        : flt.operator === 'IN' && f?.options ? <span className="flex flex-wrap gap-2 text-xs">{f.options.map((o) => <Checkbox key={o.value} label={o.label} checked={(flt.value as string[]).includes(o.value)} onChange={(e) => set({ value: e.target.checked ? [...(flt.value as string[]), o.value] : (flt.value as string[]).filter((v) => v !== o.value) })} />)}</span>
                        : f?.type === 'ENUM' && f.options ? <Select options={f.options} placeholder="Choose…" value={String(flt.value ?? '')} onChange={(e) => set({ value: e.target.value })} />
                        : f?.type === 'BOOLEAN' ? <Select options={[{ value: 'true', label: 'True' }, { value: 'false', label: 'False' }]} value={String(flt.value ?? 'true')} onChange={(e) => set({ value: e.target.value === 'true' })} />
                        : f?.type === 'DATE' || f?.type === 'DATETIME' ? <Input type="date" value={String(flt.value ?? '')} onChange={(e) => set({ value: e.target.value })} />
                        : f?.type === 'NUMBER' || f?.type === 'DECIMAL' ? <Input type="number" value={String(flt.value ?? '')} onChange={(e) => set({ value: e.target.value === '' ? '' : Number(e.target.value) })} />
                        : <Input value={String(flt.value ?? '')} onChange={(e) => set({ value: e.target.value })} />}
                      <Button size="sm" variant="ghost" onClick={() => update({ filters: def.filters.filter((_, j) => j !== i) })}><Trash2 className="h-3.5 w-3.5" /></Button>
                    </div>
                  );
                })}
              </div>
            </Card>
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <Card>
                <SectionHead title="Sort" description={`Up to ${REPORT_LIMITS.sort} levels.`} action={<Button size="sm" variant="secondary" onClick={() => update({ sort: [...def.sort, { fieldId: dataset.fields.find((f) => f.sortable)!.id, direction: 'ASC' }] })} disabled={def.sort.length >= REPORT_LIMITS.sort || grouped}><Plus className="h-3.5 w-3.5" /></Button>} />
                <div className="space-y-2 p-4">{def.sort.length === 0 && <p className="text-sm text-slate-400">Default order.</p>}{def.sort.map((s, i) => <div key={i} className="grid grid-cols-[1fr_100px_auto] gap-2"><Select options={dataset.fields.filter((x) => x.sortable).map((x) => ({ value: x.id, label: x.label }))} value={s.fieldId} onChange={(e) => update({ sort: def.sort.map((x, j) => (j === i ? { ...x, fieldId: e.target.value } : x)) })} /><Select options={[{ value: 'ASC', label: 'Asc' }, { value: 'DESC', label: 'Desc' }]} value={s.direction} onChange={(e) => update({ sort: def.sort.map((x, j) => (j === i ? { ...x, direction: e.target.value as 'ASC' } : x)) })} /><Button size="sm" variant="ghost" onClick={() => update({ sort: def.sort.filter((_, j) => j !== i) })}><Trash2 className="h-3.5 w-3.5" /></Button></div>)}</div>
              </Card>
              <Card>
                <CardHeader title="Group & aggregate" description="Group fields become the columns; add COUNT, SUM, AVG, MIN, MAX." />
                <div className="space-y-2 p-4">
                  <div className="flex flex-wrap gap-2">{dataset.fields.filter((f) => f.groupable).map((f) => <Checkbox key={f.id} label={f.label} checked={def.groupBy.includes(f.id)} onChange={(e) => { const groupBy = e.target.checked ? [...def.groupBy, f.id] : def.groupBy.filter((g) => g !== f.id); update({ groupBy, columns: groupBy.length ? groupBy : def.columns.filter((c) => !def.groupBy.includes(c)), sort: [] }); }} disabled={!def.groupBy.includes(f.id) && def.groupBy.length >= REPORT_LIMITS.groupBy} />)}</div>
                  {def.aggregations.map((a, i) => <div key={i} className="grid grid-cols-[1fr_120px_1fr_auto] gap-2"><Select options={dataset.fields.filter((x) => x.aggregatable || a.function.startsWith('COUNT')).map((x) => ({ value: x.id, label: x.label }))} value={a.fieldId} onChange={(e) => update({ aggregations: def.aggregations.map((x, j) => (j === i ? { ...x, fieldId: e.target.value } : x)) })} /><Select options={['COUNT', 'COUNT_DISTINCT', 'SUM', 'AVG', 'MIN', 'MAX'].map((x) => ({ value: x, label: titleCase(x) }))} value={a.function} onChange={(e) => update({ aggregations: def.aggregations.map((x, j) => (j === i ? { ...x, function: e.target.value as never } : x)) })} /><Input placeholder="Label" value={a.alias ?? ''} onChange={(e) => update({ aggregations: def.aggregations.map((x, j) => (j === i ? { ...x, alias: e.target.value || undefined } : x)) })} /><Button size="sm" variant="ghost" onClick={() => update({ aggregations: def.aggregations.filter((_, j) => j !== i) })}><Trash2 className="h-3.5 w-3.5" /></Button></div>)}
                  <Button size="sm" variant="secondary" onClick={() => update({ aggregations: [...def.aggregations, { fieldId: dataset.fields.find((f) => f.aggregatable || f.selectable)!.id, function: 'COUNT', alias: 'Count' }] })} disabled={def.aggregations.length >= REPORT_LIMITS.aggregations}><Plus className="h-3.5 w-3.5" /> Aggregation</Button>
                </div>
              </Card>
            </div>
            <Card>
              <SectionHead title="Preview" description={run.data ? `${run.data.meta.total} row(s)${grouped ? ', grouped' : ''} — your scope only.` : 'Run to preview the first page.'} action={<span className="flex gap-2"><Button size="sm" variant="secondary" onClick={() => { setPreviewOn(true); setPage(1); run.refetch(); }} disabled={def.columns.length === 0}><Play className="h-3.5 w-3.5" /> Run</Button><Button size="sm" variant="secondary" onClick={() => exportAdHoc(datasetId, def, name || dataset.name).catch((e) => toast.error(errorMessage(e)))} disabled={def.columns.length === 0}><Download className="h-3.5 w-3.5" /> CSV</Button>{hasPermission(PERMISSIONS.REPORTS_CREATE) && <Button size="sm" onClick={() => setSaveOpen(true)} disabled={def.columns.length === 0}><Save className="h-3.5 w-3.5" /> Save</Button>}</span>} />
              <div className="p-4">
                {run.isFetching && <LoadingBlock />}
                {run.isError && <Alert>{errorMessage(run.error)}</Alert>}
                {run.data && !run.isFetching && <ResultTable result={run.data} onPage={setPage} />}
                {!previewOn && !run.data && <p className="text-sm text-slate-400">Choose columns and run.</p>}
              </div>
            </Card>
          </div>
        </div>
      )}
      <Modal open={saveOpen} onClose={() => setSaveOpen(false)} title={editingId ? 'Save changes' : 'Save report'} size="md" footer={<><Button variant="secondary" onClick={() => setSaveOpen(false)}>Cancel</Button><Button onClick={save} loading={m.create.isPending || m.update.isPending} disabled={!name.trim()}>Save</Button></>}>
        <div className="space-y-3">
          {err && <Alert>{err}</Alert>}
          <Input label="Name" required value={name} onChange={(e) => setName(e.target.value)} />
          <Input label="Description" value={description} onChange={(e) => setDescription(e.target.value)} />
          {hasPermission(PERMISSIONS.REPORTS_SHARE) && <Select label="Visibility" options={[{ value: 'PRIVATE', label: 'Private — only me' }, { value: 'SHARED', label: 'Shared — report users with this dataset\'s permission, in their own scope' }]} value={visibility} onChange={(e) => setVisibility(e.target.value as 'PRIVATE')} />}
          <p className="text-xs text-slate-500">{isDate(def.filters[0]?.value) ? '' : ''}Sharing shares the definition, never the data.</p>
        </div>
      </Modal>
    </div>
  );
}
