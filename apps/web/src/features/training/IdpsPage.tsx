import { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { DEVELOPMENT_TYPES, type IdpItemDto, type IdpSummaryDto } from '@hr/shared';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Alert } from '@/components/ui/Alert';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { Pagination } from '@/components/ui/Pagination';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { LoadingBlock } from '@/components/ui/Spinner';
import { useToast } from '@/components/ui/Toast';
import { errorMessage } from '@/features/organization/shared';
import { EmployeePicker, type PayrollEmployeeOption } from '@/features/payroll/employee-picker';
import { useCourses, useIdp, useIdps, useTrainingMutations, useTrainingNeeds } from './training.api';
import { IdpStatusBadge, ItemStatusBadge, ProgressBar, developmentLabel } from './training-ui';

/** HR's view of development plans: create one, build it from needs and activities, activate it, complete it. */
export function IdpsPage() {
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const idps = useIdps({ view: 'all', status, page, pageSize: 20 });

  const columns: Column<IdpSummaryDto>[] = [
    { key: 'emp', header: 'Employee', render: (p) => <div><div className="font-medium text-slate-900">{p.employee.firstName} {p.employee.lastName}</div><div className="text-xs text-slate-400">{p.employee.employeeCode}{p.employee.departmentName && ` · ${p.employee.departmentName}`}</div></div> },
    { key: 'title', header: 'Plan', render: (p) => <div><div className="text-slate-900">{p.title}</div><div className="text-xs text-slate-400">{p.periodStart} → {p.periodEnd}</div></div> },
    { key: 'progress', header: 'Progress', hideBelow: 'md', render: (p) => <ProgressBar percent={p.progressPercent} /> },
    { key: 'items', header: 'Activities', className: 'text-right', hideBelow: 'sm', render: (p) => <span className="tabular-nums">{p.completedItemCount}/{p.itemCount}</span> },
    { key: 'status', header: 'Status', render: (p) => <IdpStatusBadge status={p.status} /> },
  ];

  return (
    <>
      <Card>
        <div className="grid grid-cols-1 gap-3 border-b border-slate-200 p-4 sm:grid-cols-2">
          <Select options={['DRAFT', 'ACTIVE', 'COMPLETED', 'CANCELLED'].map((s) => ({ value: s, label: s.charAt(0) + s.slice(1).toLowerCase() }))} placeholder="All statuses" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} />
          <div className="flex justify-end"><Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> Development plan</Button></div>
        </div>
        {idps.isError && <Alert className="m-4">Could not load development plans.</Alert>}
        <DataTable columns={columns} rows={idps.data?.data ?? []} rowKey={(p) => p.id} loading={idps.isLoading} onRowClick={(p) => setOpenId(p.id)} emptyTitle="No development plans" />
        {idps.data?.meta && <Pagination {...idps.data.meta} onPageChange={setPage} />}
      </Card>
      <CreateIdpModal open={creating} onClose={() => setCreating(false)} />
      <IdpDetailModal idpId={openId} onClose={() => setOpenId(null)} />
    </>
  );
}

function CreateIdpModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const m = useTrainingMutations();
  const toast = useToast();
  const [employee, setEmployee] = useState<PayrollEmployeeOption | null>(null);
  const [title, setTitle] = useState('');
  const [periodStart, setStart] = useState('');
  const [periodEnd, setEnd] = useState('');
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (open) { setErr(null); setEmployee(null); setTitle(''); setStart(''); setEnd(''); } }, [open]);
  const submit = async () => {
    setErr(null);
    try { await m.createIdp.mutateAsync({ employeeId: employee!.id, title, periodStart, periodEnd }); toast.success('Plan created'); onClose(); } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <Modal open={open} onClose={onClose} title="New development plan" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={submit} loading={m.createIdp.isPending} disabled={!employee || !title || !periodStart || !periodEnd}>Create</Button></>}>
      <div className="space-y-3">
        {err && <Alert>{err}</Alert>}
        <EmployeePicker value={employee} onChange={setEmployee} endpoint="/training/employee-options" />
        <Input label="Title" required value={title} onChange={(e) => setTitle(e.target.value)} placeholder="2026 development" />
        <div className="grid grid-cols-2 gap-3">
          <Input label="From" required type="date" value={periodStart} onChange={(e) => setStart(e.target.value)} />
          <Input label="To" required type="date" value={periodEnd} onChange={(e) => setEnd(e.target.value)} />
        </div>
      </div>
    </Modal>
  );
}

function IdpDetailModal({ idpId, onClose }: { idpId: string | null; onClose: () => void }) {
  const idp = useIdp(idpId);
  const m = useTrainingMutations();
  const toast = useToast();
  const p = idp.data;
  const needs = useTrainingNeeds({ view: 'all', employeeId: p?.employee.id ?? '', pageSize: 50 });
  const courses = useCourses({ status: 'active', pageSize: 100 });
  const [title, setTitle] = useState('');
  const [developmentType, setType] = useState<(typeof DEVELOPMENT_TYPES)[number]>('TRAINING');
  const [trainingNeedId, setNeedId] = useState('');
  const [linkedCourseId, setCourseId] = useState('');
  const [targetDate, setTargetDate] = useState('');
  const [confirm, setConfirm] = useState<'activate' | 'complete' | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { setErr(null); setTitle(''); setNeedId(''); setCourseId(''); setTargetDate(''); }, [idpId]);
  const editable = p ? ['DRAFT', 'ACTIVE'].includes(p.status) : false;

  const add = async () => {
    setErr(null);
    try {
      await m.addIdpItem.mutateAsync({ idpId: p!.id, input: { title, developmentType, trainingNeedId: trainingNeedId || null, linkedCourseId: linkedCourseId || null, targetDate: targetDate || null } });
      setTitle(''); setNeedId(''); setCourseId(''); setTargetDate('');
    } catch (e) { setErr(errorMessage(e)); }
  };
  const act = async (action: 'activate' | 'complete') => {
    setErr(null);
    try { await m.idpAction.mutateAsync({ id: p!.id, action }); toast.success(action === 'activate' ? 'Plan activated' : 'Plan completed'); setConfirm(null); } catch (e) { setErr(errorMessage(e)); }
  };
  const setItemStatus = async (item: IdpItemDto, status: 'COMPLETED' | 'CANCELLED') => {
    setErr(null);
    try { await m.updateIdpItem.mutateAsync({ id: item.id, input: { status } }); } catch (e) { setErr(errorMessage(e)); }
  };

  return (
    <>
      <Modal open={!!idpId} onClose={onClose} title={p?.title ?? 'Development plan'} description={p ? `${p.employee.firstName} ${p.employee.lastName} · ${p.periodStart} → ${p.periodEnd}` : undefined} size="lg">
        {idp.isLoading && <LoadingBlock />}
        {err && <Alert className="mb-3">{err}</Alert>}
        {p && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <IdpStatusBadge status={p.status} />
              <ProgressBar percent={p.progressPercent} />
              <span className="text-slate-500">{p.completedItemCount} of {p.itemCount} complete</span>
              {p.manager.name && <span className="text-slate-500">manager {p.manager.name}</span>}
            </div>
            <div className="flex flex-wrap gap-2">
              {p.status === 'DRAFT' && <Button onClick={() => setConfirm('activate')}>Activate</Button>}
              {p.status === 'ACTIVE' && <Button onClick={() => setConfirm('complete')}>Complete plan</Button>}
            </div>
            <ul className="divide-y divide-slate-200 rounded-md border border-slate-200">
              {p.items.length === 0 && <li className="p-3 text-sm text-slate-400">No activities yet.</li>}
              {p.items.map((item) => (
                <li key={item.id} className="p-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <span className="min-w-0">
                      <span className="block text-sm font-medium text-slate-900">{item.title}</span>
                      <span className="block text-xs text-slate-500">{developmentLabel(item.developmentType)}{item.competency && ` · ${item.competency.name}`}{item.linkedCourse && ` · ${item.linkedCourse.title}`}{item.targetDate && ` · by ${item.targetDate}`}</span>
                    </span>
                    <span className="flex items-center gap-2">
                      <ProgressBar percent={item.status === 'COMPLETED' ? 100 : item.progressPercent} />
                      <ItemStatusBadge status={item.status} />
                      {editable && !['COMPLETED', 'CANCELLED'].includes(item.status) && item.developmentType !== 'TRAINING' && <Button variant="ghost" size="sm" onClick={() => setItemStatus(item, 'COMPLETED')}>Complete</Button>}
                      {editable && !['COMPLETED', 'CANCELLED'].includes(item.status) && <Button variant="ghost" size="sm" onClick={() => setItemStatus(item, 'CANCELLED')}>Cancel</Button>}
                    </span>
                  </div>
                  {item.employeeComment && <p className="mt-1 text-xs text-slate-600">Employee: {item.employeeComment}</p>}
                  {item.managerComment && <p className="mt-1 text-xs text-slate-600">Manager: {item.managerComment}</p>}
                  {item.hrComment && <p className="mt-1 text-xs text-slate-600">HR: {item.hrComment}</p>}
                </li>
              ))}
            </ul>
            {editable && (
              <div className="space-y-3 rounded-md border border-slate-200 p-3">
                <div className="text-sm font-medium text-slate-700">Add an activity</div>
                <Select label="From a development need" options={(needs.data?.data ?? []).filter((n) => !['FULFILLED', 'CANCELLED'].includes(n.status)).map((n) => ({ value: n.id, label: n.title }))} placeholder="Optional — pick an open need" value={trainingNeedId} onChange={(e) => { setNeedId(e.target.value); const need = needs.data?.data.find((n) => n.id === e.target.value); if (need && !title) setTitle(need.title); }} />
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <Input label="Activity" required value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Complete Advanced SQL" />
                  <Select label="Type" options={DEVELOPMENT_TYPES.map((t) => ({ value: t, label: developmentLabel(t) }))} value={developmentType} onChange={(e) => setType(e.target.value as typeof developmentType)} />
                  <Input label="Target date" type="date" value={targetDate} onChange={(e) => setTargetDate(e.target.value)} />
                </div>
                {developmentType === 'TRAINING' && <Select label="Course" options={(courses.data?.data ?? []).map((c) => ({ value: c.id, label: c.title }))} placeholder="Optional — a course from the catalogue" value={linkedCourseId} onChange={(e) => setCourseId(e.target.value)} />}
                <div className="flex justify-end"><Button onClick={add} loading={m.addIdpItem.isPending} disabled={!title}>Add activity</Button></div>
              </div>
            )}
          </div>
        )}
      </Modal>
      <ConfirmDialog open={confirm === 'activate'} title="Activate this plan" message="The employee can record progress against it from now on." confirmLabel="Activate" loading={m.idpAction.isPending} error={err} onConfirm={() => act('activate')} onCancel={() => setConfirm(null)} />
      <ConfirmDialog open={confirm === 'complete'} title="Complete this plan" message="Every activity that is not cancelled must already be complete. The plan is then frozen." confirmLabel="Complete" loading={m.idpAction.isPending} error={err} onConfirm={() => act('complete')} onCancel={() => setConfirm(null)} />
    </>
  );
}

export type { IdpItemDto };
