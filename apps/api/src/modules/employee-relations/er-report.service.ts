import { MIN_AGGREGATE_GROUP_SIZE, partitionSuppression, suppressedCell, validityState, type AggregateSuppression, type EmployeeRelationsReportDto, type ErReportQuery } from '@hr/shared';
import type { Prisma } from '@prisma/client';
import { businessDateIn, employeeTodays, employeeZones } from '../../services/business-time/business-time';
import { prisma } from '../../lib/prisma';

/**
 * Employee relations reporting — counts only.
 *
 * There is no "most warned employee" anywhere in this shape, and there never will be: a disciplinary record is a
 * confidential operational fact about one person, and turning it into a ranking would stigmatise people the numbers
 * were never meant to describe.
 */
export const erReportService = {
  async report(q: ErReportQuery): Promise<EmployeeRelationsReportDto> {
    const caseWhere: Prisma.EmployeeRelationCaseWhereInput = {
      departmentId: q.departmentId,
      ...(q.from ? { incidentDate: { gte: q.from } } : {}),
      ...(q.to ? { incidentDate: { ...(q.from ? { gte: q.from } : {}), lte: q.to } } : {}),
    };
    // Small-department rule (Task 47): the protected unit is the department's population (current active headcount),
    // partitioned over every department that has a case, independent of the filter so all views agree.
    const K = MIN_AGGREGATE_GROUP_SIZE;
    const periodWhere: Prisma.EmployeeRelationCaseWhereInput = { ...caseWhere, departmentId: undefined };
    const [deptsWithCases, headcounts] = await Promise.all([
      prisma.employeeRelationCase.findMany({ where: periodWhere, select: { departmentId: true, departmentName: true }, distinct: ['departmentId', 'departmentName'] }),
      prisma.employee.groupBy({ by: ['departmentId'], where: { employmentStatus: 'ACTIVE' }, _count: { _all: true }, orderBy: { departmentId: 'asc' } }),
    ]);
    const heads = new Map(headcounts.map((h) => [h.departmentId ?? '', h._count._all]));
    const cellOf = (d: { departmentId: string | null; departmentName: string | null }) => d.departmentName ?? 'Unassigned';
    const population = new Map<string, number>();
    for (const d of deptsWithCases) population.set(cellOf(d), (population.get(cellOf(d)) ?? 0) + (heads.get(d.departmentId ?? '') ?? 0));
    // A department with nobody left in it (or no department) is treated as the smallest possible group.
    const hidden = partitionSuppression([...population.entries()].map(([key, count]) => ({ key, count: Math.max(count, 1) })), K);
    const deptSuppression = (name: string): AggregateSuppression | null => (hidden.get(name) ? suppressedCell(K, hidden.get(name)!) : null);
    if (q.departmentId) {
      const name = deptsWithCases.find((d) => d.departmentId === q.departmentId)?.departmentName ?? null;
      const filtered = name !== null ? deptSuppression(name) : (heads.get(q.departmentId) ?? 0) < K ? suppressedCell(K) : null;
      if (filtered) return { suppression: filtered, casesByStatus: [], actions: null, byDepartment: [], byActionType: [], byMonth: [] };
    }

    const [casesByStatus, cases, actions] = await Promise.all([
      prisma.employeeRelationCase.groupBy({ by: ['status'], where: caseWhere, _count: { _all: true }, orderBy: { status: 'asc' } }),
      prisma.employeeRelationCase.findMany({ where: caseWhere, select: { id: true, employeeId: true, departmentName: true, createdAt: true } }),
      prisma.disciplinaryAction.findMany({
        where: { status: { in: ['ISSUED', 'ACKNOWLEDGED'] }, case: caseWhere },
        select: { employeeId: true, status: true, validUntil: true, issuedDate: true, actionTypeNameSnapshot: true, requiresAcknowledgement: true, acknowledgedAt: true, acknowledgementDueDate: true, case: { select: { id: true, departmentName: true } } },
      }),
    ]);
    // Task 53 (T44-P1-23): validity and acknowledgement deadlines are judged on each subject's own business today, and
    // cases are bucketed by their business month in that zone (this used UTC).
    const [todays, zones] = await Promise.all([employeeTodays(prisma, actions.map((a) => a.employeeId)), employeeZones(prisma, cases.map((c) => c.employeeId))]);
    const now = (a: { employeeId: string }) => todays.get(a.employeeId)!;
    const active = actions.filter((a) => validityState(a.status, a.validUntil, now(a)) === 'ACTIVE');
    const awaiting = actions.filter((a) => a.requiresAcknowledgement && !a.acknowledgedAt);

    const group = <T>(rows: T[], key: (row: T) => string) => {
      const map = new Map<string, T[]>();
      for (const row of rows) map.set(key(row), [...(map.get(key(row)) ?? []), row]);
      return map;
    };
    const casesByDept = group(cases, (c) => c.departmentName ?? 'Unassigned');
    const actionsByDept = group(actions, (a) => a.case.departmentName ?? 'Unassigned');
    const byType = group(actions, (a) => a.actionTypeNameSnapshot);
    const casesByMonth = group(cases, (c) => businessDateIn(c.createdAt, zones.get(c.employeeId) ?? 'UTC').slice(0, 7));
    const issuedByMonth = group(actions.filter((a) => a.issuedDate), (a) => a.issuedDate!.slice(0, 7));

    const departments = new Set([...casesByDept.keys(), ...actionsByDept.keys()]);
    const months = new Set([...casesByMonth.keys(), ...issuedByMonth.keys()]);

    return {
      suppression: null,
      casesByStatus: casesByStatus.map((row) => ({ status: row.status, count: row._count._all })),
      actions: {
        issued: actions.length,
        active: active.length,
        expired: actions.length - active.length,
        awaitingAcknowledgement: awaiting.length,
        overdueAcknowledgement: awaiting.filter((a) => a.acknowledgementDueDate && a.acknowledgementDueDate < now(a)).length,
      },
      byDepartment: [...departments].sort().map((departmentName) => {
        const suppression = deptSuppression(departmentName);
        return {
          departmentName,
          cases: suppression ? null : casesByDept.get(departmentName)?.length ?? 0,
          issued: suppression ? null : actionsByDept.get(departmentName)?.length ?? 0,
          active: suppression ? null : (actionsByDept.get(departmentName) ?? []).filter((a) => validityState(a.status, a.validUntil, now(a)) === 'ACTIVE').length,
          suppression,
        };
      }),
      byActionType: [...byType.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([actionTypeName, rows]) => ({
        actionTypeName, issued: rows.length, active: rows.filter((a) => validityState(a.status, a.validUntil, now(a)) === 'ACTIVE').length,
      })),
      byMonth: [...months].sort().map((month) => ({ month, cases: casesByMonth.get(month)?.length ?? 0, issued: issuedByMonth.get(month)?.length ?? 0 })),
    };
  },
};
