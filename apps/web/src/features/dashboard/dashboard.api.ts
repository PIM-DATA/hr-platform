import { useQuery } from '@tanstack/react-query';
import type { DashboardSummary } from '@hr/shared';
import { api } from '@/lib/api-client';

export const useDashboardSummary = () =>
  useQuery({ queryKey: ['dashboard', 'summary'], queryFn: () => api.get<DashboardSummary>('/dashboard/summary').then((r) => r.data), staleTime: 30_000 });
