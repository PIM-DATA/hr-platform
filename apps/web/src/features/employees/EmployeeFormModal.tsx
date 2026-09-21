import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { EMPLOYMENT_TYPES, createEmployeeSchema, updateEmployeeProfileSchema, type EmployeeDetail, type EmployeeSelectorOption } from '@hr/shared';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Alert } from '@/components/ui/Alert';
import { useToast } from '@/components/ui/Toast';
import { errorMessage } from '@/features/organization/shared';
import { AssignmentPicker, type AssignmentValue } from './AssignmentPicker';
import { EmployeeSelect } from './EmployeeSelect';
import { useEmployeeMutations } from './employees.api';

// Form values are strings (dates from <input type=date>); zod coerces on submit.
const profileFields = { employeeCode: '', firstName: '', lastName: '', nickname: '', email: '', phone: '', hireDate: '', employmentType: 'FULL_TIME' as string };
type FormValues = typeof profileFields;
const formSchema = createEmployeeSchema.omit({ positionId: true, managerId: true });

const TYPE_OPTIONS = EMPLOYMENT_TYPES.map((t) => ({ value: t, label: t.replace('_', ' ') }));

interface Props {
  open: boolean;
  onClose: () => void;
  /** Present → edit profile only (assignment changes have dedicated flows on the detail page). */
  employee?: EmployeeDetail | null;
  onCreated?: (id: string) => void;
}

export function EmployeeFormModal({ open, onClose, employee, onCreated }: Props) {
  const isEdit = !!employee;
  const { create, updateProfile } = useEmployeeMutations();
  const toast = useToast();
  const [serverError, setServerError] = useState<string | null>(null);
  const [assignment, setAssignment] = useState<AssignmentValue>({ organizationId: '', departmentId: '', positionId: '' });
  const [manager, setManager] = useState<EmployeeSelectorOption | null>(null);
  const [assignmentError, setAssignmentError] = useState<string | undefined>();

  const form = useForm<FormValues, unknown, z.output<typeof formSchema>>({ resolver: zodResolver(formSchema as unknown as z.ZodType<z.output<typeof formSchema>, FormValues>), defaultValues: profileFields });

  useEffect(() => {
    if (!open) return;
    setServerError(null);
    setAssignmentError(undefined);
    setAssignment({ organizationId: '', departmentId: '', positionId: '' });
    setManager(null);
    form.reset(employee ? {
      employeeCode: employee.employeeCode, firstName: employee.firstName, lastName: employee.lastName, nickname: employee.nickname ?? '', email: employee.email,
      phone: employee.phone ?? '', hireDate: employee.hireDate.slice(0, 10), employmentType: employee.employmentType,
    } : profileFields);
  }, [open, employee, form]);

  const onSubmit = form.handleSubmit(async (values) => {
    setServerError(null);
    const profile = { ...values, nickname: values.nickname || null, phone: values.phone || null };
    try {
      if (isEdit && employee) {
        await updateProfile.mutateAsync({ id: employee.id, input: updateEmployeeProfileSchema.parse(profile) });
        toast.success('Profile updated');
      } else {
        if (!assignment.positionId) { setAssignmentError('Position is required'); return; }
        const created = await create.mutateAsync({ ...profile, positionId: assignment.positionId, managerId: manager?.id ?? null });
        toast.success('Employee created', `${created.employeeCode} · ${created.firstName} ${created.lastName}`);
        onCreated?.(created.id);
      }
      onClose();
    } catch (err) {
      setServerError(errorMessage(err));
    }
  });
  const busy = form.formState.isSubmitting;
  const err = form.formState.errors;

  return (
    <Modal open={open} onClose={onClose} size="lg" title={isEdit ? 'Edit employee profile' : 'New employee'} description={isEdit ? `${employee?.employeeCode} — assignment changes are made from the Employment tab` : 'Profile and initial assignment. Department and organization are derived from the position.'}
      footer={<><Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button><Button onClick={onSubmit} loading={busy}>{isEdit ? 'Save' : 'Create employee'}</Button></>}>
      <form onSubmit={onSubmit} noValidate className="space-y-6">
        {serverError && <Alert>{serverError}</Alert>}

        <section className="space-y-4">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Profile</h3>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Input label="Employee code" required placeholder="EMP001" error={err.employeeCode?.message} {...form.register('employeeCode')} />
            <Input label="First name" required error={err.firstName?.message} {...form.register('firstName')} />
            <Input label="Last name" required error={err.lastName?.message} {...form.register('lastName')} />
            <Input label="Nickname" error={err.nickname?.message} {...form.register('nickname')} />
            <Input label="Email" type="email" required error={err.email?.message} {...form.register('email')} />
            <Input label="Phone" error={err.phone?.message} {...form.register('phone')} />
            <Input label="Hire date" type="date" required error={err.hireDate?.message} {...form.register('hireDate')} />
            <Select label="Employment type" required options={TYPE_OPTIONS} error={err.employmentType?.message} {...form.register('employmentType')} />
          </div>
        </section>

        {!isEdit && (
          <section className="space-y-4">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Initial assignment</h3>
            <AssignmentPicker value={assignment} onChange={(v) => { setAssignment(v); setAssignmentError(undefined); }} positionError={assignmentError} />
            <EmployeeSelect label="Manager (optional)" value={manager} onChange={setManager} />
          </section>
        )}
      </form>
    </Modal>
  );
}
