# Employee lifecycle — onboarding, probation, offboarding

Checklists and decisions beside the employee master. The master (employment status, hire and termination dates,
position, manager, account link) stays the source of truth; this module records processes about a person and
changes the master in exactly one place: the explicit completion of an employment separation.

---

## 1. Architecture

`apps/api/src/modules/lifecycle/`: `template.service.ts` (checklist templates), `onboarding.service.ts` (plans and
tasks), `probation.service.ts` (policies, cases, reviews), `offboarding.service.ts` (cases, tasks, exit interview,
separation), `lifecycle-report.service.ts` (dashboard, report), `lifecycle.routes.ts`, `lifecycle.types.ts`
(snapshots, scope, task DTOs). Shared vocabulary and pure helpers (`addCalendarDays`, `checklistProgress`,
`TASK_TRANSITIONS`) live in `packages/shared/src/lifecycle.ts`.

## 2. Employee master boundary

| Master (employees domain) | Lifecycle (this module) |
|---|---|
| `employmentStatus`, `hireDate`, `terminationDate`, position/manager history, user link | onboarding plans and tasks, probation cases and reviews, offboarding cases and tasks |
| Changed by the Employee pages, recruitment hire, and `separateEmployeeWithTx` | never written by lifecycle code except through that helper |

Completing a task, activating a plan or a case, and recording a probation outcome change nothing in the master.
There is no second employment status.

## 3. Templates

`lifecycle_templates` (ONBOARDING | OFFBOARDING, optional organization) with `lifecycle_template_tasks`: title,
description, category, assignee type (EMPLOYEE | MANAGER | HR | SPECIFIC_USER), due offset in calendar days
relative to HIRE_DATE / START_DATE (onboarding) or LAST_WORKING_DATE / CASE_START (offboarding), required flag,
order, optional document category and `requiresDocument`. A plan or case **copies** the tasks at creation; editing
the template later changes nothing already created (tested).

## 4. Onboarding lifecycle

`onboarding_plans` snapshot the employee's code, name, organization, department, job, position and manager at
creation, plus the hire date and the start date (defaults to the hire date). Tasks are copied with
`dueDate = startDate (or hireDate) + offset`. DRAFT → ACTIVE (assignees resolved and notified, employee told) →
COMPLETED (every required task COMPLETED or SKIPPED; open optional tasks are cancelled) or CANCELLED. A plan can
be started by hand for any active employee, or after a recruitment hire by passing the hired application's id;
the hire itself never creates a plan.

Progress = completed-or-skipped tasks ÷ tasks in the checklist (cancelled excluded). It is bookkeeping, not a
readiness verdict.

## 5. Task assignment

At creation and again at activation: EMPLOYEE → the employee's active account; MANAGER → the manager snapshot's
active account; HR → the plan's HR owner (default: the creator); SPECIFIC_USER → the configured user. When the
account does not exist the task stays **unassigned** (`assigneeEmployeeId` set, `assigneeUserId` null), flagged to
HR as a configuration issue; nothing is auto-provisioned. HR reassigns tasks once the account exists. Notifications
go only to resolved assignees, one per person per plan with the task count.

Task rules: PENDING → IN_PROGRESS → COMPLETED / SKIPPED / CANCELLED. The assignee (with the complete-tasks
permission) or a manager may update; reassignment and rescheduling need the manage permission; a required task can
be skipped only by a manager; a task with `requiresDocument` needs a linked document before completion. Notes are
operational ("do not enter passwords or secrets" in the UI), shown to the assignee and managers, audited by length
only. A double completion is one completion plus one 409 under the task row lock.

## 6. Document integration

A task links a Document Center document through `linkDocumentWithTx` with the entity types `ONBOARDING_TASK` /
`OFFBOARDING_TASK`. The document must be one the actor can already open (`canAccessDocument`); linking widens no
access and stores no bytes, keys or hashes in lifecycle tables. Archive and retention stay the Document Center's.

## 7. Probation

`probation_policies`: name, optional organization, duration in days, review lead days, allow extension, maximum
extension days — all configured, none hardcoded. `probation_cases` snapshot the employee context and the policy
terms, compute `originalEndDate = startDate + durationDays`, and default the reviewer to the manager snapshot's
active account. HR may reassign the reviewer while the case is open. Probation is created by HR by hand or with an
onboarding plan when asked; nothing assumes every employee has one.

### Human decision boundary

The review (`probation_reviews`) is recorded by the assigned reviewer or a probation manager with an outcome of
PASS, EXTEND or NOT_PASS, a date and an optional comment. The system computes dates and enforces the extension
limit; it reads no attendance, leave, warning, survey, performance or talent data for the decision, shows no
score and makes no recommendation. NOT_PASS records an outcome and nothing else: the employee stays active, the
account stays active, payroll is untouched, no relations case and no offboarding case is created (tested).

### History

Every review is an appended event with the previous end date; an extension moves `currentEndDate` within the
policy's maximum beyond the original end. The case shows original end, extensions, review events and the final
outcome. A transfer after the case leaves the reviewer and manager snapshot in place; the current manager is shown
beside it. The employee sees their period, current end and outcome; comments are for HR and reviewers only.

## 8. Offboarding lifecycle

`offboarding_cases`: reason code (RESIGNATION, END_OF_CONTRACT, RETIREMENT, TERMINATION, REDUNDANCY,
TRANSFER_OUT, OTHER), an HR-confidential reason note, planned and actual last working date, snapshots, HR owner,
optional exit interview (date, reason category, would rejoin, HR-confidential note). Tasks are copied from the
template with due dates relative to the planned last day or the case start. DRAFT → ACTIVE → READY_TO_COMPLETE
(every required task done; recomputed on each task change) → COMPLETED, or CANCELLED before completion. Changing
the planned last day while active shifts only pending task due dates; completed tasks keep their history.

The employee sees their own checklist, last working date, their tasks and documents they may open; not the reason
note, the exit interview, or ACCESS / PAYROLL / EXIT_ADMIN tasks unless assigned to them. Managers see the case
and their tasks, never the note. Executives see counts.

## 9. Separation transaction

"Complete employment separation" needs `offboarding.complete_separation` and a case in READY_TO_COMPLETE. In one
transaction under the case row lock: verify not already completed; `separateEmployeeWithTx` (employees domain:
lock the employee, refuse a second separation, require that direct reports and headed departments were reassigned,
set TERMINATED and `terminationDate`, close the open position and manager history rows, audit
`TERMINATE_EMPLOYEE`); `deactivateUserWithTx` (users domain: is_active=false, all sessions deleted, audit
`DEACTIVATE_USER`; refuses the actor's own account and the last System Admin) unless HR passes
`disableAccount: false`; cancel open tasks; mark the case COMPLETED with the actual last day and the account
result; audit `COMPLETE_EMPLOYMENT_SEPARATION`; notify the HR owner. Two concurrent completions produce one
termination, one deactivation and one completion; a concurrent cancel produces one terminal state and never a
terminated employee under a cancelled case (tested).

Nothing here computes final pay, severance, leave payout or tax, deletes documents, or creates a replacement
requisition. Headcount changes naturally because the master changed; finalized workforce plans are untouched.

## 10. Account and session handling

The account is disabled, not deleted, and every session is revoked in the same transaction, so an old cookie stops
authenticating immediately (tested). No external directory or mailbox is touched.

## 11. Privacy

Export carries the subject's own onboarding plans and task list, probation dates and outcomes, and offboarding
dates, status and reason code. Reviewer comments, reason notes, exit-interview notes and other people's task notes
are internal HR records and are listed under `notIncluded`. The Employee 360 shows lifecycle statuses and dates
under each process's own view permission, never a note or comment.

## 12. Permissions

| Permission | Grants | Default roles |
|---|---|---|
| `onboarding.view` / `onboarding.complete_tasks` / `onboarding.manage` | see plans in scope / work own tasks / templates, plans, assignment, activation, completion | EMPLOYEE view+tasks; MANAGER view+tasks; HR view; HR_ADMIN all |
| `probation.view` / `probation.review` / `probation.manage` | see cases in scope / submit assigned reviews / policies, cases, reviewer reassignment | EMPLOYEE view; MANAGER view+review; HR view; HR_ADMIN all |
| `offboarding.view` / `offboarding.complete_tasks` / `offboarding.manage` / `offboarding.complete_separation` | see cases in scope / work own tasks / cases, tasks, notes, exit interview / the separation | EMPLOYEE view+tasks; MANAGER view+tasks; HR view; HR_ADMIN all |
| `lifecycle.view_reports` | aggregate dashboard and report | HR, HR_ADMIN, EXECUTIVE |

Row scope follows the employee module's data scope (own record, own team, all), plus the manager snapshot for
historical access, plus tasks assigned to the reader. No role name is checked in any service.

## 13. Reporting

Dashboard (counts and, for readers with a scope, an upcoming list), report by range (onboarding started and
completed, completion rate, overdue tasks by department; probation active, due soon, outcomes by department and
month; offboarding active, upcoming departures, completed separations by reason, month and department). Report
Center datasets `onboarding_summary`, `probation_summary`, `offboarding_summary` are aggregate-only: departments,
jobs, months, statuses, counts — no names, notes or comments.

## 14. Notifications and audit

`ONBOARDING_PLAN_STARTED`, `ONBOARDING_TASK_ASSIGNED`, `PROBATION_REVIEW_REQUIRED`, `PROBATION_OUTCOME_RECORDED`,
`OFFBOARDING_STARTED`, `OFFBOARDING_TASK_ASSIGNED`, `OFFBOARDING_COMPLETED` — names, counts and dates only. Audit
actions cover every template, plan, task, policy, case, review, extension, activation, readiness, separation,
cancellation and exit-interview event in module `lifecycle`, with notes and comments recorded by length only.

## 15. Known limitations

No external onboarding portal, automated user or email provisioning, ITSM, asset inventory or device management,
background check, e-signature, automatic payroll settlement, severance or statutory termination calculation, leave
payout, external account deprovisioning, automated replacement requisition, exit-interview sentiment analysis,
automatic probation decision, or scheduled reminder engine.
