import { Router } from 'express';
import { prisma } from './lib/prisma';
import { authRouter } from './modules/auth/auth.routes';
import { usersRouter } from './modules/users/users.routes';
import { permissionsRouter, rolesRouter } from './modules/roles/roles.routes';
import { employeesRouter } from './modules/employees/employees.routes';
import { auditRouter } from './modules/audit/audit.routes';
import { departmentsRouter, jobsRouter, organizationTreeRouter, organizationsRouter, positionsRouter } from './modules/organization/organization.routes';

/**
 * API root router — every business module mounts here.
 * Adding a module: import its router and `router.use('/<resource>', <module>Router)`.
 */
export const apiRouter = Router();

apiRouter.get('/health', async (_req, res) => {
  await prisma.$queryRaw`SELECT 1`;
  res.json({ data: { status: 'ok', database: 'ok', timestamp: new Date().toISOString() } });
});

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
// Task 7: apiRouter.use('/dashboard', dashboardRouter)
