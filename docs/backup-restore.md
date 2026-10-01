# Backup and restore

Task 49 (audit findings T44-P1-10 document backup, T44-P1-11 off-host / scheduled / alerted backups). This is the
supported way to back up, verify, copy off-host, rotate and restore one customer installation. Monitoring of all of
this is in [operations-monitoring.md](operations-monitoring.md); deployment in [deployment.md](deployment.md).

No credentials appear here — only variable names. Backup sets contain **every HR and payroll record**: treat them as the
most sensitive data of the customer.

## 1. What existed before Task 49

| Capability | Before Task 49 | Now |
|---|---|---|
| Database backup | IMPLEMENTED (`db:backup`, pg_dump + checksum manifest) | IMPLEMENTED as part of one recovery set (`ops:backup`); `db:backup` kept as a database-only tool |
| Database restore | MANUAL (documented `pg_restore`), verification into a throwaway DB (`db:restore:verify`) | IMPLEMENTED (`ops:restore`, into a new database only) |
| Document backup | NOT IMPLEMENTED (runbook said "copy the directory") | IMPLEMENTED (same set, same run) |
| Document restore | NOT IMPLEMENTED | IMPLEMENTED (same set, checksum-verified per object) |
| Session revocation after restore | MANUAL (`ops:revoke-sessions`, easy to forget — Task 44 proved old sessions survived) | IMPLEMENTED, mandatory inside `ops:restore` (plus unused reset tokens) |
| Off-host copy | NOT IMPLEMENTED | IMPLEMENTED as a provider-neutral hook contract + shipped rsync/rclone examples; required in production |
| Scheduling | EXTERNAL RESPONSIBILITY, no example | EXTERNAL RESPONSIBILITY with shipped systemd timer / cron examples |
| Backup verification | MANUAL (`db:restore:verify`) | IMPLEMENTED in every backup run + `ops:backup:verify` + `ops:restore --verify-only` drill |
| Retention | NOT IMPLEMENTED ("nothing is auto-deleted", disk grows forever) | IMPLEMENTED (keep N verified complete sets) |
| Backup failure detection | exit code of `db:backup` only | exit code + structured events + freshness check (`ops:monitor-check`) |
| RPO / RTO | not stated beyond a dev measurement | stated factually below (§10) with a measured drill — no promise |

## 2. The recovery set

One run of `npm run ops:backup` produces one directory:

```
$BACKUP_DIR/
  hr-backup-20261001T013000Z/
    database.dump      pg_dump custom format (-Fc)
    documents/…        the document store's objects, opaque keys (documents/<2 hex>/<uuid>) preserved byte for byte
    manifest.json      format 2: set id, UTC timestamps, application version, PostgreSQL/pg_dump versions, latest
                       migration and count, dump size + sha256, document file count/bytes, versions referenced by the
                       database, missing/mismatched counts, consistency statement — no credential, host, path or file name
    SHA256SUMS         sha256 of every file above (manifest included)
    status.json        state: COMPLETE | LOCAL_ONLY | INCOMPLETE | FAILED, verified, off-host result (not checksummed: it changes)
  last-success.json    the newest COMPLETE set (metadata only) — read by the freshness check
  last-attempt.json    the latest run, ok or not, with its reason code
```

- Built in `hr-backup-….partial/` and renamed only when complete; a crash leaves a `.partial` directory that can never
  be mistaken for a set (retention removes stale ones later).
- Owner-only: the command sets `umask 077`; directories `0700`, files `0600`. `BACKUP_DIR` must not be inside a web root.
- The dump is taken with credentials in libpq environment variables, never in process arguments; errors never print
  `DATABASE_URL`.

### Consistency model (single node, local document store)

`pg_dump` takes a transactional snapshot when it starts (`databaseSnapshotStartedAt`). The document tree is copied
**after** the dump. Stored objects are immutable once a database row references them — an upload writes the bytes
before its metadata row commits, versions are append-only, and bytes are only ever deleted for an upload that failed
before its row existed. So **every object referenced by the dump is in the set**. Objects uploaded during the copy may
also be in the set; after a restore they are unreferenced (reported as orphans by `ops:integrity`, harmless, never
deleted automatically). This is **not** an atomic distributed snapshot and is not presented as one; no maintenance
window is required. The run proves the claim instead of assuming it: every document version the database knew at the
snapshot instant must be in the copy **with its recorded sha256**, otherwise the set is `INCOMPLETE` and the run fails.

### What makes a run succeed

| Step | Failure → |
|---|---|
| pg_dump (non-empty, readable by `pg_restore --list`) | `DATABASE_DUMP_FAILED`, no set kept |
| copy every object of the document store | `DOCUMENT_BACKUP_FAILED` (root missing/unreadable, object unreadable), no set kept — a dump alone is not a recovery set |
| every version referenced at the snapshot present with its sha256 | `DOCUMENT_REFERENCES_MISSING`, set kept as `INCOMPLETE` (the database is in it), run fails |
| SHA256SUMS covers exactly the files present, all match, manifest agrees | `BACKUP_VERIFY_FAILED`, set kept as `FAILED` |
| off-host copy confirmed by the verify hook (production) | `OFFHOST_COPY_FAILED` / `OFFHOST_NOT_CONFIGURED`, set kept as `LOCAL_ONLY` (verified locally), run fails |
| all of the above | `COMPLETE`, `last-success.json` updated, retention applied, exit 0 |

Every failure exits **1**; nothing but full success exits 0 or moves `last-success.json`.

## 3. Commands

```sh
# all commands read the same configuration as the API (ENV_FILE) plus the backup variables (§8)
npm run ops:backup                                   # one complete set (cron/systemd runs this)
npm run ops:backup:verify -- $BACKUP_DIR/hr-backup-20261001T013000Z   # checksums, manifest, readable dump
npm run ops:restore -- <set> --verify-only           # restore drill into throwaway targets, removed afterwards
npm run ops:restore -- <set> --database hr_restored_20261001 --documents /srv/hr/documents-restored
npm run ops:integrity [-- --deep]                    # documents ↔ database, financial handoff (report only)
npm run ops:preflight                                # before a deployment/migration and after a restore
npm run ops:monitor-check                            # see operations-monitoring.md
```

`db:backup` / `db:restore:verify` (database only) remain for diagnostics; they are **not** a complete backup once the
document center is used.

## 4. Off-host copy (production requirement)

A backup on the application host does not survive losing that host. In production `ops:backup` requires an off-host
copy (`BACKUP_OFFHOST_REQUIRED` defaults to `true`) and fails without one.

The contract is provider-neutral — two executables, run **without a shell**, each called as
`<command> <set directory> <set id>` with `BACKUP_SET_DIR`, `BACKUP_SET_ID` and `BACKUP_SHA256SUMS_SHA256` in their
environment:

- `BACKUP_OFFHOST_COMMAND` copies the set to the off-host destination; exit 0 = copied.
- `BACKUP_OFFHOST_VERIFY_COMMAND` proves the remote copy exists and matches; exit 0 = confirmed. Required with the copy
  command in production: an upload is trusted only once confirmed.

Shipped examples (`deploy/backup/`):

| Hooks | Destination | Verification |
|---|---|---|
| `offhost-rsync-ssh.sh` + `offhost-rsync-ssh-verify.sh` | another host over SSH (key-based, `OFFHOST_SSH_TARGET`, `OFFHOST_SSH_PATH`); copied to `<id>.partial` then renamed | the **remote** host runs `sha256sum -c SHA256SUMS` and the SHA256SUMS hash must equal this run's |
| `offhost-rclone.sh` + `offhost-rclone-verify.sh` | any rclone remote — S3-compatible object storage, Azure Blob, GCS, SFTP (`OFFHOST_RCLONE_REMOTE`) | `rclone check --one-way` (provider hashes; `OFFHOST_RCLONE_DOWNLOAD=1` compares bytes) |

A "destination" that is another folder on the same disk is **not** off-host, and nothing here pretends otherwise.
Credentials (SSH key, rclone configuration) belong to the service user's own configuration or the deployment secret
store — never the repository, the manifest, the logs or the audit log; the events record only the hook's file name and
exit code. Remote retention (how long copies are kept) is set with the provider's lifecycle rules / a remote cron.

Tested: the rsync hooks end to end (Task 49 drill, with an SSH shim standing in for a remote host — the copy, the
remote re-hash and the failure of a tampered remote file); a destination that is unavailable → `offhost_copy_failed`,
set `LOCAL_ONLY`, exit 1; a copy hook that claims success without copying → the verify hook fails → exit 1.

## 5. Encryption — the factual position

- The application does **not** encrypt backup sets. `database.dump` and `documents/` are readable by anyone who can read
  the files.
- On the application host they are protected by file permissions only (`0700`/`0600`, owner = service user). Disk or
  volume encryption is a host/platform responsibility.
- In transit: the shipped hooks use SSH or the provider's TLS endpoint.
- At rest off-host: the provider's encryption (e.g. object-storage server-side encryption) is the provider's
  responsibility. If the destination is not fully trusted, use client-side encryption that you operate — e.g. an rclone
  `crypt` remote — and keep its key outside the backup destination. That is operator configuration, not a feature of
  this application.
- Without one of those, this baseline **cannot** protect backup data once it leaves trusted storage. That is a known
  limit, stated here rather than hidden.

## 6. Scheduling

The application has no scheduler, by design. Shipped examples:

- `deploy/systemd/hr-backup.service` + `hr-backup.timer` — **example** daily run at 01:30; `OnFailure=` triggers
  `hr-alert@.service` (your notification command).
- `deploy/backup/crontab.example` — for hosts without systemd.

The schedule is the operator's decision. The example interval is an example, not a guaranteed RPO (§10).

## 7. Retention

`BACKUP_RETAIN_COUNT` (default 7). Applied **only after a successful run**, so the newest set is always a verified
`COMPLETE` one:

- keep the newest *N* `COMPLETE` sets, delete older `COMPLETE` sets;
- delete `LOCAL_ONLY` / `INCOMPLETE` / `FAILED` sets and stale `.partial` directories only when they are older than the
  oldest set kept — newer failures stay for investigation;
- with no `COMPLETE` set, nothing is deleted at all.

So the only valid backup is never deleted, and a run of failures never rotates away the last good set (tested).

## 8. Configuration

See [environment-reference.md](environment-reference.md) → "Backup, restore and monitoring". Keep the backup variables
in a separate root-owned `0600` file (e.g. `/etc/hr-platform/backup.env`) next to `api.env`.

## 9. Restore

### Canonical procedure (tested order: restore → migrate → revoke → start)

1. **Choose a `COMPLETE` set** (`status.json`; `ops:backup:verify` it). From off-host storage, copy the whole set
   directory back first.
2. **Stop the application** if the live system is being replaced; preserve the damaged database and document
   directory (rename them) — they are evidence and may hold newer data.
3. **Restore into a NEW database and an EMPTY directory:**
   `npm run ops:restore -- <set> --database hr_restored_<date> --documents /srv/hr/documents-<date>`
   It verifies the set's checksums, refuses an `INCOMPLETE` set, creates the database (refuses one that exists, is
   configured, or is a system database), restores the dump, copies the documents of **the same set** (each object
   re-checked against SHA256SUMS), runs `prisma migrate deploy` (an older set is brought forward — tested from 28 to 30
   migrations), **revokes every restored session and every unused password-reset token** (no flag skips this), and
   checks that every referenced document object is present with its size and sha256. A failure removes what it created.
4. **Switch the configuration explicitly**: `DATABASE_URL` → the new database, `DOCUMENT_STORAGE_DIR` → the restored
   directory. Restoring *over* the live database is deliberately impossible.
5. **Start** the API; `npm run ops:preflight` and `npm run ops:monitor-check` must pass; sign in; open a document.
6. Tell users which period was lost (between the set's `databaseSnapshotStartedAt` and the failure) and take a fresh
   backup immediately.

Why sessions and reset tokens: a dump contains the sessions and reset links that were valid when it was taken;
restoring them would bring those logins and links back (Task 44 proved an old session worked after restore). They are
invalidated as part of the restore itself. Nothing else is ephemeral-security material: CSRF tokens belong to sessions,
and there is no other signing key (see the runbook, "Secrets and rotation").

### Matching database and documents

`ops:restore` copies database and documents from the same set, so they match by construction, and writes the set id to
`<documents>/.hr-backup-set.json`. A database and a document directory from **different** sets cannot be combined by
the tool; if an operator does it by hand, `ops:integrity` (and readiness, for an empty store) reports the mismatch:
missing objects and size/sha256 differences by version id, unreferenced objects as orphans.

## 10. RPO and RTO — what is actually true

- **RPO is not formally guaranteed.** The data a restore can lose is everything after the restored set's snapshot. With
  the example daily timer, the maximum scheduled interval is 24 h — plus however long failures go unnoticed, which the
  freshness check (`BACKUP_MAX_AGE_HOURS`, default 26) bounds only if someone acts on its alert. There is no
  point-in-time recovery (WAL archiving is not configured; it is a platform decision outside this task).
- **RTO is not formally guaranteed.** Measured restore durations (developer machine, PostgreSQL 18 on the same host —
  not an SLA):

| Dataset | Backup | Restore (verify, create DB, pg_restore, documents, migrate, revoke, integrity) | Start + ready |
|---|---|---|---|
| Demo seed, 6 uploaded documents — full drill with the production build | 1.4 s (set 600 KB: dump 553 KB, 42 KB documents) incl. off-host rsync hooks | 1.4 s | 0.55 s |
| Development dataset: 1,135 employees, 203 documents | 0.5 s (dump 2.05 MB, 0.84 MB documents) | 1.8 s (verify-only drill) | — |

  Real RTO = noticing + provisioning + fetching the set from off-host + the restore + switching configuration, and
  grows with data size. Re-measure on the customer's own data before any agreement.

## 11. Disaster scenarios

| Scenario | Recoverable? | How |
|---|---|---|
| A. API host lost, database intact, document store on separate storage | yes, no data loss | redeploy the API (deployment.md) pointing at the same database and document volume; `ops:preflight`, `ops:monitor-check` |
| B. API/document host lost (single node: documents on that host), database intact elsewhere | yes, to the last off-host `COMPLETE` set | the tool restores database **and** documents together only: restore the set into a new database + directory and switch (consistent pair); database changes since the set are lost. Restoring only the documents next to a newer database is not supported — newer document versions would be missing (`ops:integrity` would name them). |
| C. Database lost, document store intact | yes | `ops:restore` into a new database + new directory from the newest set (keeps database and documents consistent); objects uploaded after the set remain in the old directory as evidence |
| D. Database and document host both lost | yes, to the last off-host `COMPLETE` set | fetch the set from off-host storage → §9 |
| E. Newest set corrupted | yes, to the previous set | `ops:backup:verify` / `ops:restore` refuse a corrupted set (checksum, unreadable dump); restore the previous `COMPLETE` set — retention keeps N |
| F. Operator restores the wrong set | detectable, reversible | the restore never overwrites (new database, empty directory); compare `.hr-backup-set.json` and the manifest; restore the right set into another new database and switch |
| Off-host destination lost | yes | local sets remain; fix the destination; the next run copies anew |
| Backups silently failing | detected | `ops:monitor-check` fails `backup_freshness` once the newest `COMPLETE` set is older than `BACKUP_MAX_AGE_HOURS` |

## 12. Single-node limits (not hidden)

One API process, a local document store, in-process rate limits and caches. Backup and restore make this installation
**recoverable**; they do not make it **highly available**: a lost host means downtime until a restore completes. No
replication, no failover, no object storage, no point-in-time recovery. That is enterprise/HA work, outside Task 49.

## 13. Evidence (Task 49)

- `apps/api/tests/ops-backup.test.ts` (21 tests): set contents, permissions, manifest without secrets; document and
  dump corruption; extra/missing files; database dump failure; missing document root; referenced object missing →
  `INCOMPLETE`; off-host success, unavailable destination, unconfirmed copy, production requirements; retention rules;
  freshness; monitor failures; readiness reason codes and no re-creation; restore with session/reset-token revocation;
  overwrite refusals; mismatch detection; financial anomaly report; `ENV_FILE` precedence.
- Full drill against the production build: see the audit document, Task 49.
