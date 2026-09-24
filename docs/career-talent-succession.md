# Career paths, talent review and succession

Where people could go, what the target roles ask for, and what the organization has recorded about potential and
succession — with the decisions left to people.

> **Decision support, not decisions.** This module shows performance history, competency gaps, development
> context, readiness against a target job and a named reviewer's potential judgment. It never says "promote this
> person", never says "this is the best candidate", never ranks employees 1..N, never nominates a successor and
> never infers potential from anything. Every verdict-shaped field in it is a person's recorded choice with that
> person's name on it.

---

## 1. What is in it

1. **Career paths** — job-to-job transitions the organization considers possible.
2. **Career readiness** — the Task 24 gap rule applied to a *target* job's competency profile.
3. **Talent review cycles** — a finalized performance cycle plus a human potential assessment, giving a 9-box cell.
4. **Talent pools** — named groups, filled by hand.
5. **Succession plans** — for a position, with nominated successors and a recorded readiness.
6. **Development handoff** — a training need raised from any of the above through Task 25's own service.
7. **Aggregate reports** and a reusable `getTalentSummary(employeeId)` for the future employee 360 page.

## 2. Permissions

| Permission | Default holders | Opens |
|---|---|---|
| `career.view` | EMPLOYEE, MANAGER, HR, HR_ADMIN | The caller's own career page and readiness; nothing about anybody else |
| `career.manage` | HR_ADMIN | Career paths and steps |
| `talent.view` | MANAGER, HR, HR_ADMIN | Talent reviews within scope (own assignments; TEAM scope: direct reports' cells), pools list, team career summary |
| `talent.assess` | MANAGER, HR_ADMIN | Submitting a potential assessment — **only** as the assigned reviewer |
| `talent.manage` | HR_ADMIN | Cycles, bucket rules, assignment, reassignment, every review, pools and members, development actions |
| `talent.view_reports` | HR, HR_ADMIN, EXECUTIVE | Aggregate talent and succession reports and 9-box counts — never an individual |
| `succession.view` | HR, HR_ADMIN | Plans and nominees (without notes) |
| `succession.manage` | HR_ADMIN | Plans, nominations, readiness, removal, notes |

TEAM scope on its own writes nothing: a manager with `talent.view` sees their reports' cells but submits a potential
assessment only for the reviews assigned to them. No data scope grants succession administration. An employee never
sees a 9-box, a nomination, a potential level or a comment about themselves. EXECUTIVE holds `talent.view_reports`
only.

## 3. Career paths

A path has a code, a name, an optional organization and a set of **steps** `fromJob → toJob` (unique per path, from
≠ to, optional order). A path is a graph, not necessarily a line; the UI shows the ordered steps.

A path is **what the organization considers possible**. It is not an entitlement, not a promise and not a
promotion queue. The decision to move anybody is made by people, elsewhere — there is no movement workflow here.

## 4. Career readiness

`GET /talent/career/readiness?targetJobId=…` (and the same projection inside `GET /talent/career/me`, succession
candidate context and the talent review context) calls `skillGapService.getGapsAgainstJob({ employeeId, jobId })` —
the Task 24 service, with the target job's **job competency profile** as the requirement set. Same latest finalized
levels, same `calculateGap`, same semantics:

- **UNASSESSED ≠ level 0.** An unassessed competency is "assessment required", never a deficiency.
- Raising a requirement creates a gap from today; it rewrites no finished assessment.
- Nothing recomputes a gap from raw tables and no second requirement set exists.

The status is one of `READY_REQUIREMENTS_MET`, `GAPS_EXIST`, `ASSESSMENT_REQUIRED`, `NO_REQUIREMENTS_DEFINED`.
**"Requirements met" describes competency requirements only.** It is not "eligible for promotion", the UI says so
next to every table, and no field anywhere says `PROMOTE` or `BEST_FIT`.

The employee's page (HRD → Career & talent → My career) shows the current job, the paths it sits on, the jobs one
step away and, for each, the requirement table, with links to Competency and Training & development.

## 5. Talent review cycles

A cycle has a code, name, period, optional organization, an optional **performance cycle** (must be in REVIEW or
CLOSED — the talent review reads finalized results only) and the organization's own **potential levels**: three
codes `LOW` / `MEDIUM` / `HIGH` with the organization's labels and descriptions. The system defines no universal
meaning for potential; the customer writes the criteria.

```
DRAFT ──activate──► ACTIVE ──open review──► REVIEW ──close──► CLOSED (immutable)
                     (assign + submit)       (submit only)
```

### Performance buckets

Which rating counts as low, medium or high performance is **the cycle's configuration**: one rule per rating band
of the linked performance cycle, `ratingCode → bucket`. Every band must map to exactly one bucket; a missing,
duplicated or unknown code is refused (`BUCKET_RULES_AMBIGUOUS`). Nothing in the code says "4 = high". A cycle with
a performance cycle cannot activate without complete rules. Changing the rules before closing rebuckets the
unfinalized reviews — the snapshotted *score* never changes, only the organization's reading of it.

### Assignment

`POST /talent/cycles/:id/assign` (by department or employee ids) creates one review per employee and snapshots:
their organization, department, job and position; their FINALIZED performance plan in the linked cycle (score,
rating code and label, cycle name — never recalculated); the performance bucket; and their **direct manager as
reviewer** (employee, user, name), provided the manager has an active account. The reviewer is notified
(`TALENT_REVIEW_REQUIRED`: employee name and cycle only). HR can reassign a reviewer until submission; a reviewer
cannot be the employee.

### Potential assessment

`POST /talent/reviews/:id/potential` — `talent.assess` **and** `reviewerUserId === caller`. Written once
(`TALENT_REVIEW_SUBMITTED` on a repeat; two concurrent submissions leave one). The reviewer picks a level on the
cycle's scale and may write a comment. The UI states, and the docs repeat: potential is an organizational talent
judgment on the organization's own criteria, based on the role and the evidence shown — never on age, gender,
health, family, religion, pay, absence or disciplinary history. The system reads none of those.

The **comment** is the most sensitive text in the module: reviewer and `talent.manage` only. It never reaches an
audit payload (length only), a notification, the employee's page, a team summary or a report.

### The 9-box

`nineBoxCell = <performanceBucket>_PERFORMANCE_<potentialLevel>_POTENTIAL`, e.g.
`HIGH_PERFORMANCE_MEDIUM_POTENTIAL`. It is a **label for a distribution**: `GET /talent/cycles/:id/nine-box` returns
a count per cell and how many reviews are unplaced. Cycle managers click a cell to list the people in it; report
readers get the counts. There is no ordinal rank anywhere — not within a cell, not across the grid — and nothing
happens because of a cell: no pool membership, no nomination, no promotion.

### Closing

`POST /talent/cycles/:id/close` finalizes every SUBMITTED review and freezes the cycle. Unsubmitted reviews stay
ASSIGNED as a record that they were not done. A later performance cycle, correction or reorganization rewrites
nothing in a finalized review; the next cycle reads the new performance.

## 6. Talent pools

A pool has a code, a name, a description and an optional organization; the customer names them. **Members are added
by hand** (`talent.manage`) with a reason and optionally the talent review that prompted it — no cell, score or
rule adds anybody. Adding somebody who is already an active member returns that membership (idempotent, one active
membership per person per pool). Removal marks the row with who, when and why; the history is kept. Employees are
not notified of pool membership.

## 7. Succession plans

A plan is for a **position** — the real seat a successor would take over (Career paths, by contrast, are between
jobs). It freezes the position title, job, department and organization as they were; one open plan per position.
**Criticality** (`NORMAL` / `IMPORTANT` / `CRITICAL`) is set by a person and inferred from nothing.

```
DRAFT ──activate──► ACTIVE ──close──► CLOSED (immutable)
```

A **nomination** is one person's act: the employee, a readiness (`READY_NOW` / `READY_SOON` / `DEVELOPING`), an
optional target date and notes, with the nominator's name and the candidate's job, department and position **as they
were**. One active nomination per employee per plan (a repeat returns it). Readiness is edited by hand
(`UPDATE_SUCCESSOR_READINESS`), never derived from a score. Removal keeps the row with who, when and why.

**Candidate context** (`GET /talent/succession/candidates/:id/context`) shows two things kept deliberately apart:
the *historical nomination* (job then, readiness recorded, notes) and the *current development context* (job now,
readiness against the plan's job via §4, latest finalized performance, latest finalized talent review cell, open
needs and active IDP). No composite score, no ordering of candidates. Notes reach `succession.manage` only.

**Employees are not notified** that they were nominated, by default: organizations differ on whether succession is
confidential, and this module does not pretend otherwise with a fake notification.

## 8. Development handoff

`POST /talent/development-actions` (`talent.manage` or `succession.manage`) creates a **training need** through
`trainingNeedService.create` — Task 25's own service, table, statuses and audit — for an employee, optionally tied
to a competency, and records where it came from (`CAREER` / `SUCCESSION` / `TALENT_REVIEW`) in a second audit line.
It is an explicit human action from a readiness table, a talent review or a succession candidate. It enrols nobody
on anything and changes no competency level; from there Task 25's rules apply.

## 9. Historical snapshots

- A talent review keeps the performance score, rating and cycle name it was assigned with; the employee's
  organization, department, job and position at that time; and the reviewer identity. Later transfers, corrections
  and cycles rewrite nothing.
- A succession plan keeps the position's job, department and organization at creation; a nomination keeps the
  candidate's job, department and position at nomination. The candidate context shows the current facts next to
  them, labelled as such.
- Pool memberships and nominations are never deleted; removal is a state with an actor and a time.

## 10. Confidentiality

| Data | Who sees it |
|---|---|
| Own career page and readiness | The employee (`career.view`) |
| Somebody's readiness | Their manager (`talent.view` + TEAM/ALL scope), `talent.manage`, `succession.manage`, `career.manage` |
| Potential level and 9-box cell | The reviewer of that review, `talent.manage`; a manager sees direct reports' cells; the employee never |
| Potential comment | The reviewer and `talent.manage` only |
| Pool membership | `talent.manage` (members); `talent.view` sees pool counts |
| Succession plans and nominees | `succession.view` / `succession.manage`; notes and removal reasons `succession.manage` only |
| Aggregate reports, 9-box counts | `talent.view_reports` (EXECUTIVE, HR, HR_ADMIN) |

Audit payloads carry codes, counts and text lengths — never a comment, a note or a rejection reason's text.
Notifications carry an employee name and a cycle name at most. Server logs carry request ids.

**Personal-data export** (`POST /privacy/employees/:id/export`) includes the factual records that exist about the
subject — talent review participation (cycle, status, dates, snapshotted job and rating label), pool memberships
(pool, dates, status) and succession nominations (target position, recorded readiness, dates) — and states under
`notIncluded` that potential levels, 9-box placement, reviewer comments and succession notes are internal
organizational judgments whose disclosure is a policy decision made outside this export. This is the documented
default; a customer whose policy discloses them changes the export, not the module.

## 11. What this module does not use

No payroll or compensation data anywhere in talent. No employee-relations or disciplinary records: a warning does
not lower potential, exclude a successor or move a cell, and nothing here reads that table. No recruitment
candidates: succession is internal employees only. No protected attributes.

## 12. Audit

`CREATE_CAREER_PATH`, `UPDATE_CAREER_PATH` (including steps), `CREATE_TALENT_CYCLE`, `UPDATE_TALENT_CYCLE` (edits,
bucket rules, activation, review), `ASSIGN_TALENT_REVIEW` (including reassignment), `SUBMIT_POTENTIAL_ASSESSMENT`,
`FINALIZE_TALENT_REVIEW` (cycle close), `CREATE_TALENT_POOL`, `UPDATE_TALENT_POOL`, `ADD_TALENT_POOL_MEMBER`,
`REMOVE_TALENT_POOL_MEMBER`, `CREATE_SUCCESSION_PLAN`, `UPDATE_SUCCESSION_PLAN`, `NOMINATE_SUCCESSOR`,
`UPDATE_SUCCESSOR_READINESS`, `REMOVE_SUCCESSOR`, `CREATE_DEVELOPMENT_ACTION_FROM_TALENT` — module `talent`, actor
on every line.

## 13. Known limitations

No automatic promotion, no AI or rule-based ranking, no automatic successor recommendation, no external successors,
no employee movement workflow, no compensation or bonus linkage, no predictive attrition or risk score, no workforce
forecasting, no succession simulation, no advanced replacement chart (the plan list and detail are the chart), no
psychometric assessment, no talent marketplace or external coaching, no employee-visible nomination, no AI career
recommendation, no time-based readiness reminders, no calibration sessions, no multi-rater potential.
