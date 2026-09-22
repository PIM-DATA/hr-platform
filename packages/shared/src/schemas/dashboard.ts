/**
 * Dashboard KPI definitions (single source for backend, frontend, tests and README):
 *  employees.total          employees visible in the caller's data scope, any employment status
 *  employees.active         …of those, employmentStatus = ACTIVE
 *  employees.newLast30Days  …of those, hireDate within the last 30 calendar days including today (UTC day boundaries)
 *  departments.represented  DISTINCT departmentId across the visible employees (not the department master count)
 */
export interface DashboardSummary {
  employees: { total: number; active: number; newLast30Days: number };
  departments: { represented: number };
  /** Effective employee data scope the numbers were computed with: SELF | TEAM | ALL */
  scope: string;
  generatedAt: string;
}

export const DATA_SCOPE_LABELS: Record<string, string> = { SELF: 'My profile', TEAM: 'My team', ALL: 'All employees' };
