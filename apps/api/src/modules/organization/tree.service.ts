import type { TreeDepartment, TreeOrganization } from '@hr/shared';
import { prisma } from '../../lib/prisma';

/**
 * Organization → departments (nested) → positions (with job).
 * Exactly three queries regardless of size; the hierarchy is assembled in memory (no N+1).
 * Policy: active nodes only unless includeInactive; an inactive department hides its subtree.
 */
export async function buildOrganizationTree(opts: { organizationId?: string; includeInactive: boolean }): Promise<TreeOrganization[]> {
  const activeOnly = opts.includeInactive ? {} : { isActive: true };
  const orgWhere = { ...(opts.organizationId ? { id: opts.organizationId } : {}), ...activeOnly };

  const organizations = await prisma.organization.findMany({ where: orgWhere, select: { id: true, code: true, name: true, isActive: true }, orderBy: { code: 'asc' } });
  if (organizations.length === 0) return [];
  const orgIds = organizations.map((o) => o.id);

  const [departments, positions] = await Promise.all([
    prisma.department.findMany({
      where: { organizationId: { in: orgIds }, ...activeOnly },
      select: { id: true, organizationId: true, parentId: true, code: true, name: true, isActive: true },
      orderBy: { code: 'asc' },
    }),
    prisma.position.findMany({
      where: { department: { organizationId: { in: orgIds } }, ...activeOnly },
      select: { id: true, departmentId: true, code: true, title: true, isActive: true, job: { select: { id: true, code: true, title: true } } },
      orderBy: { code: 'asc' },
    }),
  ]);

  const deptNodes = new Map<string, TreeDepartment>();
  for (const d of departments) deptNodes.set(d.id, { id: d.id, code: d.code, name: d.name, isActive: d.isActive, parentId: d.parentId, children: [], positions: [] });
  for (const p of positions) deptNodes.get(p.departmentId)?.positions.push({ id: p.id, code: p.code, title: p.title, isActive: p.isActive, job: p.job });

  const rootsByOrg = new Map<string, TreeDepartment[]>(orgIds.map((id) => [id, []]));
  for (const d of departments) {
    const node = deptNodes.get(d.id)!;
    const parent = d.parentId ? deptNodes.get(d.parentId) : undefined;
    // a department whose parent is filtered out (inactive) is dropped with its subtree; an orphan pointing at a missing parent becomes a root
    if (d.parentId && !parent) {
      const parentExistsButHidden = !opts.includeInactive;
      if (parentExistsButHidden) continue;
      rootsByOrg.get(d.organizationId)!.push(node);
    } else if (parent) parent.children.push(node);
    else rootsByOrg.get(d.organizationId)!.push(node);
  }

  return organizations.map((o) => ({ id: o.id, code: o.code, name: o.name, isActive: o.isActive, departments: rootsByOrg.get(o.id) ?? [] }));
}
