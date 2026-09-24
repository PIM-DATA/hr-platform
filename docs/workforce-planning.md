# Organization design and workforce planning

A planning layer beside the live organization. It answers "how many do we have, how many do we plan, and what is
the difference" per department and job, and "what would the organization look like if…" as a target structure. It
decides nothing and executes nothing: hiring, transfers, restructures and terminations happen only through their
own modules when a person performs that action there.

---

## 1. Actual vs planned — the boundary

| Actual (source of truth) | Planned (this module) |
|---|---|
| Organization, Department, Job, Position, Employee masters | `workforce_planning_cycles`, `workforce_plan_items`, `workforce_planned_movements`, `organization_design_scenarios`, `organization_design_nodes`, `organization_design_positions` |
| Changed by the Organization and Employee pages, recruitment hire, etc. | Changed only by planners; **never** written back to the masters |
| Current headcount = active employees today | Current headcount **snapshot** captured at initialization and again at finalization |

No service in `apps/api/src/modules/workforce` writes to an employee, position, department, job, payroll or
recruitment table. The one bridge to another module — the requisition handoff — calls the recruitment service
under its own validation, numbering and audit, and only when a person asks for it with an explicit number of
openings.

## 2. Planning cycles

`WorkforcePlanningCycle`: code, name, optional organization, period, description, status.

`DRAFT` (editable) → `ACTIVE` (review, read-only; can go back to DRAFT) → `FINALIZED` (frozen) → `ARCHIVED`
(historical). `DRAFT` can also be archived. There is no reopen after finalization. Finalizing needs
`workforce.manage`, runs under the cycle's row lock (a concurrent second finalize gets 409), re-captures the
current headcount on every row, and does nothing else.

## 3. Headcount plan and its grain

One row per **department + job** (`grainKey = departmentId:jobId`, unique per cycle). Employees are counted through
their current position's job; a position without a job plans under "no job assigned". Positions were not chosen
as the grain because a position here is not a single seat (several employees may share one).

"Initialize from current workforce" creates one row per current department + job with
`currentHeadcountSnapshot = plannedHeadcount = today's active count`. It is idempotent — rows that exist are left
alone (their planned values belong to HR) — so a double click, or two planners clicking at once, adds nothing
twice. A row can also be added by hand for a department + job that has nobody yet (a new function).

Row fields a person sets: `plannedHeadcount` (integer ≥ 0), `reason` (GROWTH, REPLACEMENT, RESTRUCTURE,
NEW_FUNCTION, SEASONAL, OTHER), `priority` (LOW, NORMAL, HIGH, CRITICAL), `targetDate`, `notes`. None of them is
inferred from salary, performance, skills or anything else.

## 4. Current headcount snapshot and history

`currentHeadcountSnapshot` + `snapshotAt` are stored on the row. While the cycle is a draft the API also returns
`currentHeadcountLive` so a planner sees drift; after finalization it is `null` and the row shows only the frozen
figure. Employees who transfer or leave after finalization change the live dashboard and any new cycle, never the
finalized plan.

## 5. Delta semantics

```
delta = plannedHeadcount − currentHeadcountSnapshot
EXPANSION (> 0) · NO_CHANGE (= 0) · REDUCTION_PLANNED (< 0)
remainingDemand = max(0, planned − current − openRecruitmentDemand)
```

Pure functions in `packages/shared/src/workforce.ts`. The words are factual on purpose: no "overstaffed", no
"hire 3", no "fire 2". A reduction is a number; the system never lists, selects or ranks people for it, and no
termination, disciplinary case or payroll change is created.

## 6. Recruitment context and handoff

For each row with a job the plan reads Task 27's tables: approved and pending requisitions (count and requested
openings), open openings, hires on those openings, and `openRecruitmentDemand = openOpenings − hired`. These are
shown beside the delta as facts; the plan does not assume they map one-to-one to the row.

**Create requisition** is an explicit action on a row with a positive delta. It needs `workforce.manage` **and**
`recruitment.manage`. HR chooses the requested openings (the form suggests the remaining demand and nothing
more); the requisition is created as a DRAFT by `requisitionService.create` with the department, job, a reason
defaulted from the plan reason (overridable), the target date as desired start, and a justification line with the
plan figures. The link is remembered (`workforce_plan_requisitions`) so the row shows what it produced; a row that
was handed off cannot be removed. Submitting, approving and opening the requisition happen in Recruitment under
its workflow. Nothing is created without this action, and nothing happens for a negative delta.

## 7. Planned movements

`WorkforcePlannedMovement`: optional employee, from/to department, from/to job, target date, status PLANNED →
CANCELLED | COMPLETED_EXTERNALLY, notes. A record of intent for the plan. Reading them needs `workforce.plan`
(they can name a person, so executives with aggregate view do not see them). The employee master never changes
because of a movement; a transfer is executed on the employee's page and the movement is then marked as completed
externally by a person.

## 8. Organization-design scenarios

`OrganizationDesignScenario` (name, organization, optional planning cycle, DRAFT → FINALIZED | ARCHIVED) holds
`OrganizationDesignNode`s (ORGANIZATION | DEPARTMENT | TEAM, parent, optional `sourceDepartmentId`, `plannedOnly`)
and `OrganizationDesignPosition`s (a job from the Job master **or** a free-text `plannedJobTitle`, planned
headcount, optional reports-to unit, notes).

- Every scenario starts with the organization as root. "Import current departments" adds the live departments as
  referenced nodes (idempotent, parents before children).
- A node with `sourceDepartmentId` shows that department's active headcount as **current**; a planned-only node
  shows 0. A planned job title creates no Job row; a planned unit creates no Department row.
- Cycles in the tree are refused (a unit cannot be placed under itself); the root cannot move or be removed; a
  unit with children cannot be removed.
- **Finalize** stores an immutable `finalSnapshot` (tree, planned headcount, current figures at that moment) and
  freezes editing. The live organization is untouched; execution is a future workflow.

## 9. Scenario copies and comparison

**Duplicate** creates a new scenario with new ids for every node and planned position, same structure and
headcount, `duplicatedFromId` pointing back. Editing the copy never changes the original; two concurrent
duplicates yield two independent scenarios.

**Compare** (`/scenarios/:id/comparison`) gives current vs planned by unit (planned-only → current 0) and by
job across the scenario. **Compare two** (`/scenarios/:id/compare?with=`) gives totals, by unit and by job with
the difference. Numbers only — the API and the UI never name a best scenario.

## 10. Permissions and access

| Permission | Grants | Default roles |
|---|---|---|
| `workforce.view` | dashboard, cycles, plan rows, vacancies, reports (aggregate figures, row scope below) | MANAGER, HR, HR_ADMIN, EXECUTIVE, SYSTEM_ADMIN |
| `workforce.plan` | create/edit cycles, edit rows, initialize, planned movements | HR_ADMIN, SYSTEM_ADMIN |
| `workforce.manage` | finalize/archive, recruitment handoff (with `recruitment.manage`) | HR_ADMIN, SYSTEM_ADMIN |
| `organization_design.view` | scenarios, trees, comparisons | HR, HR_ADMIN, EXECUTIVE, SYSTEM_ADMIN |
| `organization_design.manage` | create/edit/duplicate/finalize scenarios | HR_ADMIN, SYSTEM_ADMIN |

Row scope: ALL data scope sees everything; TEAM scope (a manager with `workforce.view`) sees rows for their own
department and departments they head, in the dashboard, plan, vacancies and datasets — the company total never
appears through TEAM; SELF scope sees nothing. EMPLOYEE holds none of these permissions. No service checks a role
name.

## 11. Reporting

- Workforce → Reports: current vs planned by department and job for a cycle; scenario vs current; scenario vs
  scenario.
- Report Center datasets (aggregate-safe, Task 30 registry): `workforce_plan_summary` (cycle, department, job,
  current, planned, delta, classification, reason, priority, target date — no notes) and
  `organization_design_summary` (scenario, unit, type, planned-only, planned headcount — no notes). Individual
  planned movements are not exposed as a dataset.

## 12. Audit

`CREATE_WORKFORCE_CYCLE`, `UPDATE_WORKFORCE_CYCLE`, `INITIALIZE_WORKFORCE_PLAN`, `UPDATE_WORKFORCE_PLAN_ITEM`,
`FINALIZE_WORKFORCE_CYCLE`, `CREATE_WORKFORCE_PLANNED_MOVEMENT`, `UPDATE_WORKFORCE_PLANNED_MOVEMENT`,
`CREATE_ORG_DESIGN_SCENARIO`, `UPDATE_ORG_DESIGN_SCENARIO`, `UPDATE_ORG_DESIGN_STRUCTURE`,
`DUPLICATE_ORG_DESIGN_SCENARIO`, `FINALIZE_ORG_DESIGN_SCENARIO`, `CREATE_REQUISITION_FROM_WORKFORCE_PLAN` in
module `workforce`. Notes are logged by length only.

## 13. What the module does not do

No headcount approval workflow, no financial budgeting, no salary-cost simulation (payroll stays out of planning),
no predictive demand or attrition forecast, no automatic position/department/job creation, no automatic
restructuring or employee movement, no termination planning, no optimization or "best scenario", no skills-based
hiring recommendation, no advanced org-chart graphics (a simple tree), no external planning integration, no
copilot tool (Task 31 answers about workforce plans are a later, aggregate-only addition), no executive analytics
integration yet (the workforce dashboard owns these figures).
