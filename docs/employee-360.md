# Employee 360

One screen that shows what every module knows about an employee — and shows each part only to the people that
module would show it to.

> **A projection, not a source.** Employee 360 stores nothing and calculates nothing. Every section is produced by
> the module that owns the data (leave balances by Leave, the latest review by Performance, the skill profile by
> Competency, the summary by Employee relations …) and the page never writes anything back. There is no second copy
> of an employee, a balance, a score or a gap.

---

## 1. Architecture

`GET /analytics/employee-360/:employeeId` → `employee360Service.getOverview({ employeeId, actor })`:

1. The **employee master** decides whether the caller may see this person at all (`employeesService.getById`
   applies the employee data scope; outside it the answer is 404).
2. For each section the service asks the **source module's rule**: may this caller see this employee's leave /
   attendance / payroll / performance / …? The rule is the module's own, restated, never widened.
3. Allowed sections are fetched **in parallel from the module services** (`entitlementsService`,
   `leaveRequestsService`, `attendanceRecordsService.report`, `overtimeService`, `payslipService`,
   `skillGapService.profileFor`, `trainingReportService.myDevelopment`, `erCaseService.summaryFor`,
   `careerService.myCareer`, `developmentService.getTalentSummary`), each with a bounded, recent slice (this year's
   leave, this month's attendance, six payslips, ten plans, ten attendance days, twenty activity events).
4. A section that fails is logged and returned as `null` so one optional domain cannot take the page down; a
   section the caller may not see is **absent (`null`)** — never present-and-hidden, never `salaryHidden: true`.
5. A curated **activity feed** is assembled only from sections the caller may see (position changes, approved
   leave, finalized reviews, completed training, an ER action date, a finalized talent review). It is not the
   audit log and never carries a narrative.

Response shape: `{ profile, visibleSections, sections: { employment, leave, attendance, overtime, payroll,
performance, competency, development, employeeRelations, recruitment, career, talent }, activity, generatedAt }`.

## 2. Section authorization

`employee360.view` opens the page and grants nothing else.

| Section | Self | Manager (TEAM scope) | HR / others |
|---|---|---|---|
| Profile, employment timeline | ✓ | direct reports (employee scope) | `employees.view` + scope |
| Leave | ✓ | `leave.view` + scope | `leave.view` + scope |
| Attendance, overtime | ✓ | `attendance.view` / `ot.view` + scope | same |
| Payroll | own **closed** payslips (`payroll.view_own`) | **never** | `payroll.manage` only: closed results |
| Performance | own plans | plans where the manager is the **snapshot reviewer** | `performance.manage_cycles`: all plans; `performance.view` + scope: reviewer's plans |
| Competency | own profile | `competency.view` as the employee's manager | `competency.manage` |
| Development (training / IDP) | ✓ | `training.view` as the manager | `training.manage` |
| Employee relations | **never** (own issued records live in the ER module) | **never** | `employee_relations.view` / `.manage`: counts and a date |
| Recruitment origin | never | never | `recruitment.manage`: source, opening, application, dates |
| Career | `career.view` | `talent.view` as the manager | `career.manage`, `talent.manage` |
| Talent summary | **never** | `talent.view` as the manager: latest finalized cell only | `talent.manage` / `succession.manage`: cell, pool count, nomination count |

What never travels in a 360 payload, for anybody: a review or reviewer comment, a potential comment, a succession
note, a case narrative, a warning letter body, interview feedback, an offer figure, a recruiter note.

## 3. Sections

- **Employment timeline** — derived from the position and manager histories plus the hire date: Joined, Position
  changed, Moved to department, Manager changed, Employment ended (from `terminationDate` when recorded). No event
  is invented for data the schema does not hold.
- **Leave** — this year's entitlements with available units (the leave module's own balance), request counts and
  the five most recent requests. No entitlement is recalculated.
- **Attendance** — this month's totals from the attendance report (present / late / absent / leave / incomplete /
  worked minutes) and the last ten days.
- **Overtime** — this year's claims and approved minutes from the overtime report. Minutes only; the payroll
  value of overtime is never shown here.
- **Payroll** — self: own closed payslips (period, payment date, net); `payroll.manage`: closed results for the
  employee. Nothing for a manager, an executive or anyone else.
- **Performance** — the latest finalized plan (score, rating, cycle) and history. No comments.
- **Competency** — the current skill profile from Task 24 (`profileFor`): assessed / gaps / unassessed / exceeding.
- **Development** — Task 25's own projection: summary, active IDP, open needs, upcoming and recently completed
  training.
- **Employee relations** — `summaryFor`: active warnings, total issued, awaiting acknowledgement, latest action
  date, with a deep link to the module for those who hold it.
- **Recruitment origin** — for HR: candidate number, source, opening, application number, applied and hired dates.
- **Career** — paths and readiness against next jobs (Task 28), for the employee and their line.
- **Talent** — `getTalentSummary`: latest finalized 9-box cell, pool count, nomination count. No potential level,
  no comment, no notes; never shown to the employee.

## 4. UI

Employee → Employee detail. The existing Overview / Employment / Position history / Manager history tabs are
kept; when the 360 returns sections, extra tabs appear — **Time & leave**, **Performance**, **Development**,
**Career & talent**, **Relations** (employee relations summary and recruitment origin) — and the Overview gains
summary cards plus the activity feed. A tab is shown only when the server returned one of its sections. An
employee opens their own record through the same page (the employee scope allows self), so there is no separate
"my profile" screen to keep in sync.

## 5. What it is not

No dossier export ("download the complete 360"): the subject-access export exists in the Privacy module with its own
audit and minimization rules, and this page does not duplicate it. No mutation of any kind. No ranking, no risk
score, no inference. Reads are logged (route, actor, section names, duration) — never the payload.
