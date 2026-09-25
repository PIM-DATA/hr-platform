# Employee services: service requests and HR letters (Task 40)

Employees ask HR for something and follow what happens to it; HR works the request in a queue and, where the
request is for a document, issues a letter. Two rules shape everything here.

**A request is a record, not an instruction.** Completing a request records what HR did. It never writes to the
employee master, payroll, leave, benefits, expenses, performance or any other domain. If an employee asks for an
address change, HR changes the address in the employee module under that module's own authority and then closes
the ticket. The ticket is the paper trail, not the mechanism.

**A letter is a frozen snapshot.** Its text is rendered on the server, at the moment of issue, from an
allow-listed token registry. Nothing in a template is ever executed. Once issued, the letter never changes: a
later template edit, transfer or pay rise affects only letters issued afterwards.

Routes: HRM → Employee services (`/hrm/services`) with tabs My requests, My letters, Dashboard, Requests,
Service catalog, HR letters, Letter templates, Reports. API base `/api/v1/employee-services`.

## 1. Domain boundary

| Employee services owns | It does not own |
|---|---|
| The service catalogue and its form fields | Employee profile data (Task 3–7) |
| Service requests, their status and assignment | Compensation and payroll (Task 22) |
| The request conversation and internal notes | Leave balances, benefits, expenses |
| Fulfilment records | Recruitment records |
| HR letter templates and issued letters | Document bytes (Task 30 stores every file) |

## 2. Model

| Table | Purpose |
|---|---|
| `service_request_types` + `service_request_type_fields` | The catalogue: category, optional approval workflow, target days, attachment rule, fulfilment type (`GENERAL` or `HR_LETTER`), the letter template for a letter type, and the questions the employee answers. |
| `service_requests` | `SR-YYYY-NNNNNN`; employee and request-type snapshots, subject, description, status, assignee, workflow instance and result, submitted and due dates. |
| `service_request_values` | One answer per field, with the label, type and visibility frozen at submission. |
| `service_request_messages` | Append-only conversation, each row `REQUESTER_VISIBLE` or `INTERNAL`. |
| `service_request_status_history` | Append-only status trail with actor and reason code; no free text. |
| `hr_letter_templates` | Plain-text body and optional subject with `{{tokens}}`; `requiresSalaryAccess` is derived from the tokens, never supplied. |
| `hr_letters` | `HRL-YYYY-NNNNNN`; template and employee snapshots, the rendered subject and body, an exact salary snapshot where applicable, issue date, issuer, status and void reason. |
| `service_sequences` | Per-kind, per-year counters locked `FOR UPDATE` for gap-free numbers. |

Attachments are Document Center links with entity type `SERVICE_REQUEST`; a signed or scanned copy of a letter
links with `HR_LETTER`. No file bytes are stored in these tables.

## 3. Permissions

| Permission | Meaning | EMPLOYEE | MANAGER | HR | HR_ADMIN | EXECUTIVE | SYSTEM_ADMIN |
|---|---|---|---|---|---|---|---|
| `service_request.view_own` | My requests | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `service_request.create` | Create, edit, submit, withdraw my own | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `service_request.view` | The queue, submitted values and internal notes | | | ✓ | ✓ | | ✓ |
| `service_request.fulfill` | Assign, answer, fulfil, decline | | | ✓ | ✓ | | ✓ |
| `service_request.manage` | The catalogue and its form fields | | | | ✓ | | ✓ |
| `hr_letter.view_own` | My letters | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `hr_letter.issue` | Issue and void letters | | | | ✓ | | ✓ |
| `hr_letter.manage_templates` | Letter templates | | | | ✓ | | ✓ |
| `hr_letter.view_reports` | Dashboard, aggregate report, datasets | | | | ✓ | ✓ | ✓ |

Services check permissions and data scope only, never role names. The queue and the catalogue additionally need an
organization-wide data scope. A manager's `TEAM` scope opens nothing here.

## 4. Request lifecycle

`DRAFT → SUBMITTED → IN_PROGRESS → WAITING_EMPLOYEE → FULFILLED`, with `REJECTED` and `CANCELLED` as the other
terminal states. The employee owns the draft and may edit or withdraw it; they may also withdraw a submitted
request before HR starts on it.

Submission is one transaction: lock the request, verify it is a draft, validate the answers and the attachment
rule, freeze the request-type semantics onto the request, start the optional workflow, set `SUBMITTED`, write the
status trail, audit and notify. A second concurrent submit sees the lock and gets
`409 SERVICE_REQUEST_NOT_DRAFT`, so there is one transition, one workflow and one notification.

**Target days and overdue.** A request type may carry `targetDays`. The due date is `submitted + targetDays` in
**calendar days**; no working-day calendar is applied. "Past target" is derived when the request is read. Nothing
escalates automatically and there is no scheduler.

## 5. Configurable form fields

A field is data, never behaviour. The allow-listed types are `TEXT`, `TEXTAREA`, `DATE`, `SELECT`,
`MULTI_SELECT`, `BOOLEAN` and `NUMBER`. There is no code, HTML, SQL, expression language or customer-supplied
regular expression anywhere. `SELECT` and `MULTI_SELECT` carry a fixed option list and an answer must come from
it; a `DATE` must be `YYYY-MM-DD`; a `NUMBER` must parse; a text answer respects its maximum length. An answer
for an unknown key is refused.

**Snapshot.** Each stored answer carries the field's label, type and visibility as they were at submission, so a
later catalogue edit never changes what a historical answer meant. The request also keeps the type's code, name,
category, fulfilment type and target days.

## 6. Optional approval, and approval versus fulfilment

A request type may name a workflow definition of module `employee_services`, entity `SERVICE_REQUEST`. The
generic engine (Task 8) runs it; there is no second approval engine and it refuses self-approval.

Approval **authorises**; HR still **fulfils**. On approval the request keeps its fulfilment status `SUBMITTED`
and records `workflowStatus: APPROVED` plus a `WORKFLOW_APPROVED` entry on its trail. Fulfilment is refused with
`409 SERVICE_REQUEST_NOT_APPROVED` until that has happened. A workflow rejection or cancellation closes the
request, because there is nothing left to fulfil. A request type without a workflow goes straight to the queue;
no fake workflow is created.

## 7. Queue, assignment and messages

The queue filters by status, category, assignee, past-target and free text. Assignment is a row-locked write, so
two fulfillers racing produce one deterministic assignee and one status entry; assigning a person who cannot
fulfil requests is refused. **Being assigned a request grants nothing**: the assignee still needs their own
permissions in payroll, the employee master or anywhere else.

The conversation is append-only with two visibilities. `REQUESTER_VISIBLE` reaches the employee and the
fulfilment team. `INTERNAL` never leaves the fulfilment team: it is filtered out of every employee response, it
is excluded from the privacy export, and an employee attempting to write one is refused. A manager reads neither,
an executive reads neither, and audit records only that a message exists and how long it was.

## 8. Attachments

The employee links a document they can already open; linking never widens access to the file. A document they
cannot read is `404`. The fulfiller sees the link and opens the file only if Document Center rules allow it, which
the response states per attachment. A closed request takes no further attachments.

## 9. HR letter templates and the token registry

A template is plain text with `{{token}}` placeholders. The registry is owned by the server and is the complete
set of values a letter may contain:

| Non-sensitive | Sensitive (needs the payroll authority) |
|---|---|
| `employee.fullName`, `employee.firstName`, `employee.lastName`, `employee.employeeCode` | `compensation.baseSalary` |
| `employment.hireDate`, `employment.status`, `employment.type` | `compensation.currency` |
| `organization.name`, `department.name`, `job.title`, `position.title` | `compensation.salaryType` |
| `letter.number`, `letter.issueDate` | |

Anything else between double braces is refused with `422 HR_LETTER_UNKNOWN_TOKEN` when the template is saved, and
an unbalanced brace pair with `422 HR_LETTER_TEMPLATE_MALFORMED`. `{{sql:…}}`, `{{employee.password}}`,
`{{__proto__}}`, `{{constructor}}` and any unknown path are all simply unknown tokens. There is no expression
language, function call, loop, conditional or dynamic property traversal, and resolved values are held in a `Map`,
so a hostile key can never reach an object prototype. At render time an unknown or unresolved token throws rather
than emitting a blank.

The output is plain text. The web layer renders it with `white-space: pre-wrap` and never uses
`dangerouslySetInnerHTML`, so a hostile string such as `<script>alert(1)</script>` in an employee's name appears
as literal characters.

## 10. Employment certificate and salary certificate

An employment certificate uses identity and employment facts: name, employee code, hire date, employment status
and type, organization, department, job and position. It carries no salary. The wording belongs to the customer;
nothing in the code asserts that any particular text is legally valid anywhere.

A salary certificate additionally uses authoritative compensation. **Issuing it requires `hr_letter.issue` and
`payroll.manage`**, the same permission that guards `/payroll/compensations`. Fulfilling tickets is never a
salary back door: a letter clerk who may triage the request and issue non-salary letters is refused with `403`
on a salary-bearing one, through the request or directly.

The figure is the `EmployeeCompensation` row in effect **on the issue date** (`effectiveFrom <= issueDate` and
`effectiveTo` null or on or after it), snapshotted as an exact two-decimal string, for example `30612.50`. If no
authoritative compensation is in effect the issue is refused with `409 COMPENSATION_NOT_FOUND`. Nothing is
inferred from a payslip, a net figure, an annual package or a tax base.

## 11. Issuing, snapshots, void and reissue

Issuing runs in one transaction: lock the linked request if there is one, verify the employee and the active
template, resolve only the tokens the template uses, check the sensitive-token permission, render on the server,
write the immutable letter row, audit, notify the employee and link the request. Nothing in the employee master or
payroll is touched.

For an `HR_LETTER` request type, **issuing and fulfilling are the same atomic action** under the request's row
lock: there is never a fulfilled request without its letter, and two concurrent fulfil calls yield one letter, one
transition and one notification; the loser gets `409`.

An issued letter is never edited or deleted. A mistake is **voided** with a reason code, keeping its row, its
number and its text, and a corrected letter is **reissued** with a new number. The employee is told about both.

## 12. Print view

The letter opens as a sheet showing the organization, the reference number, the issue date, the subject and the
body, with a void banner when it applies. Printing uses the browser: the print stylesheet hides the application
chrome and paints the sheet alone on A4. There is **no server-generated PDF**, no electronic signature and no
statutory certification claim; the footer says so. HR may optionally link a signed or scanned copy back to the
letter through Document Center, which is a document, not a signature the system applied.

## 13. Confidentiality

- Employees see their own requests, their own visible messages, their own attachments and their own letters.
- Managers see their own only. A manager reaches a subordinate's request solely as an approver on its workflow,
  through `GET /requests/:id/review`, which shows the facts and the employee-visible answers and no internal note.
- Executives get the dashboard, the aggregate report and the datasets. No employee, request number, letter number,
  subject, answer, message, letter body or salary appears in any of them, which a recursive key check asserts.
- **Employee 360 has no service-request or HR-letter section, by decision.** The 360 is a view of an employee's
  record for people who already hold the source-domain permissions; adding ticket activity would turn it into a
  surveillance surface over what someone asked HR, which is not what it is for.
- Audit records identifiers, codes, statuses, counts and text lengths. It never carries a description, a field
  answer, a message body, an internal note, a rendered letter body or a salary amount.
- Notifications carry the number, the type and the status only.

## 14. Privacy export

The subject's export includes their service requests with the answers they submitted, the messages they could
see, the append-only status trail, the outcome and decline reason, and their issued letters including the letter
text and, on their own salary certificate, the salary figure, because that is their own personal data. Internal
HR notes and approver comments on the workflow timeline are excluded and stated in `notIncluded`. Document bytes
stay with Document Center.

## 15. Reporting

`GET /dashboard` and `GET /reports` give counts, months and averages. Two Report Center datasets are
aggregate-only and need `hr_letter.view_reports` or `service_request.manage`: `service_request_summary` (type,
category, organization, submitted and fulfilled months, status, fulfilment type, past-target flag, days to
fulfil) and `hr_letter_summary` (letter type, template, organization, issue month, status, whether it came from a
request). Neither carries a person, a number or any text a requester wrote.

## 16. Performance

Load seed on the load organization: 1,000 service requests, about 2,000 messages, 2,200 status rows and 500
letters. With that data every page answers in well under 100 ms, including the employee page, the HR queue with
and without the past-target filter, request detail, both letter lists, the dashboard, the year aggregate and both
datasets.

## 17. Tests

`apps/api/tests/employee-services.test.ts` (18 tests): template token safety including injection attempts, unknown
paths and malformed braces, and derived salary sensitivity; catalogue field validation, workflow module checks and
the letter-template requirement; draft, answer validation, frozen answers, double submit; required answers and the
attachment rule; approval authorising without fulfilling; assignment concurrency and the fulfiller check; internal
versus visible messages with manager and executive blindness; catalogue edits not changing history; general
fulfilment leaving the employee master untouched; withdrawal and decline; atomic letter fulfilment with concurrent
double issue; the salary authority gate with the exact `30612.50` snapshot and the effective-date rule; template,
employee and salary changes affecting only later letters; void and reissue; a hostile name as literal text;
access for employee, manager, HR and executive; the privacy export with internal notes excluded; audit coverage
and minimisation; and cross-domain isolation.

## 18. Known limitations

No public or external request portal, no email or SMS ticketing, no chatbot intake, no automated SLA escalation
or scheduler, no AI ticket classification or reply drafting, no external ITSM or IT service desk, no asset or
procurement fulfilment, no arbitrary workflow scripting, no arbitrary template expressions, no automatic
source-domain updates of any kind, no electronic signature, no public certificate verification or QR check, no
document OCR, no server-generated PDF (the letter is a browser print of a plain-text snapshot), no advanced
document designer or mail-merge engine beyond the allow-listed tokens, no external document delivery, no
per-request SLA reporting beyond the derived past-target flag, and no multi-language letter selection.
