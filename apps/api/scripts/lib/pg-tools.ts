import { execFile } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Shared helpers for the operational scripts (backup / restore verification / session revocation).
 *
 * Two rules drive this file:
 *  1. **Credentials never appear in process arguments.** A connection string on a command line is visible to anyone
 *     who can run `ps`. Every PostgreSQL tool is therefore invoked with libpq environment variables (PGHOST, PGUSER,
 *     PGPASSWORD, …) and arguments that contain no secret.
 *  2. **No shell.** Everything runs through execFile with an argument array (shell: false by default), so nothing a
 *     filename or database name contains can ever be interpreted as a command.
 */

export interface PgConnection {
  host: string;
  port: string;
  user: string;
  password?: string;
  database: string;
  sslmode?: string;
}

/** Parses DATABASE_URL into its parts. The URL itself is never logged or passed to a child process. */
export function parseConnection(url: string): PgConnection {
  const parsed = new URL(url);
  if (!/^postgres(ql)?:$/.test(parsed.protocol)) throw new Error('Only postgresql:// connection strings are supported');
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (!database) throw new Error('Connection string has no database name');
  return {
    host: parsed.hostname || 'localhost',
    port: parsed.port || '5432',
    user: decodeURIComponent(parsed.username) || process.env.USER || 'postgres',
    password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
    database,
    sslmode: parsed.searchParams.get('sslmode') ?? undefined,
  };
}

/** libpq environment for a child process: the password travels here, never in argv. */
export function libpqEnv(conn: PgConnection, overrides: { database?: string } = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PGHOST: conn.host,
    PGPORT: conn.port,
    PGUSER: conn.user,
    PGDATABASE: overrides.database ?? conn.database,
  };
  if (conn.password) env.PGPASSWORD = conn.password;
  else delete env.PGPASSWORD;
  if (conn.sslmode) env.PGSSLMODE = conn.sslmode;
  return env;
}

/** A label safe to print: host/port/database only, never the user's password. */
export const safeTarget = (conn: PgConnection, database = conn.database) => `${conn.host}:${conn.port}/${database}`;

/**
 * Finds a PostgreSQL client tool. Order: PG_BIN_DIR (explicit configuration) → PATH (the production expectation) →
 * a local Postgres.app installation (developer convenience only). Production deployments are expected to provide the
 * PostgreSQL client tools; nothing is ever installed by these scripts.
 */
export function findPgTool(tool: 'pg_dump' | 'pg_restore' | 'psql' | 'createdb' | 'dropdb'): string {
  const configured = process.env.PG_BIN_DIR;
  if (configured) {
    const candidate = path.join(configured, tool);
    if (existsSync(candidate)) return candidate;
    throw new Error(`PG_BIN_DIR is set but ${tool} was not found in it`);
  }
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (dir && existsSync(path.join(dir, tool))) return path.join(dir, tool);
  }
  // Local developer convenience (Postgres.app); never assumed in production.
  const appVersions = '/Applications/Postgres.app/Contents/Versions';
  if (existsSync(appVersions)) {
    const versions = readdirSync(appVersions).filter((v) => /^\d+$/.test(v)).sort((a, b) => Number(b) - Number(a));
    for (const v of versions) {
      const candidate = path.join(appVersions, v, 'bin', tool);
      if (existsSync(candidate)) return candidate;
    }
  }
  throw new Error(`${tool} not found. Install the PostgreSQL client tools or set PG_BIN_DIR to their directory.`);
}

export interface RunResult { stdout: string; stderr: string }

/** Runs a PostgreSQL tool with no shell and no secret in argv. */
export async function runTool(binary: string, args: string[], env: NodeJS.ProcessEnv, maxBuffer = 16 * 1024 * 1024): Promise<RunResult> {
  const { stdout, stderr } = await execFileAsync(binary, args, { env, maxBuffer, shell: false });
  return { stdout: stdout.toString(), stderr: stderr.toString() };
}

/** First version-looking token, so build suffixes are ignored: `pg_dump (PostgreSQL) 18.6 (Postgres.app)` → `18.6`. */
export function extractVersion(text: string): string {
  return /(\d+(?:\.\d+)*)/.exec(text)?.[1] ?? 'unknown';
}

export async function toolVersion(binary: string): Promise<string> {
  const { stdout } = await execFileAsync(binary, ['--version'], { shell: false });
  return extractVersion(stdout.toString());
}

/** Server version via a parameter-free query; the connection details come from the environment. */
export async function serverVersion(conn: PgConnection): Promise<string> {
  const { stdout } = await runTool(findPgTool('psql'), ['-Atqc', 'SHOW server_version'], libpqEnv(conn));
  return extractVersion(stdout);
}

/**
 * A PostgreSQL client older than the server cannot be trusted to produce a complete dump — pg_dump refuses anyway,
 * but failing early with a clear message beats a half-finished operation.
 */
export function assertToolCompatible(toolVersionString: string, serverVersionString: string): void {
  const major = (v: string) => Number(v.split('.')[0]);
  const client = major(toolVersionString);
  const server = major(serverVersionString);
  if (Number.isFinite(client) && Number.isFinite(server) && client < server) {
    throw new Error(`PostgreSQL client tools are older than the server (client ${toolVersionString}, server ${serverVersionString}). Use tools of version ${server} or newer.`);
  }
}

/** Temporary database names are generated from a strict charset — identifiers cannot be parameterised in SQL. */
export function generateTempDatabaseName(prefix = 'hr_restore_verify'): string {
  const suffix = Array.from({ length: 10 }, () => 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 36)]).join('');
  const name = `${prefix}_${suffix}`;
  if (!/^[a-z][a-z0-9_]{1,62}$/.test(name)) throw new Error('Generated database name failed validation');
  return name;
}

/** Structured one-line operational events (stdout), so a scheduler or log collector can pick them up. */
export function opsLog(event: string, fields: Record<string, unknown> = {}): void {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }));
}
