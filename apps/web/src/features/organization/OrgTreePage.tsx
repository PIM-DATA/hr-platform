import { useMemo, useState } from 'react';
import { Building2, Plus, Briefcase } from 'lucide-react';
import { PERMISSIONS, type DepartmentDto, type PositionDto, type TreeDepartment, type TreeOrganization } from '@hr/shared';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { SearchInput } from '@/components/ui/SearchInput';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { Checkbox } from '@/components/ui/Checkbox';
import { Alert } from '@/components/ui/Alert';
import { LoadingBlock } from '@/components/ui/Spinner';
import { EmptyState } from '@/components/ui/EmptyState';
import { TreeView, type TreeNode } from '@/components/ui/TreeView';
import { PermissionGuard } from '@/components/guards/PermissionGuard';
import { usePermission } from '@/hooks/usePermission';
import { useOrganizationOptions, useOrganizationTree } from './organization.api';
import { DepartmentFormModal } from './DepartmentFormModal';
import { PositionFormModal } from './PositionFormModal';

export function OrgTreePage() {
  const canManage = usePermission(PERMISSIONS.ORGANIZATION_MANAGE);
  const organizations = useOrganizationOptions();
  const [organizationId, setOrganizationId] = useState('');
  const [includeInactive, setIncludeInactive] = useState(false);
  const [search, setSearch] = useState('');
  const tree = useOrganizationTree(organizationId || undefined, includeInactive);

  const [deptModal, setDeptModal] = useState<{ open: boolean; defaults?: { organizationId: string; parentId: string | null } }>({ open: false });
  const [posModal, setPosModal] = useState<{ open: boolean; defaults?: { organizationId: string; departmentId: string } }>({ open: false });

  const nodes = useMemo(() => (tree.data ?? []).map((o) => orgNode(o, search.trim().toLowerCase(), canManage, setDeptModal, setPosModal)).filter(Boolean) as TreeNode[], [tree.data, search, canManage]);

  return (
    <>
      <Card>
        <div className="flex flex-col gap-3 border-b border-slate-200 p-4 lg:flex-row lg:items-center">
          <Select options={(organizations.data?.data ?? []).map((o) => ({ value: o.id, label: `${o.code} — ${o.name}` }))} placeholder="All organizations" value={organizationId} onChange={(e) => setOrganizationId(e.target.value)} className="lg:w-64" />
          <SearchInput value={search} onChange={setSearch} placeholder="Filter departments / positions…" className="lg:w-72" />
          <Checkbox label="Show inactive" checked={includeInactive} onChange={(e) => setIncludeInactive(e.target.checked)} />
          <div className="flex-1" />
          <PermissionGuard permission={PERMISSIONS.ORGANIZATION_MANAGE}>
            <Button variant="secondary" onClick={() => setDeptModal({ open: true, defaults: { organizationId, parentId: null } })}><Plus className="h-4 w-4" /> Department</Button>
          </PermissionGuard>
        </div>
        <div className="p-3">
          {tree.isLoading ? (
            <LoadingBlock />
          ) : tree.isError ? (
            <Alert>Could not load the organization structure.</Alert>
          ) : nodes.length === 0 ? (
            <EmptyState icon={<Building2 className="h-6 w-6" />} title={search ? 'No matches' : 'No organization structure yet'} description={search ? 'Try a different search.' : 'Create an organization, then add departments and positions.'} />
          ) : (
            <TreeView nodes={nodes} />
          )}
        </div>
      </Card>

      {canManage && (
        <>
          <DepartmentFormModal open={deptModal.open} onClose={() => setDeptModal({ open: false })} defaults={deptModal.defaults} />
          <PositionFormModal open={posModal.open} onClose={() => setPosModal({ open: false })} defaults={posModal.defaults} />
        </>
      )}
    </>
  );
}

type OpenDept = (s: { open: boolean; defaults?: { organizationId: string; parentId: string | null } }) => void;
type OpenPos = (s: { open: boolean; defaults?: { organizationId: string; departmentId: string } }) => void;

function matches(text: string, q: string) {
  return !q || text.toLowerCase().includes(q);
}

function orgNode(o: TreeOrganization, q: string, canManage: boolean, openDept: OpenDept, openPos: OpenPos): TreeNode | null {
  const children = o.departments.map((d) => deptNode(d, o.id, q, canManage, openDept, openPos)).filter(Boolean) as TreeNode[];
  if (q && children.length === 0 && !matches(`${o.code} ${o.name}`, q)) return null;
  return {
    id: o.id,
    label: (
      <span className="inline-flex items-center gap-2"><Building2 className="h-4 w-4 text-brand-600" />{o.name}</span>
    ),
    meta: (
      <>
        <span className="font-mono text-xs text-slate-400">{o.code}</span>
        {!o.isActive && <StatusBadge status="INACTIVE" />}
      </>
    ),
    muted: !o.isActive,
    actions: canManage && o.isActive ? <Button variant="ghost" size="sm" onClick={() => openDept({ open: true, defaults: { organizationId: o.id, parentId: null } })}>+ Department</Button> : undefined,
    children,
  };
}

function deptNode(d: TreeDepartment, organizationId: string, q: string, canManage: boolean, openDept: OpenDept, openPos: OpenPos): TreeNode | null {
  const childDepts = d.children.map((c) => deptNode(c, organizationId, q, canManage, openDept, openPos)).filter(Boolean) as TreeNode[];
  const positions = d.positions.filter((p) => matches(`${p.code} ${p.title} ${p.job?.title ?? ''}`, q)).map(posNode);
  const selfMatch = matches(`${d.code} ${d.name}`, q);
  if (q && !selfMatch && childDepts.length === 0 && positions.length === 0) return null;
  return {
    id: d.id,
    label: d.name,
    meta: (
      <>
        <span className="font-mono text-xs text-slate-400">{d.code}</span>
        {d.positions.length > 0 && <span className="text-xs text-slate-400">{d.positions.length} position{d.positions.length === 1 ? '' : 's'}</span>}
        {!d.isActive && <StatusBadge status="INACTIVE" />}
      </>
    ),
    muted: !d.isActive,
    actions: canManage && d.isActive ? (
      <>
        <Button variant="ghost" size="sm" onClick={() => openDept({ open: true, defaults: { organizationId, parentId: d.id } })}>+ Sub-dept</Button>
        <Button variant="ghost" size="sm" onClick={() => openPos({ open: true, defaults: { organizationId, departmentId: d.id } })}>+ Position</Button>
      </>
    ) : undefined,
    children: [...(q ? positions : positions), ...childDepts],
  };
}

function posNode(p: TreeDepartment['positions'][number]): TreeNode {
  return {
    id: p.id,
    leaf: true,
    muted: !p.isActive,
    label: (
      <span className="inline-flex items-center gap-2"><Briefcase className="h-3.5 w-3.5 text-slate-400" />{p.title}</span>
    ),
    meta: (
      <>
        <span className="font-mono text-xs text-slate-400">{p.code}</span>
        {p.job && <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600">{p.job.title}</span>}
        {!p.isActive && <StatusBadge status="INACTIVE" />}
      </>
    ),
  };
}

// re-exported types keep the modals' prop contracts visible here
export type { DepartmentDto, PositionDto };
