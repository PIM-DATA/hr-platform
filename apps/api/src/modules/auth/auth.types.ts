import type { DataScope } from '@hr/shared';

/** Attached to req.auth by the authenticate middleware for every valid session. */
export interface AuthContext {
  userId: string;
  email: string;
  employeeId: string | null;
  roles: string[];        // role codes, e.g. ['HR_ADMIN']
  permissions: string[];  // permission codes, e.g. ['employees.view']
  dataScope: DataScope;   // widest scope across roles
  sessionId: string;
  csrfToken: string;
}
