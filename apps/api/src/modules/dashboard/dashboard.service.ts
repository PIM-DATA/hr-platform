import type { DashboardSummary } from '@hr/shared';
import { prisma } from '../../lib/prisma';
import { windowStartIncludingToday } from '../../lib/dates';
import { employeeScopeWhere } from '../employees/employees.scope';
import type { AuthContext } from '../auth/auth.types';

export const NEW_HIRE_WINDOW_DAYS = 30;

/**
 * Operational summary. Every number is computed on the SAME population as the employee list:
 * `employeeScopeWhere(auth)` (SELF / TEAM / ALL) — no dashboard-specific scope logic exists.
 * Four aggregate queries, no employee DTOs are loaded. `now` is injectable for tests.
 */
export async function getDashboardSummary(auth: AuthContext, now: Date = new Date()): Promise<DashboardSummary> {
  const scope = employeeScopeWhere(auth);
  const [total, active, newLast30Days, departments] = await prisma.$transaction([
    prisma.employee.count({ where: scope }),
    prisma.employee.count({ where: { AND: [scope, { employmentStatus: 'ACTIVE' }] } }),
    prisma.employee.count({ where: { AND: [scope, { hireDate: { gte: windowStartIncludingToday(NEW_HIRE_WINDOW_DAYS, now) } }] } }),
    // distinct departmentId across the visible population (departmentId is NOT NULL in the schema; the filter is defensive)
    prisma.employee.findMany({ where: { AND: [scope, { NOT: { departmentId: '' } }] }, select: { departmentId: true }, distinct: ['departmentId'] }),
  ]);
  return {
    employees: { total, active, newLast30Days },
    departments: { represented: departments.length },
    scope: auth.dataScope,
    generatedAt: now.toISOString(),
  };
}
