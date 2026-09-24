import { nineBoxLabel } from '@hr/shared';
import { Card, CardHeader } from '@/components/ui/Card';
import { Alert } from '@/components/ui/Alert';
import { LoadingBlock } from '@/components/ui/Spinner';
import { useSuccessionReport, useTalentReport } from './talent.api';
import { Stat } from './talent-ui';

const titleCase = (s: string) => s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, ' ');

/** Counts and distributions. Nobody is named, nobody is ranked, and no comment leaves the record it was written on. */
export function TalentReportsPage() {
  const talent = useTalentReport();
  const succession = useSuccessionReport();
  const t = talent.data; const s = succession.data;
  return (
    <div className="space-y-4">
      {(talent.isLoading || succession.isLoading) && <LoadingBlock />}
      {(talent.isError || succession.isError) && <Alert>Could not load the reports.</Alert>}
      {s && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            <Stat label="Open succession plans" value={s.plans.total} />
            <Stat label="With at least one successor" value={s.plans.withSuccessor} />
            <Stat label="With a ready-now successor" value={s.plans.withReadyNow} />
            <Stat label="Without a successor" value={s.plans.withoutSuccessor} />
            <Stat label="Critical, no successor" value={s.criticalWithoutSuccessor} />
          </div>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Breakdown title="Succession by department" rows={s.byDepartment.map((d) => ({ label: d.departmentName, cells: [`${d.plans} plans`, `${d.withSuccessor} covered`, `${d.withoutSuccessor} uncovered`] }))} />
            <Breakdown title="By criticality" rows={s.byCriticality.map((c) => ({ label: titleCase(c.criticality), cells: [`${c.plans} plans`, `${c.withSuccessor} covered`, `${c.withReadyNow} ready now`] }))} />
            <Breakdown title="Successors by readiness" rows={s.candidatesByReadiness.map((r) => ({ label: titleCase(r.readiness), cells: [`${r.count}`] }))} />
          </div>
        </>
      )}
      {t && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Breakdown title="Talent cycle completion" rows={t.cycles.map((c) => ({ label: `${c.name} (${c.status.toLowerCase()})`, cells: [`${c.assigned} assigned`, `${c.submitted} submitted`, c.completionRate === null ? '—' : `${c.completionRate}%`] }))} />
          <Breakdown title="9-box distribution (all cycles)" rows={t.nineBox.map((c) => ({ label: nineBoxLabel(c.cell), cells: [`${c.count}`] }))} />
          <Breakdown title="Potential distribution" rows={t.potentialDistribution.map((p) => ({ label: titleCase(p.level), cells: [`${p.count}`] }))} />
          <Breakdown title="Reviews by department" rows={t.byDepartment.map((d) => ({ label: d.departmentName, cells: [`${d.reviews} reviews`, `${d.submitted} submitted`] }))} />
          <Breakdown title="Talent pools" rows={t.pools.map((p) => ({ label: p.name, cells: [`${p.activeMembers} active`] }))} />
        </div>
      )}
      <p className="text-xs text-slate-500">Aggregate only. No name, no individual cell, no comment, no ranking, no "best successor". Coverage is factual: a position either has a nominated successor or it does not.</p>
    </div>
  );
}

const Breakdown = ({ title, rows }: { title: string; rows: { label: string; cells: string[] }[] }) => (
  <Card>
    <CardHeader title={title} />
    {rows.length === 0 ? <p className="p-4 text-sm text-slate-500">Nothing yet.</p> : <ul className="divide-y divide-slate-100">{rows.map((r) => <li key={r.label} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 text-sm"><span className="text-slate-800">{r.label}</span><span className="flex flex-wrap gap-3 text-xs tabular-nums text-slate-500">{r.cells.map((c, i) => <span key={i}>{c}</span>)}</span></li>)}</ul>}
  </Card>
);
