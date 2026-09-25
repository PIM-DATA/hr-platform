# OJT, learning paths and certifications

Structured practice beside the training catalogue. The competency module still owns every level; the training
module still owns courses, needs and IDPs; this module records **what somebody practised, who watched them do it,
what sequence of development they are on, and what they hold**. Nothing here changes a competency level, a job, a
grade, a performance result or an employee relations record.

---

## 1. Architecture

`apps/api/src/modules/learning/`: `ojt.service.ts` (programs, plans, activities, observations, assessment,
completion, competency-evidence handoff), `learning-path.service.ts` (paths, assignments, projected progress),
`certification.service.ts` (definitions, issue / renew / revoke, derived status), `learning-report.service.ts`
(dashboard, report), `learning.routes.ts` (`/api/v1/learning/*`), `learning.types.ts` (snapshots, scope, plan
numbers). Shared vocabulary and pure helpers (`certificationStatus`, `ojtProgress`, `activityCompletionBlockers`,
`addDaysIso`) live in `packages/shared/src/learning.ts`; schemas and DTOs in `packages/shared/src/schemas/learning.ts`.

Permissions (module `learning`): `ojt.view`, `ojt.manage`, `ojt.train`, `ojt.assess`, `learning_path.view`,
`learning_path.manage`, `certification.view`, `certification.manage`, `learning.view_reports`. Default grants:
employees view their own; managers add `ojt.train` and `ojt.assess` (which only mean something on a plan where HR
named them trainer); HR views and reads reports; HR admin manages; executives read reports only. Services check
permissions and the employee data scope, never a role name.

## 2. Module boundaries

| Owner | What it owns | What this module does with it |
|---|---|---|
| Competency (Task 24) | levels, assessments, gaps | reads competencies for objectives; writes **evidence pointers** (`competency_evidence`) on explicit handoff; never a level |
| Training (Task 25) | courses, sessions, enrolments, needs, IDPs | reads course completions for path steps; marks a linked need IN_PROGRESS / FULFILLED / OPEN; reads IDP items to confirm a path step; never writes an IDP |
| Documents (Task 30) | files, versions, access | links an activity or a certification to a document through `linkDocumentWithTx` (no bytes, no access widening) |
| Employees | master record | snapshots department / job / position at plan or assignment creation; never writes |
| Performance, ER, talent, payroll | their own records | nothing — NEEDS_PRACTICE, MORE_PRACTICE_REQUIRED, an expired certification or an unfinished path have no effect there |

## 3. OJT

- **Program** = template: competency objectives (a `targetLevel` is the *level of evidence expected*, validated on
  the competency's own scale, never a level the plan grants), ordered activities (OBSERVE / PRACTICE / PERFORM /
  REVIEW / OTHER, required or optional, expected days, document evidence required) each with observation criteria.
  A program must have at least one activity. Editing a program never touches existing plans.
- **Plan** = frozen copy per trainee: plan number `OJT-YYYY-NNNNNN` (per-year sequence under row lock), employee
  snapshot, program name, competencies, activities and criteria copied at creation. Optional links: a training need
  (validated as the trainee's) and an IDP item reference (read only).
- **Trainer** is chosen by HR: an employee with an active user account, snapshotted by name and user id. The trainer
  acts only on plans assigned to them; any other plan is a 404 for them.
- **Activation** (DRAFT → ACTIVE) requires a trainer, freezes the structure, notifies the trainee
  (`OJT_ACTIVITY_READY`) and the trainer (`OJT_PLAN_ASSIGNED`), and moves a linked need to IN_PROGRESS.
- **Activities**: PENDING → IN_PROGRESS → COMPLETED / SKIPPED. The trainee, the trainer or an OJT manager may move
  status; only the trainee writes the reflection; only the trainer or HR writes the trainer comment (which the
  trainee never sees). A required activity can be skipped only by an OJT manager. Finished activities are final.
- **Observations** are evidence, not scores: NOT_OBSERVED / MEETS / NEEDS_PRACTICE per criterion, **one final row
  per criterion per observer** (a resubmission replaces under a row lock). Only the assigned trainer or an OJT
  manager records them. Completing an activity requires every *required* criterion observed MEETS **by the assigned
  trainer**, plus a linked document when the activity requires evidence; the blockers are listed in the response
  (`422 OJT_ACTIVITY_INCOMPLETE`) and on the screen. NEEDS_PRACTICE blocks completion and nothing else.
- **Document evidence** is a Document Center link (`OJT_ACTIVITY` / `OJT_EVIDENCE`): the trainee, the trainer or an
  OJT manager may link a document they can already read. The link grants nobody access to the document. A second
  link is idempotent.
- **Final assessment** (trainer with `ojt.assess`, or an OJT manager): COMPLETED or MORE_PRACTICE_REQUIRED with a
  comment for HR and the trainer. It is a record; the plan stays ACTIVE either way and nobody fails anything.
- **Completion** is HR's explicit act, allowed when every required activity is COMPLETED or SKIPPED, exactly once
  under a row lock. It records the date, marks a linked need FULFILLED, notifies the trainee (`OJT_COMPLETED`), and
  writes no competency, IDP, performance or talent record.
- **Competency evidence handoff** ("use as evidence for competency assessment"): from a COMPLETED plan, HR records
  one `competency_evidence` pointer per program competency (or the chosen ones) with the program's target as
  `objectiveLevelSnapshot` ("this OJT was designed towards level 4") and the plan as source. `observedLevel` stays
  **null**: nobody in this flow observed a level on the competency scale, and an objective must never read as an
  achievement. Idempotent. The assessor reads the pointers; the level changes only when a Task 24 assessment is
  finalized. The test in `tests/learning.test.ts` checks the level by raw SQL before and after and asserts the
  evidence row carries objective 4 and observed null. A future explicit "observed level" would have to be a human
  action validated on the scale, distinguishable from the objective, and still not applied to the current level.

## 4. Learning paths

- A path is an ordered list of steps: COURSE, OJT_PROGRAM, IDP_ACTIVITY (free title) or CERTIFICATION, each required
  or optional, with an optional prerequisite that must be an earlier step. References are validated at save time.
- An assignment copies the steps (with prerequisite sequence) and the employee snapshot. One ACTIVE assignment per
  path and employee (409 on a duplicate, also under concurrency). Editing the path later changes nothing here.
- **Progress is projected, not entered**: a COURSE step is fulfilled by a COMPLETED enrolment for that course, an
  OJT_PROGRAM step by a COMPLETED plan for that program, a CERTIFICATION step by a non-revoked, non-expired
  certification for that definition. Each read refreshes the projection and caches `fulfilledAt` and the source id.
  An IDP_ACTIVITY step is confirmed by a learning-path manager against a COMPLETED IDP item belonging to the
  employee (read only; the IDP is not written).
- Step state: LOCKED (prerequisite open), AVAILABLE, FULFILLED. When every required step is fulfilled the assignment
  is COMPLETED. **Path completion is a record**: no job, grade, position or promotion changes.

## 5. Certifications

- **Definition**: code, name, INTERNAL / EXTERNAL, issuer name, optional organization, `validityDays` (blank = no
  expiry), `expiryWindowDays` (default 30) for the EXPIRING_SOON status.
- **Issue** records one row per person, definition and issue date (duplicate → `409 CERTIFICATION_ALREADY_ISSUED`,
  also under concurrency). Expiry defaults from validity. A certificate document is a Document Center link
  (`EMPLOYEE_CERTIFICATION`) by a certification manager.
- **Status is derived on read** from the dates: ACTIVE, EXPIRING_SOON (within the window, inclusive of the last
  day), EXPIRED, REVOKED. Nothing runs in the background; there is no expiry scheduler and no reminder email.
- **Renewal** is a new row linked to the previous one (`renewedFromId`); the old row stays as history and cannot be
  renewed twice. **Revoke** is manual with a reason (recorded on the row, length only in the audit).

## 6. Who sees what

| Reader | OJT | Learning paths | Certifications | Reports |
|---|---|---|---|---|
| Employee | own plans: activities, criteria results, own reflection, assessment outcomes; **no trainer comment, no observation comment, no assessment comment** | own assignments | own | — |
| Trainer (manager) | plans assigned to them in full, plus their team's plans by data scope | team by scope | team by scope | — |
| Manager (not trainer) | team plans by scope; cannot observe or assess | team | team | — |
| HR | view (data scope), dashboard | view | view | dashboard, report |
| HR admin | manage everything | manage | manage | all |
| Executive | nothing per person | nothing | nothing | dashboard, report, Report Center datasets — aggregates only |

The Employee 360 development section lists OJT plans, path assignments and certifications with statuses and dates
only. The privacy export carries the subject's own plans, activity statuses, observation results, own reflections,
assessment outcomes, path assignments, certifications (including certificate numbers, which are theirs) and
evidence pointers; trainer comments and observation comments are listed under *not included* with the reason.

## 7. Reports and datasets

`GET /learning/dashboard` (counts with stated definitions) and `GET /learning/reports?from&to&organizationId`
(OJT by department / program with average completion days, paths by path / department, certifications by definition /
department). Report Center datasets `ojt_summary`, `learning_path_summary`, `certification_summary` are
aggregate-only: departments, programs, paths, definitions, months, statuses and counts — never a name, a comment,
an evidence title or a certificate number.

## 8. Notifications and audit

Notifications: `OJT_PLAN_ASSIGNED`, `OJT_ACTIVITY_READY`, `OJT_ASSESSMENT_REQUIRED` (reserved for HR use; no
scheduler sends it), `OJT_COMPLETED`, `LEARNING_PATH_ASSIGNED`, `CERTIFICATION_EXPIRING` (template only — nothing
schedules it in this release). Bodies carry names, program / path / certification names and dates only.

Audit (module `learning`): CREATE/UPDATE_OJT_PROGRAM, CREATE/UPDATE/ACTIVATE/COMPLETE/CANCEL_OJT_PLAN,
UPDATE_OJT_ACTIVITY, SUBMIT_OJT_OBSERVATION, SUBMIT_OJT_ASSESSMENT, CREATE_COMPETENCY_EVIDENCE_FROM_OJT,
CREATE/UPDATE_LEARNING_PATH, ASSIGN_LEARNING_PATH, UPDATE_LEARNING_PATH_ASSIGNMENT, CANCEL_LEARNING_PATH,
CREATE/UPDATE_CERTIFICATION_DEFINITION, ISSUE/RENEW/REVOKE_EMPLOYEE_CERTIFICATION. Payloads carry ids, statuses,
results and text lengths — never a comment, a reflection, an evidence title or a certificate number.

## 9. Tests

`apps/api/tests/learning.test.ts` (19 tests): helpers; program authority and scale validation; plan snapshot and
§64 program-change isolation; activation and notifications; trainee / trainer / HR text visibility and scope
404s; completion blockers with NEEDS_PRACTICE, observation upsert and evidence requirement; Document Center link
authority and no widening; concurrent activity completion and skip rules; assessment, concurrent plan completion,
need fulfilment and the raw-SQL level check; evidence handoff idempotency; path building, prerequisites, projected
progress, duplicate assignment under concurrency, §65 path-change isolation and IDP confirmation; certification
issue / duplicate / renew / revoke / expiring-soon and scope; My learning; executive aggregates and datasets;
Employee 360 and privacy export; audit coverage; cross-domain isolation.

## 10. Known limitations

No LMS or SCORM, no exam engine, no external certification registry or accreditation body integration, no
automatic competency level change, no AI observation or assessment, no certificate PDF generation, no expiry
scheduler or reminder delivery, no trainer workload balancing, no path recommendation, no promotion or job change
on path completion, no offline or mobile-app observation capture, and no bulk certification import.
