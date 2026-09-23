import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Laptop, ShieldCheck } from 'lucide-react';
import { changeOwnPasswordSchema, PASSWORD_MIN_LENGTH, type ChangeOwnPasswordInput } from '@hr/shared';
import { PageHeader } from '@/components/layout/PageHeader';
import { Card, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Alert } from '@/components/ui/Alert';
import { LoadingBlock } from '@/components/ui/Spinner';
import { useToast } from '@/components/ui/Toast';
import { useAuth } from '@/hooks/useAuth';
import { setLoginNotice } from '@/features/auth/login-notice';
import { ApiClientError } from '@/lib/api-client';
import { formatDateTime } from '@/lib/format';
import { useAccountMutations, useMySessions } from './account.api';

/** Self-service account security: change your password, see where you are signed in, sign other devices out. */
export function AccountSecurityPage() {
  return (
    <>
      <PageHeader title="Account security" description="Your password and the devices signed in to this account." />
      <div className="grid gap-6 lg:grid-cols-2">
        <ChangePasswordCard />
        <SessionsCard />
      </div>
    </>
  );
}

function ChangePasswordCard() {
  const { logout } = useAuth();
  const navigate = useNavigate();
  const { changePassword } = useAccountMutations();
  const [serverError, setServerError] = useState<string | null>(null);
  const form = useForm<ChangeOwnPasswordInput>({ resolver: zodResolver(changeOwnPasswordSchema), defaultValues: { currentPassword: '', newPassword: '' } });

  const onSubmit = form.handleSubmit(async (values) => {
    setServerError(null);
    try {
      await changePassword.mutateAsync(values);
      // Changing the password signs every session out, including this one. Dropping the session makes RequireAuth
      // redirect on its own, and that redirect can win the race with this navigate() — so the message is handed over
      // through sessionStorage (a UI string, never anything auth-related) instead of router state.
      setLoginNotice('Your password has been changed. Please sign in again.');
      await logout().catch(() => undefined);
      navigate('/login', { replace: true });
    } catch (err) {
      setServerError(err instanceof ApiClientError ? err.error.message : 'Something went wrong.');
    }
  });

  return (
    <Card>
      <CardHeader title="Change password" description={`At least ${PASSWORD_MIN_LENGTH} characters.`} />
      <form onSubmit={onSubmit} noValidate className="space-y-4 p-5">
        {serverError && <Alert>{serverError}</Alert>}
        <Input label="Current password" type="password" required autoComplete="current-password" error={form.formState.errors.currentPassword?.message} {...form.register('currentPassword')} />
        <Input label="New password" type="password" required autoComplete="new-password" error={form.formState.errors.newPassword?.message} {...form.register('newPassword')} />
        <p className="flex items-start gap-2 text-xs text-slate-500">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />
          You will be signed out on every device, including this one, and will need to sign in again with the new password.
        </p>
        <Button type="submit" loading={form.formState.isSubmitting}>Change password</Button>
      </form>
    </Card>
  );
}

function SessionsCard() {
  const sessions = useMySessions();
  const { revokeOtherSessions } = useAccountMutations();
  const toast = useToast();
  const [error, setError] = useState<string | null>(null);
  const others = (sessions.data ?? []).filter((s) => !s.current).length;

  const onRevoke = async () => {
    setError(null);
    try {
      const { revoked } = await revokeOtherSessions.mutateAsync();
      toast.success(revoked === 1 ? '1 other session signed out' : `${revoked} other sessions signed out`);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.error.message : 'Something went wrong.');
    }
  };

  return (
    <Card>
      <CardHeader title="Signed-in devices" description="Sessions expire on their own; sign them out here if something looks unfamiliar." />
      <div className="p-5">
        {error && <Alert className="mb-4">{error}</Alert>}
        {sessions.isLoading ? (
          <LoadingBlock />
        ) : sessions.isError ? (
          <Alert>Could not load your sessions.</Alert>
        ) : (
          <ul className="divide-y divide-slate-100">
            {(sessions.data ?? []).map((s) => (
              <li key={s.id} className="flex items-start gap-3 py-3 first:pt-0">
                <Laptop className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm text-slate-800">{s.ipAddress ?? 'Unknown address'}</span>
                    {s.current && <span className="rounded-full bg-brand-50 px-2 py-0.5 text-xs font-medium text-brand-700 ring-1 ring-inset ring-brand-600/20">This device</span>}
                  </div>
                  <p className="truncate text-xs text-slate-500" title={s.userAgent ?? undefined}>{s.userAgent ?? 'Unknown browser'}</p>
                  <p className="text-xs text-slate-400">Signed in {formatDateTime(s.createdAt)} · expires {formatDateTime(s.expiresAt)}</p>
                </div>
              </li>
            ))}
          </ul>
        )}
        <Button variant="secondary" className="mt-4" disabled={others === 0} loading={revokeOtherSessions.isPending} onClick={onRevoke}>
          Sign out other devices
        </Button>
      </div>
    </Card>
  );
}
