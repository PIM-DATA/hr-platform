import type { LucideIcon } from 'lucide-react';
import {
  LayoutDashboard, Users, Network, CalendarCheck, CalendarOff, Target, Award, GraduationCap,
  BriefcaseBusiness, Star, GitBranch, BarChart3, UserCog, ShieldCheck, KeyRound,
  ScrollText, Settings, Workflow, CalendarDays, FileSpreadsheet, FileLock2, Banknote, ShieldAlert, UserPlus, Route, FolderOpen, Table2, Sparkles,
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
  /** Hidden when the named optional feature is disabled on this installation (UX only; the API decides). */
  feature?: 'copilot';
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
      { label: 'Payroll', path: '/hrm/payroll', icon: Banknote, permission: [P.PAYROLL_VIEW_OWN, P.PAYROLL_MANAGE, P.PAYROLL_RUN, P.PAYROLL_APPROVE] },
      { label: 'Employee relations', path: '/hrm/employee-relations', icon: ShieldAlert, permission: [P.EMPLOYEE_RELATIONS_ACKNOWLEDGE, P.EMPLOYEE_RELATIONS_VIEW, P.EMPLOYEE_RELATIONS_MANAGE] },
      { label: 'Performance', path: '/hrm/performance', icon: Target, permission: P.PERFORMANCE_VIEW },
      { label: 'Recruitment', path: '/hrm/recruitment', icon: UserPlus, permission: [P.RECRUITMENT_VIEW, P.RECRUITMENT_MANAGE, P.RECRUITMENT_INTERVIEW] },
      { label: 'Documents', path: '/hrm/documents', icon: FolderOpen, permission: [P.DOCUMENTS_VIEW_OWN, P.DOCUMENTS_VIEW, P.DOCUMENTS_MANAGE] },
      { label: 'Reports', path: '/hrm/reports', icon: Table2, permission: P.REPORTS_VIEW },
    ],
  },
  {
    label: 'HRD',
    items: [
      { label: 'Competency', path: '/hrd/competency', icon: Award, permission: P.COMPETENCY_VIEW },
      { label: 'Training & development', path: '/hrd/training', icon: GraduationCap, permission: [P.TRAINING_VIEW, P.IDP_VIEW] },
      { label: 'Career & talent', path: '/hrd/career', icon: Route, permission: [P.CAREER_VIEW, P.TALENT_VIEW, P.TALENT_MANAGE, P.SUCCESSION_VIEW, P.TALENT_VIEW_REPORTS] },
    ],
  },
  {
    label: 'HROD',
    items: [
      { label: 'Workforce planning', path: '/hrod/workforce', icon: BriefcaseBusiness, permission: [P.WORKFORCE_VIEW, P.WORKFORCE_PLAN, P.WORKFORCE_MANAGE, P.ORG_DESIGN_VIEW, P.ORG_DESIGN_MANAGE] },
      { label: 'Talent', path: '/hrod/talent', icon: Star, comingSoon: true },
      { label: 'Succession', path: '/hrod/succession', icon: GitBranch, comingSoon: true },
    ],
  },
  { label: 'Analytics', items: [{ label: 'Executive dashboard', path: '/analytics/executive', icon: BarChart3, permission: P.ANALYTICS_VIEW_EXECUTIVE }] },
  { label: 'Assistant', items: [{ label: 'HR Copilot', path: '/copilot', icon: Sparkles, permission: P.COPILOT_USE, feature: 'copilot' }] },
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
