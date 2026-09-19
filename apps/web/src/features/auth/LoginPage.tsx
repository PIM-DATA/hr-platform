import { useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Building2, AlertCircle } from 'lucide-react';
import { loginSchema, type LoginInput } from '@hr/shared';
import { useAuth } from '@/hooks/useAuth';
import { ApiClientError } from '@/lib/api-client';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { LoadingBlock } from '@/components/ui/Spinner';

export function LoginPage() {
  const { status, login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [serverError, setServerError] = useState<string | null>(null);

  const form = useForm<LoginInput>({ resolver: zodResolver(loginSchema), defaultValues: { email: '', password: '' } });

  if (status === 'loading') return <LoadingBlock />;
  if (status === 'authenticated') return <Navigate to="/dashboard" replace />;

  const onSubmit = form.handleSubmit(async (values) => {
    setServerError(null);
    try {
      await login(values);
      const from = (location.state as { from?: string } | null)?.from;
      navigate(from && from !== '/login' ? from : '/dashboard', { replace: true });
    } catch (err) {
      if (err instanceof ApiClientError) {
        setServerError(
          err.status === 429
            ? 'Too many failed attempts. Please wait a few minutes and try again.'
            : err.error.code === 'ACCOUNT_INACTIVE'
              ? 'This account has been deactivated. Please contact HR.'
              : 'Invalid email or password.',
        );
      } else {
        setServerError('Unable to reach the server. Please try again.');
      }
    }
  });

  return (
    <div className="flex min-h-full items-center justify-center bg-slate-50 px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center text-center">
          <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-brand-600 text-white shadow-sm">
            <Building2 className="h-6 w-6" />
          </div>
          <h1 className="text-xl font-semibold tracking-tight text-slate-900">HR Enterprise Platform</h1>
          <p className="mt-1 text-sm text-slate-500">Sign in to your account</p>
        </div>

        <form onSubmit={onSubmit} noValidate className="space-y-5 rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
          {serverError && (
            <div role="alert" className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{serverError}</span>
            </div>
          )}

          <Input
            label="Email"
            type="email"
            autoComplete="email"
            autoFocus
            placeholder="you@company.com"
            error={form.formState.errors.email?.message}
            {...form.register('email')}
          />
          <Input
            label="Password"
            type="password"
            autoComplete="current-password"
            placeholder="••••••••"
            error={form.formState.errors.password?.message}
            {...form.register('password')}
          />

          <Button type="submit" className="w-full" loading={form.formState.isSubmitting}>
            Sign in
          </Button>
        </form>

        <p className="mt-6 text-center text-xs text-slate-400">© {new Date().getFullYear()} HR Enterprise Platform</p>
      </div>
    </div>
  );
}
