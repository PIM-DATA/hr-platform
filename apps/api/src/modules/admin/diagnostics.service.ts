import type { AdminDiagnosticsDto, AdminSettingsAreaDto } from '@hr/shared';
import { PERMISSIONS } from '@hr/shared';
import { env } from '../../config/env';
import { prisma } from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { copilotStatus } from '../copilot/provider';
import { documentStorage, documentStorageConfigured } from '../documents/storage';

/**
 * Operational facts for the administration hub. Every value is a boolean, an enum, a small number or a short
 * label that the deployment already publishes on the readiness probe. Nothing here can carry a secret: no
 * connection string, no storage path, no API key, no cookie name, no host and no origin. Values set by the
 * deployment are reported so an administrator can see how the service is running, and are never editable here.
 */
async function databaseReachable(): Promise<boolean> {
  try { await prisma.$queryRaw`SELECT 1`; return true; } catch (err) { logger.error({ err }, 'admin diagnostics: database unreachable'); return false; }
}
async function storageHealth(): Promise<'ok' | 'unavailable' | 'disabled'> {
  if (!documentStorageConfigured()) return 'disabled';
  try { return (await documentStorage().health(!!(await prisma.documentVersion.findFirst({ select: { id: true } })))).ok ? 'ok' : 'unavailable'; } catch { return 'unavailable'; }
}

export const adminDiagnosticsService = {
  async get(): Promise<AdminDiagnosticsDto> {
    const [database, storage] = await Promise.all([databaseReachable(), storageHealth()]);
    const copilot = copilotStatus();
    return {
      environment: env.NODE_ENV,
      version: env.APP_VERSION ?? null,
      database: database ? 'ok' : 'unavailable',
      secureCookies: env.COOKIE_SECURE,
      sessionTtlHours: env.SESSION_TTL_HOURS,
      documents: { enabled: env.DOCUMENTS_ENABLED, storage },
      // Whether a key is present, never the key, the provider endpoint or any part of either.
      copilot: { enabled: copilot === 'configured', provider: env.COPILOT_PROVIDER, model: env.COPILOT_MODEL, configured: !!env.COPILOT_API_KEY },
      notifications: { inApp: true, externalDelivery: false },
      generatedAt: new Date().toISOString(),
    };
  },

  /**
   * What this installation can actually administer, area by area, with the permission that opens each one. The hub
   * renders this rather than a hand-written card list, so a capability cannot drift out of step with the code: an
   * area is CONFIGURABLE only where a real screen writes it, READ_ONLY where the app shows but does not change it,
   * DEPLOYMENT_MANAGED where the value comes from the environment, and NOT_AVAILABLE where nothing exists yet.
   */
  areas(): AdminSettingsAreaDto[] {
    const P = PERMISSIONS;
    return [
      { key: 'users', name: 'Users', description: 'Login accounts, the roles each holds, activation and password reset links.', capability: 'CONFIGURABLE', path: '/admin/users', permissions: [P.USERS_VIEW], note: null },
      { key: 'roles', name: 'Roles and permissions', description: 'Roles, the permissions each grants, and the read-only matrix by module.', capability: 'CONFIGURABLE', path: '/admin/roles', permissions: [P.ROLES_VIEW], note: null },
      { key: 'organization', name: 'Organizations and structure', description: 'Organizations, departments, jobs and positions. An organization carries the IANA timezone that decides its business date.', capability: 'CONFIGURABLE', path: '/organization', permissions: [P.ORGANIZATION_VIEW], note: 'Changing a timezone affects how future business dates are derived. Dates already recorded are never rewritten.' },
      { key: 'employees', name: 'Employee master', description: 'The employee record every other module reads.', capability: 'CONFIGURABLE', path: '/employees', permissions: [P.EMPLOYEES_VIEW], note: null },
      { key: 'workflow-definitions', name: 'Workflow definitions', description: 'Approval workflows per module and entity. A version is immutable; editing means a new version.', capability: 'CONFIGURABLE', path: '/admin/workflows', permissions: [P.WORKFLOW_MANAGE_DEFINITIONS], note: null },
      { key: 'workflow-monitor', name: 'Workflow monitor', description: 'Every approval instance, what it is waiting on and for how long. Read only.', capability: 'READ_ONLY', path: '/admin/workflow-monitor', permissions: [P.WORKFLOW_VIEW_ALL], note: 'Metadata only. Reading an approver comment or opening the record needs that module’s own permission.' },
      { key: 'payroll-components', name: 'Pay components', description: 'Earnings and deductions available to payroll. System components are written by the engine and cannot be redefined.', capability: 'CONFIGURABLE', path: '/hrm/payroll/components', permissions: [P.PAYROLL_MANAGE], note: null },
      { key: 'payroll-recurring', name: 'Recurring pay items', description: 'Standing earnings and deductions per employee, with effective dates.', capability: 'CONFIGURABLE', path: '/hrm/payroll/recurring', permissions: [P.PAYROLL_MANAGE], note: 'Edits apply to payroll calculated afterwards. A closed run is never recalculated.' },
      { key: 'payroll-policies', name: 'Payroll policies', description: 'Divisors, proration bases, deduction switches and the approval workflow per organization.', capability: 'CONFIGURABLE', path: '/hrm/payroll/policies', permissions: [P.PAYROLL_MANAGE], note: 'The divisor and hours per day are customer decisions; nothing in the engine assumes a value.' },
      { key: 'payroll-periods', name: 'Payroll periods', description: 'Salary and attendance windows, payment date and the run lifecycle.', capability: 'CONFIGURABLE', path: '/hrm/payroll/periods', permissions: [P.PAYROLL_MANAGE, P.PAYROLL_RUN, P.PAYROLL_APPROVE], note: 'A closed period cannot be reopened.' },
      { key: 'leave-settings', name: 'Leave settings', description: 'Leave types, policies, entitlements, work calendars and holidays.', capability: 'CONFIGURABLE', path: '/admin/leave-settings', permissions: [P.LEAVE_MANAGE_TYPES, P.LEAVE_MANAGE_POLICIES, P.LEAVE_MANAGE_ENTITLEMENTS, P.CALENDAR_VIEW], note: null },
      { key: 'data-import', name: 'Employee data import', description: 'Create a customer’s organization structure and employees from one Excel workbook.', capability: 'CONFIGURABLE', path: '/admin/onboarding', permissions: [P.ONBOARDING_MANAGE], note: 'The workbook is never stored.' },
      { key: 'privacy', name: 'Privacy', description: 'The data-subject request register and the personal-data export tool.', capability: 'CONFIGURABLE', path: '/admin/privacy', permissions: [P.PRIVACY_MANAGE_REQUESTS, P.PRIVACY_EXPORT_DATA], note: 'Retention is manual: there is no automated deletion or anonymisation engine.' },
      { key: 'audit', name: 'Audit log', description: 'Who changed what, and when. Append-only and never edited or deleted.', capability: 'READ_ONLY', path: '/admin/audit-logs', permissions: [P.AUDIT_VIEW], note: null },
      { key: 'diagnostics', name: 'Service status', description: 'Environment, version, database readiness and which optional features are switched on.', capability: 'READ_ONLY', path: '/admin/settings', permissions: [P.SETTINGS_MANAGE, P.USERS_VIEW, P.ROLES_VIEW, P.AUDIT_VIEW], note: 'Operational facts only. This is not monitoring and does not replace it.' },
      { key: 'notifications', name: 'Notification delivery', description: 'Notifications are delivered in the application. There is no email, SMS or webhook delivery to configure.', capability: 'NOT_AVAILABLE', path: null, permissions: [], note: 'External delivery is not implemented, so there is nothing to switch on here.' },
      { key: 'security', name: 'Sign-in security', description: 'Cookie security, session lifetime, sign-in attempt limits and rate limits.', capability: 'DEPLOYMENT_MANAGED', path: null, permissions: [], note: 'Set by whoever runs the service, through the environment. Multi-factor sign-in and single sign-on are not implemented.' },
      { key: 'storage', name: 'Document storage', description: 'Where document files are kept and how large they may be.', capability: 'DEPLOYMENT_MANAGED', path: null, permissions: [], note: 'The storage location is part of the deployment and is never shown or edited in the application.' },
      { key: 'copilot', name: 'HR copilot provider', description: 'Whether the copilot is switched on, and which model it uses.', capability: 'DEPLOYMENT_MANAGED', path: null, permissions: [], note: 'The provider credential lives in the environment. It is never displayed or editable here.' },
    ];
  },
};
