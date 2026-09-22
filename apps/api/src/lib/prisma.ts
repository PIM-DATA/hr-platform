import { PrismaClient } from '@prisma/client';
import { env } from '../config/env';

/** Single PrismaClient instance for the whole process. `env.databaseUrl` selects the test database under NODE_ENV=test. */
export const prisma = new PrismaClient({
  datasourceUrl: env.databaseUrl,
  log: env.LOG_LEVEL === 'trace' ? ['query', 'warn', 'error'] : ['warn', 'error'],
});
