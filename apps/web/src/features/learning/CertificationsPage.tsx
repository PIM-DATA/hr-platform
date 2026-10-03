import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { CERTIFICATION_STATUSES, PERMISSIONS, type CertificationDefinitionDto, type EmployeeCertificationDto } from '@hr/shared';
import { Card, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Alert } from '@/components/ui/Alert';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { Pagination } from '@/components/ui/Pagination';
import { LoadingBlock } from '@/components/ui/Spinner';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { useToast } from '@/components/ui/Toast';
import { useAuth } from '@/hooks/useAuth';
import { errorMessage } from '@/features/organization/shared';
import { EmployeePicker, type PayrollEmployeeOption } from '@/features/payroll/employee-picker';
import { useDocuments } from '@/features/documents/documents.api';
import { useCertification, useCertificationDefinitions, useCertifications, useLearningMutations, useLearningOptions } from './learning.api';
import { businessDateToday } from '@/lib/format';
import { LearningBadge, fmtDate, titleCase } from './learning-ui';

/** Certifications: a definition (what), an issuance per person with dates, and a status derived on read. Renewal is a new row; revoking is a human act with a reason. */
export function CertificationsPage() {
  const { hasPermission } = useAuth();
  const manage = hasPermission(PERMISSIONS.CERTIFICATION_MANAGE);
  const [params, setParams] = useSearchParams();
  const [view, setView] = useState<'certs' | 'defs'>('certs');
  const openId = params.get('open');
  const setOpen = (id: string | null) => { const n = new URLSearchParams(params); if (id) n.set('open', id); else n.delete('open'); setParams(n, { replace: true }); };
  return (
    <>
      {manage && <div className="mb-4 flex gap-2">{(['certs', 'defs'] as const).map((v) => <button key={v} onClick={() => setView(v)} className={`rounded-md border px-3 py-1.5 text-sm ${view === v ? 'border-brand-500 bg-brand-50 text-brand-800' : 'border-slate-300 bg-white text-slate-700'}`}>{v === 'certs' ? 'Certifications' : 'Definitions'}</button>)}</div>}
      {view === 'defs' && manage ? <DefinitionsPanel /> : <CertificationsPanel manage={manage} onOpen={setOpen} />}
      {openId && <CertificationModal id={openId} onClose={() => setOpen(null)} />}
    </>
  );
}

function CertificationsPanel({ manage, onOpen }: { manage: boolean; onOpen: (id: string) => void }) {
  const [status, setStatus] = useState(''); const [definitionId, setDefinitionId] = useState(''); const [page, setPage] = useState(1); const [issuing, setIssuing] = useState(false);
  const defs = useCertificationDefinitions(); const list = useCertifications({ status, definitionId, page, pageSize: 20 });
  const columns: Column<EmployeeCertificationDto>[] = [
    { key: 'e', header: 'Employee', render: (c) => c.employee ? <div><div className="font-medium text-slate-900">{c.employee.name}</div><div className="text-xs text-slate-400">{c.employee.employeeCode} · {c.employee.department ?? '—'}</div></div> : '—' },
    { key: 'd', header: 'Certification', render: (c) => <span>{c.definitionName}<span className="block text-xs text-slate-400">{titleCase(c.issuerType)}{c.issuerName ? ` · ${c.issuerName}` : ''}{c.renewedFromId ? ' · renewal' : ''}</span></span> },
    { key: 'dates', header: 'Issued / expires', hideBelow: 'sm', render: (c) => `${c.issuedDate} / ${c.expiryDate ?? 'no expiry'}` },
    { key: 's', header: 'Status', render: (c) => <span className="flex items-center gap-2"><LearningBadge status={c.status} />{c.daysToExpiry !== null && c.status !== 'REVOKED' && c.status !== 'EXPIRED' && <span className="text-xs text-slate-500">{c.daysToExpiry} days</span>}</span> },
  ];
  return (
    <Card>
      <div className="grid grid-cols-1 gap-3 border-b border-slate-200 p-4 sm:grid-cols-3">
        <Select options={CERTIFICATION_STATUSES.map((s) => ({ value: s, label: titleCase(s) }))} placeholder="All statuses" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} />
        <Select options={(defs.data ?? []).map((d) => ({ value: d.id, label: d.name }))} placeholder="All certifications" value={definitionId} onChange={(e) => { setDefinitionId(e.target.value); setPage(1); }} />
        {manage && <div className="flex justify-end"><Button onClick={() => setIssuing(true)}><Plus className="h-4 w-4" /> Issue certification</Button></div>}
      </div>
      {list.isError && <Alert className="m-4">Could not load certifications.</Alert>}
      <DataTable columns={columns} rows={list.data?.data ?? []} rowKey={(c) => c.id} loading={list.isLoading} onRowClick={(c) => onOpen(c.id)} emptyTitle="No certifications" emptyDescription="HR records a certification against a definition." />
      {list.data?.meta && <Pagination {...list.data.meta} onPageChange={setPage} />}
      {issuing && <IssueModal onClose={() => setIssuing(false)} onDone={(id) => { setIssuing(false); onOpen(id); }} />}
    </Card>
  );
}

function CertificationForm({ employeeId, value, onChange }: { employeeId: string | null; value: { certificateNumber: string; issuedDate: string; expiryDate: string; issuerName: string; documentId: string; note: string }; onChange: (v: typeof value) => void }) {
  const docs = useDocuments({ ownerEmployeeId: employeeId ?? '', pageSize: 50 }, !!employeeId);
  return (
    <>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2"><Input label="Issued date" type="date" value={value.issuedDate} onChange={(e) => onChange({ ...value, issuedDate: e.target.value })} /><Input label="Expiry date (blank = from validity)" type="date" value={value.expiryDate} onChange={(e) => onChange({ ...value, expiryDate: e.target.value })} /></div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2"><Input label="Certificate number (optional)" value={value.certificateNumber} onChange={(e) => onChange({ ...value, certificateNumber: e.target.value })} /><Input label="Issuer name (optional)" value={value.issuerName} onChange={(e) => onChange({ ...value, issuerName: e.target.value })} /></div>
      <Select label="Certificate document (Document Center, optional)" options={(docs.data?.data ?? []).map((x) => ({ value: x.id, label: `${x.documentNumber} · ${x.title}` }))} placeholder={employeeId ? 'None' : 'Choose the employee first'} value={value.documentId} onChange={(e) => onChange({ ...value, documentId: e.target.value })} />
      <Textarea label="Note (optional)" rows={2} value={value.note} onChange={(e) => onChange({ ...value, note: e.target.value })} />
    </>
  );
}
const emptyForm = () => ({ certificateNumber: '', issuedDate: businessDateToday(), expiryDate: '', issuerName: '', documentId: '', note: '' });
const formBody = (f: ReturnType<typeof emptyForm>) => ({ certificateNumber: f.certificateNumber || null, issuedDate: f.issuedDate, expiryDate: f.expiryDate || null, issuerName: f.issuerName || null, documentId: f.documentId || null, note: f.note || null });

function IssueModal({ onClose, onDone }: { onClose: () => void; onDone: (id: string) => void }) {
  const m = useLearningMutations(); const defs = useCertificationDefinitions(); const toast = useToast();
  const [employee, setEmployee] = useState<PayrollEmployeeOption | null>(null); const [definitionId, setDefinitionId] = useState(''); const [f, setF] = useState(emptyForm()); const [error, setError] = useState<string | null>(null);
  const submit = async () => { if (!employee || !definitionId) { setError('Choose the employee and the certification.'); return; } try { const c = await m.issue.mutateAsync({ employeeId: employee.id, definitionId, ...formBody(f) }); toast.success('Certification recorded.'); onDone(c.id); } catch (e) { setError(errorMessage(e)); } };
  return (
    <Modal open onClose={onClose} size="lg" title="Issue a certification" description="Records that a person holds a certification. Nothing else changes." footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={m.issue.isPending} onClick={submit}>Record</Button></>}>
      <div className="space-y-3">{error && <Alert>{error}</Alert>}<EmployeePicker value={employee} onChange={setEmployee} endpoint="/workforce/employee-options" /><Select label="Certification" options={(defs.data ?? []).map((d) => ({ value: d.id, label: `${d.name}${d.validityDays ? ` · valid ${d.validityDays} days` : ''}` }))} placeholder="Choose" value={definitionId} onChange={(e) => setDefinitionId(e.target.value)} /><CertificationForm employeeId={employee?.id ?? null} value={f} onChange={setF} /></div>
    </Modal>
  );
}

function CertificationModal({ id, onClose }: { id: string; onClose: () => void }) {
  const q = useCertification(id); const m = useLearningMutations(); const toast = useToast();
  const [renewing, setRenewing] = useState(false); const [revoking, setRevoking] = useState(false); const [reason, setReason] = useState(''); const [f, setF] = useState(emptyForm()); const [error, setError] = useState<string | null>(null);
  const { hasPermission } = useAuth(); const manage = hasPermission(PERMISSIONS.CERTIFICATION_MANAGE);
  if (!q.data) return <Modal open onClose={onClose} title="Certification">{q.isError ? <Alert>Could not load this certification.</Alert> : <LoadingBlock />}</Modal>;
  const d = q.data;
  const act = async (fn: () => Promise<unknown>, ok: string) => { setError(null); try { await fn(); toast.success(ok); setRenewing(false); setRevoking(false); } catch (e) { setError(errorMessage(e)); } };
  return (
    <Modal open onClose={onClose} title={d.definitionName} description={`${d.employee ? `${d.employee.name} (${d.employee.employeeCode}) · ` : ''}${titleCase(d.issuerType)}${d.issuerName ? ` · ${d.issuerName}` : ''}`}
      footer={<>{manage && d.status !== 'REVOKED' && !d.renewedById && <Button onClick={() => setRenewing(true)}>Renew</Button>}{manage && d.status !== 'REVOKED' && <Button variant="danger" onClick={() => setRevoking(true)}>Revoke</Button>}<Button variant="secondary" onClick={onClose}>Close</Button></>}>
      <div className="space-y-2 text-sm">
        {error && <Alert>{error}</Alert>}
        <div className="flex items-center gap-2"><LearningBadge status={d.status} />{d.daysToExpiry !== null && d.status !== 'REVOKED' && <span className="text-xs text-slate-500">{d.daysToExpiry >= 0 ? `${d.daysToExpiry} days to expiry` : `expired ${-d.daysToExpiry} days ago`}</span>}</div>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1"><dt className="text-slate-500">Issued</dt><dd>{d.issuedDate}</dd><dt className="text-slate-500">Expires</dt><dd>{d.expiryDate ?? 'No expiry'}</dd><dt className="text-slate-500">Certificate number</dt><dd>{d.certificateNumber ?? '—'}</dd><dt className="text-slate-500">Document</dt><dd>{d.documentTitle ?? '—'}</dd>{d.renewedFromId && <><dt className="text-slate-500">Renewal of</dt><dd>an earlier issuance (kept as history)</dd></>}{d.renewedById && <><dt className="text-slate-500">Renewed</dt><dd>a newer issuance exists</dd></>}{d.revokedAt && <><dt className="text-slate-500">Revoked</dt><dd>{fmtDate(d.revokedAt)}{d.revokeReason ? ` · ${d.revokeReason}` : ''}</dd></>}{d.note && <><dt className="text-slate-500">Note</dt><dd>{d.note}</dd></>}</dl>
      </div>
      <Modal open={renewing} onClose={() => setRenewing(false)} size="lg" title="Renew" description="A new issuance is recorded and linked to this one. History is kept." footer={<><Button variant="secondary" onClick={() => setRenewing(false)}>Cancel</Button><Button loading={m.renew.isPending} onClick={() => act(() => m.renew.mutateAsync({ id, input: formBody(f) }), 'Renewed.')}>Record renewal</Button></>}><div className="space-y-3"><CertificationForm employeeId={d.employeeId} value={f} onChange={setF} /></div></Modal>
      <ConfirmDialog open={revoking} title="Revoke this certification?" message="A manual decision with a reason. The row is kept with its revocation date." confirmLabel="Revoke" variant="danger" loading={m.revoke.isPending} onConfirm={() => act(() => m.revoke.mutateAsync({ id, reason }), 'Revoked.')} onCancel={() => setRevoking(false)} error={error} />
      {revoking && <div className="mt-2"><Textarea label="Reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} /></div>}
    </Modal>
  );
}

function DefinitionsPanel() {
  const defs = useCertificationDefinitions(true); const [editing, setEditing] = useState<CertificationDefinitionDto | 'new' | null>(null);
  const columns: Column<CertificationDefinitionDto>[] = [
    { key: 'n', header: 'Certification', render: (d) => <div><div className="font-medium text-slate-900">{d.name}</div><div className="text-xs text-slate-400">{d.code} · {titleCase(d.issuerType)}{d.issuerName ? ` · ${d.issuerName}` : ''}</div></div> },
    { key: 'v', header: 'Validity', render: (d) => d.validityDays ? `${d.validityDays} days` : 'No expiry' },
    { key: 'w', header: 'Expiring window', hideBelow: 'sm', render: (d) => `${d.expiryWindowDays} days` },
    { key: 'a', header: 'Active holders', hideBelow: 'md', render: (d) => d.activeCount },
    { key: 's', header: 'Status', render: (d) => <LearningBadge status={d.isActive ? 'ACTIVE' : 'INACTIVE'} /> },
  ];
  return (
    <Card>
      <div className="flex items-center justify-between border-b border-slate-200 p-4"><CardHeader title="Certification definitions" description="What can be held, who issues it and how long it stays valid." /><Button onClick={() => setEditing('new')}><Plus className="h-4 w-4" /> New definition</Button></div>
      <DataTable columns={columns} rows={defs.data ?? []} rowKey={(d) => d.id} loading={defs.isLoading} onRowClick={(d) => setEditing(d)} emptyTitle="No definitions yet" />
      {editing && <DefinitionModal def={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </Card>
  );
}

function DefinitionModal({ def, onClose }: { def: CertificationDefinitionDto | null; onClose: () => void }) {
  const m = useLearningMutations(); const opts = useLearningOptions(); const toast = useToast();
  const [d, setD] = useState({ code: def?.code ?? '', name: def?.name ?? '', description: def?.description ?? '', issuerType: (def?.issuerType ?? 'INTERNAL') as string, issuerName: def?.issuerName ?? '', organizationId: def?.organizationId ?? '', validityDays: def?.validityDays ? String(def.validityDays) : '', expiryWindowDays: def ? String(def.expiryWindowDays) : '30' });
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    const body = { code: d.code, name: d.name, description: d.description || null, issuerType: d.issuerType as 'INTERNAL' | 'EXTERNAL', issuerName: d.issuerName || null, organizationId: d.organizationId || null, validityDays: d.validityDays ? Number(d.validityDays) : null, expiryWindowDays: d.expiryWindowDays ? Number(d.expiryWindowDays) : null };
    setError(null);
    try { if (def) { const { code: _c, ...rest } = body; void _c; await m.updateDefinition.mutateAsync({ id: def.id, input: rest }); } else await m.createDefinition.mutateAsync(body); toast.success(def ? 'Definition updated.' : 'Definition created.'); onClose(); } catch (e) { setError(errorMessage(e)); }
  };
  return (
    <Modal open onClose={onClose} title={def ? `Edit ${def.name}` : 'New certification definition'} footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button>{def && <Button variant="secondary" onClick={() => m.updateDefinition.mutateAsync({ id: def.id, input: { isActive: !def.isActive } }).then(onClose)}>{def.isActive ? 'Deactivate' : 'Reactivate'}</Button>}<Button loading={m.createDefinition.isPending || m.updateDefinition.isPending} onClick={submit}>{def ? 'Save' : 'Create'}</Button></>}>
      <div className="space-y-3">
        {error && <Alert>{error}</Alert>}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3"><Input label="Code" value={d.code} disabled={!!def} onChange={(e) => setD({ ...d, code: e.target.value.toUpperCase() })} /><Input label="Name" className="sm:col-span-2" value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} /></div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2"><Select label="Issuer type" options={[{ value: 'INTERNAL', label: 'Internal' }, { value: 'EXTERNAL', label: 'External' }]} value={d.issuerType} onChange={(e) => setD({ ...d, issuerType: e.target.value })} /><Input label="Issuer name" value={d.issuerName} onChange={(e) => setD({ ...d, issuerName: e.target.value })} /></div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3"><Input label="Validity (days, blank = none)" type="number" value={d.validityDays} onChange={(e) => setD({ ...d, validityDays: e.target.value })} /><Input label="Expiring-soon window (days)" type="number" value={d.expiryWindowDays} onChange={(e) => setD({ ...d, expiryWindowDays: e.target.value })} /><Select label="Organization" options={(opts.data?.organizations ?? []).map((o) => ({ value: o.id, label: o.name }))} placeholder="Any" value={d.organizationId} onChange={(e) => setD({ ...d, organizationId: e.target.value })} /></div>
        <Textarea label="Description" rows={2} value={d.description} onChange={(e) => setD({ ...d, description: e.target.value })} />
      </div>
    </Modal>
  );
}
