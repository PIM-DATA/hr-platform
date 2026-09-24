import { NINE_BOX_CELLS, TALENT_BUCKETS, SUCCESSION_CRITICALITIES, SUCCESSOR_READINESS, type SuccessionReportDto, type TalentReportDto } from '@hr/shared';
import { prisma } from '../../lib/prisma';

/** Counts and distributions. No names, no cells per person, no comments, no ordering of people. */
export const talentReportService = {
  async talent(): Promise<TalentReportDto> {
    const cycles = await prisma.talentReviewCycle.findMany({ select: { id: true, name: true, status: true, reviews: { select: { status: true, departmentNameSnapshot: true, nineBoxCell: true, potentialLevel: true } } }, orderBy: { periodStart: 'desc' } });
    const all = cycles.flatMap((c) => c.reviews);
    const dept = new Map<string, { reviews: number; submitted: number }>();
    for (const r of all) { const k = r.departmentNameSnapshot ?? 'Unassigned'; const d = dept.get(k) ?? { reviews: 0, submitted: 0 }; d.reviews += 1; if (r.status !== 'ASSIGNED') d.submitted += 1; dept.set(k, d); }
    const pools = await prisma.talentPool.findMany({ where: { isActive: true }, select: { name: true, _count: { select: { members: { where: { status: 'ACTIVE' } } } } }, orderBy: { name: 'asc' } });
    return {
      cycles: cycles.map((c) => { const assigned = c.reviews.length; const submitted = c.reviews.filter((r) => r.status !== 'ASSIGNED').length; return { id: c.id, name: c.name, status: c.status, assigned, submitted, finalized: c.reviews.filter((r) => r.status === 'FINALIZED').length, completionRate: assigned ? Math.round((submitted / assigned) * 1000) / 10 : null }; }),
      nineBox: NINE_BOX_CELLS.map((cell) => ({ cell, count: all.filter((r) => r.status !== 'ASSIGNED' && r.nineBoxCell === cell).length })),
      potentialDistribution: TALENT_BUCKETS.map((level) => ({ level, count: all.filter((r) => r.status !== 'ASSIGNED' && r.potentialLevel === level).length })),
      byDepartment: [...dept.entries()].map(([departmentName, v]) => ({ departmentName, ...v })).sort((a, b) => b.reviews - a.reviews),
      pools: pools.map((p) => ({ name: p.name, activeMembers: p._count.members })),
    };
  },

  async succession(): Promise<SuccessionReportDto> {
    const plans = await prisma.successionPlan.findMany({ where: { status: { not: 'CLOSED' } }, select: { status: true, criticality: true, departmentNameSnapshot: true, candidates: { where: { status: 'ACTIVE' }, select: { readiness: true } } } });
    const has = (p: (typeof plans)[number]) => p.candidates.length > 0;
    const ready = (p: (typeof plans)[number]) => p.candidates.some((c) => c.readiness === 'READY_NOW');
    const dept = new Map<string, { plans: number; withSuccessor: number; withoutSuccessor: number }>();
    for (const p of plans) { const k = p.departmentNameSnapshot ?? 'Unassigned'; const d = dept.get(k) ?? { plans: 0, withSuccessor: 0, withoutSuccessor: 0 }; d.plans += 1; if (has(p)) d.withSuccessor += 1; else d.withoutSuccessor += 1; dept.set(k, d); }
    const candidates = plans.flatMap((p) => p.candidates);
    return {
      plans: { total: plans.length, active: plans.filter((p) => p.status === 'ACTIVE').length, withSuccessor: plans.filter(has).length, withReadyNow: plans.filter(ready).length, withoutSuccessor: plans.filter((p) => !has(p)).length },
      byDepartment: [...dept.entries()].map(([departmentName, v]) => ({ departmentName, ...v })).sort((a, b) => b.plans - a.plans),
      byCriticality: SUCCESSION_CRITICALITIES.map((criticality) => { const ps = plans.filter((p) => p.criticality === criticality); return { criticality, plans: ps.length, withSuccessor: ps.filter(has).length, withReadyNow: ps.filter(ready).length }; }),
      candidatesByReadiness: SUCCESSOR_READINESS.map((readiness) => ({ readiness, count: candidates.filter((c) => c.readiness === readiness).length })),
      criticalWithoutSuccessor: plans.filter((p) => p.criticality === 'CRITICAL' && !has(p)).length,
    };
  },
};
