import { useEffect, useState } from 'react';
import { Select } from '@/components/ui/Select';
import { useDepartmentOptions, useOrganizationOptions, usePositions } from '@/features/organization/organization.api';

export interface AssignmentValue { organizationId: string; departmentId: string; positionId: string }

interface AssignmentPickerProps {
  value: AssignmentValue;
  onChange: (v: AssignmentValue) => void;
  positionError?: string;
}

/**
 * Organization → Department → Position cascading selects (active only).
 * Only positionId is sent to the API; the server derives department/organization from the position.
 */
export function AssignmentPicker({ value, onChange, positionError }: AssignmentPickerProps) {
  const organizations = useOrganizationOptions();
  const departments = useDepartmentOptions(value.organizationId || undefined);
  const positions = usePositions({ departmentId: value.departmentId || undefined, status: 'active', pageSize: 100 });
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
      <Select label="Organization" required options={(organizations.data?.data ?? []).map((o) => ({ value: o.id, label: o.name }))} placeholder="Select…" value={value.organizationId}
        onChange={(e) => onChange({ organizationId: e.target.value, departmentId: '', positionId: '' })} />
      <Select label="Department" required disabled={!value.organizationId} options={(departments.data?.data ?? []).map((d) => ({ value: d.id, label: `${d.code} — ${d.name}` }))} placeholder="Select…" value={value.departmentId}
        onChange={(e) => onChange({ ...value, departmentId: e.target.value, positionId: '' })} />
      <Select label="Position" required disabled={!value.departmentId || !ready} options={(positions.data?.data ?? []).map((p) => ({ value: p.id, label: `${p.title}${p.job ? ` (${p.job.title})` : ''}` }))} placeholder="Select…" value={value.positionId}
        error={positionError} onChange={(e) => onChange({ ...value, positionId: e.target.value })} />
    </div>
  );
}
