import { useEffect, useState } from 'react';
import { ArrowRight } from 'lucide-react';
import type { EmployeeDetail } from '@hr/shared';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Alert } from '@/components/ui/Alert';
import { useToast } from '@/components/ui/Toast';
import { errorMessage } from '@/features/organization/shared';
import { usePositions } from '@/features/organization/organization.api';
import { AssignmentPicker, type AssignmentValue } from './AssignmentPicker';
import { localToday } from '@/lib/format';
import { useEmployeeMutations } from './employees.api';

export function ChangePositionModal({ open, onClose, employee }: { open: boolean; onClose: () => void; employee: EmployeeDetail }) {
  const { changePosition } = useEmployeeMutations();
  const toast = useToast();
  const [value, setValue] = useState<AssignmentValue>({ organizationId: '', departmentId: '', positionId: '' });
  const [effectiveDate, setEffectiveDate] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const positions = usePositions({ departmentId: value.departmentId || undefined, status: 'active', pageSize: 100 });
  const target = positions.data?.data.find((p) => p.id === value.positionId);

  useEffect(() => {
    if (!open) return;
    setValue({ organizationId: employee.organization.id, departmentId: employee.department.id, positionId: '' });
    setEffectiveDate(localToday());
    setConfirming(false);
    setServerError(null);
  }, [open, employee]);

  const submit = async () => {
    setServerError(null);
    try {
      await changePosition.mutateAsync({ id: employee.id, input: { positionId: value.positionId, effectiveDate: effectiveDate ? new Date(effectiveDate) : undefined } });
      toast.success('Position changed', `${employee.employeeCode} → ${target?.title}`);
      onClose();
    } catch (err) {
      setServerError(errorMessage(err));
      setConfirming(false);
    }
  };
  const same = value.positionId === employee.position.id;

  return (
    <Modal open={open} onClose={onClose} title="Change position" description={`${employee.employeeCode} · ${employee.firstName} ${employee.lastName}`} size="lg"
      footer={
        confirming ? (
          <><Button variant="secondary" onClick={() => setConfirming(false)} disabled={changePosition.isPending}>Back</Button><Button onClick={submit} loading={changePosition.isPending}>Confirm change</Button></>
        ) : (
          <><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={() => setConfirming(true)} disabled={!value.positionId || same}>Review change</Button></>
        )
      }>
      <div className="space-y-5">
        {serverError && <Alert>{serverError}</Alert>}
        {employee.headOfDepartments.length > 0 && (
          <Alert tone="info">This employee heads {employee.headOfDepartments.map((d) => d.name).join(', ')}. Moving to another department requires clearing the department head first.</Alert>
        )}
        {!confirming ? (
          <>
            <AssignmentPicker value={value} onChange={setValue} />
            {same && <p className="text-xs text-amber-600">This is already the current position.</p>}
            <Input label="Effective date" type="date" value={effectiveDate} onChange={(e) => setEffectiveDate(e.target.value)} hint="Closes the current position history at this date and starts the new one." />
          </>
        ) : (
          <div className="grid grid-cols-1 items-center gap-3 sm:grid-cols-[1fr_auto_1fr]">
            <Summary label="Current" title={employee.position.title} dept={employee.department.name} org={employee.organization.name} />
            <ArrowRight className="mx-auto h-5 w-5 text-slate-400" />
            <Summary label="New" title={target?.title ?? ''} dept={target?.department.name ?? ''} org={target?.department.organization.name ?? ''} highlight />
            <p className="text-xs text-slate-500 sm:col-span-3">Effective {effectiveDate}. History will be recorded and this action is audited.</p>
          </div>
        )}
      </div>
    </Modal>
  );
}

function Summary({ label, title, dept, org, highlight }: { label: string; title: string; dept: string; org: string; highlight?: boolean }) {
  return (
    <div className={`rounded-md border p-3 ${highlight ? 'border-brand-300 bg-brand-50' : 'border-slate-200 bg-slate-50'}`}>
      <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-1 font-medium text-slate-900">{title}</div>
      <div className="text-xs text-slate-600">{dept} · {org}</div>
    </div>
  );
}
