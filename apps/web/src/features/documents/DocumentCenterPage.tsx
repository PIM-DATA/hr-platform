import { useEffect, useState } from 'react';
import { Plus, Upload } from 'lucide-react';
import { DOCUMENT_CLASSIFICATIONS, DOCUMENT_LINK_ENTITY_TYPES, PERMISSIONS, type DocumentDto } from '@hr/shared';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Alert } from '@/components/ui/Alert';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { SearchInput } from '@/components/ui/SearchInput';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { Pagination } from '@/components/ui/Pagination';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { LoadingBlock } from '@/components/ui/Spinner';
import { useToast } from '@/components/ui/Toast';
import { useAuth } from '@/hooks/useAuth';
import { useDebounce } from '@/hooks/useDebounce';
import { errorMessage } from '@/features/organization/shared';
import { EmployeePicker, type PayrollEmployeeOption } from '@/features/payroll/employee-picker';
import { useDocument, useDocumentCategories, useDocumentMutations, useDocumentPolicy, useDocuments } from './documents.api';
import { CLASSIFICATION_LABEL, ClassificationBadge, DownloadLinks, ExpiryBadge, formatBytes } from './documents-ui';

const titleCase = (s: string) => s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, ' ');

export function DocumentCenterPage() {
  const { hasPermission } = useAuth();
  const manage = hasPermission(PERMISSIONS.DOCUMENTS_MANAGE);
  const categories = useDocumentCategories();
  const [search, setSearch] = useState('');
  const [categoryId, setCategory] = useState('');
  const [classification, setClassification] = useState('');
  const [status, setStatus] = useState('ACTIVE');
  const [expiry, setExpiry] = useState('');
  const [page, setPage] = useState(1);
  const [uploading, setUploading] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const list = useDocuments({ search: useDebounce(search), categoryId, classification, status, expiry, page, pageSize: 20 });
  const columns: Column<DocumentDto>[] = [
    { key: 'title', header: 'Document', render: (d) => <div><div className="font-medium text-slate-900">{d.title}</div><div className="text-xs text-slate-400">{d.documentNumber} · {d.category.name}</div></div> },
    { key: 'owner', header: 'Employee', hideBelow: 'sm', render: (d) => (d.owner ? <span>{d.owner.firstName} {d.owner.lastName} <span className="text-xs text-slate-400">{d.owner.employeeCode}</span></span> : <span className="text-slate-400">—</span>) },
    { key: 'class', header: 'Classification', hideBelow: 'md', render: (d) => <ClassificationBadge value={d.classification} /> },
    { key: 'issued', header: 'Issued', hideBelow: 'lg', render: (d) => d.issuedDate ?? <span className="text-slate-400">—</span> },
    { key: 'expiry', header: 'Expiry', hideBelow: 'md', render: (d) => <ExpiryBadge state={d.expiryState} date={d.expiryDate} /> },
    { key: 'version', header: 'Version', hideBelow: 'sm', render: (d) => (d.currentVersion ? <span className="text-slate-600">v{d.currentVersion.versionNumber} · {formatBytes(d.currentVersion.fileSize)}</span> : '—') },
  ];
  return (
    <>
      <Card>
        <div className="grid grid-cols-1 gap-3 border-b border-slate-200 p-4 sm:grid-cols-3 xl:grid-cols-6">
          <SearchInput placeholder="Title, number, employee…" value={search} onChange={(v) => { setSearch(v); setPage(1); }} />
          <Select options={(categories.data ?? []).map((c) => ({ value: c.id, label: c.name }))} placeholder="All categories" value={categoryId} onChange={(e) => { setCategory(e.target.value); setPage(1); }} />
          <Select options={DOCUMENT_CLASSIFICATIONS.map((c) => ({ value: c, label: CLASSIFICATION_LABEL[c] ?? c }))} placeholder="All classifications" value={classification} onChange={(e) => { setClassification(e.target.value); setPage(1); }} />
          <Select options={[{ value: 'ACTIVE', label: 'Active' }, { value: 'ARCHIVED', label: 'Archived' }]} value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} />
          <Select options={['VALID', 'EXPIRING_SOON', 'EXPIRED', 'NONE'].map((x) => ({ value: x, label: titleCase(x) }))} placeholder="Any expiry" value={expiry} onChange={(e) => { setExpiry(e.target.value); setPage(1); }} />
          {manage && <div className="flex justify-end"><Button onClick={() => setUploading(true)}><Plus className="h-4 w-4" /> Document</Button></div>}
        </div>
        {list.isError && <Alert className="m-4">Could not load documents.</Alert>}
        <DataTable columns={columns} rows={list.data?.data ?? []} rowKey={(d) => d.id} loading={list.isLoading} onRowClick={(d) => setOpenId(d.id)} emptyTitle="No documents" emptyDescription="Documents you may see appear here; classification and the owning module decide." />
        {list.data?.meta && <Pagination {...list.data.meta} onPageChange={setPage} />}
      </Card>
      <UploadModal open={uploading} onClose={() => setUploading(false)} />
      <DocumentDetailModal id={openId} onClose={() => setOpenId(null)} />
    </>
  );
}

function FilePolicy({ categoryId }: { categoryId: string }) {
  const policy = useDocumentPolicy();
  const categories = useDocumentCategories();
  const cat = categories.data?.find((c) => c.id === categoryId);
  const max = Math.min(cat?.maxFileSizeBytes ?? Number.MAX_SAFE_INTEGER, policy.data?.maxFileSizeBytes ?? Number.MAX_SAFE_INTEGER);
  const ext = cat?.allowedExtensions ?? policy.data?.allowedExtensions ?? [];
  return <p className="text-xs text-slate-500">Accepted: {ext.join(', ')} · up to {formatBytes(max)}. Files are stored as uploaded and are not scanned for malware by this system.</p>;
}

function UploadModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const m = useDocumentMutations();
  const toast = useToast();
  const categories = useDocumentCategories();
  const [file, setFile] = useState<File | null>(null);
  const [employee, setEmployee] = useState<PayrollEmployeeOption | null>(null);
  const [f, setF] = useState({ title: '', description: '', categoryId: '', classification: '', issuedDate: '', expiryDate: '', note: '' });
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (open) { setErr(null); setFile(null); setEmployee(null); setF({ title: '', description: '', categoryId: '', classification: '', issuedDate: '', expiryDate: '', note: '' }); } }, [open]);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });
  const cat = categories.data?.find((c) => c.id === f.categoryId);
  const submit = async () => {
    setErr(null);
    try { await m.upload.mutateAsync({ file: file!, fields: { ...f, ownerEmployeeId: employee?.id ?? null } }); toast.success('Document uploaded'); onClose(); } catch (e) { setErr(errorMessage(e)); }
  };
  return (
    <Modal open={open} onClose={onClose} title="New document" description="Version 1 of a new document. The file is stored under an opaque key; the name you see is for display only." size="lg"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={submit} loading={m.upload.isPending} disabled={!file || !f.title.trim() || !f.categoryId}><Upload className="h-4 w-4" /> Upload</Button></>}>
      <div className="space-y-3">
        {err && <Alert>{err}</Alert>}
        <EmployeePicker label="Employee (optional)" value={employee} onChange={setEmployee} endpoint="/recruitment/employee-options" />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Select label="Category" required options={(categories.data ?? []).map((c) => ({ value: c.id, label: c.name }))} placeholder="Select…" value={f.categoryId} onChange={(e) => setF({ ...f, categoryId: e.target.value, classification: '' })} />
          <Select label="Classification" options={DOCUMENT_CLASSIFICATIONS.map((c) => ({ value: c, label: CLASSIFICATION_LABEL[c] ?? c }))} placeholder={cat ? `Category default: ${CLASSIFICATION_LABEL[cat.defaultClassification]}` : 'Category default'} value={f.classification} onChange={set('classification')} />
          <Input label="Title" required value={f.title} onChange={set('title')} className="sm:col-span-2" />
          <Input label="Issued date" type="date" value={f.issuedDate} onChange={set('issuedDate')} />
          <Input label="Expiry date" type="date" value={f.expiryDate} onChange={set('expiryDate')} />
        </div>
        <Textarea label="Description" rows={2} value={f.description} onChange={set('description')} />
        <div>
          <label className="block text-sm font-medium text-slate-700">File</label>
          <input type="file" className="mt-1 block w-full text-sm text-slate-700 file:mr-3 file:rounded-md file:border-0 file:bg-slate-100 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-slate-700 hover:file:bg-slate-200" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          <div className="mt-1"><FilePolicy categoryId={f.categoryId} /></div>
        </div>
      </div>
    </Modal>
  );
}

function DocumentDetailModal({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { hasPermission } = useAuth();
  const manage = hasPermission(PERMISSIONS.DOCUMENTS_MANAGE);
  const q = useDocument(id);
  const m = useDocumentMutations();
  const toast = useToast();
  const [versionFile, setVersionFile] = useState<File | null>(null);
  const [versionNote, setVersionNote] = useState('');
  const [linkType, setLinkType] = useState('EMPLOYEE');
  const [linkId, setLinkId] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const d = q.data;
  useEffect(() => { if (id) { setErr(null); setVersionFile(null); setVersionNote(''); setLinkId(''); } }, [id]);
  const run = async (fn: () => Promise<unknown>, done: string) => { setErr(null); try { await fn(); toast.success(done); } catch (e) { setErr(errorMessage(e)); } };
  return (
    <>
      <Modal open={!!id} onClose={onClose} title={d?.title ?? 'Document'} description={d ? `${d.documentNumber} · ${d.category.name}${d.owner ? ` · ${d.owner.firstName} ${d.owner.lastName} (${d.owner.employeeCode})` : ''}` : undefined} size="lg"
        footer={<div className="flex flex-wrap justify-end gap-2"><Button variant="secondary" onClick={onClose}>Close</Button>{manage && d?.status === 'ACTIVE' && <Button variant="danger" onClick={() => setConfirm(true)}>Archive</Button>}</div>}>
        {q.isLoading && <LoadingBlock />}
        {q.isError && <Alert>Could not load this document.</Alert>}
        {err && <Alert className="mb-3">{err}</Alert>}
        {d && (
          <div className="space-y-5 text-sm">
            <div className="flex flex-wrap items-center gap-3"><ClassificationBadge value={d.classification} /><ExpiryBadge state={d.expiryState} date={d.expiryDate} />{d.status === 'ARCHIVED' && <span className="text-slate-500">archived {d.archivedAt?.slice(0, 10)}</span>}{d.issuedDate && <span className="text-slate-500">issued {d.issuedDate}</span>}</div>
            {d.description && <p className="whitespace-pre-wrap text-slate-700">{d.description}</p>}
            <section>
              <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Current version</h3>
              {d.currentVersion ? <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-slate-200 p-3"><div><div className="font-medium text-slate-900">v{d.currentVersion.versionNumber} · {d.currentVersion.originalFilename}</div><div className="text-xs text-slate-500">{formatBytes(d.currentVersion.fileSize)} · {d.currentVersion.mimeType} · uploaded {d.currentVersion.uploadedAt.slice(0, 10)}{d.currentVersion.uploadedBy && ` by ${d.currentVersion.uploadedBy}`} · sha256 {d.currentVersion.sha256.slice(0, 12)}…</div></div>{d.can.download && <DownloadLinks documentId={d.id} version={d.currentVersion} size="text-sm" />}</div> : <p className="text-slate-500">No file.</p>}
            </section>
            <section>
              <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Version history</h3>
              <ul className="divide-y divide-slate-100 rounded-md border border-slate-200">{d.versions.map((v) => <li key={v.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2"><span><span className="font-medium text-slate-900">v{v.versionNumber}</span> <span className="text-slate-700">{v.originalFilename}</span><span className="ml-2 text-xs text-slate-500">{formatBytes(v.fileSize)} · {v.uploadedAt.slice(0, 10)}{v.uploadedBy && ` · ${v.uploadedBy}`} · {v.sha256.slice(0, 12)}…{v.note && ` · ${v.note}`}</span></span>{d.can.download && <DownloadLinks documentId={d.id} version={v} />}</li>)}</ul>
              {manage && d.status === 'ACTIVE' && (
                <div className="mt-2 space-y-2 rounded-md border border-dashed border-slate-300 p-3">
                  <div className="text-xs font-medium text-slate-700">Upload a new version (the previous file is kept)</div>
                  <input type="file" className="block w-full text-sm" onChange={(e) => setVersionFile(e.target.files?.[0] ?? null)} />
                  <Input label="Note" value={versionNote} onChange={(e) => setVersionNote(e.target.value)} placeholder="What changed" />
                  <Button size="sm" onClick={() => run(async () => { await m.uploadVersion.mutateAsync({ id: d.id, file: versionFile!, note: versionNote || undefined }); setVersionFile(null); setVersionNote(''); }, 'New version uploaded')} loading={m.uploadVersion.isPending} disabled={!versionFile}>Upload version</Button>
                </div>
              )}
            </section>
            <section>
              <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Linked records</h3>
              {d.links.length === 0 ? <p className="text-slate-500">Not linked to a record.</p> : <ul className="space-y-1">{d.links.map((l) => <li key={l.id} className="flex items-center justify-between text-slate-700"><span>{titleCase(l.entityType)} <span className="font-mono text-xs text-slate-500">{l.entityId}</span>{l.relationType && <span className="ml-1 text-xs text-slate-400">{l.relationType}</span>}</span>{manage && <Button size="sm" variant="ghost" onClick={() => run(() => m.unlink.mutateAsync({ id: d.id, linkId: l.id }), 'Link removed')}>Unlink</Button>}</li>)}</ul>}
              {manage && d.status === 'ACTIVE' && (
                <div className="mt-2 flex flex-wrap items-end gap-2">
                  <Select label="Record type" options={DOCUMENT_LINK_ENTITY_TYPES.map((t) => ({ value: t, label: titleCase(t) }))} value={linkType} onChange={(e) => setLinkType(e.target.value)} />
                  <Input label="Record id" value={linkId} onChange={(e) => setLinkId(e.target.value)} placeholder="Paste the record's id" />
                  <Button size="sm" variant="secondary" onClick={() => run(async () => { await m.link.mutateAsync({ id: d.id, input: { entityType: linkType as never, entityId: linkId.trim() } }); setLinkId(''); }, 'Linked')} loading={m.link.isPending} disabled={!linkId.trim()}>Link</Button>
                </div>
              )}
              <p className="mt-1 text-xs text-slate-500">Linking needs the owning module's permission and adds that module's authorization to this document; it never widens access to the record.</p>
            </section>
          </div>
        )}
      </Modal>
      <ConfirmDialog open={confirm} title="Archive this document?" message="Metadata and every version are kept; the document leaves default lists. There is no delete." confirmLabel="Archive" variant="danger" onConfirm={() => run(() => m.archive.mutateAsync(id!), 'Document archived').then(() => setConfirm(false))} onCancel={() => setConfirm(false)} loading={m.archive.isPending} />
    </>
  );
}

export function DocumentCategoriesPage() {
  const categories = useDocumentCategories(true);
  const m = useDocumentMutations();
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const [f, setF] = useState({ code: '', name: '', scopeType: 'GENERAL', defaultClassification: 'EMPLOYEE_PRIVATE', description: '' });
  const [err, setErr] = useState<string | null>(null);
  const submit = async () => { setErr(null); try { await m.createCategory.mutateAsync({ code: f.code, name: f.name, scopeType: f.scopeType as never, defaultClassification: f.defaultClassification as never, description: f.description || null, isActive: true }); toast.success('Category created'); setCreating(false); setF({ code: '', name: '', scopeType: 'GENERAL', defaultClassification: 'EMPLOYEE_PRIVATE', description: '' }); } catch (e) { setErr(errorMessage(e)); } };
  const columns: Column<NonNullable<typeof categories.data>[number]>[] = [
    { key: 'name', header: 'Category', render: (c) => <div><div className="font-medium text-slate-900">{c.name}{!c.isActive && ' (inactive)'}</div><div className="text-xs text-slate-400">{c.code}{c.description && ` · ${c.description}`}</div></div> },
    { key: 'scope', header: 'Owning module', render: (c) => titleCase(c.scopeType) },
    { key: 'class', header: 'Default classification', hideBelow: 'sm', render: (c) => <ClassificationBadge value={c.defaultClassification} /> },
    { key: 'policy', header: 'File policy', hideBelow: 'md', render: (c) => <span className="text-slate-600">{c.allowedExtensions?.join(', ') ?? 'platform default'}{c.maxFileSizeBytes && ` · ≤ ${formatBytes(c.maxFileSizeBytes)}`}</span> },
  ];
  return (
    <>
      <Card>
        <div className="flex items-center justify-between border-b border-slate-200 p-4"><p className="text-sm text-slate-600">The owning module adds its own authorization on top of the classification. Nothing is inferred from a category's name.</p><Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> Category</Button></div>
        <DataTable columns={columns} rows={categories.data ?? []} rowKey={(c) => c.id} loading={categories.isLoading} emptyTitle="No categories" />
      </Card>
      <Modal open={creating} onClose={() => setCreating(false)} title="New category" size="md" footer={<><Button variant="secondary" onClick={() => setCreating(false)}>Cancel</Button><Button onClick={submit} loading={m.createCategory.isPending} disabled={!f.code || !f.name}>Create</Button></>}>
        <div className="space-y-3">
          {err && <Alert>{err}</Alert>}
          <Input label="Code" required value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} />
          <Input label="Name" required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          <Select label="Owning module" options={['GENERAL', 'EMPLOYEE', 'HR', 'PAYROLL', 'RECRUITMENT', 'EMPLOYEE_RELATIONS', 'TRAINING', 'OTHER'].map((s) => ({ value: s, label: titleCase(s) }))} value={f.scopeType} onChange={(e) => setF({ ...f, scopeType: e.target.value })} />
          <Select label="Default classification" options={DOCUMENT_CLASSIFICATIONS.map((c) => ({ value: c, label: CLASSIFICATION_LABEL[c] ?? c }))} value={f.defaultClassification} onChange={(e) => setF({ ...f, defaultClassification: e.target.value })} />
          <Textarea label="Description" rows={2} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
        </div>
      </Modal>
    </>
  );
}
