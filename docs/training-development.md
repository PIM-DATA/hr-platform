# Training and development

How a competency gap becomes a development need, a course, a place on a session and a plan — and how all of that
stays clearly separate from the question of whether somebody actually got better.

> **Completing a course is not the same as becoming more capable.** Finishing Advanced SQL is evidence that
> development happened. Whether somebody's SQL level has moved is a question only a competency assessment answers.
> Nothing in this module raises a competency level, and nothing downstream of it may.

---

## 1. The shape of it

```
competency gap ──► training need ──► course / session ──► enrolment ──► result
                        └──────────► development plan (IDP) ──► activity ──┘
```

Five things, and the boundaries between them are the design.

## 2. Training needs analysis (TNA)

"Generate" asks the competency module for today's skill gaps and raises **one need per employee and competency that
is actually below its requirement**. It calls `skillGapService.getSkillGapsForDevelopment(...)` and never reads a
competency assessment table: one definition of a gap in the system, one place it can be wrong.

### Unassessed is not a need

A competency nobody has assessed produces **no** training need, ever. "Nobody has looked" is a reason to assess
somebody, not evidence that they are deficient, and turning it into a need would fabricate a shortfall the size of the
whole requirement. Generation returns those separately as `assessmentRequired` — a list of people to assess — and the
screen says so in as many words.

### Idempotency

Re-running a generation is normal: after a new assessment round, after a department joins. An employee and competency
that already has an open need (`OPEN`, `PLANNED` or `IN_PROGRESS`) is counted as `alreadyOpen`, never duplicated. A
need that was fulfilled and has since re-opened as a gap does get a new one — that is a different gap, at a different
time.

### The gap snapshot

A gap-based need freezes the numbers it came from: current level, required level, gap, job, department and the
assessment date. When the job's requirement moves next month the need still explains why somebody was sent on a
course. What the gap is *today* is shown beside it (`currentGapStatus`), fetched live from the competency module and
never acted on automatically: whether the development is still worth doing is a person's decision.

### Manual needs

HR raises needs by hand too — compliance, a new system, a leadership workshop — with no competency attached.

## 3. Course catalogue

A course records that it exists, how it is delivered, roughly how long it takes, who provides it, and **which
competencies it is relevant to developing**. No content is hosted.

That mapping is a pointer for whoever is choosing a course. It is explicitly **not** a promise that finishing the
course puts anybody at a level: only a competency assessment decides a level, and the mapping carries no authority
to. "Suggested courses" on a need is that mapping filtered by the need's competency — deterministic, never ranked.

A referenced course is deactivated, not deleted; an inactive course keeps its history and takes no new sessions.

## 4. Sessions

One scheduled run of a course. The course's code and title are frozen on the session, so renaming a course never
makes an old training record unreadable. Instants are stored in UTC and the session carries its own IANA timezone;
nothing assumes an offset.

```
DRAFT ──open──► OPEN ──start──► IN_PROGRESS ──complete──► COMPLETED
                  └────────────────────────────cancel──────► CANCELLED
```

**Completing a session completes nothing for anybody.** One attendee may have passed, another failed, a third never
arrived; each outcome is recorded deliberately.

**Cancelling a session** is atomic: every open place is cancelled, every need that was waiting on it goes back to
`PLANNED`, every plan item is un-linked, and everybody on it is told.

## 5. Enrolment

HR books people, singly or in bulk. Employees see the catalogue but do not self-enrol — that needs an approval and
capacity policy the product does not yet have, so it is deferred rather than half-built.

- **Capacity** is checked under the session's row lock, so a session with one seat cannot end up with two people on
  it however simultaneous the requests. A full session answers with a skipped row, not a booking.
- **One place per person per session**, enforced by a unique constraint; somebody cancelled earlier is re-booked
  onto the same row.
- **Source** (`MANUAL`, `TNA`, `IDP`) and the linked need or plan item are kept, so a training record explains why the
  person was there.

## 6. Attendance and results

Attendance is `ATTENDED` or `NO_SHOW`; the result is `COMPLETED` or `FAILED`, with an optional score and note. This is
training attendance and has nothing to do with the work-attendance module.

A recorded outcome is **final**: there is no correction workflow in this release, so nothing silently overwrites a
completion with a no-show.

| Outcome | Linked need | Linked plan item |
|---|---|---|
| `COMPLETED` | `FULFILLED` | `COMPLETED`, progress 100 |
| `FAILED` | unchanged (still in progress) — can be booked again | unchanged |
| `NO_SHOW` | unchanged | unchanged |
| place cancelled / session cancelled | back to `PLANNED` | back to `PLANNED`, un-linked |

And in every row of that table, the competency level is untouched.

## 7. Training history

An employee's history is the enrolment table read back — course, dates, status, score, source, the competency and
need it related to. There is no second table to drift out of step.

## 8. Development plans (IDP)

A plan is what somebody is going to do about their development this period. Training is one development type of
several — `TRAINING`, `OJT`, `COACHING`, `MENTORING`, `SELF_STUDY`, `PROJECT`, `OTHER` — which is the reason a plan
exists rather than a list of courses.

- HR creates the plan; one plan in flight per employee per overlapping period.
- An activity can be raised from a need, inheriting the competency and its wording, **frozen** so a renamed
  competency never makes an old plan unreadable.
- `DRAFT → ACTIVE → COMPLETED` (or `CANCELLED`). Activating needs at least one activity.
- The employee updates progress and their own note on active, non-training activities. A `TRAINING` activity booked
  against a session completes when that training is recorded complete — two records of the same fact would disagree.
- Completing a plan is an explicit action, guarded: every activity that is not cancelled must be complete.

OJT here is an activity type only. Checklists, trainer sign-off and hour tracking are a later task.

## 9. Permissions and who sees what

| Permission | Default roles | What it allows |
|---|---|---|
| `training.view` | EMPLOYEE, MANAGER, HR, HR_ADMIN | the catalogue, your own record and needs |
| `training.manage` | HR_ADMIN | needs, courses, sessions, TNA generation, reports |
| `training.enroll` | HR_ADMIN | book and cancel places |
| `training.record_result` | HR_ADMIN | attendance and results |
| `idp.view` | EMPLOYEE, MANAGER, HR_ADMIN | your own plan |
| `idp.manage` | HR_ADMIN | create and manage plans |

A training administrator's authority comes from their permission, not from who reports to them. An employee's is
over their own record. A manager's team scope gives a **summary** — counts of open needs, active plans, upcoming and
completed training per report — and nothing more. An executive has none of these by default.

### Comments

| Field | Who sees it |
|---|---|
| `employeeComment` | the employee, their manager, HR |
| `managerComment` | the employee, their manager, HR |
| `hrComment` | HR only — omitted from the response for everybody else |

None of them ever reaches a log, a notification or an audit payload, which records only that a comment changed.

## 10. Notifications

`TRAINING_ENROLLED`, `TRAINING_SESSION_UPDATED`, `TRAINING_COMPLETED`, `IDP_ACTIVATED`, `IDP_COMPLETED` — a course
title, a date or a plan title at most. Never a score, a result, a gap breakdown or a comment. In-app only. There is no
"due soon" reminder, because there is no scheduler, and a notification that pretends to be scheduled would be a lie.

## 11. Reporting

Two definitions everything rests on:

- **Completion rate** = `completed ÷ (completed + failed + no-show)`. Cancelled places are excluded — a session that
  was called off says nothing about whether training works — and people still enrolled have not finished.
- **Training hours** come from the course's own duration and count only places that were **attended or completed**.
  Somebody booked who never turned up did not spend the hours.

Breakdowns by department, course and delivery method; need counts by status and source; plan counts by status. The
by-course view lists which competencies a course is relevant to — it never reports that a skill improved, because
nobody was reassessed and there is no evidence for it.

## 12. History and transfers

Enrolments, needs and plans carry the employee's department and job as they were. A transfer does not move a
finished training record; the manager's team view uses the current org chart, because that is who manages them
today. Both are right, for different questions.

## 13. Known limitations

1. No LMS, SCORM or e-learning content of any kind.
2. No online exam engine — results are recorded by HR from whatever was assessed externally.
3. No training request or approval workflow; employees do not self-enrol.
4. No waitlist when a session is full.
5. No budget, procurement, cost or reimbursement.
6. No certificate upload or file storage.
7. No full OJT workflow (checklists, sign-off, hours).
8. No external provider integration; a provider is a name.
9. No AI recommendation of courses or activities.
10. **No automatic competency increase after training** — by design, permanently.
11. No career path or succession linkage.
12. No scheduler: no due-soon reminders, no automatic stage changes.
13. No training effectiveness framework (no Kirkpatrick levels, no before/after).
14. No correction workflow for a recorded result.

## 14. Performance

Measured on the development database with 100 employees and five gaps each: TNA generation of 500 needs in ~100 ms,
the idempotent re-run in ~14 ms, bulk enrolment of 100 people in ~60 ms, the overview report in ~25 ms. Generation
consumes the gap service in one batch per population and writes needs in one `createMany`; nothing loops per row.
