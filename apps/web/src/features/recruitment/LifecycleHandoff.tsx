import { useState } from 'react';
import { Link } from 'react-router-dom';
import { PERMISSIONS } from '@hr/shared';
import { Button } from '@/components/ui/Button';
import { useAuth } from '@/hooks/useAuth';
import { useOnboardingPlans, useProbationCases } from '@/features/lifecycle/lifecycle.api';
import { CreatePlanModal } from '@/features/lifecycle/OnboardingPage';
import { CreateCaseModal } from '@/features/lifecycle/ProbationPage';
import { LifecycleBadge } from '@/features/lifecycle/lifecycle-ui';

/**
 * The explicit handoff after a hire: the employee record exists, nothing else was created. Whoever manages
 * onboarding or probation can start each one here, through the same lifecycle dialogs and API as the lifecycle
 * pages. The lists are the lifecycle module's own (filtered by employee, under its view permission), so the
 * state shown is the module's state, never a copy. Nothing is created automatically.
 */
const OPEN_PLAN = ['DRAFT', 'ACTIVE']; const OPEN_CASE = ['ACTIVE', 'PENDING_REVIEW', 'EXTENDED'];
export function LifecycleHandoff({ employeeId, employeeName }: { employeeId: string; employeeName: string }) {
  const { hasPermission } = useAuth();
  const onbView = hasPermission(PERMISSIONS.ONBOARDING_VIEW) || hasPermission(PERMISSIONS.ONBOARDING_MANAGE);
  const probView = hasPermission(PERMISSIONS.PROBATION_VIEW) || hasPermission(PERMISSIONS.PROBATION_MANAGE);
  const plans = useOnboardingPlans({ employeeId, pageSize: 5 }, onbView);
  const cases = useProbationCases({ employeeId, pageSize: 5 }, probView);
  const [creating, setCreating] = useState<'onboarding' | 'probation' | null>(null);
  if (!onbView && !probView) return null;
  const plan = plans.data?.data.find((p) => OPEN_PLAN.includes(p.status)) ?? plans.data?.data[0] ?? null;
  const kase = cases.data?.data.find((c) => OPEN_CASE.includes(c.status)) ?? cases.data?.data[0] ?? null;
  const planOpen = !!plan && OPEN_PLAN.includes(plan.status); const caseOpen = !!kase && OPEN_CASE.includes(kase.status);
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm" data-testid="lifecycle-handoff">
      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Next steps for {employeeName}</div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {onbView && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-slate-200 bg-white p-3">
            <span>Onboarding<span className="block text-xs text-slate-500">{plans.isLoading ? 'Checking…' : plan ? <LifecycleBadge status={plan.status} /> : 'Not started'}</span></span>
            {plan ? <Link className="text-xs text-brand-700 underline" to={`/hrm/lifecycle/onboarding?open=${plan.id}`}>View onboarding</Link> : hasPermission(PERMISSIONS.ONBOARDING_MANAGE) && !plans.isLoading && <Button size="sm" onClick={() => setCreating('onboarding')}>Start onboarding</Button>}
          </div>
        )}
        {probView && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-slate-200 bg-white p-3">
            <span>Probation<span className="block text-xs text-slate-500">{cases.isLoading ? 'Checking…' : kase ? <LifecycleBadge status={kase.status} /> : 'Not created'}</span></span>
            {kase ? <Link className="text-xs text-brand-700 underline" to={`/hrm/lifecycle/probation?open=${kase.id}`}>View probation</Link> : hasPermission(PERMISSIONS.PROBATION_MANAGE) && !cases.isLoading && <Button size="sm" variant="secondary" onClick={() => setCreating('probation')}>Open probation case</Button>}
          </div>
        )}
      </div>
      {planOpen || caseOpen ? null : <p className="mt-2 text-xs text-slate-400">Each step is an explicit action with the lifecycle module's own rules (templates, policies, reviewer). Nothing is created automatically.</p>}
      {creating === 'onboarding' && <CreatePlanModal presetEmployeeId={employeeId} onClose={() => setCreating(null)} onCreated={() => setCreating(null)} />}
      {creating === 'probation' && <CreateCaseModal presetEmployeeId={employeeId} onClose={() => setCreating(null)} onCreated={() => setCreating(null)} />}
    </div>
  );
}
