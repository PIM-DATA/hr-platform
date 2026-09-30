# Compensation planning / salary review (Task 43)

Salary-review cycles: a frozen population, proposed base salaries entered by planners, HR review against a budget
ceiling, a frozen plan, and an explicit, separately authorized Apply that alone writes new salary records.

> **High-impact principle.** People decide every number. The system snapshots facts, derives the increase from the
> salary a person entered, checks it against the budget and keeps an append-only history. It never recommends a
> salary or a percentage, never ranks or scores anyone, never infers performance, potential, retention or anything
> else about a person, never uses protected attributes, and never changes a salary on its own.

## 1. Domain boundary

| Owned here | Owned elsewhere (read, never duplicated as a source of truth) |
|---|---|
| review cycles, population snapshots, budget pool, proposals, planner assignment, HR review, finalization, the Apply handoff | salary history and payroll calculation — **Payroll** (`employee_compensations`, Task 22); finalized review results — **Performance** (Task 23); employee, organization, department, job, position, manager — **Employee master** |

Apply goes through the payroll source service (`applyCompensationChangesWithTx` in
`apps/api/src/modules/payroll/payroll-master.service.ts`); this module never writes `employee_compensations` itself.
Talent / potential / 9-box, employee relations, engagement, benefits, expenses and service requests are **not shown
and not used** here.

## 2. Lifecycle

`DRAFT → ACTIVE → REVIEW → FINALIZED → ARCHIVED`

| State | What happens | Who |
|---|---|---|
| DRAFT | name, effective date, currency, "show performance context"; population preview; explicit exclusions; budget | `manage_cycles`, `manage_budget` |
| ACTIVE | planners enter and submit proposals for the rows assigned to them | planners (`plan`) |
| REVIEW | HR returns, changes (with a reason) and approves proposals; returned rows go back to the planner | `review` |
| FINALIZED | every proposal approved, Σ increase within budget; plan frozen; **no salary changed** | `finalize` |
| ARCHIVED | history (from FINALIZED) or an abandoned draft; an archived cycle can no longer be applied | `manage_cycles` |

Batch-shaped by nature, the review uses explicit cycle and proposal states under row locks rather than the generic
workflow engine (which would create a per-employee approval instance for what is one reviewed plan).

## 3. Population

At activation, in one transaction under the cycle's row lock:

- candidates = ACTIVE employees of the cycle's organization, minus HR's explicit exclusions;
- the salary record in effect **today** (the baseline date) is resolved through `employee_compensations`;
- eligibility is a fact: `ELIGIBLE`, `MISSING_COMPENSATION` (no record, or not positive — never treated as 0),
  `CURRENCY_MISMATCH` (never converted);
- snapshot per person: code, name, organization, department, job, position, manager, employment type, the salary
  record id, amount, currency and its start date;
- planner = the manager's active user account at activation (none if the manager has no active account);
- a `NOT_STARTED` proposal with **no value** is opened for every eligible person.

Performance, potential, age, gender, tenure, discipline and every other personal attribute play no part in inclusion.
Double activation is serialized by the row lock and the unique (cycle, employee) key. Later changes to the employee
master (department, job, manager, salary) do not rewrite the snapshot.

## 4. Budget

One organization pool per cycle: a ceiling on Σ(proposed − current) in the cycle currency. It reserves no payroll
money, creates no accounting commitment and guarantees nobody an increase. `used` is one database aggregate over
proposals with a value; `remaining = budget − used`, exact Decimal (e.g. 1000.10 − (333.37 + 666.73) = 0.00).
Enforced at planner submit, HR change and finalize (`409 COMP_BUDGET_EXCEEDED`). Base salary only: no annual cost,
tax, social security, bonus or benefit modelling.

## 5. Proposals

- The only entered value is `proposedBaseSalary` (a decimal string). `increaseAmount = proposed − current` (2 dp) and
  `increasePercent = increase ÷ current × 100` (stored 4 dp half-up, shown 2 dp) are derived server-side.
- `proposed ≥ current`: equal means no increase (a valid answer); a decrease is refused (`422 COMP_DECREASE_NOT_ALLOWED`) — a reduction is a different process.
- No current salary → no proposal (the row is not plannable; HR fixes the salary source outside the cycle).
- States: `NOT_STARTED → DRAFT → SUBMITTED → HR_REVIEW → APPROVED`, with `RETURNED` from HR back to the planner.
- A planner edits rows not yet submitted while ACTIVE, and only rows HR returned while in REVIEW.
- Submit needs every row the planner holds to carry a value, and the cycle within budget.
- Optional planner note (≤ 500 chars): seen by that planner and HR review only; never in reports, audit, notifications
  or the privacy export.
- History (`compensation_proposal_history`) is append-only: SAVED, SUBMITTED, RETURNED, OVERRIDDEN, APPROVED, APPLIED,
  with old/new proposed salary, actor and reason code.

## 6. Performance context

When the cycle allows it and the reader holds `performance.view`, each row shows the latest **finalized** Task 23
review (cycle, score, rating), labelled "Performance context". Draft reviews are never shown; a person without a
finalized review shows nothing and is not blocked. No formula, matrix or sort reads it.

## 7. HR review

The HR grid lists every row, filterable by department, planner, status and plannability, ordered by department and
name only (no "top increase", no ranking). HR may return a proposal (reason code), change it (new salary + reason code;
the proposal returns to HR_REVIEW and the change is recorded), approve one, or approve all under review (optionally
per planner or department). Planner reassignment is explicit, requires a reason and a user holding
`compensation_planning.plan`, and is recorded in `compensation_planner_assignments`.

## 8. Finalize ≠ Apply

Finalize freezes the approved plan. **No salary changes at finalization.** Apply is a separate action.

## 9. Apply

- Needs `compensation_planning.apply` **and** `payroll.manage` (the authority over `/payroll/compensations`).
- One transaction under the cycle's row lock. A preflight checks every row with an increase:
  - `SOURCE_COMPENSATION_CHANGED` — the baseline record is no longer the employee's latest open record with the same amount and currency (e.g. someone changed 30,000 to 32,000 manually; the plan of 31,500 is **not** applied);
  - `EMPLOYEE_NOT_ACTIVE` — terminated or inactive since activation;
  - `COMPENSATION_IN_USE` — a payroll run already paid the baseline past the day before the effective date.
  One blocker → `409 COMP_APPLY_BLOCKED` with the list; nothing is written. `GET …/apply-preview` shows the same list.
- Otherwise, through the payroll service: row-lock the employees' salary records, re-check, close each baseline the
  day before the effective date, create the new record from the effective date (note `Salary review <code>`), audit
  in the payroll module. Old records keep their amounts.
- Zero-increase rows are marked applied with no new record.
- Idempotent: the cycle's `appliedAt` and each proposal's `appliedCompensationId` (unique). A second Apply — concurrent
  or later — gets `409 COMP_CYCLE_ALREADY_APPLIED`; no duplicate records.
- A transfer after finalization does not block (salary belongs to the employee; the planning snapshot keeps the old
  department). Payroll picks the new record up through its own period resolution.

## 10. Permissions

| Permission | Grants | Default roles |
|---|---|---|
| `compensation_planning.view_team` | see rows assigned to me as planner | MANAGER, HR, HR_ADMIN |
| `compensation_planning.plan` | enter and submit proposals on my rows | MANAGER, HR, HR_ADMIN |
| `compensation_planning.review` | HR grid, return, change, approve (with an ALL data scope) | HR, HR_ADMIN |
| `compensation_planning.manage_cycles` | create, population, activate, reassign planner, archive | HR_ADMIN |
| `compensation_planning.manage_budget` | set the budget | HR_ADMIN |
| `compensation_planning.finalize` | finalize | HR_ADMIN |
| `compensation_planning.apply` | apply (plus `payroll.manage`) | HR_ADMIN |
| `compensation_planning.view_reports` | aggregate reports and the Report Center dataset | HR, HR_ADMIN, EXECUTIVE |

EMPLOYEE has none. Services check permissions and scope, not role names. **SYSTEM_ADMIN holds none of these**
(separation of duties: administering RBAC is not salary authority). It still assigns MANAGER / HR / HR_ADMIN /
EXECUTIVE through `roles.manage` — the role-grant guard lets a `roles.manage` holder grant business permissions it does
not hold, never administration ones or a role that itself carries `roles.manage` (README, "Authorization"). Granting
compensation permissions to an administrator is a deliberate, audited change made by **another** administrator: since
Task 45 an administrator cannot give themselves these permissions, neither by assigning themselves a role nor by editing
a role they hold (docs/account-security-rbac.md). No `view_own`
permission exists: employees see nothing of planning in this release.

## 11. Confidentiality and visibility

- A planner sees only rows where they are the assigned planner — not other teams, not organization totals, not other
  planners' proposals (another row is `404`). A manager's TEAM scope opens nothing by itself.
- HR administration requires an organization-wide data scope plus a compensation HR permission.
- Employees see no draft, proposal, budget or note. After Apply, the new salary is visible wherever salary history
  already is (payroll rules). No Employee 360 section; no copilot tool.
- Executive: aggregate reports only.

## 12. Reporting

`GET /compensation-planning/reports/cycles/:id`: population, completion, Σ current base, Σ increase, base after plan
(current + increase), approved increase, weighted average increase % (Σ increase ÷ Σ current of rows with a value),
budget / used / remaining. The per-department split (department at activation) is returned only to compensation HR —
for an executive a small department's total could be one salary. Report Center dataset
`compensation_planning_summary`: one row per non-draft cycle, organization level; money columns carry the currency
(Task 42 guard: no cross-currency sums).

## 13. Notifications, audit, logging, privacy

- Notifications `COMP_PLAN_CYCLE_OPENED / MANAGER_SUBMITTED / RETURNED / READY_FOR_REVIEW / FINALIZED / APPLIED` carry
  the cycle name only — never a salary, increase, percentage, note or count.
- Audit (`module = compensation_planning`): ids, statuses, reason codes, counts, currency, the budget ceiling. Never an
  individual salary, proposed salary, increase or note (only whether a note changed and its length). The salary
  records Apply creates are audited by the payroll module, as every salary change is.
- Logs carry operational metadata only.
- The privacy export excludes salary-review planning records (listed under `notIncluded`); applied salaries appear in
  compensation history per the payroll export rules.

## 14. Performance (measured, not an SLA)

1,000-employee cycle, local PostgreSQL: activation 245 ms · planner sheet 8 ms · HR page (50 rows) 11 ms · budget
aggregation 12 ms · approve all 66 ms · finalize 42 ms · apply preview 27 ms · **apply 1,000 changes 1.16 s** in one
transaction · report 10 ms. Batch queries throughout (population, baselines, locks); Apply writes two rows and two
audit events per changed employee.

## 15. Known limitations

Base salary planning only — no bonus, commission, equity/stock, total rewards, tax, social security or annual-cost
modelling; no market benchmark data, salary ranges / grades engine or pay-equity analysis; no AI or rule-based
recommendation and no merit matrix; no promotion workflow; no salary decreases through a review; one currency per
cycle, no FX; one organization budget pool (no department or manager allocations); no employee compensation
statement or letter generation; no Finance/ERP budget integration; no employee self-service view of proposals; no
copilot access to planning; Apply is all-or-nothing (reconcile blockers, then apply again).
