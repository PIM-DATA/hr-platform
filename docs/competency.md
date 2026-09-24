# Competency and skill gaps

What each job needs, where each person actually is, and the difference between the two — and how all three stay true
when any one of them moves.

> **A competency is not a performance KPI.** Performance measures what somebody achieved in a cycle; competency
> measures how capable they are against what their job requires. The two are separate on purpose: a good year does
> not raise somebody's SQL level, and a skill gap is not a bad review. Nothing in this module reads a performance
> score, and nothing in it writes one.

---

## 1. The shape of it

1. a **proficiency scale** — the levels everything is measured on, written by the customer;
2. the **competency library** — the things people can be more or less good at, each on one scale, grouped by category;
3. a **job competency profile** — what a job requires, and to what level;
4. an **assessment cycle** — one round, with a self assessment and the reviewer's;
5. a **skill profile and gap** — the latest assessed level against today's requirement.

## 2. Proficiency scales

A scale is a list of levels with labels: `1 Awareness, 2 Basic, 3 Working, 4 Advanced, 5 Expert` is an example, not a
default. At least two levels, because a scale with one cannot express a gap.

**Once competencies use a scale, its rungs are frozen.** An assessment recorded "3" on the understanding of what 3
meant, so adding or removing a level would silently rewrite every one of those (`COMPETENCY_SCALE_IN_USE`). The
wording of a level can always be improved — that clarifies what was always meant rather than changing it.

## 3. Competencies

A competency has a stable code, a category, exactly one scale, and optional **behaviour indicators**: what each level
looks like in practice, so two reviewers mean the same thing by "level 3".

A competency's scale cannot be changed after creation — re-basing recorded levels onto a different scale would make
all of them ambiguous. A competency that a job profile or an assessment refers to can be **deactivated but never
deleted**.

## 4. Job competency profiles

Requirements belong to the **job**. A position already names a job, and an employee holds a position, so the chain is:

```
employee → position → job → required competencies
```

Per-employee requirements would create a second master of what work needs, and the two would disagree within a month.
Position-specific overrides are a later problem.

Each requirement has a level (validated against that competency's scale), an optional **weight** and a mandatory
flag. The weight is a **priority, not a percentage**: a competency framework says what matters more, and there is no
reason for it to add up to 100. Nothing derives a score from it in this release — it is carried through to the
development hand-off so planning can decide how to use it.

## 5. Assessment cycles

```
DRAFT ──activate──► ACTIVE ──open assessment──► REVIEW ──close──► CLOSED
```

Each step is a decision somebody makes; there is no scheduler. Assessments follow their cycle: opening the assessment
stage hands each one to whoever owes the first — the employee, or the reviewer directly when
`selfAssessmentRequired` is false.

An assessment's own states are `DRAFT → ACTIVE → SELF_REVIEW → MANAGER_REVIEW → FINALIZED`. "Self submitted" is not a
state of its own: it is the same instant as `MANAGER_REVIEW`, and two names for one moment is how state machines
start lying.

## 6. Assignment

HR assigns a population at once — a list of employees, or an organization, department, job or position. Each
assessment **snapshots the job profile** onto itself: the competency's code, name and category, the scale's labels,
the behaviour indicators, the required level, the weight and the mandatory flag.

Three things are refused rather than guessed:

| Situation | What happens |
|---|---|
| The employee's position has no job | skipped, with that reason |
| The job has no competency profile | skipped, with that reason — never an empty assessment |
| Already assigned in this cycle | counted as `alreadyAssigned`, never duplicated |

An empty assessment would look like an oversight by the reviewer rather than a gap in the framework, and the person
who can fix it is HR.

## 7. Reviewers

The reviewer defaults to the employee's **direct manager**, resolved and frozen when the assessment is created, and
they need an active account to open it. HR can reassign explicitly (audited); changing the org chart does not move an
assessment already under way.

An employee without an account still gets an assessment — they are an employee and belong in the population — but
cannot fill in the self assessment, which is flagged rather than silently stuck. No account is ever created to work
around it.

## 8. The two assessments

**Self assessment**: the employee picks a level from the scale for each competency and comments. Every competency
must have a level, and submitting is one-way.

**Manager assessment**: the reviewer sees the requirement, the indicators, the self level and the employee's comment,
and records their own level.

**The final level is the reviewer's level.** Not an average of the two: a self assessment is evidence a reviewer
reads, not half a vote, and averaging would produce a number neither person said.

## 9. The gap

```
gap        = requiredLevel − finalLevel      (signed)
gapNeeded  = max(0, gap)                     (what development would act on)
```

| Status | Meaning |
|---|---|
| `GAP` | below the requirement |
| `NO_GAP` | at it |
| `EXCEEDS_REQUIREMENT` | above it — kept, not clamped away |
| `UNASSESSED` | nobody has looked |

**UNASSESSED is not zero.** An employee nobody has assessed has an *unknown* level, which is a different fact from
being assessed and found at the bottom of the scale; reporting them the same way would invent a deficiency nobody
measured. `currentLevel` and `gapNeeded` are both `null` in that case.

No LOW/MEDIUM/HIGH severity is invented: what a two-level gap means depends on the scale and the customer, and the UI
can sort by magnitude without the server pretending to know.

## 10. Historical assessment vs current skill profile

Two questions that look alike and are not:

| | Requirement used | Answers |
|---|---|---|
| **Assessment** | the requirement snapshotted at the time | "how did that round come out?" |
| **Skill profile** | the employee's **current** job's requirement | "where do they stand today?" |

So when a job's SQL requirement goes from 4 to 5: the finished assessment still reads *required 4, gap 1*, and the
skill profile reads *required 5, current 3, gap 2*. Both are true, and keeping them apart is the design.

A transfer works the same way. The new job's requirements apply from today; a level assessed under the old job is
still a known level for that competency; a competency the new job needs that was never assessed is `UNASSESSED`, not
zero; and a competency the new job does not require is still listed with its assessed level, because a skill does not
stop existing when somebody changes jobs.

## 11. Permissions and privacy

| Permission | Default roles | What it allows |
|---|---|---|
| `competency.view` | EMPLOYEE, MANAGER, HR, HR_ADMIN, EXECUTIVE | your own profile and assessments, and aggregate gap reports |
| `competency.assess` | MANAGER, HR_ADMIN | assess the assessments you are the snapshot reviewer for |
| `competency.manage` | HR_ADMIN | the framework, job profiles, cycles, assignment, reviewer reassignment, the development hand-off |

Reading **one person's** assessment or profile requires being that person, their snapshot reviewer, or holding
`competency.manage`. A manager's team scope is enough for aggregate team numbers and nothing else — what a reviewer
wrote about somebody is not team data.

Assessment comments live on the assessment and nowhere else: never in a notification, a report, a general list or an
audit payload, which records only that comments exist (`commentedItems`) and who submitted them.

## 12. Reporting

Aggregate only, over finalized assessments, using each assessment's own snapshots: coverage (against what the cycle
**assigned**, never the whole employee master), totals, the competencies most people are short on, and breakdowns by
department and job.

## 13. The development hand-off (Task 25)

```
getSkillGapsForDevelopment({ employeeId?, organizationId?, departmentId?, jobId?, gapOnly? })
```

Also available over HTTP as `GET /competency/skill-gaps` behind `competency.manage`. It returns one row per employee
and requirement: current level, required level, `gapNeeded`, gap status, job, department and when it was assessed.

Whatever consumes a skill gap — a training needs analysis, an individual development plan — reads it from here rather
than recomputing it from the tables, so there is **one definition of a gap** in the system, one place it can be
wrong, and one place to fix it. Unassessed rows are included as `UNASSESSED` with a null gap: planning may well
decide that "nobody has looked" is itself a need, but that is its decision, not an assumption buried in this query.

Nothing here recommends training. Mapping a gap to a course is Task 25's job.

## 14. Known limitations

1. No training catalogue, request or enrolment, and no mapping from a gap to a course.
2. No training needs analysis or individual development plan.
3. No certification tracking or expiry.
4. No skill endorsement or peer verification.
5. No 360-degree competency assessment — one reviewer per assessment.
6. No HR override of an assessed level.
7. No position-specific requirement override; requirements are per job.
8. No AI skill inference, CV parsing or automatic level suggestion.
9. No evidence attachments on an assessment.
10. No automated reassessment schedule or expiry of an assessed level.
11. No link to performance scores in either direction.
12. No link to pay: a gap creates no allowance, adjustment or payroll effect.
13. No reopen or correction after a cycle closes.

## 15. Performance

Measured on the development database with 100 employees and a five-competency job: assignment of 101 assessments and
505 items in ~308 ms, the full gap report over 101 assessments in ~14 ms, the development hand-off (505 rows) in
~16 ms, one skill profile in ~3 ms. Requirements are loaded once per distinct job, not once per employee.
