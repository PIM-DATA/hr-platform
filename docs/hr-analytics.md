# Executive HR analytics

Organization-level figures for the people who run the organization, composed from each module's own report.

> **Descriptive, aggregate, and nobody's.** The dashboard shows counts, rates and distributions. It contains no
> employee, no ranking, no comment and no prediction — no attrition risk, no flight risk, no "top performers". A
> test walks the whole response and fails if an employee id, code, name, email, comment, case number or candidate
> reaches it.

---

## 1. Permissions

| Permission | Default holders | Grants |
|---|---|---|
| `analytics.view_executive` | EXECUTIVE, HR_ADMIN, SYSTEM_ADMIN | `GET /analytics/executive/overview`, `/export`, `/options`, `/metrics` — all aggregate |
| `analytics.view_payroll_aggregate` | HR_ADMIN, SYSTEM_ADMIN | The payroll section: organization-level totals across closed runs. **Not** granted to EXECUTIVE by default |

Individual data stays governed by the source modules: an executive opening an employee's record gets exactly the
sections the employee module and each source module allow (see [employee-360.md](employee-360.md)). Cards link to a
source module's report only when the viewer already holds that module's permission; there is no drill-down from a
number to a person.

## 2. Architecture

`executiveAnalyticsService.overview(auth, filters)` calls the domain report services in parallel:

| Section | Source | Filters applied |
|---|---|---|
| workforce | Employee master and position history (this module's only own aggregation) | organization, department, job (current assignment); date range for hires and moves |
| leave | `leaveReportsService.overview` (Task 14) | date range (clamped to the leave report's own limit), organization, department |
| attendance | `attendanceRecordsService.report` per department, rows aggregated and dropped (Task 20) | date range, department (current) |
| overtime | `overtimeService.report` per department, rows dropped (Task 21) | date range, department |
| performance | `performanceReportService.cycleReport` for cycles overlapping the range (Task 23) | organization (cycle), department (**plan snapshot**) |
| competency | `skillGapService.gapReport` (Task 24) | organization, department, job (current job profile; no date) |
| training | `trainingReportService.report` (Task 25) | date range, department |
| recruitment | `recruitmentReportService.report` (Task 27) | date range, organization |
| employeeRelations | `erReportService.report` (Task 26) | date range, department (case snapshot) |
| talent | `talentReportService.talent()` / `.succession()` (Task 28) | none — current state |
| payroll | `payrollRunService.summary` per closed run, department split discarded (Task 22) | date range (period), organization |

Business modules never import analytics; analytics imports their report services. A failing section is logged and
returned as `null`; the rest of the dashboard still renders.

## 3. Metric dictionary

Served at `GET /analytics/metrics` and shown in the UI under **Definitions**; the canonical list is
`ANALYTICS_METRICS` in `packages/shared/src/schemas/analytics.ts`. Highlights:

| Metric | Definition | Attribution |
|---|---|---|
| Active headcount | Employees with status ACTIVE right now | current — the date range does not apply |
| New hires | Employees whose `hireDate` is in the range, any current status | hire date |
| Position / department moves | Position-history rows starting in the range that were not the employee's first assignment | start of the new assignment |
| Terminations | Employees with `terminationDate` in the range; a lower bound (no termination workflow exists), no trend inferred | termination date |
| Approved leave units | Task 14 report | request dates, department on the request |
| Attendance days | Task 20 report totals | attendance date, current department |
| Approved overtime minutes | Task 21 report — minutes, never money | attendance date |
| Reviews finalized / average score | Task 23 cycle report for cycles overlapping the range | cycle period, **plan snapshot department** |
| Competency coverage / gaps | Task 24 gap report | latest levels vs current job profile |
| Training completion rate | Task 25: completed ÷ (completed + failed + no-show) | session date |
| Hires / time to hire | Task 27: HIRED applications; applied → hired days | application applied date, opening snapshot |
| ER actions issued / active | Task 26 report | incident/issue date, case snapshot |
| Succession coverage | Task 28: plans with ≥1 successor / ready-now / none | current state |
| Payroll net total | Sum of net across CLOSED runs in the period range | payroll period |

**Cross-domain totals are not forced onto one dimension.** A department's headcount is today's; its finalized
reviews are counted where the plans were created; its recruitment is the opening's snapshot. The numbers answer
different questions and the dictionary says which.

## 4. Filters and limits

Date range (required, at most 36 months — validated), organization, department, job. Filters a module cannot apply
are not pretended: the recruitment report takes organization only, talent reports take none, the competency report
takes no date. The leave section is clamped to the leave report's own maximum range (its `period` states what was
used).

## 5. Aggregate privacy

- No employee-level arrays anywhere in the payload; the domain reports that return per-employee rows are
  aggregated inside the service and the rows are discarded.
- Employee relations: counts by status, department, action type and month only.
- Talent: cell counts and coverage only; no nomination, no comment.
- Recruitment: funnel, sources, time to hire; no candidate.
- **Payroll**: organization-level totals only, behind a separate permission. No department split is offered because
  a department of one or two people would reveal a salary; if a customer needs a split, a minimum group size must
  be enforced first.

## 6. Export

`GET /analytics/executive/export` returns the same aggregate tables as CSV (UTF-8 with BOM). Every cell is quoted
and any value starting with `= + - @ \t \r` is prefixed with an apostrophe so a spreadsheet never executes a
department name. There is no employee-level export from analytics; modules keep their own exports under their own
permissions.

## 7. Logging and caching

Each request logs route, actor id, filter ids and duration — never a payload. There is no server-side cache; the
client caches queries briefly. Reads are not audited (consistent with the rest of the platform).

## 8. Known limitations

No custom report builder, dashboard designer, saved views, scheduled or emailed reports, external BI connector,
warehouse or OLAP cube. No predictive analytics, attrition or flight-risk scoring, anomaly detection, AI summaries
or "copilot". No employee ranking of any kind. No custom KPI formulas. No historical headcount trend (there is no
headcount snapshot table; only hires, moves and recorded terminations are trended). No executive payroll analytics
by default and no payroll split below organization level. No all-in-one employee dossier export.
