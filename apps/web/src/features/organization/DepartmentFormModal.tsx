import { useEffect, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { createDepartmentSchema, type CreateDepartmentInput, type DepartmentDto } from '@hr/shared';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Alert } from '@/components/ui/Alert';
import { useDepartmentOptions, useOrgMutations, useOrganizationOptions } from './organization.api';
import { errorMessage } from './shared';

interface Props {
  open: boolean;
  onClose: () => void;
  department?: DepartmentDto | null;
  /** Pre-select organization / parent when opened from the tree. */
  defaults?: { organizationId?: string; parentId?: string | null };
}

export function DepartmentFormModal({ open, onClose, department, defaults }: Props) {
  const isEdit = !!department;
  const { create, update } = useOrgMutations<DepartmentDto>('departments');
  const [serverError, setServerError] = useState<string | null>(null);
  const form = useForm<CreateDepartmentInput>({ resolver: zodResolver(createDepartmentSchema), defaultValues: { organizationId: '', parentId: null, code: '', name: '' } });
  const organizationId = form.watch('organizationId');
  const organizations = useOrganizationOptions();
  const departments = useDepartmentOptions(organizationId || undefined);

  useEffect(() => {
    if (!open) return;
    setServerError(null);
    form.reset({
      organizationId: department?.organizationId ?? defaults?.organizationId ?? '',
      parentId: department?.parentId ?? defaults?.parentId ?? null,
      code: department?.code ?? '',
      name: department?.name ?? '',
    });
  }, [open, department, defaults, form]);

  // Parent options: same organization, excluding itself and its descendants (UX mirror of the API cycle check).
  const parentOptions = useMemo(() => {
    const all = departments.data?.data ?? [];
    if (!department) return all;
    const childrenOf = new Map<string | null, string[]>();
    for (const d of all) childrenOf.set(d.parentId, [...(childrenOf.get(d.parentId) ?? []), d.id]);
    const excluded = new Set<string>([department.id]);
    const stack = [department.id];
    while (stack.length) for (const c of childrenOf.get(stack.pop()!) ?? []) { excluded.add(c); stack.push(c); }
    return all.filter((d) => !excluded.has(d.id));
  }, [departments.data, department]);

  const onSubmit = form.handleSubmit(async (values) => {
    setServerError(null);
    try {
      if (isEdit) await update.mutateAsync({ id: department!.id, input: { parentId: values.parentId ?? null, code: values.code, name: values.name } });
      else await create.mutateAsync({ ...values, parentId: values.parentId ?? null });
      onClose();
    } catch (err) {
      setServerError(errorMessage(err));
    }
  });
  const busy = form.formState.isSubmitting;

  return (
    <Modal open={open} onClose={onClose} title={isEdit ? 'Edit department' : 'New department'} description={isEdit ? `${department?.organization.name} · ${department?.code}` : undefined}
      footer={<><Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button><Button onClick={onSubmit} loading={busy}>{isEdit ? 'Save' : 'Create'}</Button></>}>
      <form onSubmit={onSubmit} noValidate className="space-y-4">
        {serverError && <Alert>{serverError}</Alert>}
        <Select label="Organization" required disabled={isEdit} options={(organizations.data?.data ?? []).map((o) => ({ value: o.id, label: `${o.code} — ${o.name}` }))} placeholder="Select organization…"
          error={form.formState.errors.organizationId?.message} {...form.register('organizationId', { onChange: () => form.setValue('parentId', null) })} />
        <Select label="Parent department" options={parentOptions.map((d) => ({ value: d.id, label: `${d.code} — ${d.name}` }))} placeholder="— None (top level) —" disabled={!organizationId}
          value={form.watch('parentId') ?? ''} onChange={(e) => form.setValue('parentId', e.target.value || null)} />
        <Input label="Code" required placeholder="e.g. SALES" hint="Unique within the organization." error={form.formState.errors.code?.message} {...form.register('code')} />
        <Input label="Name" required placeholder="e.g. Sales" error={form.formState.errors.name?.message} {...form.register('name')} />
      </form>
    </Modal>
  );
}
