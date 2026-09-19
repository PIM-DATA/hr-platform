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

## Security notes

- Sessions are DB-backed; only a SHA-256 hash of the cookie token is stored. Cookies are `httpOnly`, `sameSite`, and `secure` in production.
- Permissions are enforced in the API (`requirePermission`) — the UI only hides what the user cannot do.
- Audit logs never contain passwords, hashes, tokens or cookies (redacted before write).
- Seed admin credentials come from `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` and are skipped in production.
