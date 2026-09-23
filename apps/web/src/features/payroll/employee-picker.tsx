import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { Input } from '@/components/ui/Input';
import { useDebounce } from '@/hooks/useDebounce';

export interface PayrollEmployeeOption {
  id: string;
  employeeCode: string;
  firstName: string;
  lastName: string;
  organization: { id: string; code: string; name: string } | null;
  department: { id: string; code: string; name: string } | null;
}

/**
 * Picking an employee for a payroll screen.
 *
 * It uses payroll's own employee lookup rather than leave's: a payroll administrator holds `payroll.manage` and need
 * hold no leave permission at all, so borrowing leave's endpoint would fail for exactly the people who need this.
 */
export function EmployeePicker({ label = 'Employee', value, onChange }: {
  label?: string;
  value: PayrollEmployeeOption | null;
  onChange: (employee: PayrollEmployeeOption | null) => void;
}) {
  const [term, setTerm] = useState('');
  const search = useDebounce(term, 250);
  const options = useQuery({
    queryKey: ['payroll', 'employee-options', search],
    queryFn: () => api.get<PayrollEmployeeOption[]>(`/payroll/employee-options?search=${encodeURIComponent(search)}&limit=20`).then((r) => r.data),
    enabled: !value && search.trim().length > 0,
  });

  if (value) {
    return (
      <div className="space-y-1.5">
        <span className="block text-sm font-medium text-slate-700">{label}</span>
        <div className="flex items-center justify-between rounded-md border border-slate-300 px-3 py-2 text-sm">
          <span>
            <span className="font-medium text-slate-900">{value.firstName} {value.lastName}</span>
            <span className="ml-1.5 text-xs text-slate-500">{value.employeeCode}</span>
          </span>
          <button type="button" className="text-xs text-brand-700 hover:underline" onClick={() => { onChange(null); setTerm(''); }}>Change</button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      <Input label={label} required placeholder="Search by name or employee code…" value={term} onChange={(e) => setTerm(e.target.value)} />
      {search.trim().length > 0 && (
        <ul className="max-h-44 overflow-y-auto rounded-md border border-slate-200">
          {options.isLoading && <li className="px-3 py-2 text-sm text-slate-500">Searching…</li>}
          {options.data?.length === 0 && <li className="px-3 py-2 text-sm text-slate-500">No active employee matches that.</li>}
          {(options.data ?? []).map((o) => (
            <li key={o.id}>
              <button type="button" className="block w-full px-3 py-2 text-left text-sm hover:bg-slate-50" onClick={() => onChange(o)}>
                <span className="font-medium text-slate-900">{o.firstName} {o.lastName}</span>
                <span className="ml-1.5 text-xs text-slate-500">{o.employeeCode}{o.department && ` · ${o.department.name}`}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
