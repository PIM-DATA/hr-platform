import { useEffect, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { PASSWORD_MIN_LENGTH, PERMISSIONS, blockingGrantPermissions, selfEscalation, createUserSchema, type RoleDto, type UserDto } from '@hr/shared';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Checkbox } from '@/components/ui/Checkbox';
import { Alert } from '@/components/ui/Alert';
import { ApiClientError } from '@/lib/api-client';
import { useDebounce } from '@/hooks/useDebounce';
import { useAuth } from '@/hooks/useAuth';
import { useEmployeeOptions, useUserMutations } from './users.api';

// Edit form: same fields minus password.
const editSchema = createUserSchema.omit({ password: true });
type FormValues = z.infer<typeof createUserSchema>;

interface UserFormModalProps {
  open: boolean;
  onClose: () => void;
  roles: RoleDto[];
  /** When set, the modal edits this user; otherwise it creates a new one. */
  user?: UserDto | null;
}

export function UserFormModal({ open, onClose, roles, user }: UserFormModalProps) {
  const isEdit = !!user;
  const { user: me, scopeOf } = useAuth();
  const { create, update, setRoles } = useUserMutations();
  // Mirrors the API rules (blockingGrantPermissions + data scope, and no self-escalation); roles the user already has
  // stay editable. Task 50: scopes are per permission — the grant limit is the actor's scope for the user-administration
  // permission being exercised, and self-escalation compares each permission's scope.
  const SCOPE_RANK: Record<string, number> = { SELF: 0, TEAM: 1, ALL: 2 };
  const grantScope = scopeOf(isEdit ? PERMISSIONS.USERS_UPDATE : PERMISSIONS.USERS_CREATE) ?? 'SELF';
  const isSelf = !!user && user.id === me?.id;
  const widensSelf = (r: RoleDto) => {
    const before = { permissions: me?.permissions ?? [], permissionScopes: me?.permissionScopes ?? {} };
    const after = { permissions: [...before.permissions, ...r.permissionCodes], permissionScopes: { ...before.permissionScopes } };
    for (const p of r.permissionCodes) if ((SCOPE_RANK[r.dataScope] ?? 0) > (SCOPE_RANK[after.permissionScopes[p] ?? ''] ?? -1)) after.permissionScopes[p] = r.dataScope as 'SELF' | 'TEAM' | 'ALL';
    const e = selfEscalation(before, after);
    return e.gained.length > 0 || e.scopeWidened;
  };
  const held = (r: RoleDto) => user?.roles.some((ur) => ur.code === r.code) ?? false;
  const blockReason = (r: RoleDto): string | null => {
    if (held(r)) return null;
    if (isSelf && widensSelf(r)) return 'would widen your own access — another administrator must assign it';
    if (blockingGrantPermissions(me?.permissions ?? [], r.permissionCodes).length > 0 || (SCOPE_RANK[r.dataScope] ?? 0) > (SCOPE_RANK[grantScope] ?? 0)) return 'requires higher privileges';
    return null;
  };
  const canGrant = (r: RoleDto) => blockReason(r) === null;
  const [serverError, setServerError] = useState<string | null>(null);
  const [employeeSearch, setEmployeeSearch] = useState('');
  const debouncedSearch = useDebounce(employeeSearch);
  const employees = useEmployeeOptions(debouncedSearch, user?.id, open);

  const form = useForm<FormValues>({
    resolver: zodResolver(isEdit ? (editSchema as unknown as typeof createUserSchema) : createUserSchema),
    defaultValues: { email: '', password: '', roleCodes: [], employeeId: null },
  });

  useEffect(() => {
    if (!open) return;
    setServerError(null);
    setEmployeeSearch('');
    form.reset({
      email: user?.email ?? '',
      password: '',
      roleCodes: user?.roles.map((r) => r.code) ?? [],
      employeeId: user?.employee?.id ?? null,
    });
  }, [open, user, form]);

  const employeeOptions = useMemo(() => {
    const list = employees.data ?? [];
    // keep the currently linked employee selectable even if the search filters it out
    if (user?.employee && !list.some((e) => e.id === user.employee!.id)) {
      list.unshift({ ...user.employee, linkedUserId: user.id });
    }
    return list.map((e) => ({ value: e.id, label: `${e.employeeCode} — ${e.firstName} ${e.lastName}` }));
  }, [employees.data, user]);

  const onSubmit = form.handleSubmit(async (values) => {
    setServerError(null);
    try {
      if (isEdit && user) {
        const profileChanged = values.email !== user.email || (values.employeeId ?? null) !== (user.employee?.id ?? null);
        if (profileChanged) await update.mutateAsync({ id: user.id, input: { email: values.email, employeeId: values.employeeId ?? null } });
        const oldRoles = user.roles.map((r) => r.code).sort().join(',');
        if (oldRoles !== [...values.roleCodes].sort().join(',')) await setRoles.mutateAsync({ id: user.id, input: { roleCodes: values.roleCodes } });
      } else {
        await create.mutateAsync({ ...values, employeeId: values.employeeId ?? null });
      }
      onClose();
    } catch (err) {
      setServerError(err instanceof ApiClientError ? err.error.message : 'Something went wrong. Please try again.');
    }
  });

  const selectedRoles = form.watch('roleCodes');
  const toggleRole = (code: string, checked: boolean) => {
    const next = checked ? [...new Set([...selectedRoles, code])] : selectedRoles.filter((c) => c !== code);
    form.setValue('roleCodes', next, { shouldValidate: form.formState.isSubmitted });
  };
  const busy = form.formState.isSubmitting;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={isEdit ? 'Edit user' : 'Create user'}
      description={isEdit ? user?.email : 'Create a login account and assign roles.'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={onSubmit} loading={busy}>{isEdit ? 'Save changes' : 'Create user'}</Button>
        </>
      }
    >
      <form onSubmit={onSubmit} noValidate className="space-y-5">
        {serverError && <Alert>{serverError}</Alert>}

        <Input label="Email" type="email" required autoComplete="off" error={form.formState.errors.email?.message} {...form.register('email')} />

        {!isEdit && (
          <Input label="Temporary password" type="password" required autoComplete="new-password" hint={`At least ${PASSWORD_MIN_LENGTH} characters. Share it with the user securely; they should change it after first login.`} error={form.formState.errors.password?.message} {...form.register('password')} />
        )}

        <div className="space-y-1.5">
          <label className="block text-sm font-medium text-slate-700">Linked employee</label>
          <input
            type="search"
            value={employeeSearch}
            onChange={(e) => setEmployeeSearch(e.target.value)}
            placeholder="Search by code or name to narrow the list…"
            className="h-9 w-full rounded-md border border-slate-300 px-3 text-sm shadow-sm placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
          <Select
            options={employeeOptions}
            placeholder="— No employee (system account) —"
            value={form.watch('employeeId') ?? ''}
            onChange={(e) => form.setValue('employeeId', e.target.value || null)}
          />
          <p className="text-xs text-slate-500">Only active employees without an account are listed. Each employee can have one account.</p>
        </div>

        <fieldset className="space-y-2">
          <legend className="text-sm font-medium text-slate-700">
            Roles <span className="text-red-500">*</span>
          </legend>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {roles.map((r) => (
              <Checkbox
                key={r.code}
                label={r.name}
                description={`${r.description ?? ''} · scope ${r.dataScope}${canGrant(r) ? '' : ` · ${blockReason(r)}`}`}
                checked={selectedRoles.includes(r.code)}
                disabled={!canGrant(r)}
                onChange={(e) => toggleRole(r.code, e.target.checked)}
              />
            ))}
          </div>
          {form.formState.errors.roleCodes && <p className="text-xs text-red-600">{form.formState.errors.roleCodes.message}</p>}
        </fieldset>
      </form>
    </Modal>
  );
}
