import type { TeamDevelopmentDto } from '@hr/shared';
import { Card } from '@/components/ui/Card';
import { Alert } from '@/components/ui/Alert';
import { LoadingBlock } from '@/components/ui/Spinner';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { useTeamDevelopment } from './training.api';

/** A manager's team at a glance — counts, never contents. What somebody's plan says is theirs and HR's. */
export function TeamDevelopmentPage() {
  const team = useTeamDevelopment();
  if (team.isLoading) return <LoadingBlock />;
  if (team.isError) return <Alert>Could not load your team's development summary.</Alert>;
  const t = team.data!;
  const columns: Column<TeamDevelopmentDto['members'][number]>[] = [
    { key: 'name', header: 'Employee', render: (m) => <div><div className="font-medium text-slate-900">{m.name}</div><div className="text-xs text-slate-400">{m.employeeCode}</div></div> },
    { key: 'needs', header: 'Open needs', className: 'text-right', render: (m) => <span className="tabular-nums">{m.openNeeds}</span> },
    { key: 'idp', header: 'Development plan', hideBelow: 'sm', render: (m) => (m.activeIdp ? 'Active' : <span className="text-slate-400">None</span>) },
    { key: 'upcoming', header: 'Upcoming training', className: 'text-right', hideBelow: 'md', render: (m) => <span className="tabular-nums">{m.upcoming}</span> },
    { key: 'completed', header: 'Completed', className: 'text-right', render: (m) => <span className="tabular-nums">{m.completed}</span> },
  ];
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        {[['Team members', t.teamSize], ['Open needs', t.openNeeds], ['Active plans', t.activeIdps], ['Upcoming training', t.upcomingSessions], ['Completed training', t.completedTraining]].map(([label, value]) => (
          <div key={label} className="rounded-lg border border-slate-200 bg-white p-3"><div className="text-xs text-slate-500">{label}</div><div className="mt-0.5 text-xl font-semibold tabular-nums text-slate-900">{value}</div></div>
        ))}
      </div>
      <Card><DataTable columns={columns} rows={t.members} rowKey={(m) => m.employeeId} emptyTitle="Nobody reports to you" /></Card>
    </div>
  );
}
