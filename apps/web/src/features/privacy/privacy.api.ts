import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreatePrivacyRequestInput, PersonalDataExportDto, PrivacyEmployeeOptionDto, PrivacyRequestDto, UpdatePrivacyRequestInput } from '@hr/shared';
import { api, ApiClientError, getCsrfToken } from '@/lib/api-client';

/** Same base the JSON client uses; the export is a file download, so it builds its own request. */
const API_ROOT = `${(import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '')}/api/v1`;

const KEY = 'privacy';
export const privacyKeys = {
  requests: (f: Record<string, unknown>) => [KEY, 'requests', f] as const,
  request: (id: string) => [KEY, 'request', id] as const,
  employees: (search: string) => [KEY, 'employee-options', search] as const,
};

export interface RequestFilters { status?: string; requestType?: string; page: number; pageSize: number }

export function usePrivacyRequests(f: RequestFilters) {
  const params = new URLSearchParams({ page: String(f.page), pageSize: String(f.pageSize) });
  if (f.status) params.set('status', f.status);
  if (f.requestType) params.set('requestType', f.requestType);
  return useQuery({ queryKey: privacyKeys.requests({ ...f }), queryFn: () => api.get<PrivacyRequestDto[]>(`/privacy/requests?${params}`), placeholderData: (p) => p });
}

/** Notes live only on the detail endpoint, so the drawer fetches the request again when it opens. */
export const usePrivacyRequest = (id: string | null) =>
  useQuery({ queryKey: privacyKeys.request(id ?? ''), queryFn: () => api.get<PrivacyRequestDto>(`/privacy/requests/${id}`).then((r) => r.data), enabled: !!id });

export const usePrivacyEmployeeOptions = (search: string) =>
  useQuery({ queryKey: privacyKeys.employees(search), queryFn: () => api.get<PrivacyEmployeeOptionDto[]>(`/privacy/employee-options?search=${encodeURIComponent(search)}`).then((r) => r.data) });

export function usePrivacyMutations() {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: [KEY] });
  return {
    create: useMutation({ mutationFn: (input: CreatePrivacyRequestInput) => api.post<PrivacyRequestDto>('/privacy/requests', input).then((r) => r.data), onSuccess: invalidate }),
    update: useMutation({
      mutationFn: ({ id, input }: { id: string; input: UpdatePrivacyRequestInput }) => api.patch<PrivacyRequestDto>(`/privacy/requests/${id}`, input).then((r) => r.data),
      onSuccess: invalidate,
    }),
    // There is deliberately no delete: a privacy request is an operational record (see docs/privacy-operations.md).
  };
}

/**
 * Runs an export and hands the file straight to the browser.
 *
 * This one call bypasses the JSON client because the endpoint answers with a file attachment (the body is the export
 * itself, not the usual `{ data }` envelope). The payload is never put in the query cache: it is one person's complete
 * file and belongs in a download, not in application memory.
 */
export async function exportEmployeeData(employeeId: string): Promise<PersonalDataExportDto> {
  const csrf = getCsrfToken();
  const res = await fetch(`${API_ROOT}/privacy/employees/${employeeId}/export`, {
    method: 'POST',
    credentials: 'include',
    headers: csrf ? { 'x-csrf-token': csrf } : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) throw new ApiClientError(res.status, json.error ?? { code: 'EXPORT_FAILED', message: res.statusText });

  const result = json as PersonalDataExportDto;
  const fileName = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1]
    ?? `personal-data-${result.subject.employeeCode}-${result.generatedAt.slice(0, 10)}.json`;
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  return result;
}
