import { useEffect, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';
import type { EmployeeSelectorOption } from '@hr/shared';
import { useDebounce } from '@/hooks/useDebounce';
import { cn } from '@/lib/utils';
import { useEmployeeOptions } from './employees.api';

interface EmployeeSelectProps {
  label?: string;
  value: EmployeeSelectorOption | null;
  onChange: (value: EmployeeSelectorOption | null) => void;
  /** Restrict candidates to one department (department head picker). */
  departmentId?: string;
  /** Exclude one employee (the employee being edited). */
  excludeId?: string;
  placeholder?: string;
  error?: string;
  disabled?: boolean;
}

/**
 * Searchable employee picker backed by GET /employees/options (server-side search, max 20, scoped by the API).
 * Never loads the whole company; the selected value is kept as an object so it can be displayed without refetching.
 */
export function EmployeeSelect({ label, value, onChange, departmentId, excludeId, placeholder = 'Search by name or code…', error, disabled }: EmployeeSelectProps) {
  const [term, setTerm] = useState('');
  const [open, setOpen] = useState(false);
  const debounced = useDebounce(term, 250);
  const options = useEmployeeOptions({ search: debounced || undefined, departmentId, excludeId }, open);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  return (
    <div className="space-y-1.5" ref={ref}>
      {label && <label className="block text-sm font-medium text-slate-700">{label}</label>}
      {value ? (
        <div className={cn('flex items-center justify-between rounded-md border border-slate-300 bg-slate-50 px-3 py-1.5 text-sm', disabled && 'opacity-60')}>
          <span>
            <span className="font-medium text-slate-900">{value.firstName} {value.lastName}</span>
            <span className="ml-2 font-mono text-xs text-slate-500">{value.employeeCode}</span>
            <span className="ml-2 text-xs text-slate-500">{value.position.title} · {value.department.name}</span>
          </span>
          {!disabled && (
            <button type="button" onClick={() => onChange(null)} className="rounded p-0.5 text-slate-400 hover:text-slate-700" aria-label="Clear">
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
      ) : (
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            value={term}
            disabled={disabled}
            onChange={(e) => { setTerm(e.target.value); setOpen(true); }}
            onFocus={() => setOpen(true)}
            placeholder={placeholder}
            className={cn('h-9 w-full rounded-md border bg-white pl-9 pr-3 text-sm shadow-sm placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-brand-500 disabled:bg-slate-50', error ? 'border-red-400' : 'border-slate-300')}
            role="combobox"
            aria-expanded={open}
          />
          {open && (
            <ul role="listbox" className="absolute z-20 mt-1 max-h-64 w-full overflow-y-auto rounded-md border border-slate-200 bg-white py-1 shadow-lg">
              {options.isLoading ? (
                <li className="px-3 py-2 text-sm text-slate-500">Searching…</li>
              ) : (options.data ?? []).length === 0 ? (
                <li className="px-3 py-2 text-sm text-slate-500">No active employees found</li>
              ) : (
                options.data!.map((o) => (
                  <li key={o.id}>
                    <button type="button" role="option" aria-selected={false} onClick={() => { onChange(o); setTerm(''); setOpen(false); }} className="flex w-full flex-col items-start px-3 py-2 text-left text-sm hover:bg-slate-50">
                      <span className="font-medium text-slate-900">{o.firstName} {o.lastName} <span className="ml-1 font-mono text-xs text-slate-500">{o.employeeCode}</span></span>
                      <span className="text-xs text-slate-500">{o.position.title} · {o.department.name}</span>
                    </button>
                  </li>
                ))
              )}
            </ul>
          )}
        </div>
      )}
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}
