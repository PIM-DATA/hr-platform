# Privacy operations

Tooling for handling what data subjects ask for: a register of requests, and an export of one person's data.

> **Scope, stated plainly.** This is a *privacy operations foundation*: record keeping and an export tool. It is not
> a compliance certification, and installing it does not make a deployment compliant with PDPA, GDPR or any other
> law. Retention periods, legal basis, response deadlines and erasure decisions belong to the customer's own policy
> and legal review. The system never makes those decisions automatically.

---

## 1. Who can use it

| Permission | Grants | Default roles |
|---|---|---|
| `privacy.manage_requests` | record and track privacy requests | HR Admin, System Admin |
| `privacy.export_data` | assemble and download one person's data | HR Admin, System Admin |

They are separate on purpose: tracking a request is a different job from reading out somebody's whole file.
Authorization is deployment-wide rather than scoped to a manager's team — a privacy administrator handles requests
for anyone in the installation, **including former employees**, who are often the ones asking.

## 2. The request register (Administration → Privacy → Requests)

Records what was asked, by whom, when it is due and what was decided.

- **Types**: `ACCESS`, `EXPORT`, `CORRECTION`, `DELETION`, `RESTRICTION`, `OTHER`.
- **Status**: `OPEN` → `IN_PROGRESS` → `COMPLETED` | `REJECTED`. A completed or rejected request is **never
  reopened** (`PRIVACY_REQUEST_CLOSED`); record a new request instead, so each decision keeps its own history.
- **There is no delete endpoint.** A privacy request is an operational record of a decision. Removing it would erase
  the evidence that the organization answered.
- **Notes** are free text that may quote the data subject. They are returned only on the detail view, never in the
  list, and are never copied into the audit trail — the audit records *that* a note exists, not its content.
- Creating and updating a request is audited (`CREATE_PRIVACY_REQUEST`, `UPDATE_PRIVACY_REQUEST`).

### Deletion requests

Recorded for human review; **nothing is deleted automatically**. Employment records usually carry statutory retention
obligations that outlast an erasure request, and a system that deleted on request would break both the audit trail and
the leave ledger. Use the notes and status to document the decision your policy reaches.

## 3. Personal data export (Administration → Privacy → Data export)

Produces a JSON file with everything the system holds about one employee.

- One consistent snapshot: the collections are read in a single `RepeatableRead` transaction, so a change midway
  cannot produce a half-old, half-new file.
- Delivered as a download (`Content-Disposition: attachment`, `Cache-Control: no-store`). **Nothing is stored
  server-side** — no export archive, no temporary file.
- `formatVersion` in the envelope lets the shape evolve without invalidating files generated earlier.
- Collections are capped at 5,000 rows each, so one export can never exhaust the server's memory.

**Included**: profile, account (email, status, roles — never credentials), position and manager history, leave
requests, entitlements and ledger entries, approval workflow history for the subject's own requests, the subject's own
notifications, privacy requests about them, and audit events they performed.

**Not included** — and the file says so, with the reason, in its `notIncluded` section:

| Category | Why |
|---|---|
| Credentials | Password hashes, session tokens and reset tokens are security material. |
| Other people's notifications | An approver's inbox is *their* personal data, even when the message concerns this employee. |
| Audit events recorded by other actors | The audit schema identifies who performed an action, not who every record is about, so events *about* a person performed by others cannot be attributed reliably. Guessing would produce a misleading file. |
| Database backups | Backup archives are handled through the backup retention process (`docs/operations-runbook.md`), not this export. |

Third parties appear only where a record is meaningless without them — the approver of *your* leave request, your
manager's name — and then only as a name and employee code, never their email or profile.

The export itself is audited (`EXPORT_EMPLOYEE_PERSONAL_DATA`) as an event with **row counts only**. The payload is
never written to the audit trail or to the logs.

## 4. Handling the file

It is personal data. Deliver it the way your policy requires, and delete local copies when the request is closed.
The system cannot help with that once the file has left the browser.

## 5. Retention

No automated retention runs against business data. What exists today:

- `npm run ops:cleanup-reset-tokens -- --days 30` — spent password reset tokens (security artifacts, no business
  value).
- Backup retention is a deployment concern (`docs/operations-runbook.md`).

Audit-log retention, leave-history retention and employee-record retention after termination are **not implemented**
and are listed as gaps in `docs/production-readiness.md`: they require the customer's policy first.

## 6. Not implemented, deliberately

- Automated erasure or anonymisation of any kind.
- Consent management, processing register, DPIA tooling, cross-border transfer records.
- Data-subject self-service (a portal where an employee exports their own file without HR).
- Notifications or deadline reminders for privacy requests.
