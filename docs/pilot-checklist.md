# Pilot customer checklist

Everything an operator does to take one customer from "nothing installed" to "using the system", and what to do while
it runs. One customer = one deployment = one database; nothing here is shared between customers.

Companion documents: `docs/production-readiness.md` (configuration and security model), `docs/operations-runbook.md`
(daily operations), `docs/customer-onboarding.md` (the Excel import), `docs/account-recovery.md`,
`docs/privacy-operations.md`, `docs/releases/pilot-rc.md` (what is and is not in this release).

---

## 1. Customer prerequisites (agree before installing)

- [ ] Customer identifier (short code) — used for the host name, the database name and the backup folder.
- [ ] Who the first System Administrator is (a named person, with an email address).
- [ ] Who receives privacy requests and who may export personal data (`privacy.*` permissions).
- [ ] Working days and public holidays for the first year.
- [ ] Leave types, entitlement per type, and who approves (direct manager / department head).
- [ ] A secure channel for handing over one-time password reset links (the system sends no email).
- [ ] Where backups will be kept **off this host**, and who checks them.
- [ ] Data-protection paperwork is the customer's: privacy notice, legal basis, retention schedule. The system provides
      tooling, not compliance (`docs/privacy-operations.md`).

## 2. Infrastructure

- [ ] Linux host (or VM) with Node.js 20+ and the PostgreSQL **client tools** (`pg_dump`, `pg_restore`, `psql`) on
      `PATH`, or `PG_BIN_DIR` pointing at them.
- [ ] PostgreSQL 18 (or the version the customer standardises on), reachable from the host, with an **empty** database
      and a dedicated role for this customer.
- [ ] HTTPS terminated by a reverse proxy or platform; HTTP redirected to HTTPS.
- [ ] A domain name for the application (`https://hr.<customer>.example`).
- [ ] Backup directory on the host (`BACKUP_DIR`), readable only by the service account.
- [ ] Off-host destination for backup copies — **required before real data goes in** (see §7).

## 3. Installation

```bash
npm ci                 # from the release checkout, using the committed lockfile
npm run build          # shared → api (dist) → web (dist)
DATABASE_URL="…" npm run db:deploy      # the Prisma CLI does not read ENV_FILE
BOOTSTRAP_ADMIN_EMAIL=… BOOTSTRAP_ADMIN_PASSWORD=… npm run bootstrap:admin
npm run start          # node apps/api/dist/server.js, with ENV_FILE pointing at the customer's config
```

- [ ] Production configuration in place (`docs/production-readiness.md` → Environment inventory). The process refuses
      to start if anything required is missing or unsafe, which is the intended safety net.
- [ ] `npm run ops:check` exits 0 and reports the expected `version`.
- [ ] The static frontend (`apps/web/dist`) is served by the proxy with the Content-Security-Policy from
      `docs/production-readiness.md` §7.
- [ ] Sign in as the bootstrap administrator and change that password immediately (it was typed into a shell).
- [ ] **Never run the demo seed** (`npm run db:seed` / `db:seed:demo`). It is a development convenience and refuses to
      run in production; production data comes from the customer's own import.

## 4. Customer onboarding

- [ ] Administration → Onboarding → **Download template** (always the server's template, never an old copy).
- [ ] Fill Organizations → Departments → Jobs → Positions → Employees (`docs/customer-onboarding.md`).
- [ ] **Preview** and clear every error. Preview writes nothing.
- [ ] **Import** the same file; check the counts against the customer's own headcount.
- [ ] Spot-check a few employees: department, position, manager.
- [ ] Create login accounts in Administration → Users, one per person who needs one, linked to their employee record,
      with the right role. There is no bulk provisioning yet (see `docs/releases/pilot-rc.md`) — for a pilot of a few
      dozen accounts this is deliberate manual work; budget time for it.

## 5. Configuration

- [ ] Work calendar with the customer's working days; add the year's public holidays; set it as the organization default.
- [ ] Workflow definition (one step, direct manager, is the common case) — created **and activated**.
- [ ] Leave types, then a policy per type: entitlement, half-day rules, notice, attachment requirement (see the
      attachment note in `docs/releases/pilot-rc.md`), the workflow it uses — created **and activated**.
- [ ] Entitlements generated for every employee who may take leave, for the current period. This is one action per
      employee/type today; do it as part of onboarding, not on the first day someone needs leave.
- [ ] Check one employee's balance screen shows what the customer expects.

## 6. Security

- [ ] Roles reviewed: who is System Admin, HR Admin, Manager, Employee. Nobody gets System Admin "just in case".
- [ ] `account.manage_recovery` and `privacy.*` are with the people the customer named in §1.
- [ ] Session cookie shows `Secure`, `HttpOnly`, `SameSite=Lax` in the browser.
- [ ] `PUBLIC_APP_URL` is the real application URL — reset links are built from it.
- [ ] The password policy is understood: 12 characters minimum, no forced rotation, recovery is admin-assisted.
- [ ] Audit log is readable by the people who will answer "who did this?" and by nobody else.

## 7. Backup — go-live gate

**Do not put real employee data in until all four are true.**

- [ ] `npm run ops:backup` exits 0 and writes a COMPLETE recovery set (database **and** documents, checksummed, copied
      off-host and confirmed) — docs/backup-restore.md. (`db:backup` alone is database-only and not enough.)
- [ ] `npm run ops:restore -- <set> --verify-only` succeeds (restores database + documents into throwaway targets,
      revokes sessions and reset tokens, verifies, removes them; it never touches the live system).
- [ ] The operator knows where backups are, how often they run, and how long they are kept.
- [ ] **OFF-HOST BACKUP DESTINATION REQUIRED** — a copy on another machine or object storage, encrypted at rest by
      whatever holds it. A backup on the same disk as the database survives nothing that matters.

## 8. Smoke tests (on the real instance, before go-live)

- [ ] Administrator signs in; dashboard loads.
- [ ] Employee signs in; submits a leave request; sees it pending with the balance reserved.
- [ ] Manager gets the in-app notification, opens the approval inbox, approves.
- [ ] Employee sees the approval notification; the balance moves from reserved to used.
- [ ] HR opens Leave → Reports and sees the request.
- [ ] Administrator issues a password reset link for a test account; it works once and is refused the second time.
- [ ] Privacy → Data export produces a file for one employee; open it and read it.
- [ ] `npm run ops:check` exits 0; the logs show JSON lines with request ids and no secrets.

## 9. Go-live

- [ ] Backup taken immediately before go-live, and verified.
- [ ] The customer knows: notifications are **in-app only** — approvers must open the system (or the bell) to see work.
- [ ] The customer knows how a person who forgets their password gets back in (§10, "User forgot password").
- [ ] Support contact and working hours agreed, on both sides.

## 10. Daily operations and support answers

`docs/operations-runbook.md` has the detail. The questions that actually get asked:

| Question | Where the operator looks |
|---|---|
| "A user cannot sign in" | Administration → Users: is the account active, is it the right email? Audit log → `LOGIN_FAILED` for the reason. Rate limited? wait out `LOGIN_WINDOW_MINUTES`. Then issue a reset link. |
| "Who approved this leave request?" | The request's detail dialog shows each step and who acted; Audit log → `WORKFLOW_APPROVE` with actor and timestamp. |
| "Why did this balance change?" | Leave → entitlement detail → **ledger**: every GRANT / RESERVE / USE / RELEASE / ADJUST entry with its reference. The cached summary is recomputed from the ledger in the same transaction. |
| "Where did the import fail?" | Onboarding preview reports sheet/row/field; the error CSV is downloadable. A failed import creates nothing. |
| "Is the database healthy?" | `npm run ops:check`; `/api/v1/health/ready` reports the database; PostgreSQL's own logs for anything deeper. |
| "Can we still restore the latest backup?" | `npm run ops:restore -- <set> --verify-only` — run it on a schedule, not only after an incident; `ops:monitor-check` tells you when the last verified backup is too old. |
| "A user forgot their password" | Administration → Users → key icon → generate a one-time link → hand it over through the agreed secure channel. Nobody can read or set a password (`docs/account-recovery.md`). |
| "An employee asks for their data" | Administration → Privacy → record the request, then Data export for that employee (`docs/privacy-operations.md`). |
| "Someone lost a laptop" | Administration → Users → sign-out icon (all sessions), then issue a reset link if the password may be known. |

## 11. Incidents

- [ ] Named contact on the customer side and on the operator side, with a channel that is not this system.
- [ ] Runbook §3 (detecting trouble) and §7 (disaster recovery) read **before** they are needed.
- [ ] Data-affecting incident: take a backup first, then investigate.
- [ ] A restore signs everyone out (`npm run ops:revoke-sessions` is part of the procedure) — tell the customer.

## 12. Pilot exit / offboarding

A pilot can end with the customer continuing, or not. Either way nothing is deleted automatically, and nothing is
deleted without the customer asking.

- [ ] Stop new access: deactivate accounts in Administration → Users, or stop the application.
- [ ] Revoke sessions: `npm run ops:revoke-sessions`.
- [ ] If the contract requires a handover, produce it: a per-employee export (Privacy → Data export) or a database
      dump, transferred over an agreed secure channel.
- [ ] Take a final backup and record where it is and who holds it.
- [ ] Agree, in writing, what happens to the data: retained for a stated period, or destroyed on a stated date, by
      whom. The system will not decide this and does not erase anything on its own.
- [ ] On the agreed date: decommission the application, drop the database, and destroy the backup copies — including
      the off-host ones. Record that it was done.
