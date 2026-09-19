import { PrismaClient } from '@prisma/client';
import { env } from '../config/env';

/** Single PrismaClient instance for the whole process. */
export const prisma = new PrismaClient({
  log: env.LOG_LEVEL === 'trace' ? ['query', 'warn', 'error'] : ['warn', 'error'],
});
