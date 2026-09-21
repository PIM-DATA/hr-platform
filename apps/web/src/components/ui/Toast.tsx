import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { CheckCircle2, AlertCircle, Info, X } from 'lucide-react';
import { cn } from '@/lib/utils';

type Tone = 'success' | 'error' | 'info';
interface Toast { id: number; tone: Tone; title: string; description?: string }
interface ToastApi {
  toast: (t: Omit<Toast, 'id'>) => void;
  success: (title: string, description?: string) => void;
  error: (title: string, description?: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);
const DURATION_MS = 4500;

/** Lightweight in-house notification system (no external library). Mount once in AppProviders. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const dismiss = useCallback((id: number) => setToasts((prev) => prev.filter((t) => t.id !== id)), []);
  const toast = useCallback(
    (t: Omit<Toast, 'id'>) => {
      const id = Date.now() + Math.random();
      setToasts((prev) => [...prev, { ...t, id }]);
      setTimeout(() => dismiss(id), DURATION_MS);
    },
    [dismiss],
  );
  const api = useMemo<ToastApi>(
    () => ({ toast, success: (title, description) => toast({ tone: 'success', title, description }), error: (title, description) => toast({ tone: 'error', title, description }) }),
    [toast],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-0 z-[60] flex flex-col items-center gap-2 p-4 sm:items-end">
        {toasts.map((t) => (
          <ToastItem key={t.id} toast={t} onDismiss={() => dismiss(t.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

const styles: Record<Tone, { icon: typeof Info; cls: string }> = {
  success: { icon: CheckCircle2, cls: 'border-emerald-200 bg-white text-emerald-700' },
  error: { icon: AlertCircle, cls: 'border-red-200 bg-white text-red-700' },
  info: { icon: Info, cls: 'border-slate-200 bg-white text-slate-700' },
};

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  const { icon: Icon, cls } = styles[toast.tone];
  return (
    <div role="status" className={cn('pointer-events-auto flex w-full max-w-sm items-start gap-2.5 rounded-lg border px-4 py-3 text-sm shadow-lg', cls)}>
      <Icon className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="font-medium">{toast.title}</div>
        {toast.description && <div className="mt-0.5 text-xs text-slate-500">{toast.description}</div>}
      </div>
      <button onClick={onDismiss} className="rounded p-0.5 text-slate-400 hover:text-slate-600" aria-label="Dismiss">
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within <ToastProvider>');
  return ctx;
}
