import { useEffect, useState } from 'react';
import type { EmployeeDetail, EmployeeSelectorOption } from '@hr/shared';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Alert';
import { useToast } from '@/components/ui/Toast';
import { errorMessage } from '@/features/organization/shared';
import { EmployeeSelect } from './EmployeeSelect';
import { useEmployeeMutations } from './employees.api';

export function ChangeManagerModal({ open, onClose, employee }: { open: boolean; onClose: () => void; employee: EmployeeDetail }) {
  const { changeManager } = useEmployeeMutations();
  const toast = useToast();
  const [manager, setManager] = useState<EmployeeSelectorOption | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);

  useEffect(() => {
    if (open) { setManager(null); setServerError(null); }
  }, [open]);

  const apply = async (managerId: string | null) => {
    setServerError(null);
    try {
      await changeManager.mutateAsync({ id: employee.id, input: { managerId } });
      toast.success(managerId ? 'Manager changed' : 'Manager cleared');
      onClose();
    } catch (err) {
      setServerError(errorMessage(err));
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Change manager" description={`${employee.employeeCode} · ${employee.firstName} ${employee.lastName}`}
      footer={
        <>
          {employee.manager && <Button variant="danger" onClick={() => apply(null)} loading={changeManager.isPending}>Clear manager</Button>}
          <div className="flex-1" />
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={() => manager && apply(manager.id)} disabled={!manager} loading={changeManager.isPending}>Assign</Button>
        </>
      }>
      <div className="space-y-4">
        {serverError && <Alert>{serverError}</Alert>}
        <div className="rounded-md bg-slate-50 p-3 text-sm">
          <span className="text-slate-500">Current manager: </span>
          {employee.manager ? <span className="font-medium text-slate-900">{employee.manager.firstName} {employee.manager.lastName} <span className="font-mono text-xs text-slate-500">{employee.manager.employeeCode}</span></span> : <span className="text-slate-400">none</span>}
        </div>
        <EmployeeSelect label="New manager" value={manager} onChange={setManager} excludeId={employee.id} />
        <p className="text-xs text-slate-500">Managers may be in any department. The server rejects self-management and cycles in the reporting line.</p>
      </div>
    </Modal>
  );
}
