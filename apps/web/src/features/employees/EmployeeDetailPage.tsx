import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Briefcase, Pencil, UserCog, UserCheck, UserX, Users } from 'lucide-react';
import { PERMISSIONS, type EmployeeDetail } from '@hr/shared';
import { PageHeader } from '@/components/layout/PageHeader';
import { Card, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { Alert } from '@/components/ui/Alert';
import { LoadingBlock } from '@/components/ui/Spinner';
import { EmptyState } from '@/components/ui/EmptyState';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { useToast } from '@/components/ui/Toast';
import { PermissionGuard } from '@/components/guards/PermissionGuard';
import { usePermission } from '@/hooks/usePermission';
import { formatDate, formatDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { errorMessage } from '@/features/organization/shared';
import { useDirectReports, useEmployee, useEmployeeMutations, useManagerHistory, usePositionHistory } from './employees.api';
import { EmployeeFormModal } from './EmployeeFormModal';
import { ChangePositionModal } from './ChangePositionModal';
import { ChangeManagerModal } from './ChangeManagerModal';

type Tab = 'overview' | 'employment' | 'positions' | 'managers';
const TABS: { key: Tab; label: string }[] = [
  { key: 'overview', label: 'Overview' },
  { key: 'employment', label: 'Employment' },
  { key: 'positions', label: 'Position history' },
  { key: 'managers', label: 'Manager history' },
];

export function EmployeeDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const employee = useEmployee(id);
  const [tab, setTab] = useState<Tab>('overview');
  const [editOpen, setEditOpen] = useState(false);
  const [positionOpen, setPositionOpen] = useState(false);
  const [managerOpen, setManagerOpen] = useState(false);
  const [statusConfirm, setStatusConfirm] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  const canUpdate = usePermission(PERMISSIONS.EMPLOYEES_UPDATE);
  const canActivate = usePermission(PERMISSIONS.EMPLOYEES_ACTIVATE);
  const { activate, deactivate } = useEmployeeMutations();
  const toast = useToast();

  if (employee.isLoading) return <LoadingBlock />;
  if (employee.isError || !employee.data) {
    return (
      <Card className="mt-4">
        <EmptyState title="Employee not found" description="This employee does not exist or is outside your data scope." action={<Button variant="secondary" onClick={() => navigate('/employees')}>Back to employees</Button>} />
      </Card>
    );
  }
  const e = employee.data;
  const isActive = e.employmentStatus === 'ACTIVE';

  const toggleStatus = async () => {
    setStatusError(null);
    try {
      await (isActive ? deactivate : activate).mutateAsync(e.id);
      toast.success(isActive ? 'Employee deactivated' : 'Employee activated', isActive && e.account ? 'The linked user account remains active.' : undefined);
      setStatusConfirm(false);
    } catch (err) {
      setStatusError(errorMessage(err));
    }
  };

  return (
    <>
      <Link to="/employees" className="mb-3 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800"><ArrowLeft className="h-4 w-4" /> Employees</Link>
      <PageHeader
        title={`${e.firstName} ${e.lastName}`}
        description={`${e.employeeCode} · ${e.position.title} · ${e.department.name}`}
        actions={
          <>
            <StatusBadge status={e.employmentStatus} className="self-center" />
            {canUpdate && <Button variant="secondary" onClick={() => setEditOpen(true)}><Pencil className="h-4 w-4" /> Edit profile</Button>}
            {canActivate && (
              isActive ? <Button variant="danger" onClick={() => setStatusConfirm(true)}><UserX className="h-4 w-4" /> Deactivate</Button>
                       : <Button onClick={() => setStatusConfirm(true)}><UserCheck className="h-4 w-4" /> Activate</Button>
            )}
          </>
        }
      />

      <div className="mb-5 -mb-px flex gap-1 overflow-x-auto border-b border-slate-200">
        {TABS.map((t) => (
          <button key={t.key} onClick={() => setTab(t.key)} className={cn('whitespace-nowrap border-b-2 px-3 py-2.5 text-sm font-medium', tab === t.key ? 'border-brand-600 text-brand-700' : 'border-transparent text-slate-500 hover:text-slate-700')}>{t.label}</button>
        ))}
      </div>

      {tab === 'overview' && <OverviewTab e={e} />}
      {tab === 'employment' && <EmploymentTab e={e} onChangePosition={() => setPositionOpen(true)} onChangeManager={() => setManagerOpen(true)} />}
      {tab === 'positions' && <PositionHistoryTab id={e.id} />}
      {tab === 'managers' && <ManagerHistoryTab id={e.id} />}

      {canUpdate && (
        <>
          <EmployeeFormModal open={editOpen} onClose={() => setEditOpen(false)} employee={e} />
          <ChangePositionModal open={positionOpen} onClose={() => setPositionOpen(false)} employee={e} />
          <ChangeManagerModal open={managerOpen} onClose={() => setManagerOpen(false)} employee={e} />
        </>
      )}
      <ConfirmDialog open={statusConfirm} title={isActive ? 'Deactivate employee' : 'Activate employee'}
        message={isActive ? `${e.employeeCode} will be marked INACTIVE. This does not change any linked user account; use User management for that.` : `${e.employeeCode} will become ACTIVE again. The current position and manager must be active.`}
        confirmLabel={isActive ? 'Deactivate' : 'Activate'} variant={isActive ? 'danger' : 'primary'} loading={activate.isPending || deactivate.isPending} error={statusError}
        onConfirm={toggleStatus} onCancel={() => { setStatusConfirm(false); setStatusError(null); }} />
    </>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="mt-0.5 text-sm text-slate-900">{children ?? '—'}</dd>
    </div>
  );
}

function OverviewTab({ e }: { e: EmployeeDetail }) {
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
      <Card className="lg:col-span-2">
        <CardHeader title="Profile" />
        <dl className="grid grid-cols-1 gap-4 px-5 py-4 sm:grid-cols-2">
          <Field label="Employee code"><span className="font-mono">{e.employeeCode}</span></Field>
          <Field label="Status"><StatusBadge status={e.employmentStatus} /></Field>
          <Field label="Name">{e.firstName} {e.lastName}</Field>
          <Field label="Nickname">{e.nickname}</Field>
          <Field label="Email">{e.email}</Field>
          <Field label="Phone">{e.phone}</Field>
          <Field label="Created">{formatDateTime(e.createdAt)}</Field>
          <Field label="Updated">{formatDateTime(e.updatedAt)}</Field>
        </dl>
      </Card>
      <div className="space-y-4">
        <Card>
          <CardHeader title="At a glance" />
          <dl className="space-y-4 px-5 py-4">
            <Field label="Direct reports"><span className="inline-flex items-center gap-1.5"><Users className="h-4 w-4 text-slate-400" />{e.directReportCount}</span></Field>
            <Field label="Head of department">{e.headOfDepartments.length ? e.headOfDepartments.map((d) => d.name).join(', ') : 'No'}</Field>
          </dl>
        </Card>
        {e.account !== undefined && (
          <PermissionGuard permission={PERMISSIONS.USERS_VIEW}>
            <Card>
              <CardHeader title="User account" description="Account status is independent of employment status." />
              <dl className="space-y-4 px-5 py-4">
                {e.account ? (
                  <>
                    <Field label="Login email">{e.account.email}</Field>
                    <Field label="Account status"><StatusBadge status={e.account.isActive ? 'ACTIVE' : 'INACTIVE'} /></Field>
                    <Field label="Last login">{formatDateTime(e.account.lastLoginAt)}</Field>
                    {e.employmentStatus !== 'ACTIVE' && e.account.isActive && <Alert tone="info">Employee is inactive but the account can still log in.</Alert>}
                  </>
                ) : (
                  <p className="text-sm text-slate-500">No login account linked. <Link to="/admin/users" className="text-brand-600 hover:underline">Manage users</Link></p>
                )}
              </dl>
            </Card>
          </PermissionGuard>
        )}
      </div>
    </div>
  );
}

function EmploymentTab({ e, onChangePosition, onChangeManager }: { e: EmployeeDetail; onChangePosition: () => void; onChangeManager: () => void }) {
  const reports = useDirectReports(e.id);
  const reportColumns: Column<EmployeeDetail['manager'] & { position: { title: string }; department: { name: string }; employmentStatus: string }>[] = [
    { key: 'code', header: 'Code', render: (r) => <span className="font-mono text-xs">{r!.employeeCode}</span> },
    { key: 'name', header: 'Name', render: (r) => <Link to={`/employees/${r!.id}`} className="font-medium text-brand-700 hover:underline">{r!.firstName} {r!.lastName}</Link> },
    { key: 'position', header: 'Position', hideBelow: 'sm', render: (r) => r.position.title },
    { key: 'department', header: 'Department', hideBelow: 'md', render: (r) => r.department.name },
    { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.employmentStatus} /> },
  ];
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
            <h2 className="text-sm font-semibold text-slate-900">Current position</h2>
            <PermissionGuard permission={PERMISSIONS.EMPLOYEES_UPDATE}><Button size="sm" variant="secondary" onClick={onChangePosition}><Briefcase className="h-4 w-4" /> Change position</Button></PermissionGuard>
          </div>
          <dl className="grid grid-cols-1 gap-4 px-5 py-4 sm:grid-cols-2">
            <Field label="Organization">{e.organization.name} <span className="font-mono text-xs text-slate-400">{e.organization.code}</span></Field>
            <Field label="Department">{e.department.name} <span className="font-mono text-xs text-slate-400">{e.department.code}</span></Field>
            <Field label="Position">{e.position.title} <span className="font-mono text-xs text-slate-400">{e.position.code}</span></Field>
            <Field label="Job">{e.job ? `${e.job.title} (L${e.job.level})` : null}</Field>
            <Field label="Hire date">{formatDate(e.hireDate)}</Field>
            <Field label="Employment type">{e.employmentType.replace('_', ' ')}</Field>
          </dl>
        </Card>
        <Card>
          <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
            <h2 className="text-sm font-semibold text-slate-900">Manager</h2>
            <PermissionGuard permission={PERMISSIONS.EMPLOYEES_UPDATE}><Button size="sm" variant="secondary" onClick={onChangeManager}><UserCog className="h-4 w-4" /> Change manager</Button></PermissionGuard>
          </div>
          <dl className="space-y-4 px-5 py-4">
            <Field label="Reports to">{e.manager ? <Link to={`/employees/${e.manager.id}`} className="text-brand-700 hover:underline">{e.manager.firstName} {e.manager.lastName} <span className="font-mono text-xs text-slate-400">{e.manager.employeeCode}</span></Link> : 'No manager'}</Field>
            <Field label="Head of department">{e.headOfDepartments.length ? e.headOfDepartments.map((d) => d.name).join(', ') : 'No'}</Field>
          </dl>
        </Card>
      </div>
      <Card>
        <CardHeader title={`Direct reports (${e.directReportCount})`} description="Only employees within your data scope are listed." />
        <DataTable columns={reportColumns as never} rows={(reports.data ?? []) as never[]} rowKey={(r: { id: string }) => r.id} loading={reports.isLoading} emptyTitle="No direct reports" />
      </Card>
    </div>
  );
}

function PositionHistoryTab({ id }: { id: string }) {
  const history = usePositionHistory(id);
  return (
    <Card>
      <CardHeader title="Position history" description="Newest first. The open row (no end date) is the current assignment." />
      {history.isError && <Alert className="m-4">Could not load history.</Alert>}
      <DataTable
        columns={[
          { key: 'position', header: 'Position', render: (h) => <span className="font-medium text-slate-900">{h.position.title} <span className="font-mono text-xs text-slate-400">{h.position.code}</span></span> },
          { key: 'department', header: 'Department', hideBelow: 'sm', render: (h) => h.department.name },
          { key: 'org', header: 'Organization', hideBelow: 'md', render: (h) => h.organization.name },
          { key: 'start', header: 'Start', render: (h) => formatDate(h.startDate) },
          { key: 'end', header: 'End', render: (h) => (h.endDate ? formatDate(h.endDate) : <StatusBadge status="CURRENT" tone="success" />) },
        ]}
        rows={history.data ?? []} rowKey={(h) => h.id} loading={history.isLoading} emptyTitle="No position history" />
    </Card>
  );
}

function ManagerHistoryTab({ id }: { id: string }) {
  const history = useManagerHistory(id);
  return (
    <Card>
      <CardHeader title="Manager history" description="Newest first. The open row (no end date) is the current manager." />
      {history.isError && <Alert className="m-4">Could not load history.</Alert>}
      <DataTable
        columns={[
          { key: 'manager', header: 'Manager', render: (h) => <span className="font-medium text-slate-900">{h.manager.firstName} {h.manager.lastName} <span className="font-mono text-xs text-slate-400">{h.manager.employeeCode}</span></span> },
          { key: 'position', header: "Manager's position", hideBelow: 'sm', render: (h) => h.manager.position?.title ?? '—' },
          { key: 'start', header: 'Start', render: (h) => formatDate(h.startDate) },
          { key: 'end', header: 'End', render: (h) => (h.endDate ? formatDate(h.endDate) : <StatusBadge status="CURRENT" tone="success" />) },
        ]}
        rows={history.data ?? []} rowKey={(h) => h.id} loading={history.isLoading} emptyTitle="No manager history" emptyDescription="This employee has never had a manager assigned." />
    </Card>
  );
}
