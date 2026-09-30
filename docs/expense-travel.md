# Expenses and travel (Task 39)

Employee business expenses and travel requests: a policy with per-category rules, a travel request approved
before the trip, an expense report created from the approved trip (or standalone), items with receipts from the
Document Center, an exact server-side total, one approval, and then either a recorded external payment or an
explicit handoff to payroll. Expenses are **not** Benefit Claims: there is no entitlement balance, no ledger and
no period; a report is checked against policy rules, not against what remains of a grant.

Routes: HRM → Expenses & travel (`/hrm/expenses`) with tabs My expenses, Dashboard, Travel requests, Expense
reports, Policies, Categories, Payments, Reports. API base `/api/v1/expense`.

## 1. Model

| Table | Purpose |
|---|---|
| `expense_categories` | What an item can be (`GENERAL` or `TRAVEL`), with an active flag. |
| `expense_policies` + `expense_policy_rules` + `expense_policy_applicability` | One policy per set of employees: currency, effective dates, the report workflow, an optional report maximum, one rule per category (receipt required, receipt required from an amount, per-item maximum, maximum age in days, travel-only, description required) and allow-listed applicability rows. |
| `travel_policies` | Which workflow approves a trip, which expense policy the trip's report falls under, optional estimate maximum. |
| `travel_requests` | `TRV-YYYY-NNNNNN`; purpose, destination, dates, estimate, currency, status, the workflow instance, employee snapshot. |
| `expense_reports` | `EXP-YYYY-NNNNNN`; policy snapshot (code, name, report maximum), employee snapshot, currency, cached total, status, workflow instance, payment fields, payroll line id. |
| `expense_items` | Category snapshot, date, amount, merchant, description, informational original amount/currency, and the rule snapshot frozen at submission (receipt required, per-item maximum). |
| `expense_status_history` | Append-only status transitions for both entities with actor and reason code. |
| `expense_sequences` | Per-kind, per-year counters locked `FOR UPDATE` for gap-free numbers. |

Receipts are Document Center links with entity type `EXPENSE_ITEM` and relation `RECEIPT`; the file itself stays
under Document Center rules. Money is `Decimal(18,2)`, transported as strings.

## 2. Permissions

| Permission | Meaning | EMPLOYEE | MANAGER | HR | HR_ADMIN | EXECUTIVE | SYSTEM_ADMIN |
|---|---|---|---|---|---|---|---|
| `expense.view_own` | My expenses | ✓ | ✓ | ✓ | ✓ | | ✓ |
| `expense.submit` | Create, edit, submit, cancel own travel requests and reports; attach receipts | ✓ | ✓ | ✓ | ✓ | | ✓ |
| `expense.view` | Administrative lists and details (organization-wide scope only) | | | ✓ | ✓ | | ✓ |
| `expense.manage` | Categories and policies | | | | ✓ | | ✓ |
| `expense.review` | Purpose-specific reviewer view (approvers get it through the workflow step) | | | | ✓ | | ✓ |
| `expense.record_payment` | Record a payment; send to payroll (with `payroll.manage`) | | | | ✓ | | ✓ |
| `expense.view_reports` | Dashboard, aggregate report, datasets | | | | ✓ | ✓ | ✓ |

Services check permissions and data scope only, never role names. A manager's `TEAM` scope does **not** open a
subordinate's travel or expenses: a manager sees only what the workflow puts in front of them.

## 3. Policy applicability and resolution (server authority)

Applicability rows use organization, department, job, position, employment type and employment status only.
There is no field for any protected attribute. A policy applies when at least one of its rows matches the
employee. **The claimant never chooses a policy.** The server resolves it at report creation and again,
independently, at submission, so a crafted request cannot bypass the rule:

1. **Explicit configuration wins.** A report created from an approved trip uses the expense policy the trip's
   travel policy names, if the travel policy names one. That policy is still validated (active, in effect, the
   employee's organization, applicable to the employee); if it is not valid the trip cannot be expensed
   (`422 EXPENSE_POLICY_NOT_APPLICABLE`) until HR fixes the configuration.
2. **Otherwise the unique most-specific applicable policy** is used:

   | Rule type | Specificity |
   |---|---|
   | POSITION | 5 |
   | JOB | 4 |
   | DEPARTMENT | 3 |
   | ORGANIZATION | 2 |
   | EMPLOYMENT_TYPE, EMPLOYMENT_STATUS | 1 |

3. **Two applicable policies at the same top specificity are refused**: `409 EXPENSE_POLICY_AMBIGUOUS` on
   creation and on submission of an existing draft. No fallback, no employee preference, no workflow, no report.
4. **No applicable policy** is `422 EXPENSE_POLICY_NOT_APPLICABLE`. A `policyId` in the request is accepted only
   when it equals the resolved policy; anything else is `422 EXPENSE_POLICY_NOT_APPLICABLE`.
5. A draft whose policy is no longer the resolved one (HR changed applicability after the draft) is blocked at
   submission with "Your expense policy is now …; create a new report".

`GET /expense/my` returns `policyResolution` (`RESOLVED`, `AMBIGUOUS` with the tied policies, or `NONE`) and the
web form shows the assigned policy read-only or the reason nothing can be created. HR sees every current tie on the
Policies tab, computed by the same resolver over active employees (`GET /expense/policies/conflicts`), with the
instruction to update applicability before employees can submit. Task 39 adds no priority editor: refusing the
tie is the MVP behaviour.

## 4. Travel requests

`DRAFT → PENDING_APPROVAL → APPROVED | REJECTED`, `CANCELLED` from draft or pending, `COMPLETED` by the
employee from approved. Submission validates the employee (active), the travel policy (active, in effect, same
organization) and the estimate against the policy maximum, then starts the workflow named by the travel policy
(module `expense`, entity `TRAVEL_REQUEST`). Approval of a trip books nothing and pays nothing. The purpose is
visible to the owner, the approver's review view and administrators; it never enters a notification, an audit
payload, a list, a dataset or the executive report (audit stores the purpose length only).

An expense report is created from an approved trip only by the explicit "Create expense report" action. Nothing
is created automatically. The link is validated (same employee, trip APPROVED or COMPLETED). The estimate is shown
beside the actual total as context for the approver; the actual is **not** capped by the estimate.

## 5. Expense reports and items

`DRAFT → PENDING_APPROVAL → READY_FOR_PAYMENT → SENT_TO_PAYROLL | PAID`, or `REJECTED`, or `CANCELLED` from draft
or pending. `APPROVED` and `READY_FOR_PAYMENT` are the same state: the final approval makes a report ready for
payment and nothing else.

Item checks (shown as blockers while the report is a draft):

- amount above zero; per-item maximum from the category rule (exact Decimal comparison: 5000.00 passes a 5000.00
  maximum, 5000.01 does not);
- **receipt threshold is inclusive**: with `requiresReceipt` and `receiptRequiredAbove = 500.00`, an item of
  499.99 needs no receipt and an item of 500.00 does; with `requiresReceipt` and no threshold every item needs one;
- description required, travel-only category on a report without a trip, maximum age in days, expense date in
  the future.

Report checks: at least one item, policy active and in effect today, the optional report maximum (exact Decimal:
a 5000.00 total passes a 5000.00 maximum, 5000.01 does not), the policy re-resolution above, and the trip link.
The maximum-age rule is inclusive: with `maximumAgeDays = 30` an item dated exactly 30 days before the business
date (Asia/Bangkok) is allowed and one dated 31 days before is blocked, on the item and again at submission. The total is always the server's Σ of the item amounts (a cached copy is kept on the report and rechecked at
submit; the items are the truth). The browser never computes money.

Submission runs in one transaction: lock the report, recompute the blockers, freeze the rule snapshots on each
item and the policy snapshot on the report, set `PENDING_APPROVAL`, start the workflow (module `expense`, entity
`EXPENSE_REPORT`), write history, audit and notifications. A second concurrent submit sees the lock and gets
`409 EXPENSE_REPORT_NOT_DRAFT`; one workflow instance exists. Items, receipts and the title are immutable after
submission; a later policy edit does not change a submitted report.

There is **no partial approval**: the approver approves the report as a whole or rejects it with a comment, and
the employee corrects and submits a new report. Rejection is terminal. The approver's comment stays on the
workflow timeline and is never copied to the report, the notification or the privacy export.

## 6. Payment and payroll

Approval does not pay. Two explicit actions exist, both for `expense.record_payment` with organization-wide
scope:

- **Record payment** (`POST .../payment`): method, optional reference, paid date → `PAID`. Bookkeeping only; no
  transfer is made, the reference is stored on the report and only its length is audited.
- **Send to payroll** (`POST .../send-to-payroll`, also needs `payroll.manage`): adds one manual **earning** line
  to the employee's result in the chosen period through the payroll module's own helper, with the report as the
  reference. The helper is idempotent by reference, so two concurrent calls create one line; the report becomes
  `SENT_TO_PAYROLL`, never `PAID`, because payroll has not run. Payroll rules apply unchanged: the run must be in
  review without a pending approval and the component must be an active earning. Payment is recorded as `PAID`
  after payroll is done.

No tax decision is made anywhere in the module.

## 7. Confidentiality

- Employees see their own records. Managers see their own records plus the approver queue; they cannot list or
  open a subordinate's trips or reports (`404`), and the team lists return zero.
- Approvers use `GET .../review`, which returns the report or trip with items, receipt links (marked accessible
  or not by Document Center rules), the trip context and the purpose. A manager of another team gets `404`.
- Executives get the dashboard, the aggregate report (by policy, category, month; travel counts and estimated
  totals) and the datasets. No employee, department, purpose, destination, merchant, description, report number
  or payment reference appears in any of them (tested by a recursive key check).
- Employee 360 has **no expense section** by decision: spend is not a personal-history fact and the 360 already
  carries the lifecycle, benefits and relations sections that the source modules gate.
- Audit stores identifiers, amounts, statuses and text lengths only.
- Notifications (ten types) carry the number and the status, never the purpose, an amount reference or a comment.
- Privacy export includes the employee's own trips (with purpose), reports, items and payment records, and lists
  approver comments as not included.

## 8. Report Center datasets

`travel_request_summary`, `expense_report_summary`, `expense_category_summary` (one row per item of a submitted
report). Aggregate-only, `expense.view_reports` or `expense.manage`, organization snapshot only, no department,
person, number, purpose, merchant or description.

## 9. Performance

Load seed on the load organization: 500 approved trips, 1,000 reports (500 linked to trips), 5,000 items. With
that data the employee page, administrative lists, report detail, dashboard and the year aggregate answer in
under 100 ms; the three datasets in under 100 ms. Indexes: employee+status, status+submitted date, policy+status,
trip, paid date, trip dates.

## 10. Tests

`apps/api/tests/expense.test.ts` (16 tests): categories, policy rules, workflow validation, protected-attribute
refusal; server-side resolution (most specific wins, the claimant cannot name another policy, an equal-specificity
tie is `EXPENSE_POLICY_AMBIGUOUS` on create and on submit with no report or workflow created, HR conflict list,
stale draft blocked); travel-linked policy used and validated; report maximum 5000.00 / 5000.01 and age 30 / 31
days under a fixed clock; travel request lifecycle with purpose-free
notifications and audit and the other manager's `404`; explicit report-from-trip; per-item maximum and inclusive
receipt boundary; stranger's receipt `404` and the approver's non-access to the file; submission freeze,
immutability, double submit and a policy edit after submission; double approve; external payment with reference
minimisation; 333.37 + 666.73 = 1000.10 by API and raw SQL, estimate not a cap, rejection terminal; approve/reject
race, cancel exactly once, draft cancel without a workflow, description rule; payroll handoff permissions,
idempotency, one line of 2000.00, `SENT_TO_PAYROLL` then `PAID`; transfer snapshot and terminated employee;
manager blindness and list totals; executive aggregates, recursive key check, datasets and denials; privacy
export, no 360 section, audit coverage and minimisation, cross-domain isolation.

## 11. Known limitations

No OCR or receipt extraction, no FX conversion (original amount and currency are informational only), no
per-diem or mileage engine, no corporate-card or bank feed, no advance or cash-float handling, no booking or
itinerary integration, no budget or cost-centre accounting, no tax or VAT decision, no partial approval or
line-item approval, no multi-currency report, no delegation of approval, no reminder scheduler, no policy
versioning beyond effective dates, no policy priority editor or policy selection groups (ties are refused), no department-level spend for managers or executives, and no Employee 360
section.

## Task 48 — payroll handoff integrity and currency-keyed travel estimates (T44-P1-14, P1-15, P2-15)

- Same guarantees as benefits: the report's payroll line is immutable in payroll (`409 PAYROLL_ITEM_SOURCE_LINKED`,
  `ON DELETE RESTRICT`, stable id across recalculation), the report currency must equal the run currency
  (`409 PAYROLL_CURRENCY_MISMATCH`), a `SENT_TO_PAYROLL` report cannot be cancelled and can only be recorded as paid
  through payroll (`409 EXPENSE_REPORT_IN_PAYROLL`). A concurrent delete and recalculation leave the one linked line.
- Reports API: `travel.estimatedTotal` (a sum over every currency) is removed; `travel.estimatedByCurrency` and
  `travel.byMonth` (now `{ month, currency, … }`) are the figures. The web shows them per currency.
