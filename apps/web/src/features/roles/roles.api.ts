import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PermissionDto, RoleDto, UpdateRolePermissionsInput } from '@hr/shared';
import { api } from '@/lib/api-client';

const KEY = 'roles';

export function useRoles() {
  return useQuery({ queryKey: [KEY], queryFn: () => api.get<RoleDto[]>('/roles').then((r) => r.data), staleTime: 5 * 60_000 });
}

export function useRole(id: string | undefined) {
  return useQuery({ queryKey: [KEY, id], queryFn: () => api.get<RoleDto>(`/roles/${id}`).then((r) => r.data), enabled: !!id });
}

export function usePermissions() {
  return useQuery({ queryKey: ['permissions'], queryFn: () => api.get<PermissionDto[]>('/permissions').then((r) => r.data), staleTime: 10 * 60_000 });
}

export function useUpdateRolePermissions() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateRolePermissionsInput }) => api.patch<RoleDto>(`/roles/${id}/permissions`, input).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: [KEY] }),
  });
}

/** Groups permissions by module for display: { employees: [ {code, action, ...} ] } */
export function groupByModule(permissions: PermissionDto[]) {
  const groups = new Map<string, (PermissionDto & { action: string })[]>();
  for (const p of permissions) {
    const action = p.code.split('.')[1] ?? p.code;
    const list = groups.get(p.module) ?? [];
    list.push({ ...p, action });
    groups.set(p.module, list);
  }
  return [...groups.entries()].map(([module, items]) => ({ module, items }));
}
