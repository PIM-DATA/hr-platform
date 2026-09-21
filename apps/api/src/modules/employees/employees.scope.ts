import type { Prisma } from '@prisma/client';
import { DATA_SCOPES } from '@hr/shared';
import type { AuthContext } from '../auth/auth.types';

/**
 * Data-scope → Prisma WHERE fragment, applied to EVERY employee query (reads and mutations)
 * before pagination — never filtered in JavaScript.
 *   SELF : own record only
 *   TEAM : own record + DIRECT reports (managerId = me); not recursive in Phase 1
 *   ALL  : no restriction
 * A user without a linked employee sees nothing under SELF/TEAM (impossible id match).
 */
export function employeeScopeWhere(auth: AuthContext): Prisma.EmployeeWhereInput {
  if (auth.dataScope === DATA_SCOPES.ALL) return {};
  const me = auth.employeeId ?? '__no_employee__';
  if (auth.dataScope === DATA_SCOPES.TEAM) return { OR: [{ id: me }, { managerId: me }] };
  return { id: me };
}
