import { useState } from 'react';
import { Plus } from 'lucide-react';
import { PRIVACY_REQUEST_STATUSES, PRIVACY_REQUEST_TERMINAL, PRIVACY_REQUEST_TYPES, type PrivacyEmployeeOptionDto, type PrivacyRequestDto, type PrivacyRequestStatus } from '@hr/shared';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { Input } from '@/components/ui/Input';
import { Alert } from '@/components/ui/Alert';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { Pagination } from '@/components/ui/Pagination';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { LoadingBlock } from '@/components/ui/Spinner';
import { ApiClientError } from '@/lib/api-client';
import { formatDate, formatDateTime } from '@/lib/format';
import { PrivacyEmployeePicker } from './PrivacyEmployeePicker';
import { usePrivacyMutations, usePrivacyRequest, usePrivacyRequests } from './privacy.api';

const PAGE_SIZE = 20;
const toOptions = (values: readonly string[]) => values.map((v) => ({ value: v, label: v.replace(/_/g, ' ') }));
const isClosed = (status: string) => PRIVACY_REQUEST_TERMINAL.includes(status as PrivacyRequestStatus);
const subjectLabel = (r: PrivacyRequestDto) =>
  r.subject.employee ? `${r.subject.employee.firstName} ${r.subject.employee.lastName} (${r.subject.employee.employeeCode})` : r.subject.user?.email ?? '—';

export function PrivacyRequestsPage() {
  const [status, setStatus] = useState('');
  const [requestType, setRequestType] = useState('');
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const requests = usePrivacyRequests({ status: status || undefined, requestType: requestType || undefined, page, pageSize: PAGE_SIZE });

  const columns: Column<PrivacyRequestDto>[] = [
    { key: 'requestedAt', header: 'Received', render: (r) => <span className="text-slate-600">{formatDate(r.requestedAt)}</span> },
    { key: 'type', header: 'Type', render: (r) => <span className="font-medium text-slate-900">{r.requestType.replace(/_/g, ' ')}</span> },
    { key: 'subject', header: 'Data subject', render: (r) => subjectLabel(r) },
    { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} tone={r.status === 'COMPLETED' ? 'success' : r.status === 'REJECTED' ? 'danger' : r.status === 'IN_PROGRESS' ? 'info' : 'warning'} /> },
    { key: 'due', header: 'Due', hideBelow: 'md', render: (r) => <span className="text-slate-500">{formatDate(r.dueAt)}</span> },
    { key: 'assigned', header: 'Assigned to', hideBelow: 'lg', render: (r) => <span className="text-slate-500">{r.assignedTo?.email ?? '—'}</span> },
  ];

  return (
    <>
      <div className="mb-4 flex justify-end">
        <Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> Record request</Button>
      </div>

      <Alert className="mb-4" tone="info">
        Deletion requests are recorded for policy review; automatic erasure is not available. Retention periods and legal basis are decided by your organization, not by this system.
      </Alert>

      <Card>
        <div className="flex flex-col gap-3 border-b border-slate-200 p-4 sm:flex-row">
          <Select options={toOptions(PRIVACY_REQUEST_STATUSES)} placeholder="All statuses" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} className="w-44" />
          <Select options={toOptions(PRIVACY_REQUEST_TYPES)} placeholder="All types" value={requestType} onChange={(e) => { setRequestType(e.target.value); setPage(1); }} className="w-44" />
        </div>
        {requests.isError && <Alert className="m-4">Could not load privacy requests.</Alert>}
        <DataTable
          columns={columns}
          rows={requests.data?.data ?? []}
          rowKey={(r) => r.id}
          loading={requests.isLoading}
          onRowClick={(r) => setOpenId(r.id)}
          emptyTitle="No privacy requests"
          emptyDescription="Requests you record from data subjects appear here."
        />
        {requests.data?.meta && <Pagination page={requests.data.meta.page} pageSize={requests.data.meta.pageSize} total={requests.data.meta.total} onPageChange={setPage} />}
      </Card>

      <CreateRequestModal open={creating} onClose={() => setCreating(false)} />
      <RequestDetailModal id={openId} onClose={() => setOpenId(null)} />
    </>
  );
}

function CreateRequestModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { create } = usePrivacyMutations();
  const [requestType, setRequestType] = useState<string>(PRIVACY_REQUEST_TYPES[0]);
  const [employee, setEmployee] = useState<PrivacyEmployeeOptionDto | null>(null);
  const [dueAt, setDueAt] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);

  const reset = () => { setRequestType(PRIVACY_REQUEST_TYPES[0]); setEmployee(null); setDueAt(''); setNotes(''); setError(null); };
  const close = () => { reset(); onClose(); };

  const onSubmit = async () => {
    setError(null);
    if (!employee) return setError('Choose the data subject this request is about.');
    try {
      await create.mutateAsync({
        requestType: requestType as (typeof PRIVACY_REQUEST_TYPES)[number],
        employeeId: employee.id,
        dueAt: dueAt ? new Date(`${dueAt}T00:00:00`).toISOString() : null,
        notes: notes.trim() || null,
      });
      close();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.error.message : 'Something went wrong.');
    }
  };

  return (
    <Modal
      open={open}
      onClose={close}
      title="Record a privacy request"
      description="What the data subject asked for, and when."
      footer={<><Button variant="secondary" onClick={close}>Cancel</Button><Button onClick={onSubmit} loading={create.isPending}>Record request</Button></>}
    >
      <div className="space-y-4">
        {error && <Alert>{error}</Alert>}
        <Select label="Request type" options={toOptions(PRIVACY_REQUEST_TYPES)} value={requestType} onChange={(e) => setRequestType(e.target.value)} />
        <div className="space-y-1.5">
          <span className="block text-sm font-medium text-slate-700">Data subject</span>
          <PrivacyEmployeePicker value={employee} onChange={setEmployee} />
        </div>
        <Input label="Due date" type="date" value={dueAt} onChange={(e) => setDueAt(e.target.value)} hint="Optional — the deadline your policy sets for answering." />
        <Textarea label="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="How the request arrived, what exactly was asked for…" />
        <p className="text-xs text-slate-500">Notes are visible to anyone who can manage privacy requests and are shown only on this request; they are never copied into the audit trail.</p>
      </div>
    </Modal>
  );
}

function RequestDetailModal({ id, onClose }: { id: string | null; onClose: () => void }) {
  const request = usePrivacyRequest(id);
  const { update } = usePrivacyMutations();
  const [error, setError] = useState<string | null>(null);
  const data = request.data;
  const closed = data ? isClosed(data.status) : false;

  const changeStatus = async (status: PrivacyRequestStatus) => {
    if (!id) return;
    setError(null);
    try {
      await update.mutateAsync({ id, input: { status } });
    } catch (err) {
      setError(err instanceof ApiClientError ? err.error.message : 'Something went wrong.');
    }
  };

  return (
    <Modal
      open={!!id}
      onClose={() => { setError(null); onClose(); }}
      title="Privacy request"
      description={data ? `${data.requestType.replace(/_/g, ' ')} · recorded ${formatDateTime(data.createdAt)}` : undefined}
      footer={<Button variant="secondary" onClick={() => { setError(null); onClose(); }}>Close</Button>}
    >
      {request.isLoading || !data ? (
        <LoadingBlock />
      ) : (
        <div className="space-y-4 text-sm">
          {error && <Alert>{error}</Alert>}
          <dl className="grid grid-cols-[9rem_1fr] gap-y-2">
            <dt className="text-slate-500">Data subject</dt><dd className="text-slate-800">{subjectLabel(data)}</dd>
            <dt className="text-slate-500">Status</dt><dd><StatusBadge status={data.status} /></dd>
            <dt className="text-slate-500">Received</dt><dd className="text-slate-800">{formatDateTime(data.requestedAt)}</dd>
            <dt className="text-slate-500">Due</dt><dd className="text-slate-800">{formatDate(data.dueAt)}</dd>
            <dt className="text-slate-500">Completed</dt><dd className="text-slate-800">{formatDateTime(data.completedAt)}</dd>
            <dt className="text-slate-500">Recorded by</dt><dd className="text-slate-800">{data.createdBy?.email ?? '—'}</dd>
            <dt className="text-slate-500">Assigned to</dt><dd className="text-slate-800">{data.assignedTo?.email ?? '—'}</dd>
          </dl>

          {data.notes && (
            <div>
              <div className="text-slate-500">Notes</div>
              <p className="mt-1 whitespace-pre-wrap rounded-md bg-slate-50 p-3 text-slate-800">{data.notes}</p>
            </div>
          )}

          {closed ? (
            <p className="text-xs text-slate-500">
              This request is {data.status.toLowerCase()} and can no longer be changed. Record a new request if the data subject comes back — each decision keeps its own history.
            </p>
          ) : (
            <div className="flex flex-wrap gap-2 border-t border-slate-200 pt-4">
              {data.status === 'OPEN' && <Button variant="secondary" loading={update.isPending} onClick={() => changeStatus('IN_PROGRESS')}>Start working on it</Button>}
              <Button loading={update.isPending} onClick={() => changeStatus('COMPLETED')}>Mark completed</Button>
              <Button variant="danger" loading={update.isPending} onClick={() => changeStatus('REJECTED')}>Reject</Button>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
