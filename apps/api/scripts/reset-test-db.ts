/**
 * Resets the dedicated PostgreSQL TEST database before a test run: drops and recreates its schema, then
 * re-applies the migration history with `prisma migrate deploy` (so every run also verifies the migrations
 * from an empty database).
 *
 * Safety: refuses to run unless NODE_ENV=test, TEST_DATABASE_URL is a PostgreSQL URL and differs from
 * DATABASE_URL. The Prisma CLI is spawned with DATABASE_URL overridden by TEST_DATABASE_URL; no URL is printed.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { env } from '../src/config/env';

const fail = (msg: string): never => { console.error(`reset-test-db: ${msg}`); process.exit(1); };
// Destructive: drops and recreates a schema. Production can never reach this, whatever else is set.
if (env.isProduction || process.env.NODE_ENV === 'production') fail('refusing to run against a production environment');
if (!env.isTest) fail('NODE_ENV must be "test"');
const url = env.TEST_DATABASE_URL;
if (!url || url === env.DATABASE_URL) fail('TEST_DATABASE_URL missing or equal to DATABASE_URL');
if (!/^postgres(ql)?:\/\//.test(url!)) fail('TEST_DATABASE_URL must be a PostgreSQL URL');
const schema = new URL(url!).searchParams.get('schema') ?? 'public';
if (!/^[a-z_][a-z0-9_]*$/.test(schema)) fail('schema name in TEST_DATABASE_URL must be a simple identifier');

const run = (args: string[], input?: string) => {
  const r = spawnSync('npx', ['prisma', ...args], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, DATABASE_URL: url! },
    input,
    stdio: [input === undefined ? 'ignore' : 'pipe', 'ignore', 'inherit'],
  });
  if (r.status !== 0) fail(`prisma ${args[0]} ${args[1]} failed`);
};
run(['db', 'execute', '--stdin', '--url', url!], `DROP SCHEMA IF EXISTS "${schema}" CASCADE; CREATE SCHEMA "${schema}";`);
run(['migrate', 'deploy']);
console.log('test database reset: schema recreated, migrations applied from empty');
