import { useState } from 'react';
import { UserCheck, UserX, Pencil } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { ApiClientError } from '@/lib/api-client';
import { useToast } from '@/components/ui/Toast';

/** Turns any thrown error into a message safe to show users (API business messages are curated; anything else is generic). */
export function errorMessage(err: unknown, fallback = 'Something went wrong. Please try again.'): string {
  if (err instanceof ApiClientError) {
    if (err.status >= 500) return fallback;
    return err.error.message;
  }
  return fallback;
}

interface Target { id: string; label: string; isActive: boolean }

/**
 * Shared activate/deactivate flow: returns the confirm dialog element and an `ask(target)` opener.
 * Business errors from the API (e.g. DEPARTMENT_IN_USE) are shown inside the dialog.
 */
export function useStatusConfirm(entity: string, m: { activate: { mutateAsync: (id: string) => Promise<unknown>; isPending: boolean }; deactivate: { mutateAsync: (id: string) => Promise<unknown>; isPending: boolean } }) {
  const toast = useToast();
  const [target, setTarget] = useState<Target | null>(null);
  const [error, setError] = useState<string | null>(null);
  const close = () => { setTarget(null); setError(null); };
  const onConfirm = async () => {
    if (!target) return;
    setError(null);
    try {
      await (target.isActive ? m.deactivate : m.activate).mutateAsync(target.id);
      toast.success(`${entity[0].toUpperCase()}${entity.slice(1)} ${target.isActive ? 'deactivated' : 'activated'}`, target.label);
      close();
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  const dialog = (
    <ConfirmDialog
      open={!!target}
      title={target?.isActive ? `Deactivate ${entity}` : `Activate ${entity}`}
      message={target?.isActive ? `"${target.label}" will be marked inactive. It stays in history and can be re-activated later.` : `"${target?.label}" will become active again.`}
      confirmLabel={target?.isActive ? 'Deactivate' : 'Activate'}
      variant={target?.isActive ? 'danger' : 'primary'}
      loading={m.activate.isPending || m.deactivate.isPending}
      error={error}
      onConfirm={onConfirm}
      onCancel={close}
    />
  );
  return { ask: (t: Target) => setTarget(t), dialog };
}

/** Edit + activate/deactivate icon buttons for table rows (rendered only when the caller has organization.manage). */
export function RowActions({ isActive, onEdit, onToggle }: { isActive: boolean; onEdit: () => void; onToggle: () => void }) {
  return (
    <div className="flex justify-end gap-1">
      <Button variant="ghost" size="sm" onClick={onEdit} aria-label="Edit"><Pencil className="h-4 w-4" /></Button>
      {isActive ? (
        <Button variant="ghost" size="sm" className="text-red-600 hover:bg-red-50" onClick={onToggle} aria-label="Deactivate"><UserX className="h-4 w-4" /></Button>
      ) : (
        <Button variant="ghost" size="sm" className="text-emerald-600 hover:bg-emerald-50" onClick={onToggle} aria-label="Activate"><UserCheck className="h-4 w-4" /></Button>
      )}
    </div>
  );
}

export const STATUS_OPTIONS = [{ value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' }];
export const PAGE_SIZE = 20;
