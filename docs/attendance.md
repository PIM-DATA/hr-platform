# Time & attendance

How the system decides what somebody was expected to work, what they actually worked, and what to call the difference.
Written for the HR administrator configuring it and the engineer maintaining it.

---

## 1. The shape of a day

Four things decide one employee-day, and they are read in this order:

1. **The schedule** — a shift, a day off, or a holiday, for that employee on that date.
2. **The work calendar** (the same one Leave uses) — the organization's working days and public holidays.
3. **Approved leave** — read from the Leave module; attendance never writes to it and never recalculates leave units.
4. **Clock events**, plus an **approved correction** if there is one.

They go into one pure function (`calculateAttendance` in `@hr/shared`) which produces the day's record. The record is
a **cache with a unique key** (`employeeId` + `attendanceDate`): delete every row and recalculating reproduces them
exactly. That is what makes it safe to recalculate after a clock event, a schedule change, an approved leave request
or an approved correction.

## 2. Time and timezone

| Kind | Stored as | Example |
|---|---|---|
| Business date | `YYYY-MM-DD` in the organization's timezone | `2026-09-23` |
| Shift time | `HH:mm` wall clock in the organization's timezone | `08:00` |
| Clock event | UTC instant | `2026-09-23T01:00:00.000Z` |

A shift's `08:00` is a wall-clock time, so the instant it means changes with the organization's timezone and with
daylight saving. Nothing in the code assumes an offset: `zonedTimeToUtc(date, time, timezone)` resolves it per date,
and `Organization.timezone` is the only source of "what time is it here".
Since Task 53 the same rule holds in every module (expense, services, learning, lifecycle, benefits, ER, documents,
reports, copilot) — see docs/business-dates.md. Attendance day allocation itself is unchanged.

## 3. Shifts

A shift says when work starts and ends, how long the unpaid break is, and how much lateness is forgiven:

```
D1   08:00 → 17:00   break 60   late grace 10   early grace 10   → required 480 minutes
N1   20:00 → 05:00   break 60   (overnight)                      → required 480 minutes
```

- `isOvernight` is **derived** (`end <= start`), never supplied by a client.
- Grace decides the **status**, not the numbers: clocking in at 08:15 with a 10-minute grace is `LATE` with
  `lateMinutes: 15`, because "5 minutes late" would be a number nobody can reconcile against the clock.
- Shift codes are unique per organization. Editing a shift does **not** recalculate days already worked against it.

## 4. Overnight shifts

The attendance day is the day the shift **started**. Clocking in at 20:00 on the 23rd and out at 05:00 on the 24th is
one day of work, recorded against the 23rd. The clock-out endpoint attaches the event to the open clock-in's date, so
this happens without the employee choosing anything.

## 5. Schedules

One row per employee per date: `WORK` + a shift, `OFF`, or `HOLIDAY`.

- HR assigns a shift to people over a date range, choosing which weekdays it applies to. Weekends (days outside the
  chosen weekdays) become `OFF`; holidays from the work calendar stay `HOLIDAY` unless "also schedule work on public
  holidays" is ticked.
- **No schedule row means nothing is expected.** The day shows as `NOT_SCHEDULED` and can never be an absence — a
  missing schedule is a configuration gap, not misconduct.
- Approved leave is deliberately **not** written into the schedule. It is read when the day is calculated, so
  cancelling leave can never leave an "on leave" day behind.
- There is no rotating-roster engine: assignments are explicit, per range, per weekday.

## 6. Clocking

`POST /attendance/clock-in` and `/clock-out`, permission `attendance.clock`.

- **The employee comes from the session**, never from the request body.
- Events are **append-only**: nothing is ever updated or deleted. A mistake is fixed by a correction request.
- Every clock takes the employee row lock first, so two taps, two tabs or a retry cannot both create an event
  (`ALREADY_CLOCKED_IN`, `NOT_CLOCKED_IN`, `ALREADY_CLOCKED_OUT`). The disabled button is a courtesy; the lock is the
  guarantee.
- The source is recorded (`WEB` today; `ADMIN`, `IMPORT` and `API` exist in the model for later) — no device
  integration is implemented.
- An account with no employee record cannot clock (`EMPLOYEE_PROFILE_REQUIRED`).

## 7. The calculated day

| Status | When |
|---|---|
| `NOT_SCHEDULED` | day off, holiday, or no shift assigned. Clocking is still recorded. |
| `SCHEDULED` | a work day that has not ended yet, with no clock-in (the "not clocked yet" KPI). |
| `NORMAL` | worked within the shift, allowing for grace. |
| `LATE` / `EARLY_LEAVE` / `LATE_AND_EARLY` | worked, outside the grace at one or both ends. |
| `INCOMPLETE` | clocked in without out (or out without in). The system never invents the missing time. |
| `ABSENT` | a work day that **ended** with no clocking and no full-day leave. |
| `ON_LEAVE` | approved full-day leave. |

Minutes: `workMinutes = clock-out − clock-in − break` (never negative), `lateMinutes` and `earlyLeaveMinutes` against
the expected window, and `extraMinutes` for anything beyond what the day required — **informational only; there is no
overtime calculation or payment in this release.**

**Absence is never predicted.** A day becomes `ABSENT` only once the shift's end has passed, which is why the daily
screen has a *Recalculate* action (and why a future scheduled job would call the same service).

## 8. Leave integration

- A **full day** of approved leave is `ON_LEAVE`, never absent.
- A **half day** narrows the expected window to the other half and halves the break: morning leave means the employee
  is expected from the midpoint of the shift, afternoon leave until it. Arriving at the midpoint is not late.
- A half day of leave does **not** excuse the working half: no clocking on that half, after the day ends, is `ABSENT`.
- Leave balances, units and policy live in the Leave module. Attendance only reads approved requests.

## 9. Corrections

"I forgot to clock out" is a **request about a day**, not an edit of it.

1. The employee submits the times that should have been recorded, with a reason (`attendance.clock`).
2. Approval goes through the shared **workflow engine** — the definition with code `ATTENDANCE_CORRECTION`, created in
   Administration → Workflows exactly like the leave one. There is no second approval engine, and no attendance
   endpoint that approves anything: the generic `POST /workflow/instances/:id/actions` does it.
3. Approving records the decision and recalculates the day **using the requested times**. The raw clock events are
   untouched, so the record always shows both what happened and what was decided.
4. Rejecting leaves the day exactly as it was.

Only one request may be open per employee per day. A later recalculation cannot undo a decision, because the decision
is one of the inputs being recalculated.

## 10. Permissions and scope

| Permission | Who has it by default | What it allows |
|---|---|---|
| `attendance.clock` | Employee, Manager, HR, HR Admin, System Admin | clock in/out for yourself, raise corrections |
| `attendance.view` | Employee, Manager, HR, HR Admin, System Admin, Executive | read attendance — narrowed by the role's data scope |
| `attendance.schedule_manage` | HR Admin, System Admin | assign schedules |
| `attendance.manage` | HR Admin, System Admin | shifts, recalculation |
| `attendance.correct` | HR, HR Admin, System Admin | reserved for HR-side correction handling |

Reads use the same `employeeScopeWhere` as every other module: SELF sees itself, TEAM sees itself and direct reports,
ALL sees everyone. There is no attendance-specific scope logic and no role name anywhere in the services.

## 11. Audit and notifications

Audited: `CREATE_SHIFT`, `UPDATE_SHIFT`, `ASSIGN_SCHEDULE`, `CLOCK_IN`, `CLOCK_OUT`, `RECALCULATE_ATTENDANCE`,
`SUBMIT_ATTENDANCE_CORRECTION`, `APPROVE_ATTENDANCE_CORRECTION`, `REJECT_ATTENDANCE_CORRECTION`,
`CANCEL_ATTENDANCE_CORRECTION`. The raw clock events are themselves an append-only history.

Notifications reuse the shared service: the current approver gets `APPROVAL_REQUIRED` when a correction reaches their
step, and the employee gets `ATTENDANCE_CORRECTION_APPROVED` / `..._REJECTED`. In-app only — no email or SMS.

## 12. Screens

HRM → Time & attendance: **My attendance** (clock in/out + history + request a correction), **Team**, **Daily**
(KPI strip + the day's table + recalculate), **Schedule** (employees × dates grid + assign), **Corrections**
(mine / waiting for me / all), **Shifts**, **Reports** (a range, per employee).

## 13. Known limitations

- Web clock only — no biometric device, no terminal, no offline clock, no device import.
- **No GPS or geofence.** That needs location consent, accuracy handling, a spoofing policy, work-location
  configuration and a mobile experience; none of it is half-built here.
- One clock-in and one clock-out per day: no multiple punches and no break tracking.
- No rotating-roster generator; schedules are assigned explicitly.
- **No overtime calculation or approval, and no payroll posting.** `extraMinutes` is recorded for information only.
- Absence appears when a day is recalculated after it ends; there is no scheduler in the application yet.
- Editing a shift does not retroactively change days already calculated against it.

## Task 48 — range report totals cover everybody (T44-P1-13)

`GET /attendance/reports/overview` used to load the first 500 employees (by code) and sum only them: a department of
520 reported 500, silently, and the executive overview inherited it. Now:

- `totals` is one SQL aggregate over **every** employee in the caller's scope and filters; `totalEmployees` is the
  population; neither depends on the page.
- `rows` is one page of employees: `page` (default 1) and `pageSize` (default 50, at most 100 — a larger value is
  `400`, never silently shortened); `meta: { page, pageSize, total }`. The web report pages through them.
- `attendanceRecordsService.summary` (totals + population, no rows) feeds the executive overview; the copilot's team
  view reads its team's rows explicitly (`rowsFor`).
- `POST /attendance/recalculate` processes every active employee in scope in id-ordered batches of 500 (it stopped at
  2,000 before, leaving later employees' days — and the payroll inputs read from them — stale).
- Verified at 499 / 500 / 501 / 520 / 1,000 employees in one department and 3,020 in one organization
  (`audit44-large-department.test.ts`).

**Payroll freeze.** A recalculation that would change a day's status or late minutes inside an approved or closed
payroll period is refused (`409 PAYROLL_PERIOD_LOCKED`, see payroll.md); an identical recalculation still passes.
