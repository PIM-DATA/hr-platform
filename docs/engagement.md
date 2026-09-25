# Employee engagement, eNPS and surveys

Collect, measure, aggregate and report employee feedback. A survey result is never a performance score, a talent
rating, disciplinary evidence or an input to pay. Anonymity here is a storage and reporting discipline that the
application enforces and states plainly — not a cryptographic guarantee.

---

## 1. Survey lifecycle

`DRAFT` (edit survey, questions, audience) → `OPEN` (questions, audience, response mode and threshold frozen;
employees answer) → `CLOSED` (no new answers; results frozen as history; anonymous comments readable to
engagement managers if the threshold is met) → `ARCHIVED` (history). HR opens and closes by hand; `periodStart`
and `periodEnd` are informational. A draft can be deleted; anything that was open is kept; responses are never
deleted by the application. **Duplicate** copies the questionnaire only — not the audience, answers or results.

## 2. Survey modes

| | ANONYMOUS | IDENTIFIED |
|---|---|---|
| Response row | `employeeId`, `assignmentId`, `submittedAt`, `positionIdSnapshot` all null; `submittedDate` (day) and organization / department / job snapshots only | employee, assignment and timestamp stored |
| Opening guard | audience must be at least the survey's minimum group size (`ENGAGEMENT_AUDIENCE_BELOW_ANONYMITY_THRESHOLD`) | none |
| Reporting | every subgroup below the minimum is suppressed for everyone | aggregates for readers; respondent detail for `engagement.manage` |
| Comments | `engagement.manage`, survey closed, whole survey at or above the minimum; text only | `engagement.manage`, with the respondent |
| Employee notice | "คำตอบของแบบสำรวจนี้จะไม่ถูกจัดเก็บพร้อม employee/user identifier และผลของกลุ่มขนาดเล็กจะถูกซ่อนตามเกณฑ์ของแบบสำรวจ" | "แบบสำรวจนี้ระบุตัวผู้ตอบได้" |

The mode, the minimum group size (3–20, default 5, stored per survey and never hardcoded in a calculation) and
the survey type are chosen in draft and immutable from OPEN on.

## 3. Anonymity architecture and its limits

Participation and answers are separate tables. For an anonymous survey nothing joins them:

- `engagement_survey_assignments` — who was invited (employee id, organization / department / job / position
  snapshots, the cohort tokens below) and `completedAt`.
- `engagement_survey_cohorts` — **survey-local anonymous dimensions**, created when the survey opens: one row per
  organization, department and job present in the frozen audience, with an opaque random id (`randomUUID`, not
  a time-ordered key), the dimension type, the source id and the label as it was at opening. A cohort is a group
  token shared by everyone in that group; it is never a person.
- `engagement_responses` — the answer context. The row has **no** employee, user, assignment, organization,
  department, job or position column: only the survey, the response mode, the submission date and up to three
  cohort tokens (`orgCohortId`, `deptCohortId`, `jobCohortId`). `engagement_response_answers` holds values only.
- `engagement_identified_respondents` — written **only** for IDENTIFIED surveys: response → assignment →
  employee, with the exact submission time. An anonymous submission never writes this table, so for an anonymous
  survey there is no row and no path from a response to a person.

Reporting resolves group names through the survey's own cohort rows and never joins answers to assignments.
Position is not a cohort (position groups are tiny): a position filter on an anonymous survey is reported as
suppressed, never estimated.

Limits, stated as they are: a cohort row records which master record it stood for, so a database operator can
map tokens to departments at survey level — which is what the breakdown reports show anyway, under the threshold;
the audit log records that an actor submitted to a survey (mode and answer count, no response id), the same fact
the assignment row holds; and a very small organization with distinctive answers can still be guessable by
someone who knows it. The UI and this document claim only that "anonymous responses are not stored with employee
or user identifiers", never mathematical or cryptographic anonymity.

## 4. Question bank and question types

`engagement_questions`: code, theme, text, type, default required, validated `config`, active flag. Deactivate
rather than delete once used. Types: LIKERT (configurable range, default 1–5, optional labels), SCALE (min/max,
at most 21 points), SINGLE_CHOICE / MULTI_CHOICE (options with code + label), YES_NO, TEXT (cap 2,000
characters, configurable lower), ENPS (always 0–10; at most one primary eNPS question per survey).

A survey question is a **snapshot**: text, theme, type, scale, options, required and order are copied when the
question is added. Renaming the bank question later changes nothing in a survey that already used it.

## 5. Submission

One employee, one assignment, one submission. The client keeps the draft and sends it once; nothing is saved
server-side before submit. Validation is server-side against the question snapshot (required, integer within the
scale, valid option codes, text length, unknown question, duplicate answer). The submission takes a share lock on
the survey and an exclusive lock on the assignment: two simultaneous submits yield exactly one response and one
completion; a close (exclusive survey lock) is ordered entirely before or entirely after any submission, so there
is never a half-accepted response.

## 6. eNPS

Promoters 9–10, passives 7–8, detractors 0–6. `eNPS = promoter% − detractor%`, computed in one shared helper
(`enpsScore`) from valid answers to the primary ENPS question only, rounded half-up to one decimal, range −100 to
+100. Unanswered assignments count in the response-rate denominator, never in the eNPS denominator. The frontend
never recomputes it.

## 7. Response rate

`completed assignments ÷ assigned employees`, one decimal. The denominator is the audience frozen at opening; it
does not shrink afterwards (an employee who leaves stays in it).

## 8. Results, themes and suppression

Per question: response count, average and distribution (scaled), counts and percentages (choice, yes/no), comment
count (text). Themes: the average of questions that share a theme **and an identical scale**; Likert 1–5 is never
averaged with eNPS 0–10, and there is no invented "engagement index". Breakdowns by department, job or
organization use assignment and response snapshots, so a transfer after the survey changes nothing.

Suppression: for an anonymous survey, any group whose response count is below the survey's minimum returns
`{ suppressed: true, minimumGroupSize, reason }` and nothing else — no averages, distributions, eNPS, comments or
counts; a filtered suppressed group also reports no participation counts. The rule is applied **after all filters
are combined** (department + job + position cannot narrow a group below the minimum and still show it) and it
applies to HR admins, executives and SYSTEM_ADMIN alike. The same helper serves the results screens, the CSV
export and the Report Center datasets.

## 9. Free text

Free text is capped, never summarized, scored or classified. Managers and executives never see it. For an
anonymous survey, engagement managers read it after close, only when the whole survey meets the threshold, as
text alone — no department, job, time or name — in an order derived from a hash rather than submission order.

## 10. Who sees what

| | Employee | Manager (TEAM) | HR (`view_results`) | Executive | `engagement.manage` |
|---|---|---|---|---|---|
| Answer surveys | ✓ | ✓ | ✓ | – | ✓ |
| Aggregates | – | own department(s) only | all | all | all |
| Breakdowns / filters | – | within own department(s) | ✓ | ✓ | ✓ |
| Comments | – | – | – | – | anonymous after close + threshold; identified always |
| Respondent detail | – | – | – | – | identified surveys only |
| Participation list | – | – | – | – | ✓ (no link to an answer) |

No service checks a role name. TEAM scope means the manager's own department plus departments they head (assignment
snapshot department), with no path to the company total.

## 11. Historical snapshots

Assignment and response rows carry the dimensions as they were at opening; question rows carry the wording as
asked; the mode and threshold are frozen. Transfers, renames and reorganizations after the fact do not rewrite a
closed survey.

## 12. Privacy export

Identified-survey answers are the subject's own data and are exported with the question text as asked.
Anonymous answers hold cohort tokens only, cannot be attributed and are **not reconstructed**; the export carries
only the participation record (survey, invited, completed) and says so under `notIncluded`.

## 13. Notifications, audit, logs

- `ENGAGEMENT_SURVEY_OPENED` to each assigned account: survey name and closing date, nothing else.
- Audit: create/update/assign/open/close/archive/duplicate survey, create/update question, submit response
  (survey-level: mode + answer count; identified submissions also carry the response id), view comments, view
  respondent detail. Never an answer value or a comment.
- Logs: request id, survey id, status, duration. The submission body is not logged (verified by test with a
  seeded comment).

## 14. No employment-decision linkage

Nothing in performance, talent, succession, employee relations, payroll or the Employee 360 reads engagement
tables, and nothing in engagement writes to them. A negative answer creates no case, changes no score and touches
no pay. Verified by tests that snapshot those tables around a submission and walk the 360 payload.

## 15. Report Center

`engagement_survey_summary`, `engagement_question_summary`, `engagement_department_summary` — aggregate-only,
threshold suppression applied per row, no answer or comment, manager rows limited to their department.

## 16. Limitations

No external anonymous survey link, no email/SMS distribution, no scheduled reminders, no recurring pulse
scheduler, no AI sentiment analysis or topic modelling, no benchmark provider, no action-plan workflow, no custom
statistics engine or significance testing, no branching/logic, no matrix questions, no attachments, no
multilingual questionnaire engine, no identified detailed export, and no cryptographic anonymity guarantee.
