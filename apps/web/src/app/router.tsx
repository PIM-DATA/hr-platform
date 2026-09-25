import { createBrowserRouter, Navigate } from 'react-router-dom';
import { PERMISSIONS } from '@hr/shared';
import { AppShell } from '@/components/layout/AppShell';
import { RequireAuth } from '@/components/guards/RequireAuth';
import { RequirePermission } from '@/components/guards/PermissionGuard';
import { LoginPage } from '@/features/auth/LoginPage';
import { DashboardPage } from '@/features/dashboard/DashboardPage';
import { ComingSoonPage } from '@/features/coming-soon/ComingSoonPage';
import { UserListPage } from '@/features/users/UserListPage';
import { RoleListPage } from '@/features/roles/RoleListPage';
import { RoleDetailPage } from '@/features/roles/RoleDetailPage';
import { PermissionMatrixPage } from '@/features/roles/PermissionMatrixPage';
import { OrganizationLayout } from '@/features/organization/OrganizationLayout';
import { OrgTreePage } from '@/features/organization/OrgTreePage';
import { OrganizationsPage } from '@/features/organization/OrganizationsPage';
import { DepartmentsPage } from '@/features/organization/DepartmentsPage';
import { JobsPage } from '@/features/organization/JobsPage';
import { PositionsPage } from '@/features/organization/PositionsPage';
import { EmployeeListPage } from '@/features/employees/EmployeeListPage';
import { EmployeeDetailPage } from '@/features/employees/EmployeeDetailPage';
import { AuditLogPage } from '@/features/audit/AuditLogPage';
import { WorkflowDefinitionsPage } from '@/features/workflow/WorkflowDefinitionsPage';
import { LeaveSettingsLayout } from '@/features/leave-settings/LeaveSettingsLayout';
import { LeaveTypesPage } from '@/features/leave-settings/LeaveTypesPage';
import { PoliciesPage } from '@/features/leave-settings/PoliciesPage';
import { CalendarsPage } from '@/features/leave-settings/CalendarsPage';
import { EntitlementsPage } from '@/features/leave-settings/EntitlementsPage';
import { LeaveLayout } from '@/features/leave/LeaveLayout';
import { MyLeavePage } from '@/features/leave/MyLeavePage';
import { ApprovalsPage } from '@/features/leave/ApprovalsPage';
import { TeamLeavePage } from '@/features/leave/TeamLeavePage';
import { AllRequestsPage } from '@/features/leave/AllRequestsPage';
import { ReportsPage } from '@/features/leave/ReportsPage';
import { NotificationsPage } from '@/features/notifications/NotificationsPage';
import { OnboardingPage } from '@/features/onboarding/OnboardingPage';
import { AccountSecurityPage } from '@/features/account/AccountSecurityPage';
import { ResetPasswordPage } from '@/features/account/ResetPasswordPage';
import { PrivacyLayout } from '@/features/privacy/PrivacyLayout';
import { PrivacyRequestsPage } from '@/features/privacy/PrivacyRequestsPage';
import { DataExportPage } from '@/features/privacy/DataExportPage';
import { AttendanceLayout } from '@/features/attendance/attendance-ui';
import { MyAttendancePage } from '@/features/attendance/MyAttendancePage';
import { DailyAttendancePage } from '@/features/attendance/DailyAttendancePage';
import { SchedulePage } from '@/features/attendance/SchedulePage';
import { ShiftsPage } from '@/features/attendance/ShiftsPage';
import { CorrectionsPage } from '@/features/attendance/CorrectionsPage';
import { AttendanceReportsPage } from '@/features/attendance/AttendanceReportsPage';
import { OvertimePage } from '@/features/attendance/OvertimePage';
import { OvertimePoliciesPage } from '@/features/attendance/OvertimePoliciesPage';
import { PayrollLayout } from '@/features/payroll/payroll-ui';
import { MyPayslipsPage } from '@/features/payroll/MyPayslipsPage';
import { PeriodsPage } from '@/features/payroll/PeriodsPage';
import { CompensationPage } from '@/features/payroll/CompensationPage';
import { PayComponentsPage } from '@/features/payroll/PayComponentsPage';
import { RecurringItemsPage } from '@/features/payroll/RecurringItemsPage';
import { PayrollPoliciesPage } from '@/features/payroll/PayrollPoliciesPage';
import { PerformanceLayout } from '@/features/performance/performance-ui';
import { MyPerformancePage } from '@/features/performance/MyPerformancePage';
import { TeamReviewsPage } from '@/features/performance/TeamReviewsPage';
import { CyclesPage } from '@/features/performance/CyclesPage';
import { KpiLibraryPage } from '@/features/performance/KpiLibraryPage';
import { PerformanceReportsPage } from '@/features/performance/PerformanceReportsPage';
import { CompetencyLayout } from '@/features/competency/competency-ui';
import { MyCompetenciesPage } from '@/features/competency/MyCompetenciesPage';
import { TeamAssessmentsPage } from '@/features/competency/TeamAssessmentsPage';
import { CompetencyLibraryPage } from '@/features/competency/CompetencyLibraryPage';
import { ScalesPage } from '@/features/competency/ScalesPage';
import { JobProfilesPage } from '@/features/competency/JobProfilesPage';
import { CompetencyCyclesPage } from '@/features/competency/CompetencyCyclesPage';
import { SkillGapReportPage } from '@/features/competency/SkillGapReportPage';
import { TrainingLayout } from '@/features/training/training-ui';
import { MyDevelopmentPage } from '@/features/training/MyDevelopmentPage';
import { TeamDevelopmentPage } from '@/features/training/TeamDevelopmentPage';
import { TrainingNeedsPage } from '@/features/training/TrainingNeedsPage';
import { CoursesPage } from '@/features/training/CoursesPage';
import { SessionsPage } from '@/features/training/SessionsPage';
import { IdpsPage } from '@/features/training/IdpsPage';
import { TrainingReportsPage } from '@/features/training/TrainingReportsPage';
import { ErLayout } from '@/features/employee-relations/er-ui';
import { MyRecordsPage } from '@/features/employee-relations/MyRecordsPage';
import { ApprovalsPage as ErApprovalsPage } from '@/features/employee-relations/ApprovalsPage';
import { CasesPage as ErCasesPage } from '@/features/employee-relations/CasesPage';
import { ActionsPage as ErActionsPage } from '@/features/employee-relations/ActionsPage';
import { ActionTypesPage } from '@/features/employee-relations/ActionTypesPage';
import { ErReportsPage } from '@/features/employee-relations/ErReportsPage';
import { RecruitmentLayout } from '@/features/recruitment/recruitment-ui';
import { RecruitmentDashboardPage } from '@/features/recruitment/DashboardPage';
import { RecruitmentApprovalsPage } from '@/features/recruitment/ApprovalsPage';
import { RequisitionsPage } from '@/features/recruitment/RequisitionsPage';
import { OpeningsPage } from '@/features/recruitment/OpeningsPage';
import { CandidatesPage } from '@/features/recruitment/CandidatesPage';
import { ApplicationsPage } from '@/features/recruitment/ApplicationsPage';
import { InterviewsPage } from '@/features/recruitment/InterviewsPage';
import { OffersPage } from '@/features/recruitment/OffersPage';
import { RecruitmentReportsPage } from '@/features/recruitment/ReportsPage';
import { TalentLayout } from '@/features/talent/talent-ui';
import { MyCareerPage } from '@/features/talent/MyCareerPage';
import { TeamCareerPage } from '@/features/talent/TeamCareerPage';
import { CareerPathsPage } from '@/features/talent/CareerPathsPage';
import { TalentReviewsPage } from '@/features/talent/TalentReviewsPage';
import { TalentPoolsPage } from '@/features/talent/TalentPoolsPage';
import { SuccessionPage } from '@/features/talent/SuccessionPage';
import { TalentReportsPage } from '@/features/talent/TalentReportsPage';
import { ExecutiveDashboardPage } from '@/features/analytics/ExecutiveDashboardPage';
import { CopilotPage } from '@/features/copilot/CopilotPage';
import { WorkforceLayout } from '@/features/workforce/workforce-ui';
import { WorkforceDashboardPage } from '@/features/workforce/DashboardPage';
import { CyclesPage as WorkforceCyclesPage } from '@/features/workforce/CyclesPage';
import { HeadcountPlanPage } from '@/features/workforce/HeadcountPlanPage';
import { OrgDesignPage } from '@/features/workforce/OrgDesignPage';
import { VacanciesPage } from '@/features/workforce/VacanciesPage';
import { WorkforceReportsPage } from '@/features/workforce/ReportsPage';
import { EngagementLayout } from '@/features/engagement/engagement-ui';
import { MySurveysPage } from '@/features/engagement/MySurveysPage';
import { TeamEngagementPage } from '@/features/engagement/TeamPage';
import { EngagementDashboardPage } from '@/features/engagement/DashboardPage';
import { SurveysPage as EngagementSurveysPage } from '@/features/engagement/SurveysPage';
import { QuestionBankPage } from '@/features/engagement/QuestionBankPage';
import { EngagementCommentsPage, EngagementParticipationPage, EngagementReportsPage, EngagementResultsPage } from '@/features/engagement/ResultsPage';
import { LifecycleLayout } from '@/features/lifecycle/lifecycle-ui';
import { MyLifecyclePage } from '@/features/lifecycle/MyLifecyclePage';
import { LifecycleDashboardPage } from '@/features/lifecycle/DashboardPage';
import { OnboardingPage as LifecycleOnboardingPage } from '@/features/lifecycle/OnboardingPage';
import { ProbationPage } from '@/features/lifecycle/ProbationPage';
import { OffboardingPage } from '@/features/lifecycle/OffboardingPage';
import { TemplatesPage as LifecycleTemplatesPage } from '@/features/lifecycle/TemplatesPage';
import { LifecycleReportsPage } from '@/features/lifecycle/ReportsPage';
import { DocumentsLayout } from '@/features/documents/documents-ui';
import { MyDocumentsPage } from '@/features/documents/MyDocumentsPage';
import { DocumentCenterPage, DocumentCategoriesPage } from '@/features/documents/DocumentCenterPage';
import { ReportsLayout, SavedReportsPage, ReportBuilderPage } from '@/features/reports/ReportCenterPage';
import { MENU } from '@/config/menu';

// Every menu item that is not implemented yet renders ComingSoonPage — behind its permission when it has one.
const comingSoonRoutes = MENU.flatMap((group) => group.items)
  .filter((item) => item.comingSoon)
  .map((item) => {
    const page = <ComingSoonPage title={item.label} />;
    return item.permission
      ? { element: <RequirePermission permission={item.permission} />, children: [{ path: item.path.replace(/^\//, ''), element: page }] }
      : { path: item.path.replace(/^\//, ''), element: page };
  });

export const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  // Public: whoever follows a reset link cannot sign in yet, so this page must live outside RequireAuth.
  { path: '/reset-password', element: <ResetPasswordPage /> },
  {
    element: <RequireAuth />, // everything below requires a valid session
    children: [
      {
        path: '/',
        element: <AppShell />,
        children: [
          { index: true, element: <Navigate to="/dashboard" replace /> },
          { element: <RequirePermission permission={PERMISSIONS.DASHBOARD_VIEW} />, children: [{ path: 'dashboard', element: <DashboardPage /> }] },

          // Administration — route guards show a 403 page; the API enforces the same permissions.
          { element: <RequirePermission permission={PERMISSIONS.USERS_VIEW} />, children: [{ path: 'admin/users', element: <UserListPage /> }] },
          {
            element: <RequirePermission permission={PERMISSIONS.ROLES_VIEW} />,
            children: [
              { path: 'admin/roles', element: <RoleListPage /> },
              { path: 'admin/roles/:id', element: <RoleDetailPage /> },
              { path: 'admin/permissions', element: <PermissionMatrixPage /> },
            ],
          },
          // People
          {
            element: <RequirePermission permission={PERMISSIONS.EMPLOYEES_VIEW} />,
            children: [
              { path: 'employees', element: <EmployeeListPage /> },
              { path: 'employees/:id', element: <EmployeeDetailPage /> },
            ],
          },
          // Organization — tabbed sub-pages under one guard
          {
            element: <RequirePermission permission={PERMISSIONS.ORGANIZATION_VIEW} />,
            children: [
              {
                path: 'organization',
                element: <OrganizationLayout />,
                children: [
                  { index: true, element: <OrgTreePage /> },
                  { path: 'organizations', element: <OrganizationsPage /> },
                  { path: 'departments', element: <DepartmentsPage /> },
                  { path: 'jobs', element: <JobsPage /> },
                  { path: 'positions', element: <PositionsPage /> },
                ],
              },
            ],
          },
          { element: <RequirePermission permission={PERMISSIONS.AUDIT_VIEW} />, children: [{ path: 'admin/audit-logs', element: <AuditLogPage /> }] },
          { element: <RequirePermission permission={PERMISSIONS.WORKFLOW_MANAGE_DEFINITIONS} />, children: [{ path: 'admin/workflows', element: <WorkflowDefinitionsPage /> }] },
          {
            element: <RequirePermission permission={[PERMISSIONS.LEAVE_MANAGE_TYPES, PERMISSIONS.LEAVE_MANAGE_POLICIES, PERMISSIONS.LEAVE_MANAGE_ENTITLEMENTS, PERMISSIONS.CALENDAR_VIEW]} />,
            children: [{
              path: 'admin/leave-settings', element: <LeaveSettingsLayout />,
              children: [
                { element: <RequirePermission permission={PERMISSIONS.LEAVE_MANAGE_TYPES} />, children: [{ index: true, element: <LeaveTypesPage /> }] },
                { element: <RequirePermission permission={PERMISSIONS.LEAVE_MANAGE_POLICIES} />, children: [{ path: 'policies', element: <PoliciesPage /> }] },
                { element: <RequirePermission permission={PERMISSIONS.LEAVE_MANAGE_ENTITLEMENTS} />, children: [{ path: 'entitlements', element: <EntitlementsPage /> }] },
                { element: <RequirePermission permission={PERMISSIONS.CALENDAR_VIEW} />, children: [{ path: 'calendars', element: <CalendarsPage /> }] },
              ],
            }],
          },
          {
            // Leave (Task 12). Tab visibility is capability-based inside the layout; each page's API enforces the same rules.
            element: <RequirePermission permission={[PERMISSIONS.LEAVE_VIEW, PERMISSIONS.WORKFLOW_APPROVE]} />,
            children: [{
              path: 'hrm/leave', element: <LeaveLayout />,
              children: [
                { element: <RequirePermission permission={PERMISSIONS.LEAVE_VIEW} />, children: [{ index: true, element: <MyLeavePage /> }] },
                { element: <RequirePermission permission={PERMISSIONS.WORKFLOW_APPROVE} />, children: [{ path: 'approvals', element: <ApprovalsPage /> }] },
                { element: <RequirePermission permission={PERMISSIONS.LEAVE_VIEW} />, children: [{ path: 'team', element: <TeamLeavePage /> }, { path: 'requests', element: <AllRequestsPage /> }, { path: 'reports', element: <ReportsPage /> }] },
              ],
            }],
          },
          {
            // Time & attendance (Task 20). Tab visibility is capability-based inside the layout; each page's API
            // enforces the same permission and the caller's data scope.
            element: <RequirePermission permission={[PERMISSIONS.ATTENDANCE_VIEW, PERMISSIONS.ATTENDANCE_CLOCK, PERMISSIONS.OT_VIEW]} />,
            children: [{
              path: 'hrm/attendance', element: <AttendanceLayout />,
              children: [
                { element: <RequirePermission permission={PERMISSIONS.ATTENDANCE_CLOCK} />, children: [{ index: true, element: <MyAttendancePage /> }] },
                {
                  element: <RequirePermission permission={PERMISSIONS.ATTENDANCE_VIEW} />,
                  children: [
                    { path: 'team', element: <DailyAttendancePage scope="team" /> },
                    { path: 'daily', element: <DailyAttendancePage scope="all" /> },
                    { path: 'schedule', element: <SchedulePage /> },
                    { path: 'corrections', element: <CorrectionsPage /> },
                    { path: 'reports', element: <AttendanceReportsPage /> },
                  ],
                },
                { element: <RequirePermission permission={PERMISSIONS.ATTENDANCE_MANAGE} />, children: [{ path: 'shifts', element: <ShiftsPage /> }] },
                {
                  // Overtime (Task 21): claims need `ot.request`, reading needs `ot.view`, policies `ot.manage_policy`.
                  element: <RequirePermission permission={PERMISSIONS.OT_VIEW} />,
                  children: [
                    { path: 'overtime', element: <OvertimePage /> },
                    { path: 'overtime-policies', element: <OvertimePoliciesPage /> },
                  ],
                },
              ],
            }],
          },
          {
            // Payroll (Task 22). Payroll permissions are their own — never derived from a data scope, because a
            // manager who can see a report's attendance has no business seeing their salary.
            element: <RequirePermission permission={[PERMISSIONS.PAYROLL_VIEW_OWN, PERMISSIONS.PAYROLL_MANAGE, PERMISSIONS.PAYROLL_RUN, PERMISSIONS.PAYROLL_APPROVE]} />,
            children: [{
              path: 'hrm/payroll', element: <PayrollLayout />,
              children: [
                { element: <RequirePermission permission={PERMISSIONS.PAYROLL_VIEW_OWN} />, children: [{ index: true, element: <MyPayslipsPage /> }] },
                {
                  element: <RequirePermission permission={[PERMISSIONS.PAYROLL_MANAGE, PERMISSIONS.PAYROLL_RUN, PERMISSIONS.PAYROLL_APPROVE]} />,
                  children: [
                    { path: 'periods', element: <PeriodsPage /> },
                    { path: 'components', element: <PayComponentsPage /> },
                    { path: 'policies', element: <PayrollPoliciesPage /> },
                  ],
                },
                {
                  element: <RequirePermission permission={PERMISSIONS.PAYROLL_MANAGE} />,
                  children: [
                    { path: 'compensation', element: <CompensationPage /> },
                    { path: 'recurring', element: <RecurringItemsPage /> },
                  ],
                },
              ],
            }],
          },
          {
            // Performance (Task 23). `performance.view` is your own plan plus aggregate reporting; reading somebody
            // else's review needs to be their snapshot reviewer or to manage the cycle, which the API enforces.
            element: <RequirePermission permission={PERMISSIONS.PERFORMANCE_VIEW} />,
            children: [{
              path: 'hrm/performance', element: <PerformanceLayout />,
              children: [
                { index: true, element: <MyPerformancePage /> },
                { element: <RequirePermission permission={PERMISSIONS.PERFORMANCE_REVIEW} />, children: [{ path: 'reviews', element: <TeamReviewsPage /> }] },
                { element: <RequirePermission permission={PERMISSIONS.PERFORMANCE_MANAGE_CYCLES} />, children: [{ path: 'cycles', element: <CyclesPage /> }] },
                {
                  element: <RequirePermission permission={[PERMISSIONS.PERFORMANCE_MANAGE_KPIS, PERMISSIONS.PERFORMANCE_MANAGE_CYCLES]} />,
                  children: [{ path: 'kpis', element: <KpiLibraryPage /> }],
                },
                { path: 'reports', element: <PerformanceReportsPage /> },
              ],
            }],
          },
          {
            // Competency (Task 24). `competency.view` is your own profile plus aggregate gap reporting; reading
            // somebody else's assessment needs to be their snapshot reviewer or to manage the framework.
            element: <RequirePermission permission={PERMISSIONS.COMPETENCY_VIEW} />,
            children: [{
              path: 'hrd/competency', element: <CompetencyLayout />,
              children: [
                { index: true, element: <MyCompetenciesPage /> },
                { element: <RequirePermission permission={PERMISSIONS.COMPETENCY_ASSESS} />, children: [{ path: 'assessments', element: <TeamAssessmentsPage /> }] },
                { path: 'library', element: <CompetencyLibraryPage /> },
                {
                  element: <RequirePermission permission={PERMISSIONS.COMPETENCY_MANAGE} />,
                  children: [
                    { path: 'scales', element: <ScalesPage /> },
                    { path: 'job-profiles', element: <JobProfilesPage /> },
                    { path: 'cycles', element: <CompetencyCyclesPage /> },
                  ],
                },
                { path: 'gaps', element: <SkillGapReportPage /> },
              ],
            }],
          },
          {
            // Training and development (Task 25). `training.view` is your own record and the catalogue; managing
            // needs, courses, sessions and plans needs the training permissions, never a data scope.
            element: <RequirePermission permission={PERMISSIONS.TRAINING_VIEW} />,
            children: [{
              path: 'hrd/training', element: <TrainingLayout />,
              children: [
                { index: true, element: <MyDevelopmentPage /> },
                { path: 'team', element: <TeamDevelopmentPage /> },
                { element: <RequirePermission permission={PERMISSIONS.TRAINING_MANAGE} />, children: [{ path: 'needs', element: <TrainingNeedsPage /> }, { path: 'reports', element: <TrainingReportsPage /> }] },
                { path: 'courses', element: <CoursesPage /> },
                { path: 'sessions', element: <SessionsPage /> },
                { element: <RequirePermission permission={PERMISSIONS.IDP_MANAGE} />, children: [{ path: 'idps', element: <IdpsPage /> }] },
              ],
            }],
          },
          {
            // Employee relations (Task 26). The most confidential module: case screens need a permission no manager
            // holds by default, and an employee reaches only what was issued to them.
            element: <RequirePermission permission={[PERMISSIONS.EMPLOYEE_RELATIONS_ACKNOWLEDGE, PERMISSIONS.EMPLOYEE_RELATIONS_VIEW, PERMISSIONS.EMPLOYEE_RELATIONS_MANAGE]} />,
            children: [{
              path: 'hrm/employee-relations', element: <ErLayout />,
              children: [
                { element: <RequirePermission permission={PERMISSIONS.EMPLOYEE_RELATIONS_ACKNOWLEDGE} />, children: [{ index: true, element: <MyRecordsPage /> }] },
                { element: <RequirePermission permission={PERMISSIONS.WORKFLOW_APPROVE} />, children: [{ path: 'approvals', element: <ErApprovalsPage /> }] },
                {
                  element: <RequirePermission permission={[PERMISSIONS.EMPLOYEE_RELATIONS_VIEW, PERMISSIONS.EMPLOYEE_RELATIONS_MANAGE]} />,
                  children: [{ path: 'cases', element: <ErCasesPage /> }, { path: 'actions', element: <ErActionsPage /> }, { path: 'reports', element: <ErReportsPage /> }],
                },
                { element: <RequirePermission permission={PERMISSIONS.EMPLOYEE_RELATIONS_MANAGE} />, children: [{ path: 'action-types', element: <ActionTypesPage /> }] },
              ],
            }],
          },
          {
            // Career, talent and succession (Task 28). An employee reaches only their own career page; talent and
            // succession screens need their own permissions; reports are aggregate-only.
            element: <RequirePermission permission={[PERMISSIONS.CAREER_VIEW, PERMISSIONS.TALENT_VIEW, PERMISSIONS.TALENT_MANAGE, PERMISSIONS.SUCCESSION_VIEW, PERMISSIONS.TALENT_VIEW_REPORTS]} />,
            children: [{
              path: 'hrd/career', element: <TalentLayout />,
              children: [
                { element: <RequirePermission permission={PERMISSIONS.CAREER_VIEW} />, children: [{ index: true, element: <MyCareerPage /> }] },
                { element: <RequirePermission permission={[PERMISSIONS.TALENT_VIEW, PERMISSIONS.TALENT_MANAGE]} />, children: [{ path: 'team', element: <TeamCareerPage /> }, { path: 'talent', element: <TalentReviewsPage /> }, { path: 'pools', element: <TalentPoolsPage /> }] },
                { element: <RequirePermission permission={PERMISSIONS.CAREER_MANAGE} />, children: [{ path: 'paths', element: <CareerPathsPage /> }] },
                { element: <RequirePermission permission={[PERMISSIONS.SUCCESSION_VIEW, PERMISSIONS.SUCCESSION_MANAGE]} />, children: [{ path: 'succession', element: <SuccessionPage /> }] },
                { element: <RequirePermission permission={PERMISSIONS.TALENT_VIEW_REPORTS} />, children: [{ path: 'reports', element: <TalentReportsPage /> }] },
              ],
            }],
          },
          {
            // Recruitment (Task 27). Purpose-specific access: a hiring manager or interviewer reaches only their own
            // requisitions, openings, applications and interviews; the API applies the same scope.
            element: <RequirePermission permission={[PERMISSIONS.RECRUITMENT_VIEW, PERMISSIONS.RECRUITMENT_MANAGE, PERMISSIONS.RECRUITMENT_INTERVIEW]} />,
            children: [{
              path: 'hrm/recruitment', element: <RecruitmentLayout />,
              children: [
                { element: <RequirePermission permission={[PERMISSIONS.RECRUITMENT_VIEW, PERMISSIONS.RECRUITMENT_MANAGE]} />, children: [
                  { index: true, element: <RecruitmentDashboardPage /> }, { path: 'requisitions', element: <RequisitionsPage /> }, { path: 'openings', element: <OpeningsPage /> },
                  { path: 'candidates', element: <CandidatesPage /> }, { path: 'applications', element: <ApplicationsPage /> }, { path: 'offers', element: <OffersPage /> },
                ] },
                { element: <RequirePermission permission={PERMISSIONS.WORKFLOW_APPROVE} />, children: [{ path: 'approvals', element: <RecruitmentApprovalsPage /> }] },
                { element: <RequirePermission permission={[PERMISSIONS.RECRUITMENT_INTERVIEW, PERMISSIONS.RECRUITMENT_MANAGE]} />, children: [{ path: 'interviews', element: <InterviewsPage /> }] },
                { element: <RequirePermission permission={PERMISSIONS.RECRUITMENT_MANAGE} />, children: [{ path: 'reports', element: <RecruitmentReportsPage /> }] },
              ],
            }],
          },
          {
            // Documents (Task 30): the page opens for anybody with a document permission; every document is then decided by classification and its owning module.
            element: <RequirePermission permission={[PERMISSIONS.DOCUMENTS_VIEW_OWN, PERMISSIONS.DOCUMENTS_VIEW, PERMISSIONS.DOCUMENTS_MANAGE]} />,
            children: [{
              path: 'hrm/documents', element: <DocumentsLayout />,
              children: [
                { element: <RequirePermission permission={PERMISSIONS.DOCUMENTS_VIEW_OWN} />, children: [{ index: true, element: <MyDocumentsPage /> }] },
                { element: <RequirePermission permission={[PERMISSIONS.DOCUMENTS_VIEW, PERMISSIONS.DOCUMENTS_MANAGE]} />, children: [{ path: 'center', element: <DocumentCenterPage /> }] },
                { element: <RequirePermission permission={PERMISSIONS.DOCUMENTS_MANAGE} />, children: [{ path: 'categories', element: <DocumentCategoriesPage /> }] },
              ],
            }],
          },
          {
            element: <RequirePermission permission={PERMISSIONS.REPORTS_VIEW} />,
            children: [{ path: 'hrm/reports', element: <ReportsLayout />, children: [{ index: true, element: <SavedReportsPage /> }, { path: 'builder', element: <ReportBuilderPage /> }, { path: 'builder/:id', element: <ReportBuilderPage /> }] }],
          },
          { element: <RequirePermission permission={PERMISSIONS.ANALYTICS_VIEW_EXECUTIVE} />, children: [{ path: 'analytics/executive', element: <ExecutiveDashboardPage /> }] },
          { element: <RequirePermission permission={PERMISSIONS.COPILOT_USE} />, children: [{ path: 'copilot', element: <CopilotPage /> }] },
          {
            element: <RequirePermission permission={[PERMISSIONS.WORKFORCE_VIEW, PERMISSIONS.WORKFORCE_PLAN, PERMISSIONS.WORKFORCE_MANAGE, PERMISSIONS.ORG_DESIGN_VIEW, PERMISSIONS.ORG_DESIGN_MANAGE]} />,
            children: [{
              path: 'hrod/workforce', element: <WorkforceLayout />,
              children: [
                { element: <RequirePermission permission={[PERMISSIONS.WORKFORCE_VIEW, PERMISSIONS.WORKFORCE_PLAN, PERMISSIONS.WORKFORCE_MANAGE]} />, children: [
                  { index: true, element: <WorkforceDashboardPage /> }, { path: 'cycles', element: <WorkforceCyclesPage /> }, { path: 'plan', element: <HeadcountPlanPage /> }, { path: 'vacancies', element: <VacanciesPage /> },
                ] },
                { element: <RequirePermission permission={[PERMISSIONS.ORG_DESIGN_VIEW, PERMISSIONS.ORG_DESIGN_MANAGE]} />, children: [{ path: 'design', element: <OrgDesignPage /> }] },
                { path: 'reports', element: <WorkforceReportsPage /> },
              ],
            }],
          },
          {
            element: <RequirePermission permission={[PERMISSIONS.ENGAGEMENT_RESPOND, PERMISSIONS.ENGAGEMENT_VIEW_RESULTS, PERMISSIONS.ENGAGEMENT_MANAGE]} />,
            children: [{
              path: 'hrod/engagement', element: <EngagementLayout />,
              children: [
                { index: true, element: <MySurveysPage /> },
                { element: <RequirePermission permission={[PERMISSIONS.ENGAGEMENT_VIEW_RESULTS, PERMISSIONS.ENGAGEMENT_MANAGE]} />, children: [
                  { path: 'team', element: <TeamEngagementPage /> }, { path: 'dashboard', element: <EngagementDashboardPage /> }, { path: 'surveys', element: <EngagementSurveysPage /> }, { path: 'results', element: <EngagementResultsPage /> }, { path: 'reports', element: <EngagementReportsPage /> },
                ] },
                { element: <RequirePermission permission={PERMISSIONS.ENGAGEMENT_MANAGE} />, children: [{ path: 'questions', element: <QuestionBankPage /> }, { path: 'comments', element: <EngagementCommentsPage /> }, { path: 'participation', element: <EngagementParticipationPage /> }] },
              ],
            }],
          },
          {
            element: <RequirePermission permission={[PERMISSIONS.ONBOARDING_VIEW, PERMISSIONS.PROBATION_VIEW, PERMISSIONS.OFFBOARDING_VIEW, PERMISSIONS.ONBOARDING_MANAGE, PERMISSIONS.PROBATION_MANAGE, PERMISSIONS.OFFBOARDING_MANAGE, PERMISSIONS.LIFECYCLE_VIEW_REPORTS]} />,
            children: [{
              path: 'hrm/lifecycle', element: <LifecycleLayout />,
              children: [
                { index: true, element: <MyLifecyclePage /> }, { path: 'dashboard', element: <LifecycleDashboardPage /> },
                { element: <RequirePermission permission={[PERMISSIONS.ONBOARDING_VIEW, PERMISSIONS.ONBOARDING_MANAGE]} />, children: [{ path: 'onboarding', element: <LifecycleOnboardingPage /> }] },
                { element: <RequirePermission permission={[PERMISSIONS.PROBATION_VIEW, PERMISSIONS.PROBATION_MANAGE]} />, children: [{ path: 'probation', element: <ProbationPage /> }] },
                { element: <RequirePermission permission={[PERMISSIONS.OFFBOARDING_VIEW, PERMISSIONS.OFFBOARDING_MANAGE]} />, children: [{ path: 'offboarding', element: <OffboardingPage /> }] },
                { element: <RequirePermission permission={[PERMISSIONS.ONBOARDING_MANAGE, PERMISSIONS.OFFBOARDING_MANAGE]} />, children: [{ path: 'templates', element: <LifecycleTemplatesPage /> }] },
                { element: <RequirePermission permission={[PERMISSIONS.LIFECYCLE_VIEW_REPORTS, PERMISSIONS.ONBOARDING_MANAGE, PERMISSIONS.PROBATION_MANAGE, PERMISSIONS.OFFBOARDING_MANAGE]} />, children: [{ path: 'reports', element: <LifecycleReportsPage /> }] },
              ],
            }],
          },
          { element: <RequirePermission permission={PERMISSIONS.ONBOARDING_MANAGE} />, children: [{ path: 'admin/onboarding', element: <OnboardingPage /> }] },
          {
            // Privacy operations (Task 18). Each tab is guarded on its own permission, as the API is.
            element: <RequirePermission permission={[PERMISSIONS.PRIVACY_MANAGE_REQUESTS, PERMISSIONS.PRIVACY_EXPORT_DATA]} />,
            children: [{
              path: 'admin/privacy', element: <PrivacyLayout />,
              children: [
                { element: <RequirePermission permission={PERMISSIONS.PRIVACY_MANAGE_REQUESTS} />, children: [{ index: true, element: <PrivacyRequestsPage /> }] },
                { element: <RequirePermission permission={PERMISSIONS.PRIVACY_EXPORT_DATA} />, children: [{ path: 'export', element: <DataExportPage /> }] },
              ],
            }],
          },
          { path: 'account/security', element: <AccountSecurityPage /> }, // your own account: authentication only
          { path: 'notifications', element: <NotificationsPage /> }, // the caller's own inbox: authentication only, no permission
          ...comingSoonRoutes,
          { path: '*', element: <ComingSoonPage title="Page not found" description="The page you are looking for does not exist." /> },
        ],
      },
    ],
  },
]);
