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
| 9 Leave master data (calendar, holidays, types, policies) | ⏳ |
| 10 Leave entitlement + ledger | ⏳ |
| 10.5 PostgreSQL migration / integration validation | ⏳ required before 11 |
| 11 Leave request + workflow + reservation concurrency | ⏳ |
| 12 Approval inbox + Leave UI · 13 Notification (in-app) · 14 Leave dashboard + review | ⏳ |
| Attendance | Phase 2B |

## Stack

| Layer | Technology |
|---|---|
| Frontend | React 19, Vite, TypeScript, Tailwind CSS v4, React Router, TanStack Query, react-hook-form |
| Backend | Node.js, Express 5, TypeScript, Zod, Pino |
| Database | Prisma 6 — SQLite for local development, PostgreSQL for real data |
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
cp apps/api/.env.example apps/api/.env      # then set SEED_ADMIN_PASSWORD (and SEED_DEMO_PASSWORD for demo role accounts)
npm run db:migrate                          # creates apps/api/prisma/dev.db and runs the seed
npm run dev                                 # api → http://localhost:4000, web → http://localhost:5173
```

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

- `apps/api/tests/*.test.ts` are integration tests over the real Express app + Prisma + a throwaway SQLite file.
  Files run **sequentially in separate processes** (`fileParallelism: false`); every file starts with `resetDatabase()`
  (all tables wiped in FK order, roles re-seeded), so files never depend on execution order. Unit tests without a DB could run in parallel if ever needed.
- Each file opens **one HTTP server bound to `127.0.0.1`** via `createTestServer()` instead of `request(app)`. supertest's
  per-request `app.listen(0)` binds `[::]:P` while connecting to `127.0.0.1:P`; on macOS that bind succeeds even when another
  process owns `127.0.0.1:P`, so requests occasionally reached a foreign process (garbage or wrong responses ≈ a few % of full runs).
- SQLite test URL uses `connection_limit=1` (single-writer database). `TEST_LOG_LEVEL=error|debug` prints server-side logs (JSON) into vitest output.
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

## Moving to PostgreSQL

1. `apps/api/prisma/schema.prisma`: `provider = "postgresql"`.
2. `DATABASE_URL="postgresql://user:password@host:5432/hr_platform?schema=public"`.
3. Delete `apps/api/prisma/migrations/` (SQLite SQL is not portable) and run `npm run db:migrate -- --name init`.

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
| `DATABASE_URL` | SQLite `file:./dev.db?connection_limit=1` for development; PostgreSQL URL for real data |
| `CORS_ORIGIN` | allowed browser origin (also used by the CSRF origin check) |
| `SESSION_TTL_HOURS`, `COOKIE_SECURE` | session lifetime; `Secure` cookies are forced on in production |
| `LOGIN_MAX_ATTEMPTS`, `LOGIN_WINDOW_MINUTES` | login rate limit |
| `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD` | first System Admin (seed, dev only) |
| `SEED_DEMO_PASSWORD` | optional demo accounts per role (seed, dev only) |
| `TEST_LOG_LEVEL` | tests only: set `error` to print server-side 5xx causes |

## Known limitations / backlog

- SQLite is for development only; move to PostgreSQL before real data (see above). Login rate limiter is in-memory (single instance).
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

## Security notes

- Passwords: bcrypt (cost 12). Unknown email and wrong password return the same `INVALID_CREDENTIALS` error, with a constant-time dummy compare.
- Permissions are enforced in the API (`requirePermission`) — the UI only hides what the user cannot do.
- Audit logs never contain passwords, hashes, tokens or cookies (`services/audit/redact.ts` runs before every write).
- Seed admin credentials come from `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` and are skipped in production.
- The frontend keeps the current user in memory only; nothing auth-related is stored in localStorage/sessionStorage.
