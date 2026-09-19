import { useQuery } from '@tanstack/react-query';
import { Building2, UserPlus, Users, UserCheck } from 'lucide-react';
import { PageHeader } from '@/components/layout/PageHeader';
import { Card } from '@/components/ui/Card';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { api } from '@/lib/api-client';

interface Health { status: string; database: string; timestamp: string }

/**
 * Phase 1 shell. Task 7 replaces the placeholder numbers with GET /dashboard/summary
 * and adds role-specific quick actions.
 */
export function DashboardPage() {
  const health = useQuery({ queryKey: ['health'], queryFn: () => api.get<Health>('/health'), refetchInterval: 30_000 });

  const stats = [
    { label: 'Total Employees', icon: Users },
    { label: 'Active Employees', icon: UserCheck },
    { label: 'Departments', icon: Building2 },
    { label: 'New Employees (30d)', icon: UserPlus },
  ];

  return (
    <>
      <PageHeader title="Dashboard" description="Overview of your organization." />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {stats.map(({ label, icon: Icon }) => (
          <Card key={label} className="p-5">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-slate-500">{label}</span>
              <span className="flex h-9 w-9 items-center justify-center rounded-md bg-brand-50 text-brand-600">
                <Icon className="h-5 w-5" />
              </span>
            </div>
            <div className="mt-3 text-3xl font-semibold tracking-tight text-slate-900">—</div>
            <div className="mt-1 text-xs text-slate-400">Available in Task 7</div>
          </Card>
        ))}
      </div>

      <Card className="mt-6 p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-slate-900">System status</h2>
            <p className="mt-0.5 text-xs text-slate-500">Frontend ↔ API ↔ Database connectivity check</p>
          </div>
          <div className="flex items-center gap-3 text-sm">
            <span className="text-slate-500">API</span>
            <StatusBadge status={health.isLoading ? 'CHECKING' : health.isError ? 'OFFLINE' : 'ONLINE'} tone={health.isError ? 'danger' : undefined} />
            <span className="text-slate-500">Database</span>
            <StatusBadge status={health.data?.data.database === 'ok' ? 'OK' : health.isLoading ? 'CHECKING' : 'ERROR'} />
          </div>
        </div>
      </Card>
    </>
  );
}
