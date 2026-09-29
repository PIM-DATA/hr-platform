# Report center

Reports built from a server-owned registry of datasets — never from SQL.

---

## 1. No arbitrary SQL

A report definition is JSON validated by a strict schema: `columns` (field ids), `filters` (`fieldId`, `operator`,
`value`), `sort`, `groupBy`, `aggregations` (`fieldId`, `function`, `alias`), `pageSize`. Unknown properties are
rejected, so `sql`, `where`, `table`, `join`, `selectRaw`, `orderByRaw` never reach a runner. Field ids are
resolved against the dataset's registry entry; an unknown field, a disallowed operator, a bad value, a sort on an
unsortable field or an aggregation the field does not permit is refused with a 422. A money field declares its
`currencyField`; SUM / AVG / MIN / MAX over it are refused (422 `REPORT_CURRENCY_GROUP_REQUIRED`) unless the currency
is a group key or the report is filtered to one currency — currencies are never added (Task 42 correction; applies
to the benefit and expense datasets; no FX conversion exists). COUNT stays allowed. Users choose from the registry;
they cannot name a table, a column or a join.

## 2. Dataset registry

`apps/api/src/modules/reports/registry.ts` and `datasets/index.ts`. Each dataset has an id, name, description, the
module permission(s) that open it, an `aggregateOnly` flag, an optional required date range, its fields and a
runner. Two runners exist: `prismaDataset` (one Prisma model chosen by the registry, filters/sort/group built only
from the registered column paths, grouping and aggregation executed in the database) and `memoryDataset` (wraps a
domain service that already computes the rows — the competency module's gap service, an ER aggregate — and
filters/groups its bounded output). There is no generic model accessor: a request cannot make a runner touch a
model the registry did not give it.

Fields carry a type (STRING, NUMBER, DECIMAL, DATE, DATETIME, BOOLEAN, ENUM with options), a sensitivity, and the
selectable / filterable / sortable / groupable / aggregatable flags. `GET /reports/datasets` returns only datasets
the caller may use and only their visible fields; column paths never leave the server.

## 3. Datasets

| Dataset | Grain | Opens with | Row scope |
|---|---|---|---|
| employee_directory | employee | employees.view | employee data scope (SELF / TEAM / ALL) |
| headcount_summary *(aggregate)* | counts | employees.view | employee data scope |
| leave_requests | request | leave.view | employee data scope; ≤ 24 months |
| attendance_summary | employee / day | attendance.view | employee data scope; **≤ 12 months required** |
| overtime_approved | claim | ot.view | employee data scope; ≤ 24 months; minutes only |
| performance_results | finalized plan | performance.view | own, reviewed, or all for cycle managers |
| competency_gaps | employee × competency | competency.manage | Task 24 gap service; UNASSESSED stays null |
| training_history | enrolment | training.view | employee scope; all for training.manage |
| recruitment_applications | application | recruitment.manage | recruitment application scope; ≤ 36 months |
| talent_review_summary | review | talent.manage | all; no comments |
| employee_relations_aggregate *(aggregate)* | counts | employee_relations.view/manage | counts by department / type / month / status |
| payroll_period_summary *(aggregate)* | closed run | payroll.manage | organization-level totals only |

Excluded on purpose: individual salary or net pay, disciplinary detail, potential comments, succession notes,
candidate feedback or offer figures, contact details, document storage keys. Every dataset's rows are those the
caller's source module would show them; the report permission never overrides a module's scope.

## 4. Permissions

| Permission | Default | Meaning |
|---|---|---|
| reports.view | MANAGER, HR, HR_ADMIN, EXECUTIVE | open the report center, run and export |
| reports.view_individual | MANAGER, HR, HR_ADMIN | use datasets that return individual rows; without it only `aggregateOnly` datasets are offered (EXECUTIVE) |
| reports.create | MANAGER, HR, HR_ADMIN, EXECUTIVE | save private reports |
| reports.share | HR_ADMIN | make a saved report SHARED |
| reports.manage | HR_ADMIN | edit / delete any saved report |

Plus the dataset's own module permission. An executive therefore sees `headcount_summary` and nothing individual.

## 5. Filters, sorting, grouping, aggregation

Operators by type — STRING: EQ NE CONTAINS STARTS_WITH; NUMBER/DECIMAL: EQ NE GT GTE LT LTE; DATE: EQ BEFORE AFTER
BETWEEN; DATETIME: BEFORE AFTER BETWEEN; ENUM: EQ NE IN; BOOLEAN: EQ; plus IS_NULL / IS_NOT_NULL. Values are
validated server-side (numbers, dates, enum options). Sorting on allow-listed fields, up to 3 levels. Grouping on
groupable fields, up to 3, with COUNT, COUNT_DISTINCT, SUM, AVG, MIN, MAX where the field permits; a grouped
report's columns must be its group fields. Decimals stay decimal strings on the wire and in CSV.

Limits: 30 columns, 20 filters, 3 group fields, 10 aggregations, 3 sorts, page size 1–200 (default 50), export cap
50,000 rows (`REPORT_EXPORT_TOO_LARGE` beyond it, decided from the count before any row is built). High-volume
datasets require a BETWEEN date filter within their maximum span.

## 6. Saved reports and sharing

`saved_reports`: name, description, dataset, owner, visibility PRIVATE / SHARED, definition, updated by. A SHARED
report is listed to users who hold `reports.view` **and** the dataset's permission; others do not see it at all.
Running any report — shared or not — returns the runner's own scope: a manager running HR's "All active employees"
gets their team. Editing and deleting are the owner's (or `reports.manage`); deleting a definition deletes no
business data. Templates (`GET /reports/templates`) are application-owned definitions on ordinary fields.

## 7. CSV export

Same permission and scope as running. UTF-8 with BOM, every cell quoted, values starting with `= + - @ \t \r`
prefixed with an apostrophe (tested with `=HYPERLINK`, `+CMD`, `-CMD`, `@SUM`). Exports are audited
(`EXPORT_REPORT`: dataset, report, row count, column ids, filter fields — never the rows).

## 8. Audit

`CREATE_REPORT`, `UPDATE_REPORT`, `SHARE_REPORT`, `DELETE_REPORT`, `RUN_REPORT` (saved-report runs),
`EXPORT_REPORT`. Ad-hoc previews are not audited.

## 9. Known limitations

No arbitrary SQL, SQL editor or custom joins (one dataset per report); no calculated or formula fields; no pivot
tables, charts or dashboard designer; no scheduled or emailed reports; no warehouse or external BI connector; no
PDF report designer; no background export job (the 50,000-row cap is the ceiling); no report versioning beyond
updated-by/at; no individual payroll dataset.
