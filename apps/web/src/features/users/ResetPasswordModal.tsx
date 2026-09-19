import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { resetPasswordSchema, type ResetPasswordInput, type UserDto } from '@hr/shared';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Alert } from '@/components/ui/Alert';
import { ApiClientError } from '@/lib/api-client';
import { useUserMutations } from './users.api';

export function ResetPasswordModal({ open, onClose, user }: { open: boolean; onClose: () => void; user: UserDto | null }) {
  const { resetPassword } = useUserMutations();
  const [serverError, setServerError] = useState<string | null>(null);
  const form = useForm<ResetPasswordInput>({ resolver: zodResolver(resetPasswordSchema), defaultValues: { password: '' } });

  useEffect(() => {
    if (open) {
      form.reset({ password: '' });
      setServerError(null);
    }
  }, [open, form]);

  const onSubmit = form.handleSubmit(async (values) => {
    if (!user) return;
    setServerError(null);
    try {
      await resetPassword.mutateAsync({ id: user.id, input: values });
      onClose();
    } catch (err) {
      setServerError(err instanceof ApiClientError ? err.error.message : 'Something went wrong.');
    }
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Reset password"
      description={user?.email}
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={onSubmit} loading={form.formState.isSubmitting}>Set password</Button>
        </>
      }
    >
      <form onSubmit={onSubmit} noValidate className="space-y-4">
        {serverError && <Alert>{serverError}</Alert>}
        <Input label="New temporary password" type="password" required autoComplete="new-password" error={form.formState.errors.password?.message} {...form.register('password')} />
        <p className="text-xs text-slate-500">All active sessions of this user will be signed out.</p>
      </form>
    </Modal>
  );
}
