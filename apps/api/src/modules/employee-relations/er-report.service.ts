import { businessToday, validityState, type EmployeeRelationsReportDto, type ErReportQuery } from '@hr/shared';
import type { Prisma } from '@prisma/client';
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
    const [casesByStatus, cases, actions] = await Promise.all([
      prisma.employeeRelationCase.groupBy({ by: ['status'], where: caseWhere, _count: { _all: true }, orderBy: { status: 'asc' } }),
      prisma.employeeRelationCase.findMany({ where: caseWhere, select: { id: true, departmentName: true, createdAt: true } }),
      prisma.disciplinaryAction.findMany({
        where: { status: { in: ['ISSUED', 'ACKNOWLEDGED'] }, case: caseWhere },
        select: { status: true, validUntil: true, issuedDate: true, actionTypeNameSnapshot: true, requiresAcknowledgement: true, acknowledgedAt: true, acknowledgementDueDate: true, case: { select: { id: true, departmentName: true } } },
      }),
    ]);
    const now = businessToday('UTC');
    const active = actions.filter((a) => validityState(a.status, a.validUntil, now) === 'ACTIVE');
    const awaiting = actions.filter((a) => a.requiresAcknowledgement && !a.acknowledgedAt);

    const group = <T>(rows: T[], key: (row: T) => string) => {
      const map = new Map<string, T[]>();
      for (const row of rows) map.set(key(row), [...(map.get(key(row)) ?? []), row]);
      return map;
    };
    const casesByDept = group(cases, (c) => c.departmentName ?? 'Unassigned');
    const actionsByDept = group(actions, (a) => a.case.departmentName ?? 'Unassigned');
    const byType = group(actions, (a) => a.actionTypeNameSnapshot);
    const casesByMonth = group(cases, (c) => c.createdAt.toISOString().slice(0, 7));
    const issuedByMonth = group(actions.filter((a) => a.issuedDate), (a) => a.issuedDate!.slice(0, 7));

    const departments = new Set([...casesByDept.keys(), ...actionsByDept.keys()]);
    const months = new Set([...casesByMonth.keys(), ...issuedByMonth.keys()]);

    return {
      casesByStatus: casesByStatus.map((row) => ({ status: row.status, count: row._count._all })),
      actions: {
        issued: actions.length,
        active: active.length,
        expired: actions.length - active.length,
        awaitingAcknowledgement: awaiting.length,
        overdueAcknowledgement: awaiting.filter((a) => a.acknowledgementDueDate && a.acknowledgementDueDate < now).length,
      },
      byDepartment: [...departments].sort().map((departmentName) => ({
        departmentName,
        cases: casesByDept.get(departmentName)?.length ?? 0,
        issued: actionsByDept.get(departmentName)?.length ?? 0,
        active: (actionsByDept.get(departmentName) ?? []).filter((a) => validityState(a.status, a.validUntil, now) === 'ACTIVE').length,
      })),
      byActionType: [...byType.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([actionTypeName, rows]) => ({
        actionTypeName, issued: rows.length, active: rows.filter((a) => validityState(a.status, a.validUntil, now) === 'ACTIVE').length,
      })),
      byMonth: [...months].sort().map((month) => ({ month, cases: casesByMonth.get(month)?.length ?? 0, issued: issuedByMonth.get(month)?.length ?? 0 })),
    };
  },
};
