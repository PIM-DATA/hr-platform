import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { createJobSchema, type JobDto } from '@hr/shared';

// form uses input type (level arrives as string from <input type=number>); zod coerces before submit
type JobFormValues = z.input<typeof createJobSchema>;
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/Textarea';
import { Alert } from '@/components/ui/Alert';
import { useOrgMutations } from './organization.api';
import { errorMessage } from './shared';

export function JobFormModal({ open, onClose, job }: { open: boolean; onClose: () => void; job?: JobDto | null }) {
  const isEdit = !!job;
  const { create, update } = useOrgMutations<JobDto>('jobs');
  const [serverError, setServerError] = useState<string | null>(null);
  const form = useForm<JobFormValues, unknown, z.output<typeof createJobSchema>>({ resolver: zodResolver(createJobSchema), defaultValues: { code: '', title: '', level: 1, description: '' } });

  useEffect(() => {
    if (!open) return;
    setServerError(null);
    form.reset({ code: job?.code ?? '', title: job?.title ?? '', level: job?.level ?? 1, description: job?.description ?? '' });
  }, [open, job, form]);

  const onSubmit = form.handleSubmit(async (values) => {
    setServerError(null);
    const input = { ...values, description: values.description || null };
    try {
      if (isEdit) await update.mutateAsync({ id: job!.id, input });
      else await create.mutateAsync(input);
      onClose();
    } catch (err) {
      setServerError(errorMessage(err));
    }
  });
  const busy = form.formState.isSubmitting;

  return (
    <Modal open={open} onClose={onClose} title={isEdit ? 'Edit job' : 'New job'} size="sm"
      footer={<><Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button><Button onClick={onSubmit} loading={busy}>{isEdit ? 'Save' : 'Create'}</Button></>}>
      <form onSubmit={onSubmit} noValidate className="space-y-4">
        {serverError && <Alert>{serverError}</Alert>}
        <Input label="Code" required placeholder="e.g. DA" hint="Unique across all jobs." error={form.formState.errors.code?.message} {...form.register('code')} />
        <Input label="Title" required placeholder="e.g. Data Analyst" error={form.formState.errors.title?.message} {...form.register('title')} />
        <Input label="Level" type="number" min={1} max={99} required error={form.formState.errors.level?.message} {...form.register('level')} />
        <Textarea label="Description" placeholder="What this job does…" error={form.formState.errors.description?.message} {...form.register('description')} />
      </form>
    </Modal>
  );
}
