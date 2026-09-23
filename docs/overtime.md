# Overtime

How the system decides that time counts as overtime, who approves it, and what payroll will eventually read.

> **This release calculates no money.** Overtime produces **minutes** and a **multiplier**. Turning those into an
> amount — against a salary basis, with tax and deductions — is payroll's job (Task 22), which does not exist yet.
> Nothing in this module knows what an hour is worth in currency, and nothing in it should learn.

---

## 1. Where it lives

Overtime is part of Time & Attendance, not a module of its own: it reads the attendance record, and its approvals run
through the shared workflow engine as `module = attendance`, `entityType = OVERTIME_REQUEST`. There is no second
approval engine and no `ot.approve` permission — deciding a claim is `workflow.approve`, exactly as it is for leave
and for attendance corrections.

## 2. What a claim is

A claim is **about a day that has already happened**. The employee says "I worked 120 minutes beyond my shift on the
23rd"; the system checks the day actually supports that, and somebody approves it.

The client sends three things: the date, the minutes, and optionally a reason. Everything else — the employee, the day
type, the eligible minutes, the policy, the multiplier, the organization/department/position — is derived on the
server, because every one of those decides what somebody is eventually paid.

Minutes are the unit everywhere. A claim of 150 minutes is stored as `150`, never as `2.5` hours; the UI formats it as
`2h 30m`. No rounding to quarter-hours happens anywhere, deliberately: if a customer wants rounding, that is a payroll
policy and it must not be applied twice.

## 3. Day types

Derived from the attendance record, never sent by a client:

| Attendance day | Overtime day type |
|---|---|
| scheduled work | `WORKDAY` |
| calendar holiday | `HOLIDAY` |
| day off / nothing scheduled | `OFF_DAY` |

The day type picks the multiplier, which is why it is server-side.

## 4. Eligibility — the rule that matters

**Workdays.** Overtime is time worked *outside* the shift — before it started or after it ended — capped by the paid
time that exceeds what the day required:

```
eligible = min( timeBeforeShift + timeAfterShift , workedMinutes − requiredMinutes )
```

The cap is the whole point. Somebody who arrives at 09:00 for an 08:00–17:00 shift and leaves at 18:00 has an hour
"after the shift", but has only made up the hour they missed: their worked minutes equal the requirement, so their
eligible overtime is **zero**. Arriving on time and leaving at 19:00 is two hours of extra paid time and two hours past
the shift — 120 minutes eligible. Arriving an hour late and leaving at 19:00 leaves 60.

**Off days and holidays.** There is no shift to be outside of, so every paid minute worked is eligible. No break is
invented: the attendance calculation already deducted whatever break the day actually had, which for a day with no
shift is none.

**Both.** A day with no clocking, or with only one side of it, yields nothing — overtime is a claim about time that
was demonstrably worked, and the system will not guess the other half. Fix the day with an attendance correction
first. Overnight shifts work naturally: the shift end is the instant the shift ended, not midnight.

Pre-shift time is supported because the attendance record keeps the first clock-in and the scheduled start as
instants; both sides are measured the same way.

## 5. Policy

One policy per organization, per period (active policies may not overlap, so any day resolves to exactly one). Without
one, a day cannot be claimed — `OT_POLICY_NOT_FOUND`.

| Field | Meaning |
|---|---|
| `workdayMultiplier` / `offDayMultiplier` / `holidayMultiplier` | ratios the customer configures; **nothing in the code assumes 1.5 / 2 / 3** or any legal rate |
| `minimumEligibleMinutes` | below this, a day is not overtime (`OT_BELOW_MINIMUM`). A threshold, **never** a rounding rule |
| `maximumApprovedMinutesPerDay` | the most a single day may claim (`OT_EXCEEDS_DAILY_MAX`) |
| `workflowDefinitionCode` | which approval workflow claims under this policy use |
| `effectiveFrom` / `effectiveTo` | when it applies |

Multipliers are validated as positive and at most 10 — enough for any real rate, tight enough to catch `15` typed for
`1.5`.

**Rates freeze once claimed.** As soon as a request has snapshotted a policy, its rate fields stop being editable
(`OT_POLICY_IN_USE`) and `effectiveTo` cannot be pulled back before the latest day claimed under it. Editing rates in
place would silently re-price overtime that was already approved. Close the policy and write a new one.

## 6. Lifecycle

`DRAFT → PENDING → APPROVED | REJECTED | CANCELLED`, the same shape as leave.

- **Preview** (`POST /attendance/overtime/preview`) shows the day, what was worked, what is eligible, the multiplier
  and the most that can be claimed. It writes nothing.
- **Draft** can be edited; after submit the claim is immutable.
- **Submit** locks the claim and the employee, recalculates eligibility, resolves the policy, validates the claim, and
  **snapshots** the day type, eligible minutes, multiplier, policy and org/department/position in one transaction
  before handing the claim to the workflow engine.
- **One open claim per day.** A pending or approved claim blocks another for the same date; a rejected or cancelled
  one does not.
- **Cancel** is for the requester, on a draft or a pending claim. An **approved** claim cannot be withdrawn — it is
  payroll input. Reversing one is a future, payroll-safe procedure.

## 7. Approval revalidates the day

When the final approval lands, eligibility is recomputed **against the attendance as it stands at that moment**. If
the claim no longer fits, approval fails with `OT_ATTENDANCE_CHANGED_REVIEW_REQUIRED` and the whole transition rolls
back: the claim stays pending, the workflow stays pending, and a person decides what to do (usually: withdraw and
claim again).

This matters because an attendance correction can land between submit and approval. Approving overtime the attendance
no longer supports is exactly the sort of thing that surfaces three months later in a payroll dispute.

The multiplier is **not** re-resolved on approval: it is the one snapshotted at submit.

## 8. Attendance corrections and approved overtime

The guard works both ways round:

| Situation | Behaviour |
|---|---|
| Correction approved while a claim is **pending** | allowed — the claim is revalidated when somebody approves it |
| Correction approved that would leave **less eligible overtime than is already approved** | refused: `ATTENDANCE_CORRECTION_CONFLICTS_WITH_APPROVED_OT`, and the correction, the attendance and the claim are all left exactly as they were |

So the system can never hold "120 approved minutes" on a day whose attendance supports 30.

Raw clock events are never edited by anything in this module. An attendance correction remains the only way to change
what a day says.

## 9. Scope and permissions

| Permission | Default roles | What it allows |
|---|---|---|
| `ot.view` | Employee, Manager, HR, HR Admin, System Admin, Executive | read claims — narrowed by the role's data scope |
| `ot.request` | Employee, Manager, HR Admin, System Admin | claim overtime for **yourself** |
| `ot.manage_policy` | HR Admin, System Admin | create and edit policies |

Reads use the same `employeeScopeWhere` as every other module (SELF / TEAM / ALL). Data scope never grants the right
to approve: that is the workflow's snapshot approver, checked by the engine. Somebody else's claim answers 404, not
403, so the endpoint never confirms it exists.

## 10. Audit and notifications

Audited: `CREATE_OT_POLICY`, `UPDATE_OT_POLICY`, `CREATE_OVERTIME_REQUEST`, `UPDATE_OVERTIME_REQUEST`,
`SUBMIT_OVERTIME_REQUEST`, `APPROVE_OVERTIME_REQUEST`, `REJECT_OVERTIME_REQUEST`, `CANCEL_OVERTIME_REQUEST` — minutes
and multipliers only, never an amount.

Notifications reuse the shared service: the current approver gets `APPROVAL_REQUIRED`, the employee gets
`OVERTIME_APPROVED` (with the approved duration) or `OVERTIME_REJECTED`. The rejection comment stays in the workflow
timeline; it is never copied into a notification.

## 11. The payroll handoff

Task 22 reads exactly one thing:

```ts
overtimeService.getApprovedOvertimeForPayroll({ employeeId, from, to })
// → { requestId, employeeId, attendanceDate, approvedMinutes, dayType, rateMultiplierSnapshot, policyId }[]
```

Approved claims only, with the five facts a payroll run needs. Payroll does not query workflow instances, attendance
records or policies for itself — if it needs more, this shape grows deliberately. There is no public endpoint for it;
it is an internal service so the contract stays where it can be checked.

Everything in that payload is **immutable after approval**: the minutes, the day type, the multiplier, the policy and
the date. A policy edited later does not rewrite it, and an attendance correction that would undermine it is refused.

## 12. Screens

HRM → Time & attendance → **Overtime** (my claims, waiting for me, everyone in scope; claim dialog with the preview)
and **OT policies** (rates, limits, workflow, effective period; rate fields disabled once a policy has been claimed
under).

## 13. Known limitations

- **Claim-based, after the fact.** There is no pre-approved or planned overtime, and no automatic overtime scheduling.
- **No money.** No rate, no amount, no tax, no social security, no payroll posting, no bank export.
- **No rounding rule** — minutes stay minutes until payroll decides.
- **One rate per claim.** A single claim cannot span two multipliers (for example crossing midnight into a holiday);
  claim the day it belongs to.
- **No approved-claim reversal.** Withdrawing an approved claim needs a payroll-safe procedure, which does not exist
  yet.
- **No device integration** (biometric, terminal, GPS) — overtime is derived from the same web clock as attendance.
- Nothing here is a statement of legal compliance: multipliers, minimums and caps are whatever the customer configures.
