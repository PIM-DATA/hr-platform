import path from 'node:path';
import dotenv from 'dotenv';
import { z } from 'zod';

// Load apps/api/.env (same file the Prisma CLI reads). ENV_FILE points elsewhere — a production install keeping its
// configuration outside the repo, or a smoke run that must not inherit developer values. Real process environment
// variables always win: dotenv never overwrites what the platform already set.
dotenv.config({ path: process.env.ENV_FILE ?? path.resolve(__dirname, '../../.env') });

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.string().min(1),
  /** Dedicated PostgreSQL test database. Required when NODE_ENV=test; must differ from DATABASE_URL. */
  TEST_DATABASE_URL: z.string().min(1).optional(),
  /** Browser origin(s) allowed to call the API, comma-separated. Production requires explicit https origins. */
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  /**
   * Reverse-proxy hops to trust for req.ip / req.protocol (Express `trust proxy`).
   * 0 = trust nothing (direct exposure), 1 = one proxy in front (the usual platform setup).
   */
  TRUST_PROXY: z.coerce.number().int().min(0).max(10).default(0),
  SESSION_TTL_HOURS: z.coerce.number().positive().default(12),
  LOGIN_MAX_ATTEMPTS: z.coerce.number().int().positive().default(10),
  LOGIN_WINDOW_MINUTES: z.coerce.number().positive().default(15),
  /** Modest global API limit per IP per minute; the login limiter is much stricter. 0 disables it. */
  API_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(0).default(600),
  /** JSON body cap. There are no uploads in this phase, so requests stay small. */
  JSON_BODY_LIMIT: z.string().default('1mb'),
  COOKIE_SECURE: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  /** Optional build marker (commit SHA or release tag) surfaced on /health. Never required. */
  APP_VERSION: z.string().optional(),
  SEED_ADMIN_EMAIL: z.string().email().optional(),
  SEED_ADMIN_PASSWORD: z.string().min(8).optional(),
  SEED_DEMO_PASSWORD: z.string().min(8).optional(),
});

/** Values that are fine locally but must never be accepted by a production process. */
const DEV_PLACEHOLDER_SECRETS = ['change-me-locally', 'changeme', 'password', 'secret', 'demo', 'test1234'];
const isLocalOrigin = (origin: string) => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:\d+)?$/i.test(origin.trim());

export function parseEnv(source: NodeJS.ProcessEnv): { ok: true; value: z.infer<typeof envSchema> } | { ok: false; errors: string[] } {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    return { ok: false, errors: Object.entries(parsed.error.flatten().fieldErrors).map(([k, v]) => `${k}: ${v?.join(', ')}`) };
  }
  const value = parsed.data;
  const errors: string[] = [];

  if (value.NODE_ENV === 'production') {
    // Fail fast: production never falls back to development defaults.
    if (!source.DATABASE_URL) errors.push('DATABASE_URL is required in production');
    if (!source.CORS_ORIGIN) errors.push('CORS_ORIGIN is required in production (the browser origin that serves the app)');
    else {
      const origins = value.CORS_ORIGIN.split(',').map((o) => o.trim()).filter(Boolean);
      if (!origins.length) errors.push('CORS_ORIGIN must list at least one origin in production');
      if (origins.some(isLocalOrigin)) errors.push('CORS_ORIGIN must not include localhost in production');
      if (origins.some((o) => o === '*')) errors.push('CORS_ORIGIN must not be "*" — the API uses credentialed cookies');
      if (origins.some((o) => !o.startsWith('https://'))) errors.push('CORS_ORIGIN must use https:// in production (HTTPS is terminated by the proxy)');
    }
    // Demo/bootstrap credentials belong to development only; production bootstraps an admin with an explicit command.
    if (source.SEED_DEMO_PASSWORD) errors.push('SEED_DEMO_PASSWORD must not be set in production (demo accounts are development-only)');
    for (const [name, secret] of [['SEED_ADMIN_PASSWORD', value.SEED_ADMIN_PASSWORD]] as const) {
      if (secret && DEV_PLACEHOLDER_SECRETS.includes(secret.toLowerCase())) errors.push(`${name} is a development placeholder and cannot be used in production`);
    }
    if (source.COOKIE_SECURE === 'false') errors.push('COOKIE_SECURE cannot be false in production (session cookies must be Secure)');
  }

  // The test suite wipes every table, so it may only ever point at TEST_DATABASE_URL — never at the dev database.
  if (value.NODE_ENV === 'test') {
    if (!value.TEST_DATABASE_URL) errors.push('NODE_ENV=test requires TEST_DATABASE_URL (a dedicated PostgreSQL database); it never falls back to DATABASE_URL');
    else if (value.TEST_DATABASE_URL === value.DATABASE_URL) errors.push('TEST_DATABASE_URL must not equal DATABASE_URL: tests reset the whole database');
  }

  return errors.length ? { ok: false, errors } : { ok: true, value };
}

const result = parseEnv(process.env);
if (!result.ok) {
  // Names and reasons only — never the values themselves.
  // eslint-disable-next-line no-console
  console.error(`Invalid environment configuration (${process.env.NODE_ENV ?? 'development'}):\n  - ${result.errors.join('\n  - ')}`);
  process.exit(1);
}
const data = result.value;

/** True when a production process talks to a database on the same host — legitimate for a single-VM install, worth saying out loud. */
export const databaseIsLocal = /(^|@)(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(data.DATABASE_URL);

export const env = {
  ...data,
  /** The connection the process actually uses: TEST_DATABASE_URL under NODE_ENV=test, DATABASE_URL otherwise. */
  databaseUrl: data.NODE_ENV === 'test' ? (data.TEST_DATABASE_URL as string) : data.DATABASE_URL,
  isProduction: data.NODE_ENV === 'production',
  isTest: data.NODE_ENV === 'test',
  isDevelopment: data.NODE_ENV === 'development',
  /** Session cookies are always Secure in production, regardless of COOKIE_SECURE. */
  cookieSecure: data.NODE_ENV === 'production' || data.COOKIE_SECURE,
  /** Allowed browser origins (comma-separated in CORS_ORIGIN). */
  allowedOrigins: data.CORS_ORIGIN.split(',').map((o) => o.trim()).filter(Boolean),
};
export type Env = typeof env;
