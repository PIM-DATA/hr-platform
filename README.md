# HR Enterprise Platform

One employee data · One organization structure · One permission system · One workflow · One platform.

Phase 1 (Foundation): Authentication, Users, RBAC, Employee Master, Organization, Audit Log, Dashboard.
Later phases add HRM / HRD / HROD / Analytics / AI Copilot on top of the same core.

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
cp apps/api/.env.example apps/api/.env      # then set SEED_ADMIN_PASSWORD
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
| `npm test` | API tests against a throwaway `apps/api/prisma/test.db` |
| `npm run typecheck` | `tsc --noEmit` in every workspace |

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

## Security notes

- Passwords: bcrypt (cost 12). Unknown email and wrong password return the same `INVALID_CREDENTIALS` error, with a constant-time dummy compare.
- Permissions are enforced in the API (`requirePermission`) — the UI only hides what the user cannot do.
- Audit logs never contain passwords, hashes, tokens or cookies (`services/audit/redact.ts` runs before every write).
- Seed admin credentials come from `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` and are skipped in production.
- The frontend keeps the current user in memory only; nothing auth-related is stored in localStorage/sessionStorage.
