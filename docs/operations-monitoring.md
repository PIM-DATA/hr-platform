# Operations monitoring

Task 49 (audit finding T44-P1-12). Before this task the honest answers to "the API is down at 02:00", "the database disk
is full", "backups have failed for three days" were: nobody knows automatically. This document defines what the
application now **emits** and what something **outside** it must do with those signals.

**Division of responsibility.** The application provides probes, a check command with a meaningful exit code, and
structured events. It does **not** deliver alerts (no PagerDuty / chat / e-mail integration is configured by this
repository) and it cannot see PostgreSQL's own disk. An operator-owned monitor must consume the signals below and page
a person. Until that is set up, nothing alerts — this document says so rather than implying otherwise.

## 1. Signals

| Signal | Source | Failure means |
|---|---|---|
| `GET /api/v1/health/live` | API process | process down / hung |
| `GET /api/v1/health/ready` → 200 / 503 | API | database unreachable, or document storage unusable |
| `npm run ops:monitor-check` → exit 0 / 1 | operator host (same config as the API) | any check below failed |
| Structured events (JSON lines, `"event"` field) | API logs, ops command output | see §4 |
| Exit code of `npm run ops:backup` | scheduler | the backup run failed (any step) |

### Readiness payload

```json
{ "data": { "status": "ready", "version": "…", "timestamp": "…", "database": "ok",
            "documentStorage": "ok | disabled | unavailable", "documentStorageReason": "ROOT_MISSING", "copilot": "disabled" } }
```

No host, path, credential or business data. `documentStorageReason` (only when unavailable) is a stable code:
`ROOT_MISSING`, `ROOT_NOT_DIRECTORY`, `ROOT_EMPTY_BUT_DOCUMENTS_EXIST`, `NOT_READABLE`, `NOT_WRITABLE`, `CHECK_FAILED`;
the same code is logged with event `document_storage_unavailable`. Readiness checks the store's root (present,
readable, writable, not empty while the database references documents) — it never scans every object (that is
`ops:integrity`) and, since Task 49, never re-creates a missing root once documents exist: an unmounted volume or a
database restored without its files makes the API **not ready** instead of silently "ok" (Task 44 finding).

### `npm run ops:monitor-check`

| Check | Fails when |
|---|---|
| `api_live`, `api_ready` | probe not 200 (`OPS_CHECK_URL`, default `http://127.0.0.1:$PORT`; skip with `MONITOR_SKIP_API=true` on a host without the API) |
| `document_storage` | root missing / not a directory / unreadable / not writable / empty while documents exist |
| `document_storage_free_space` | free space on the document volume below `MONITOR_MIN_FREE_MB` (default 1024) |
| `backup_freshness` | no verified `COMPLETE` set, its directory is gone, or it is older than `BACKUP_MAX_AGE_HOURS` (default 26) |
| `backup_free_space` | free space on `BACKUP_DIR` below `MONITOR_MIN_FREE_MB` (or the directory does not exist) |

Exit 1 with event `monitor_check_failed` listing every failed check; exit 0 with `monitor_check_ok`. Backup freshness
cannot be skipped in production. Freshness comes from `$BACKUP_DIR/last-success.json`, written only after a fully
successful run — failure modes: if `BACKUP_DIR` is lost or unreadable the check fails (correctly); the file says nothing
about the off-host copy's later fate (watch the remote with the provider's own tooling).

Demonstrated in the Task 49 drill (production build): healthy → exit 0; API stopped → `api_live`, `api_ready`;
document directory removed → `api_ready`, `document_storage`, `document_storage_free_space` and readiness
`ROOT_MISSING`; stale backup → `backup_freshness`; no backup → `backup_freshness`, `backup_free_space`.

### What is NOT observed here

- **PostgreSQL storage / disk-full**: the application cannot see the database server's filesystem. Disk, WAL growth and
  database health alerts are the database host's or managed provider's monitoring — configure them there.
- Host CPU/memory, TLS certificate expiry, the reverse proxy: platform monitoring.
- The off-host destination's retention and health after the copy was confirmed: provider tooling.

## 2. External alert contract (what the operator must set up)

| Who/what | Consumes | Alerts when |
|---|---|---|
| External HTTPS uptime monitor (outside the host) | `https://<host>/api/v1/health/live` and `/api/v1/health/ready` every 1–5 min | non-200 twice in a row |
| Scheduler on the host (systemd timer / cron) | `npm run ops:monitor-check` every 5 min | non-zero exit (`OnFailure=` / wrapper) |
| Scheduler on the host | `npm run ops:backup` (example daily) | non-zero exit |
| Log pipeline (optional) | events `app_fatal_error`, `backup_failed`, `offhost_copy_failed`, `restore_failed`, `document_storage_unavailable`, `db_readiness_failed` | any occurrence |
| Database platform | PostgreSQL disk / availability | provider thresholds |

Concrete example (shipped, not configured anywhere by this repository): `deploy/systemd/hr-backup.timer` runs
`hr-backup.service` → `npm run ops:backup` exits 1 on any failure → systemd marks the unit failed → `OnFailure=` starts
`hr-alert@hr-backup.service.service` → **your** `/usr/local/bin/hr-notify` delivers the page. The same pattern for
`hr-monitor.timer` (every 5 min) and `hr-api.service`. Replace `hr-notify` with your integration; no alert is delivered
until you do.

## 3. Process supervision

The API is one Node process (`npm start`). It exits on a fatal error (event `app_fatal_error`) and drains on SIGTERM
(10 s). It must run under a supervisor that restarts it:

- systemd: `deploy/systemd/hr-api.service` — `Restart=on-failure`, `RestartSec=5`, a crash loop (5 in 10 min) stops
  restarting and triggers `OnFailure=` instead of looping forever; `UMask=0077`.
- Containers: the orchestrator's restart policy plus a liveness probe on `/health/live` and a readiness probe on
  `/health/ready`.

No process manager is built into the application.

## 4. Events

JSON lines with an `"event"` field (`grep '"event":"' …`). API: `app_started`, `app_shutdown`, `app_fatal_error`,
`db_readiness_failed`, `document_storage_unavailable` (plus request-level events of individual modules). Ops commands:

| Command | Events |
|---|---|
| `ops:backup` | `backup_started` (set id, target host:port/database — no credentials), `offhost_copy_succeeded` / `offhost_copy_failed` (hook name, exit code, timeout flag), `backup_retention_deleted`, `backup_succeeded` (durations, sizes, counts), `backup_failed` (reason code) |
| `ops:backup:verify` | `backup_verify_succeeded` / `backup_verify_failed` |
| `ops:restore` | `restore_started`, `sessions_revoked`, `restore_succeeded` / `restore_failed`; with `--verify-only`: `restore_verify_started` / `_succeeded` / `_failed` |
| `ops:integrity`, `ops:preflight` | `integrity_check_ok` / `_failed`, `preflight_ok` / `_failed` |
| `ops:monitor-check`, `ops:check` | `monitor_check_ok` / `_failed`, `ops_check_healthy` / `_unhealthy` |
| legacy `db:backup` / `db:restore:verify` | `backup_completed`, `restore_verify_completed`, … (database-only) |

Never in an event: `DATABASE_URL`, passwords, keys, employee data, original document file names, amounts.
