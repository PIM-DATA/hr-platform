# Operations runbook

For whoever keeps a customer installation running. Companion to `docs/production-readiness.md` (deployment) and
`docs/phase-2-leave-review.md` (application behaviour). No credentials appear here — only variable names.

Commercial model: **one customer = one deployment = one PostgreSQL database.** Everything below applies per customer.

---

## 1. Daily health

| Check | Command / endpoint | Healthy |
|---|---|---|
| Process alive | `GET /api/v1/health/live` | 200 |
| Ready to serve | `GET /api/v1/health/ready` | 200 (503 = database unreachable) |
| Both, scriptable | `npm run ops:check` | exit code 0 |

`ops:check` needs no credentials and prints one JSON line (`ops_check_healthy` / `ops_check_unhealthy`); point it at
another host with `OPS_CHECK_URL`. Use it after every deploy and from whatever monitor you adopt.

## 2. Reading the logs

Production logs are JSON lines. Every request carries `requestId`, also returned as the `x-request-id` header, so a
user report ("it failed at 14:03") maps to exact lines:

```bash
grep '"requestId":"<id>"' app.log
grep '"level":50' app.log        # errors
grep '"event":"' app.log         # operational events (below)
```

Stable event names: `app_started`, `app_shutdown`, `app_fatal_error`, `db_readiness_failed`, `backup_started`,
`backup_completed`, `backup_failed`, `restore_verify_started`, `restore_verify_completed`, `restore_verify_failed`,
`sessions_revoked`, `ops_check_healthy`, `ops_check_unhealthy`.

Logs never contain passwords, tokens, cookies, authorization headers, connection strings or request bodies — so a leave
reason or attachment reference never reaches a log file. An inbound `x-request-id` is only echoed when it is short and
printable; anything else is replaced by a generated id.

## 3. Detecting trouble

| Symptom | How it shows up | First response |
|---|---|---|
| API down | `ops:check` non-zero; `/health/live` unreachable | check the process/container is running, then §5 |
| Database unavailable | `/health/ready` 503; `db_readiness_failed` in logs | check PostgreSQL and connectivity; the app recovers on its own once the database returns |
| Repeated 5xx | `"level":50` lines with distinct `requestId`s | take one `requestId`, read its error line; check database health and recent deploys |
| Restart loop | repeated `app_started` without `app_shutdown`; `app_fatal_error` | read the fatal line; a bad configuration exits **before** listening with a named reason |
| Backup failed | `backup_failed`, non-zero exit from `db:backup` | §4; check disk space and that the PostgreSQL client tools exist |
| Disk filling | backup directory growth; write errors | move or delete old backups per the retention policy you set (§4) |

## 4. Backups

```bash
BACKUP_DIR=/var/backups/hr npm run db:backup
```

- Uses `pg_dump --format=custom` (compressed, restorable with `pg_restore`). The database stays online; the dump is a
  consistent snapshot.
- Credentials are passed to `pg_dump` through libpq environment variables — never on the command line, where `ps`
  would expose them.
- Writes `hr-enterprise-YYYYMMDD-HHmmss.dump` plus a `.manifest.json` holding format version, timestamps, PostgreSQL
  and application versions, database name, size, **SHA-256** and the latest applied migration. No credentials.
- The dump is written as `.dump.partial` and renamed only after it completed and was checksummed, so a truncated file
  can never look like a usable backup. A failure deletes the partial, writes no manifest and exits non-zero.
- Files are created `0600` (owner only): a dump contains every HR record in the system.
- `BACKUP_DIR` is **required in production** (development falls back to a git-ignored folder in the repo).

**Not yet solved — you must arrange these:**

- **Off-host copy.** A backup on the same machine does not survive losing that machine. Copy it to separate storage.
- **Encryption.** `.dump` files are unencrypted. Storage must provide encryption at rest and transfers must use
  encrypted transport. Do not invent your own encryption.
- **Schedule and retention.** There is no scheduler in the application, by design. Have your platform's scheduler run
  `npm run db:backup` and alert on a non-zero exit. Frequency and how long to keep backups are policy decisions per
  customer contract — nothing is auto-deleted.

## 5. Restarting safely

1. `npm run db:backup` first if the restart follows a suspected data problem.
2. Send `SIGTERM` (any platform stop does this): in-flight requests finish, Prisma disconnects, the process exits
   (10s force timeout).
3. Start again; confirm `app_started` shows the expected environment and version.
4. `npm run ops:check` → exit 0, then sign in once and load the dashboard.

## 6. Verifying a backup (do this regularly)

```bash
npm run db:restore:verify -- /var/backups/hr/hr-enterprise-20260923-133302.manifest.json
```

Checksum → create a throwaway `hr_restore_verify_<random>` database → `pg_restore` → verify tables, migration history,
row counts and referential sanity → `prisma migrate deploy` (proving the restored copy can move to the current
version) → revoke restored sessions → drop the temporary database. It refuses to target the development, test or
source database, and a checksum mismatch stops it before anything is restored. Exit code 0 means recoverable.

A backup you have never restored is a hope, not a backup. Verify after configuration changes and on a schedule.

## 7. Disaster recovery

> Restoring **onto** a live database is deliberately not a command in this repository — a single mistyped argument
> would destroy customer data. It is this controlled procedure instead.

1. **Stop the application** (stop writes; keep the process down for the whole restore).
2. **Preserve the damaged database** if it still exists — rename it or take a dump of it. It is evidence and may hold
   data newer than the backup.
3. **Provision an empty PostgreSQL database** for the restore target.
4. **Verify the backup first**: `npm run db:restore:verify -- <manifest>` (never restore an unverified file).
5. **Restore** into the empty target with the PostgreSQL tools directly, with credentials in the environment:
   `PGHOST=… PGUSER=… PGPASSWORD=… pg_restore --no-owner --no-privileges --exit-on-error --dbname <target> <dump>`
6. **`npm run db:deploy`** against the restored database (no-op if the backup matches the current version).
7. **Check readiness**: point the application at the restored database and confirm `/health/ready` returns 200.
8. **Revoke all sessions**: `npm run ops:revoke-sessions` — a dump contains the sessions that were valid when it was
   taken, so without this, old logins come back to life. It deletes session rows only; accounts and passwords are
   untouched. Everyone signs in again.
9. **Start the application.**
10. **Smoke test**: sign in, load the dashboard, open a leave request, check balances and notifications.
11. **Inspect logs and the audit log** for the recovery window; tell users which period may have been lost.
12. **Resume service**, then take a fresh backup immediately.

## 8. Alerting (categories, not vendors)

Alert on: readiness failing repeatedly; the process restarting repeatedly; sustained 5xx; `db:backup` exiting
non-zero; no successful backup within the window your policy defines; disk usage approaching capacity; database
connectivity failures. No monitoring vendor is integrated yet — the JSON logs, exit codes and probes are what any
agent would consume.

## 9. RPO and RTO

Neither is a promise this system can make on its own:

- **RPO** (how much data a failure may lose) = your backup frequency. With daily backups and no WAL archiving, the
  worst case is a day of work. Point-in-time recovery would need WAL archiving, which is not configured.
- **RTO** (how long recovery takes) = provisioning + restore + verification in *your* environment, driven by database
  size and hardware.

Measured locally during the Task 16 drill (development dataset, Postgres.app on a laptop): backup **131 ms** for a
**116 KB** dump; full restore verification **1.2 s** (restore + integrity checks + migrate deploy + session
revocation). These are development measurements on a tiny dataset — they are **not** production figures and must not
be quoted as an SLA. Re-measure with real data volumes before agreeing RPO/RTO with a customer.

## 10. Secrets and rotation

There is **no application signing secret to rotate**: sessions are database rows, the cookie carries an opaque random
token and only its SHA-256 hash is stored, CSRF tokens are per-session random values, and password reset tokens are
hashed the same way. Nothing in this system is encrypted or signed with a long-lived key, so there is no key ceremony
and no key material to lose.

What does exist:

| Secret | Where it lives | Rotating it |
|---|---|---|
| Database credential (`DATABASE_URL`) | the platform's secret store / `ENV_FILE` | create the new role or password in PostgreSQL, grant it the same rights, update `DATABASE_URL`, restart the API (§5), confirm `/health/ready`, then retire the old credential. A short read-only window is normal; nothing is cached in the application. |
| Bootstrap administrator password | used once, by `npm run bootstrap:admin` | not rotated — the person signs in and changes their own password, which revokes every session. The environment variable is not needed again. |
| Backup files | `BACKUP_DIR` (mode `0600`) | not a secret to rotate, but they contain every HR record: keep them where only the operator can read them, and off this host. |

Revoking access in a hurry: `npm run ops:revoke-sessions` signs everyone out; deactivating a user in
Administration → Users stops that person signing in at all; `POST /admin/users/:id/revoke-sessions` does it for one
person. Changing the database credential does not sign anybody out — sessions live in the database itself.

If an external provider is ever integrated (email, SMS, SSO), its credential belongs in this table with the same
treatment. Do not invent a rotation procedure for a key the system does not have.

## 11. Routine cleanup

| Job | Command | When |
|---|---|---|
| Spent password reset tokens | `npm run ops:cleanup-reset-tokens -- --days 30` | monthly, or on a scheduler |

Removes only expired, used and revoked tokens older than the given number of days; live links are never touched.
It prints one JSON line (`reset_tokens_cleaned`) with the count — no token values, ever. Nothing else in the system
deletes business data on a schedule: retention policy is the customer's decision
(see `docs/privacy-operations.md`).

## 12. Operational safety rules

- `prisma migrate reset`, `db:test:reset` and the demo seed **never** run against production; the scripts refuse
  (`NODE_ENV=production`) but the habit matters more than the guard.
- Schema rollback is a new forward migration, never a reset.
- There is no backup/restore HTTP endpoint and no admin UI for it: these are privileged CLI operations, which keeps the
  attack surface out of the web application entirely.
- Backup operations are logged operationally, not in the application audit log — they often run while the application
  is unavailable, and infrastructure actions do not belong in a business audit trail.


## Document storage (Task 30)

The document center keeps file bytes **outside PostgreSQL**, in `DOCUMENT_STORAGE_DIR` (local filesystem adapter).
From the moment it is used, the database backup described above is **not a complete backup**:

- Back up `DOCUMENT_STORAGE_DIR` on the same schedule as the database, immediately after each dump, and keep the
  pair together (same backup run, same retention).
- Restore the pair together. A database restored without the matching storage produces documents whose objects
  are missing (downloads answer `DOCUMENT_OBJECT_MISSING`); storage restored without the database produces orphaned
  files. Neither is silently corrected.
- `npm run ops:check` reports `copilot: disabled | configured` from configuration only (the AI provider is never called by readiness; a provider outage surfaces as 503 `COPILOT_UNAVAILABLE` on the copilot endpoints and nowhere else).
- `npm run ops:check` reports `documentStorage: ok | disabled | unavailable` from the readiness probe; `unavailable`
  (root missing or not writable) makes the API not ready. Production refuses to start with the document center
  enabled and no `DOCUMENT_STORAGE_DIR`, or with a temporary path.
- Files are stored as uploaded. No malware scanning is performed by the platform; add a scanner in the deployment
  if policy requires one.
