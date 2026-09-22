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
| 12 Approval inbox + Leave UI · 13 Notification (in-app) · 14 Leave dashboard + review | ⏳ |
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
| `TEST_LOG_LEVEL` | tests only: set `error` to print server-side 5xx causes |

## Known limitations / backlog

- Login rate limiter is in-memory (single instance).
- Audit: actor email is the current email (identity = `userId`); no retention/archive/export.
- No forgot-password / self-service password change; admins reset passwords.
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

## Security notes

- Passwords: bcrypt (cost 12). Unknown email and wrong password return the same `INVALID_CREDENTIALS` error, with a constant-time dummy compare.
- Permissions are enforced in the API (`requirePermission`) — the UI only hides what the user cannot do.
- Audit logs never contain passwords, hashes, tokens or cookies (`services/audit/redact.ts` runs before every write).
- Seed admin credentials come from `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` and are skipped in production.
- The frontend keeps the current user in memory only; nothing auth-related is stored in localStorage/sessionStorage.
