// Runs before every test file. The `test` npm script points DATABASE_URL at test.db
// and resets it with `prisma db push --force-reset`, so tests start from an empty schema.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'file:./test.db';

// Login rate-limiter state is in-memory per process; reset it before every test so no test
// (or file, when the worker is reused) can inherit failed-login counts from another.
import { beforeEach } from 'vitest';
import { loginRateLimiter } from '../src/middleware/login-rate-limit';
beforeEach(() => loginRateLimiter.clearAll());
