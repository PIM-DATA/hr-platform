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

`NODE_ENV` is one of `development`, `test`, `production`. Production never falls back to development defaults —
`parseEnv` (apps/api/src/config/env.ts) collects every problem and the process **exits before listening**:

| Rule in production | Why |
|---|---|
| `DATABASE_URL` required | no implicit local database |
| `CORS_ORIGIN` required, `https://` only, no `localhost`, never `*` | session cookies are credentialed |
| `SEED_DEMO_PASSWORD` must be unset | demo accounts are a development feature |
| `SEED_ADMIN_PASSWORD` may not be a known placeholder | e.g. `change-me-locally` |
| `COOKIE_SECURE=false` rejected | session cookies must be `Secure` |
| `TEST_DATABASE_URL` required under `NODE_ENV=test`, and different from `DATABASE_URL` | the suite wipes every table |

A production database on the same host is allowed (single-VM install) but logged as a warning at startup.

`ENV_FILE` points the loader at a configuration file outside the repository; real process environment variables always
win over file values.

### Environment variables (names only)

`NODE_ENV`, `PORT`, `LOG_LEVEL`, `DATABASE_URL`, `TEST_DATABASE_URL`, `CORS_ORIGIN`, `TRUST_PROXY`,
`API_RATE_LIMIT_PER_MINUTE`, `JSON_BODY_LIMIT`, `SESSION_TTL_HOURS`, `LOGIN_MAX_ATTEMPTS`, `LOGIN_WINDOW_MINUTES`,
`COOKIE_SECURE`, `APP_VERSION`, `ENV_FILE`; bootstrap-only: `BOOTSTRAP_ADMIN_EMAIL`, `BOOTSTRAP_ADMIN_PASSWORD`;
development-only: `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD`, `SEED_DEMO_PASSWORD`; frontend build-only:
`VITE_API_BASE_URL`.

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
npm run build          # packages/shared → apps/api (tsc → dist) → apps/web (vite → dist)
npm run db:deploy      # prisma migrate deploy   (never migrate dev / db push / migrate reset)
npm run start          # node apps/api/dist/server.js
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
- Passwords: bcrypt cost 12, minimum 8 characters (12 for the production bootstrap admin), never logged. There is no
  breached-password check and no password reset flow yet (§9).
- Authorization: permission codes + data scope, verified per request; see `docs/phase-2-leave-review.md`.

**Frontend CSP is not configured.** The API's own CSP is strict, but the static frontend needs a policy written against
what Vite actually emits, delivered by whatever serves the files. Guessing one here would either break the app or give
false comfort, so it is an explicit gap.

## 8. Deployment checklist

**Pre-deploy**
- [ ] `NODE_ENV=production` and every required variable set (the process refuses to start otherwise)
- [ ] `CORS_ORIGIN` = the public https origin(s); `TRUST_PROXY` = real number of proxy hops
- [ ] PostgreSQL reachable, credentials stored in the platform's secret store (never in the repository)
- [ ] `npm ci && npm run build` succeeds; `npm run typecheck` and `npm test` green
- [ ] TLS certificate valid at the edge; HTTP redirected to HTTPS
- [ ] Backup of the target database taken (restore is manual today)

**Deploy**
- [ ] `npm run db:deploy` (abort the release if it fails)
- [ ] Start `npm run start`; confirm the startup log shows the expected environment and version
- [ ] `GET /api/v1/health/ready` returns 200

**Post-deploy smoke**
- [ ] Sign in as an administrator; the session cookie shows `Secure`, `HttpOnly`, `SameSite=Lax`
- [ ] Dashboard loads; create → submit → approve one leave request; balance and notification update
- [ ] `/api/v1/leave/reports/overview` returns figures
- [ ] Logs show JSON lines with request ids and no secrets

**First install only**
- [ ] `BOOTSTRAP_ADMIN_EMAIL=… BOOTSTRAP_ADMIN_PASSWORD=… npm run bootstrap:admin` (creates reference data + one
      administrator; refuses placeholders, refuses to overwrite an existing account). Never run the demo seed.

**Rollback**
- Application: redeploy the previous build (the API is stateless).
- Schema: no automated rollback — write a new forward migration. `migrate reset` is never acceptable on customer data.

## 9. Known gaps after Task 15

- **Backup/restore**: `npm run db:backup` and `npm run db:restore:verify` exist and the restore drill passes
  (see docs/operations-runbook.md). Still missing: an off-host copy of backups, encryption at rest for dump files,
  automated scheduling/retention, backup-failure alerting and point-in-time recovery (WAL archiving).
- **Monitoring**: `npm run ops:check` plus structured events give a monitor something to consume, but no metrics,
  alerting, uptime checks or external error tracking (Sentry/Datadog) are wired up; logs go to stdout only.
- **Account recovery**: no password reset / forgot-password flow; an administrator must reset credentials.
- **Frontend CSP** and other static-hosting headers are not defined.
- **Horizontal scaling**: rate limiting (and any future in-process state) assumes a single instance.
- **PDPA/retention**: no data export, erasure workflow or audit-log retention policy.
- **Onboarding**: no customer data import tooling; no per-customer configuration management.
- **Dependency advisory**: `npm audit` reports 3 high advisories, all one issue — `deepmerge-ts` (stack exhaustion when
  merging recursive object graphs) reached through `@prisma/config` in the **Prisma CLI**. The CLI is a build/migration
  tool, not part of the request path: the running server loads `@prisma/client`, not `prisma`/`@prisma/config`. The only
  remediation npm offers is a Prisma **major downgrade** to 6.12.0, which would undo the pinned 6.19.3 PostgreSQL work,
  so it is deliberately not applied. Revisit when a patched Prisma release is available.
- Everything listed in `docs/phase-2-leave-review.md` §13–14 (approved-leave cancellation, attachments/uploads,
  external notification channels, report export, attendance and payroll integration).
