# Recruitment and applicant tracking

Requisitions, openings, candidates, applications, interviews, offers and the hire that turns a candidate into an
employee. An operational record of a hiring process and the decisions people made in it.

> **This module ranks nobody and decides nothing.** There is no scoring of candidates, no automatic rejection, no
> automatic hire, no "recommended candidate" and no model of any kind. Interview feedback is one interviewer's view,
> shown next to the others so that a person can decide. Every stage move, every offer and every hire is somebody's
> explicit action, recorded with who did it and when.

---

## 1. What is in it

1. **A recruitment policy** per organization — which workflow approves a requisition, which approves an offer.
2. **A requisition** — a request for headcount, approved through the shared workflow.
3. **An opening** — a vacancy created from an approved requisition, taking applications inside this system.
4. **A candidate** — a person outside the company, with the minimum a recruiter needs.
5. **An application** — one candidate against one opening, moving through a fixed pipeline.
6. **Interviews** — scheduled conversations with named interviewers and their written feedback.
7. **An offer** — a proposal to a candidate, approved through the workflow and frozen once approved.
8. **The hire** — one transaction that creates the employee record from the application.

## 2. Permissions

| Permission | Who holds it by default | What it opens |
|---|---|---|
| `recruitment.view` | MANAGER, HR, HR_ADMIN | Purpose-scoped reads: a hiring manager's own requisitions, openings and their applications; an interviewer's own interviews |
| `recruitment.manage` | HR, HR_ADMIN | The recruiter's desk: every requisition, opening, candidate, application and interview; reports |
| `recruitment.interview` | MANAGER, HR_ADMIN | The Interviews tab and submitting feedback on interviews one is assigned to |
| `recruitment.manage_offers` | HR_ADMIN | Drafting offers, seeing salary figures, recording sent / accepted / declined |
| `recruitment.hire` | HR_ADMIN | Creating the employee record from an application |
| `privacy.export_data` | HR_ADMIN | Exporting a candidate's personal data (on the privacy router) |

Nothing else opens a candidate: not a data scope, not a team, not seniority. **EXECUTIVE has no recruitment
permission** and sees nothing. A manager who is neither the hiring manager on an opening nor an interviewer on one
of its interviews gets a 404 for its applications — the endpoint does not confirm they exist.

## 3. Requisitions

A requisition references the organization, department, job, position and hiring manager, and asks for a number of
openings. It gets a server-generated number (`REQ-YYYY-NNNNNN`, from a per-year counter taken under a row lock).

```
DRAFT ──submit──► PENDING_APPROVAL ──approve──► APPROVED ──close──► CLOSED
  │                     │
  └── cancel            └── reject ──► REJECTED (terminal: HR drafts a new one)
```

At submit the names of the masters are **snapshotted**: the approver decides on what they saw, and a department
rename next month does not rewrite the record of that decision. The workflow is the organization's
`requisitionWorkflowCode` from the recruitment policy, `module = recruitment`, `entityType =
RECRUITMENT_REQUISITION`. Submitting needs an account linked to an employee record (the workflow's requester).

## 4. Openings

An opening is created only from an **APPROVED** requisition, and the openings on a requisition together never ask
for more heads than were approved (`REQUISITION_HEADCOUNT_EXCEEDED`). It freezes the title, department,
organization and hiring manager as they were on the requisition.

```
DRAFT ──open──► OPEN ──hold──► ON_HOLD ──open──► OPEN
  │               │                │
  └── cancel      └── close        └── close
```

**OPEN publishes nothing.** It means the opening takes applications inside this system. There is no job board, no
career page, no email — and no button that pretends otherwise.

`filledCount` is counted from HIRED applications every time it is read; `isFull` is derived. Reaching the headcount
does not close the opening: closing is a decision, and the remaining active applications are left for a person to
reject or withdraw explicitly.

## 5. Candidates

The profile holds name, email, phone, current title and company, a location, a source and a summary. **Nothing
protected is modelled** — no national id, no date of birth, no marital status, no religion, no health, no politics —
so nothing protected can be stored; a request carrying such a field is refused with a validation error rather than
silently stripped.

Duplicate detection is exact: email lower-cased and trimmed, phone reduced to digits. A match is reported
(`CANDIDATE_POSSIBLE_DUPLICATE`, listing the matching candidates) and the recruiter decides; `allowDuplicate: true`
creates a separate record. Nothing is ever merged automatically.

**There is no delete endpoint.** A candidate can be archived. The applications, interviews and offers that
reference them are a record of decisions, and erasure is a policy decision made outside this module (see
[privacy-operations.md](privacy-operations.md)).

Candidate names and contact details never reach the audit log, a notification or a server log; audit entries carry
the candidate number.

## 6. Applications and the pipeline

One application per candidate per opening, against an OPEN opening, for an ACTIVE candidate.

```
APPLIED ──► SCREENING ──► INTERVIEW ──► OFFER ──hire──► HIRED
   any active stage ──reject──► REJECTED        ──withdraw──► WITHDRAWN
```

A **stage move** is an explicit action by somebody with `recruitment.manage`, between the four active stages.
Moving forward is routine; moving back requires a reason. HIRED, REJECTED and WITHDRAWN are never reached by a move:
each has its own action with its own checks. The **stage history** is append-only — from, to, who, when, why — and
is the answer to "who moved this candidate".

A rejection carries a coded reason (`NOT_A_FIT`, `EXPERIENCE`, `COMPENSATION`, `POSITION_FILLED`, `NO_RESPONSE`,
`OTHER`) and an optional note. The code is aggregated in reports; the note never is. A withdrawal is HR's record that
the candidate withdrew — the candidate has no login. Both cancel the application's scheduled interviews; a
withdrawal also withdraws its open offers.

## 7. Interviews and feedback

An interview belongs to an application and has a title, an optional round number, UTC start and end instants, an
IANA timezone (defaulting to the organization's), an optional location and meeting link, and one or more
interviewers who must be users. Interviewers are notified in the system (`INTERVIEW_ASSIGNED`: the opening title
and the date — never the candidate's name). No calendar invite or email is sent.

**Being an interviewer is purpose-specific access**: it opens that interview and its application, and nothing else.

Feedback is a recommendation (`PROCEED` / `HOLD` / `DO_NOT_PROCEED`), an optional 1–5 overall impression, and
strengths / concerns / comments. It is written **once** per interviewer per interview, only by an assigned
interviewer, and not on a cancelled interview. An interviewer reads their own; recruiters and the application's
hiring manager read all of it, side by side. Nothing anywhere adds it up: there is no average, no total, no rank.
Feedback text never reaches the audit log (lengths only), a notification or a report.

## 8. Offers

An offer is drafted by `recruitment.manage_offers` for an application at the **OFFER** stage, with a proposed start
date, employment type, position, base salary proposal (a decimal, held as `Decimal(18,2)`), currency and other
terms. One live offer per application.

```
DRAFT ──submit──► PENDING_APPROVAL ──approve──► APPROVED ──mark sent──► SENT ──record──► ACCEPTED | DECLINED
  ▲                     │
  └──── reject ─────────┘                 any of DRAFT / APPROVED / SENT / ACCEPTED ──withdraw──► WITHDRAWN
```

- **Confidential.** The salary and other terms are returned only to `recruitment.manage_offers` and to the approver
  on that offer's workflow; everyone else gets the offer with `baseSalaryProposal: null` and
  `compensationVisible: false`. The figure never reaches the audit log (only that a salary exists and its currency).
- **Frozen once approved.** An approved offer cannot be edited. To change the terms, withdraw it and draft a new one.
  A workflow rejection returns the draft to HR for revision.
- **Sent, accepted, declined are HR's records** of what happened outside the system. Nothing is emailed, and the
  candidate has no login. Recording an acceptance changes nothing else — the application stays at OFFER.
- **Not a payroll record.** The offer figure is a recruitment proposal. Payroll's compensation history is a
  separate decision with its own authorization; nothing here writes to it.

## 9. Hire

`POST /recruitment/applications/:id/hire` needs `recruitment.hire` and a body with what the employee record needs:
employee code, hire date, position, employment type, work email and optional manager. The candidate's name and phone
are copied; nothing else about the candidate is assumed.

One transaction, with the application, its opening and its candidate all locked:

1. the application is at OFFER and not already hired;
2. the candidate has not been hired on another application;
3. an offer on this application is ACCEPTED;
4. the opening is OPEN and its HIRED count is below its headcount (`OPENING_FULL` otherwise, counted under the lock);
5. the employee is created through `createEmployeeWithTx` — the same road every employee takes, with the same
   uniqueness checks (code, email) and the same `CREATE_EMPLOYEE` audit;
6. the application becomes HIRED with a history line, the candidate becomes HIRED, both link to the employee id
   (unique — one hire per candidate, one per application), scheduled interviews are cancelled, and the recruiter and
   hiring manager are told (`HIRING_COMPLETED`).

If any step fails, nothing was hired. Two simultaneous hires of one application produce exactly one employee.

**What does not happen**, on purpose: no user account (an account is an access decision made in Users), no payroll
compensation (see §8), no automatic closing of the opening, no change to any other application.

## 10. Dashboard and reports

The dashboard shows counts for the caller's scope: requisitions in flight, open openings, active applications,
upcoming interviews, offers in progress, hires, and the pipeline funnel.

The report (`recruitment.manage`) aggregates applications by `appliedAt` in a date range and optionally an
organization: funnel, by source / department / job, interviews, offers, hires, **average time to hire** and
rejection reasons by code. Time to hire is `appliedAt → hiredAt` in days, averaged over hires in the range, and is
null when there are none. Time to fill (from requisition approval) is not reported in this release. Nobody is named
and nobody is ranked.

## 11. Privacy

`POST /privacy/candidates/:id/export` (`privacy.export_data`) returns the candidate's profile and the record of each
application: stages and history, interview schedules, and the offers that were sent, accepted or declined (with their
terms — they were given to the candidate). It states what is **not** included and why: interviewer feedback (an
interviewer's working assessment), offer drafts that were never sent, rejection notes, and the names of the people
who acted. The export is audited with counts, never the payload.

There is no candidate deletion. Retention and erasure are policy decisions the organization makes; the register of
privacy requests exists for tracking them.

## 12. Audit

Every mutation is audited in `module = recruitment` with the actor: requisition create / update / submit / approve /
reject, opening create / update / open / close, candidate create / update, application create / move / reject /
withdraw, interview schedule / update, feedback submitted, offer create / update / submit / approve / reject / sent /
accepted / declined / withdraw, hire, policy update. Payloads carry numbers, codes, counts and lengths — never a
candidate's name or contact details, never feedback text, never a salary figure.

## 13. What this release does not do

No job board or careers page, no email or calendar integration, no CV / attachment upload, no CV parsing, no
candidate portal or login, no e-signature, no background checks, no AI or rule-based screening, scoring or ranking,
no automatic hire or rejection, no interviewer availability or scheduling assistant, no offer letter PDF, no
onboarding task workflow, no time-to-fill report, no agency or referral bonus management, no talent pool
campaigns, no multi-currency conversion, no protected-attribute fields of any kind.
