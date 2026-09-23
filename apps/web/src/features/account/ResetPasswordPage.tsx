import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { AlertCircle, Building2, CheckCircle2 } from 'lucide-react';
import { PASSWORD_MIN_LENGTH, passwordField } from '@hr/shared';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { ApiClientError } from '@/lib/api-client';
import { consumePasswordReset } from './account.api';

const formSchema = z
  .object({ newPassword: passwordField, confirmPassword: z.string() })
  .refine((v) => v.newPassword === v.confirmPassword, { message: 'The two passwords do not match', path: ['confirmPassword'] });
type FormValues = z.infer<typeof formSchema>;

/**
 * Public page behind a one-time reset link.
 *
 * The token arrives in the query string because that is what a link can carry, but it is moved into memory and the
 * query string is replaced immediately: a URL is shared, bookmarked, and kept in browser history far longer than the
 * token is valid. The token is submitted in the request body.
 */
export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const [token] = useState(() => params.get('token') ?? '');
  const [done, setDone] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const form = useForm<FormValues>({ resolver: zodResolver(formSchema), defaultValues: { newPassword: '', confirmPassword: '' } });

  useEffect(() => {
    // history.replaceState, not navigate(): a router navigation re-renders this route, and a remount would read the
    // token back out of a URL that no longer has it. This clears the address bar without touching the router.
    if (window.location.search) window.history.replaceState({}, '', window.location.pathname);
  }, []);

  const onSubmit = form.handleSubmit(async (values) => {
    setServerError(null);
    try {
      await consumePasswordReset({ token, newPassword: values.newPassword });
      setDone(true);
    } catch (err) {
      setServerError(
        err instanceof ApiClientError
          ? err.status === 429
            ? 'Too many attempts. Please wait a few minutes and try again.'
            : err.error.message
          : 'Unable to reach the server. Please try again.',
      );
    }
  });

  return (
    <div className="flex min-h-full items-center justify-center bg-slate-50 px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center text-center">
          <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-brand-600 text-white shadow-sm">
            <Building2 className="h-6 w-6" />
          </div>
          <h1 className="text-xl font-semibold tracking-tight text-slate-900">Set a new password</h1>
          <p className="mt-1 text-sm text-slate-500">This link can be used once.</p>
        </div>

        <div className="space-y-5 rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
          {done ? (
            <div className="space-y-4 text-center">
              <CheckCircle2 className="mx-auto h-10 w-10 text-emerald-600" />
              <p className="text-sm text-slate-700">Your password has been set and every other session has been signed out.</p>
              <Link to="/login" className="inline-block"><Button>Go to sign in</Button></Link>
            </div>
          ) : !token ? (
            <div className="space-y-3 text-center">
              <AlertCircle className="mx-auto h-10 w-10 text-amber-500" />
              <p className="text-sm text-slate-700">This page needs a valid reset link. Ask your administrator to issue a new one.</p>
              <Link to="/login" className="text-sm font-medium text-brand-700 hover:underline">Back to sign in</Link>
            </div>
          ) : (
            <form onSubmit={onSubmit} noValidate className="space-y-5">
              {serverError && (
                <div role="alert" className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>{serverError}</span>
                </div>
              )}
              <Input label="New password" type="password" autoFocus autoComplete="new-password" hint={`At least ${PASSWORD_MIN_LENGTH} characters`} error={form.formState.errors.newPassword?.message} {...form.register('newPassword')} />
              <Input label="Confirm new password" type="password" autoComplete="new-password" error={form.formState.errors.confirmPassword?.message} {...form.register('confirmPassword')} />
              <Button type="submit" className="w-full" loading={form.formState.isSubmitting}>Set password</Button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
