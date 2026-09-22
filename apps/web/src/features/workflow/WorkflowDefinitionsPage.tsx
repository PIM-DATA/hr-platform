import { useMemo, useState } from 'react';
import { Plus, Power, PowerOff, Copy } from 'lucide-react';
import { type WorkflowDefinitionDto } from '@hr/shared';
import { PageHeader } from '@/components/layout/PageHeader';
import { Card, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { Alert } from '@/components/ui/Alert';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { useToast } from '@/components/ui/Toast';
import { formatDateTime } from '@/lib/format';
import { errorMessage } from '@/features/organization/shared';
import { useWorkflowDefinitionMutations, useWorkflowDefinitions } from './workflow.api';
import { WorkflowDefinitionFormModal } from './WorkflowDefinitionFormModal';

const APPROVER_LABEL: Record<string, string> = { DIRECT_MANAGER: 'Direct manager', DEPARTMENT_HEAD: 'Department head', SPECIFIC_USER: 'Specific user', ROLE: 'Role (not supported)' };

export function WorkflowDefinitionsPage() {
  const defs = useWorkflowDefinitions();
  const { activate, deactivate } = useWorkflowDefinitionMutations();
  const toast = useToast();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [form, setForm] = useState<{ open: boolean; base?: WorkflowDefinitionDto }>({ open: false });
  const [confirm, setConfirm] = useState<{ def: WorkflowDefinitionDto; action: 'activate' | 'deactivate' } | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);

  const selected = useMemo(() => defs.data?.find((d) => d.id === selectedId) ?? defs.data?.[0] ?? null, [defs.data, selectedId]);

  const onConfirm = async () => {
    if (!confirm) return;
    setConfirmError(null);
    try {
      await (confirm.action === 'activate' ? activate : deactivate).mutateAsync(confirm.def.id);
      toast.success(`${confirm.def.code} v${confirm.def.version} ${confirm.action === 'activate' ? 'activated' : 'deactivated'}`);
      setConfirm(null);
    } catch (err) {
      setConfirmError(errorMessage(err));
    }
  };

  const columns: Column<WorkflowDefinitionDto>[] = [
    { key: 'code', header: 'Code', render: (d) => <span className="font-mono text-xs text-slate-700">{d.code}</span> },
    { key: 'version', header: 'Ver.', render: (d) => <span className="tabular-nums">v{d.version}</span> },
    { key: 'name', header: 'Name', render: (d) => <span className="font-medium text-slate-900">{d.name}</span> },
    { key: 'module', header: 'Module / entity', hideBelow: 'md', render: (d) => <span className="text-slate-600">{d.module} · {d.entityType}</span> },
    { key: 'steps', header: 'Steps', hideBelow: 'sm', render: (d) => <span className="tabular-nums">{d.steps.length}</span> },
    { key: 'instances', header: 'Instances', hideBelow: 'lg', render: (d) => <span className="tabular-nums text-slate-500">{d.instanceCount}</span> },
    { key: 'status', header: 'Status', render: (d) => <StatusBadge status={d.isActive ? 'ACTIVE' : 'INACTIVE'} /> },
    {
      key: 'actions', header: <span className="sr-only">Actions</span>, className: 'text-right',
      render: (d) => (
        <div className="flex justify-end gap-1" onClick={(e) => e.stopPropagation()}>
          <Button variant="ghost" size="sm" title="New version based on this" aria-label="New version" onClick={() => setForm({ open: true, base: d })}><Copy className="h-4 w-4" /></Button>
          {d.isActive
            ? <Button variant="ghost" size="sm" className="text-red-600 hover:bg-red-50" aria-label="Deactivate" onClick={() => setConfirm({ def: d, action: 'deactivate' })}><PowerOff className="h-4 w-4" /></Button>
            : <Button variant="ghost" size="sm" className="text-emerald-600 hover:bg-emerald-50" aria-label="Activate" onClick={() => setConfirm({ def: d, action: 'activate' })}><Power className="h-4 w-4" /></Button>}
        </div>
      ),
    },
  ];

  return (
    <>
      <PageHeader title="Workflows" description="Approval workflow definitions. Versions are immutable — to change a workflow, create a new version and activate it."
        actions={<Button onClick={() => setForm({ open: true })}><Plus className="h-4 w-4" /> New workflow</Button>} />
      {defs.isError && <Alert className="mb-4">Could not load workflow definitions.</Alert>}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1fr_380px]">
        <Card>
          <DataTable columns={columns} rows={defs.data ?? []} rowKey={(d) => d.id} loading={defs.isLoading} onRowClick={(d) => setSelectedId(d.id)} emptyTitle="No workflow definitions" emptyDescription="Create the first workflow, e.g. Employee → Direct manager → HR." />
        </Card>
        <Card>
          <CardHeader title={selected ? `${selected.code} v${selected.version}` : 'Steps'} description={selected ? `${selected.name} · ${selected.module}/${selected.entityType}` : 'Select a definition'} />
          {selected ? (
            <ol className="space-y-3 px-5 py-4">
              {selected.steps.map((s) => (
                <li key={s.id} className="flex gap-3">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-600 text-xs font-semibold text-white">{s.stepOrder}</span>
                  <div className="min-w-0 text-sm">
                    <div className="font-medium text-slate-900">{s.name}</div>
                    <div className="text-xs text-slate-500">{APPROVER_LABEL[s.approverType] ?? s.approverType}{s.approverUser && ` · ${s.approverUser.email}`}</div>
                    <div className="text-[11px] text-slate-400">on self: {s.onSelf} · on unresolved: {s.onUnresolved}</div>
                  </div>
                </li>
              ))}
              <li className="border-t border-slate-100 pt-3 text-xs text-slate-400">Created {formatDateTime(selected.createdAt)}{selected.activatedAt && ` · activated ${formatDateTime(selected.activatedAt)}`} · {selected.instanceCount} instance(s)</li>
            </ol>
          ) : <p className="px-5 py-4 text-sm text-slate-500">—</p>}
        </Card>
      </div>
      <WorkflowDefinitionFormModal open={form.open} base={form.base} onClose={() => setForm({ open: false })} />
      <ConfirmDialog open={!!confirm} title={confirm?.action === 'activate' ? 'Activate version' : 'Deactivate version'}
        message={confirm?.action === 'activate' ? `${confirm.def.code} v${confirm.def.version} becomes the active version; any other active version of ${confirm.def.code} is deactivated. Running requests keep their snapshot.` : `${confirm?.def.code} v${confirm?.def.version} will no longer be used for new requests. Running requests are not affected.`}
        confirmLabel={confirm?.action === 'activate' ? 'Activate' : 'Deactivate'} variant={confirm?.action === 'activate' ? 'primary' : 'danger'}
        loading={activate.isPending || deactivate.isPending} error={confirmError} onConfirm={onConfirm} onCancel={() => { setConfirm(null); setConfirmError(null); }} />
    </>
  );
}
