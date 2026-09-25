import { useQuery } from '@tanstack/react-query';
import type { AdminDiagnosticsDto, AdminSettingsAreaDto, WorkflowMonitorDetailDto, WorkflowMonitorRowDto, WorkflowMonitorSummaryDto } from '@hr/shared';
import { api } from '@/lib/api-client';

const KEY = 'admin';
const qs = (f: Record<string, unknown>) => { const p = new URLSearchParams(); for (const [k, v] of Object.entries(f)) if (v !== undefined && v !== '' && v !== null) p.set(k, String(v)); return p.toString(); };
type Page<T> = { data: T[]; meta: { page: number; pageSize: number; total: number } };

export const useAdminAreas = () => useQuery({ queryKey: [KEY, 'areas'], queryFn: () => api.get<AdminSettingsAreaDto[]>('/admin/settings/areas').then((r) => r.data), staleTime: 60_000 });
export const useAdminDiagnostics = () => useQuery({ queryKey: [KEY, 'diagnostics'], queryFn: () => api.get<AdminDiagnosticsDto>('/admin/diagnostics').then((r) => r.data) });
export const useWorkflowMonitor = (f: Record<string, unknown>) => useQuery({ queryKey: [KEY, 'monitor', f], queryFn: () => api.get<WorkflowMonitorRowDto[]>(`/admin/workflow-monitor?${qs(f)}`) as Promise<Page<WorkflowMonitorRowDto>>, placeholderData: (p) => p });
export const useWorkflowMonitorSummary = () => useQuery({ queryKey: [KEY, 'monitor-summary'], queryFn: () => api.get<WorkflowMonitorSummaryDto>('/admin/workflow-monitor/summary').then((r) => r.data) });
export const useWorkflowMonitorInstance = (id: string | null) => useQuery({ queryKey: [KEY, 'monitor-instance', id ?? ''], queryFn: () => api.get<WorkflowMonitorDetailDto>(`/admin/workflow-monitor/${id}`).then((r) => r.data), enabled: !!id });
