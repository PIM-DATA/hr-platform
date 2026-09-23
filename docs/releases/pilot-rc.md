# Pilot release candidate — 0.1.0-rc.1

The first release intended to be installed for a real customer, as a **pilot**: one company, a few dozen people, HR
Core plus Leave, run by an operator who is close to the customer.

Everything below is what the code does today, verified on a clean installation. Where something is missing, it says so.

---

## 1. What a pilot customer gets

**Core HR** — authentication (database-backed sessions, CSRF, rate limiting), role-based access with a data scope
(own / team / everyone), organizations, departments, jobs and positions, employee master data with position and
manager history, and an audit trail of every business change.

**Leave** — work calendars and holidays, leave types and policies (entitlement, half days, notice, backdating,
maximum consecutive days, attachment requirement), entitlements with an append-only ledger, requests with overlap and
policy validation, manager/department-head approval through a versioned workflow engine, a team calendar, in-app
notifications and reporting.

**Operations** — production configuration that fails fast, health probes, structured JSON logs with request ids,
graceful shutdown, database backup and restore **verification**, customer onboarding by Excel import, admin-assisted
account recovery, session administration, and privacy request tracking with personal-data export.

## 2. Deliberately not in this release

Attendance, payroll, performance, HRD/HROD modules, analytics, external notification delivery (email/SMS/LINE),
file upload and document storage, SSO/SAML/OIDC, multi-factor authentication, self-service registration, and
multi-tenancy. None of these are half-built: they are absent.

## 3. Security model in one page

- **Sessions** are database rows; the cookie holds an opaque 256-bit token and only its SHA-256 hash is stored.
  `HttpOnly`, `Secure`, `SameSite=Lax`. There is no JWT and **no signing secret to rotate**.
- **CSRF**: synchronizer token on every mutation, plus an origin check against the allow-list.
- **Authorization** is enforced in the API on every request — permission code plus data scope. The UI only hides what
  the user cannot do.
- **Passwords**: bcrypt cost 12, minimum 12 characters from one shared policy, never logged. Nobody — including a
  System Administrator — can read or set another person's password; recovery is a one-time link built from
  `PUBLIC_APP_URL`, never from a request header.
- **Audit**: every business mutation is written in the same transaction as the change, with the actor, and passes
  through a redactor that blanks anything that looks like a secret.
- **Logs** carry the request path without its query string, so a token in a URL cannot reach a log file.
- **Personal data export** excludes credentials and other people's data, and states what it leaves out.

## 4. Operational prerequisites (the customer or operator provides these)

1. **Off-host backup destination.** `npm run db:backup` + `npm run db:restore:verify` work and are verified in this
   release, but they write to a directory on the same host. A copy elsewhere is a **go-live requirement**, not a
   nice-to-have.
2. **HTTPS** terminated in front of the API, with `TRUST_PROXY` set to the real number of hops.
3. **Uptime monitoring** — something that calls `/api/v1/health/ready` (or `npm run ops:check`) and tells a human when
   it fails. The application ships no alerting.
4. **A secure channel** for handing over password reset links, since no email is sent.
5. **Privacy paperwork** — notice, legal basis, retention schedule, and who decides deletion requests.

## 5. Test evidence

| Evidence | Result |
|---|---|
| Automated suite | **464 tests, 26 files, 5/5 consecutive full runs green** |
| Concurrency (row locks) | balance (10), workflow (7), leave (7), notifications (19) and account/privacy (23) suites green on their own; each lock is mutation-checked — removing it makes its test fail |
| Fresh install | clean database → `npm ci` → build → `migrate deploy` → bootstrap admin → compiled production server → readiness OK |
| Pilot end-to-end | onboarding import (1 org, 3 departments, 3 jobs, 5 positions, 10 employees) → accounts → calendar/holiday/type/policy/workflow/entitlement → submit → approve → notifications → report → backup + restore verify → reset link → privacy request + export → audit trace. **All green on the clean instance.** |
| Security probes | unauthenticated surface 401, CSRF/origin rejection, cookie flags, cross-employee access denied (404, no existence disclosure), employee cannot export another's data, no credential material in any response |
| Backup drill | 106 KB dump in 133 ms; restore verification 0.9 s (33 tables, 5 migrations, restored sessions revoked) |
| Frontend CSP | built bundle runs under a strict policy with **no violations** (see production-readiness §7) |
| Mobile | 390 px walkthrough of login, leave, approvals, notifications, account security, reset page — no horizontal scroll |

**Browsers**: tested on current Chrome/Chromium only. Safari, Firefox and Edge are expected to work (no
browser-specific APIs are used) but have **not** been tested — do not promise them to a customer.

**Tested capacity** (measured, not an SLA): onboarding import of **1,000 employees** (preview 98 ms, commit 6.05 s);
lists and reports are paginated; one API instance per customer. No load test of concurrent users has been run, so no
concurrency figure is claimed.

## 6. Commercial gap matrix

| Area | Status today | Pilot blocker? | Mitigation for the pilot | Future work |
|---|---|---|---|---|
| External notification (email/SMS/LINE) | in-app only; delivery outbox exists, no provider | **No** | approvers check the system; agree an expectation ("check daily") | provider integration behind the existing outbox |
| User bulk provisioning | one account at a time in Administration → Users; the import never creates accounts | **No** for a pilot of a few dozen; would be for hundreds | budget onboarding time; create accounts as people need them | bulk/invite provisioning |
| Entitlement batch generation | one action per employee/type | **No** at pilot size | generate during onboarding, not on demand | batch generation per policy/period |
| File attachments | `requiresAttachment` exists; there is no upload — the field is a free-text reference | **No** | leave `requiresAttachment` **off** in pilot policies, or use it as a reference note (e.g. a document number) and keep the document outside the system | document storage |
| Off-host backup | local dump + verified restore; no off-host copy | **No for the code, yes for go-live** | operator copies backups off the host before real data goes in (checklist §7) | scheduled, encrypted, off-host retention |
| External monitoring/alerting | health probes, `ops:check`, structured logs | **No** | operator's uptime check + log review | metrics and alerting integration |
| Frontend CSP | policy defined and verified against the built bundle; the static host sets the header | **No** | apply the header from production-readiness §7 | automated header test in CI |
| Retention automation | none for business data; spent reset tokens are cleaned by a command | **No** | customer policy + manual action | retention jobs once the policy exists |
| SSO / MFA | not implemented | **No** | strong passwords, session revocation, admin-assisted recovery | SSO first, then MFA |
| Attendance | not implemented | **No** (out of pilot scope) | — | next module candidate |
| Payroll | not implemented | **No** (out of scope) | — | — |
| Multi-tenancy | not implemented by design | **No** | one deployment + one database per customer | — |
| Horizontal scaling | rate limiting and the login limiter are process-local | **No** (one instance per customer) | run one API instance | shared store before scaling out |

## 7. Customer isolation

The commercial model is one customer per deployment per database, and the code has no notion of a tenant — reviewed
for this release:

- **No `tenantId` anywhere**, and no row-level customer filter to get wrong. `Organizations` are structure *inside* one
  customer (companies, legal entities), not tenants.
- **Nothing shared at runtime**: the server writes no files, holds no cross-request cache of business data, and its
  only process-local state is the rate-limiter counters and the login-failure counters — per instance, per customer.
- **One database per deployment.** `DATABASE_URL` is the only data path; the test-database guard makes it impossible
  for a test run to point at it.
- **Separate configuration**: each install has its own `ENV_FILE` (or platform environment), its own `PUBLIC_APP_URL`
  and `CORS_ORIGIN`, and its own backup directory.
- **Logs** go to that process's stdout only; they contain ids and paths, not another customer's data.
- **Backups**: dumps are named `hr-enterprise-<timestamp>.dump`, so give each customer its **own** `BACKUP_DIR`
  (e.g. `/var/backups/hr/<customer>`); two customers must never share a directory.
- **No uploads**: the onboarding workbook is parsed in memory and never stored, so there is no shared file area.

## 8. Known dependency advisories (`npm audit`, at release time)

`npm audit` reports **5 advisories: 3 high, 2 moderate**. None is in the request path of the running server:

| Advisory | Path | Exposure |
|---|---|---|
| `deepmerge-ts` — stack exhaustion on recursive object graphs (**high**) | `prisma` → `@prisma/config` → `deepmerge-ts` | **Build/migration tooling only.** The server loads `@prisma/client`, not the Prisma CLI. Nothing in production merges untrusted object graphs. |
| `uuid <11.1.1` — missing buffer bounds check in v3/v5/v6 when a buffer is supplied (**moderate**) | `exceljs` → `uuid` | **Excel parsing path.** The workbook parser never calls those uuid functions with a caller-supplied buffer. Workbooks are already limited to 10 MB / 5,000 rows, `.xlsx` only, formulas rejected, and the file is never stored. |

This is not "zero vulnerabilities" and is not presented as such. Both are transitive, both are tracked, and both will
be resolved by upgrading `prisma` and `exceljs` when their fixed versions land.

## 9. Backlog from this review (non-blocking)

Found during the pilot readiness review, none of them a blocker; recorded so they are not rediscovered:

- **A malformed path parameter returns 500 instead of 400.** A NUL byte in an id (`/leave/requests/%00`) reaches
  PostgreSQL, which rejects the byte sequence; the caller gets the generic 500 envelope with a request id (no SQL is
  leaked), but the log gets a stack trace. Requires an authenticated session — unauthenticated routes validate through
  the schema and answer 400/401. Fix: reject NUL bytes and over-long values in id parameters, and map the error to 404.
- **The request id is not shown in the UI.** The API returns it on unknown errors; the screens show the message only,
  so a user cannot quote it to support. Fix: surface it in the generic error alert.
- **`npm run db:deploy` does not read `ENV_FILE`** (the Prisma CLI reads its own environment). Documented in
  production-readiness and the pilot checklist; a wrapper script would remove the trap.
- **Backup file names do not carry the customer code.** Harmless with one directory per customer, which the checklist
  requires, but a name like `hr-<customer>-<timestamp>.dump` would be safer to handle.

## 10. Upgrade and migration notes

- Schema changes are **forward-only**: a new migration, applied with `npm run db:deploy`. There is no automated
  rollback and `prisma migrate reset` is never acceptable on customer data.
- Take a verified backup before any upgrade; the runbook's restore procedure is the rollback plan.
- Data seeded by the demo seed is **development-only** and never present on a customer installation.
- This is the first release, so there is no upgrade path to describe yet. Record the installed version
  (`APP_VERSION`, reported by `/api/v1/health`) so the next upgrade knows where it started.

## 11. Version convention

`MAJOR.MINOR.PATCH-rc.N` for release candidates (`0.1.0-rc.1`), dropping the suffix for a release (`0.1.0`).
Set `APP_VERSION` to the same string on every deployment: it is reported by `/api/v1/health` and printed in the
startup log, which is how an operator proves which build is running. Nothing is published to a package registry.
