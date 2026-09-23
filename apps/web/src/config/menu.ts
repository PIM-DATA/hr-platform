import type { LucideIcon } from 'lucide-react';
import {
  LayoutDashboard, Users, Network, CalendarCheck, CalendarOff, Target, Award, GraduationCap,
  Route, BriefcaseBusiness, Star, GitBranch, BarChart3, UserCog, ShieldCheck, KeyRound,
  ScrollText, Settings, Workflow, CalendarDays, FileSpreadsheet, FileLock2,
} from 'lucide-react';
import { PERMISSIONS, type PermissionCode } from '@hr/shared';

export interface MenuItem {
  label: string;
  path: string;
  icon: LucideIcon;
  /** Item is hidden unless the current user has this permission (any of, when an array). */
  permission?: PermissionCode | PermissionCode[];
  /** Not implemented yet → renders ComingSoonPage. */
  comingSoon?: boolean;
}
export interface MenuGroup {
  label?: string;
  items: MenuItem[];
}

const P = PERMISSIONS;

/** Sidebar definition. Adding a module = add an item here + its route. */
export const MENU: MenuGroup[] = [
  { items: [{ label: 'Dashboard', path: '/dashboard', icon: LayoutDashboard, permission: P.DASHBOARD_VIEW }] },
  {
    label: 'People',
    items: [
      { label: 'Employees', path: '/employees', icon: Users, permission: P.EMPLOYEES_VIEW },
      { label: 'Organization', path: '/organization', icon: Network, permission: P.ORGANIZATION_VIEW },
    ],
  },
  {
    label: 'HRM',
    items: [
      { label: 'Attendance', path: '/hrm/attendance', icon: CalendarCheck, permission: [P.ATTENDANCE_VIEW, P.ATTENDANCE_CLOCK] },
      { label: 'Leave', path: '/hrm/leave', icon: CalendarOff, permission: [P.LEAVE_VIEW, P.WORKFLOW_APPROVE] },
      { label: 'Performance', path: '/hrm/performance', icon: Target, comingSoon: true },
    ],
  },
  {
    label: 'HRD',
    items: [
      { label: 'Competency', path: '/hrd/competency', icon: Award, comingSoon: true },
      { label: 'Training', path: '/hrd/training', icon: GraduationCap, comingSoon: true },
      { label: 'IDP', path: '/hrd/idp', icon: Route, comingSoon: true },
    ],
  },
  {
    label: 'HROD',
    items: [
      { label: 'Workforce', path: '/hrod/workforce', icon: BriefcaseBusiness, comingSoon: true },
      { label: 'Talent', path: '/hrod/talent', icon: Star, comingSoon: true },
      { label: 'Succession', path: '/hrod/succession', icon: GitBranch, comingSoon: true },
    ],
  },
  { items: [{ label: 'Analytics', path: '/analytics', icon: BarChart3, comingSoon: true }] },
  {
    label: 'Administration',
    items: [
      { label: 'Users', path: '/admin/users', icon: UserCog, permission: P.USERS_VIEW },
      { label: 'Roles', path: '/admin/roles', icon: ShieldCheck, permission: P.ROLES_VIEW },
      { label: 'Permissions', path: '/admin/permissions', icon: KeyRound, permission: P.ROLES_VIEW },
      { label: 'Audit Logs', path: '/admin/audit-logs', icon: ScrollText, permission: P.AUDIT_VIEW },
      { label: 'Workflows', path: '/admin/workflows', icon: Workflow, permission: P.WORKFLOW_MANAGE_DEFINITIONS },
      { label: 'Leave Settings', path: '/admin/leave-settings', icon: CalendarDays, permission: [P.LEAVE_MANAGE_TYPES, P.LEAVE_MANAGE_POLICIES, P.LEAVE_MANAGE_ENTITLEMENTS, P.CALENDAR_VIEW] },
      { label: 'Onboarding', path: '/admin/onboarding', icon: FileSpreadsheet, permission: P.ONBOARDING_MANAGE },
      { label: 'Privacy', path: '/admin/privacy', icon: FileLock2, permission: [P.PRIVACY_MANAGE_REQUESTS, P.PRIVACY_EXPORT_DATA] },
      { label: 'Settings', path: '/admin/settings', icon: Settings, permission: P.SETTINGS_MANAGE, comingSoon: true },
    ],
  },
];
