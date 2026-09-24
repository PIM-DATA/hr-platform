import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreateSavedReportInput, ReportDatasetDto, ReportDefinition, ReportRunResultDto, ReportTemplateDto, SavedReportDto, UpdateSavedReportInput } from '@hr/shared';
import { api, ApiClientError, getCsrfToken } from '@/lib/api-client';

const KEY = 'reports';
const BASE = `${(import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '')}/api/v1/reports`;

export const useReportDatasets = () => useQuery({ queryKey: [KEY, 'datasets'], queryFn: () => api.get<ReportDatasetDto[]>('/reports/datasets').then((r) => r.data), staleTime: 60_000 });
export const useReportTemplates = () => useQuery({ queryKey: [KEY, 'templates'], queryFn: () => api.get<ReportTemplateDto[]>('/reports/templates').then((r) => r.data), staleTime: 60_000 });
export const useSavedReports = () => useQuery({ queryKey: [KEY, 'saved'], queryFn: () => api.get<SavedReportDto[]>('/reports/saved').then((r) => r.data) });
export const useSavedReport = (id: string | null) => useQuery({ queryKey: [KEY, 'saved', id ?? ''], queryFn: () => api.get<SavedReportDto>(`/reports/saved/${id}`).then((r) => r.data), enabled: !!id });
export const useRunReport = (datasetId: string | null, definition: ReportDefinition | null, page: number, enabled: boolean) =>
  useQuery({ queryKey: [KEY, 'run', datasetId, definition, page], queryFn: () => api.post<ReportRunResultDto>('/reports/run', { datasetId, definition, page }).then((r) => r.data), enabled: enabled && !!datasetId && !!definition, placeholderData: (p) => p, retry: false });

async function download(path: string, init: RequestInit, filename: string) {
  const csrf = getCsrfToken();
  const res = await fetch(`${BASE}${path}`, { ...init, credentials: 'include', headers: { ...(init.headers ?? {}), ...(csrf ? { 'x-csrf-token': csrf } : {}) } });
  if (!res.ok) { const json = await res.json().catch(() => ({})); throw new ApiClientError(res.status, json?.error ?? { code: 'EXPORT_FAILED', message: 'Could not export the report' }); }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a'); link.href = url; link.download = filename; document.body.appendChild(link); link.click(); link.remove(); URL.revokeObjectURL(url);
}
export const exportAdHoc = (datasetId: string, definition: ReportDefinition, name: string) => download('/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ datasetId, definition, name }) }, `${name.replace(/[^A-Za-z0-9._-]+/g, '-') || 'report'}.csv`);
export const exportSaved = (id: string, name: string) => download(`/saved/${id}/export`, { method: 'GET' }, `${name.replace(/[^A-Za-z0-9._-]+/g, '-') || 'report'}.csv`);

export function useReportMutations() {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: [KEY, 'saved'] });
  return {
    create: useMutation({ mutationFn: (input: CreateSavedReportInput) => api.post<SavedReportDto>('/reports/saved', input).then((r) => r.data), onSuccess: invalidate }),
    update: useMutation({ mutationFn: ({ id, input }: { id: string; input: UpdateSavedReportInput }) => api.patch<SavedReportDto>(`/reports/saved/${id}`, input).then((r) => r.data), onSuccess: invalidate }),
    remove: useMutation({ mutationFn: (id: string) => api.delete(`/reports/saved/${id}`), onSuccess: invalidate }),
  };
}
