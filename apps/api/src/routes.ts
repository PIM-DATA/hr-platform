import { Router } from 'express';
import { authRouter } from './modules/auth/auth.routes';
import { usersRouter } from './modules/users/users.routes';
import { permissionsRouter, rolesRouter } from './modules/roles/roles.routes';
import { employeesRouter } from './modules/employees/employees.routes';
import { auditRouter } from './modules/audit/audit.routes';
import { dashboardRouter } from './modules/dashboard/dashboard.routes';
import { workflowRouter } from './modules/workflow/workflow.routes';
import { calendarsRouter, holidaysRouter } from './modules/calendar/calendar.routes';
import { leaveRouter } from './modules/leave/leave.routes';
import { notificationsRouter } from './modules/notification/notification.routes';
import { onboardingRouter } from './modules/onboarding/onboarding.routes';
import { accountAdminRouter, accountRouter } from './modules/account/account.routes';
import { privacyRouter } from './modules/privacy/privacy.routes';
import { attendanceRouter } from './modules/attendance/attendance.routes';
import { payrollRouter } from './modules/payroll/payroll.routes';
import { performanceRouter } from './modules/performance/performance.routes';
import { competencyRouter } from './modules/competency/competency.routes';
import { trainingRouter } from './modules/training/training.routes';
import { employeeRelationsRouter } from './modules/employee-relations/er.routes';
import { recruitmentRouter } from './modules/recruitment/recruitment.routes';
import { talentRouter } from './modules/talent/talent.routes';
import { analyticsRouter } from './modules/analytics/analytics.routes';
import { documentsRouter } from './modules/documents/documents.routes';
import { reportsRouter } from './modules/reports/reports.routes';
import { copilotRouter } from './modules/copilot/copilot.routes';
import { workforceRouter } from './modules/workforce/workforce.routes';
import { engagementRouter } from './modules/engagement/engagement.routes';
import { registerLeaveWorkflowHandlers } from './modules/leave/leave-request.handlers';
import { departmentsRouter, jobsRouter, organizationTreeRouter, organizationsRouter, positionsRouter } from './modules/organization/organization.routes';

/**
 * API root router — every business module mounts here.
 * Adding a module: import its router and `router.use('/<resource>', <module>Router)`.
 */
export const apiRouter = Router();

apiRouter.use('/auth', authRouter);
apiRouter.use('/users', usersRouter);
apiRouter.use('/roles', rolesRouter);
apiRouter.use('/permissions', permissionsRouter);
apiRouter.use('/organizations', organizationsRouter);
apiRouter.use('/departments', departmentsRouter);
apiRouter.use('/jobs', jobsRouter);
apiRouter.use('/positions', positionsRouter);
apiRouter.use('/organization', organizationTreeRouter); // GET /organization/tree
apiRouter.use('/employees', employeesRouter);
apiRouter.use('/audit-logs', auditRouter);
apiRouter.use('/dashboard', dashboardRouter);
apiRouter.use('/workflow', workflowRouter);
apiRouter.use('/calendars', calendarsRouter);
apiRouter.use('/holidays', holidaysRouter);
apiRouter.use('/leave', leaveRouter);
apiRouter.use('/notifications', notificationsRouter);
apiRouter.use('/onboarding', onboardingRouter);
apiRouter.use('/account', accountRouter);
apiRouter.use('/admin/users', accountAdminRouter);
apiRouter.use('/privacy', privacyRouter);
apiRouter.use('/attendance', attendanceRouter);
apiRouter.use('/payroll', payrollRouter);
apiRouter.use('/performance', performanceRouter);
apiRouter.use('/competency', competencyRouter);
apiRouter.use('/training', trainingRouter);
apiRouter.use('/employee-relations', employeeRelationsRouter);
apiRouter.use('/recruitment', recruitmentRouter);
apiRouter.use('/talent', talentRouter);
apiRouter.use('/analytics', analyticsRouter);
apiRouter.use('/documents', documentsRouter);
apiRouter.use('/reports', reportsRouter);
apiRouter.use('/copilot', copilotRouter);
apiRouter.use('/workforce', workforceRouter);
apiRouter.use('/engagement', engagementRouter);
registerLeaveWorkflowHandlers(); // leave ↔ workflow terminal callbacks (approve / reject / cancel)
