# Payroll

How a month's pay is calculated, checked, approved and frozen — and, just as importantly, what this release does
**not** calculate.

> **This release calculates no statutory amounts.** There is no withholding tax, no social security, no provident
> fund, no bank transfer file and no accounting posting. Those amounts are **absent, not approximated**: nothing here
> estimates them, and no output of this module may be filed with an authority as if it had. Every payslip says so in
> as many words.

---

## 1. What payroll is, and what it is not

Payroll turns things that already happened — a salary, an allowance, approved overtime, unpaid leave, absence,
lateness — into an amount per employee, per month, that somebody can be paid. It does this **once**, records what it
was calculated from, has it reviewed and approved, and then closes it for good.

It is a money domain, so three properties come before everything else:

- **Exact.** Every amount is a `NUMERIC` in the database, a `Prisma.Decimal` in the service and a decimal *string* on
  the wire. No amount is ever a JavaScript number; `0.1 + 0.2` problems do not exist here because floats do not.
- **Deterministic.** The same inputs produce the same satang. Rounding happens once, at the line, half-up.
- **Auditable and immutable.** A payslip explains itself from its own stored lines, and a closed run never changes —
  not when a salary changes tomorrow, not when a component is renamed, not ever.

Single currency (`THB` by default, configured per policy), monthly frequency only.

## 2. Money and rounding

| Thing | Scale | Rounding |
|---|---|---|
| Amounts (gross, deductions, net, every line) | 2 | half-up |
| Derived rates (daily, hourly, minute) | 6 | half-up |
| Quantities (days, leave units) | 2 | half-up |

Rates come from the payroll policy, never from a constant in the code:

```
dailyRate  = baseSalary / monthlyDivisorDays
hourlyRate = dailyRate / dailyWorkHours
minuteRate = hourlyRate / 60
```

Nothing assumes 30 days, 26 days or 8 hours. A customer who divides by 26 changes one field and every rate follows.

Rounding is applied **once per line**, never to an intermediate. 30,000 ÷ 30 ÷ 8 ÷ 60 = 2.083333 per minute; 120
minutes of overtime at ×1.5 is `120 × 2.083333 × 1.5 = 374.99994 → 375.00`. Rounding the minute rate to two places
first would have produced 374.40 and paid somebody sixty satang less every month.

## 3. Compensation history

A salary is a **record with a period**, not a field on the employee. A raise closes the old record with an end date
and opens a new one — the previous amount is never edited, because a payslip from March must still explain itself in
December. Once a payroll run has used a compensation record it is marked *in use*, and only its end date and note can
change.

A period must resolve to **exactly one** salary. A salary change in the middle of a period is refused
(`PAYROLL_COMPENSATION_SPLITS_PERIOD`) rather than prorated by a rule nobody has agreed: date the change from the
first of a month, or use a manual adjustment.

## 4. Pay components

A component is what a payslip line can be: an earning or a deduction, with a stable code.

**System components** are the engine's own and exist on every deployment: `BASE_SALARY`, `OT_PAY`,
`UNPAID_LEAVE_DEDUCTION`, `ABSENCE_DEDUCTION`, `LATE_DEDUCTION`, `MANUAL_EARNING`, `MANUAL_DEDUCTION`. They cannot be
deleted or deactivated and are re-created if missing.

**Custom components** are the customer's: allowances, standing deductions. A component's code and meaning are fixed
once payslips refer to it; a result line snapshots the code *and* the name, so renaming a component later never
rewrites history.

`taxable` is recorded as metadata for a future statutory engine. **Nothing reads it to calculate anything** in this
release.

## 5. Recurring items

An allowance or deduction that applies every month while it is in force: one active item per employee and component,
with an effective period and a fixed amount. A run copies the amount onto the payslip; changing the item later affects
future runs only.

## 6. Periods and the attendance cut-off

A period is one month for one organization: a **salary month** (`periodStart`/`periodEnd`) and an **attendance
window** (`attendanceFrom`/`attendanceTo`), which need not be the same — a cut-off on the 20th is normal and is
configured per period. From `REVIEW` onwards the boundaries are frozen.

```
OPEN ──calculate──► REVIEW ──submit──► REVIEW (with approver) ──approve──► APPROVED ──close──► CLOSED
                      ▲                          │
                      └──── reject / cancel ──────┘
```

## 7. What a calculation reads

For each employee in the population (everybody employed for any part of the period, including leavers):

| Line | Source | How |
|---|---|---|
| Base salary | compensation record | full month, or prorated by calendar or working days for a mid-period joiner or leaver |
| Recurring items | active pay items | the item's amount |
| Overtime | **the overtime module's** approved claims | `approvedMinutes × minuteRate × the multiplier snapshotted at approval` |
| Unpaid leave | approved leave on an unpaid policy | leave units inside the cut-off × daily rate |
| Absence | attendance records marked absent | days × daily rate, when the policy enables it |
| Lateness | attendance records | exact late minutes × minute rate, when the policy enables it |

Overtime minutes and multipliers come from `overtimeService.getApprovedOvertimeForPayroll` — payroll never forms a
second opinion about how much overtime was worked or what it was worth, and never re-reads raw attendance for it.
There is **no rounding to 15 or 30 minutes**: if a customer wants that, it belongs in the overtime policy, applied
once.

**The double-deduction guard.** A day covered by approved leave is never also charged as an absence. Unpaid leave
costs a day; absence costs a day; nobody pays for the same day twice.

## 8. Input fingerprint and stale runs

Every source the calculation read goes into a SHA-256 fingerprint stored on the run. Before approval the fingerprint
is recomputed: if a correction was approved, an overtime claim decided, a salary recorded or a recurring item changed
since the run was calculated, submission is refused with `PAYROLL_INPUT_CHANGED` until somebody recalculates.

Silently approving a payroll whose inputs have moved is the failure mode this module exists to prevent.

## 9. Manual adjustments

A payroll administrator can add a manual earning or deduction to one employee's result **while the run is under
review**, and every adjustment requires a reason. Generated lines are read-only: to change one, fix the source and
recalculate. A recalculation rebuilds every generated line and **keeps the manual ones**.

A run that has been sent for approval is frozen (`PAYROLL_RUN_PENDING_APPROVAL`): the approver must decide on the
amounts they were shown. Cancelling or rejecting the approval hands it back.

## 10. Reconciliation and negative net

Before a run can be approved it must reconcile: every line adds up to its result, every result adds up to the run, and
nobody has a negative net pay (`PAYROLL_NEGATIVE_NET`). A negative net means the deductions exceeded the pay, which is
a decision for a human, not something to pay out.

## 11. Approval and closing

Approval runs through the shared workflow engine as `module = payroll`, `entityType = PAYROLL_RUN`, with the
definition named by the payroll policy. There is no payroll-specific approval endpoint and no self-approval. On
approval the checks run **again** inside the transaction, so a run that went stale while waiting is not approved.

Closing is final: `APPROVED → CLOSED`, and a closed run can never be recalculated, adjusted, reopened or deleted.
There is deliberately **no reopen procedure** — a correction belongs to the next period, where it is visible.

## 12. Payslips

An employee sees **their own** payslips and only for **closed** runs. The query is keyed by the session's employee id,
so there is no id to tamper with; somebody else's payslip is a 404, never a 403 that would confirm it exists. A
manager's team data scope grants nothing here: salary is not team data, and `payroll.view_own` is not derived from any
scope.

Payslips print through the browser's own print dialog. No PDF dependency was added.

## 13. Permissions

| Permission | Who has it by default | What it allows |
|---|---|---|
| `payroll.view_own` | EMPLOYEE, MANAGER, HR, HR_ADMIN | your own payslips |
| `payroll.manage` | HR, HR_ADMIN | compensation, components, recurring items, policies, adjustments, export |
| `payroll.run` | HR_ADMIN | calculate, submit, close |
| `payroll.approve` | HR_ADMIN | payroll-side approval capability |

EXECUTIVE deliberately has **none**: a company-wide reporting role is not a reason to see what individuals are paid.
Reading any payroll data at all requires a payroll permission — never the employee data scope.

## 14. Reporting and export

A run summary breaks the totals down by component and by department. The CSV export is escaped and every cell that
starts with `=`, `+`, `-` or `@` is prefixed with an apostrophe, so a spreadsheet cannot be made to execute somebody's
employee code. **There is no bank file**: a bank format is specific to each bank, and inventing one would be worse
than not having it.

## 15. Known limitations

1. No withholding tax, social security or provident fund calculation.
2. No bank transfer file, and no accounting/GL posting.
3. Monthly frequency only; no weekly, bi-weekly or daily payroll.
4. One currency per policy; no multi-currency payroll and no FX.
5. A mid-period salary change is refused rather than prorated.
6. No off-cycle or supplementary run: one run per period.
7. No retroactive adjustment engine — a correction is a manual adjustment in a later period.
8. No reopen after closing, by design.
9. Overtime is paid from approved claims only; nothing is inferred from raw attendance.
10. `taxable` on a component is metadata; nothing reads it yet.
11. No employee-facing year-to-date or annual tax summary.

## 16. Performance

A run loads every source in batches — one query per source for the whole population, not one per employee. Measured on
the development database: **~0.7 ms per employee** (250 employees in ~164 ms), scaling linearly.
