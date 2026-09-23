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
registerLeaveWorkflowHandlers(); // leave ↔ workflow terminal callbacks (approve / reject / cancel)
