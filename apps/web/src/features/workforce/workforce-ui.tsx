import { Outlet, useSearchParams } from 'react-router-dom';
import { PERMISSIONS, type HeadcountDeltaClass } from '@hr/shared';
import { PageHeader } from '@/components/layout/PageHeader';
import { Tabs } from '@/components/ui/Tabs';
import { Select } from '@/components/ui/Select';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { useAuth } from '@/hooks/useAuth';
import { useWorkforceCycles } from './workforce.api';

export const titleCase = (s: string) => s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, ' ');
const CLASS_LABEL: Record<HeadcountDeltaClass, { label: string; tone: 'success' | 'neutral' | 'warning' }> = { EXPANSION: { label: 'Expansion', tone: 'success' }, NO_CHANGE: { label: 'No change', tone: 'neutral' }, REDUCTION_PLANNED: { label: 'Reduction planned', tone: 'warning' } };
export function DeltaBadge({ classification }: { classification: HeadcountDeltaClass }) { const c = CLASS_LABEL[classification]; return <StatusBadge status={c.label} tone={c.tone} />; }
export function Delta({ value }: { value: number }) { return <span className={`tabular-nums font-medium ${value > 0 ? 'text-emerald-700' : value < 0 ? 'text-amber-700' : 'text-slate-500'}`}>{value > 0 ? `+${value}` : value}</span>; }
export function CycleStatusBadge({ status }: { status: string }) { const tone = status === 'DRAFT' ? 'neutral' : status === 'ACTIVE' ? 'info' : status === 'FINALIZED' ? 'success' : 'neutral'; return <StatusBadge status={titleCase(status)} tone={tone} />; }
export function Stat({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return <div className="rounded-lg border border-slate-200 bg-white p-4"><div className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</div><div className="mt-1 text-2xl font-semibold tabular-nums text-slate-900">{value}</div>{hint && <div className="mt-0.5 text-xs text-slate-400">{hint}</div>}</div>;
}

/** Tab visibility follows capability; the API enforces the same. */
export function useWorkforceTabs() {
  const { hasPermission } = useAuth();
  const view = hasPermission(PERMISSIONS.WORKFORCE_VIEW) || hasPermission(PERMISSIONS.WORKFORCE_PLAN) || hasPermission(PERMISSIONS.WORKFORCE_MANAGE);
  const design = hasPermission(PERMISSIONS.ORG_DESIGN_VIEW) || hasPermission(PERMISSIONS.ORG_DESIGN_MANAGE);
  return [
    view && { label: 'Dashboard', to: '/hrod/workforce', end: true },
    view && { label: 'Planning cycles', to: '/hrod/workforce/cycles' },
    view && { label: 'Headcount plan', to: '/hrod/workforce/plan' },
    design && { label: 'Organization design', to: '/hrod/workforce/design' },
    view && { label: 'Vacancies', to: '/hrod/workforce/vacancies' },
    (view || design) && { label: 'Reports', to: '/hrod/workforce/reports' },
  ].filter(Boolean) as { label: string; to: string; end?: boolean }[];
}
export function WorkforceLayout() {
  const tabs = useWorkforceTabs();
  return (
    <>
      <PageHeader title="Workforce planning" description="Planned headcount and target organization beside the live one. Numbers and deltas are facts; hiring, moves and restructures happen only through their own modules when a person decides." />
      {tabs.length > 1 && <div className="mb-5"><Tabs items={tabs} /></div>}
      <Outlet />
    </>
  );
}

/** A cycle picker shared by the plan screens, kept in the URL so tabs agree on which plan is open. */
export function useSelectedCycle() {
  const [params, setParams] = useSearchParams();
  const cycles = useWorkforceCycles({ page: 1, pageSize: 100 });
  const list = cycles.data?.data ?? [];
  const fromUrl = params.get('cycle');
  const selected = fromUrl && list.some((c) => c.id === fromUrl) ? fromUrl : (list.find((c) => c.status === 'DRAFT' || c.status === 'ACTIVE') ?? list[0])?.id ?? null;
  const set = (id: string) => { const next = new URLSearchParams(params); if (id) next.set('cycle', id); else next.delete('cycle'); setParams(next, { replace: true }); };
  return { cycles: list, loading: cycles.isLoading, selected, cycle: list.find((c) => c.id === selected) ?? null, set };
}
export function CyclePicker({ value, onChange, cycles }: { value: string | null; onChange: (id: string) => void; cycles: { id: string; code: string; name: string; status: string }[] }) {
  return <Select label="Planning cycle" options={cycles.map((c) => ({ value: c.id, label: `${c.name} (${c.code}) · ${titleCase(c.status)}` }))} placeholder="Live workforce (no plan)" value={value ?? ''} onChange={(e) => onChange(e.target.value)} />;
}
