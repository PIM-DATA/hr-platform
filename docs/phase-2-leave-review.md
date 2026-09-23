# Phase 2 — Leave Management: architecture and closure review

Status at the end of Task 14. This document is the review record for Phase 2 (Tasks 8–14): what was built, the rules the
code actually enforces, what is verified by tests, and what is deliberately left for later. It contains no credentials
and no environment values — only variable names.

---

## 1. Phase objective

Deliver end-to-end leave management on top of the Foundation phase: a reusable approval workflow engine, leave master
data (calendars, types, policies), an auditable balance ledger, the leave request lifecycle, the user-facing Leave UI
with an approval inbox, in-app notifications, and operational reporting — all on PostgreSQL with proven concurrency
behaviour.

## 2. Architecture

```
packages/shared      zod schemas, DTOs, enums, pure helpers (business dates, leave units, ledger maths, overlap,
                     unit formatting) — the single source of truth shared by API and web
apps/api             Express 5 + Prisma 6 (PostgreSQL)
  modules/leave      leave types, policies, entitlements, balance service, requests, reports
  modules/calendar   work calendars + holidays (shared domain, used by Attendance later)
  modules/notification  inbox HTTP surface
  services/workflow  generic approval engine (module-agnostic)
  services/notification shared publisher + templates + delivery outbox
  services/audit     append-only audit log
apps/web             React 19 + TanStack Query; Leave, Approvals, Team leave, All requests, Reports, Notifications
```

Layering rule that held throughout: **the workflow engine knows nothing about leave**. It exposes generic callbacks
(`onApproved`, `onRejected`, `onCancelled`, `onStepPending`) keyed by `(module, entityType, entityId)`; the leave module
registers handlers. The same applies to notifications: business modules publish events, the notification service owns
wording, idempotency and delivery.

## 3. Domain models

| Model | Role |
|---|---|
| `work_calendars`, `holidays` | working days + holidays per organization; `organizations.defaultCalendarId` |
| `leave_types` | semantic only (code, name) — no rules |
| `leave_policies` | all rules for a `(leaveType, organization\|ANY, employmentType\|ANY)` selector, with an effective range |
| `leave_entitlements` | one row per `(employee, leaveType, periodStart)`; cached summary of the ledger |
| `leave_ledger` | append-only source of truth for balances (`operationKey` unique) |
| `leave_requests` | request lifecycle + immutable submit snapshots |
| `workflow_definitions/_steps` | versioned, immutable once used |
| `workflow_instances/_steps/_actions` | one instance per submitted record; approver snapshot; append-only actions |
| `notifications`, `notification_deliveries` | per-user inbox + outbox foundation |
| `audit_logs` | append-only business audit |

## 4. Permission model

25 permission codes; authorization is **always** by permission code, never by role name (verified by grep across
`modules/` and `services/`). Phase 2 codes: `calendar.view`, `calendar.manage`, `leave.manage_types`,
`leave.manage_policies`, `leave.manage_entitlements`, `leave.view`, `leave.request`, `workflow.approve`,
`workflow.view_all`, `workflow.manage_definitions`.

| Role | Leave-relevant grants | Data scope |
|---|---|---|
| EMPLOYEE | `leave.view`, `leave.request` | SELF |
| MANAGER | + `workflow.approve` | TEAM |
| HR | + `leave.manage_entitlements`, `calendar.view` | ALL |
| HR_ADMIN | + `leave.manage_types/_policies`, `calendar.manage`, `workflow.*` | ALL |
| EXECUTIVE | `leave.view`, `leave.request`, `workflow.approve` | ALL |
| SYSTEM_ADMIN | every permission | ALL |

Three separate authorization contexts, deliberately not merged:

1. **Browse** — `leave.view` + `employeeScopeWhere(auth)`.
2. **Self-service** — `leave.request` for `auth.employeeId` only. An ALL-scope user still cannot create, edit, submit or
   cancel someone else's request.
3. **Approval** — `workflow.approve` + being the *snapshot* approver of the step that is currently pending. Data scope
   grants no approval rights; `workflow.view_all` grants no inbox entries.

The notification inbox is a fourth case: authentication only, filtered by `userId`. No permission, no data scope, and no
override for SYSTEM_ADMIN.

## 5. Data-scope model

`employeeScopeWhere(auth)` is the single definition (SELF → own id, TEAM → self + direct reports, ALL → no filter) and
is used by employees, dashboard, leave requests, team calendar and reports. Every consumer composes it with **`AND`**.
This matters: Task 11 shipped a bug where spreading the scope over an object that also had `id`/`OR` silently replaced
the scope clause. It was found by a test, fixed in `getById` and `list`, and the review re-checked every call site.

## 6. Workflow lifecycle

Submit resolves each step's approver from the requester's current org data and **snapshots** it (`DIRECT_MANAGER`,
`DEPARTMENT_HEAD`, `SPECIFIC_USER`; `ROLE` deliberately unsupported). `onSelf` and `onUnresolved` default to FAIL;
`SKIP` is opt-in per step, and an all-skipped definition auto-approves inside the submitting transaction. HTTP exposes
`APPROVE`/`REJECT` only — cancellation is internal and business modules expose their own endpoint. Definitions are
immutable once used; edits create a new version.

Concurrency: `loadWorkflowInstanceForMutation` takes `SELECT … FOR UPDATE` **before** any status is read, so
`act()`/`cancel()` cannot decide on a stale read.

## 7. Leave lifecycle

`DRAFT → PENDING → APPROVED | REJECTED | CANCELLED`. Drafts validate leave type, calendar and units; entitlement,
policy rules and overlap are enforced at submit. Submit runs in one transaction: lock request → lock employee →
revalidate → reserve → write snapshots + PENDING → workflow submit → store instance id → audit → notify. Snapshots
(entitlement, request policy, calendar, units, org/dept/position) are frozen; later calendar, holiday, assignment or
policy changes never recalculate a submitted request. Submit is idempotent; a request already PENDING/APPROVED with an
instance returns its current state.

**Entitlement policy vs request policy**: `leave_entitlements.policyId` is the historical *grant* policy;
`leave_requests.policyId` is resolved at submit from the employee's current organization/employment type and drives the
workflow, half-day, reason/attachment, backdate, notice, max-consecutive and negative-balance rules. After a transfer
they legitimately differ while the balance still comes from the existing entitlement.

## 8. Ledger / accounting model

`leave_ledger` is append-only and authoritative; `leave_entitlements` caches the summary and is **recomputed from the
ledger** inside every writing transaction (never incremented). Sign convention: GRANT +, CARRY_FORWARD +, ADJUSTMENT ±,
RESERVE + / RELEASE −, USE + / REFUND −; `available = granted + carriedForward + adjustment − reserved − used`. Units
are non-zero multiples of 0.5, validated before rounding. Every write carries a deterministic `operationKey`
(`grant:<id>`, `leave:<requestId>:reserve|release|use|refund`, `adj:<uuid>`, `cf:<uuid>`): same key + same payload
replays, different payload is a 409. `reconcile()` compares cache against ledger read-only. There is **no HTTP route**
for reserve/release/use/refund — they are internal service calls only.

## 9. Locking and concurrency guarantees

| Path | Lock order |
|---|---|
| Balance mutation (adjust, carry-forward, reserve, release, use, refund) | entitlement row |
| Leave submit | leave_request → employee → entitlement |
| Workflow transition (approve / reject / cancel-pending) | workflow_instance → leave_request → entitlement |

No path acquires these in the reverse order (verified by reading every mutation path in this review). The employee lock
exists because two leave types use *different* entitlement rows, so only an employee-level lock can serialise
overlapping submissions. Isolation stays at PostgreSQL's default READ COMMITTED; the row locks are the correctness
mechanism — no SERIALIZABLE, no retry framework, no application mutex.

Proven by dedicated suites (each 20/20 consecutive runs): concurrent reserve against a 2-day balance → exactly one
succeeds; 10 × 1-day reserves against 5 days → exactly five; same-operationKey races → one ledger row; rollback releases
locks; duplicate final approvals → one transition; approve vs cancel → exactly one terminal outcome; overlapping
submissions of different leave types → exactly one; different employees never block each other. Removing a lock makes
the corresponding tests fail, so the suites genuinely detect the races.

## 10. Notification model

Publishing is a shared service call on the caller's transaction, so the notification and its `IN_APP` delivery commit
with the business change and roll back with it. No external network call ever happens inside a transaction. Recipients
are snapshot approvers (approval-required) or the requesting employee's account; a missing or inactive account is
skipped rather than failing the business transition. Idempotency uses `(userId, dedupeKey)`. Only the step that is
pending *now* triggers `APPROVAL_REQUIRED`; future steps stay silent until they become current. Notification content
never repeats leave reasons, attachment references, approval comments, policy rules or balances.

## 11. Reporting semantics

`GET /leave/reports/overview` aggregates the requests the caller can already read (`leave.view` + scope, enforced in
SQL). Rules, stated on screen as well:

- **Attribution `START_DATE`** — a request counts, with its whole snapshotted `units`, in the period containing its
  start date. A request spanning a month boundary belongs entirely to its start month; requests store a total, not a
  per-day ledger, and history is never re-prorated against today's calendar.
- **Population** — everything except DRAFT.
- **Dimensions** — organization/department come from the request snapshot, so transfers do not rewrite history. That is
  independent of authorization, which always uses the employee's current scope.
- **Figures** come from request snapshots, not the ledger: this is an operational leave-request report, while the ledger
  remains the source of truth for balances.
- Range is required, `from ≤ to`, at most 24 months (`REPORT_RANGE_TOO_LARGE`); months are zero-filled; pending aging
  buckets (0–2 / 3–7 / 8+ days) are counted in the database from `submittedAt` using elapsed calendar time.

## 12. Test coverage

367 backend tests on PostgreSQL (Foundation 188 + Phase 2), all green, 5/5 consecutive full-suite runs. Phase 2 suites:
workflow engine, workflow concurrency, calendar + leave master, entitlements + ledger, balance concurrency, policy
semantics, leave requests, leave concurrency, leave read models, notifications, leave reports. Concurrency suites are
run 20/20 whenever a mutation path changes. Every destructive test helper refuses to run outside `NODE_ENV=test` with a
dedicated `TEST_DATABASE_URL`.

## 13. Known limitations

- Approved leave cannot be cancelled (an approved-cancellation workflow is not built).
- `attachmentRef` is an opaque string — no upload, storage or document service.
- No batch entitlement generation, no automatic carry-forward job, no automatic re-grant on employee transfer.
- A request cannot span two entitlement periods (it must be split manually).
- No attendance integration and no payroll integration.
- Notifications are in-app only: no email/LINE/Lark/push worker, no preferences, no digest, no retention policy.
- Reporting has no export, no scheduled reports and no report centre; figures are request-based, not ledger-based.
- `ROLE`-type workflow approvers and approver groups are not supported.
- Team calendar is a month list, not a grid; no per-employee calendar assignment (organization default only).

## 14. Production-readiness gaps

- Production deployment has not been done; no infrastructure-as-code, no TLS/reverse-proxy configuration in repo.
- No backup/restore drill for PostgreSQL.
- No monitoring, alerting or error tracking; logs are stdout only.
- Login rate limiting is in-memory per process — it does not hold across multiple instances.
- No password reset / account recovery flow; admins must reset credentials directly.
- No PDPA/retention operational tooling (no data export or erasure workflow, no audit-log retention policy).
- `npm audit` reports 3 high advisories, all from `deepmerge-ts` reached through `@prisma/config` in the **Prisma CLI**
  (developer toolchain, not the request path). The only offered remediation is a Prisma major **downgrade** to 6.12.0,
  which would undo the pinned 6.19.3 PostgreSQL work — deliberately not applied; revisit when a patched Prisma ships.

## 15. Deferred backlog

Attendance (Phase 2B), approved-leave cancellation, document/attachment service, external notification channels with a
delivery worker and preferences, report export/report centre, batch entitlement + carry-forward jobs, re-grant on
transfer, admin notification inspection, workflow approver groups/roles, production hardening (the gaps above).
