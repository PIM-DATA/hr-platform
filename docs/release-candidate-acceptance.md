# Release candidate acceptance — proposed 0.1.0-rc.2

Task 54. This document freezes what the repository is, what was verified, and what still has to be proven in a real
environment before a pilot or a production go-live. It does **not** promote readiness on its own.

| Classification | State |
|---|---|
| **REPOSITORY READY** | **Yes** — remediation complete: P0 = 0, repository-side P1 = 0 |
| **INFRASTRUCTURE VALIDATED** | **No** — no authorized staging/production-like environment, off-host destination or alert channel was available |
| **CUSTOMER PILOT ACCEPTED** | **No** — requires §8 on the customer's environment |

**REPOSITORY REMEDIATION COMPLETE; EXTERNAL DEPLOYMENT ACCEPTANCE PENDING.**

## 1. Repository baseline (2026-10-03)

| Item | Result |
|---|---|
| Base commit | `2dcf004` (Task 53) → `32d2cd5` (Task 54, adds this document; no tag) |
| Working tree | clean before Task 54 |
| Version | root `package.json` `0.1.0-rc.1`; workspaces `0.1.0`; **no git tags exist** (convention so far: an RC is a document in `docs/releases/`, no tag) |
| Migrations | 30 in `apps/api/prisma/migrations`, sequential; `prisma migrate status` → "Database schema is up to date"; the restore drill brought a restored database to 30 with `migrate deploy` |
| `npm run typecheck` | pass (shared, api, web) |
| `npm test` (full suite, run alone, first run) | **61 files, 1145 / 1145 passed** (321 s) |
| `npm run build` | pass |
| `npm run verify:clean-build -- --worktree` | pass — `npm ci` → `npm run build` in a fresh copy, outputs present, no source maps |
| Deployment docs | `docs/deployment.md`, `docs/environment-reference.md`, `docs/production-readiness.md`, `docs/pilot-checklist.md`, `deploy/` (Apache, nginx, systemd units, off-host hooks, crontab example) |
| Backup / restore scripts | `ops:backup`, `ops:backup:verify`, `ops:restore` (`--verify-only`), `ops:integrity`, `ops:preflight` |
| Monitoring scripts | `ops:monitor-check`, `deploy/systemd/hr-monitor.service`, `hr-alert@.service`, `hr-api.service` |

### Local application-side drill (Task 54 — LOCAL, not off-host evidence)

Run on the development host against a copy of the development database; the active database was only read.

| Step | Result |
|---|---|
| `ops:backup` | `COMPLETE`, verified, 2.06 MB dump + 203 documents (0.8 MB) in 0.4 s; `offhost: NOT_REQUIRED` (development) |
| `ops:backup:verify` | 205 files, checksums match, dump readable |
| `ops:restore --verify-only` | new isolated database, 30 migrations, 1,135 employees, 203 document versions, 0 orphans, **419 sessions and 0 reset tokens revoked**, 2.0 s; drill database removed |
| Off-host failure (`BACKUP_OFFHOST_REQUIRED=true`, hook = `/usr/bin/false`) | exit **1**, `OFFHOST_COPY_FAILED`, local set kept as `LOCAL_ONLY` |
| `ops:monitor-check`, fresh set | exit 0 (document storage, free space, backup freshness) |
| `ops:monitor-check`, no backup | exit **1**, `backup_freshness` |
| `ops:monitor-check`, API stopped | exit **1**, `api_live, api_ready` |

These prove the application's contract (non-zero exits, events) — not that a copy left the host or that a human was
alerted.

## 2. Release candidate

- **Proposed version:** `0.1.0-rc.2` — compatible with the existing `0.1.0-rc.1` convention.
- **Content since rc.1:** Tasks 15–53 (HR modules, analytics, documents, reports, copilot) and the Task 44–53 remediation
  (privileged accounts, RBAC SoD, production baseline, confidentiality/privacy, financial correctness, ops baseline,
  permission scopes, maker-checker, copilot high-impact enforcement, business dates). No new feature in Task 54.
- **Task 54 change (a demonstrated defect, not a feature):** date-picker defaults used the browser's zone; with the browser
  on Pacific/Kiritimati / Pacific/Pago_Pago and the organization on Asia/Bangkok the change-position effective date
  defaulted to tomorrow / yesterday (browser evidence). `/auth/me` now returns `businessCalendar.timezone` and pickers
  default to that organization's date (verified in the browser for both zones; API test added). A module-level expense
  item default that was computed once at load time is now computed when the dialog opens.
- **Not done (needs approval):** bump the root version to `0.1.0-rc.2`, write `docs/releases/0.1.0-rc.2.md`, create a git
  tag. Recommended action in §9.

## 3. Deployment prerequisites (operator)

TLS-terminating reverse proxy with the shipped security headers (`npm run ops:verify-web`); `NODE_ENV=production`,
`TRUST_PROXY`, `PUBLIC_APP_URL`, `CORS_ORIGIN`, `COOKIE_SECURE=true` (refused otherwise); PostgreSQL with a dedicated
database and least-privilege role; `DOCUMENT_STORAGE_DIR` on a persistent, backed-up volume; `BACKUP_DIR` (`0700`) and a
**real off-host destination** with the two hook commands; the backup timer, monitor timer and `hr-api.service`
supervisor; an alert path from `hr-alert@.service` / an external uptime probe to a named human; the bootstrap System
Administrator; `COPILOT_ENABLED=false` unless §7 applies. Full list: `docs/deployment.md`, `docs/environment-reference.md`.

## 4. T44-P1-11 — off-host backup: EXTERNAL VALIDATION PENDING

Audit evidence: "Backups off-host / scheduled / alerted — Local directory only" → Task 49 shipped the off-host hook
contract, rsync-over-SSH and rclone hooks, retention, freshness and timers. **Not done, per deployment: a real off-host
destination, its encryption at rest, alert delivery.** No destination, credential or tool (rclone, aws, gsutil, az) exists
in this environment. **Status: open — EXTERNAL VALIDATION PENDING. Not resolved.**

Acceptance checklist (on the customer's staging/production host; never against the active customer database):

- [ ] Off-host credentials stored root-only (`0600`), outside the repository; owner named (§6)
- [ ] `ops:backup` with `BACKUP_OFFHOST_REQUIRED=true` → `COMPLETE`, `offhost: CONFIRMED`
- [ ] Remote copy listed; remote checksum verified by `BACKUP_OFFHOST_VERIFY_COMMAND` (and once by hand)
- [ ] Encryption at rest of the destination confirmed in writing (the application does not encrypt sets — docs/backup-restore.md §5)
- [ ] Off-host failure simulated on the real host (wrong target / revoked key) → non-zero exit, `LOCAL_ONLY`, alert received
- [ ] Set downloaded **from the remote**, `ops:backup:verify`, then `ops:restore` into a new database + empty directory
- [ ] After restore: sessions and unused reset tokens revoked (count recorded); sign in; an authenticated document download is byte-identical
- [ ] Backup and restore durations recorded (RPO/RTO input, docs/backup-restore.md §10)
- [ ] Timer schedule active (`systemctl list-timers` or cron) and owner named

## 5. T44-P1-12 — monitoring and alerting: EXTERNAL VALIDATION PENDING

Audit evidence: "Monitoring / supervision — No alerting, no supervisor" → Task 49 shipped events, `ops:monitor-check`,
`hr-api.service`, `hr-alert@.service` and the external alert contract. **No alert is delivered** until an operator wires
it. No monitoring service or alert destination exists here; a locally emitted event is not proof of delivery. **Status:
open — EXTERNAL VALIDATION PENDING. Not resolved.**

Acceptance checklist (each must reach the designated operator — record time sent and time received):

- [ ] HTTPS uptime probe on the public URL (external service)
- [ ] API readiness probe `/api/v1/health/ready`
- [ ] Backup freshness (`ops:monitor-check` timer) and backup failure (`OnFailure=hr-alert@`)
- [ ] Document storage availability and free-space threshold (`MONITOR_MIN_FREE_MB`); database disk at the provider
- [ ] Process supervision: kill the API → restarted by systemd; crash loop → alert
- [ ] Simulations with alert received: API unavailable · stale/missing backup · document storage unavailable · backup command failure

## 6. Operational ownership

| Responsibility | Owner |
|---|---|
| Monitors the application (receives uptime / readiness alerts) | **TBD** |
| Receives backup-failure alerts | **TBD** |
| May perform a restoration | **TBD** |
| Controls off-host credentials | **TBD** |
| Maintains the backup schedule and retention | **TBD** |
| Approves production deployment | **TBD** |
| Customer data-protection decisions (privacy requests, retention) | **TBD** (customer) |

No owner was assigned by the repository; each must be named by the customer/operator before go-live.

## 7. Copilot production setting

`COPILOT_ENABLED=false` (default) for the pilot and production. Production refuses the fake provider. The Task 52
enforcement is server-side and tested with the deterministic fake provider only; **live-provider adversarial behaviour is
UNVERIFIED** (no provider key). Enabling it for a customer requires the live adversarial smoke test in
docs/hr-copilot.md §14.6 and docs/pilot-checklist.md §6, recorded before go-live.

## 8. Pilot acceptance checklist

| Area | Repository evidence | Needs the customer's environment |
|---|---|---|
| TLS | reference proxy configs; `ops:verify-web` (Task 46) | [ ] certificate, HSTS, headers verified on the real URL |
| Production config | fail-fast env validation; `ops:preflight` | [ ] `ops:preflight` exit 0 on the host |
| Database | 30 migrations, `migrate status` clean, restore drill migrates | [ ] dedicated DB, least-privilege role, provider backups/disk monitored |
| Documents | storage health, integrity check, byte-identical drill (Task 49) | [ ] persistent volume, permissions, included in backup |
| Backup | §1 local drill | [ ] §4 completed |
| Monitoring | §1 local drill | [ ] §5 completed |
| Privileged accounts | Task 45 tests | [ ] two named System Administrators; bootstrap password changed |
| RBAC | Tasks 45 / 50 / 51 tests | [ ] role assignment reviewed with the customer |
| Privacy | Task 47 export, suppression, audit redaction | [ ] privacy notice, retention, request owner (customer) |
| Payroll integrity | Task 48 currency, freeze, fingerprint, handoff | [ ] one parallel payroll run reconciled by the customer |
| Business dates | Task 53 / 54 tests (DST, cross-midnight, host TZ) | [ ] each organization's IANA timezone set correctly |
| Copilot | §7 | [ ] disabled, or live smoke test recorded |

## 9. Production acceptance checklist

Everything in §8, plus: P1-11 and P1-12 **validated** (§4, §5) and marked resolved only then; RPO/RTO agreed with the
customer from measured drill times; MFA for privileged roles (P2-25, open); a second authorized person for maker-checker
steps; release tagged from a verified commit with a changelog.

**Recommended release action (needs explicit approval):** bump the root version to `0.1.0-rc.2`, add
`docs/releases/0.1.0-rc.2.md` (summary of §2), then tag the resulting commit `v0.1.0-rc.2` as a **pilot release
candidate**. Do not label it production until §4 and §5 are validated in the customer's environment.

## 10. Remaining blockers and known limitations

- **Blockers for production:** T44-P1-11 and T44-P1-12 external validation; operator ownership (§6).
- **Open P2 items** remain as listed in the audit (e.g. MFA, idle session timeout, per-account login throttle).
- Copilot live-provider behaviour unverified (§7).
- Single node: in-memory rate limiters, local document storage, no HA (docs/backup-restore.md §12).
- Business dates: records carry no timezone snapshot; installation-wide defaults use the reference organization
  (docs/business-dates.md §7).
