# Employee relations and disciplinary records

An operational record of what was reported about somebody, what was proposed in response, who approved it, what was
issued and when it was received.

> **This is not a legal engine.** Nothing in this module decides that an incident broke a rule, that a warning is
> warranted, what level it should be, how long it should stand or what follows if it happens again. Those are
> decisions people make under the organization's own disciplinary policy, which is the organization's — and its legal
> advisers' — to write. Retention periods, what an acknowledgement means to an employment tribunal, and every other
> employment-law question are likewise the customer's, and this document says so wherever it matters.

---

## 1. What is in it

1. **Action types** — what can be done: verbal warning, written warning, and whatever else the organization defines.
2. **A case** — one reported incident about one employee, with the employee's organization frozen on it.
3. **A disciplinary action** — a proposal on a case, which becomes an issued action only through approval.
4. **A warning letter** — the issued document, frozen at the moment of issue.
5. **An acknowledgement** — the employee's record that they received it.

## 2. Action types and policy

An action type has a code, a name, a display order, whether it produces a letter, whether it must be acknowledged,
and an optional **default** validity in days. The default is exactly that: HR may set a different validity on each
proposal, and there is no number anywhere in the code — 90 days and a year are both wrong for somebody.

The display order is **not a ladder**. The system never turns one warning into the next, never counts strikes, and
never proposes anything. What it does do is show a person deciding what already stands against the employee, so
that they can decide.

A per-organization policy names the approval workflow and, optionally, how many days an employee is given to
acknowledge. It encodes no penalty.

## 3. Cases

A case is opened by somebody with `employee_relations.manage`. It gets a server-generated number
(`ER-YYYY-NNNNNN`, from a per-year counter taken under a row lock so two cases opened at once never collide), and it
freezes the employee's code, name, organization, department, position and job as they were. A transfer next month
does not move the record.

```
DRAFT ──(proposal drafted)──► UNDER_REVIEW ──submit──► PENDING_APPROVAL ──approve──► ACTION_ISSUED ──close──► CLOSED
                                    ▲                          │
                                    └────── reject ────────────┘
```

The case narrative and HR's internal notes live in the case table and nowhere else. They never reach an audit
payload, a notification or a log — the audit records that the description changed and how long it is now.

Once a proposal has been submitted the incident details are frozen; the approver decides on what they were shown.

## 4. Disciplinary actions

One live proposal per case. It is drafted from an action type, optionally from a letter template, and is editable —
reason, validity, letter — until it is submitted. An action type that produces a letter cannot be submitted without
one.

```
DRAFT ──submit──► PENDING_APPROVAL ──approve──► ISSUED ──acknowledge──► ACKNOWLEDGED
   │                    │
   │                    └── reject ──► REJECTED (terminal for this proposal)
   └── withdraw ──► CANCELLED
```

**Nothing reaches ISSUED except a final workflow approval.** The workflow is the shared engine, `module =
employee_relations`, `entityType = DISCIPLINARY_ACTION`, using the definition named by the policy. A rejected
proposal is finished — HR drafts a new one rather than quietly editing the one that was refused. An issued action
cannot be cancelled in this release: a mistake in an issued document is a new action, not a corrected one.

## 5. The warning letter

Templates use allow-listed placeholders only — `{{employeeName}}`, `{{employeeCode}}`, `{{incidentDate}}`,
`{{actionName}}`, `{{department}}`, `{{position}}`, `{{organization}}`, `{{issuedDate}}`, `{{validUntil}}`. There is
no expression language and nothing a template author writes can run. Letters are plain text; tags are stripped on
the way in and the text is escaped on the way out.

At issue the letter becomes its own record: subject, body, the employee's details, the incident date, the action
name and the validity, all snapshotted, with a letter number. **No endpoint updates that table.** Renaming the action
type, changing the template, or moving the employee afterwards changes nothing about it.

Output is print-friendly HTML through the browser's own print dialog. There is no PDF service and no file storage.

## 6. Acknowledgement

The employee opens their own issued document and acknowledges **receipt**. The statement they agree to is fixed and
copied onto the acknowledgement:

> I confirm that I have received this document. Acknowledging receipt does not mean that I agree with its contents or
> admit to the matters described in it.

The screen says the same before the button. The employee is whoever is signed in; the endpoint takes no target and
nothing in the request can acknowledge on somebody else's behalf. Acknowledging twice returns the first record
unchanged. HR can record that an employee declined to sign, with a note — which is likewise not an admission of
anything.

An acknowledgement due date, when the policy sets one, is display and reporting only. There is no scheduler and no
reminder pretends to be one.

## 7. Validity and expiry

`validUntil` is frozen at issue from the validity that was submitted. Whether a warning is **active** or **expired**
is derived on read from that date and today's date — no job runs, no row is mutated, and the stored status stays
whatever it was. Lists and reports filter on the derived state.

## 8. Confidentiality

| Permission | Default roles | What it opens |
|---|---|---|
| `employee_relations.view` | HR, HR_ADMIN | cases, actions, history, reports — without internal notes |
| `employee_relations.manage` | HR_ADMIN | everything, including internal notes |
| `employee_relations.issue` | HR_ADMIN | submit a proposal for approval |
| `employee_relations.acknowledge` | EMPLOYEE, MANAGER, HR, HR_ADMIN | your own issued documents |

**Being somebody's manager opens nothing.** A team data scope is enough to see attendance and leave; a disciplinary
record is more sensitive than either, and the case screens require a permission that no manager holds by default.
An executive has none of these.

An **approver** sees a projection of the one proposal waiting for them — the case summary, the proposed action, the
draft letter and what already stands against the employee — and not the internal notes.

An **employee** sees only what has been **issued** to them. Drafts, refused proposals, the case narrative and the
notes are invisible; somebody else's document is a 404, never a 403 that confirms it exists.

Reports are aggregate: cases by status, actions issued, active, expired, awaiting and overdue acknowledgement, and
breakdowns by department, action type and month. There is no ranking of employees anywhere, and there will not be.

## 9. History and the Employee 360 hand-off

A case and its letter carry the employee's organization, position and job as they were. The employee's disciplinary
history is the list of actions issued to them, read through the case screens.

`erCaseService.summaryFor(employeeId)` (and `GET /employee-relations/summary/:employeeId`, behind
`employee_relations.view`) returns counts only — active warnings, total issued, latest action date, awaiting
acknowledgement — for a future Employee 360. No generic employee list calls it by default.

## 10. Privacy export

An employee's personal-data export includes an `employeeRelations` category: for each document issued to them, the
case number, category and incident date, the action, its validity, the letter as issued and their acknowledgement.
It deliberately excludes the case narrative, HR's internal notes, refused proposals and drafts (HR working records
that may concern other people) and anything about approvers. The export states this in `notIncluded`.

Nothing is deleted automatically. Retention of disciplinary records is a policy and legal decision the customer
makes; the platform sets no period.

## 11. What this module never does

- Deducts pay, suspends pay or touches a payroll component. A suspension recommendation is a record.
- Lowers a performance score or affects a review.
- Deactivates an employee, ends employment or disables a login. Offboarding is its own explicit process.
- Escalates, recommends or concludes anything.

## 12. Notifications and audit

`DISCIPLINARY_ACTION_ISSUED` tells the employee a document exists and nothing else; `DISCIPLINARY_ACTION_ACKNOWLEDGED`
tells the case owner receipt was recorded. Approvers are notified through the generic approval notification with the
case number only.

Audit actions cover the case, the proposal, submission, approval, rejection, issue, the letter, acknowledgement and
closing. Payloads carry numbers, statuses and lengths — `descriptionChanged`, `letterBodyChanged` — never the text.

## 13. Known limitations

1. No legal advice, rule engine or automatic escalation.
2. No automatic termination or any employment-status change.
3. No grievance or appeal workflow.
4. No evidence or attachment upload; no file storage.
5. No e-signature provider; acknowledgement is an in-system record.
6. No PDF generation service — print through the browser.
7. No investigation workflow or witness management.
8. No suspension or payroll integration, and no performance penalty.
9. No correction or reissue flow for an issued document.
10. No retention automation or scheduled deletion.
11. No acknowledgement reminders — there is no scheduler.
12. No executive or aggregate-only permission; executives see nothing.

## 14. Performance

Measured on the development database with 100 cases and 100 issued actions: case list with filters and the overview
report each in tens of milliseconds; the list loads each case's actions in one include rather than one query per row.

## Task 47 — report small groups (T44-P1-07)

The ER report withholds per-department counts for departments of fewer than 5 people (current active headcount), with
complementary suppression, and a department filter onto such a department withholds the whole report (`suppression`,
`actions: null`). Organization totals remain. The Report Center `employee_relations_aggregate` dataset is per-person
(`PERSON_ROWS`): it must be grouped, and groups of fewer than 5 people are withheld.

## Task 51 — the subject never handles their own case (T44-P1-19)

A case or disciplinary action about the acting user's own employee record is, for management purposes, not theirs:
lists exclude it, detail / edit / close / cancel / actions / approval view answer `404` (as for a case that does not
exist), the 360 summary of oneself is `404`, opening a case about oneself is `403 ER_SUBJECT_NOT_ALLOWED`, and a workflow
decision (approve / reject) by the subject is `409 ER_SUBJECT_CANNOT_DECIDE` even when they are the configured approver.
The employee's own flow — `/my/records`, acknowledgement — is unchanged.
