# Product surface gap audit (Task 37)

Inspection of the repository and the running application on 2026-09-25, after Task 36. This is **not** the
enterprise readiness review: it records what a user can see and use today, what is still a placeholder, what
exists only on one side (API or UI), and what to build next. Intentional, documented limitations (no SCORM, no
insurer API, no job board) are not counted as gaps.

Method: source inspection (menu, router, feature directories, API mounts, permissions, datasets, Employee 360,
executive analytics, copilot tools, docs, README, Prisma models) and a real-browser walk of every sidebar item and
every tab as HR_ADMIN, HR, MANAGER, EMPLOYEE, EXECUTIVE and SYSTEM_ADMIN (274 page loads), plus a 390 px drawer
smoke as EMPLOYEE and MANAGER. An API-versus-web-client cross-check of all 581 API routes found the candidates in
section 6, each then verified by hand.

---

## 1. Current feature map

| Group | Modules (module → API mount) | State |
|---|---|---|
| **Foundation** | Auth and sessions, users, roles, permission matrix, organizations / departments / jobs / positions, employee master with position and manager history, audit log, dashboard, notifications, account security, workflow engine and definitions, calendars and holidays | Complete |
| **HRM** | Attendance and shifts (`/attendance`), leave (`/leave`, `/calendars`), overtime (`/attendance/overtime`), payroll (`/payroll`), employee relations (`/employee-relations`), performance (`/performance`), recruitment (`/recruitment`), documents (`/documents`), report center (`/reports`), employee lifecycle (`/lifecycle`), benefits (`/benefits`) | Complete MVPs |
| **HRD** | Competency and skill gaps (`/competency`), training / TNA / IDP (`/training`), OJT / learning paths / certifications (`/learning`), career / talent / 9-box / succession (`/talent`) | Complete MVPs |
| **HROD / Talent** | Workforce planning and organization design (`/workforce`), engagement / eNPS (`/engagement`) | Complete MVPs; two stale placeholders in the menu (section 5) |
| **Employee self service** | My attendance, my leave, my payslips, my records, my performance, my documents, my lifecycle, my benefits, my competencies, my development, my career, my surveys, notifications, account security | Present in every module |
| **Manager self service** | Team attendance, approvals, team leave, team reviews, team assessments, team development, team career, team engagement, team onboarding / probation / offboarding, trainer queue, claim review | Present; confidentiality rules per module |
| **Shared platform** | Workflow engine, notifications, audit, document links, report registry, privacy export, sequences | Complete |
| **Analytics / reports** | Employee 360 (`/analytics/employee-360`), executive dashboard (`/analytics/executive`), 26 Report Center datasets, per-module report tabs | Complete; two 360 sections not rendered (section 7) |
| **AI / Copilot** | Grounded copilot with 16 tools (self, team, organization, reports, documents) | Complete; five newer domains not exposed (section 12) |
| **Operations / admin** | Users, roles, permissions, audit logs, workflow definitions, leave settings, onboarding import, privacy | Complete; Settings is a placeholder; no workflow-instance monitor (section 6) |

## 2. Current menu tree (from the running application, HR_ADMIN / SYSTEM_ADMIN view)

```
Dashboard                                  COMPLETE (stale "Coming soon" cards, see §5)
People
  Employees                                COMPLETE  (detail: Overview, Employment, Position history, Manager history + 360 tabs)
  Organization                             COMPLETE  Structure · Organizations · Departments · Jobs · Positions
HRM
  Attendance                               COMPLETE  My attendance · Team · Daily · Schedule · Corrections · Overtime · OT policies · Shifts · Reports
  Leave                                    COMPLETE  My leave · Approvals · Team leave · All requests · Reports
  Payroll                                  COMPLETE  My payslips · Periods · Compensation · Pay components · Recurring items · Policies
  Employee relations                       COMPLETE  My records · Approvals · Cases · Actions · Action types · Reports
  Performance                              COMPLETE  My performance · Team reviews · Cycles · KPI library · Reports
  Recruitment                              COMPLETE  Dashboard · Approvals · Requisitions · Openings · Candidates · Applications · Interviews · Offers · Reports
  Documents                                COMPLETE  My documents · Document center · Categories
  Reports                                  COMPLETE  Saved reports · Report builder
  Employee lifecycle                       COMPLETE  Dashboard · Onboarding · Probation · Offboarding · Templates · Reports
  Benefits                                 COMPLETE  My benefits · Dashboard · Plans · Periods · Enrolments · Entitlements · Claims · Payments · Reports
HRD
  Competency                               COMPLETE  My competencies · Team assessments · Competencies · Scales · Job profiles · Cycles · Skill gaps
  Training & development                   COMPLETE  My development · Training needs · Courses · Sessions · Development plans · OJT · Learning paths · Certifications · Reports · Learning reports
  Career & talent                          COMPLETE  My career · Career paths · Talent reviews · Talent pools · Succession · Reports
HROD
  Workforce planning                       COMPLETE  Dashboard · Planning cycles · Headcount plan · Organization design · Vacancies · Reports
  Engagement                               COMPLETE  My surveys · Dashboard · Surveys · Question bank · Results · Comments · Participation · Reports
  Talent                        [Soon]     COMING SOON — stale: implemented under HRD → Career & talent → Talent reviews
  Succession                    [Soon]     COMING SOON — stale: implemented under HRD → Career & talent → Succession
Analytics
  Executive dashboard                      COMPLETE
Assistant
  HR Copilot                               COMPLETE
Administration
  Users · Roles · Permissions · Audit Logs COMPLETE
  Workflows                                COMPLETE (definitions only; no instance monitor)
  Leave Settings                           COMPLETE  Leave types · Policies · Entitlements · Calendars & holidays
  Onboarding                               COMPLETE (Excel customer import — label collides with lifecycle Onboarding)
  Privacy                                  COMPLETE  Requests · Data export
  Settings                      [Soon]     COMING SOON — genuine placeholder (SYSTEM_ADMIN only)
Top bar / user menu
  Notifications · Account security         COMPLETE
```

## 3. Complete MVP modules

Every module in the tree above except the three placeholders is a complete MVP with tests, documentation and a
known-limitations list: Foundation (Tasks 1–7), Workflow and Leave (8–14), production and operations (15–19),
Attendance (20), Overtime (21), Payroll (22), Performance (23), Competency (24), Training / TNA / IDP (25),
Employee relations (26), Recruitment (27), Career / talent / succession (28), Employee 360 and executive analytics
(29), Documents and Report Center (30), Copilot (31), Workforce planning and org design (32), Engagement (33),
Lifecycle (34), OJT / learning paths / certifications (35), Benefits (36).

## 4. Partial modules

None is partial in the sense of "a visible feature that does not work". The closest cases are surface issues:

| Module | What is shallower | Category |
|---|---|---|
| Employee 360 | The API returns `lifecycle` (Task 34) and `benefits` (Task 36) sections; the employee detail page renders only Time & leave, Performance, Development, Career & talent and Relations. HR sees no lifecycle or benefits summary on the 360 page. | DISCONNECTED (UI missing) |
| Payroll administration | Pay components, recurring items, periods and policies can be created but not edited from the UI (`PATCH` endpoints exist; only compensation has an edit dialog). | Backend-without-UI (medium) |
| Recruitment → lifecycle | Hiring an application creates the employee record; there is no link or prompt from the hired application to start an onboarding plan or a probation case. HR navigates to Employee lifecycle and starts them by hand. | Handoff gap (manual, works) |
| Executive dashboard | Rolls up headcount, hires, attendance, leave, overtime, competency, training, talent and recruitment; engagement, lifecycle, learning, workforce planning and benefits have their own dashboards but are not rolled up. | INTEGRATION_ENHANCEMENT |

## 5. Coming Soon and placeholders (exact, as visible)

| # | Label | Route | Who sees it | What happens today |
|---|---|---|---|---|
| CS-1 | HROD → **Talent** with a "Soon" badge | `/hrod/talent` | every role (item has no permission gate) | Renders the generic "Coming soon" page. Stale: Talent reviews, 9-box and pools shipped in Task 28 at `/hrd/career/talent`. |
| CS-2 | HROD → **Succession** with a "Soon" badge | `/hrod/succession` | every role | Renders "Coming soon". Stale: succession plans shipped in Task 28 at `/hrd/career/succession`. |
| CS-3 | Administration → **Settings** with a "Soon" badge | `/admin/settings` | SYSTEM_ADMIN only (`settings.manage`; HR_ADMIN does not hold it) | Renders "Coming soon". Genuine placeholder: no settings page exists; the permission exists. |
| CS-4 | Dashboard section **"Coming soon"** with four dashed cards: Attendance, Leave, Performance, Training, each badged "Soon" | `/dashboard` | every role | Static cards, not clickable. Stale: all four modules shipped (Tasks 20, 9–14, 23, 25). |
| CS-5 | Dashboard **quick actions** limited to foundation-era links (New employee, Employees, Organization, Users, Audit logs) | `/dashboard` | every role | Works, but the landing page points at none of the 20 later modules. |
| CS-6 | README "Foundation phase" table row: *Attendance · Leave · Performance · Competency · Training · IDP · Workforce · Talent · Succession · Analytics · Settings — Coming soon* and *Phase 2 (in progress)* | `README.md` lines 16–36 | readers of the repo | Documentation stale since Task 20. |

No route renders a mock, static or non-persisted page. No button without an action was found. No admin screen is
empty by construction. Source search for "coming soon", "not implemented", "TODO", "stub", "placeholder" and
"mock" matched only the items above (plus code comments and form placeholders).

## 6. Backend-only gaps (API or domain capability with no usable UI)

Verified by hand after the route cross-check (computed paths such as `/${kind}/${id}/${action}` were resolved).

| # | Capability | Endpoints | Severity | Why it matters |
|---|---|---|---|---|
| BO-1 | Workflow instance monitor: list and inspect every pending / completed instance across modules | `GET /workflow/instances`, `GET /workflow/instances/:id` | Medium | An administrator cannot see stuck approvals except through each module's own approvals tab. |
| BO-2 | Edit payroll master data after creation | `PATCH /payroll/components/:id`, `/payroll/pay-items/:id`, `/payroll/periods/:id`, `/payroll/policies/:id` | Medium | A typo in a pay component, a recurring item's end date, a period's payment date or a policy has to be fixed by recreating. |
| BO-3 | Edit an IDP header | `PATCH /training/idps/:id` | Low | Items can be added and the plan activated / completed; the title and period cannot be edited. |
| BO-4 | Competency profile of another employee, organization skill-gap list, ER and talent summaries per employee | `GET /competency/profile/:employeeId`, `/competency/skill-gaps`, `/employee-relations/summary/:employeeId`, `/talent/summary/:employeeId` | Low | Served to Employee 360 and the copilot; the UI reaches the same facts through the 360 and the gap report. |
| BO-5 | Leave policy resolver | `GET /leave/policies/resolve` | Low | Helper used by services; no user need. |
| BO-6 | Leave BalanceService reserve / release / use / refund | service only, no HTTP | Low | Internal by design (README, Task 10). |

Everything else flagged by the cross-check (exports, downloads, CSV, activate / deactivate, recruitment and talent
actions, onboarding import) is reached through computed paths or anchors and is in use.

## 7. UI-only gaps (UI that is static, mocked or not connected)

None found. Every page reads from and writes to its API module. The one disconnected rendering is the reverse
case: **Employee 360 returns `lifecycle` and `benefits` sections that the page never shows** (section 4).

## 8. Disconnected handoffs (employee lifecycle continuity)

Recruitment → Hire → Onboarding → Probation → Active → Offboarding → Separation.

| Step | State |
|---|---|
| Requisition → opening → candidate → application → interview → offer → **hire** | Complete; hire creates the employee record through the employees domain (Task 27). |
| Hire → **onboarding plan** | Manual. No link, banner or prompt from the hired application or the new employee to "Start onboarding"; no automatic plan. |
| Hire → **probation case** | Manual. Same. |
| Hire → **user account** | Manual by an administrator (documented; tasks stay unassigned until then). |
| Onboarding → active employment | Complete (plan completion changes nothing in the master, by design). |
| Probation outcome | Complete; NOT PASS changes nothing (by design). |
| Offboarding → **separation** | Complete: one explicit action terminates, disables the account, revokes sessions (Task 34). |
| Separation → benefits, payroll, documents | No side effects, by design; benefits claims already approved continue. |

Practical gap: the two manual starts after hire (onboarding plan, probation case) are the only places a user has
to know to go elsewhere. Everything else is linked.

## 9. Navigation cleanup register

| # | Issue | Evidence | Category |
|---|---|---|---|
| NAV-1 | Stale HROD Talent / Succession placeholders duplicate live HRD pages | CS-1, CS-2 | UX_CLEANUP |
| NAV-2 | Dashboard "Coming soon" cards for shipped modules; quick actions ignore 20 modules | CS-4, CS-5 | UX_CLEANUP |
| NAV-3 | Training & development has two report tabs: "Reports" (Task 25) and "Learning reports" (Task 35) | walk: 10 tabs | UX_CLEANUP |
| NAV-4 | Two menu items labelled "Onboarding": Administration → Onboarding (Excel customer import, Task 17) and Employee lifecycle → Onboarding (Task 34) | menu | UX_CLEANUP |
| NAV-5 | Module index pages assume an employee record: for HR, EXECUTIVE and SYSTEM_ADMIN accounts without one, Attendance, Payroll, Documents, Competency, Career & talent and Engagement open on a "Could not load" or 409 (My attendance / payslips / documents / competencies / career / surveys). Training, Benefits and Lifecycle already resolve to the right first page. | walk: HR, EXECUTIVE, SYSTEM_ADMIN rows | UX_CLEANUP |
| NAV-6 | EXECUTIVE menu shows Attendance (`attendance.view`) but the index needs `attendance.clock`, so the landing page is Forbidden while the Team / Daily / Reports tabs work | walk: EXECUTIVE | UX_CLEANUP (permission ↔ index) |
| NAV-7 | EXECUTIVE menu shows Career & talent (`talent.view_reports`) but the index needs `career.view` and the tab list is empty, so talent reports are unreachable from the menu for the executive | walk: EXECUTIVE, `tabs=[]` | UX_CLEANUP (permission ↔ index) |
| NAV-8 | HR menu shows Leave Settings but the index (Leave types) needs `leave.manage_types`, which HR lacks; Entitlements and Calendars tabs work | walk: HR | UX_CLEANUP (permission ↔ index) |
| NAV-9 | HROD group holds Workforce planning and Engagement while Talent and Succession live under HRD → Career & talent; group naming is inconsistent with the label "HROD / Talent" in the product vision | menu | UX_CLEANUP (product decision) |
| NAV-10 | React "two children with the same key" console warning appeared once during the walk (page not identified by the harness) | walk console | UX_CLEANUP (low) |

No dead link (404) was found from any menu item or tab for any role. The 390 px drawer lists 18 items for an
employee and 21 for a manager; the first 12 pages of each had no horizontal overflow.

## 10. Surface by role (from the walk)

| Role | Sidebar items | Notes |
|---|---|---|
| EMPLOYEE | 18 (+2 stale Soon) | Every module opens on a "My …" page; no admin tabs anywhere. |
| MANAGER | 21 (+2 stale) | Team tabs in attendance, leave, ER approvals, performance, competency, training, career, lifecycle, engagement; recruitment (interviewer); reports builder; benefits shows own account and approver queue only. |
| HR | 22 (+2 stale) | Administration of every HRM / HRD / HROD module except Users, Roles, Workflows, Privacy, Executive dashboard; NAV-5 and NAV-8 apply. |
| HR_ADMIN | 30 (+2 stale) | Everything except Settings (placeholder) and System-admin-only items. |
| EXECUTIVE | 18 (+2 stale) | Aggregate dashboards and reports in every domain; NAV-5, NAV-6, NAV-7 apply. |
| SYSTEM_ADMIN | 31 (+3 Soon) | All of the above plus Settings placeholder; NAV-5 applies (no employee record). |

Permission visibility is otherwise correct: no module is hidden from a role that should have it, and the three
mismatches above are index-page choices, not missing grants.

## 11. Major domains still absent

Checked against the README vision ("HRM / HRD / HROD / Analytics / AI Copilot on the same core"); no competitor
comparison notes exist in the repository, so no competitor checklist was used.

| Domain | Present today | Flag? | Reason |
|---|---|---|---|
| Expense / travel claims | Benefits claims cover welfare reimbursement with entitlement balances only | **Yes — surface gap** | Employees have a claim form, a ledger and an approval flow for welfare but nowhere to claim a business expense; the Benefits claim engine (reservation, documents, workflow, payment, payroll handoff) is directly reusable. |
| Employee requests / service desk (HR letters, certificates, data changes) | Corrections, leave, OT, claims exist per module; no generic request | **Yes — surface gap** | The workflow engine, documents and notifications are all in place; "ask HR for a letter" is the most common ESS request with no home. |
| Compensation planning (salary review / merit cycles) | Payroll holds compensation history only | Yes — vision-adjacent | Performance, competency and talent outputs exist; there is no cycle that turns them into a pay decision. |
| Timesheet / project time | Attendance records days and shifts; no time-to-project | Yes — adjacent | Only if the customer base needs billable time; otherwise future. |
| Roster / rotation planning | Shifts and schedule assignment exist | No | Documented attendance limitation, not a missing domain. |
| Asset management | Absent | No | Nothing in the vision points there. |
| Rewards / recognition | Absent | No | Nothing in the vision points there. |
| Succession, survey, benefits | Present | — | — |

## 12. Integration enhancements

| # | Enhancement | Category | Priority |
|---|---|---|---|
| INT-1 | Copilot has no tools or suggested prompts for workforce planning, engagement results, lifecycle status, OJT / certifications or benefits balances (it can already query their Report Center datasets) | INTEGRATION_ENHANCEMENT | P3 |
| INT-2 | Executive dashboard does not roll up engagement, lifecycle, learning, workforce plan or benefits aggregates (each has its own dashboard) | INTEGRATION_ENHANCEMENT | P3 |
| INT-3 | Employee 360 lifecycle and benefits sections not rendered (section 4) | DISCONNECTED | P1 (small) |
| INT-4 | Hire → onboarding / probation start link (section 8) | DISCONNECTED | P2 (small) |

## 13. Enterprise-only gaps (kept separate; not feature work)

MFA and SSO; object storage for documents (local filesystem adapter today); malware scanning; monitoring and
alerting; off-host backup; email / SMS delivery (notifications are in-app only); a scheduler (expiry reminders,
recurring surveys, pulse); distributed rate limiting; PDF generation (payslips, letters, offers); retention and
erasure automation; multi-instance session and limiter state. These are listed in README "Known limitations" and
`docs/production-readiness.md` and are deliberately excluded from the feature register.

## 14. Prioritized gap register

| ID | Feature / menu | Current state | Evidence | User impact | Category | Priority |
|---|---|---|---|---|---|---|
| G-01 | HROD → Talent, Succession | Stale "Soon" placeholders | CS-1, CS-2 | Users told a shipped feature is not available; two menu items lead nowhere | VISIBLE_COMING_SOON | P1 |
| G-02 | Dashboard "Coming soon" cards and quick actions | Stale cards; foundation-era links | CS-4, CS-5 | First screen misrepresents the product | VISIBLE_COMING_SOON | P1 |
| G-03 | Employee 360 lifecycle and benefits | API sections not rendered | §4, §7 | HR cannot see probation / offboarding / benefits summary on the 360 page | DISCONNECTED | P1 |
| G-04 | Module index pages for non-employee accounts | "Could not load" / 409 on six modules for HR, executive, system admin | NAV-5 | Confusing first page for administrators | UX_CLEANUP | P1 |
| G-05 | Executive and HR menu ↔ index permission mismatches | Forbidden landing pages | NAV-6, NAV-7, NAV-8 | Executive cannot reach talent reports from the menu | UX_CLEANUP | P1 |
| G-06 | README phase tables | Stale "Coming soon" / "in progress" | CS-6 | Misleads readers of the repo | UX_CLEANUP | P1 |
| G-07 | Administration → Settings | Genuine placeholder | CS-3 | Nothing to configure centrally (organization defaults, notification preferences, feature toggles are env or per-module) | VISIBLE_COMING_SOON | P2 |
| G-08 | Workflow instance monitor | API only | BO-1 | Stuck approvals invisible to administrators | PARTIAL | P2 |
| G-09 | Payroll master-data edits | API only | BO-2 | Recreate instead of edit | PARTIAL | P2 |
| G-10 | Hire → onboarding / probation | Manual navigation | §8 | Two extra steps HR must know about | DISCONNECTED | P2 |
| G-11 | Expense / travel claims | Absent | §11 | No business-expense claim for employees | MISSING_MAJOR_DOMAIN | P2 |
| G-12 | Employee requests / HR letters | Absent | §11 | Most common ESS request has no home | MISSING_MAJOR_DOMAIN | P2 |
| G-13 | Compensation planning cycles | Absent | §11 | Talent and performance outputs stop short of pay decisions | MISSING_MAJOR_DOMAIN | P2 |
| G-14 | Training module: two report tabs; Onboarding label collision; HROD grouping | Naming and grouping | NAV-3, NAV-4, NAV-9 | Minor confusion | UX_CLEANUP | P3 |
| G-15 | Copilot and executive dashboard coverage of the five newest domains | Not integrated | INT-1, INT-2 | Fewer answers and one less roll-up | INTEGRATION_ENHANCEMENT | P3 |
| G-16 | IDP header edit; duplicate-key warning | Minor | BO-3, NAV-10 | Low | UX_CLEANUP | P3 |
| G-17 | Timesheet / project time | Absent | §11 | Only for customers needing billable time | MISSING_MAJOR_DOMAIN | P4 |
| G-18 | Enterprise items in §13 | Documented | §13 | — | ENTERPRISE_ONLY | P4 |

No percentage is reported: the register holds 6 P1 items (all small cleanup or a small render gap), 7 P2, 3 P3
and 2 P4.

## 15. Recommended next tasks (3–5 candidates)

1. **Product surface cleanup** — SMALL. Closes G-01, G-02, G-04, G-05, G-06, G-14: remove the two stale
   placeholders, replace the dashboard "Coming soon" cards with quick links to the shipped modules, give every
   module an index resolver like Training and Benefits already have, align the three menu ↔ index permission
   choices, refresh the README phase tables, merge the two training report tabs, rename the import item. No new
   domain logic; regression is the existing suite plus the browser walk. Dependencies: none.
2. **Employee 360 lifecycle and benefits panels + hire handoff** — SMALL. Closes G-03 and G-10: render the two
   sections the API already returns (per their source-module rules, which the API already enforces) and add a
   "Start onboarding / probation" link from a hired application and from the new employee's record. Dependencies:
   Tasks 27, 34, 36 (all shipped).
3. **Expense and travel claims** — MEDIUM. Closes G-11 on the Benefits claim engine: claim types without an
   entitlement balance (or with a budget), the same reservation-free submit, documents, workflow, payment record
   and payroll handoff; per-category limits and policy per organization. Dependencies: Benefits (36), Payroll (22),
   Documents (30), Workflow (8).
4. **Employee service requests and HR letters** — MEDIUM. Closes G-12: request types configured by HR (employment
   certificate, salary letter, data change), a generic request with workflow, a document produced from a template
   (the ER letter-template mechanism exists), status tracking in ESS. Dependencies: Workflow (8), Documents (30),
   ER templates (26), Notifications (13).
5. **Administration: Settings page and workflow instance monitor** — MEDIUM. Closes G-07, G-08, G-09: organization
   defaults and feature toggles that today live in env or scattered per module, a read-only monitor of workflow
   instances with cancel for administrators, and edit dialogs for payroll master data. Dependencies: none new.

Not recommended now: compensation planning (G-13) is a large domain that should follow a decision on whether pay
decisions belong in this product; timesheets (G-17) only on customer demand; all §13 items belong to the final
enterprise readiness phase.
