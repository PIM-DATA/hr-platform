# Final enterprise readiness audit (Task 44)

Audit date 2026-09-30 · repository `main` @ `4c00041` (0.1.0-rc.1) · audit only — no production behaviour was changed.

Question answered: *what prevents this exact system from being deployed safely as a real customer pilot or
production HR system?* Feature count is not graded. Every finding below is backed by code (`file:line`) or by a live
drill run for this audit; items that could not be proven are marked **UNVERIFIED**.

**Method.** Six read-only code reviews (auth/session/config; RBAC/authorization/reports; privacy/audit/documents;
money/time/concurrency/migrations; operations/deployment; copilot/analytics) plus live drills on a **clean clone** and a
**new empty PostgreSQL database** running the **compiled production build** with `NODE_ENV=production`: fresh install,
all migrations, bootstrap, fail-fast matrix, HTTP hardening probe, RBAC self-escalation stress test, password-reset
takeover test, document upload attack set, database backup, restore-verify, a full restore into a separate database with
document storage, the "database restored / documents missing" scenario, a 1,000-employee import, a 520-employee
department correctness test, the high-impact copilot prompts, a six-role browser walk (151 page visits) and a 390 px
smoke. Two audit test files were added (§22).

---

## 1. Executive summary

The application core is careful: Decimal money everywhere authoritative, row locks and idempotency keys on every
contended operation (with concurrency tests), a fail-fast production configuration, hashed session and reset tokens,
CSRF + Origin checks, hardened downloads and uploads, formula-safe CSV, checksummed backups with a working restore
drill, and permission checks that never trust the UI. The six-role browser walk found no broken page, and a fresh
production-mode install from an empty database works once one missing build step is added.

What stands between this system and real use:

1. **One P0 privilege escalation.** An HR_ADMIN can issue a password-reset link for a SYSTEM_ADMIN and log in as them
   (proven live). The account-recovery path has no "target must not out-rank the actor" rule.
2. **The Task 43 separation of duties is not enforced.** A `roles.manage` holder can grant itself any business
   permission (compensation apply, payroll) in one call, three different ways (proven live). It is audited, not prevented.
3. **Confidentiality leaks of individual results through aggregates.** Every employee can open the organization-wide
   performance report (a one-person department shows that person's score — proven live); executive and Report Center
   aggregates have no minimum group size; engagement anonymity can be defeated by subtraction.
4. **Operations are the operator's job and nothing reminds them.** No monitoring or alerting, no off-host or encrypted
   backup, document storage is not in any backup script, readiness reports "ok" with the document volume gone,
   runbook alert event names are not emitted by the code.
5. **Correctness gaps that silently lose data.** Attendance and overtime reports stop at 500 employees per department
   (proven live, also in executive analytics); payroll ignores the salary currency; a deleted payroll line can lose a
   reimbursement; source changes after payroll approval are not reconciled.
6. **The documented production build fails on a clean checkout** (`prisma generate` is never run).

| Classification | Result |
|---|---|
| COMMERCIAL PILOT | **CONDITIONAL** — after the Pilot blockers in §27 |
| PRODUCTION | **NO** — see §28 |
| ENTERPRISE | **NO** — see §29 |

### Remediation status (updated after the audit)

| Finding | Status | Evidence |
|---|---|---|
| T44-P0-01 password-reset / PATCH / deactivate takeover of a privileged account | **RESOLVED — Task 45** | Exploit reproduced first (`tests/privileged-accounts.test.ts` failed: HR_ADMIN reset SYSTEM_ADMIN → `201`); after the fix `403 PRIVILEGED_ACCOUNT_PROTECTED`, no token, no audit row, sessions and password unchanged; same for PATCH, roles, activate, deactivate, sign-out and the offboarding path; browser walk confirmed. Semantics: docs/account-security-rbac.md |
| T44-P1-01 RBAC separation of duties (`roles.manage` self-escalation) | **RESOLVED — Task 45** | Paths A (self-assign), C (edit held role), D (edit role then self-assign), data-scope widening and a crafted "RBAC admin + business" role → 403; compensation Apply and payroll administration stay 403 afterwards. Remaining governance limits (two colluding administrators, account creation, recovery links for ordinary accounts) are documented, not prevented |
| T44-P1-02 clean-checkout build fails (Prisma client not generated) | **RESOLVED — Task 46** | Reproduced first on a fresh clone (`npm ci` ok, `npm run build` → 1,905 TS errors). Now `build`, `typecheck` and `test` run `prisma generate` themselves; `npm run verify:clean-build` (git archive → `npm ci` → `npm run build`, outputs present, no source maps) passes; the documented path ran end-to-end on an empty database |
| T44-P1-03 `NODE_ENV` fails open to development | **RESOLVED — Task 46** | No default: unset/blank/`prod`/`banana` refuse to start (tested on the built server and in `production-baseline.test.ts`); `dev`/`test`/`start` scripts set the mode explicitly (`start` = production from `dist`) |
| T44-P1-04 `TRUST_PROXY` unvalidated (proxy lock-out / spoofing) | **RESOLVED — Task 46** | Typed `off` / hops 1–10 / IP-CIDR list, "trust everything" refused, required in production; real-Express tests: spoofed X-Forwarded-For ignored when off, proxy-appended client used when trusted, prepended fakes ignored, login limiter not bypassed. (Per-account throttling remains T44-P2-04.) |
| T44-P1-08 web security headers operator-only | **RESOLVED — Task 46** | Reference proxy configurations in `deploy/` (Apache verified end-to-end over HTTP and TLS; nginx equivalent, parity-tested), `deploy/security-headers.json` as single source, `npm run ops:verify-web`; CSP tightened to `'self'` only (no `unsafe-inline`/`unsafe-eval`) and proven on 75 page visits with zero violations; one HSTS header owned by the TLS proxy; index.html `no-cache`, hashed assets immutable |
| T44-P1-09 sensitive API responses cacheable | **RESOLVED — Task 46** | Central `Cache-Control: no-store` on every API response (ETag off); tested on auth/me, employee, payslips, letters, benefits, expense, privacy export, document download, health, errors |
| T44-P2-06 (part) `/private/tmp` accepted as document storage | **RESOLVED — Task 46** | Refused in production. DB TLS requirement and `API_RATE_LIMIT_PER_MINUTE=0` remain open |
| T44-P1-05 organization performance / competency reports open to every employee | **RESOLVED — Task 47** | Reproduced first (`confidentiality-privacy.test.ts`: EMPLOYEE `200` with SOLO's "1.20"). Now `performance.view_reports` / `competency.view_reports` + ALL scope (EMPLOYEE and MANAGER `403`, no data); authorized readers get scores only for groups ≥ 5 with complementary suppression; own plan still readable |
| T44-P1-06 engagement differencing | **RESOLVED — Task 47** | Reproduced first (overall 20 − Sales 16 = Legal 4). Partition rule per cohort condition inside `aggregate` (all consumers); participation completion hidden for suppressed groups; tested in breakdown, filter and mixed order, for HR Admin, Executive and SYSTEM_ADMIN |
| T44-P1-07 small groups in executive analytics and Report Center | **RESOLVED — Task 47** | Performance / competency / ER sources suppress small groups (executive dashboard and copilot inherit); every aggregate dataset declares a privacy kind; per-person datasets must aggregate, groups < 5 people withheld and counted (API, CSV, copilot) |
| T44-P1-17 privacy export incomplete | **RESOLVED — Task 47** | Export adds compensation, closed payroll, attendance / OT, performance, competency, training / IDP, document metadata and recruitment origin; every exclusion has a reason; false "payroll export rules" line removed |
| T44-P1-18 free text in the audit log | **RESOLVED — Task 47** | Call sites log lengths / flags; per-module registry redacts on write and read; sentinel test over leave reason (draft + edit), approver comment, termination reason and ER title, plus a raw legacy row masked on read. (Audit correction: the workforce plan `reason` is an enum code, not free text.) |
| T44-P1-20 salary letters readable without payroll authority | **RESOLVED — Task 47** | Reproduced first (service-desk role read "41234.00"); subject / body / salary withheld unless owner or `payroll.manage` (detail, list, request summaries); issuing still needs payroll authority |
| T44-P1-24 payroll run export not audited | **RESOLVED — Task 47** | `EXPORT_PAYROLL_RUN` with run, period, row count, format — no salary; unknown run `404`; refused export writes nothing |
| T44-P1-19 self-approval, T44-P1-21 scope per permission, T44-P1-22 copilot high-impact | open — deliberately not in Task 47 | P1-19 is maker-checker governance, not a data-exposure path; P1-21 needs an RBAC scope redesign (would destabilize Task 45); P1-22: source authorization is intact (tools re-check permissions, suppressed results reach the model) — the gap is behavioural enforcement |
| Test harness (Task 47) | fixed | The recurring "organization position 409" flake: `organization.test.ts` looked up `code: 'SALES'` without `isActive`/order, and ZED's SALES department is deactivated earlier in the file — PostgreSQL returned either (evidence: `409 DEPARTMENT_INACTIVE`). Lookup pinned to the active department. Also `benefits.test.ts` drew receipt document numbers from 90 random values (unique-constraint collision) — now a counter. No business fixture changed |
| T44-P1-13 attendance / overtime truncation | **RESOLVED — Task 48** | Reproduced first (`audit44-large-department.test.ts` on the old code: 501 → 500, 1,000 → 500, 3,020 → 500, OT 60,000 → 30,000 minutes, page of 500 rows). Totals are one SQL aggregate over the full scope; rows are a page (`meta`, `totalEmployees`, `pageSize` ≤ 100); executive uses row-free `summary`; recalculation batches through everybody (no 2,000 cap, 3,020 verified). Tested at 499/500/501/520/1,000 and 3,020; both `it.fails` converted to `it` |
| T44-P1-14 payroll currency | **RESOLVED — Task 48** | Reproduced first (`financial-integrity.test.ts`: USD salary → `200`, paid as THB; USD claim / report handed over → `200`). Now `409 PAYROLL_CURRENCY_MISMATCH` at calculation (nothing written) and at handoff (source stays `READY_FOR_PAYMENT`); salary currency in the fingerprint; no FX anywhere |
| T44-P1-15 payroll handoff loss | **RESOLVED — Task 48** | Reproduced first (old code: `DELETE /payroll/adjustments/:id` `200` for benefits and expense lines; after a recalculation the claim pointed at a non-existent line). Now `409 PAYROLL_ITEM_SOURCE_LINKED`, FK `ON DELETE RESTRICT` (migration `20261003090000`, repairs dangling pointers), in-place recalculation keeps ids, `409 PAYROLL_HANDOFF_LINE_ORPHANED` if the employee left the population, no second payment by another method; idempotency and delete/recalculate race tested; reconciliation helper `expectHandoffReconciled` |
| T44-P1-16 payroll after approval | **RESOLVED — Task 48** | Reproduced first (old code: pay item / salary record in an approved period `201`, attendance recalculation `200`, leave and OT approval `200`, `close` `200` with changed inputs). Now `409 PAYROLL_PERIOD_LOCKED` at every guarded source (period rows locked `FOR SHARE` against approval's `FOR UPDATE`; approval-vs-mutation race tested, one side always refused), `close` re-checks the inputs (`409 PAYROLL_INPUT_CHANGED`), fingerprint v2 covers currency, hire/termination dates, component state, leave paid flag and calendar. No retro-adjustment path (documented) |
| T44-P2-15 remaining cross-currency sums | **RESOLVED — Task 48** | Reproduced first (executive payroll: THB 152,000.50 + USD 16,500.25 shown as "168500.75 USD"). One payroll source `closedTotals` keyed by currency (executive, CSV, copilot); Report Center payroll money declares `currencyField`; travel estimate total removed, `byMonth` keyed by currency. The same source applies the Task 47 small-group rule to payroll totals (runs < 5 employees withheld) — a one-employee run total was shown to executives and the copilot before |
| T44-P1-19 self-approval (re-evaluated in Task 48) | open — deferred | The payroll evidence (own compensation / own adjustments) is pre-approval maker-checker governance, not the post-approval drift of P1-16; a proper fix spans compensation, pay items, adjustments, compensation planning, ER and services (subject ≠ actor, maker ≠ checker). The workflow engine already refuses requester self-approval of the payroll run itself |
| Also fixed in Task 48 | fixed | Payroll system-component cache was process-wide: a refused first calculation on a fresh database cached ids from a rolled-back transaction and broke every later calculation (FK error) — now per transaction. Report Center in-memory DECIMAL filters compared with `Number()` — now Decimal (tested beyond float precision) |
| T44-P1-10 document backup | **RESOLVED — Task 49** | Reproduced first (Task 44: database restored without files → ready "ok", downloads 404; readiness re-created the missing root). Now `ops:backup` writes database + documents as one set (manifest, SHA256SUMS, every referenced object present with its sha256 or the run fails `INCOMPLETE`); `ops:restore` restores the pair from the same set into a new database + empty directory and verifies every object (deep); readiness never re-creates a root once documents exist (`ROOT_MISSING`, `ROOT_EMPTY_BUT_DOCUMENTS_EXIST`, reason logged); `ops:integrity` reports missing/mismatched/orphan objects. Full drill on the production build: 6/6 downloads byte-identical after restore |
| T44-P1-11 backups off-host / scheduled / alerted | **APPLICATION SIDE READY — Task 49; EXTERNAL NOT CONFIGURED** | Off-host hook contract (copy + remote verification, required in production, failure = run fails, set kept `LOCAL_ONLY`), shipped rsync-over-SSH and rclone hooks (rsync pair exercised end to end with an SSH shim, remote tamper detected), retention (never deletes the newest valid set), freshness (`last-success.json`, `backup_freshness`), systemd timer / cron examples with `OnFailure` alert hook. **Not done, per deployment:** a real off-host destination, its encryption at rest (the application does not encrypt sets — stated in docs/backup-restore.md §5), alert delivery. Remains open until a deployment configures and proves them |
| T44-P1-12 monitoring / supervision | **APPLICATION SIDE READY — Task 49; EXTERNAL ALERTING NOT CONFIGURED** | Runbook events now emitted (`app_started`, `app_shutdown`, `app_fatal_error`, `db_readiness_failed`, `document_storage_unavailable`, backup/restore/monitor events); `ops:monitor-check` (API live/ready, document storage + free space, backup freshness + free space; exit 1 names the failed checks — each failure demonstrated on the production build); supervisor unit `hr-api.service` (restart, crash-loop limit, `OnFailure`); external alert contract in docs/operations-monitoring.md. PostgreSQL disk is not observable from the application (provider responsibility, stated). **No alert is delivered** until an operator wires `hr-alert@.service` / an uptime monitor |
| T44-P2-19 readiness blind spots | **RESOLVED — Task 49** | Unmounted/empty volume and missing root detected without re-creating it; disk-full/read-only → `NOT_WRITABLE` probe; reason code returned (path-free) and logged; free space in `ops:monitor-check` |
| T44-P2-20 backup umask / restore target | partly — Task 49 | Ops commands set `umask 077` and build sets in a `0700` partial directory; restore drill (`--verify-only`) still needs `CREATEDB` — recommended on a separate verification host (runbook §4.2) |
| T44-P2-22 RPO/RTO | partly — Task 49 | Stated factually with measured drill durations (docs/backup-restore.md §10); no target is promised — agreeing targets is a customer decision; release engineering untouched |
| Found and fixed in Task 49 | fixed | Ops commands imported `@prisma/client` before the application's `ENV_FILE` loader; Prisma loaded the repository `.env` first, so a backup run with `ENV_FILE` silently dumped the `.env` database (caught in the drill by the new document cross-check: 203 objects "missing"). Every ops entry point now loads `ENV_FILE` first; regression test spawns a command with `ENV_FILE` and proves it targets that database. Also: macOS `openrsync` lacks `--chmod` — the shipped hook no longer uses it (`-a` preserves the 0600/0700 modes) |
| T44-P1-21 scope per permission | **RESOLVED — Task 50** | Reproduced first (`permission-scope.test.ts` on the old code: MANAGER+EXECUTIVE read another department's private and public documents by URL `200`, the individual employee directory dataset returned all employees, CSV export and a shared saved report likewise; "employees.view SELF + leave.view ALL" listed every employee; organization reports accepted an unrelated ALL; an RBAC manager with an unrelated ALL role could self-assign a wider leave scope; Copilot `report_query` returned other departments — 9 tests failed). Now scope is resolved per permission from the roles that grant it (`@hr/shared` `computePermissionScopes`, same on the web); no user-wide scope (SELF until a guard names a permission); Employee 360 sections, Copilot tools, Report Center (`datasetAuth`), documents, organization reports and module admin checks use their own permission's scope; SoD compares per permission. Same-permission union, manager TEAM, HR ALL unchanged; no migration. Also fixed: a `documents.view` ALL viewer without `documents.manage` got an empty list (`ownerEmployee: {}`) |
| All other findings | open | — |

The classifications above are unchanged by these fixes; the remaining Pilot blockers are listed in §27.

## 2. Current architecture

One customer = one deployment = one PostgreSQL database (docs/production-readiness.md §1; confirmed in code: no
tenant column, process-local state).

| Component | Actual implementation |
|---|---|
| Web | React + Vite SPA, built to static files (`apps/web/dist`); served by an operator-provided reverse proxy/CDN. No proxy config shipped. No source maps in the build. |
| API | Node + Express 5 (`apps/api/dist/server.js`), single process; JSON API under `/api/v1`; no static serving. |
| Database | PostgreSQL (developed on 18.6); Prisma 6.19.3; 27 forward-only migrations; default Prisma pool; no statement/lock timeouts. |
| Documents | `LocalFileDocumentStorage` on a directory (`DOCUMENT_STORAGE_DIR`), opaque keys, 0600 files; metadata in PostgreSQL. |
| Auth / session | Email + password (bcrypt 12); DB-backed sessions (SHA-256 of a 256-bit token), `hr_session` cookie HttpOnly/Secure/Lax, 12 h absolute; per-session CSRF token. No MFA, SSO or SCIM. |
| RBAC | Permission codes (141) on 6 seeded roles; data scope SELF/TEAM/ALL = widest across a user's roles; context rebuilt per request. |
| Audit | `audit_logs` table, application-enforced append-only, key-based redaction. |
| Workflow | Shared engine with per-module handlers; row-locked instances. |
| Notifications | In-app only (delivery rows written as SENT); no email/SMS. |
| Copilot | Optional (off by default); Anthropic Messages API via `fetch`; read-only tools; fake provider for dev/test, refused in production. |
| Reporting | Server-owned Report Center registry (no SQL from clients); executive analytics; CSV exports with formula escaping. |
| Background jobs | **None.** No scheduler, cron or queue; time-based states are derived on read or run as manual scripts. |
| Backup / restore | `db:backup` (pg_dump custom + SHA-256 manifest), `db:restore:verify` (throwaway DB), `ops:revoke-sessions`, `ops:check`. Local files only. |
| Deployment | Provider-neutral contract: `npm ci → build → db:deploy → start` behind an HTTPS reverse proxy; `ENV_FILE` for config. |

## 3. Repository and release state

| Item | Value |
|---|---|
| Branch / HEAD | `main` / `4c00041` (Task 43 correction); tree clean at audit start |
| Node / npm | v24.18.0 / 11.16.0 (`engines.node >=20`) |
| PostgreSQL | 18.6 local (Postgres.app); client tools needed on PATH or `PG_BIN_DIR` |
| Workspaces | `packages/shared`, `apps/api`, `apps/web` |
| Versions | root `0.1.0-rc.1`; workspaces `0.1.0`; **no git tags**, no CHANGELOG, `APP_VERSION` set by hand |
| Migrations | 27; each `migration.sql` has exactly one commit (never edited after commit) |
| Tests | 945 before this audit; see §22 for the final run |
| Committed artifacts | Only `apps/api/.env.example`; `.env*`, `dist/`, backups, dumps, `.data/` are ignored. No secret in 56 commits of history (`git log -G` for key/token/private-key patterns: none). |
| Local hygiene (not in git) | `apps/api/.env` is mode 0644; legacy `apps/api/prisma/dev.db` / `test.db` SQLite files remain in the working tree |
| Dependencies | `npm audit`: 0 critical, 3 high, 2 moderate (§4.9) |
| Install scripts | `allowScripts` restricts lifecycle scripts to prisma/esbuild; `fsevents` pending (optional, macOS) |

## 4. Security

### 4.1 HTTP hardening (live, production build)
- API headers on every response: CSP `default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
  `X-Frame-Options: DENY`, HSTS `max-age=15552000; includeSubDomains` (production only), `nosniff`, `no-referrer`, COOP,
  CORP, Permissions-Policy, `x-request-id`; no `x-powered-by`.
- Malformed URLs: bad percent-encoding, `%00`, a 5,000-char segment → `400` with a generic message; unknown route
  `404`; invalid JSON `400 INVALID_JSON`; wrong types `400 VALIDATION_ERROR`; no stack, SQL or path in any response.
- CSRF: missing token `403 CSRF_TOKEN_MISSING`; foreign `Origin` `403 CSRF_ORIGIN_MISMATCH`, no CORS allow header.
- **Gap:** the web origin (SPA, reset-password page) has **no** security headers unless the operator's proxy adds them;
  a recommended CSP exists only in docs, and docs/production-readiness.md:235 still says "frontend CSP not defined".
- **Gap:** no global `Cache-Control: no-store` on API JSON (live: `/auth/me`, `/users`, `/payroll/compensations`,
  `/privacy/requests` returned none). Set only on downloads and CSV exports.

### 4.2 Production fail-fast (live matrix, compiled server, `NODE_ENV=production`)
Refused at startup (exit 1): missing `PUBLIC_APP_URL`; `COOKIE_SECURE=false`; `CORS_ORIGIN` `*` / `http://` / localhost;
copilot `fake` provider; copilot enabled without key; `SEED_DEMO_PASSWORD` set; placeholder `SEED_ADMIN_PASSWORD`;
`DOCUMENT_STORAGE_DIR` missing or `/tmp/...`. Started (exit 0 on SIGTERM): valid config. **Gaps:** `/private/tmp/...`
accepted (regex, no realpath); `NODE_ENV` defaults to `development`, so **forgetting it silently disables every guard**
(`env.ts:17`, `npm start` sets no NODE_ENV); `TRUST_PROXY` is never validated; `API_RATE_LIMIT_PER_MINUTE=0` is allowed;
no DB TLS (`sslmode`) requirement for a remote database. An unreachable database does not stop startup (readiness
reports it).

### 4.3 Uploads and downloads (live)
HTML, SVG, EXE → `415 DOCUMENT_TYPE_NOT_ALLOWED`; a "PDF" that is not → `415 DOCUMENT_CONTENT_MISMATCH`; NUL in
filename → `400`; `../../etc/passwd.txt` stored under an opaque key inside the root; files 0600. Download:
`attachment` + RFC 5987 filename, `Cache-Control: private, no-store`, CSP `default-src 'none'; sandbox`, `nosniff`.
DOCX/XLSX are checked only as "a ZIP". **No malware scanning** (`documents.service.ts:290` `malwareScanning:false`).

### 4.4 Browser storage
No `localStorage`/IndexedDB; `sessionStorage` holds only a UI notice and a copilot report *definition* (no rows). No
token, salary or copilot answer is persisted. Auth is the HttpOnly cookie only.

### 4.5 Secrets
Production secrets come from the environment / `ENV_FILE`; no secret-manager product is assumed. None committed.
Logs redact passwords, tokens, cookies, authorization and API keys (top-level paths only — see §8).

### 4.6 Bootstrap and seeds (live)
`bootstrap:admin` creates 141 permissions, 6 roles and one administrator; refuses an existing email and placeholder
passwords; the demo seed refuses `NODE_ENV=production`. **Gaps (live):** re-running bootstrap with a *different* email
creates another SYSTEM_ADMIN after the system is initialized, and bootstrap writes **no audit row**. The demo seed guard
depends on `NODE_ENV` only.

### 4.7 Error and log leakage
Production 500s are generic with a request id. The error path logs the whole `err` object; Prisma errors can carry
values, and redaction paths are not wildcarded. `P2002` 409 messages name DB columns. No test exercises the
production 500 branch (the test at production-config.test.ts:237 asserts a 401).

### 4.8 Supply chain / install (live)
`npm ci` from the lockfile: 345 packages in 4 s, reproducible. **`npm run build` fails on a clean checkout** — the
Prisma client is never generated (TS2339 `PrismaClientKnownRequestError` …). `npm run db:generate -w apps/api` fixes it;
no document mentions it. `prisma` CLI and `tsx` are devDependencies, so `db:deploy`, bootstrap, backup and ops scripts
need the full install (the docs do say `npm ci`).

### 4.9 Dependency audit (`npm audit`, 2026-09-30)

| Sev. | Package / path | Runtime? | Relevance | Fix |
|---|---|---|---|---|
| high ×3 | `prisma` → `@prisma/config` → `deepmerge-ts@7.1.5` (GHSA-ggr8-5vv4-36mx, stack exhaustion on recursive object graphs) | CLI/config loading (deploy time) | Not reachable from HTTP input | npm proposes a *major* prisma change — do not force; track prisma release |
| moderate ×2 | `exceljs@4.4.0` → `uuid@8.3.2` (GHSA-w5hq-g745-h8pq, missing bounds check when a caller passes `buf`) | Runtime (template + import) | exceljs does not pass attacker-controlled buffers to uuid | npm proposes exceljs 3.x (breaking downgrade) — do not force |

No critical. None exploitable through the application as used; keep on watch.

## 5. Authentication and session

| Control | State |
|---|---|
| Login | Generic `INVALID_CREDENTIALS` for unknown user and wrong password; dummy-hash timing equalization; every attempt audited (no password) |
| Session fixation | Existing cookie revoked at login |
| Token | `randomBytes(32)`; DB stores SHA-256 only; CSRF token per session |
| Cookie (live) | `hr_session`; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age 43200 |
| Expiry | 12 h absolute; **no idle timeout**; persistent cookie |
| Logout (live) | `204`, then `/auth/me` `401` |
| Password change / reset | Revokes all sessions and outstanding reset tokens |
| Deactivation | Deletes all sessions; inactive users rejected on every request |
| Restored copy (live) | A session captured before the backup **worked on the restored copy** until `ops:revoke-sessions` (then `401`). `restore-verify` revokes in its temp DB automatically; the real restore relies on the runbook step. |
| Password hashing | bcryptjs cost 12; policy 12–128 chars (bcrypt uses the first 72 bytes) |
| Reset | Admin-issued only; 256-bit token, hashed, single-use under a row lock, 60 min; link built from `PUBLIC_APP_URL`; **delivered by hand** (no email) |
| Rate limiting (live) | Failed logins per IP: 10 × 401 then 429; global 600/min/IP; reset endpoint 10/15 min/IP — **all in-memory, per IP only** (no per-account throttle) |
| CSRF / Origin | Synchronizer header + timing-safe compare; Origin allow-list when present |
| CORS | Explicit allow-list with credentials; production refuses `*`/http/localhost |
| trust proxy | `TRUST_PROXY` (default 0) — behind a proxy with the default, every user shares one IP bucket (10 bad logins lock everyone out) |
| MFA | **Absent** (documented out of scope) |
| SSO / SCIM | **Absent** (no SAML/OIDC/Google/Microsoft; no provisioning API) |

MFA impact: Pilot — acceptable with strong passwords, few admins and audit review; Production — required at least for
privileged roles (salary and HR data), P1-adjacent, listed P2 because the pilot scale and documented scope make it a
planned track, not an omission; Enterprise — required (MFA + SSO), P3 roadmap item that blocks Enterprise.

## 6. RBAC

**Model facts.** 141 permissions, 6 roles; `roles.manage` held only by SYSTEM_ADMIN; HR_ADMIN has `users.*` and
`roles.view`. There is **no** API to create or delete a role or change its scope. `PATCH /roles/:id/permissions`
(`roles.service.ts:50-86`) checks only that codes exist and that SYSTEM_ADMIN keeps `CRITICAL_PERMISSIONS`. Role grants
go through `blockingGrantPermissions` (`packages/shared/src/permissions.ts`) + scope check; a `roles.manage` holder may
grant business permissions it lacks. Last-admin, self-deactivation and self-removal of SYSTEM_ADMIN are protected. No
business code checks a role name.

### 6.1 RBAC self-escalation stress test (live, production build, fresh DB)

Actor: SYSTEM_ADMIN (holds `roles.manage` and `payroll.manage`, not `compensation_planning.apply`).

| Path | Request | Result |
|---|---|---|
| A. assign a business role to self | `PATCH /users/<self>/roles {SYSTEM_ADMIN, HR_ADMIN}` | **200** → actor holds `compensation_planning.apply` |
| B. create a role with the permission | `POST /roles` | 404 — no such endpoint |
| C. edit a role the actor holds | `PATCH /roles/<SYSTEM_ADMIN>/permissions` + `compensation_planning.apply` | **200** → actor holds it |
| D. edit another role, then assign it | add `compensation_planning.apply` + `payroll.manage` to EMPLOYEE, then self-assign | **200 / 200** → both held (and every employee got them) |
| E. APIs directly | all of the above were direct API calls | — |
| F. repeat with `payroll.manage` | remove it from own role, re-add | **200** → held again |
| Negative: HR_ADMIN (users.update, no roles.manage) | self → SYSTEM_ADMIN; edit role permissions | `ROLE_ESCALATION_NOT_ALLOWED`; `403` |

Every step was audited (`UPDATE_USER_ROLES`, `UPDATE_ROLE_PERMISSIONS`). **Verdict: a separation-of-duties defect, not
intended semantics.** The Task 43 correction and docs state that "administering RBAC is not salary authority"; in fact
`roles.manage` is an unrestricted super-admin authority. Path A exists *because* the Task 43 bypass does not exclude the
actor as target; path C/D exist because permission editing has no escalation rule at all. Audit makes it detectable,
not prevented. → finding **T44-P1-01**.

### 6.2 Password-reset takeover (live) → **T44-P0-01**
HR_ADMIN `POST /admin/users/<SYSTEM_ADMIN id>/password-reset` → `201` with the link; consuming it → `204`; login as the
SYSTEM_ADMIN → `200` with `roles.manage`. The same path lets SYSTEM_ADMIN take over an HR_ADMIN (and so compensation
apply). The only rule is "not yourself" (`account.service.ts:70-98`). `PATCH /users/:id` (email, employee re-link) and
deactivate have the same missing "target must not out-rank the actor" check.

### 6.3 Backend authorization (code review; UI bypass does not help — §19 walk)
Confirmed: payslips self-only; compensation Apply needs `compensation_planning.apply` **and** `payroll.manage`;
planners isolated to their rows; TEAM scope never reaches payroll, benefit claims, expenses, ER or succession;
recruitment offer figures hidden from hiring managers and interviewers; employee direct URLs to 10 admin/HR pages →
403 page and no data call (live).
Gaps: compensation self-approval (override/approve/applier = finalizer; planner reassignment onto own row); payroll
self-dealing (own compensation, own adjustments); ER case subject not excluded (can read/edit own case; workflow
self-check ignores the subject); salary HR letters (body + `salaryAmount`) visible to any ALL-scope service fulfiller
without payroll authority; scope is the widest across roles, not per permission — resolved in Task 50 — (a MANAGER+EXECUTIVE user gets ALL-scope
documents and individual reports); `POST /documents/:id/links` does not check access to the source document; manage-level
document update can reclassify RESTRICTED→PUBLIC_INTERNAL; talent 9-box cell reveals potential to team managers; workflow
definitions whose steps are all SKIP auto-approve (live definitions **UNVERIFIED**).

### 6.4 Data scope
No endpoint trusts a client-supplied scope; non-admins are forced to their own employee id. Datasets and services that
ignore scope rely on only ALL-scope roles holding the permission (competency gaps, talent review, ER, benefits, expense,
services, compensation) — safe with the seeded roles, unsafe with a TEAM custom role. **Live leak:** EMPLOYEE (SELF)
`GET /performance/cycles/:id/report` → organization report with `byDepartment: Sales, finalized 1, averageScore 3.95`
(one person's score) and `GET /competency/reports/gaps` → organization-wide gaps. → **T44-P1-05**.

## 7. Privacy

- **Personal data export** covers profile, account, positions, leave, workflows, notifications, own audit, ER issued
  actions/letters, talent facts, engagement identified answers, lifecycle, learning, benefits, expense, services and
  letters. **Neither exported nor declared** in `notIncluded`: salary history / pay items / payroll results (the
  compensation-planning note claims "payroll export rules" that do not exist), attendance and overtime, performance,
  competency assessments, training and IDP, owned documents, recruitment history of hires. Candidates cannot be
  privacy-request subjects. `docs/privacy-operations.md:53-64` is stale.
- **Retention / deletion:** none automated — no retention schedule, legal hold, `deletedAt` or anonymization; deletion
  requests are recorded only (documented as customer policy). Expired sessions are never swept
  (`sessionService.deleteExpired` has no caller). The documented reset-token cleanup command
  (`-- --days 30`) does not match the script (`argv[2]`) and exits 1.
- **Export security:** every CSV writer quotes cells and neutralizes `= + - @ \t \r`; exports are capped (50,000 rows,
  `413` above) and audited — except the **payroll run CSV (every salary), which is not audited**. No XLSX export.
- **Minimization:** no protected attributes in the schema; benefit and service forms warn against medical detail; the
  leave `reason` field has no such hint and is written raw to the audit log.
- **Engagement anonymity:** threshold (default 5, min 3) enforced for dashboards, CSV, Report Center, executive rollup
  and copilot, with no role bypass (tests `engagement.test.ts:230,244,305`, `new-domain-integration.test.ts:240`).
  **Weakness:** no complementary suppression — overall minus visible groups reveals a suppressed group (the repository's
  own fixture yields "Legal: 4 completed, all detractors"), and the participation list names who completed. Anonymous
  responses are linkable at DB level (cuid v1 timestamp + exact `completedAt` + same-transaction audit row); not exposed
  by the API.

## 8. Audit and logging

- Append-only in the application only (no update/delete path; no DB trigger or REVOKE). No `request_id` column.
- Redaction by key name. Newer modules log lengths/flags for free text. **Raw sensitive text still audited:** leave
  `reason` (possible health data), leave approver comments and entitlement notes, ER workflow comments and case title,
  termination `reason`, payroll adjustment note + amount, workforce plan reason. Salary values are audited on
  compensation create/pay items and visible to every `audit.view` holder (HR_ADMIN, SYSTEM_ADMIN).
- No password, hash, session or reset token found in audit payloads.
- Logs: pino JSON, one line per request (method, path without query, status, duration, user id, request id); no headers
  or bodies; copilot logs metadata only; a test asserts tokens/query strings/passwords never reach logs
  (`account-privacy.test.ts:432`). Live production log (35 lines) contained no password, cookie or token.
- **Runbook drift:** docs/operations-runbook.md:32-34,47 tells operators to alert on `app_started`, `app_fatal_error`,
  `db_readiness_failed`, `app_shutdown`; the server never emits these events.

## 9. Money and payroll correctness

- Authoritative money is Prisma `Decimal` (half-up, 2 dp / 6 dp rates) in payroll, benefits, expense and compensation;
  `Number()`/`toFixed` hits are counts, tenure, display, or Decimal `toFixed`. One marginal case: Report Center
  in-memory filters compare DECIMAL with `Number()` (filter only).
- Payroll immutability holds for: recalculation after APPROVED/CLOSED, frozen period dates, close-once, frozen run
  pending approval, stale input fingerprint at submit and approval, negative-net blocker, non-removable generated lines,
  concurrency (tests `payroll.test.ts:378,397,428-434,443,506,524,550`).
- **Gaps:** payroll never compares `EmployeeCompensation.currencyCode` with the period currency (verified —
  `payroll-calculation.service.ts:263-303`), so a USD salary is paid as THB; benefit/expense handoffs to payroll have no
  currency check; `removeAdjustment` can delete a handoff line, leaving the claim/report `SENT_TO_PAYROLL` and unpaid;
  recalculation re-creates manual lines with new ids (handoff `payroll_result_item_id` dangles, no FK); `close()` does not
  re-check inputs; attendance/OT/leave changes dated inside an APPROVED/CLOSED period are accepted and never reconciled;
  immutability is application-only.
- **Cross-currency sums remaining:** executive `payrollAggregate` adds all closed runs and labels the total with the
  first run's currency (verified — `executive-analytics.service.ts:153-168`, also reaches the copilot); Report Center
  `payroll_period_summary` money fields lack `currencyField`; expense `travel.estimatedTotal`/`travelByMonth` unkeyed.
  Benefits (Task 42 correction), compensation and expense category/policy reports are correct.
- **Compensation Apply** (Task 43, re-verified by its suite): explicit authority, stale source blocked, terminated
  employee blocked, double apply `409` with no duplicate, atomic, no decrease, exact budget — plus the new SYSTEM_ADMIN
  denial. Remaining: self-approval chain (§6.3).

## 10. Concurrency and data integrity

Row locks + unique keys + concurrency tests exist for leave and balances, clock-in, overtime, workflow, payroll,
recruitment hire, offboarding, training capacity, learning, benefit claims, expense, HR letter numbering, compensation
activate/apply, onboarding import (advisory lock), reset tokens and notifications (inventory with file/test references
in the audit working notes; all these suites pass in the final run). Gaps: no concurrency test for attendance
corrections; concurrent numbering tested only for ER and benefits; first-of-year sequence `upsert` race **UNVERIFIED**;
sequence year is UTC (00:00–07:00 Bangkok on 1 January gets the previous year's prefix).

**Organization 409 flake (historical).** It has not recurred in any run of this session (945/945 twice before the audit;
final run §22). The earlier investigation resolved a supertest ephemeral-port collision (tests now use
`createTestServer()`); position codes are unique per department and every file resets the shared test database with
`fileParallelism: false`. Classification: **test-isolation class, currently unresolved-unknown for the specific 409** — no
evidence of a product defect; if it recurs, capture the full log (the suite now always writes it to a file).

**Large department (live, `audit44-large-department.test.ts`, 520 employees):** attendance and overtime reports return
exactly 500 rows and 500 × totals with no truncation marker; the executive overview shows `attendance.employees: 500`.
Correctness assertions were `it.fails` (expected-fail) until fixed — **fixed in Task 48** (now normal tests, plus 499/500/501/1,000 and 3,020). Other silent caps: attendance recalculation 2,000
employees (stale payroll input past the cap), approver inboxes 500, team leave calendar 500, document list 1,000 with a
wrong total, team development 200.

**Business dates / timezone.** `businessToday(tz)` with the organization's IANA zone is used by leave, attendance,
overtime and recruitment. Hard-coded `Asia/Bangkok` in expense, services SLA, certification expiry, probation,
compensation baseline and benefits; hard-coded `UTC` in ER; server UTC date in copilot tools, document expiry, several
Report Center datasets (services SLA disagrees with the module for 7 h a day), Employee 360 certification status and the
dashboard new-hire window. Correct for a Bangkok-only pilot; wrong for any other zone. DST: tests cover London and New
York offsets (`attendance.test.ts:184-186`, `business-date.test.ts:40`), not a transition day.

## 11. Database and migrations

- 27 migrations applied sequentially on a new empty database with `migrate deploy`: success, 183 tables.
- No migration edited after commit. One historical destructive migration (`20260925040629_anonymize_engagement_responses`
  drops 7 columns — applied pre-production, by design). Data migrations are guarded (`competency_evidence_ojt_backfill`)
  or narrow (`system_admin_without_compensation_planning`). No `ALTER TYPE`, no `NOT NULL` added to existing tables.
- Unsafe defaults: `currency_code DEFAULT 'THB'` on payroll/compensation/offer tables; status columns are free TEXT
  without CHECK. Missing indexes: `payroll_results.compensation_id`, `engagement_survey_assignments.employee_id`,
  `benefit_claims.entitlement_id` and others (low traffic today).
- **Upgrade path:** forward migrations for Tasks 32–43 reviewed: additive tables/columns, nullable columns, no rewrites.
  An upgrade from an older *customer* database was not executed (no earlier customer snapshot exists; every environment
  so far is dev/test). The restore test (§13) proves `migrate deploy` is a no-op on a current copy.
- PostgreSQL config: default pool, no `statement_timeout`/`lock_timeout`; transactions 5 s default, 60 s attendance,
  120 s payroll/onboarding/compensation; a 5 s transaction waiting behind a 120 s payroll lock fails with `P2028`, which is
  not mapped (likely `500`, **UNVERIFIED**). Whole-population payroll runs in one transaction. Shutdown drains and
  disconnects (live SIGTERM exit 0).

## 12. Fresh install (live, clean clone, new empty database, production mode)

| Step | Result |
|---|---|
| `git clone` + `npm ci` | OK, 345 packages, 4 s |
| `npm run build` (as documented) | **FAIL** — Prisma client not generated |
| `npm run db:generate -w apps/api` then build | OK; no source maps (web 0, api 0) |
| New DB `hr_audit44_fresh` + `npm run db:deploy` | 27 migrations, 183 tables, 0 users |
| `bootstrap:admin` | OK (141 permissions, 6 roles, 1 admin); refuses same email and placeholder; demo seed refused |
| `node dist/server.js` with `ENV_FILE`, `TRUST_PROXY=1`, `COOKIE_SECURE=true` | Starts; `/health`, `/health/live`, `/health/ready` 200 |
| Login, admin pages, document category, upload, download | OK |
| Customer setup without hidden knowledge | Possible via the documented pilot checklist and the Excel import (§17), after the build fix. The production env inventory omits `DOCUMENTS_ENABLED`, `DOCUMENT_STORAGE_DIR`, `DOCUMENT_MAX_FILE_MB` and `COPILOT_*` (the fail-fast catches the missing directory). |

## 13. Backup and restore (live)

| Drill | Result |
|---|---|
| `db:backup` | exit 0, 0.2 s, 550 KB custom-format dump, SHA-256 manifest (app version, server/pg_dump versions, latest migration, count 27), files 0600 |
| Failing backup (bad role) | exit 1, `BACKUP_FAILED`, no partial file, no manifest |
| `db:restore:verify` | exit 0, 1.4 s: checksum, temp DB, 183 tables, 27 migrations, 5 sessions revoked, temp DB dropped |
| Full restore into separate DB (`pg_restore --exit-on-error`) | exit 0; checksum matched manifest; tables 183/183, migrations 27/27, users 3/3, sessions 6/6, documents 2/2, versions 2/2, audit rows 33/33, roles 6/6, permissions 141/141 |
| App on restored DB | ready; **pre-backup session still valid (200) until `ops:revoke-sessions`**, then 401; fresh login 200; document download 200 |
| Duration | seconds on this tiny dataset — **not a production RTO** |

Off-host copy: **none** (local directory only). Encryption: **none** in the application; at rest and in transit are
deployment responsibilities; credentials reach pg tools through libpq env vars, never argv. Scheduling, retention and
failure alerting: **none** (exit code only). PITR: **not configured**; platform responsibility. Minor: the partial dump
is written with the default umask before `chmod 600`; `BACKUP_DIR` is created without an explicit mode;
restore-verify needs `CREATEDB` for the application role and runs on the production server.

**Task 49 drill (production build, isolated databases `hr_t49_drill_*`, removed afterwards).** Demo-seeded
database, 6 documents uploaded through the API, a pre-backup session and an unused reset token; `ops:backup` with the
shipped rsync-over-SSH hooks (SSH shim standing in for the remote host) → set 600 KB (dump 553 KB, 6 objects, 42 KB),
**1.4 s**, remote copy re-hashed; a document and a session created after the backup; `ops:restore` into a new database +
empty directory **1.4 s** (2 sessions and 1 reset token revoked, 30 migrations, deep document integrity); production API
on the restored pair ready in **0.55 s**; pre-backup session **401**, fresh login **200**, downloads **6/6**
byte-identical, post-backup document **404**, employee/payroll/leave counts equal to the backup; `ops:preflight` OK;
monitor check: healthy 0, stale backup 1, missing backup 1, storage removed 1 (readiness `ROOT_MISSING`), API stopped 1;
off-host destination unavailable → `offhost_copy_failed`, exit 1; an older set (28 migrations) restored and migrated to
30. Development dataset (1,135 employees, 203 documents): backup 0.5 s, verify-only restore 1.8 s. Developer machine — not
an RTO. Details: docs/backup-restore.md §10.

## 14. Documents

Architecture (Task 30) verified: production refuses temp storage (see `/private/tmp` gap), opaque keys, traversal
blocked, authenticated downloads per classification, append-only versions, archive = status. **Backup:** document
storage is in **no** script; the runbook describes a manual copy; not in the pilot go-live gate or the numbered DR steps.
**Live failure scenario — DB restored, documents missing:** readiness `documentStorage: ok` (the probe re-created the
empty root, mode 0755), `ops:check` healthy, downloads `404 DOCUMENT_OBJECT_MISSING` with a clear message. The reverse
(files without rows) goes unnoticed — there is no DB↔file consistency check. A failed multi-file upload can orphan a
stored object. **Object storage:** local files are appropriate for a single-node pilot and a single-node production with
a backed-up volume; not for multi-instance or enterprise. **Malware scanning:** absent — Pilot: acceptable (uploads need
`documents.manage`, HR staff only, strict type/signature checks); Production: P2 (scanner hook recommended); Enterprise: P3
required.

## 15. Copilot / AI safety

- Off by default; production refuses the fake provider and a missing key (live). Provider failure, timeout and bad key
  are isolated to the copilot (`copilot.test.ts:308-319`); readiness never depends on it; the menu hides when disabled.
- Tools are read-only, offered and re-checked by permission, argument-validated, result-capped; no server-side
  conversation store; logs and audit carry metadata only; answers rendered as escaped text.
- **High-impact prompts (live, fake provider, 4 roles incl. SYSTEM_ADMIN):** "Who should I fire?", "Who deserves a
  raise?", "Rank employees by performance and potential.", "Who looks dishonest from expenses?", "Who may be sick based
  on benefits?", "ใครควรถูกเลิกจ้าง" → all `highImpact: true`, EN/TH boundary notice + limitation; no recommendation. For
  "Rank…" the tools still ran and raw data followed the notice. The guard is a **notice, not a restriction**: a scripted
  model answer "EMP004 should be fired." is passed through (`copilot.test.ts:260-263`), ranking-capable tools stay
  available (`report_query` on `performance_results`/`talent_review_summary`), and only the current message is
  classified. Real-model behaviour **UNVERIFIED** (no API key in this environment).
- Other: tool calls per step uncapped and not abortable; `stop_reason` ignored; the employee tool-offer test is vacuous
  (employees get the org-wide `skill_gap_report`); in-memory rate limit; default model id `claude-sonnet-5`
  **UNVERIFIED**.

## 16. Reporting and analytics

Report Center: server-owned registry, field allow-lists, caller's own scope for saved/shared reports, audited exports,
50,000-row cap. **`aggregateOnly` does not mean grouped** — the in-memory runner returns one row per record with
quasi-identifiers (department, month, amount/outcome), and there is no minimum cell size outside engagement (a
one-person compensation cycle reveals that salary). Executive analytics: Task 42 rollups check source permissions and
refuse department/job filters; the older sections (performance, ER, recruitment, terminations/hires) accept department
and job filters with no minimum group size and are gated only by `analytics.view_executive` (also reachable through the
copilot's `executive_hr_overview`). Cross-currency and truncation issues are in §9–§10.

## 17. Performance and scaling

Observed on a developer machine, not an SLA. **1,000-employee import (live):** preview 0.1 s, commit 7.4 s in one
transaction, replay idempotent, one bad row → nothing created with the row number reported, unauthorized importer `403`;
the master formula cell is rejected but a **shared-formula child cell is not**. **At 1,000 employees:** employee list
page 1 / last page 10 ms, attendance month report 14 ms, leave overview 38 ms, payroll periods 6 ms, performance cycles
4 ms, training report 7 ms, executive overview 77 ms, dashboard 7 ms; compensation cycle measurements from Task 43 (apply
1,000 changes 1.16 s). No N+1 or timeout seen at this size; correctness caps are in §10. **Scaling:** one API instance by
design; login/API/reset/copilot rate limits and a payroll component cache are in-process; document storage is local —
horizontal scaling would split rate limits and break document access. No HA.

## 18. Monitoring and operations

Exists: `/health` (DB), `/health/live`, `/health/ready` (DB + document write probe + copilot state), request ids,
structured JSON logs, graceful shutdown, `ops:check`. **Does not exist:** uptime monitoring, alerting, error aggregation,
metrics, DB/disk/document-volume alerts, backup freshness check, process supervisor guidance (the server exits on a fatal
error and stays down), log rotation/shipping.

| Question | Answer today |
|---|---|
| API down at 02:00 — who knows? | Nobody automatically |
| Database storage full? | Nobody (readiness is `SELECT 1`) |
| Backup failing for 3 days? | Nobody (no scheduler, no freshness check) |
| Document storage unavailable? | `/health/ready` 503 if something polls it; an unmounted volume still reports ok |

**After Task 49** (application side; delivery needs the operator's monitor — docs/operations-monitoring.md):

| Question | Answer after Task 49 |
|---|---|
| API down at 02:00 — who knows? | the external uptime probe on `/health/live` and `ops:monitor-check` (`api_live`) fail → the configured alert hook; the supervisor restarts the process |
| Database storage full? | still not observable from the application — database host / provider monitoring (stated) |
| Backup failing for 3 days? | every failed run exits 1 (`backup_failed`, `OnFailure`), and `backup_freshness` fails after `BACKUP_MAX_AGE_HOURS` |
| Document storage unavailable? | readiness 503 with a reason code (unmounted volume included), `document_storage` + free-space checks |

## 19. Deployment

A deployer finds: build/migrate/start order, HTTPS-at-proxy requirement, fail-fast config, probes, bootstrap, backup and
restore commands, account recovery and a pilot checklist. Missing or wrong: the `prisma generate` step; `NODE_ENV=production`
is not enforced by the start script; reverse-proxy example with web security headers; `TRUST_PROXY` guidance as a must-set;
env inventory entries for documents/copilot; backup schedule example; monitoring setup; process supervisor unit; log
retention; PostgreSQL role/SSL/`CREATEDB` notes; stale `docs/releases/pilot-rc.md` (says no payroll/documents, 464 tests).
Browser walk (live, Chrome, dev build): EMPLOYEE 18, MANAGER 22, HR 25, HR_ADMIN 34, EXECUTIVE 19, SYSTEM_ADMIN 33 menu
items — 151 visits, 0 console errors, 0 failed requests, 0 403 loops, 0 404, 0 placeholder, 0 overflow; 390 px smoke
(login, dashboard, leave, attendance, expenses, services, documents, payroll self, manager compensation) clean; disabled
copilot shows a "not enabled" card, no broken route. Accessibility (light): labelled inputs and logical tab order on
login; dialogs have `role=dialog aria-modal` and Escape, but **no initial focus, no focus trap, no focus restore**.

## 20. Disaster recovery

RPO/RTO: **not defined or measured** for production (only this audit's laptop timings). Current capability:
RPO = time since the last manual/scheduled dump (no WAL/PITR); RTO = manual restore procedure (runbook §7) + document copy
+ session revocation. Single-node failures: API host loss → outage until redeploy, and if backups/documents live on the
same host (the default single-VM layout) they are lost too; document disk loss → files unrecoverable without an
operator copy (metadata remains, downloads fail); DB host loss → restore the last off-host dump, if one exists. No HA.

## 21. Enterprise capabilities

| Capability | State |
|---|---|
| MFA | Absent |
| SSO (SAML/OIDC), SCIM | Absent |
| HA / horizontal scaling | Absent (single instance, in-memory limits, local documents) |
| Object storage | Absent (local files) |
| Email/SMS delivery | Absent (in-app notifications; reset links by hand) |
| Retention / legal hold / anonymization | Absent |
| Malware scanning | Absent |
| PITR | Platform responsibility, not configured |
| Scheduler (reminders, sweeps, rollover) | Absent |
| WCAG conformance | Not assessed; focus management gaps |
| Release engineering (tags, changelog, build-derived version) | Absent |

## 22. Test evidence

Added for this audit (tests only; no production code changed):
- `apps/api/tests/audit44-large-department.test.ts` — 520 employees in one department: pins today's 500-row truncation
  and records it; two correctness tests are `it.fails` (expected-fail) so the suite stays green and turns red when the
  defect is fixed.
- `apps/api/tests/audit44-import-1000.test.ts` — 1,000-employee import: unauthorized importer, one-bad-row atomicity,
  formula cell, commit + replay, and reads at 1,000 employees. Timings are written to `AUDIT44_OUT` when set.

Targeted runs before the full suite: both audit files (6 passed, 2 expected-fail), plus the Task 43 RBAC focus set
(127/127 × 5). Final sequential run (typecheck → full suite → build): `npm run typecheck` pass; `npm test` first and only run **51 files, 951 passed + 2 expected-fail (953), 247.7 s**, complete log captured; `npm run build` pass (existing >500 kB chunk warning only). The organization 409 flake did not recur.

Live drill scripts (fresh install, fail-fast matrix, RBAC stress, reset takeover, backup/restore, document scenarios,
copilot prompts, browser walk) were run from the session scratch area against throwaway databases
`hr_audit44_fresh` / `hr_audit44_restored`, which were dropped afterwards.

---

## 23. P0 findings

**T44-P0-01 — Password-reset link lets a lower-privileged admin take over a higher-privileged account** — ✅ RESOLVED in Task 45 (see Remediation status)
- Area: authentication / RBAC · Evidence: live — HR_ADMIN issued a reset link for a SYSTEM_ADMIN (`201`), consumed it
  (`204`) and logged in with `roles.manage` (`200`); `account.service.ts:70-98` checks only "not yourself". Same class:
  `PATCH /users/:id` (email, employee re-link) and deactivate.
- Impact: vertical privilege escalation that bypasses the Task 3.1 rule "HR_ADMIN cannot grant SYSTEM_ADMIN"; in the other
  direction SYSTEM_ADMIN gains compensation apply by taking over an HR_ADMIN.
- Affected: Pilot, Production, Enterprise.
- Remediation: before issuing a reset, revoking sessions, editing or deactivating a user, require that the target's
  effective permissions (and scope) are within the actor's (reuse the grant rule without the `roles.manage` bypass);
  audit refusals; tests for both directions.
- Blocking: Pilot **yes** · Production **yes** · Enterprise **yes**.

## 24. P1 findings (required before real production / customer rollout)

| ID | Area | Evidence | Impact | Remediation | Blocks Pilot / Prod / Ent |
|---|---|---|---|---|---|
| T44-P1-01 ✅ resolved (Task 45) | RBAC separation of duties | Live stress test §6.1: self-assign HR_ADMIN; edit own role; edit EMPLOYEE then self-assign — all 200 | `roles.manage` = unrestricted super-admin; Task 43 SoD claim is false; one call gives any business authority (audited only) | `setPermissions`: refuse adding permissions the actor lacks and editing roles the actor holds (or require a second approver); `resolveRoles`: no `roles.manage` bypass when target = actor; correct the Task 43 docs | Conditional (document "SYSTEM_ADMIN is super-admin" + audit review) / yes / yes |
| T44-P1-02 ✅ resolved (Task 46) | Build / install | Live: clean clone `npm run build` fails; Prisma client not generated; docs omit the step | Documented install fails for every new customer | Run `prisma generate` in `build` (or `postinstall`); document it; CI fresh-clone build | yes / yes / yes |
| T44-P1-03 ✅ resolved (Task 46) | Config fail-open | `env.ts:17` default `development`; `npm start` sets no `NODE_ENV` | Forgetting one variable disables every production guard (error detail, Secure cookie, HSTS, URL/CORS/copilot checks, demo seed) | Fail closed: generic errors unless explicitly development; `NODE_ENV=production` in the start script or refuse non-local DB/https origin with non-production mode | yes / yes / yes |
| T44-P1-04 ✅ resolved (Task 46) | Rate limit behind proxy | `TRUST_PROXY` default 0, unvalidated; limiters per IP in memory | Behind the documented proxy, 10 bad logins lock out every user for 15 min | Make `TRUST_PROXY` mandatory in production; log the resolved client IP at startup; add per-account throttle | yes / yes / yes |
| T44-P1-05 ✅ resolved (Task 47) | Confidentiality via reports | Live: EMPLOYEE gets org performance report (`Sales finalized 1, avg 3.95`) and org competency gaps; code: `performance.routes.ts:73-74`, `competency.routes.ts:95` | Any employee can read a colleague's performance score in small departments | Require a reporting permission + scope; minimum group size (engagement `meetsThreshold`) | yes / yes / yes |
| T44-P1-06 ✅ resolved (Task 47) | Engagement anonymity | Fixture `engagement.test.ts:218-236` derives a suppressed group; participation list names completers | Anonymous answers of a small group recoverable | Complementary suppression; hide participation for suppressed groups; differencing test | yes (if engagement used) / yes / yes |
| T44-P1-07 ✅ resolved (Task 47) | Small-group disclosure in executive analytics and Report Center | `executive-analytics.service.ts:147-151,206-216`; `prisma-runner.ts:191` row-level "aggregate" datasets | Near-individual scores, ER actions, claims, salaries to executives (also via copilot) | Minimum cell size on department/job filters and aggregate datasets; force grouping | no / yes / yes |
| T44-P1-08 ✅ resolved (Task 46) | Web security headers | No proxy config shipped; SPA/reset page headers operator-only; doc contradiction | A default deployment serves the SPA without CSP/clickjacking protection | Ship a tested reference proxy config (headers, HTTPS redirect) + go-live header check | yes (operator can add) / yes / yes |
| T44-P1-09 ✅ resolved (Task 46) | Sensitive API caching | Live: no `Cache-Control` on `/auth/me`, users, compensations, privacy; payslip/letter/ER/talent JSON | Salary/HR JSON and CSRF token cacheable by browser/intermediaries | Global `Cache-Control: no-store` on `/api/v1` | yes / yes / yes |
| T44-P1-10 ✅ resolved (Task 49) | Document backup | No script covers `DOCUMENT_STORAGE_DIR`; live: DB restored without files → ready "ok", downloads 404 | Uploaded HR documents lost on disk loss or incomplete restore | Paired DB + document backup/restore command; consistency check in `ops:check`; readiness must not re-create the root | yes (if documents enabled) / yes / yes |
| T44-P1-11 ◐ application side ready (Task 49), external not configured | Backups off-host / scheduled / alerted | Local directory only; no schedule, encryption, retention, freshness alert | Host loss destroys data and backups; silent backup failure | Reference encrypted off-host copy + schedule + retention + failure/freshness alert (operator runbook, not a product) | yes (operator commitment) / yes / yes |
| T44-P1-12 ◐ application side ready (Task 49), external not configured | Monitoring / supervision | No alerting, no supervisor; runbook event names not emitted | Outages and disk-full go unnoticed; crashed API stays down | Emit the documented events; document supervisor unit and external uptime check on `/health/ready`; disk alerts | yes (uptime check) / yes / yes |
| T44-P1-13 ✅ resolved (Task 48) | Attendance/OT truncation | Live 520-employee test: 500 rows, 500 totals, executive `employees: 500`; recalculation cap 2,000 | Silent under-reporting; stale payroll input past 2,000 | Paginate or aggregate in SQL without an employee cap; error instead of truncating | conditional (dept > 500) / yes / yes |
| T44-P1-14 ✅ resolved (Task 48) | Payroll currency | `payroll-calculation.service.ts:263-303` never checks salary currency; handoffs unchecked | Non-THB salary/claim paid as THB | Block calculation/handoff on currency mismatch | no (single-currency pilot) / yes / yes |
| T44-P1-15 ✅ resolved (Task 48) | Payroll handoff loss | `removeAdjustment`, recalculation re-creates lines (dangling ids, no FK) | Approved reimbursement never paid, silently | Protect handoff lines; link by (referenceType, referenceId); fail recalculation that drops them | conditional (if handoff used) / yes / yes |
| T44-P1-16 ✅ resolved (Task 48) | Payroll after approval | `close()` does not re-check inputs; source changes in closed periods accepted | Closed payroll diverges from attendance/leave without reconciliation | Re-check at close; block or flag changes in approved/closed periods; retro-adjustment path | conditional / yes / yes |
| T44-P1-17 ✅ resolved (Task 47) | Privacy export completeness | Salary history, payroll, attendance/OT, performance, competency, training/IDP, documents, recruitment of hires neither exported nor declared | Incomplete and partly false subject-access answers | Add collections or declare them in `notIncluded`; fix docs | yes (declare) / yes / yes |
| T44-P1-18 ✅ resolved (Task 47) | Sensitive text in append-only audit | Leave reason/comments, ER comments/title, termination reason, payroll notes | Health/disciplinary text readable by every `audit.view` holder forever | Switch to the existing length/changed pattern | yes / yes / yes |
| T44-P1-19 | Self-approval / self-dealing | Compensation override/approve/apply chain; payroll own compensation/adjustments; ER subject; service fulfiller own ticket/letter | One person can raise and pay their own salary or handle their own case | Subject ≠ actor checks; maker ≠ checker on money steps | conditional (small trusted HR team) / yes / yes |
| T44-P1-20 ✅ resolved (Task 47) | Salary letters exposure | `letter.service.ts:188-198` returns body + salary to ALL-scope fulfillers | Salaries visible without payroll authority | Redact salary-bearing letters unless owner or `payroll.manage` | yes / yes / yes |
| T44-P1-21 ✅ resolved (Task 50) | Scope per permission | `authorization.service.ts:19-33` widest scope across roles | MANAGER+EXECUTIVE user reads all private documents and individual reports | Resolve scope per permission or forbid mixed-scope combinations | conditional (avoid combos) / yes / yes |
| T44-P1-22 | Copilot high-impact | Notice only; tools unrestricted; history not classified | A real model can still rank or recommend with a disclaimer | Server-side factual-only template or tool restriction for high-impact; classify history | conditional (keep copilot off) / yes / yes |
| T44-P1-23 | Timezone | Hard-coded Bangkok/UTC in 7+ modules; UTC in reports/documents/copilot/360 | Wrong expiry/SLA/probation dates outside Bangkok; modules disagree 7 h/day | One helper using `Organization.timezone` | no (Bangkok pilot) / yes / yes |
| T44-P1-24 ✅ resolved (Task 47) | Payroll CSV audit | `payroll.routes.ts:85-96` not audited | Bulk salary export leaves no trace | Audit every payroll export | yes / yes / yes |

## 25. P2 findings (hardening / operational maturity)

| ID | Finding (evidence) | Remediation |
|---|---|---|
| T44-P2-01 | Bootstrap re-runnable with a new email after initialization; no audit row (live) | Refuse when an active SYSTEM_ADMIN exists unless `--force`; audit |
| T44-P2-02 | Demo seed guarded only by `NODE_ENV` | Also refuse non-local DB / require explicit dev flag |
| T44-P2-03 | No idle session timeout; persistent 12 h cookie | Idle timeout; session cookie |
| T44-P2-04 | No per-account login throttle | DB-backed per-account backoff |
| T44-P2-05 | Error path logs full `err`; redaction not wildcarded; P2002 exposes columns | Error serializer; wildcard redact; mapped field names |
| T44-P2-06 | No DB TLS requirement; `API_RATE_LIMIT_PER_MINUTE=0` allowed; `/private/tmp` accepted | Validate in production |
| T44-P2-07 | Audit append-only only in app; no request id column | DB REVOKE/trigger; `request_id` |
| T44-P2-08 | Anonymous engagement responses linkable at DB level | Random ids; day-precision `completedAt`; batch audit |
| T44-P2-09 | Salary values in audit visible to `audit.view` | Gate payroll/compensation audit rows on payroll permission |
| T44-P2-10 | Expired sessions never swept; reset-token cleanup command documented wrongly | Sweep job/script; fix docs or parser |
| T44-P2-11 | No malware scanning; DOCX/XLSX checked as ZIP only; orphan object on multi-file upload | Scanner hook; OOXML check; cleanup |
| T44-P2-12 | Document linking without source access; manage-level reclassification; domain map missing HR_LETTER etc. | Access check on link; classification guard |
| T44-P2-13 | Talent 9-box reveals potential to managers; self-nomination | Hide cell; block self-nomination |
| T44-P2-14 | Import: shared-formula child cells accepted (live); no zip-bomb limit; 5,000-row single transaction; re-validation outside `tx` | Reject any formula-bearing value; size/entry limits; use `tx` |
| T44-P2-15 ✅ resolved (Task 48) | Remaining cross-currency sums (executive payroll, `payroll_period_summary`, travel estimate) | Key by currency; `currencyField` |
| T44-P2-16 | Other silent caps (inboxes 500, team calendar 500, documents 1,000 wrong total, team development 200) | Paginate or mark truncated |
| T44-P2-17 | PostgreSQL: no `statement_timeout`/`lock_timeout`, default pool, `P2028` unmapped | Set timeouts/pool; map to 409/503 |
| T44-P2-18 | Missing concurrency tests (attendance corrections, most numbering sequences); first-of-year upsert race UNVERIFIED | Add tests |
| T44-P2-19 ✅ resolved (Task 49) | Readiness blind spots (disk full, unmounted volume, reason not logged) | Marker file probe; log reason; external disk alerts |
| T44-P2-20 | Backup partial file umask; restore-verify needs CREATEDB on production server | `umask 077`; separate verify target |
| T44-P2-21 | Documentation drift: env inventory, `pilot-rc.md`, production-readiness §9, privacy-operations tables, hr-analytics copilot line | Rewrite for current state |
| T44-P2-22 | No RPO/RTO; no tags/changelog; versions mismatched | Measure and agree targets; release engineering |
| T44-P2-23 | Dialog focus management (no initial focus/trap/restore, live); unlinked error text | Focus trap; `aria-describedby` |
| T44-P2-24 | Copilot: calls per step uncapped, tools not abortable, `stop_reason` ignored, vacuous tool-offer test, employee gets org skill-gap tool | Caps; abort; surface truncation; fix test/permission |
| T44-P2-25 | MFA absent (for Production privileged roles) | TOTP/WebAuthn for admin roles first |
| T44-P2-26 | Workflow all-SKIP auto-approval for money/ER modules (live definitions UNVERIFIED) | Refuse all-skipped instances for those modules |
| T44-P2-27 | Benefits/expense manage actions skip the ALL-scope admin check (latent with a TEAM custom role); datasets ignoring scope | Add the admin-scope check; scope datasets |
| T44-P2-28 | Dependencies: 3 high (prisma CLI → deepmerge-ts), 2 moderate (exceljs → uuid), not request-reachable | Track upstream; no forced major changes |

## 26. P3 findings (future enterprise)

SSO (SAML/OIDC) and SCIM · HA and horizontal scaling (shared rate-limit store, object storage adapter) · PITR / managed
PostgreSQL · email/SMS delivery through the existing notification outbox (self-service password reset, approval
reminders) · scheduler (reminders, sweeps, entitlement rollover, retention) · retention schedules, legal hold,
anonymization of leavers and rejected candidates, candidate privacy subjects · WCAG AA conformance · DB-level payroll
immutability, CHECK constraints, removal of `DEFAULT 'THB'`, missing indexes · UTC sequence-year prefix · DST
transition-day tests · unbounded in-memory dataset loads · `/health/ready` detail exposure · bcrypt 72-byte limit ·
login Origin check · production 500 test · copilot audit id ≠ request id · legacy local SQLite files and `.env` mode.

## 27. Commercial pilot classification — **CONDITIONAL**

Blockers (must be fixed or explicitly accepted before a real customer pilot):
1. ~~**T44-P0-01** reset/edit/deactivate target privilege check (fix).~~ Resolved in Task 45.
2. ~~**T44-P1-02** build step and **T44-P1-03** `NODE_ENV` fail-closed.~~ Resolved in Task 46.
3. ~~**T44-P1-05**, **T44-P1-06**, **T44-P1-20**, **T44-P1-18**, **T44-P1-24**~~ resolved in Task 47; ~~**T44-P1-09**~~ resolved in Task 46.
4. ~~**T44-P1-01** RBAC SoD.~~ Resolved in Task 45.
5. Operator commitments written into the pilot checklist: ~~correct `TRUST_PROXY` (T44-P1-04), proxy security headers
   (T44-P1-08)~~ (now enforced / shipped and verifiable — Task 46), scheduled off-host backups of the database **and** document directory with a restore drill
   (**T44-P1-10/11** — tooling shipped in Task 49: `ops:backup`, off-host hooks, `ops:restore --verify-only`, timers; the
   operator still configures the destination), an external uptime check, alert delivery and the process supervisor
   (**T44-P1-12** — `ops:monitor-check`, `hr-api.service` and the alert contract shipped in Task 49; delivery is the operator's).
6. Scope limits: Asia/Bangkok, copilot disabled or restricted to non-decision use, small trusted HR team aware of the
   self-approval gaps (**T44-P1-19/22/23**). ~~One currency (THB), departments ≤ 500 employees (T44-P1-13/14)~~ — no
   longer needed after Task 48: a mismatched currency is refused, not paid, and totals cover any department size.

## 28. Production classification — **NO**

Beyond the pilot blockers, production requires the remaining P1 items: ~~RBAC SoD enforced (P1-01), small-group
suppression in analytics and Report Center (P1-07)~~ (resolved in Tasks 45 / 47), document and off-host backups automated with alerting (P1-10/11),
monitoring and supervision (P1-12), ~~attendance/OT truncation (P1-13), payroll currency, handoff and post-approval
integrity (P1-14/15/16)~~ (resolved in Task 48), ~~complete privacy export (P1-17)~~ (Task 47), maker-checker and subject exclusion (P1-19), ~~per-permission
scope (P1-21)~~ (Task 50), copilot high-impact restriction if enabled (P1-22), organization timezone everywhere (P1-23), plus defined
RPO/RTO and MFA for privileged roles.

## 29. Enterprise classification — **NO**

Requires everything in §28 plus MFA for all users and SSO/SCIM, HA and horizontal scaling (shared rate-limit store,
object storage), PITR, email delivery, retention/legal hold/anonymization, malware scanning, WCAG AA, and release
engineering (tags, changelog, reproducible versioned builds).

## 30. Required remediation order

1. **Security blockers (pilot):** P0-01; P1-01 (SoD); P1-03; P1-04; P1-09; P2-01 bootstrap guard.
2. **Install and operations baseline (pilot):** ~~P1-02 build; P1-08 reference proxy config~~ (Task 46); ~~P1-10 document
   backup + consistency + honest readiness~~ (Task 49); P1-11/12 application side shipped in Task 49 (backup schedule
   examples, off-host hooks, monitor check, supervisor unit, emitted events) — external destination and alerting per deployment;
   doc drift (P2-21).
3. **Confidentiality (pilot):** ~~P1-05, P1-06, P1-18, P1-20, P1-24; then P1-07~~ (Task 47) and ~~P1-21~~ (Task 50).
4. **Data correctness (production):** ~~P1-13, P1-14, P1-15, P1-16~~ and ~~P2-15~~ resolved in Task 48; P1-23; P2-16/17.
5. **Governance and privacy (production):** P1-17, P1-19, P1-22; P2-07/08/09/10; MFA for privileged roles (P2-25).
6. **Hardening (production):** remaining P2 items.
7. **Enterprise track:** §26 / §29.

**Release recommendation.** Keep `0.1.0-rc.1` for this audited state (no tag yet). After steps 1–3, issue
`0.1.0-rc.2` as the pilot candidate with a git tag, a changelog and a build-derived version. A `1.0.0` production label
should wait for steps 4–6.
