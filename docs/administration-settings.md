# Administration, settings and workflow operations (Task 41)

Administration answers one question honestly: what can this installation actually be configured to do, and by
whom. Every area states whether it is configured in the application, shown but not changed here, set by the
deployment, or not implemented at all. There are no placeholder cards, no disabled switches and no "coming soon".

Route: Administration → Overview (`/admin/settings`). API base `/api/v1/admin`.

## 1. What this task found, and what it changed

The inventory that drove the work:

| Area | Before | After |
|---|---|---|
| Users, roles, permissions, audit log, privacy, data import, leave settings, organization, employees | Backend and UI complete | Unchanged, now indexed and labelled by capability |
| Workflow definitions | Backend and UI complete | Unchanged |
| **Workflow instances** | List and detail endpoints existed; no administrator UI at all | **Workflow monitor added** (purpose-built read-only endpoints and a page) |
| **Pay components** | Backend had `PATCH`; UI was list and create only | **Edit added**, system components protected |
| **Recurring pay items** | Backend had `PATCH`; UI was list and create only | **Edit added** (amount, end date, note) |
| **Payroll policies** | Backend had `PATCH`; UI was list and create only | **Edit added**, sending only what changed |
| **Payroll periods** | Backend had `PATCH`; UI had no edit | **Edit added** for an uncalculated period's windows |
| `SystemSetting` key/value table | Exists in the schema; **zero production reads** | Deliberately left unused. No generic key/value editor was built. |
| Notification delivery, retention automation, multi-factor sign-in, single sign-on | Not implemented | Reported as not implemented; nothing was invented |
| Cookie security, session lifetime, storage location, copilot credential, origins | Environment only | Reported as deployment-managed, never editable or displayed |

## 2. Information architecture

The hub groups areas as: **People and access** (users, roles, employee master), **Organization**, **Processes**
(workflow definitions, workflow monitor), **Payroll configuration** (components, recurring items, policies,
periods), **Modules** (leave settings) and **System** (data import, privacy, audit log, service status,
notifications, sign-in security, document storage, copilot).

The list comes from `GET /admin/settings/areas`, so a capability cannot drift away from the code that implements
it. A card is a link only when the caller holds one of the permissions that already guards that area; an area
nobody configures here is still shown, because "there is nothing to set" is the useful answer.

Capability badges:

| Badge | Meaning |
|---|---|
| Configurable | A real screen in this application writes it. Every such area has a path and a permission. |
| Read only | The application shows it and does not change it (audit log, workflow monitor, service status). |
| Deployment managed | Set through the environment by whoever runs the service. Never editable or displayed here. |
| Not implemented | The capability does not exist. Nothing pretends otherwise. |

## 3. Settings storage: why there is no generic editor

The schema carries a `SystemSetting` key/value table from the foundation. Nothing in production code reads it,
so exposing it would have meant offering administrators a way to set keys that change nothing, or worse, keys
whose effect nobody can state. It stays unused and no arbitrary key/value or JSON-blob editor was built.

What is genuinely configurable is configured where it belongs, with a typed schema: an organization's **IANA
timezone** on the organization record (`PATCH /organizations/:id`, validated as a real timezone), leave rules in
leave settings, payroll rules in payroll configuration, and so on. Changing an organization's timezone affects
how business dates are derived from that point on; dates and timestamps already recorded are never rewritten.

## 4. Service status

`GET /admin/diagnostics` reports environment, version, database reachability, whether cookies are secure, the
session lifetime, whether documents and the copilot are switched on, and that notifications are in-application
only. Every value is a boolean, an enum, a small number or a short label.

It can carry no secret by construction: there is no connection string, no storage path, no API key, no cookie
name, no host and no origin in the response, and a test asserts that the values of the environment's own secrets
never appear in it. The panel is operational information, **not monitoring**, and does not replace it.

## 5. Workflow monitor

Administration → Workflow monitor (`/admin/workflow-monitor`), behind the existing `workflow.view_all`
permission. There is no `admin.manage_everything`.

**Read only, on purpose.** The monitor exposes no write at all: no force approve, no force reject, no skip, no
reassign, no delete, no retry. A decision stays with the approver the workflow named. A test asserts every write
verb against the monitor returns 404 because no such route exists.

A row carries the definition and version, the module, the entity type, the record **identifier**, the requester,
the status, the current step and its approver, and how many days a pending instance has been waiting. Filters:
module, status, entity type, waiting longer than 3, 7 or 14 days, and a search over the requester or the record
id. The list is server-paginated; the browser never loads every instance.

**The monitor never reads the business record behind an instance**, so no amount, claim description, relations
narrative, survey answer, expense purpose, merchant or salary can appear in it however it is queried.

### Confidentiality of approver comments and the source link

The one piece of text the engine itself holds is an approver's comment, which is that approver's confidential
word about a business record. The rule is single and testable:

> A comment is shown, and the link to the record is offered, only to a caller who already holds a permission that
> opens that module.

Everyone else sees that a comment exists and how many characters it had. The source route stays authoritative
either way: hiding the link is a courtesy to the administrator, not the security boundary.

The module-to-permission mapping lives in `WORKFLOW_SOURCE_MODULES` in the shared package, and uses the
permissions each module already defines. A monitor operator who holds only `workflow.view_all` can watch every
approval in the company and read none of the words, which a test proves directly.

Deep-linking to the exact record is not implemented: the link opens the module's screen and the detail shows the
record identifier.

## 6. Payroll configuration

Payroll remains authoritative (Task 22). Task 41 added the missing UI for operations the backend already
accepted, and changed no calculation.

- **Pay components** — edit name, description, taxable flag, whether it may be recurring, and active status. The
  code, the type and how the amount is arrived at are not in the update contract at all, because payslips already
  refer to them. A **system** component is written by the engine and offers no edit; the screen says so instead.
- **Recurring pay items** — edit the amount, the end date and the note. The employee and the component are fixed:
  a different employee or component is a different item. Edits apply to payroll calculated afterwards; a run that
  is already calculated or closed is never recalculated.
- **Payroll policies** — edit the label, the divisor days, the hours per day, the proration bases, the deduction
  switches, the approval workflow, the end date and the active flag. The screen sends **only the fields that
  changed**, because a policy that has already calculated a period in review, approved or closed refuses a change
  to *how it calculates* (`409 PAYROLL_POLICY_IN_USE`) and is superseded by a new policy instead. Renaming such a
  policy still works. No label in the UI implies a divisor of 30 or 26, or an eight-hour day: those are the
  customer's values and are shown from the policy.
- **Payroll periods** — edit the salary window, the attendance window and the payment date while the period is
  open and has no run. Once a run exists, the windows are part of a calculated result and the server refuses
  (`409 PAYROLL_PERIOD_FROZEN`); the button is not offered either. A closed period cannot be reopened.

**Confidentiality.** Every payroll configuration screen and endpoint needs payroll authority. Being an HR user is
not enough on its own, a manager and an executive are refused everywhere, and the workflow-monitor operator has no
payroll access at all. The employee picker used for recurring items returns code, name, organization and
department only: no salary, no bank details, no payslip.

## 7. Permissions

No new permission was created. Each area is administered under the permission that already guards it:
`users.view`, `roles.view`, `audit.view`, `workflow.manage_definitions`, `workflow.view_all`, `payroll.manage`,
`organization.view`, `employees.view`, the leave settings permissions, `onboarding.manage`, the privacy
permissions and `settings.manage`. The hub route accepts any administrative permission, and deliberately not
`organization.view`, which every employee holds.

## 8. Audit and concurrency

Every mutation reached from administration is an existing, already-audited operation: users, roles, payroll
master data, organizations and leave settings all write their own before-and-after audit entries. The two new
endpoints are reads and write nothing, so they add no audit noise: thousands of "an administrator looked at the
monitor" events would bury the entries that matter, and any sensitive read of a source record is logged by the
module that owns it.

Concurrency is unchanged because no new mutable store was introduced. The payroll edits run through the existing
service transactions, and the policy guard against editing an in-use policy is enforced inside that transaction.

## 9. Accessibility and mobile

Hub groups are `section` elements with accessible names; every form control has a label; capability badges carry
their text, not only colour; dialogs are the shared modal with keyboard dismissal. At 390 px the hub and the
monitor list and detail render without horizontal overflow. Payroll configuration is desktop-first, with no action
that is reachable only at desktop width.

## 10. Tests

`apps/api/tests/administration.test.ts` (8 tests): the hub reports only real capabilities and no "coming soon";
a configurable area always has a screen and a permission, and a deployment-managed or unimplemented one never
has a path; diagnostics carry no connection string, path, origin, key or token, and never the value of an
environment secret; the monitor paginates, filters and carries no source-domain key; an approver comment and the
source link require the source-module permission, proved with a workflow operator who holds none; the monitor
exposes no write verb; the payroll edits the screens offer are the ones the server accepts while code and type
are not editable; payroll configuration refuses a manager, an employee, an executive and the workflow operator;
and a calculated period refuses a window change.

## 11. Known limitations

No multi-factor sign-in, no single sign-on, no external monitoring or alerting, no secret-manager interface, no
runtime mutation of environment configuration, no email, SMS or webhook notification delivery and therefore no
delivery settings, no retention or deletion automation, no workflow force-approve, force-reject, reassign or
delete, no workflow retry console, no deep link from the monitor to an exact record, no generic key/value settings
editor, no statutory payroll configuration of any kind (no tax, social security, provident fund or bank
configuration), no reopening of a closed payroll period, and no per-area settings versioning or change history
beyond the audit log.
