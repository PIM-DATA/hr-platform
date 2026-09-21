import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { createPositionSchema, type CreatePositionInput, type PositionDto } from '@hr/shared';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Alert } from '@/components/ui/Alert';
import { useDepartmentOptions, useJobOptions, useOrgMutations, useOrganizationOptions } from './organization.api';
import { errorMessage } from './shared';

interface Props {
  open: boolean;
  onClose: () => void;
  position?: PositionDto | null;
  defaults?: { organizationId?: string; departmentId?: string };
}

export function PositionFormModal({ open, onClose, position, defaults }: Props) {
  const isEdit = !!position;
  const { create, update } = useOrgMutations<PositionDto>('positions');
  const [serverError, setServerError] = useState<string | null>(null);
  const [organizationId, setOrganizationId] = useState('');
  const form = useForm<CreatePositionInput>({ resolver: zodResolver(createPositionSchema), defaultValues: { departmentId: '', jobId: '', code: '', title: '' } });
  const organizations = useOrganizationOptions();
  const departments = useDepartmentOptions(organizationId || undefined);
  const jobs = useJobOptions();

  useEffect(() => {
    if (!open) return;
    setServerError(null);
    setOrganizationId(position?.department.organization.id ?? defaults?.organizationId ?? '');
    form.reset({ departmentId: position?.department.id ?? defaults?.departmentId ?? '', jobId: position?.job?.id ?? '', code: position?.code ?? '', title: position?.title ?? '' });
  }, [open, position, defaults, form]);

  const onSubmit = form.handleSubmit(async (values) => {
    setServerError(null);
    try {
      if (isEdit) await update.mutateAsync({ id: position!.id, input: values });
      else await create.mutateAsync(values);
      onClose();
    } catch (err) {
      setServerError(errorMessage(err));
    }
  });
  const busy = form.formState.isSubmitting;

  return (
    <Modal open={open} onClose={onClose} title={isEdit ? 'Edit position' : 'New position'} description={isEdit ? position?.code : undefined}
      footer={<><Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button><Button onClick={onSubmit} loading={busy}>{isEdit ? 'Save' : 'Create'}</Button></>}>
      <form onSubmit={onSubmit} noValidate className="space-y-4">
        {serverError && <Alert>{serverError}</Alert>}
        <Select label="Organization" options={(organizations.data?.data ?? []).map((o) => ({ value: o.id, label: `${o.code} — ${o.name}` }))} placeholder="Select organization…"
          value={organizationId} onChange={(e) => { setOrganizationId(e.target.value); form.setValue('departmentId', ''); }} />
        <Select label="Department" required disabled={!organizationId} options={(departments.data?.data ?? []).map((d) => ({ value: d.id, label: `${d.code} — ${d.name}` }))} placeholder="Select department…"
          error={form.formState.errors.departmentId?.message} {...form.register('departmentId')} />
        <Select label="Job" required options={(jobs.data?.data ?? []).map((j) => ({ value: j.id, label: `${j.code} — ${j.title} (L${j.level})` }))} placeholder="Select job…"
          error={form.formState.errors.jobId?.message} {...form.register('jobId')} />
        <Input label="Code" required placeholder="e.g. POS-DATA-ANALYST" hint="Unique across all positions." error={form.formState.errors.code?.message} {...form.register('code')} />
        <Input label="Title" required placeholder="e.g. Senior Data Analyst" error={form.formState.errors.title?.message} {...form.register('title')} />
      </form>
    </Modal>
  );
}
