import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { createOrganizationSchema, isValidTimezone, type CreateOrganizationInput, type OrganizationDto } from '@hr/shared';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Alert } from '@/components/ui/Alert';
import { useOrgMutations } from './organization.api';
import { errorMessage } from './shared';

export function OrganizationFormModal({ open, onClose, organization }: { open: boolean; onClose: () => void; organization?: OrganizationDto | null }) {
  const isEdit = !!organization;
  const { create, update } = useOrgMutations<OrganizationDto>('organizations');
  const [serverError, setServerError] = useState<string | null>(null);
  const [timezone, setTimezone] = useState('Asia/Bangkok');
  const form = useForm<CreateOrganizationInput>({ resolver: zodResolver(createOrganizationSchema), defaultValues: { code: '', name: '' } });

  useEffect(() => {
    if (!open) return;
    setServerError(null);
    form.reset({ code: organization?.code ?? '', name: organization?.name ?? '' });
    setTimezone(organization?.timezone ?? 'Asia/Bangkok');
  }, [open, organization, form]);

  const onSubmit = form.handleSubmit(async (values) => {
    setServerError(null);
    try {
      if (isEdit) {
        if (!isValidTimezone(timezone)) { setServerError('Timezone must be an IANA name such as Asia/Bangkok'); return; }
        await update.mutateAsync({ id: organization!.id, input: { ...values, timezone } });
      }
      else await create.mutateAsync(values);
      onClose();
    } catch (err) {
      setServerError(errorMessage(err));
    }
  });
  const busy = form.formState.isSubmitting;

  return (
    <Modal open={open} onClose={onClose} title={isEdit ? 'Edit organization' : 'New organization'} size="sm"
      footer={<><Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button><Button onClick={onSubmit} loading={busy}>{isEdit ? 'Save' : 'Create'}</Button></>}>
      <form onSubmit={onSubmit} noValidate className="space-y-4">
        {serverError && <Alert>{serverError}</Alert>}
        <Input label="Code" required placeholder="e.g. HQ" hint="Unique across all organizations. Upper-cased automatically." error={form.formState.errors.code?.message} {...form.register('code')} />
        <Input label="Name" required placeholder="e.g. Head Office" error={form.formState.errors.name?.message} {...form.register('name')} />
        {isEdit && <Input label="Timezone" required value={timezone} onChange={(e) => setTimezone(e.target.value)} placeholder="Asia/Bangkok" hint="IANA name — source of truth for this organization's business dates." />}
      </form>
    </Modal>
  );
}
