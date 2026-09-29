# Benefits, welfare and claims

Benefit plans, eligibility, enrolment, entitlement balances, reimbursement claims and payment tracking. Money is
exact, the entitlement ledger is append-only, pending claims reserve their amount so nothing can be overspent, and
approval never moves money: it makes a claim ready for a payment somebody records.

---

## 1. Architecture

`apps/api/src/modules/benefits/`: `plan.service.ts` (categories, plans, periods), `eligibility.service.ts`
(deterministic rules, preview, overrides), `enrollment.service.ts` (enrolments, entitlements, generation,
adjustments), `benefit-ledger.ts` (Decimal balance and append-only ledger under a row lock), `claim.service.ts`
(claims, submission, workflow callbacks, payment, payroll handoff, review view, My benefits),
`benefits-report.service.ts` (dashboard, report), `benefits.routes.ts` (`/api/v1/benefits/*`), `benefits.types.ts`
(scope, snapshots, claim numbers). Vocabulary, the ledger sign convention and `tenureMonths` live in
`packages/shared/src/benefits.ts`; schemas and DTOs in `packages/shared/src/schemas/benefits.ts`.

Permissions (module `benefits`): `benefits.view_own`, `benefits.claim` (employees and managers), `benefits.view`
(HR), `benefits.manage`, `benefits.review_claims`, `benefits.record_payment` (HR admin), `benefits.view_reports`
(executive, HR admin). Services check permissions and scope, never a role name.

## 2. Domain boundary

| Owner | Owns | Benefits does |
|---|---|---|
| Employee master | identity, employment status, organization, department, job, position, hire date | reads them for eligibility; snapshots them on enrolment, entitlement and claim; never writes |
| Payroll (Task 22) | periods, runs, results, components | on explicit request adds one manual earning line through payroll's own composable helper; never writes payroll tables directly; decides nothing about tax |
| Documents (Task 30) | files and access | links a claim to a receipt the claimant can already read; no bytes, no wider access |
| Workflow | approval definitions and instances | submits `benefits / BENEFIT_CLAIM` instances and reacts to their terminal callbacks; no second approval engine |
| Performance, talent, ER, lifecycle | their records | nothing — benefit usage never touches them (asserted by test) |

A benefit amount is not salary, not taxable income, not a payroll earning or deduction. Taxability, social
security, withholding and provident-fund treatment are future statutory configuration.

## 3. Money

Every amount is PostgreSQL `NUMERIC(18,2)`, `Prisma.Decimal` inside, a decimal string on the wire, through the
payroll money helper (`dec`, `money`, `toMoneyString`; two places, half-up, once). No `Number(amount)`, no
`parseFloat`, no float arithmetic anywhere in the module or the web (the browser only displays strings). Each
monetary plan has one ISO currency; a claim's currency must equal its period's snapshot; there is no conversion.
Because a plan's currency can change between periods, reports key money by the **row's** currency (the
entitlement's or claim's), never the plan's current setting. Every monetary aggregate — dashboard, report
(`byPlan[].amounts`, `byCategory[].amounts`, `claimsByStatus[].amounts`, `totals`), executive roll-up, copilot —
is per currency; amounts in different currencies are never added (Task 42 correction).

## 4. Categories and plans

Categories are labels (`benefit_categories`); no rule is derived from a name. A plan (`benefit_plans`) has a type:

- **REIMBURSEMENT** — the employee has an entitlement, spends personally, submits a claim; approval consumes.
- **ALLOWANCE** — a welfare budget tracked the same way. It is not a payroll recurring allowance.
- **COVERAGE_ONLY** — insurance or a service: eligibility, enrolment and coverage dates; no balance, no claims.

Monetary plans carry currency, default entitlement, per-claim maximum, document requirement, employee-selectable
flag, post-employment-claims flag, sensitivity (NORMAL / CONFIDENTIAL) and the claim approval workflow code (an
active definition for `benefits / BENEFIT_CLAIM`; validated). Status DRAFT → ACTIVE → INACTIVE → ARCHIVED.
Editing an active plan's money rules affects future periods only (§8).

No field exists for diagnosis, condition, disability, pregnancy, medication or treatment. The claim form tells the
employee not to enter passwords, medical diagnosis or unnecessary sensitive detail; the description is optional,
limited to 500 characters, and never copied into audit, notifications or reports.

## 5. Eligibility

`benefit_eligibility_rules` accept allow-listed employee-master dimensions only: ORGANIZATION, DEPARTMENT, JOB,
POSITION, EMPLOYMENT_TYPE, EMPLOYMENT_STATUS, MIN_TENURE_MONTHS. Rules of one type are OR-ed, types are AND-ed;
an employee who is not ACTIVE is ineligible unless an EMPLOYMENT_STATUS rule says otherwise. There is no rule type
for age, gender, religion, marital status, health, disability, pregnancy, ethnicity, union membership,
performance, warnings, talent or survey answers, so none can be configured.

`evaluateBenefitEligibility(employee, plan, asOfDate)` is pure and deterministic and returns `eligible`, matched
rule types, display-safe reason codes and messages. Eligible means "meets the criteria", never "enrolled", "paid"
or "approved". The preview (`GET /plans/:id/eligibility-preview`) counts and, on request, lists; it creates
nothing. Overrides (`benefit_eligibility_overrides`) are explicit INCLUDE / EXCLUDE decisions with a reason code
and optional note; a new decision supersedes the old row, which stays as history. Audit records the note's length.

## 6. Periods

`benefit_periods` belong to a monetary plan (DRAFT / OPEN / CLOSED, no overlap among non-closed periods).
**OPEN freezes** currency, entitlement amount, per-claim maximum and the document rule as snapshots; claims and
entitlements in that period are judged by the snapshot forever. A draft period may be edited; an open one may not.
CLOSED stops new claims; pending claims continue. No scheduler opens or closes anything.

## 7. Enrolment

`benefit_enrollments` is one row per employee and plan with status ELIGIBLE / ENROLLED / WAIVED / ENDED, source
SELF or HR, coverage dates and the employee snapshot. HR enrols an eligible active employee; an employee may enrol
themselves only when the plan is employee-selectable, and may waive such a plan. Nothing auto-enrols. A waiver is
kept, never deleted. Re-enrolment after a waiver or an end updates the same row (audited).

## 8. Entitlements and the ledger

`benefit_entitlements` is one account per employee, plan and period (unique), with currency, employee snapshot and
cached sums. `benefit_entitlement_ledger` is the truth, append-only, never updated or deleted:

| Type | Sign | Meaning |
|---|---|---|
| GRANT | + | what the period gives |
| ADJUSTMENT | ± | an explicit HR correction with a reason code (never zero) |
| RESERVE | + | a submitted claim holds this until decided |
| RELEASE | − | the hold comes back (reject, cancel, or approval converting it) |
| CONSUME | + | an approved claim spends this permanently |

`reserved = Σ RESERVE + Σ RELEASE`, `available = granted + adjustment − reserved − consumed`. Every movement runs
behind `SELECT … FOR UPDATE` on the entitlement row, so competing claims are serialized; RESERVE and negative
ADJUSTMENT are refused when they would take `available` below zero. Movements carry an `operationKey`
(`benefit-grant:<entitlement>`, `benefit-claim:<claim>:reserve|release|consume`, unique), so a retried callback
replays instead of settling twice. Audit is actor history; the ledger is the balance source.

**Generate entitlements** (HR, open period) creates one account with a GRANT for each ENROLLED employee who is
eligible as of the period start (or today, whichever is later). It is idempotent: an existing account is skipped
and never re-granted. Eligibility is evaluated then and snapshotted; a later transfer does not remove a grant
(§75); the next period evaluates the rules again. Adjustments create ADJUSTMENT rows; the grant row is never
edited.

## 9. Claims

`benefit_claims`: number `BCL-YYYY-NNNNNN` from `benefit_sequences` under a row lock; plan, period and entitlement
references; plan, category, employee, per-claim maximum, document rule and sensitivity snapshots; currency,
claimed amount, approved amount, service date, submitted date, optional description; status; workflow instance;
payment fields. Status trail in `benefit_claim_status_history` (from, to, actor, reason code; no free text).

Statuses: DRAFT → PENDING_APPROVAL → READY_FOR_PAYMENT → PAID, or SENT_TO_PAYROLL → PAID; REJECTED; CANCELLED.
**APPROVED and READY_FOR_PAYMENT are one state**: final approval makes a reimbursement ready for payment at once.

- **Draft**: the employee creates it against their own entitlement (a period must be OPEN, the employee ACTIVE
  unless the plan allows post-employment claims). No reservation, no workflow. Editable; cancellable without a
  ledger row. Nobody can create a claim for another employee.
- **Documents**: `POST /claims/:id/documents` links a document the claimant can already read (Task 30
  `canAccessDocument`), entity type `BENEFIT_CLAIM`; the link grants nobody access. The Document Center's own link
  endpoint accepts `BENEFIT_CLAIM` only from the claimant or a benefits manager while the claim is open.
- **Submit** (one transaction, §36): lock claim → verify DRAFT → validate (period open, service date inside the
  period and not in the future, currency match, amount > 0 and ≤ per-claim maximum, document present if required,
  enrolled, entitlement exists, employee active or plan allows) → lock entitlement → RESERVE with the balance
  guard → PENDING_APPROVAL → workflow submit → audit → notify. A refused submission leaves no reservation and no
  workflow. The claimed amount is immutable afterwards: change of mind means cancel and a new claim.
- **Approval** is the generic workflow (`benefits / BENEFIT_CLAIM`, chain configured per plan). The engine
  refuses self-approval. On final approval the callback locks the claim and the entitlement, appends RELEASE then
  CONSUME for the claimed amount (both idempotent by key), sets approvedAmount = claimedAmount, READY_FOR_PAYMENT.
  **Partial approval is not offered**: the generic action carries no amount, and half-working partial semantics
  were not worth a second approval path. Rejection appends RELEASE and sets REJECTED; the reviewer's comment stays
  on the workflow timeline (the claimant sees the decision, never the words).
- **Cancel**: DRAFT → CANCELLED directly; PENDING_APPROVAL → `workflowEngine.cancel` → the callback releases the
  reservation exactly once. READY_FOR_PAYMENT and later cannot be cancelled casually.
- **Review view** (`GET /claims/:id/review`): the claim, its documents (each marked accessible or not under
  Document Center rules), remaining entitlement, and the description only when the plan is NORMAL or the caller
  holds `benefits.review_claims`. Available to the approvers on the claim's workflow and to organization-wide
  reviewers. No other benefit history, salary, performance or relations data.

## 10. Reimbursement and payment tracking

Approved ≠ paid. `POST /claims/:id/payment` (`benefits.record_payment`) records method EXTERNAL / PAYROLL / OTHER,
an optional reference and the paid date, and sets PAID. It is bookkeeping: no bank API, no transfer. The audit
carries the method and the reference's length; the employee sees the method and date, not the reference.

## 11. Payroll handoff

`POST /claims/:id/send-to-payroll` needs `benefits.record_payment` **and** `payroll.manage`. It uses payroll's new
composable helper `addManualAdjustmentWithTx` (extracted from the manual adjustment endpoint; the endpoint now
calls it) to add one manual EARNING line to the employee's result in the chosen payroll period's current run,
inside the benefits transaction. Payroll's rules apply unchanged: the period is locked, the run must be in review
and not awaiting approval, the component active. The line carries `referenceType = BENEFIT_CLAIM` and the claim
id, which makes the call idempotent (a repeat returns the existing line). The claim becomes **SENT_TO_PAYROLL**,
not PAID; HR records PAID after payroll is done. Nothing here decides taxability.

## 12. Confidentiality

`adminScope(auth)` = an organization-wide data scope plus `benefits.view` / manage / review / record_payment.
Everyone else sees exactly their own rows: lists filter by the caller's employee id, details 404. A manager's TEAM
scope never opens a subordinate's claims, balances, receipts or utilization; a manager reaches a claim only as an
approver on its workflow, through the review view. Employees never see another employee's anything.

## 13. Employee 360, privacy, reports

- **Employee 360**: the subject sees enrolments, open-period balances and claim counts by status; an
  organization-wide benefits administrator sees the same; a manager opening a subordinate's 360 has no benefits
  section. No description, document or payment reference.
- **Privacy export**: the subject's enrolments, entitlements with their ledger movements, claims (amounts,
  statuses, dates, own description, payment method and reference) are exported. Reviewer comments on benefits
  workflows are redacted in the workflow section and adjustment notes are not exported; both are listed under "not
  included" with the reason.
- **Dashboard and report** (`/benefits/dashboard`, `/benefits/reports`): counts, and Decimal totals per currency by plan,
  category and claim status, organization-wide. **No department breakdown**: a department of three with one health claim is a
  person. No employee, claim number, description, document or payment reference (recursive key check in the test).
- **Report Center datasets** `benefit_enrollment_summary`, `benefit_entitlement_summary`, `benefit_claim_summary`
  are aggregate-only with exact decimal columns, organization at snapshot, no department, no person. Money columns
  declare their currency field: SUM / AVG / MIN / MAX need the currency in the grouping or an EQ currency filter
  (422 `REPORT_CURRENCY_GROUP_REQUIRED`).

## 14. Notifications and audit

Notifications: BENEFIT_ENROLLMENT_CONFIRMED, BENEFIT_CLAIM_SUBMITTED, BENEFIT_CLAIM_APPROVAL_REQUIRED,
BENEFIT_CLAIM_APPROVED, BENEFIT_CLAIM_REJECTED, BENEFIT_CLAIM_READY_FOR_PAYMENT (template only; approval sends
APPROVED), BENEFIT_CLAIM_PAID. Bodies carry claim number, plan name and status — never an amount, a description
or a receipt name.

Audit (module `benefits`): CREATE/UPDATE_BENEFIT_CATEGORY, CREATE/UPDATE/ACTIVATE_BENEFIT_PLAN,
SET_BENEFIT_ELIGIBILITY_OVERRIDE, CREATE/OPEN/CLOSE_BENEFIT_PERIOD, ENROLL_BENEFIT, WAIVE_BENEFIT,
GENERATE_BENEFIT_ENTITLEMENTS, ADJUST_BENEFIT_ENTITLEMENT, CREATE/UPDATE/SUBMIT/APPROVE/REJECT/CANCEL_BENEFIT_CLAIM,
RECORD_BENEFIT_PAYMENT, SEND_BENEFIT_TO_PAYROLL. Payloads carry ids, statuses, decimal strings and text lengths;
never a description, a document, a receipt name, a payment reference or a reviewer's comment.

## 15. Historical snapshots

A claim snapshots plan code and name, category, per-claim maximum, document rule, sensitivity and the employee's
organization, department, job and position at creation; an entitlement snapshots the employee at grant; a period
snapshots the plan's money rules at open. A plan renamed or re-priced later, or an employee transferred, leaves
history exactly as it was; reports read the snapshots.

## 16. Concurrency (tested)

Two concurrent submissions against one balance: never reserved above the balance, never negative available, each
refusal `422 BENEFIT_INSUFFICIENT_BALANCE`. Double submit of one claim: one reservation, one workflow, 409 for the
second. Double final approval: one CONSUME. Approve vs reject race: one terminal state and the ledger reconciles
with it. Double cancel: one RELEASE. Payroll handoff repeated: one payroll line.

## 17. Tests

`apps/api/tests/benefits.test.ts` (20 tests): tenure helper; categories, plans, rule allow-list and workflow
validation; deterministic eligibility, preview without side effects, historical overrides; period freeze and
plan-edit isolation, idempotent generation; adjustments; draft / document / validation / reservation on submit;
over-claim refusal and the approver's view; concurrent approval with exact ledger rows; rejection and the
approve/reject race; cancel exactly once; concurrent submissions and double submit; the 1000.10 decimal case by
raw SQL; external payment with reference minimization; payroll handoff idempotency ending in SENT_TO_PAYROLL;
coverage-only plans with self-enrol and waive; transfer snapshots; My benefits and manager blindness; executive
aggregates and datasets; Employee 360 and privacy export; audit coverage and cross-domain isolation.

## 18. Known limitations

No insurer API, hospital or provider integration, medical diagnosis management, dependent insurance workflow,
flexible-benefit marketplace, OCR receipt extraction, fraud detection, bank payment, taxability engine, statutory
benefits engine, automatic payroll treatment, FX conversion, external reimbursement provider, automated claim
adjudication, recurring payment scheduler, provident-fund or pension engine, stock or equity benefits, AI benefit
recommendation, partial approval, or department-level utilization for executives.
