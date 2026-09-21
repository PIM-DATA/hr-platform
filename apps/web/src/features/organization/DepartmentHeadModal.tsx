import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { DepartmentDto, EmployeeSelectorOption } from '@hr/shared';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Alert';
import { useToast } from '@/components/ui/Toast';
import { api } from '@/lib/api-client';
import { EmployeeSelect } from '@/features/employees/EmployeeSelect';
import { errorMessage } from './shared';

/** Set / change / clear the department head (organization.manage). Candidates are active employees of this department. */
export function DepartmentHeadModal({ open, onClose, department }: { open: boolean; onClose: () => void; department: DepartmentDto | null }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [head, setHead] = useState<EmployeeSelectorOption | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: ({ id, employeeId }: { id: string; employeeId: string | null }) => api.patch<DepartmentDto>(`/departments/${id}/head`, { employeeId }).then((r) => r.data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['organization'] }); qc.invalidateQueries({ queryKey: ['employees'] }); },
  });

  useEffect(() => { if (open) { setHead(null); setServerError(null); } }, [open]);
  if (!department) return null;

  const apply = async (employeeId: string | null) => {
    setServerError(null);
    try {
      await mutation.mutateAsync({ id: department.id, employeeId });
      toast.success(employeeId ? 'Department head updated' : 'Department head cleared', department.name);
      onClose();
    } catch (err) {
      setServerError(errorMessage(err));
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Department head" description={`${department.organization.name} · ${department.name}`}
      footer={
        <>
          {department.headEmployee && <Button variant="danger" onClick={() => apply(null)} loading={mutation.isPending}>Clear head</Button>}
          <div className="flex-1" />
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={() => head && apply(head.id)} disabled={!head} loading={mutation.isPending}>Set head</Button>
        </>
      }>
      <div className="space-y-4">
        {serverError && <Alert>{serverError}</Alert>}
        <div className="rounded-md bg-slate-50 p-3 text-sm">
          <span className="text-slate-500">Current head: </span>
          {department.headEmployee ? <span className="font-medium text-slate-900">{department.headEmployee.firstName} {department.headEmployee.lastName} <span className="font-mono text-xs text-slate-500">{department.headEmployee.employeeCode}</span></span> : <span className="text-slate-400">none</span>}
        </div>
        <EmployeeSelect label="New head" value={head} onChange={setHead} departmentId={department.id} placeholder="Search active employees of this department…" />
        <p className="text-xs text-slate-500">Department head is separate from the manager relationship — setting it does not change anyone's manager.</p>
      </div>
    </Modal>
  );
}
