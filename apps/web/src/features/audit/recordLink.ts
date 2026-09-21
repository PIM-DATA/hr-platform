import { PERMISSIONS, type PermissionCode } from '@hr/shared';

/** Maps an audited record to an existing page. Returns null when there is no suitable route. */
export function recordLink(recordType: string, recordId: string | null): { to: string; permission: PermissionCode } | null {
  if (!recordId) return null;
  switch (recordType) {
    case 'Employee': return { to: `/employees/${recordId}`, permission: PERMISSIONS.EMPLOYEES_VIEW };
    case 'Role': return { to: `/admin/roles/${recordId}`, permission: PERMISSIONS.ROLES_VIEW };
    case 'User': return { to: '/admin/users', permission: PERMISSIONS.USERS_VIEW }; // no user detail route; list page
    case 'Organization': return { to: '/organization/organizations', permission: PERMISSIONS.ORGANIZATION_VIEW };
    case 'Department': return { to: '/organization/departments', permission: PERMISSIONS.ORGANIZATION_VIEW };
    case 'Job': return { to: '/organization/jobs', permission: PERMISSIONS.ORGANIZATION_VIEW };
    case 'Position': return { to: '/organization/positions', permission: PERMISSIONS.ORGANIZATION_VIEW };
    default: return null;
  }
}
