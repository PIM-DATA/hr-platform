import { Card } from '@/components/ui/Card';
import { Alert } from '@/components/ui/Alert';
import { LoadingBlock } from '@/components/ui/Spinner';
import { EmptyState } from '@/components/ui/EmptyState';
import { useLifecycleMutations, useMyLifecycle } from './lifecycle.api';
import { LifecycleBadge, Progress, TaskRow, titleCase } from './lifecycle-ui';

/** The employee's own lifecycle: onboarding checklist, probation period and outcome, exit checklist, and tasks assigned to them. */
export function MyLifecyclePage() {
  const my = useMyLifecycle();
  const m = useLifecycleMutations();
  if (my.isLoading) return <LoadingBlock />;
  if (my.isError || !my.data) return <Alert>Could not load your lifecycle.</Alert>;
  const d = my.data;
  return (
    <div className="space-y-4">
      {d.onboarding && (
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-4 py-3"><div className="text-sm font-semibold text-slate-900">My onboarding <LifecycleBadge status={d.onboarding.status} /></div><Progress pct={d.onboarding.progress.pct} hint={`${d.onboarding.progress.done}/${d.onboarding.progress.total} tasks`} /></div>
          <div className="px-4 py-2 text-xs text-slate-500">Start {d.onboarding.startDate}{d.onboarding.hrOwnerName && ` · HR contact ${d.onboarding.hrOwnerName}`}</div>
          <ul className="divide-y divide-slate-100" data-testid="my-onboarding-tasks">{d.onboarding.tasks.map((t) => <TaskRow key={t.id} task={t} manage={false} onUpdate={(input) => m.updateOnboardingTask.mutateAsync({ id: t.id, input: input as never })} />)}</ul>
        </Card>
      )}
      {d.probation && (
        <Card className="p-4">
          <div className="text-sm font-semibold text-slate-900">My probation <LifecycleBadge status={d.probation.status} /></div>
          <div className="mt-1 text-sm text-slate-600">{d.probation.startDate} → {d.probation.currentEndDate}{d.probation.extensions > 0 && ` (extended ${d.probation.extensions}×)`}{d.probation.finalOutcome && <> · outcome <b>{titleCase(d.probation.finalOutcome)}</b></>}</div>
        </Card>
      )}
      {d.offboarding && (
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-4 py-3"><div className="text-sm font-semibold text-slate-900">My exit checklist <LifecycleBadge status={d.offboarding.status} /></div><Progress pct={d.offboarding.progress.pct} /></div>
          <div className="px-4 py-2 text-xs text-slate-500">Planned last working day {d.offboarding.plannedLastWorkingDate}{d.offboarding.actualLastWorkingDate && ` · actual ${d.offboarding.actualLastWorkingDate}`}</div>
          <ul className="divide-y divide-slate-100">{d.offboarding.tasks.map((t) => <TaskRow key={t.id} task={t} manage={false} onUpdate={(input) => m.updateOffboardingTask.mutateAsync({ id: t.id, input: input as never })} />)}</ul>
        </Card>
      )}
      <Card>
        <div className="border-b border-slate-200 px-4 py-3 text-sm font-semibold text-slate-900">Tasks assigned to me</div>
        {d.myTasks.length === 0 && <EmptyState title="Nothing assigned" description="Onboarding and offboarding tasks assigned to you appear here." />}
        <ul className="divide-y divide-slate-100">{d.myTasks.map((x) => <li key={x.task.id}><div className="px-4 pt-2 text-[11px] uppercase text-slate-400">{titleCase(x.kind)} · {x.employeeName}</div><ul><TaskRow task={x.task} manage={false} onUpdate={(input) => (x.kind === 'ONBOARDING' ? m.updateOnboardingTask : m.updateOffboardingTask).mutateAsync({ id: x.task.id, input: input as never })} /></ul></li>)}</ul>
      </Card>
      {!d.onboarding && !d.probation && !d.offboarding && d.myTasks.length === 0 && <p className="text-xs text-slate-400">No lifecycle process is open for you.</p>}
    </div>
  );
}
