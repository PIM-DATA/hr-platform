import { Router } from 'express';
import { prisma } from './lib/prisma';

/**
 * API root router — every business module mounts here.
 * Adding a module: import its router and `router.use('/<resource>', <module>Router)`.
 */
export const apiRouter = Router();

apiRouter.get('/health', async (_req, res) => {
  await prisma.$queryRaw`SELECT 1`;
  res.json({ data: { status: 'ok', database: 'ok', timestamp: new Date().toISOString() } });
});

// Task 2: apiRouter.use('/auth', authRouter)
// Task 3: apiRouter.use('/users', usersRouter); apiRouter.use('/roles', rolesRouter); apiRouter.use('/permissions', ...)
// Task 4: apiRouter.use('/organizations' | '/departments' | '/jobs' | '/positions', ...)
// Task 5: apiRouter.use('/employees', employeesRouter)
// Task 6: apiRouter.use('/audit-logs', auditRouter)
// Task 7: apiRouter.use('/dashboard', dashboardRouter)
