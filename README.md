# HR Enterprise Platform

One employee data · One organization structure · One permission system · One workflow · One platform.

## Foundation Phase — Complete

| Area | Status | Notes |
|---|---|---|
| Authentication | ✅ | DB-backed sessions, httpOnly cookie, CSRF, login rate limit |
| RBAC + data scope | ✅ | permission codes, SELF/TEAM/ALL, admin-safety and escalation guards |
| User management | ✅ | users, roles, permission matrix |
| Organization structure | ✅ | organizations → departments (tree) → positions → jobs, department head |
| Employee master | ✅ | single source of truth, position/manager history, assignment rules |
| Audit log | ✅ | append-only, transactional for admin mutations, redacted, filterable UI |
| Dashboard | ✅ | scope-aware KPIs + permission-based quick actions |
| Attendance · Leave · Performance · Competency · Training · IDP · Workforce · Talent · Succession · Analytics · Settings | ⏳ Coming soon | menu placeholders only; Phase 2 is designed before implementation |

Later phases add HRM / HRD / HROD / Analytics / AI Copilot on top of the same core without changing it.

### Phase 2 — HRM Operations (in progress)

| Task | Status |
|---|---|
| 8 Workflow engine foundation | ✅ |
| 8.1 Approver resolution hardening | ✅ |
| 8.2 Workflow transition concurrency (instance row lock) | ✅ |
| 9 Leave master data + shared work calendars | ✅ |
| 10 Leave entitlement + ledger | ✅ (BalanceService reserve/release/use/refund = service-level only, no HTTP surface yet) |
| 10.5 PostgreSQL migration + balance concurrency validation | ✅ |
| 10.6 Request policy vs entitlement policy semantics | ✅ |
| 11 Leave request + workflow + reservation concurrency | ✅ (API + tests; Leave UI is Task 12) |
| 12 Leave UI + approval inbox | ✅ |
| 13 Notification foundation (in-app) | ✅ |
| 14 Leave reporting + Phase 2 review | ✅ |
| Attendance | Phase 2B |

## Stack

| Layer | Technology |
|---|---|
| Frontend | React 19, Vite, TypeScript, Tailwind CSS v4, React Router, TanStack Query, react-hook-form |
| Backend | Node.js, Express 5, TypeScript, Zod, Pino |
| Database | PostgreSQL (canonical since Task 10.5) via Prisma 6; SQLite history of Tasks 1–10 archived |
| Shared | `packages/shared` — permission / role codes, enums, zod schemas used by both sides |
| Tests | Vitest + Supertest |

## Structure

```
packages/shared/      constants + zod schemas shared by api and web
apps/api/             REST API   (src/modules/<domain>, src/services/<shared service>, prisma/)
apps/web/             SPA        (src/features/<domain>, src/components/{ui,layout,guards})
```

## Getting started

```bash
npm install
cp apps/api/.env.example apps/api/.env      # set DATABASE_URL, TEST_DATABASE_URL, SEED_ADMIN_PASSWORD (and SEED_DEMO_PASSWORD for demo accounts)
createdb hr_enterprise_dev && createdb hr_enterprise_test   # two SEPARATE PostgreSQL databases (see "Database")
npm run db:migrate                          # applies the PostgreSQL migrations to DATABASE_URL and runs the seed
npm run dev                                 # api → http://localhost:4000, web → http://localhost:5173
```

For production see [Running in production](#running-in-production) — development commands are never used there.

**Requires PostgreSQL** (developed against PostgreSQL 18; standard SQL only, no version-specific features). `npm run db:migrate`
targets PostgreSQL — it will not produce a SQLite file.

Run separately with `npm run dev:api` / `npm run dev:web`. The Vite dev server proxies `/api` to the API,
so the browser talks to one origin (cookies work without CORS).

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | api + web in watch mode |
| `npm run db:migrate` | `prisma migrate dev` (creates a migration from schema changes + seeds) |
| `npm run db:seed` | re-run the seed (idempotent) |
| `npm run db:studio` | Prisma Studio (DB browser) |
| `npm test` | API integration tests against a throwaway `apps/api/prisma/test.db` (see *Testing* below) |
| `npm run typecheck` | `tsc --noEmit` in every workspace |
| `npm run ops:cleanup-reset-tokens -- --days 30` | deletes spent (expired/used/revoked) password reset tokens |

## Testing

- `apps/api/tests/*.test.ts` are integration tests over the real Express app + Prisma + the dedicated PostgreSQL **test** database (`TEST_DATABASE_URL`).
  Files run **sequentially in separate processes** (`fileParallelism: false`); every file starts with `resetDatabase()`
  (all tables wiped in FK order, roles re-seeded), so files never depend on execution order. Unit tests without a DB could run in parallel if ever needed.
- Each file opens **one HTTP server bound to `127.0.0.1`** via `createTestServer()` instead of `request(app)`. supertest's
  per-request `app.listen(0)` binds `[::]:P` while connecting to `127.0.0.1:P`; on macOS that bind succeeds even when another
  process owns `127.0.0.1:P`, so requests occasionally reached a foreign process (garbage or wrong responses ≈ a few % of full runs).
- `npm test` = `db:test:reset` (drops + recreates the test schema, `prisma migrate deploy` from empty) then `NODE_ENV=test vitest run`.
  **Test DB safety**: `src/config/env.ts` exits when `NODE_ENV=test` without `TEST_DATABASE_URL` or when it equals `DATABASE_URL`;
  `resetDatabase()` / `cleanUsers()` re-check the same before deleting; `scripts/reset-test-db.ts` only accepts a PostgreSQL URL.
  Tests never fall back to the dev database. `TEST_LOG_LEVEL=error|debug` prints server-side logs (JSON) into vitest output.
- `tests/balance-concurrency.test.ts` opens real concurrent transactions (see "Concurrency" under Task 10.5) and is the acceptance
  suite for the row lock; it must pass 20/20 consecutive runs after any change to `BalanceService`.
- `loginAs()` / `explainAuthFailure()` fail with the account/session state (never passwords, hashes, tokens or cookies).

## API conventions

Base path `/api/v1`. REST resources: `GET /employees`, `GET /employees/:id`, `POST /employees`, `PATCH /employees/:id`.

```jsonc
// list
{ "data": [ ... ], "meta": { "page": 1, "pageSize": 20, "total": 143 } }
// single
{ "data": { ... } }
// error
{ "error": { "code": "VALIDATION_ERROR", "message": "Validation failed", "details": [{ "field": "email", "message": "..." }] } }
```

Every response carries `x-request-id`; the same id appears in the API log line for that request.

## Adding a module (e.g. Leave)

1. `packages/shared/src/permissions.ts` → add `leave.*` codes and grant them in `roles.ts`; run `npm run db:seed`.
2. `apps/api/src/modules/leave/` → `leave.routes.ts`, `leave.controller.ts`, `leave.service.ts`; mount in `src/routes.ts`.
3. Prisma model(s) referencing `employees.id`; `npm run db:migrate`.
4. `apps/web/src/features/leave/` pages; add the route in `src/app/router.tsx`; flip `comingSoon` off in `src/config/menu.ts`.

## Database (PostgreSQL) and migration boundary

- **Canonical database**: PostgreSQL for development, integration tests and production (`provider = "postgresql"`). Runtime support
  for SQLite was dropped in Task 10.5 — one dialect, one migration history.
- **Migration boundary**: `apps/api/prisma/migrations/` contains the PostgreSQL history, starting with the baseline
  `20260922091154_init_postgresql` generated from the Task 10 data model (empty database → `migrate deploy` → `db:seed` → run).
  `apps/api/prisma/migrations-sqlite-archive/` is the SQLite history of Tasks 1–10, kept as a historical development record only —
  **never apply it to PostgreSQL** and never add to it. No data was migrated from `dev.db` (demo/seed data only; re-seed instead).
  A leftover `apps/api/prisma/dev.db` is inert and still git-ignored (`*.db`).
- **Two databases**: `DATABASE_URL` (dev, seeded) and `TEST_DATABASE_URL` (tests; wiped on every run). Same server, separate databases.
- Scripts (`apps/api`): `db:generate`, `db:migrate` (dev: create/apply + seed), `db:deploy` (apply only), `db:seed` (idempotent),
  `db:test:reset` (guarded destructive reset of the test database), `test`.

## Authentication

| Endpoint | Auth | CSRF | Notes |
|---|---|---|---|
| `POST /auth/login` | – | exempt | `{ email, password }` → user payload + `hr_session` cookie. Rate limited per IP. |
| `POST /auth/logout` | cookie | required | Revokes the session, clears the cookie (idempotent, 204). |
| `GET /auth/me` | cookie | – | Current user: employee summary, roles, permissions, dataScope, csrfToken. |

- **Session**: `crypto.randomBytes(32)` token in an `httpOnly; SameSite=Lax; Path=/` cookie (`Secure` in production).
  The DB stores only `SHA-256(token)` plus a separate random `csrf_token`. TTL = `SESSION_TTL_HOURS`.
  Login always creates a fresh session (any session presented at login is revoked). Expired sessions and
  sessions of deactivated users are rejected by the `authenticate` middleware.
- **CSRF**: synchronizer token. Mutations (POST/PUT/PATCH/DELETE) made with a session must send
  `x-csrf-token: <csrfToken from /auth/me>`; the global `csrfGuard` compares it against the session row.
  When an `Origin` header is present it must match `CORS_ORIGIN` or the request host (defense-in-depth).
- **Middleware for new modules**: `requireAuth` (401 without session) → `req.auth = { userId, employeeId, roles, permissions, dataScope, ... }`.
  `requirePermission(...)` arrives in Task 3.
- **Login rate limit**: `LOGIN_MAX_ATTEMPTS` failures per IP within `LOGIN_WINDOW_MINUTES` → 429. In-memory; use a shared store (Redis) when running more than one API instance.

## Authorization (RBAC)

- **Permission codes are the source of truth** (`packages/shared/src/permissions.ts`). Routes declare
  `requirePermission('users.update')`; nothing authorizes by role name.
- **Effective permissions** = union of all assigned roles' permissions (deduplicated, sorted);
  **data scope** = widest of the roles' scopes (`ALL > TEAM > SELF`). Both are computed in
  `services/authorization/authorization.service.ts`, rebuilt from the DB on every request by `authenticate`
  (so permission changes apply on the next request) and exposed on `req.auth` and `GET /auth/me`.
- **SYSTEM_ADMIN policy (Option B)**: the role's permissions are DB-driven like any other role, but
  `PATCH /roles/:id/permissions` refuses to remove `CRITICAL_PERMISSIONS` from it (`409 CRITICAL_PERMISSION_REQUIRED`).
- **Admin safety**: no self-deactivation (`SELF_DEACTIVATION_NOT_ALLOWED`), no removing SYSTEM_ADMIN from yourself
  (`SELF_ROLE_REMOVAL_NOT_ALLOWED`), the last active SYSTEM_ADMIN cannot be deactivated or demoted (`LAST_SYSTEM_ADMIN`),
  and nobody can grant a role whose permissions exceed their own (`ROLE_ESCALATION_NOT_ALLOWED`)
  or whose data scope is wider than their own (`ROLE_SCOPE_ESCALATION_NOT_ALLOWED`).
- **Frontend** (`usePermission`, `<PermissionGuard>`, `<RequirePermission>` → 403 page, permission-aware sidebar) is UX only.

| Users API | Permission |
|---|---|
| `GET /users`, `GET /users/:id` | `users.view` |
| `POST /users` | `users.create` |
| `PATCH /users/:id`, `PATCH /users/:id/roles`, `POST /users/:id/reset-password` | `users.update` |
| `PATCH /users/:id/activate`, `PATCH /users/:id/deactivate` (revokes all sessions) | `users.activate` |
| `GET /users/employee-options` | `users.create` or `users.update` |
| `GET /roles`, `GET /roles/:id`, `GET /permissions` | `roles.view` |
| `PATCH /roles/:id/permissions` | `roles.manage` |

Administrative mutations write their audit row inside the same transaction (rollback if the audit fails);
auth events (login/logout) are best-effort.

## Organization structure

`Organization → Department (nested via parent_id) → Position → Job`. Jobs are reusable job definitions; positions are concrete seats in a department.

| API | Permission |
|---|---|
| `GET /organizations`, `/departments`, `/jobs`, `/positions` (+ `/:id`), `GET /organizations/:id/departments`, `GET /organization/tree?organizationId&includeInactive` | `organization.view` |
| `POST`, `PATCH /:id`, `PATCH /:id/activate`, `PATCH /:id/deactivate` on each resource | `organization.manage` |

- Codes are trimmed/upper-cased. Unique: organization + job + position codes globally; department code within its organization.
- Department hierarchy: parent must exist, be active and belong to the same organization; a department cannot be its own parent or
  be moved under one of its descendants (`CIRCULAR_HIERARCHY`). `organizationId` is immutable after creation.
- Active positions require an active department (in an active organization) and an active job.
- No hard deletes and no cascading: deactivation is refused while dependants are active —
  `ORGANIZATION_IN_USE` (active departments/employees), `DEPARTMENT_IN_USE` (active sub-departments/positions/employees),
  `JOB_IN_USE` (active positions), `POSITION_IN_USE` (active employees).
- The tree endpoint runs three queries (organizations, departments, positions+job) and nests in memory; inactive nodes are hidden unless `includeInactive=true`.

## Employee master

`employees` is the single source of truth; every future module references `employees.id`.
Current assignment lives on the row (`organizationId`, `departmentId`, `positionId`, `managerId`); history in
`employee_positions` / `employee_managers` (`endDate = null` = current, at most one open row each; `endDate` is the
exclusive boundary and equals the next row's `startDate`).

| API | Permission |
|---|---|
| `GET /employees` (search, filters, whitelisted sort, pagination), `GET /employees/options`, `GET /employees/:id`, `/:id/position-history`, `/:id/manager-history`, `/:id/reports` | `employees.view` |
| `POST /employees` (profile + `positionId` + optional `managerId`) | `employees.create` |
| `PATCH /employees/:id` (profile only), `PATCH /employees/:id/position`, `PATCH /employees/:id/manager` | `employees.update` |
| `PATCH /employees/:id/activate`, `PATCH /employees/:id/deactivate` (INACTIVE, never TERMINATED) | `employees.activate` |
| `PATCH /departments/:id/head` | `organization.manage` |

- **Data scope** (`req.auth.dataScope`) is added to the Prisma WHERE of every employee query: SELF = own record,
  TEAM = self + direct reports (`managerId = me`, not recursive), ALL = everything. Out-of-scope records answer
  `404 EMPLOYEE_NOT_FOUND` (no existence leak); mutations use the same scoped lookup.
- **Effective date** (position/manager change): defaults to now; must not be in the future (`FUTURE_EFFECTIVE_DATE_NOT_SUPPORTED`)
  and not before the current open history row's start (`INVALID_EFFECTIVE_DATE`); backdating inside the current assignment is allowed.
- **Position is the source of truth**: the server derives department/organization from `positionId`
  (`resolvePositionAssignment`, requires the position → department → organization → job chain to be active).
  Changing a position closes the open history row, opens a new one and updates the three pointers in one transaction.
- **Manager**: must be an active employee, not self, and not create a cycle (`MANAGER_CYCLE_NOT_ALLOWED`, checked by
  walking the manager chain in memory). Cross-department managers are allowed. Clearing closes the open history row.
- **Department head ≠ manager**: head must be an active employee of that department; setting it never touches
  `managerId`. A head cannot be moved to another department (`EMPLOYEE_IS_DEPARTMENT_HEAD`) or deactivated until cleared.
- **Deactivation** is refused while the employee manages active reports or heads a department (`EMPLOYEE_IN_USE` with
  counts). Re-activation requires the current position chain and manager to be active. Employment status and the linked
  user account (`users.isActive`) are independent — neither cascades to the other.
- Audit (same transaction): `CREATE_EMPLOYEE`, `UPDATE_EMPLOYEE` (field diff), `CHANGE_EMPLOYEE_POSITION` (org/dept/position old→new),
  `CHANGE_EMPLOYEE_MANAGER`, `ACTIVATE_EMPLOYEE`, `DEACTIVATE_EMPLOYEE`, `UPDATE_DEPARTMENT_HEAD`.

## Audit log

Read-only API (`audit.view`): `GET /audit-logs` (filters `userId`, `module`, `action`, `recordType`, `recordId`, `dateFrom`
inclusive, `dateTo` **exclusive**, UTC ISO timestamps; `page`/`pageSize` ≤ 100; `sortDir`, newest first) and `GET /audit-logs/:id`
(old/new payload, parsed safely — `{ "_unparsed": true }` for malformed rows — and redacted again on read). No create/update/delete
endpoint exists; `prisma.auditLog` is written only by `services/audit/audit.service.ts`.

Audit matrix (every mutation endpoint → action; all admin actions are written inside the mutation's transaction, auth events are best-effort):

| Module | Actions |
|---|---|
| auth | LOGIN_SUCCESS, LOGIN_FAILED, LOGOUT |
| users | CREATE_USER, UPDATE_USER, UPDATE_USER_ROLES, ACTIVATE_USER, DEACTIVATE_USER, RESET_USER_PASSWORD |
| roles | UPDATE_ROLE_PERMISSIONS |
| organization | CREATE/UPDATE/ACTIVATE/DEACTIVATE_ORGANIZATION, …_DEPARTMENT (+ UPDATE_DEPARTMENT_HEAD), …_JOB, …_POSITION |
| employees | CREATE_EMPLOYEE, UPDATE_EMPLOYEE, CHANGE_EMPLOYEE_POSITION, CHANGE_EMPLOYEE_MANAGER, ACTIVATE_EMPLOYEE, DEACTIVATE_EMPLOYEE |

Known limitations: `actor.email` is the user's *current* email (the immutable identity is `actor.userId`); no retention/archive or export yet;
validation failures (duplicates, cycles, in-use) are not audited by design.

## Dashboard

`GET /dashboard/summary` (`dashboard.view`, not audited). Every number uses the **same** population as the employee list —
`employeeScopeWhere(auth)` — so a manager's "Total employees" equals their unfiltered Employees list.

| KPI | Definition |
|---|---|
| Total employees | employees visible in the caller's data scope, any employment status |
| Active employees | …with `employmentStatus = ACTIVE` |
| Departments (represented) | distinct `departmentId` across the visible employees — **not** the department master count |
| New employees — last 30 days | visible employees with `hireDate ≥ startOfUtcDay(today − 29)` (i.e. the last 30 calendar days including today; hire date, not `createdAt`) |

Four aggregate queries (`count` ×3 + `findMany distinct departmentId`), no employee DTOs loaded.

## Environment variables (`apps/api/.env`, never committed)

| Variable | Purpose |
|---|---|
| `NODE_ENV`, `PORT`, `LOG_LEVEL` | runtime |
| `DATABASE_URL` | PostgreSQL URL of the development database |
| `TEST_DATABASE_URL` | PostgreSQL URL of the **separate** test database (required under `NODE_ENV=test`; must differ from `DATABASE_URL`) |
| `CORS_ORIGIN` | allowed browser origin (also used by the CSRF origin check) |
| `SESSION_TTL_HOURS`, `COOKIE_SECURE` | session lifetime; `Secure` cookies are forced on in production |
| `LOGIN_MAX_ATTEMPTS`, `LOGIN_WINDOW_MINUTES` | login rate limit |
| `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD` | first System Admin (seed, dev only) |
| `SEED_DEMO_PASSWORD` | optional demo accounts per role (seed, dev only) |
| `PUBLIC_APP_URL` | base URL the server puts in generated links (password resets). **Required in production** (https, no credentials/query/fragment, not localhost); development falls back to the first `CORS_ORIGIN`. Never derived from the request `Host` header |
| `PASSWORD_RESET_TTL_MINUTES` | lifetime of a one-time reset link (5–1440, default 60) |
| `TEST_LOG_LEVEL` | tests only: set `error` to print server-side 5xx causes |

## Known limitations / backlog

- Login rate limiter is in-memory (single instance).
- Audit: actor email is the current email (identity = `userId`); no retention/archive/export.
- Account recovery is admin-assisted (one-time link); no email/SMS delivery, so no self-service forgot-password.
- Privacy: request register + personal-data export exist; retention/erasure policy and automated deletion do not.
- Attendance: web clock only — no GPS, biometric devices, multiple punches or payroll posting.
- Overtime: claim-based after the fact, minutes and multipliers only — no rounding rule or approved-claim reversal.
- Payroll: no tax, social security, provident fund, bank file or GL posting; monthly only, one currency, one run per period, no off-cycle or retroactive run, no reopen after closing.
- Department head is set from the Departments page only; no termination flow (`terminationDate` read-only).
- No automated frontend tests (API integration tests cover security and business rules; UI verified manually per task).

## Workflow engine (shared service)

`services/workflow/` is reused by every approval-driven module; it knows only `(module, entityType, entityId)`.

- **Definitions are versioned and immutable**: `workflow_definitions (code, version)` + `workflow_definition_steps`. "Editing" = `POST /workflow/definitions` creates `max(version)+1` (inactive); `POST /workflow/definitions/:id/activate` validates (≥1 step, contiguous 1..n, approver config) and makes it the single active version of that code.
- **Instances snapshot their approvers**: `workflowEngine.submit()` (called inside the business module's transaction) resolves each step from the requester's *current* data — `DIRECT_MANAGER` → `employees.managerId`, `DEPARTMENT_HEAD` → `departments.headEmployeeId`, `SPECIFIC_USER` → configured user (must be active; a linked employee, if any, must be ACTIVE — system users without an employee are allowed). Manager/head approvers require an ACTIVE employee with an active login, and stores `approverEmployeeId/approverUserId/approverType` on `workflow_instance_steps`. Later org changes never affect a running instance. `ROLE` approvers are reserved, not enabled (RBAC roles are not organization-scoped approval groups).
- **onSelf / onUnresolved** default `FAIL`: submit answers `409 SELF_APPROVAL_NOT_ALLOWED` / `409 APPROVER_UNRESOLVED` (step + reason only). `SKIP` must be configured per step; if every step is skipped the instance is approved immediately (audited `autoApproved`).
- **Approver picker**: `GET /workflow/approver-options?search=` (`workflow.manage_definitions`) returns active users with a minimal employee summary, so workflow admins do not need `users.view`.
- **Sequential**: only the current `PENDING` step's snapshot approver may `APPROVE`/`REJECT` (`POST /workflow/instances/:id/actions`, `workflow.approve`); approve advances or completes, reject completes and cancels remaining steps. `CANCEL` is internal (`workflowEngine.cancel`) and only exposed by business endpoints (e.g. `POST /leave/requests/:id/cancel`).
- **Inbox** (`GET /workflow/inbox`) = steps where I am the snapshot approver — an authorization context independent of employee data scope. Instance reads: requester, snapshot approvers or `workflow.view_all`; others get 404.
- **Handlers**: `workflowEngine.registerHandler(module, { onApproved, onRejected })` run inside the engine's transaction; a failing handler rolls back the transition.
- **History**: `workflow_actions` (append-only) + `audit_logs` (`WORKFLOW_SUBMIT/APPROVE/REJECT/CANCEL`, `CREATE/ACTIVATE/DEACTIVATE_WORKFLOW_DEFINITION`) in the same transaction.

- **Transition concurrency (Task 8.2)**: `loadWorkflowInstanceForMutation(tx, id)` takes `SELECT "id" FROM "workflow_instances" WHERE "id" = $1 FOR UPDATE`
  before `act()` / `cancel()` read anything, so the order is lock → reload → status → actor → step → instance → action → audit →
  handler → commit (no read-then-lock TOCTOU). Granularity = one instance row. Handler lock order is fixed as workflow_instance →
  business record → entitlement. `onCancelled` runs inside the business module's cancel transaction. Validated in
  `tests/workflow-concurrency.test.ts` (approve∥approve, approve∥reject, final approve∥cancel, multi-step double approve, different
  instances not blocking, handler failure rollback releasing the lock); removing the lock fails 4 of 7 tests; 20/20 consecutive runs.

## Work calendars, leave types and policies (Task 9)

- **Business dates** are `YYYY-MM-DD` strings validated as real calendar dates (`isBusinessDate`); timestamps stay UTC. `organizations.timezone`
  (IANA, default `Asia/Bangkok`, validated by `isValidTimezone` — offsets like `+07:00` are rejected) is the source of truth for
  `businessToday(timezone)`. All date/working-day/leave-unit arithmetic lives in `packages/shared/src/business-date.ts`.
- **Work calendars** (`modules/calendar`, shared with Attendance later): `work_calendars` (code unique per organization, `workingDays`
  = validated, ordered subset of MON..SUN) + `holidays` (unique per calendar/date, may fall on non-working days) +
  `organizations.defaultCalendarId` (must be an active calendar of that organization; `CALENDAR_IN_USE` blocks deactivating the default).
  Permissions `calendar.view` / `calendar.manage`; API `/calendars`, `/calendars/:id/holidays`, `/holidays/:id`, `PATCH /calendars/organizations/:organizationId/default`.
- **Leave types** are semantic only (`code`, `name`, `description`); `LEAVE_TYPE_IN_USE` blocks deactivation while an active policy references them.
- **Leave policies** hold the rules (annual units, half-day, negative balance, notice, carry-forward, workflow code, effective range) for a
  `(leaveType, organization|ANY, employmentType|ANY)` selector. New policies are inactive; **activation** validates dates, active leave type /
  organization, `LEAVE_POLICY_OVERLAP` (same selector, inclusive ranges overlap; global and specific coexist), and a workflow code that is
  active and compatible with `leave/LEAVE_REQUEST` (`WORKFLOW_DEFINITION_NOT_FOUND` / `_INCOMPATIBLE`). Re-activation and edits of active
  policies re-run the same validation. `policyId` is a historical identity for entitlements/requests (reference guard arrives with those tables).
- **Resolver** `leavePoliciesService.resolve({ leaveTypeId, organizationId, employmentType, asOfDate })` loads only active, effective
  candidates and ranks: org+type → org+any → any+type → global (`LEAVE_POLICY_NOT_FOUND` otherwise). Clients never choose a policy.
- **Units**: whole or half days (`isHalfDayUnit`). `calculateLeaveUnits` = working days in range − 0.5 for a PM start − 0.5 for an AM end;
  same-day PM→AM and half days on non-working days/holidays are rejected.
- Permissions `leave.manage_types`, `leave.manage_policies`; `GET /leave/workflow-options` gives policy managers the compatible workflows without workflow admin rights.

## Leave entitlements and balance ledger (Task 10)

- **Model**: `leave_entitlements` = one row per `(employee, leaveType, periodStart)` with a **cached summary** (`granted`, `carriedForward`,
  `adjustment`, `reserved`, `used`); `leave_ledger` = **append-only source of truth** (`entryType`, signed `units`, optional
  `referenceType/referenceId`, `operationKey @unique`, `note`, `createdByUserId`). The cache is recomputed **from the ledger inside the same
  transaction** on every write (`summaryFromLedger`), never incremented. `reconcile(id)` reports drift read-only (no auto-repair).
  Periods for the same employee/type may not overlap (`ENTITLEMENT_PERIOD_OVERLAP`); identical period → `ENTITLEMENT_ALREADY_EXISTS`.
- **Sign convention** (`packages/shared/src/leave-ledger.ts`, `LEDGER_SIGN`): GRANT +, CARRY_FORWARD +, ADJUSTMENT ±, RESERVE + / RELEASE −
  (net → `reserved`), USE + / REFUND − (net → `used`). `available = granted + carriedForward + adjustment − reserved − used`. Units are
  non-zero multiples of 0.5 (`LEDGER_UNIT_INVALID`, `LEDGER_SIGN_INVALID`), validated before rounding.
- **BalanceService** (`modules/leave/balance.service.ts`) is composable with the caller's transaction (`grant/carryForward/adjust/reserve/
  release/use/refund(tx, …)`) and loads the entitlement through a single `loadEntitlementForMutation(tx, id)` (the future `SELECT … FOR UPDATE`
  point). Guards: no negative available balance unless the referenced policy `allowNegativeBalance` (`INSUFFICIENT_LEAVE_BALANCE`),
  release ≤ reserved, refund ≤ used, cumulative carry-forward ≤ `policy.carryForwardMaxUnits` (`CARRY_FORWARD_EXCEEDS_POLICY`).
- **Idempotency**: every write carries an `operationKey` — `grant:<entitlementId>`, `leave:<requestId>:reserve|release|use|refund`,
  `adj:<uuid>`, `cf:<uuid>`. Same key + same payload → replay of the existing row (`idempotentReplay: true`); same key + different payload
  → 409 `LEDGER_OPERATION_CONFLICT`.
- **Generation** (`POST /leave/entitlements` — client sends only `employeeId, leaveTypeId, periodStart, periodEnd`): validates active
  employee/type → overlap → resolves the policy at `periodStart` (`policyId` + `policyResolvedDate` snapshot) → creates the row → GRANT
  `annualUnits` (no ledger row when `annualUnits = 0`) → audit `GENERATE_LEAVE_ENTITLEMENT`, all in one transaction. `GET /leave/entitlements/preview`
  shows the resolved policy before generating. No mass generation yet.
- **Policy reference hardening**: once entitlements reference a policy, `PATCH` may change only `name` and `effectiveTo`
  (`effectiveTo ≥ MAX(policyResolvedDate)`); anything else → 409 `LEAVE_POLICY_IN_USE`. Deactivating is allowed — existing entitlements keep
  the historical `policyId` and remain viewable.
- **API** (permission `leave.manage_entitlements`; HR, HR_ADMIN, SYSTEM_ADMIN): `GET /leave/entitlements` (filters employee/organization/
  leaveType/year/period), `GET /leave/entitlements/:id`, `GET /leave/entitlements/:id/ledger`, `POST /leave/entitlements/:id/adjust`
  (signed units + required note), `POST /leave/entitlements/:id/carry-forward`, `GET /leave/employee-options`, `GET /leave/type-options`.
  Audit actions `GENERATE_/ADJUST_/CARRY_FORWARD_LEAVE_ENTITLEMENT` are written in the same transaction. There are **no employee-facing
  balance endpoints and no leave requests yet** (Task 11); `reserve/release/use/refund` have no HTTP surface.
- **Entitlement policy vs request policy (Task 10.6)** — `leave_entitlements.policyId` is the historical *grant* policy (why the
  employee received N units; carry-forward cap; admin adjustment/carry-forward accounting rules). A leave request resolves its own
  *request* policy at SUBMIT from the employee's current organization/employment type + leave type + start date and snapshots it
  in `leave_requests.policyId`; after a transfer it may differ from the entitlement's policy while the balance still comes from the
  old entitlement (no automatic re-grant on transfer in Phase 2). `balanceService.reserve(tx, id, units, { …, balancePolicyId })`
  applies the request policy's `allowNegativeBalance` (policy must exist and be for the entitlement's leave type, else
  `BALANCE_POLICY_MISMATCH`); `balancePolicyId` is internal — never accepted from a client. release/use/refund settle an existing
  reservation and resolve no policy. The `LEAVE_POLICY_IN_USE` guard counts entitlements **and** submitted leave requests
  (drafts without `policyId` are not references); `effectiveTo` may not precede the latest resolution date of either.
  The `leave_requests` table (schema + indexes) was added in this task; its lifecycle service is Task 11.
- **Concurrency (Task 10.5)** — `loadEntitlementForMutation(tx, id)` runs `SELECT "id" FROM "leave_entitlements" WHERE "id" = $1 FOR UPDATE`
  (parameterised tagged template) before loading the row, so every mutation of an existing entitlement (adjust, carryForward,
  reserve, release, use, refund) is serialised per entitlement: **lock → operationKey check → balance guard → insert → recompute →
  cache → commit**. The initial GRANT happens inside the transaction that creates the row, before it is visible. Lock granularity is
  one entitlement row (no global mutex, proven by the "different entitlements" test); one operation touches one entitlement, so no
  lock ordering is needed yet — a future multi-entitlement operation must lock in a deterministic (id) order. Isolation stays at
  PostgreSQL's default READ COMMITTED: after the lock is granted, subsequent statements see what the previous holder committed,
  which is all the balance guard needs; no SERIALIZABLE, no retry framework. The referenced policy is not locked because its rule
  fields are immutable once referenced (`LEAVE_POLICY_IN_USE`). A same-`operationKey` race across two different entitlements is caught
  by the unique index and mapped to 409 `LEDGER_OPERATION_CONFLICT`. **Guarantee validated** (`tests/balance-concurrency.test.ts`):
  available 2 + concurrent reserve 2/2 → exactly one succeeds; available 5 + 10 concurrent reserve 1 → exactly 5; same key + same
  payload concurrently → one ledger row, both callers succeed; rollback releases the lock; cache == ledger after every scenario;
  0.5-unit sums are exact on `DOUBLE PRECISION`. Removing the `FOR UPDATE` makes 6 of the 10 tests fail (double-spend), so the
  suite detects the race. Full suite 5/5 and concurrency suite 20/20 consecutive green on PostgreSQL 18.6 at Task 10.5 sign-off.

## Leave requests (Task 11)

- **Lifecycle** `DRAFT → PENDING → APPROVED | REJECTED | CANCELLED`, all transitions transactional.
  API: `POST /leave/requests` (draft), `PATCH /leave/requests/:id` (draft only), `POST /leave/requests/preview` (read-only),
  `POST /leave/requests/:id/submit`, `POST /leave/requests/:id/cancel`, `GET /leave/requests`, `GET /leave/requests/:id`,
  `GET /leave/balances/me`. Approval stays on the generic `POST /workflow/instances/:id/actions` (APPROVE/REJECT) — there is
  no leave-specific approve endpoint and no generic workflow CANCEL.
- **Three authorization contexts**: *browse* = `leave.view` + `employeeScopeWhere` (SELF/TEAM/ALL); *self-service mutation* =
  `leave.request` for `auth.employeeId` only (even an ALL-scope user cannot create, edit, submit or cancel for someone else);
  *approval* = `workflow.approve` + the snapshot approver identity, independent of data scope. A request detail is readable by
  an in-scope viewer **or** by a snapshot approver (so approvers outside their data scope can decide); anyone else gets 404,
  never 403, so existence is not leaked. Every filter in the list query is AND-ed with the scope clause.
- **Request input is strict**: the create/update schemas reject unknown keys, so `employeeId`, `units`, `status`, `policyId`,
  `entitlementId`, `calendarId`, `organizationId/departmentId/positionId`, `workflowInstanceId` and the timestamps can never be
  written by a client (400). PATCH carries no defaults — omitted fields keep their stored values.
- **Submit transaction** (one transaction, lock order **leave_request → employee → entitlement**): lock the request → lock the
  employee (serialises that employee's submissions even across leave types, which use different entitlement rows) → revalidate
  leave type/calendar/units, entitlement, request policy, policy rules and overlap → `reserve` (locks the entitlement,
  `operationKey = leave:<id>:reserve`, `balancePolicyId` = request policy) → write snapshots + `PENDING` → `workflowEngine.submit`
  → store `workflowInstanceId` → audit. Submitting again is idempotent: a request that is already PENDING/APPROVED with an
  instance returns its current state — no second reservation, workflow or audit row.
- **Auto-approval**: when every workflow step is skipped the engine calls `onApproved` *inside* the submit transaction, so the
  snapshots and `PENDING` are written **before** `workflowEngine.submit`, and afterwards only `workflowInstanceId` is stored —
  the handler's `APPROVED` is never overwritten back to `PENDING` (regression-tested).
- **Terminal handlers** (`leave-request.handlers.ts`) run on the engine's transaction, lock order **workflow_instance →
  leave_request → entitlement**: `onApproved` = release + use (`leave:<id>:release`, `leave:<id>:use`) + `APPROVED`;
  `onRejected` / `onCancelled` = release + `REJECTED` / `CANCELLED`. Workflow instance/step/action, leave status, ledger rows,
  entitlement cache and both audit entries commit or roll back together.
- **Snapshots are frozen at submit**: entitlement, request policy, calendar + units and org/dept/position. Later changes to the
  organization's default calendar, holidays, the employee's assignment or the policy set never recalculate a submitted request;
  approval settles the stored units.
- **Entitlement selection**: exactly one entitlement whose period covers the whole range; a range spanning two periods →
  `LEAVE_CROSSES_ENTITLEMENT_PERIOD`, none → `LEAVE_ENTITLEMENT_NOT_FOUND` (no splitting in Phase 2).
- **Overlap** is half-day aware via `leaveSpansOverlap` in `@hr/shared` (day → AM/PM slots): Full∩Full, Full∩AM, Full∩PM, AM∩AM,
  PM∩PM overlap; AM∩PM of the same day does not. PENDING and APPROVED block; DRAFT, REJECTED and CANCELLED do not. The DB
  narrows candidates by date range + blocking status first, so no employee's full history is loaded.
- **Cancellation policy**: the requester may cancel a DRAFT or a PENDING request (even after earlier steps approved, while the
  workflow is still pending). APPROVED leave cannot be cancelled here — an approved-leave cancellation workflow is backlog.
- **Concurrency guarantees** (`tests/leave-concurrency.test.ts`, 20/20 consecutive runs): concurrent submit of the same draft →
  one reservation + one instance; concurrent overlapping submits of different leave types → exactly one succeeds (employee row
  lock, not the entitlement lock); final approve vs cancel → exactly one terminal outcome with ledger and audit agreeing;
  duplicate final approve → one transition, one RELEASE + one USE; different employees never block each other. Removing the
  employee lock fails test 78 and removing the request lock fails test 77, so the suite detects both races.
- **Error codes** (never raw Prisma/PostgreSQL): `LEAVE_REQUEST_NOT_FOUND/_NOT_DRAFT/_NOT_PENDING/_NOT_CANCELLABLE`,
  `EMPLOYEE_PROFILE_REQUIRED`, `LEAVE_ASSIGNMENT_REQUIRED`, `LEAVE_TYPE_INACTIVE`, `LEAVE_ENTITLEMENT_NOT_FOUND`,
  `LEAVE_CROSSES_ENTITLEMENT_PERIOD`, `LEAVE_POLICY_NOT_FOUND`, `LEAVE_CROSSES_POLICY_PERIOD`, `WORK_CALENDAR_NOT_CONFIGURED`,
  `LEAVE_REASON_REQUIRED`, `LEAVE_ATTACHMENT_REQUIRED`, `LEAVE_HALF_DAY_NOT_ALLOWED`, `LEAVE_HALF_DAY_INVALID`,
  `LEAVE_BACKDATE_NOT_ALLOWED`, `LEAVE_NOTICE_NOT_MET`, `LEAVE_MAX_CONSECUTIVE_EXCEEDED`, `LEAVE_UNITS_ZERO`,
  `LEAVE_REQUEST_OVERLAP`, `INSUFFICIENT_LEAVE_BALANCE`, `BALANCE_POLICY_MISMATCH`.
- **Permissions** `leave.view` + `leave.request` (both granted to EMPLOYEE, MANAGER, HR, HR_ADMIN, EXECUTIVE, SYSTEM_ADMIN);
  25 permissions total. `attachmentRef` is an opaque string — there is no upload or document service yet, and no notifications
  (Task 13) or Leave UI (Task 12).

## Leave UI and approval inbox (Task 12)

- **Pages** under `/hrm/leave` (`features/leave/`): **My leave** (balance cards + my requests + new/edit request dialog),
  **Approvals** (inbox), **Team leave** (who is away, by day) and **All requests** (organization-wide). Tab visibility is
  capability-based, never role names: My leave needs `leave.view` + a linked employee, Approvals needs `workflow.approve`,
  Team leave needs `leave.view` + data scope TEAM/ALL, All requests needs `leave.view` + scope ALL. These are UX hints —
  every endpoint re-checks the same rules.
- **Read models added for the UI** (no business logic duplicated on the client):
  `GET /leave/requests/me` — always the caller's own requests; an ALL-scope user opening My leave does **not** load the
  company. No employee profile → empty list (mutations still return `EMPLOYEE_PROFILE_REQUIRED`).
  `GET /leave/approvals` — pending leave steps where the caller **is the snapshot approver**, with the request, employee,
  department, position and leave type batch-loaded in one query (no per-row detail fetch). Data scope and
  `workflow.view_all` never widen it.
  `GET /leave/calendar` — summary of who is away in a required `from`/`to` range inside the caller's data scope;
  deliberately excludes reason, attachment, policy internals, ledger figures and workflow comments, and `status` is
  whitelisted to PENDING/APPROVED (a draft is not an absence and belongs to its owner).
  `GET /leave/type-options` now also accepts `leave.view` so any requester can pick a leave type.
- **The server is the only calculator.** The new-request dialog calls `POST /leave/requests/preview` for units, policy
  rules, calendar, balance and the approval route; changing any field marks the preview stale and blocks Submit until it
  is refreshed. A preview is **not a guarantee** — Submit revalidates everything, and a losing race (e.g.
  `INSUFFICIENT_LEAVE_BALANCE`, `LEAVE_REQUEST_OVERLAP`) is shown in the dialog with the balances refreshed.
  Submitting follows the real lifecycle: create draft → `POST /:id/submit`.
- **Approve / reject** use the generic `POST /workflow/instances/:id/actions`; there is no leave-specific approval
  mutation. The screen requires a comment to reject (the API keeps it optional — changing that would be an engine rule).
  Cancel/withdraw uses `POST /leave/requests/:id/cancel` for DRAFT and PENDING; approved leave shows a note that
  cancelling it is not supported yet.
- **Shared leave UI** (`features/leave/leave-ui.tsx`): `formatLeaveUnits` (in `@hr/shared`, half-day precise — 10, 10.5,
  0.5, -0.5; replaces the page-local formatter Task 10 used), `formatBusinessDate` (formats `YYYY-MM-DD` from its parts,
  never through a UTC `Date`, so days never shift), `LeaveStatusBadge` (text + colour), `StepTimeline` (snapshot
  approvers exactly as recorded, with human-readable skip reasons), `BalanceCards` (`reserved` shown as "Pending"; the
  accounting term stays `reserved` in the API and ledger) and `leaveErrorMessage` mapping every leave business error to a
  sentence, with a generic fallback for unknown/5xx.
- **Query keys** are namespaced (`leaveKeys.myRequests/request/balancesMe/approvals/calendar/requests`); mutations
  invalidate the leave namespace plus the dashboard, never the whole cache. Buttons disable while a mutation is in
  flight — backend idempotency and row locks remain the correctness mechanism.
- **Responsive**: verified at 390px with no horizontal scroll; tables drop secondary columns on phones (the details move
  into the row subtitle) and the request form is single-column. Team leave is a dependency-free month list grouped by
  day — no calendar library was added, and no new dependency at all in this task.

## Notifications (Task 13)

- **Shared service, not a leave feature.** `services/notification/` owns the model, the wording and the outbox;
  business modules only publish events: `notificationService.publish({ userId, type, source, data, dedupeKey }, vars, tx)`.
  Titles and bodies come from `notification.templates.ts`, so no module hardcodes copy.
- **Authorization**: the inbox is the signed-in user's own data, so there is **no permission code and no data scope** —
  `requireAuth` plus a `userId` filter on every query. Not even SYSTEM_ADMIN or an ALL-scope role can read another
  inbox; another user's notification id returns **404** (never 403, so existence is not leaked). Admin inspection of
  other people's notifications is backlog.
- **Transaction policy**: `publish` runs on the caller's transaction, so the notification row and its IN_APP delivery
  commit with the leave/workflow change — a failed notification insert rolls the business transaction back (in-app
  delivery is durable by definition). **No external call ever runs inside a transaction**; email/LINE/Lark/push will be
  PENDING outbox rows plus a worker. A missing or inactive recipient is skipped silently — an approval must never fail
  because the requester has no active account.
- **Idempotency**: unique `(userId, dedupeKey)` with deterministic keys — `leave:<id>:submitted|approved|rejected`,
  `workflow:<instanceId>:step:<stepId>:approval-required`. Same key + same event replays the existing row; same key for
  a *different* event is a 409 `NOTIFICATION_DEDUPE_CONFLICT`. A concurrent double publish leaves exactly one
  notification and one delivery (unique index as the backstop).
- **Workflow integration stays generic**: the engine gained `onStepPending(ctx, tx)` alongside
  `onApproved/onRejected/onCancelled` and fires it only for the step that is pending **now** — at submit and after each
  approval that advances the instance. The engine imports nothing leave-specific; the leave handler turns the event into
  an APPROVAL_REQUIRED notification for the **snapshot** approver, so changing an employee's manager afterwards never
  redirects a pending notification.
- **Event mapping**: submit (still pending) → requester `LEAVE_SUBMITTED` + current approver `APPROVAL_REQUIRED`;
  intermediate approval → next approver only (no noise for the requester or the approver who just acted); final approval
  → requester `LEAVE_APPROVED`; rejection → requester `LEAVE_REJECTED`. An **auto-approved** submit sends only the final
  outcome. A requester cancelling their own request gets nothing (they did it), and the approver's earlier
  APPROVAL_REQUIRED stays as history — notifications are append-only, never edited or deleted (only `readAt` changes).
- **Privacy**: a notification says what happened and links to the record. Bodies and `data` never contain leave reasons,
  attachment references, approval comments, policy rules or ledger amounts; `data` holds only `leaveRequestId` and
  `workflowInstanceId` for deep-linking.
- **API** (all `requireAuth`): `GET /notifications` (status all|unread|read, type, pagination, newest first),
  `GET /notifications/latest` (bell dropdown), `GET /notifications/unread-count` (COUNT only),
  `POST /notifications/:id/read` (idempotent — the first read timestamp is kept), `POST /notifications/read-all`.
  Marking read is **not audited**: it is UX state, and the underlying business events already carry audit entries.
- **UI**: topbar bell with an unread badge (hidden at 0, `99+` from 100) and the ten newest items, plus `/notifications`
  with All/Unread tabs, mark-as-read and mark-all-as-read. Clicking a notification marks it read and deep-links into the
  Task 12 Leave screens (`/hrm/leave?request=<id>`, `/hrm/leave/approvals?request=<id>`); if the request has changed in
  the meantime the dialog simply shows its current state. Unread is conveyed by the word "Unread" as well as colour.
- **Polling, not sockets**: the unread count refetches every 60 s and on window focus, and leave mutations invalidate the
  notification queries. No websocket, SSE, Redis or queue was added. The query cache is cleared on login, logout and any
  401, so a previous user's notifications can never flash for the next one.
- **Deliveries** (`notification_deliveries`) are the outbox foundation: Task 13 writes exactly one `IN_APP` / `SENT` row
  per notification and no EMAIL/LINE/LARK/PUSH rows at all. The table is not exposed to the frontend and has no admin UI.

## Leave reporting (Task 14)

- `GET /leave/reports/overview` and `/leave/reports/options` need only `leave.view`: a report is an aggregate of the
  requests the caller can already read, and the data scope is applied **in SQL** (never as a post-filter). A filter can
  narrow a report but never widen it. Options are derived from the caller's own visible requests, so a manager needs no
  organization-admin permission to filter their report, and the DTO stays minimal (id/name only).
- **Semantics** (also stated on the page): requests are attributed to the period containing their **start date**, with
  the whole `units` value recorded at submit — a request crossing a month boundary counts in its start month, and
  history is never re-prorated against the current calendar. DRAFTs are excluded; PENDING, APPROVED, REJECTED and
  CANCELLED all count as submitted activity. Organization/department come from the request **snapshot**, so transfers
  don't rewrite history. Figures come from request snapshots — the ledger remains the source of truth for balances.
- Contents: summary KPIs, per-leave-type and per-department breakdowns (a request with no department snapshot is
  grouped as "Unassigned", never dropped), a zero-filled monthly trend and pending aging (0–2 / 3–7 / 8+ days by
  elapsed time since submission, counted in the database). `from`/`to` are required, `from ≤ to`, at most 24 months
  (`REPORT_RANGE_TOO_LARGE`).
- The Reports tab appears for `leave.view` with data scope TEAM or ALL (SELF users have My leave instead). Charts are
  dependency-free CSS bars with exact numbers beside them — no chart library was added.
- **Phase 2 closure review**: see [docs/phase-2-leave-review.md](docs/phase-2-leave-review.md) for the architecture,
  permission and data-scope model, lifecycle and locking guarantees, reporting semantics, test coverage, known
  limitations and production-readiness gaps.

## Running in production

Deployment contract (provider-neutral; the full runbook, checklist and gap list live in
[docs/production-readiness.md](docs/production-readiness.md)):

```bash
npm ci
npm run build       # packages/shared → apps/api (tsc → dist) → apps/web (vite → dist)
npm run db:deploy   # prisma migrate deploy — never migrate dev / db push / migrate reset
                    # the Prisma CLI reads its own environment, not ENV_FILE: DATABASE_URL="…" npm run db:deploy
npm run start       # node apps/api/dist/server.js
```

- **Order matters**: build → migrate → start, and a failed migration aborts the release. Production never runs
  `vite dev` or `tsx watch`.
- **HTTPS is mandatory.** The app does not terminate TLS; a reverse proxy or platform edge serves
  `apps/web/dist` and forwards `/api` to the Node process. Same-origin is the recommended setup (cookies without CORS);
  a split deployment builds the frontend with `VITE_API_BASE_URL` and lists that origin in `CORS_ORIGIN`.
- **Fail-fast configuration**: with `NODE_ENV=production` the process exits before listening if `DATABASE_URL`,
  `CORS_ORIGIN` or `PUBLIC_APP_URL` is missing, if an origin is `localhost`/`*`/non-https, if `SEED_DEMO_PASSWORD` is set, if a known
  placeholder password is used, or if `COOKIE_SECURE=false`. `ENV_FILE` can point at a config file outside the repo;
  real environment variables always win. There is no session signing secret — sessions are database-backed.
- **`TRUST_PROXY`** must equal the number of proxy hops (default `0`). It drives `req.ip` (rate limiting) and
  `req.protocol` (secure cookies), so a wrong value is a security setting, not a formality.
- **Probes**: `/api/v1/health` (app + database), `/health/live`, `/health/ready` (503 when the database is down) —
  unauthenticated, rate-limit exempt, and free of internal detail.
- **Rate limits**: failed logins per IP (`LOGIN_MAX_ATTEMPTS` / `LOGIN_WINDOW_MINUTES`) and a general
  `API_RATE_LIMIT_PER_MINUTE` ceiling (health exempt). Both are in-process, which is correct for the commercial model
  of **one deployment + one database per customer**; scaling out horizontally would need a shared store.
- **Logs** are structured JSON with a request id per line (`x-request-id` echoed back); passwords, tokens, cookies and
  request bodies are never logged. Unknown errors return a generic message plus the request id — never a stack trace.
- **Shutdown**: `SIGTERM`/`SIGINT` drain in-flight requests, disconnect Prisma and exit (10s force timeout);
  uncaught exceptions and unhandled rejections are logged fatally and trigger the same shutdown.
- **First install**: `BOOTSTRAP_ADMIN_EMAIL=… BOOTSTRAP_ADMIN_PASSWORD=… npm run bootstrap:admin` creates reference
  data and one administrator. The demo seed (`npm run db:seed:demo`) and `db:test:reset` both **refuse** to run with
  `NODE_ENV=production`.

## Backups and operations

Full procedures in [docs/operations-runbook.md](docs/operations-runbook.md).

```bash
BACKUP_DIR=/var/backups/hr npm run db:backup          # pg_dump --format=custom + SHA-256 manifest
npm run db:restore:verify -- <path/to/*.manifest.json> # restore into a throwaway DB and prove it is usable
npm run ops:check                                      # liveness + readiness, exit 0/1 (no credentials needed)
npm run ops:revoke-sessions                            # after a restore: force everyone to sign in again
```

- Credentials reach the PostgreSQL tools through libpq environment variables, never through command arguments (a
  connection string in `ps` output is a leak). Everything runs through `execFile` with an argument array — no shell.
- A dump is written as `.dump.partial` and renamed only after it completes and is checksummed, so a truncated file
  can never pass for a backup; a failure removes the partial, writes no manifest and exits non-zero.
- Dumps and manifests are `0600`: a dump contains every HR record. `BACKUP_DIR` is required in production and the
  backup folder is git-ignored.
- `db:restore:verify` checks the SHA-256 first, then restores into a generated `hr_restore_verify_<random>` database,
  verifies tables/migrations/row counts/referential sanity, runs `migrate deploy`, revokes the restored sessions and
  drops the temporary database. It refuses the development, test and source databases as targets.
- **Restoring onto a live database is not a command here** — it is a controlled procedure in the runbook, because one
  mistyped argument would destroy customer data. Session revocation after a restore is mandatory: a dump contains the
  sessions that were valid when it was taken.
- PostgreSQL client tools are expected on `PATH` (or `PG_BIN_DIR`); nothing is installed by these scripts. There is no
  scheduler, no off-host copy and no backup encryption in the application — those are deployment responsibilities and
  are listed as gaps.

## Customer onboarding (Excel import)

Administration → Onboarding loads a new customer's structure and people from one workbook
(`onboarding.manage`: HR Admin, System Admin). Full guide: [docs/customer-onboarding.md](docs/customer-onboarding.md).

- **Create-oriented**: every row means "create this". An existing code is an error, never a silent update; there is no
  bulk-edit mode and no undo. Sheets: Organizations → Departments → Jobs → Positions → Employees.
- **Preview writes nothing** (no records, no audit, no stored file) and reports problems per sheet/row/field with a
  downloadable error CSV. **Import re-uploads the same file**: the server hashes it (`ONBOARDING_FILE_CHANGED` if it
  differs), re-validates *inside* the transaction and then creates everything through the ordinary domain services —
  so uniqueness, assignment, manager-cycle, department-head rules, position/manager histories and per-entity audit are
  the same ones the UI produces, not a second implementation.
- **All-or-nothing**: one transaction; a single blocking error creates nothing. Concurrent imports serialise on a
  PostgreSQL advisory lock taken only by this operation, and re-submitting an already imported workbook replays its
  import record (the SHA-256 is the idempotency key) instead of duplicating entities.
- **Forward references work**: a department's parent, a position's department, an employee's manager or a department
  head may appear later in the same workbook.
- **Never creates login accounts** and never links an employee to a user by email — accounts are made in
  Administration → Users.
- **Bounded and private**: 10 MB / 5,000 rows, `.xlsx` only, formulas rejected, nothing written to disk, and the
  workbook is never stored. Import history keeps metadata only (counts, file hash, who, when). Logs never contain row
  content.

## Account recovery and privacy operations (Task 18)

Full guides: [docs/account-recovery.md](docs/account-recovery.md), [docs/privacy-operations.md](docs/privacy-operations.md).

- **Change your own password** — user menu → Account security (`POST /account/change-password`). The current password
  must be proven; on success **every** session is revoked, including the one making the change.
- **Admin-issued one-time link** — Administration → Users → key icon (`POST /admin/users/:userId/password-reset`,
  `account.manage_recovery`). 256-bit token, **only its SHA-256 hash stored**, shown once, at most one live link per
  account, default 60 minutes. Built from `PUBLIC_APP_URL`, never the request `Host` header. There is no endpoint for
  an administrator to set a password: the old `POST /users/:id/reset-password` was **removed**, because an
  administrator who can set a password can impersonate the user.
- **Consuming a link** — public `/reset-password?token=…` page (token moved to memory, URL replaced immediately) →
  `POST /account/reset-password`, rate limited 10/15 min per IP. Unknown, expired, used and deactivated all return one
  generic error (no account enumeration). The token row is locked `FOR UPDATE`, so concurrent attempts cannot both
  succeed; success revokes all sessions and all other reset tokens.
- **Sessions** — `GET /account/sessions` (own sessions, no token hashes), `POST /account/sessions/revoke-others`,
  and `POST /admin/users/:userId/revoke-sessions` for a lost device. Passwords are unchanged by a revoke.
- **Privacy** — Administration → Privacy. Request register (`privacy.manage_requests`): types ACCESS / EXPORT /
  CORRECTION / DELETION / RESTRICTION / OTHER, status OPEN → IN_PROGRESS → COMPLETED | REJECTED, terminal states are
  never reopened, **no delete endpoint**, notes only on the detail view and never in the audit. Personal-data export
  (`privacy.export_data`): one `RepeatableRead` snapshot, JSON attachment with `no-store`, nothing stored server-side,
  credentials and other people's data excluded and the file lists what it leaves out. Audited as an event with counts.
- **Deletion is never automatic.** A DELETION request is recorded for policy review; retention and legal basis are the
  customer's decision. This is a privacy operations foundation, not a compliance certification.
- **Logs**: query strings are stripped before logging (request logger and error handler), so a token in a URL cannot
  reach a log file. `npm run ops:cleanup-reset-tokens -- --days 30` removes spent tokens.

## Time & attendance (Task 20)

Full guide: [docs/attendance.md](docs/attendance.md). HRM → Time & attendance.

- **Shifts** (`attendance.manage`): start, end, unpaid break, late/early grace. `isOvernight` is derived from the
  times; a 20:00 → 05:00 shift belongs to the day it **started**.
- **Schedules** (`attendance.schedule_manage`): one row per employee per date (`WORK` + shift / `OFF` / `HOLIDAY`),
  assigned over a range and filtered by weekday. The **work calendar from Leave is reused** — weekends and holidays
  come from the organization's default calendar. No schedule row means nothing is expected, so it can never be an
  absence. Approved leave is never written here; it is read when the day is calculated.
- **Clocking** (`attendance.clock`): `POST /attendance/clock-in` / `clock-out`. The employee comes from the session,
  events are **append-only**, and each clock takes the employee row lock, so two taps produce one event
  (`ALREADY_CLOCKED_IN` / `NOT_CLOCKED_IN` / `ALREADY_CLOCKED_OUT`). A clock-out closes the open clock-in, which is
  what makes an overnight shift one day.
- **The calculated day** is a cache with a unique key (`employeeId` + `attendanceDate`), produced by one pure function
  in `@hr/shared`: `NOT_SCHEDULED | SCHEDULED | NORMAL | LATE | EARLY_LEAVE | LATE_AND_EARLY | INCOMPLETE | ABSENT |
  ON_LEAVE`, plus worked / late / early / extra minutes. Grace decides the status; the minutes recorded are the real
  ones. **Absence is never predicted** — a day becomes ABSENT only after its shift has ended (hence *Recalculate*).
- **Leave integration**: full-day leave is `ON_LEAVE`, half-day leave narrows the expected window to the other half
  (and halves the break) without excusing it. Attendance never writes to Leave.
- **Corrections**: an employee requests the times that should have been recorded; approval runs through the shared
  **workflow engine** (definition code `ATTENDANCE_CORRECTION`) and the generic action endpoint. Approving recalculates
  the day from the requested times and **never rewrites a raw clock event**; rejecting leaves the day as it was.
- **Not in this release**: overtime calculation or payment (`extraMinutes` is informational), GPS/geofence, biometric
  or terminal integration, multiple punches and break tracking, rotating rosters, payroll posting.

## Overtime (Task 21)

Full guide: [docs/overtime.md](docs/overtime.md). HRM → Time & attendance → Overtime.

- **No money is calculated.** Overtime produces approved **minutes** plus a **multiplier snapshot**; payroll (Task 22)
  is what turns them into an amount. Minutes are the unit everywhere — 150 is stored as `150`, shown as `2h 30m`, and
  never rounded.
- **Eligibility** is one pure function: `min(time outside the shift, worked − required)` on a workday, and every paid
  minute on an off day or holiday. The cap is what stops a late arrival that is made up at the end of the day from
  becoming overtime — 09:00→18:00 on an 08:00–17:00 shift is **zero** eligible minutes, 08:00→19:00 is 120.
- **The client sends a date, minutes and a reason.** Employee, day type, policy, multiplier and eligible minutes are
  all derived server-side, and snapshotted onto the claim at submit.
- **Policy** (`ot.manage_policy`): per organization, non-overlapping periods, multipliers per day type (ratios the
  customer configures — nothing assumes 1.5/2/3), optional minimum and daily maximum, and the approval workflow.
  Once a claim has snapshotted a policy its rates are frozen (`OT_POLICY_IN_USE`).
- **Approval** runs through the shared workflow engine (`module = attendance`, `entityType = OVERTIME_REQUEST`) — there
  is no `ot.approve` and no overtime-specific approval endpoint. Final approval **revalidates against the current
  attendance** and fails with `OT_ATTENDANCE_CHANGED_REVIEW_REQUIRED` rather than approving unsupported overtime.
- **Approved overtime is protected**: an attendance correction that would leave the day supporting less than what was
  approved is refused (`ATTENDANCE_CORRECTION_CONFLICTS_WITH_APPROVED_OT`) and nothing moves.
- **Payroll handoff**: `overtimeService.getApprovedOvertimeForPayroll({ employeeId, from, to })` returns requestId,
  date, approved minutes, day type, multiplier and policy — nothing else.

## Payroll (Task 22)

Full guide: [docs/payroll.md](docs/payroll.md). HRM → Payroll.

- **No statutory amounts are calculated.** No withholding tax, no social security, no provident fund, no bank file, no
  GL posting — absent, not approximated, and stated on every payslip. Nothing this module produces may be filed with
  an authority as if it had been.
- **Money is exact**: `NUMERIC` in the database, `Prisma.Decimal` in the service, decimal **strings** on the wire.
  Amounts 2 places, derived rates 6, half-up, rounded once at the line. 120 overtime minutes at ×1.5 on a 30,000
  salary is `375.00`, not the `374.40` a prematurely rounded minute rate would pay.
- **Nothing is hardcoded**: the monthly divisor days and hours per day come from the payroll policy, so a customer who
  divides by 26 changes one field and every rate follows.
- **A salary is history, not a field.** A raise closes the old compensation record and opens a new one; a record a run
  has used can never be re-priced. A salary change inside a period is refused rather than prorated by an unagreed rule.
- **Inputs come from the modules that own them**: approved overtime from Task 21 (minutes and the multiplier
  snapshotted at approval), unpaid leave from Task 12, absence and lateness from Task 20. A day covered by approved
  leave is never also charged as an absence.
- **Stale runs cannot be approved.** Every source is fingerprinted at calculation; if anything moved since, submission
  fails with `PAYROLL_INPUT_CHANGED` until somebody recalculates. A run waiting for its approver is frozen.
- **Approval** is the shared workflow engine (`module = payroll`, `entityType = PAYROLL_RUN`) — no payroll-specific
  approval endpoint, no self-approval. Closing is final: no recalculation, no adjustment, **no reopen**.
- **Confidentiality**: `payroll.view_own` shows your own payslips for closed runs only; everything else needs a
  payroll permission. A manager's data scope grants nothing, and EXECUTIVE has no payroll permission at all.

## Pilot release

- [docs/releases/pilot-rc.md](docs/releases/pilot-rc.md) — what is in the pilot release candidate, the commercial gap
  matrix, test evidence, dependency advisories and the version convention.
- [docs/pilot-checklist.md](docs/pilot-checklist.md) — the operator's checklist from "nothing installed" to go-live,
  daily support answers, and pilot offboarding.

## Security notes

- Passwords: bcrypt (cost 12), minimum 12 characters from one shared policy (`passwordField`) used by user creation, own change, reset links and `bootstrap:admin`. Unknown email and wrong password return the same `INVALID_CREDENTIALS` error, with a constant-time dummy compare.
- Permissions are enforced in the API (`requirePermission`) — the UI only hides what the user cannot do.
- Audit logs never contain passwords, hashes, tokens or cookies (`services/audit/redact.ts` runs before every write).
- Seed admin credentials come from `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` and are skipped in production.
- The frontend keeps the current user in memory only; nothing auth-related is stored in localStorage/sessionStorage.
- Password reset tokens follow the session model: 256-bit random, only the SHA-256 hash stored, shown once, one-time use,
  revoked on any password change. Nobody — including a System Admin — can read or set another person's password.
