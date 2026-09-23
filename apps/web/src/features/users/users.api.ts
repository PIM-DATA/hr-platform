import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreateUserInput, EmployeeOption, UpdateUserInput, UpdateUserRolesInput, UserDto, UserListQuery } from '@hr/shared';
import { api } from '@/lib/api-client';

const KEY = 'users';

function toQueryString(q: Partial<UserListQuery>) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== '') params.set(k, String(v));
  return params.toString();
}

export function useUsers(query: Partial<UserListQuery>) {
  return useQuery({
    queryKey: [KEY, query],
    queryFn: () => api.get<UserDto[]>(`/users?${toQueryString(query)}`),
    placeholderData: (prev) => prev,
  });
}

export function useEmployeeOptions(search: string, includeUserId?: string, enabled = true) {
  const params = new URLSearchParams();
  if (search) params.set('search', search);
  if (includeUserId) params.set('includeUserId', includeUserId);
  return useQuery({
    queryKey: [KEY, 'employee-options', search, includeUserId],
    queryFn: () => api.get<EmployeeOption[]>(`/users/employee-options?${params}`).then((r) => r.data),
    enabled,
  });
}

/** All mutations invalidate the users list so the table refreshes. */
export function useUserMutations() {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: [KEY] });
  return {
    create: useMutation({ mutationFn: (input: CreateUserInput) => api.post<UserDto>('/users', input).then((r) => r.data), onSuccess: invalidate }),
    update: useMutation({ mutationFn: ({ id, input }: { id: string; input: UpdateUserInput }) => api.patch<UserDto>(`/users/${id}`, input).then((r) => r.data), onSuccess: invalidate }),
    setRoles: useMutation({ mutationFn: ({ id, input }: { id: string; input: UpdateUserRolesInput }) => api.patch<UserDto>(`/users/${id}/roles`, input).then((r) => r.data), onSuccess: invalidate }),
    activate: useMutation({ mutationFn: (id: string) => api.patch<UserDto>(`/users/${id}/activate`).then((r) => r.data), onSuccess: invalidate }),
    deactivate: useMutation({ mutationFn: (id: string) => api.patch<UserDto>(`/users/${id}/deactivate`).then((r) => r.data), onSuccess: invalidate }),
    // Password recovery lives in features/account: an administrator issues a one-time link and never sets a password.
  };
}
