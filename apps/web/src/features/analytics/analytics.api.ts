import { useQuery } from '@tanstack/react-query';
import type { AnalyticsFilter, Employee360Dto, ExecutiveOverviewDto, MetricDefinition } from '@hr/shared';
import { api, ApiClientError, getCsrfToken } from '@/lib/api-client';

const KEY = 'analytics';
const qs = (f: Record<string, unknown>) => { const p = new URLSearchParams(); for (const [k, v] of Object.entries(f)) if (v !== undefined && v !== '' && v !== null) p.set(k, String(v)); return p.toString(); };

export interface AnalyticsOptions { organizations: { id: string; name: string }[]; departments: { id: string; name: string; organizationId: string }[]; jobs: { id: string; title: string }[] }

export const useEmployee360 = (employeeId: string | undefined, enabled = true) =>
  useQuery({ queryKey: [KEY, 'employee-360', employeeId ?? ''], queryFn: () => api.get<Employee360Dto>(`/analytics/employee-360/${employeeId}`).then((r) => r.data), enabled: !!employeeId && enabled, staleTime: 30_000 });
export const useExecutiveOverview = (f: Partial<AnalyticsFilter>) =>
  useQuery({ queryKey: [KEY, 'executive', f], queryFn: () => api.get<ExecutiveOverviewDto>(`/analytics/executive/overview?${qs(f)}`).then((r) => r.data), enabled: !!f.from && !!f.to, placeholderData: (p) => p });
export const useAnalyticsOptions = () => useQuery({ queryKey: [KEY, 'options'], queryFn: () => api.get<AnalyticsOptions>('/analytics/executive/options').then((r) => r.data), staleTime: 60_000 });
export const useMetricDefinitions = () => useQuery({ queryKey: [KEY, 'metrics'], queryFn: () => api.get<MetricDefinition[]>('/analytics/metrics').then((r) => r.data), staleTime: 300_000 });

/** Downloads the aggregate tables as CSV. Built by hand because the endpoint answers with a file, not `{ data }`. */
export async function downloadExecutiveCsv(f: Partial<AnalyticsFilter>): Promise<void> {
  const base = `${(import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '')}/api/v1`;
  const csrf = getCsrfToken();
  const res = await fetch(`${base}/analytics/executive/export?${qs(f)}`, { credentials: 'include', headers: csrf ? { 'x-csrf-token': csrf } : undefined });
  if (!res.ok) throw new ApiClientError(res.status, { code: 'EXPORT_FAILED', message: 'Could not export the dashboard' });
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url; link.download = `hr-analytics-${f.from}-to-${f.to}.csv`;
  document.body.appendChild(link); link.click(); link.remove(); URL.revokeObjectURL(url);
}
