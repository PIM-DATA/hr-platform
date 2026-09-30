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
| benefits (Task 42) | `benefitsReportService.dashboard` + `.report` (Task 36); per-currency amounts as the report returns them | organization (snapshot); date range for approved / paid |
| expense (Task 42) | `expenseAnalyticsService.dashboard` + `.report` (Task 39) | organization (snapshot); date range for submitted / approved / paid (submitted date) |
| employeeServices (Task 42) | `serviceAnalyticsService.dashboard` + `.report` (Task 40) | organization (snapshot); date range for submitted requests and issued letters |
| lifecycle (Task 42) | `lifecycleReportService.report` (Task 34), totals only | date range, organization; the viewer's lifecycle scope |
| learning (Task 42) | `learningReportService.report` (Task 35), totals only | date range, organization (OJT / paths: the plan's organization snapshot; certifications: the employee's current organization — a certification has no snapshot); the viewer's learning scope |
| workforcePlanning (Task 42) | `workforcePlanService.dashboard` (Task 32) for the latest ACTIVE / FINALIZED cycle | organization (selects the cycle); the viewer's workforce scope |
| engagement (Task 42) | `resultsService.dashboard` (Task 33) — threshold applied by the engagement module | none; any population filter hides it |

Business modules never import analytics; analytics imports their report services. A failing section is logged and
returned as `null`; the rest of the dashboard still renders.

**Section status (Task 42).** The payload carries `sectionStatus` for every section so a `null` is never shown as a
zero: `OK` (loaded; may be genuinely empty), `NOT_AUTHORIZED` (the viewer lacks the source module's report
permission), `UNAVAILABLE` (the source failed; logged with the section name only), `NOT_APPLICABLE_TO_FILTER` (the
source is never split by the department / job filter in use). The UI prints the matching sentence in place of the
section.

**Newer-domain roll-ups (Task 42).** `analytics/domain-rollups.ts` builds the seven roll-ups; the executive
dashboard and the copilot use the same functions. Each needs the permission its module's own report route needs —
`analytics.view_executive` alone opens none:

| Roll-up | Needs any of |
|---|---|
| benefits | `benefits.view_reports`, `benefits.manage` |
| expense | `expense.view_reports`, `expense.manage` |
| employeeServices | `hr_letter.view_reports`, `service_request.manage` |
| lifecycle | `lifecycle.view_reports` or a lifecycle manage permission |
| learning | `learning.view_reports` or an OJT / path / certification manage permission |
| workforcePlanning | `workforce.view` / `.plan` / `.manage` |
| engagement | `engagement.view_results` / `.manage` |

EXECUTIVE holds all seven by default; HR_ADMIN holds those its role grants. These domains are **never split by
department or job** (Task 36/39/40 small-group rule): with a department or job filter the section is
`NOT_APPLICABLE_TO_FILTER`, not a department figure.

**Money.** Benefits and expense amounts are exact decimal strings per currency, summed with `Prisma.Decimal` in the
source services (and, where the executive view regroups the source's per-plan / per-policy rows by currency, with
`Prisma.Decimal` again). Two currencies are never added. The web re-punctuates the string; it never parses it.

**States are not added together.** Benefits: pending (claimed), ready for payment, sent to payroll and paid are
disjoint current states; *consumed* is the ledger's approved total and is not *paid*. Expenses: pending, ready for
payment, sent to payroll and paid likewise; the in-range *approved* total includes reports now ready, sent or paid and
is shown beside, not added to, *paid*. For this the source dashboards gained additive fields (`readyForPayment`,
`sentToPayroll` per currency; `readyForPaymentTotal`, `sentToPayrollTotal`), the expense report a per-currency travel
estimate, the services report a `totals` block, and the three dashboards an optional organization filter. No source
calculation changed.


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
| Benefit enrolments / claims by state / consumed (Task 42) | Task 36 dashboard, per currency | current state |
| Benefit approved / paid in range | Task 36 report | claim submitted date / paid date |
| Expense pending / ready / sent to payroll (Task 42) | Task 39 dashboard, per currency | current state |
| Expense submitted / approved / paid in range, by category | Task 39 report | report submitted date |
| Service requests open / overdue; fulfilled, average fulfilment days; letters | Task 40 dashboard + report | current state; submitted date; issue date |
| Lifecycle, learning, workforce plan, engagement eNPS | Task 32–35 reports | see the dictionary; eNPS suppressed below the survey's minimum group size |

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
- **Benefits / expenses / employee services** (Task 42): per currency, per state, per category / plan / month /
  letter type — never an employee, claim / report / request / letter number, description, merchant, purpose,
  destination, subject, answer, message, note, letter body, salary figure, document or payment reference. A test
  walks the payload and the CSV for those keys and for seeded secret strings.
- **Engagement**: the latest eNPS is shown only when the engagement module's own threshold allows; below it the
  section says *suppressed* and carries no score.
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
Task 42 roll-ups: no department / job split for benefits, expense, employee services, lifecycle, learning,
workforce planning or engagement; no individual financial surveillance; no inference (fraud, health, hardship,
engagement, performance, flight risk) from welfare, spend or request activity; current-state figures are "now",
not historical snapshots. There is no FX conversion: amounts in different currencies are listed side by side and
never added. (Task 42 correction: the learning roll-up's certification counts now follow the organization filter —
by the employee's current organization — and the benefits report itself keys every amount by currency, so the
executive view reuses it instead of regrouping.)

## Task 47 — small groups in the executive dashboard (T44-P1-07)

The performance, competency and employee-relations sections are read from their source reports, which now withhold
small groups (performance / competency: fewer than 5 scored / assessed people; ER: departments of fewer than 5 people),
with complementary suppression. A department or job filter onto such a group shows the section as withheld (explicit
`suppression`, UI "withheld", CSV `SUPPRESSED`), never a number. Workforce counts (headcount, hires, terminations) are
not suppressed: executives can already see the employee directory, so they reveal nothing beyond it.
