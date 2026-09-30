# Production readiness

Status after Task 15 (production foundation). This describes how the codebase expects to be deployed and what is still
missing. It contains no credentials and no environment values — only variable names.

---

## 1. Commercial instance model

One customer = one application deployment = one PostgreSQL database.

```
Customer A:  app instance A  →  database A
Customer B:  app instance B  →  database B
```

There is **no shared multi-tenant layer**: no `tenantId` columns, no cross-customer row filtering, no billing or
subscription logic. The `organizations` tree inside a single deployment models group companies, subsidiaries and
business units for **one** customer — it is not a tenant boundary and must never be used as one. If a shared SaaS
platform is wanted later, that is its own architectural phase (data model, isolation strategy, migration of existing
single-tenant installs), not a retrofit.

The API is assumed to run as **one instance per customer**. That assumption is what makes the in-process rate limiters
correct (§6); running two instances without a shared store weakens them.

## 2. Environments

`NODE_ENV` must be exactly one of `development`, `test`, `production` — it has **no default** (Task 46): unset, blank or
any other value refuses to start. Production never falls back to development defaults —
`parseEnv` (apps/api/src/config/env.ts) collects every problem and the process **exits before listening**:

| Rule in production | Why |
|---|---|
| `DATABASE_URL` required | no implicit local database |
| `CORS_ORIGIN` required, `https://` only, no `localhost`, never `*` | session cookies are credentialed |
| `SEED_DEMO_PASSWORD` must be unset | demo accounts are a development feature |
| `SEED_ADMIN_PASSWORD` may not be a known placeholder | e.g. `change-me-locally` |
| `COOKIE_SECURE=false` rejected | session cookies must be `Secure` |
| `PUBLIC_APP_URL` required (https, no credentials/query/fragment, not localhost) | reset links are built from it |
| `TRUST_PROXY` required: `off`, hop count 1–10 or proxy IPs/CIDRs; `true`/`*`/`all` refused | client IP and protocol must match the real topology |
| `DOCUMENT_STORAGE_DIR` required while documents are enabled; temporary paths (incl. `/private/tmp`) refused | uploaded files must survive restarts |
| copilot `fake` provider refused; `COPILOT_API_KEY` required when enabled | no test double in production |
| `TEST_DATABASE_URL` required under `NODE_ENV=test`, and different from `DATABASE_URL` | the suite wipes every table |

A production database on the same host is allowed (single-VM install) but logged as a warning at startup.

`ENV_FILE` points the loader at a configuration file outside the repository; real process environment variables always
win over file values.

### Environment inventory (names and formats only — never real values)

The complete, current reference is **[environment-reference.md](environment-reference.md)** (Task 46); the table below
is the short list. Every variable the code actually reads. "Secret" means it must live in the platform's secret store, never in the
repository, a ticket or a chat message.

**Required in production** — the process refuses to start without the first four (plus `TRUST_PROXY`, and
`DOCUMENT_STORAGE_DIR` while documents are enabled — see the reference); `BACKUP_DIR` is required by the
backup command rather than at startup.

| Variable | Purpose | Example format | Secret |
|---|---|---|---|
| `NODE_ENV` | selects the strict production rules | `production` | no |
| `DATABASE_URL` | PostgreSQL connection for this customer's database | `postgresql://USER:PASSWORD@HOST:5432/DB?schema=public` | **yes** |
| `CORS_ORIGIN` | browser origin(s) allowed to call the API; also the CSRF origin check | `https://hr.customer.example` (comma-separated for several) | no |
| `PUBLIC_APP_URL` | base URL for links the server generates (password resets). https, no credentials, no query/fragment, not localhost | `https://hr.customer.example` | no |
| `BACKUP_DIR` | directory that holds database dumps and manifests (files are written `0600`) | `/var/backups/hr` | no |

**Optional, with defaults** — set them deliberately; the defaults are safe but not always right for a given host.

| Variable | Purpose | Default / example | Secret |
|---|---|---|---|
| `PORT` | API listen port | `4000` | no |
| `LOG_LEVEL` | pino level | `info` | no |
| `TRUST_PROXY` | reverse-proxy hops to trust for client IP and protocol | `0` (direct), `1` (one proxy) | no |
| `SESSION_TTL_HOURS` | session lifetime | `12` | no |
| `LOGIN_MAX_ATTEMPTS` / `LOGIN_WINDOW_MINUTES` | failed-login limiter per IP | `10` / `15` | no |
| `API_RATE_LIMIT_PER_MINUTE` | global per-IP ceiling (`0` disables) | `600` | no |
| `JSON_BODY_LIMIT` | maximum request body | `1mb` | no |
| `PASSWORD_RESET_TTL_MINUTES` | lifetime of an admin-issued reset link (5–1440) | `60` | no |
| `COOKIE_SECURE` | forced `true` in production regardless; may not be `false` there | `true` | no |
| `APP_VERSION` | build marker reported by `/health` | `0.1.0-rc.1` | no |
| `ENV_FILE` | path to a configuration file outside the repository | `/etc/hr-platform/api.env` | no (its contents are) |

**Operational (tools, not the server)**

| Variable | Purpose | Example | Secret |
|---|---|---|---|
| `BOOTSTRAP_ADMIN_EMAIL` / `BOOTSTRAP_ADMIN_PASSWORD` | first administrator, one command, once | `admin@customer.example` / 12+ characters | password **yes** |
| `PG_BIN_DIR` | where `pg_dump`/`pg_restore`/`psql` live, when not on `PATH` | `/usr/lib/postgresql/18/bin` | no |
| `OPS_CHECK_URL` / `OPS_CHECK_TIMEOUT_MS` | override the health-probe target (defaults to `127.0.0.1:$PORT`) | `https://hr.customer.example` / `5000` | no |

**Never set in production** (the process refuses `SEED_DEMO_PASSWORD`, and the demo seed refuses to run):
`TEST_DATABASE_URL`, `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD`, `SEED_DEMO_PASSWORD`, `TEST_LOG_LEVEL`.
Frontend build-only: `VITE_API_BASE_URL` (split-origin deployments only).

**The Prisma CLI does not read `ENV_FILE`.** It reads the process environment (or `apps/api/.env`), so a host whose
configuration lives outside the repository runs migrations as
`DATABASE_URL="$(…)" npm run db:deploy`, or with `DATABASE_URL` exported in the deploy shell. The application server,
the backup, restore-verify, ops-check, session-revoke and reset-token-cleanup commands all honour `ENV_FILE`.

There is **no session signing secret**: sessions are database-backed and the cookie carries an opaque token whose
SHA-256 hash is stored, so there is nothing to sign and no secret to rotate.

## 3. Deployment architecture (provider-neutral)

```
browser ──HTTPS──▶ reverse proxy / platform edge
                     ├── /            → static files from apps/web/dist
                     └── /api         → Node process: node apps/api/dist/server.js
                                         │
                                         └── PostgreSQL
```

The application does **not** terminate TLS. HTTPS is mandatory in production; plain HTTP is unsupported because session
cookies are `Secure`. Serving the frontend and the API from one origin is the recommended setup: cookies work without
CORS and `CORS_ORIGIN` only needs the public origin. A split deployment is supported — build the frontend with
`VITE_API_BASE_URL` and list that origin in `CORS_ORIGIN`.

`TRUST_PROXY` must equal the number of proxy hops. It is `0` by default: trusting `X-Forwarded-*` headers that nothing
sets would let a client spoof its own IP (rate limiting) and protocol (secure cookies).

No Dockerfile is shipped. Docker is not installed in the development environment, and an untested container definition
would be a liability rather than a convenience; the build/run contract above is everything an image needs.

## 4. Build and release

```bash
npm ci
npm run build          # Prisma client generation → packages/shared → apps/api (tsc → dist) → apps/web (vite → dist)
npm run db:deploy      # prisma migrate deploy   (never migrate dev / db push / migrate reset)
npm run start          # NODE_ENV=production node apps/api/dist/server.js
```

Deployment order is **build → migrate → start**, and a failed migration must abort the release: the new code is not
started against an unmigrated database. Production never runs `vite dev` or `tsx watch`.

Schema rollback is **not** automated. `prisma migrate reset` is destructive and must never be used on a customer
database; a schema change that has to be undone needs a new forward migration. Restoring data is a database-level
restore, which is still a gap (§9).

## 5. Runtime behaviour

- **Probes** — `GET /api/v1/health` (app + database), `/health/live` (process only), `/health/ready` (503 when the
  database is unreachable). Unauthenticated, exempt from rate limiting, and free of internal detail; the failure reason
  goes to the log, not the response.
- **Graceful shutdown** — `SIGTERM`/`SIGINT` stop accepting connections, wait for in-flight requests, disconnect
  Prisma, then exit; a 10s timer forces exit if something hangs. `uncaughtException` / `unhandledRejection` are logged
  as fatal and start the same shutdown instead of limping on in an unknown state.
- **Logging** — structured JSON in production (pretty only in development) with `timestamp`, `level`, `requestId`,
  `method`, `url`, `status`, `durationMs`, `userId`. Passwords, hashes, tokens, cookies and authorization headers are
  redacted by the logger; request bodies are never logged, so leave reasons and attachment references stay out of logs.
  Startup logs the environment, port, version, proxy setting and origin count — never a connection string or host.
- **Request ids** — an inbound `x-request-id` is echoed, otherwise one is generated; the same id appears in error logs
  and in 5xx responses so a user report can be traced.
- **Errors** — production returns `{ error: { code, message, requestId } }` with a generic message for unknown errors;
  stack traces, SQL and Prisma internals never reach a client. Business errors keep their specific codes.

## 6. Rate limiting

| Scope | Default | Notes |
|---|---|---|
| Failed logins per IP | `LOGIN_MAX_ATTEMPTS` (10) per `LOGIN_WINDOW_MINUTES` (15) | success resets the counter; `Retry-After` sent |
| All `/api/v1` requests per IP | `API_RATE_LIMIT_PER_MINUTE` (600/min) | `RateLimit-*` headers; `0` disables |
| Health probes | exempt | a platform probe must never be throttled |

Both limiters are in-process. With one instance per customer that is the whole system; horizontal scaling needs a
shared store (Redis or equivalent) and is listed as a gap rather than built speculatively.

## 7. Security posture

- Session cookie: `HttpOnly`, `Secure` (forced in production), `SameSite=Lax`, DB-backed with SHA-256 token hashes and
  `SESSION_TTL_HOURS` expiry; deactivating a user invalidates their sessions on the next request.
- CSRF: synchronizer token (`x-csrf-token`) on every mutation, plus an Origin check against the allow-list.
- CORS: explicit allow-list from `CORS_ORIGIN`; no wildcard, no origin reflection.
- Headers on every response: `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`,
  `Cross-Origin-Opener-Policy`, `Cross-Origin-Resource-Policy`, `Permissions-Policy`, a strict API CSP
  (`default-src 'none'`), and `Strict-Transport-Security` in production.
- Passwords: bcrypt cost 12, minimum **12 characters everywhere** (one shared policy: user creation, own change, reset link, `bootstrap:admin`; the development seed is the only, explicitly non-production, exception), never logged. Recovery is
  admin-assisted through a one-time reset link (`docs/account-recovery.md`); no administrator can read or set another
  person's password. There is no breached-password check and no email-delivered self-service reset (§9).
- Authorization: permission codes + data scope, verified per request; see `docs/phase-2-leave-review.md`.

### Frontend headers (Task 19 → Task 46)

The static frontend is served by the reverse proxy, which owns its headers, caching and HSTS. The verified policy and
reference configurations (Apache, verified end-to-end over TLS; nginx, equivalent) are in `deploy/`, with
`deploy/security-headers.json` as the single source; see [deployment.md §9](deployment.md). Task 46 tightened the Task 19
policy: `style-src 'self'` without `'unsafe-inline'` (React applies style props through the CSSOM, and 75 page visits on
real data produced no violation) and Zod runs `jitless`, so there is no eval probe either. Check a live deployment with
`npm run ops:verify-web -- https://<host>`.

## 8. Deployment checklist

**Pre-deploy**
- [ ] `NODE_ENV=production` and every required variable set (the process refuses to start otherwise)
- [ ] `CORS_ORIGIN` = the public https origin(s); `TRUST_PROXY` matches the topology (docs/deployment.md §8)
- [ ] `PUBLIC_APP_URL` = the https origin users open — **required**; the process refuses to start without it, and it must have no credentials, query string or fragment (reset links are built from it, never from the request host)
- [ ] PostgreSQL reachable, credentials stored in the platform's secret store (never in the repository)
- [ ] `npm ci && npm run build` succeeds; `npm run typecheck` and `npm test` green
- [ ] TLS certificate valid at the edge; HTTP redirected to HTTPS
- [ ] Backup of the target database taken (restore is manual today)

**Deploy**
- [ ] `DATABASE_URL=… npm run db:deploy` (the Prisma CLI does not read `ENV_FILE`; abort the release if it fails)
- [ ] Start `npm run start`; confirm the startup log shows the expected environment and version
- [ ] `GET /api/v1/health/ready` returns 200

**Post-deploy smoke**
- [ ] `npm run ops:verify-web -- https://<host>` passes (web headers, caching, single HSTS, API no-store)
- [ ] Sign in as an administrator; the session cookie shows `Secure`, `HttpOnly`, `SameSite=Lax`
- [ ] Dashboard loads; create → submit → approve one leave request; balance and notification update
- [ ] `/api/v1/leave/reports/overview` returns figures
- [ ] Issue a reset link for a test account, use it in a private window, confirm the link is refused the second time
- [ ] Logs show JSON lines with request ids and no secrets

**First install only**
- [ ] `BOOTSTRAP_ADMIN_EMAIL=… BOOTSTRAP_ADMIN_PASSWORD=… npm run bootstrap:admin` (creates reference data + one
      administrator; refuses placeholders, refuses to overwrite an existing account). Never run the demo seed.

**Rollback**
- Application: redeploy the previous build (the API is stateless).
- Schema: no automated rollback — write a new forward migration. `migrate reset` is never acceptable on customer data.

## 9. Known gaps

- **Backup/restore**: `npm run db:backup` and `npm run db:restore:verify` exist and the restore drill passes
  (see docs/operations-runbook.md). Still missing: an off-host copy of backups, encryption at rest for dump files,
  automated scheduling/retention, backup-failure alerting and point-in-time recovery (WAL archiving).
- **Monitoring**: `npm run ops:check` plus structured events give a monitor something to consume, but no metrics,
  alerting, uptime checks or external error tracking (Sentry/Datadog) are wired up; logs go to stdout only.
- **Account recovery**: admin-assisted recovery is available (self-service password change, one-time reset links,
  session revocation — `docs/account-recovery.md`). Self-service email delivery is **not implemented**: there is no
  email/SMS provider, so an administrator must hand the link over. No MFA and no SSO.
- ~~Frontend CSP and other static-hosting headers are not defined.~~ Defined, shipped as reference proxy configurations
  and verified (Task 46, `deploy/`).
- **Horizontal scaling**: rate limiting (and any future in-process state) assumes a single instance.
- **Privacy/retention**: a privacy operations foundation exists — request register and personal-data export
  (`docs/privacy-operations.md`). Still required from the customer: a legal/retention policy, audit-log and
  employee-record retention rules, and any automated erasure or anonymisation, none of which this system performs.
  Nothing here constitutes a compliance certification.
- **Onboarding**: the Excel import (docs/customer-onboarding.md) covers the initial structure and employees.
  Still missing: bulk update/correction tooling, user-account provisioning and invitations, historical leave/payroll
  data migration, and per-customer configuration management.
- **Commercial gaps** (bulk user provisioning, batch entitlement generation, external notification delivery, file
  attachments, off-host backup integration, external monitoring, retention automation): reviewed and classified for the
  pilot in `docs/releases/pilot-rc.md`.
- **Dependency advisories**: the Excel parser (`exceljs`) pulls `uuid <11.1.1`, which carries a **moderate** advisory
  (missing buffer bounds check in uuid v3/v5/v6 when a buffer is supplied — a code path the workbook parser does not
  use). Revisit when exceljs updates its dependency. Separately, `npm audit` reports 3 high advisories, all one issue — `deepmerge-ts` (stack exhaustion when
  merging recursive object graphs) reached through `@prisma/config` in the **Prisma CLI**. The CLI is a build/migration
  tool, not part of the request path: the running server loads `@prisma/client`, not `prisma`/`@prisma/config`. The only
  remediation npm offers is a Prisma **major downgrade** to 6.12.0, which would undo the pinned 6.19.3 PostgreSQL work,
  so it is deliberately not applied. Revisit when a patched Prisma release is available.
- Everything listed in `docs/phase-2-leave-review.md` §13–14 (approved-leave cancellation, attachments/uploads,
  external notification channels, report export, attendance and payroll integration).
