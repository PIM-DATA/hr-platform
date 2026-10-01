# Environment reference

Every variable the application and its operations scripts read (Task 46). Values below are **examples, never real
secrets**. The API validates its configuration at startup (`apps/api/src/config/env.ts`) and refuses to start on any
error, printing variable names and reasons only — never values.

Where configuration comes from: `ENV_FILE` (a file outside the repository — recommended for production), otherwise
`apps/api/.env`; real environment variables always win. The Prisma CLI (`npm run db:deploy`) reads `DATABASE_URL` from
the process environment or `apps/api/.env`, not from `ENV_FILE`.

Legend — **Req**: `P` required in production, `T` required in test, `—` optional. **Secret**: store in the platform's
secret store, never in the repository.

## Runtime mode

| Variable | Req | Secret | Example | Purpose |
|---|---|---|---|---|
| `NODE_ENV` | **always** | no | `production` | Exactly `development`, `test` or `production`. Never defaulted: unset, blank, `prod`, `Production` … refuse to start. `npm run dev` / `npm test` / `npm start` set it themselves. |

## API

| Variable | Req | Secret | Example | Purpose |
|---|---|---|---|---|
| `DATABASE_URL` | P (all modes) | **yes** | `postgresql://hr_app:…@db.internal:5432/hr?schema=public` | Application database. |
| `TEST_DATABASE_URL` | T | yes | `postgresql://…/hr_enterprise_test?schema=public` | Test database; must differ from `DATABASE_URL` (tests wipe it). |
| `PORT` | — | no | `4000` | API listen port (bind it to loopback behind the proxy). |
| `LOG_LEVEL` | — | no | `info` | `fatal`…`trace`, `silent`. |
| `CORS_ORIGIN` | P | no | `https://hr.example.com` | Allowed browser origin(s), comma-separated. Production: https only, no localhost, never `*`. |
| `PUBLIC_APP_URL` | P | no | `https://hr.example.com` | Base URL of reset links. https, no credentials, no query/fragment, not localhost. |
| `TRUST_PROXY` | P | no | `1` | Proxy trust for client IP / protocol: `off`, a hop count `1`–`10`, or proxy IPs/CIDRs (`10.0.0.0/8,127.0.0.1`, also `loopback`). `true`/`*`/`all` are refused. Dev/test default `off`. See docs/deployment.md §5. |
| `COOKIE_SECURE` | — | no | `true` | Production forces Secure cookies and refuses `false`. Development may use `false` over plain http. |
| `SESSION_TTL_HOURS` | — | no | `12` | Absolute session lifetime. |
| `LOGIN_MAX_ATTEMPTS` / `LOGIN_WINDOW_MINUTES` | — | no | `10` / `15` | Failed-login limit per client IP (in-process). |
| `API_RATE_LIMIT_PER_MINUTE` | — | no | `600` | Per-IP API ceiling (0 disables; health exempt). |
| `JSON_BODY_LIMIT` | — | no | `1mb` | JSON request body cap. |
| `APP_VERSION` | — | no | `0.1.0-rc.1` | Build marker on `/health` and the startup log. |
| `PASSWORD_RESET_TTL_MINUTES` | — | no | `60` | Lifetime of an admin-issued reset link (5–1440). |

## Documents

| Variable | Req | Secret | Example | Purpose |
|---|---|---|---|---|
| `DOCUMENTS_ENABLED` | — | no | `true` | Default `true`. `false` disables the document center (then no storage directory is needed). |
| `DOCUMENT_STORAGE_DIR` | P when documents enabled | no (contents are sensitive) | `/var/lib/hr/documents` | Persistent directory for file bytes, owned by the API user, mode 0700. Temporary paths (`/tmp`, `/var/tmp`, `/dev/shm`, `/private/tmp`) are refused in production. Back it up with the database. |
| `DOCUMENT_MAX_FILE_MB` | — | no | `20` | Upload size cap (1–500). |

## HR Copilot (optional, off by default)

| Variable | Req | Secret | Example | Purpose |
|---|---|---|---|---|
| `COPILOT_ENABLED` | — | no | `false` | Off by default; the core application never depends on it. |
| `COPILOT_PROVIDER` | — | no | `anthropic` | `anthropic`; `fake` is a test double and is refused in production. |
| `COPILOT_API_KEY` | P when enabled | **yes** | — | Provider credential. |
| `COPILOT_MODEL` | — | no | (see .env.example) | Model id; confirm against the provider's current list before enabling. |
| `COPILOT_TIMEOUT_MS`, `COPILOT_MAX_TOOL_STEPS`, `COPILOT_MAX_INPUT_CHARS`, `COPILOT_MAX_OUTPUT_TOKENS`, `COPILOT_RATE_LIMIT` | — | no | `30000`, `6`, `12000`, `1024`, `20` | Bounds. |

## Development only

| Variable | Req | Secret | Example | Purpose |
|---|---|---|---|---|
| `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` | — | yes (local) | `admin@company.local` / … | Demo seed administrator. Placeholders refused in production. |
| `SEED_DEMO_PASSWORD` | — | yes (local) | … | Demo accounts. Must not be set in production (refused). |
| `TEST_LOG_LEVEL` | — | no | `error` | Makes the silent test logger print. |

## Operations scripts (not read by the running API)

| Variable | Used by | Secret | Purpose |
|---|---|---|---|
| `ENV_FILE` | API and all scripts | no | Path of the configuration file (outside the repository in production). |
| `BOOTSTRAP_ADMIN_EMAIL` / `BOOTSTRAP_ADMIN_PASSWORD` | `bootstrap:admin` | **yes** | First administrator; the password follows the 12-character policy and is never echoed. Pass for the one command only. |
| `PG_BIN_DIR` | `ops:backup`, `ops:restore`, `db:backup`, `db:restore:verify` | no | Where `pg_dump`/`pg_restore`/`psql`/`createdb`/`dropdb` live if not on `PATH`. |
| `REVOKE_SESSIONS_DATABASE_URL` | `ops:revoke-sessions` | **yes** | Target a restored copy instead of `DATABASE_URL`. |
| `OPS_CHECK_URL`, `OPS_CHECK_TIMEOUT_MS` | `ops:check`, `ops:monitor-check` | no | Probe through the proxy or from another host (default `http://127.0.0.1:$PORT`, 5000 ms). |
| `RESET_TOKEN_RETENTION_DAYS` | `ops:cleanup-reset-tokens` | no | Retention for spent reset tokens. |

## Backup, restore and monitoring (Task 49 — not read by the running API)

Keep these in a separate root-owned `0600` file (e.g. `/etc/hr-platform/backup.env`) loaded by the backup and monitor
units next to `ENV_FILE`. All ops commands load `ENV_FILE` **first**, so they act on the same database and document
root as the API (see [backup-restore.md](backup-restore.md), [operations-monitoring.md](operations-monitoring.md)).

| Variable | Req | Secret | Default | Production behaviour |
|---|---|---|---|---|
| `BACKUP_DIR` | P | no | dev: `apps/api/backups` (git-ignored) | Where recovery sets, `last-success.json` and `last-attempt.json` live. Required; never inside a web root; mode `0700`. Also `db:backup`. |
| `BACKUP_RETAIN_COUNT` | — | no | `7` | Verified COMPLETE sets kept locally (1–1000). Never deletes the newest valid set. |
| `BACKUP_OFFHOST_COMMAND` | P | no (the path) | — | Absolute path of the off-host copy hook, run without a shell as `<cmd> <set dir> <set id>`. Production fails the run (`OFFHOST_NOT_CONFIGURED`) without it. |
| `BACKUP_OFFHOST_VERIFY_COMMAND` | P (with the above) | no (the path) | — | Absolute path of the hook that proves the remote copy matches (exit 0). Required with the copy hook in production. |
| `BACKUP_OFFHOST_REQUIRED` | — | no | `true` in production, `false` otherwise | `false` in production = explicit, documented acceptance of local-only backups (not recommended). |
| `BACKUP_OFFHOST_TIMEOUT_SECONDS` | — | no | `3600` | Per hook. A timeout is a failure. |
| Hook settings: `OFFHOST_SSH_TARGET`, `OFFHOST_SSH_PATH`, `OFFHOST_SSH_KEY` (path) / `OFFHOST_RCLONE_REMOTE`, `OFFHOST_RCLONE_DOWNLOAD` | with the shipped hooks | no | — | Read by `deploy/backup/*.sh` only. |
| Off-host credentials (SSH private key, `RCLONE_CONFIG_*` / rclone config) | with the shipped hooks | **yes** | — | In the service user's own configuration or the secret store — never in the repository, the manifest or any log. |
| `BACKUP_MAX_AGE_HOURS` | — | no | `26` | `ops:monitor-check` fails `backup_freshness` when the newest COMPLETE set is older. Choose: schedule interval + margin. |
| `MONITOR_MIN_FREE_MB` | — | no | `1024` | Free-space threshold for the document volume and `BACKUP_DIR`. |
| `MONITOR_SKIP_API` | — | no | `false` | `true` on a host that runs the checks but not the API. |
| `MONITOR_SKIP_BACKUP` | — | no | `false` | Development only; refused in production. |

## Web build

| Variable | When | Purpose |
|---|---|---|
| `VITE_API_BASE_URL` | build time, split-origin deployments only | API origin when the web app is served from a different host (then also add it to the CSP `connect-src` and list the web origin in `CORS_ORIGIN`). Same-origin (recommended) leaves it unset. |
