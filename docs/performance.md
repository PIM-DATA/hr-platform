# Performance management

How an appraisal round is set up, what each person is measured on, who assesses them, how a score is arrived at — and
what this release deliberately does not do.

> **This is a performance process, not a pay decision.** Nothing here touches payroll: a rating creates no bonus, no
> increase and no pay component. The link between a review and money is a decision a company makes, and it is not
> automated in this release.

---

## 1. The shape of it

Four things, in order:

1. a **cycle** — the period people are appraised for, with its own score scale and rating bands;
2. the **KPI library** — reusable definitions of the things people get measured on;
3. a **plan** — one employee, one cycle, the KPIs they were given and what they weigh;
4. two **assessments** — the employee's own and their reviewer's, the second of which closes the plan.

Everything after step 3 is history in the making, which is why so much of what follows is about freezing things.

## 2. Cycles

A cycle carries its period, optional self- and manager-review windows, whether a self review is required at all, the
score scale (`minScore`, `maxScore`, `scoreStep`) and its rating bands. Nothing assumes 1–5: a customer scoring out of
10, or in steps of 0.5, changes three fields.

```
DRAFT ──activate──► ACTIVE ──open review──► REVIEW ──close──► CLOSED
```

Each step is a decision somebody makes, not a date passing: there is no scheduler in this release, and the review
windows are guidance the screens show, not automation.

- **DRAFT** — configuration and plan structure can still change. The scale and bands can only be edited here.
- **ACTIVE** — employees record progress against their plans.
- **REVIEW** — the assessments happen; KPIs, weights and targets are frozen.
- **CLOSED** — history. Nothing inside the cycle changes again, and there is no reopen.

## 3. The KPI library

A KPI is a **template**: a code, a name, how it is measured (`NUMBER`, `PERCENTAGE`, `BOOLEAN`, `MILESTONE`,
`QUALITATIVE`), an optional unit and an optional default weight. Adding it to a plan **snapshots** its code, name,
description and measurement onto the plan item.

That snapshot is the whole point: renaming a KPI, recategorising it or retiring it changes the library and nothing
else. Last year's reviews keep reading exactly as they did.

## 4. Plans and snapshots

A plan freezes, at the moment it is created:

| Frozen | Why |
|---|---|
| employee code and name | reporting keeps working after a rename |
| organization, department, position, job | a transfer in October must not move a January result into another department's average |
| reviewer (employee, user account and name) | a change of manager does not hand somebody else a review already under way |

Reporting reads those snapshots, never today's org chart — the same principle the leave and payroll reports use.

## 5. Reviewer resolution

The reviewer defaults to the employee's **direct manager**, resolved and snapshotted when the plan is created. The
manager needs an **active user account**, because they have to open the review; a plan without a usable reviewer
cannot be submitted (`PERFORMANCE_REVIEWER_REQUIRED`), and HR can assign a different reviewer explicitly.

Changing the org chart afterwards does not move the review. Reassignment is an explicit act, recorded in the audit
log, which is what makes "who reviewed whom" answerable a year later.

## 6. Employees without an account

A plan can exist for somebody who has no login — they are an employee, and they belong in the cycle's population and
its reporting. What they cannot do is fill in a self assessment, so the plan is flagged
(`selfReviewUnavailable`) and HR can see exactly who that applies to. The system never creates an account to work
around it.

## 7. Weights

Weights are **percentage points** as decimal strings, and a plan's must add up to **exactly 100.00** before anybody
can submit an assessment (`PERFORMANCE_WEIGHT_INVALID`). 33.33 + 33.33 + 33.34 is exactly 100; a float would make that
a coin toss, and a review blocked by 99.999999% would be unexplainable to the person it blocked.

## 8. Scoring

**The manager's score is the score.** A KPI's target and actual are evidence a reviewer reads; they are not converted
into a rating automatically.

That is a deliberate limit rather than an omission. "Sold 92 of 100" means something different for a sales target, a
defect count, a threshold and a range, and a rule engine that knew the difference does not exist yet. Guessing would
produce numbers that look authoritative and are wrong. The employee's self score is recorded for comparison and never
enters the calculation.

```
weightedScore = SUM( managerScore × weight / 100 )
```

Two decimal places, half-up, in `Prisma.Decimal`, rounded **once** at the end — rounding each term first lets three
KPIs at 33.33% drift away from the score the reviewer thought they were giving. Scores cross the wire as strings and
nothing in the browser calculates one.

## 9. Rating bands

Bands are configured per cycle: a code, a label and an inclusive score range. They must not overlap, must sit inside
the scale, and must cover the whole scale before a cycle can be activated — a finalized score landing in a gap would
have no rating to show.

The label is **snapshotted** onto the plan when it finalizes, so renaming a band later never rewrites what somebody
was told.

## 10. The two assessments

**Self review** (when the cycle requires one): the employee scores each KPI and comments. Every KPI must be scored,
each score must sit on the scale, and the weights must add up. Submitting is one-way — after that it belongs to the
reviewer.

**Manager review**: the snapshot reviewer sees the target, the actual, the employee's comment and their self score,
and records their own score and comment. Submitting calculates the weighted score, resolves the rating and finalizes
the plan.

```
DRAFT → ACTIVE → SELF_REVIEW → MANAGER_REVIEW → FINALIZED
```

A cycle with `selfReviewRequired = false` goes ACTIVE → MANAGER_REVIEW. A manager review is always required; nothing
finalizes itself.

## 11. Permissions and who sees what

| Permission | Default roles | What it allows |
|---|---|---|
| `performance.view` | EMPLOYEE, MANAGER, HR, HR_ADMIN, EXECUTIVE | your own plan, and aggregate reports |
| `performance.review` | MANAGER, HR_ADMIN | assess the plans you are the snapshot reviewer for |
| `performance.manage_cycles` | HR_ADMIN | cycles, assignment, plan structure, reviewer reassignment |
| `performance.manage_kpis` | HR_ADMIN | the KPI library |

Reading **one person's** plan requires being that person, being their snapshot reviewer, or holding
`performance.manage_cycles`. A data scope grants nothing here: seeing a report's attendance is an operational need;
reading what their manager wrote about them is not, and the two must not be joined up by accident.

Writing an assessment is narrower still — `reviewerUserId == you`. A manager with the same permission and their own
team cannot touch a review assigned to somebody else, and HR does not review on a manager's behalf.

An executive's `performance.view` gives them their own plan and the aggregate reports, which contain no individual's
score, rating or comment.

## 12. Privacy of review comments

A review comment is a manager writing about a person. It appears in exactly one place: the plan, behind the rules
above. It is **never** in a notification body, a report, a general employee list or an audit payload — the audit
records that comments exist (`commentedItems`) and who submitted them, never a word of the text.

Notifications carry a cycle name and a person's name at most: `PERFORMANCE_REVIEW_OPENED`,
`PERFORMANCE_SELF_REVIEW_SUBMITTED`, `PERFORMANCE_MANAGER_REVIEW_REQUIRED`, `PERFORMANCE_FINALIZED`.

## 13. Bulk assignment

HR assigns a whole population at once — a list of employees, or an organization, department, job or position — and
gets one plan each. Re-running an assignment counts the people already assigned rather than failing, because adding a
department to a cycle that is already running is normal. Inactive employees are skipped and reported.

## 14. Reporting

Aggregates only, computed in the database: completion counts, the average final score, the rating distribution (every
band, including the empty ones), a department breakdown and a per-KPI average of the reviewers' scores. Every
dimension comes from the plan snapshots.

## 15. Known limitations

1. No 360-degree or peer feedback.
2. No calibration process or committee view.
3. No 9-box grid, talent matrix or succession linkage.
4. No forced ranking or distribution quotas.
5. No competency or skill scoring (that is its own module).
6. No bonus, increase or payroll linkage of any kind.
7. No OKR tree, key-result roll-up or goal dependencies.
8. No automatic achievement formula from target and actual — the reviewer scores.
9. No AI-written or AI-suggested review text.
10. No reopen or correction workflow after a cycle closes.
11. No automated cycle scheduler: stage changes are made by a person.
12. One reviewer per plan, and no second-level or skip-level approval.
13. No attachments or evidence files on a plan item.

## 16. Performance

Measured on the development database with 100 employees and 4 KPIs each: assignment of 101 plans in ~22 ms, the full
cycle report over 101 plans in ~22 ms, a page of 20 plans in ~6 ms. Assignment and reporting are batched and
aggregated in the database; nothing loops per employee.
