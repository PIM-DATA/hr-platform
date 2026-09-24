import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Card, CardHeader } from '@/components/ui/Card';
import { Alert } from '@/components/ui/Alert';
import { LoadingBlock } from '@/components/ui/Spinner';
import { EmptyState } from '@/components/ui/EmptyState';
import { useMyCareer } from './talent.api';
import { ReadinessBadge, ReadinessTable } from './talent-ui';

/**
 * The employee's own career page: the paths their job sits on, the jobs one step away, and — for each — what that
 * job asks for against their latest assessed levels. No potential, no cell, no nomination: those are the
 * organization's records about the employee, not the employee's page. And nowhere does it say "you are ready for
 * promotion": a path is a possibility the organization has defined, not an entitlement.
 */
export function MyCareerPage() {
  const me = useMyCareer();
  const [openJob, setOpenJob] = useState<string | null>(null);
  if (me.isLoading) return <LoadingBlock />;
  if (me.isError) return <Alert>Could not load your career page.</Alert>;
  const d = me.data!;
  const selected = d.nextJobs.find((n) => n.targetJob.id === openJob) ?? d.nextJobs[0] ?? null;
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title="Current job" description={d.currentJob ? `${d.currentJob.title} (${d.currentJob.code})` : 'No job is linked to your position yet.'} />
        <div className="p-4 text-sm text-slate-700">
          {d.paths.length === 0 ? <p className="text-slate-500">Your job is not on a defined career path yet. Career paths are set by HR; ask them what is planned for your role.</p> : (
            <ul className="space-y-3">
              {d.paths.map((p) => (
                <li key={p.id}>
                  <div className="font-medium text-slate-900">{p.name}</div>
                  {p.description && <div className="text-xs text-slate-500">{p.description}</div>}
                  <ol className="mt-1 flex flex-wrap items-center gap-1 text-xs">
                    {p.steps.map((s, i) => (
                      <li key={s.id} className="flex items-center gap-1">
                        <span className={`rounded-full border px-2 py-0.5 ${s.fromJob.id === d.currentJob?.id ? 'border-brand-300 bg-brand-50 text-brand-800' : 'border-slate-200 bg-white text-slate-700'}`}>{s.fromJob.title}</span>
                        <span className="text-slate-400">→</span>
                        <span className={`rounded-full border px-2 py-0.5 ${s.toJob.id === d.currentJob?.id ? 'border-brand-300 bg-brand-50 text-brand-800' : 'border-slate-200 bg-white text-slate-700'}`}>{s.toJob.title}</span>
                        {i < p.steps.length - 1 && <span className="mx-1 text-slate-300">·</span>}
                      </li>
                    ))}
                  </ol>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>

      <Card>
        <CardHeader title="Possible next jobs" description="Jobs one step from yours on a defined path. Possible means the organization has defined the route — the decision to move anybody is made by people, elsewhere." />
        {d.nextJobs.length === 0 ? <EmptyState title="No next jobs defined" description="When a path leads on from your job, it appears here with what that job asks for." /> : (
          <div className="grid grid-cols-1 gap-0 lg:grid-cols-[260px_1fr]">
            <ul className="divide-y divide-slate-100 border-b border-slate-200 lg:border-b-0 lg:border-r">
              {d.nextJobs.map((n) => (
                <li key={n.targetJob.id}>
                  <button type="button" onClick={() => setOpenJob(n.targetJob.id)} className={`flex w-full flex-col items-start gap-1 px-4 py-3 text-left hover:bg-slate-50 ${selected?.targetJob.id === n.targetJob.id ? 'bg-slate-50' : ''}`}>
                    <span className="font-medium text-slate-900">{n.targetJob.title}</span>
                    <ReadinessBadge status={n.status} />
                  </button>
                </li>
              ))}
            </ul>
            <div className="p-4">
              {selected && (
                <div className="space-y-3">
                  <h3 className="text-sm font-semibold text-slate-900">{selected.targetJob.title} — requirements and where you stand</h3>
                  <ReadinessTable readiness={selected} />
                  <div className="flex flex-wrap gap-3 text-sm">
                    <Link className="text-brand-700 underline" to="/hrd/competency">My competencies</Link>
                    <Link className="text-brand-700 underline" to="/hrd/training">My development{selected.development.activeIdpTitle ? ` · ${selected.development.activeIdpTitle}` : ''}{selected.development.openNeeds ? ` · ${selected.development.openNeeds} open need(s)` : ''}</Link>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
