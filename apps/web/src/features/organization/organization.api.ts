import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  DepartmentDto, DepartmentListQuery, JobDto, JobListQuery, OrganizationDto, OrganizationListQuery, PositionDto, PositionListQuery, TreeOrganization,
} from '@hr/shared';
import { api } from '@/lib/api-client';

const KEY = 'organization';

function qs(q: Record<string, unknown>) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== '' && v !== null) params.set(k, String(v));
  return params.toString();
}

export function useOrganizations(q: Partial<OrganizationListQuery> = {}) {
  return useQuery({ queryKey: [KEY, 'organizations', q], queryFn: () => api.get<OrganizationDto[]>(`/organizations?${qs(q)}`), placeholderData: (p) => p });
}
export function useDepartments(q: Partial<DepartmentListQuery> = {}, enabled = true) {
  return useQuery({ queryKey: [KEY, 'departments', q], queryFn: () => api.get<DepartmentDto[]>(`/departments?${qs(q)}`), placeholderData: (p) => p, enabled });
}
export function useJobs(q: Partial<JobListQuery> = {}) {
  return useQuery({ queryKey: [KEY, 'jobs', q], queryFn: () => api.get<JobDto[]>(`/jobs?${qs(q)}`), placeholderData: (p) => p });
}
export function usePositions(q: Partial<PositionListQuery> = {}) {
  return useQuery({ queryKey: [KEY, 'positions', q], queryFn: () => api.get<PositionDto[]>(`/positions?${qs(q)}`), placeholderData: (p) => p });
}
export function useOrganizationTree(organizationId?: string, includeInactive = false) {
  return useQuery({
    queryKey: [KEY, 'tree', organizationId ?? 'all', includeInactive],
    queryFn: () => api.get<TreeOrganization[]>(`/organization/tree?${qs({ organizationId, includeInactive: includeInactive || undefined })}`).then((r) => r.data),
  });
}

/** Options lists for selects (active only, first 100). */
export const useOrganizationOptions = () => useOrganizations({ status: 'active', pageSize: 100 });
export const useDepartmentOptions = (organizationId?: string) => useDepartments({ organizationId, status: 'active', pageSize: 100 }, true);
export const useJobOptions = () => useJobs({ status: 'active', pageSize: 100 });

type Resource = 'organizations' | 'departments' | 'jobs' | 'positions';

/** create / update / activate / deactivate for one resource; every success invalidates the whole organization cache (tree, lists, options). */
export function useOrgMutations<TDto>(resource: Resource) {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: [KEY] });
  return {
    create: useMutation({ mutationFn: (input: unknown) => api.post<TDto>(`/${resource}`, input).then((r) => r.data), onSuccess: invalidate }),
    update: useMutation({ mutationFn: ({ id, input }: { id: string; input: unknown }) => api.patch<TDto>(`/${resource}/${id}`, input).then((r) => r.data), onSuccess: invalidate }),
    activate: useMutation({ mutationFn: (id: string) => api.patch<TDto>(`/${resource}/${id}/activate`).then((r) => r.data), onSuccess: invalidate }),
    deactivate: useMutation({ mutationFn: (id: string) => api.patch<TDto>(`/${resource}/${id}/deactivate`).then((r) => r.data), onSuccess: invalidate }),
  };
}
