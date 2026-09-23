import { useState } from 'react';
import type { PrivacyEmployeeOptionDto } from '@hr/shared';
import { SearchInput } from '@/components/ui/SearchInput';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { Alert } from '@/components/ui/Alert';
import { LoadingBlock } from '@/components/ui/Spinner';
import { useDebounce } from '@/hooks/useDebounce';
import { cn } from '@/lib/utils';
import { usePrivacyEmployeeOptions } from './privacy.api';

/**
 * Employee lookup for privacy work. It uses the privacy endpoint rather than the employee directory, because a
 * privacy administrator does not need `employees.view` — and because former employees, who may well be the ones
 * asking, must be findable here.
 */
export function PrivacyEmployeePicker({ value, onChange }: { value: PrivacyEmployeeOptionDto | null; onChange: (employee: PrivacyEmployeeOptionDto | null) => void }) {
  const [search, setSearch] = useState('');
  const options = usePrivacyEmployeeOptions(useDebounce(search));

  if (value) {
    return (
      <div className="flex items-center justify-between rounded-md border border-slate-300 bg-slate-50 px-3 py-2">
        <span className="text-sm text-slate-800">
          {value.firstName} {value.lastName} <span className="text-xs text-slate-500">({value.employeeCode})</span>
        </span>
        <button type="button" onClick={() => onChange(null)} className="text-xs font-medium text-brand-700 hover:underline">Change</button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <SearchInput value={search} onChange={setSearch} placeholder="Search name, code or email…" />
      {options.isError && <Alert>Could not load employees.</Alert>}
      {options.isLoading ? (
        <LoadingBlock />
      ) : (
        <ul className="max-h-56 divide-y divide-slate-100 overflow-y-auto rounded-md border border-slate-200">
          {(options.data ?? []).map((e) => (
            <li key={e.id}>
              <button
                type="button"
                onClick={() => onChange(e)}
                className={cn('flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-slate-50')}
              >
                <span className="truncate text-slate-800">
                  {e.firstName} {e.lastName} <span className="text-xs text-slate-500">({e.employeeCode})</span>
                </span>
                {e.employmentStatus !== 'ACTIVE' && <StatusBadge status={e.employmentStatus} />}
              </button>
            </li>
          ))}
          {(options.data ?? []).length === 0 && <li className="px-3 py-3 text-sm text-slate-500">No employees match that search.</li>}
        </ul>
      )}
    </div>
  );
}
