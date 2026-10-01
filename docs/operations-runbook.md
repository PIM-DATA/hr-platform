# Operations runbook

For whoever keeps a customer installation running. Companion to `docs/production-readiness.md` (deployment) and
`docs/phase-2-leave-review.md` (application behaviour). No credentials appear here — only variable names.

Commercial model: **one customer = one deployment = one PostgreSQL database.** Everything below applies per customer.

---

## 1. Daily health

| Check | Command / endpoint | Healthy |
|---|---|---|
| Process alive | `GET /api/v1/health/live` | 200 |
| Ready to serve | `GET /api/v1/health/ready` | 200 (503 = database unreachable or document storage unusable — see `documentStorageReason`) |
| Everything the host can see | `npm run ops:monitor-check` | exit 0 (API ready, document storage + free space, fresh verified backup, backup free space) |
| Last backup | `cat $BACKUP_DIR/last-success.json` | `completedAt` within your schedule |

`ops:monitor-check` should already run every 5 minutes from a scheduler that alerts on a non-zero exit
([operations-monitoring.md](operations-monitoring.md)). `ops:check` (probes only) remains for deploy pipelines.

## 2. Reading the logs

Production logs are JSON lines. Every request carries `requestId`, also returned as the `x-request-id` header, so a
user report ("it failed at 14:03") maps to exact lines:

```bash
grep '"requestId":"<id>"' app.log
grep '"level":50' app.log        # errors
grep '"event":"' app.log         # operational events
```

Event names are listed in [operations-monitoring.md §4](operations-monitoring.md#4-events) (API: `app_started`,
`app_shutdown`, `app_fatal_error`, `db_readiness_failed`, `document_storage_unavailable`; ops commands: `backup_*`,
`offhost_copy_*`, `restore_*`, `sessions_revoked`, `integrity_check_*`, `preflight_*`, `monitor_check_*`).

Logs never contain passwords, tokens, cookies, authorization headers, connection strings or request bodies — so a leave
reason or attachment reference never reaches a log file. An inbound `x-request-id` is only echoed when it is short and
printable; anything else is replaced by a generated id.

## 3. Detecting and handling trouble

| Symptom | How it shows up | What to do |
|---|---|---|
| API down | uptime monitor / `api_live` fails | `systemctl status hr-api` (or the container); `journalctl -u hr-api -n 200` → the `app_fatal_error` line; a bad configuration exits **before** listening with a named reason; fix, then §5 |
| Restart loop | repeated `app_started` without `app_shutdown`; systemd stops after 5 crashes in 10 min and fires `OnFailure` | read the fatal line; do not just restart again |
| Database unavailable | readiness 503 with `"database":"unavailable"`; `db_readiness_failed` | check PostgreSQL (service, disk on the database host, connections); the API recovers by itself once the database returns — no restart needed |
| Document storage unavailable | readiness 503, `documentStorageReason`; `document_storage` check fails | `ROOT_MISSING` / `ROOT_EMPTY_BUT_DOCUMENTS_EXIST`: the volume is not mounted or the wrong directory is configured — mount it, never create an empty directory in its place; `NOT_WRITABLE`/`NOT_READABLE`: ownership/permissions (service user, `0700`) or a full / read-only filesystem |
| Disk filling | `document_storage_free_space` / `backup_free_space` fail (`MONITOR_MIN_FREE_MB`) | documents: grow the volume (objects are never deleted automatically); backups: lower `BACKUP_RETAIN_COUNT` or grow the volume — never delete the newest `COMPLETE` set by hand |
| Backup failed | `ops:backup` exit 1, `backup_failed` with `reason`; `last-attempt.json` | §4.1 |
| Backups stale | `backup_freshness` fails | the schedule did not run or every run failed: `systemctl list-timers hr-backup*`, `journalctl -u hr-backup`, then §4.1 |
| Repeated 5xx | `"level":50` lines with distinct `requestId`s | take one `requestId`, read its error line; check database health and recent deploys |
| Integrity findings | `ops:integrity` / `ops:preflight` exit 1 | §6.2 — report only; reconcile by hand |

## 4. Backups

```bash
npm run ops:backup                     # normally run by hr-backup.timer, not by hand
```

One run = one verified recovery set (database + documents + manifest + SHA256SUMS), copied off-host and confirmed,
then retention. Details, formats and guarantees: [backup-restore.md](backup-restore.md).

### 4.1 Investigating a failed backup

Read the `reason` of `backup_failed` (also in `$BACKUP_DIR/last-attempt.json`):

| Reason | Meaning | Action |
|---|---|---|
| `DATABASE_DUMP_FAILED` | pg_dump failed | PostgreSQL reachable? client tools ≥ server major version (`PG_BIN_DIR`)? disk space in `BACKUP_DIR`? |
| `DOCUMENT_BACKUP_FAILED` | document root missing/unreadable, or an object could not be read | same as "document storage unavailable" (§3) |
| `DOCUMENT_REFERENCES_MISSING` | the database references objects the store does not have | `npm run ops:integrity -- --deep` names the versions; restore those objects from the previous set or reconcile — the set is kept as `INCOMPLETE` |
| `BACKUP_VERIFY_FAILED` | the written set does not verify (disk/filesystem fault) | check the backup volume; rerun |
| `OFFHOST_COPY_FAILED` | copy or remote verification hook failed (the local set is fine, `LOCAL_ONLY`) | run the hook by hand: `deploy/backup/offhost-…sh <set dir> <set id>`; network, SSH key / rclone credentials, remote disk; rerun `ops:backup` |
| `OFFHOST_NOT_CONFIGURED` | production without `BACKUP_OFFHOST_COMMAND` | configure it (backup-restore.md §4) |
| `BACKUP_DIR_REQUIRED`, `BACKUP_CONFIG_INVALID` | configuration | fix `backup.env` |

### 4.2 Verifying a backup by hand

```bash
npm run ops:backup:verify -- $BACKUP_DIR/hr-backup-YYYYMMDDTHHMMSSZ      # checksums, manifest, dump readable
npm run ops:restore -- $BACKUP_DIR/hr-backup-YYYYMMDDTHHMMSSZ --verify-only   # full restore drill, cleaned up
```

Run the drill monthly and after configuration changes (it needs `CREATEDB` for the database role; on a production
server prefer running it on a separate verification host with the set copied there — T44-P2-20).

## 5. Restarting safely

1. If the restart follows a suspected data problem, `npm run ops:backup` first.
2. `systemctl restart hr-api` (SIGTERM: in-flight requests finish within 10 s, the database pool is released).
3. Confirm `app_started` with the expected version; `npm run ops:monitor-check` → exit 0; sign in once.

## 6. Recovery

### 6.1 Restore

Follow [backup-restore.md §9](backup-restore.md#9-restore) exactly: verify the set → `ops:restore` into a **new**
database and an **empty** directory (sessions and unused reset tokens are revoked inside the restore) → switch
`DATABASE_URL` / `DOCUMENT_STORAGE_DIR` → start → `ops:preflight` and `ops:monitor-check` → sign in, open a document →
tell users the lost window → back up immediately. Restoring over the live database is not possible with this tooling,
on purpose. `npm run ops:revoke-sessions` remains available for any other "sign everyone out now" situation.

### 6.2 Integrity and preflight

```bash
npm run ops:integrity               # documents ↔ database (size), financial handoff anomalies; exit 1 on findings
npm run ops:integrity -- --deep     # also re-hashes every stored object
npm run ops:preflight               # before deploying / migrating, and after a restore
```

Report only — nothing is repaired, moved or deleted. Findings name record ids and opaque storage keys, never file names
or amounts. Financial findings (e.g. a report `SENT_TO_PAYROLL` without its payroll line, Task 48) are reconciled by a
payroll administrator, never by a script. Orphan objects are warnings (expected after a restore).

### 6.3 Disaster scenarios

[backup-restore.md §11](backup-restore.md#11-disaster-scenarios).

## 7. Alerting

What must page someone and who sets it up: [operations-monitoring.md §2](operations-monitoring.md#2-external-alert-contract-what-the-operator-must-set-up).
The repository ships the signals and examples; delivering alerts is the operator's configuration.

## 8. Deploying a new release

`npm ci && npm run build` → `npm run ops:backup` → `npm run ops:preflight` (pending migrations listed; a failed or
unknown migration, unusable document storage or an integrity finding stops here) → `npm run db:deploy` → restart (§5) →
`npm run ops:monitor-check`.

## 9. RPO and RTO

Stated factually, with measurements and without promises, in
[backup-restore.md §10](backup-restore.md#10-rpo-and-rto--what-is-actually-true). In short: RPO is bounded by the
backup schedule you configure (not guaranteed); RTO was measured at seconds on small datasets on a developer machine —
not an SLA.

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


## Document storage (Task 30, Task 49)

The document center keeps file bytes **outside PostgreSQL**, in `DOCUMENT_STORAGE_DIR` (local filesystem adapter).
Since Task 49 they are part of every backup set and every restore (backup-restore.md); readiness reports the store's
usability with a reason code; `ops:integrity` compares objects with their database records. Files are stored as
uploaded — no malware scanning is performed by the platform (audit T44-P2-11).
