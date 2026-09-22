import path from 'node:path';
import dotenv from 'dotenv';
import { z } from 'zod';

// Load apps/api/.env (same file the Prisma CLI reads).
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.string().min(1),
  /** Dedicated PostgreSQL test database. Required when NODE_ENV=test; must differ from DATABASE_URL. */
  TEST_DATABASE_URL: z.string().min(1).optional(),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  SESSION_TTL_HOURS: z.coerce.number().positive().default(12),
  LOGIN_MAX_ATTEMPTS: z.coerce.number().int().positive().default(10),
  LOGIN_WINDOW_MINUTES: z.coerce.number().positive().default(15),
  COOKIE_SECURE: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  SEED_ADMIN_EMAIL: z.string().email().optional(),
  SEED_ADMIN_PASSWORD: z.string().min(8).optional(),
  SEED_DEMO_PASSWORD: z.string().min(8).optional(),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error('Invalid environment configuration:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

// Test safety: the suite wipes every table, so it may only ever point at TEST_DATABASE_URL — never at the dev database.
if (parsed.data.NODE_ENV === 'test') {
  if (!parsed.data.TEST_DATABASE_URL) {
    // eslint-disable-next-line no-console
    console.error('NODE_ENV=test requires TEST_DATABASE_URL (a dedicated PostgreSQL database). Refusing to fall back to DATABASE_URL.');
    process.exit(1);
  }
  if (parsed.data.TEST_DATABASE_URL === parsed.data.DATABASE_URL) {
    // eslint-disable-next-line no-console
    console.error('TEST_DATABASE_URL must not equal DATABASE_URL: tests reset the whole database.');
    process.exit(1);
  }
}

export const env = {
  ...parsed.data,
  /** The connection the process actually uses: TEST_DATABASE_URL under NODE_ENV=test, DATABASE_URL otherwise. */
  databaseUrl: parsed.data.NODE_ENV === 'test' ? (parsed.data.TEST_DATABASE_URL as string) : parsed.data.DATABASE_URL,
  isProduction: parsed.data.NODE_ENV === 'production',
  isTest: parsed.data.NODE_ENV === 'test',
  // secure cookies are forced on in production regardless of COOKIE_SECURE
  cookieSecure: parsed.data.NODE_ENV === 'production' || parsed.data.COOKIE_SECURE,
};
export type Env = typeof env;
