# Business dates, instants and timezones

Task 53 (T44-P1-23). This page is the rule every module follows; `apps/api/src/services/business-time/business-time.ts`
and the shared helpers in `packages/shared/src/business-date.ts` / `attendance.ts` implement it.

## 1. Four kinds of time

| Kind | Form | Examples | Rule |
|---|---|---|---|
| **Instant** | UTC `Date` / ISO string with `Z` | `submittedAt`, `fulfilledAt`, `finalizedAt`, `createdAt`, clock-in | Stored and compared as instants. Never sliced to a date with `toISOString().slice(0, 10)`. |
| **Business date** | `YYYY-MM-DD` string | `dueDate`, `expiryDate`, `validUntil`, `submittedDate`, leave dates, payroll period dates | A calendar date in the applicable organization's zone. Compared as strings; never passed through `new Date(...)`. |
| **Calendar date stored as UTC midnight** | `DateTime` at `00:00Z` | `Employee.hireDate`, `terminationDate`, position/manager history dates | Legacy columns that carry a calendar date. Their UTC date *is* the business date; filters use UTC day boundaries (`calendarDate: true` in the Report Center). |
| **Wall-clock time** | `HH:mm` | shift start/end | Resolved per date and zone with `zonedTimeToUtc` (attendance, unchanged). |

## 2. The authoritative zone

`Organization.timezone` — a validated IANA name (`Asia/Bangkok`, `America/New_York`, `UTC`). Offsets (`+07:00`),
`GMT+7` and free text are refused (`400`). A value that is somehow invalid in the database is a controlled
`409 ORGANIZATION_TIMEZONE_INVALID` — the server never falls back to its own process zone. A new organization defaults to
`Asia/Bangkok` (database default, documented in customer onboarding) and can be changed in organization settings.

Which organization applies:

| Situation | Zone |
|---|---|
| A record about an employee (request due date, certificate expiry, warning validity, probation end, claim service date, expense date, document owned by an employee) | the employee's **current** organization |
| A report filtered to an organization | that organization |
| An installation-wide default with no organization in scope ("this year" for an unfiltered report, Report Center date filters, the copilot's default range, sequence numbers without a subject) | the **reference organization**: the first active organization by code; `UTC` only in an installation with no organization |
| "Overdue now" across organizations | each row's own organization (`employeeTodays`, `perOrganizationToday`) — organizations on different dates are compared separately, never with one global date |
| A compensation cycle | the cycle's organization |
| A training session | the session's own `timezone` (unchanged) |

## 3. Helpers (API)

`todayForEmployee`, `todayForOrganization`, `referenceToday`, `employeeTodays` (one query for many employees),
`organizationTodays`, `perOrganizationToday` (a WHERE fragment that is a single comparison when every organization is on
the same date, else one branch per date), `businessRange` (`[local 00:00 of from, local 00:00 of the day after to)`),
`businessDateIn` (an instant's business date), `businessYear` (sequence-number year). Shared:
`businessToday(tz, now)`, `businessDayStart`, `businessDateRangeInstants`, `businessDateOf`, `zonedTimeToUtc`.

## 4. Date ranges

A business-date range selecting instants is `gte` local 00:00 of the first date and `lt` local 00:00 of the day after the
last date. A local day is 23 or 25 hours on a DST change (tested for America/New_York 8 Mar / 1 Nov 2026 and Europe/London
29 Mar / 25 Oct 2026); nothing adds 86 400 000 ms to find a day boundary. Where a module stores the business date of the
event (`submittedDate` on service requests and benefit claims) reports filter on that date directly.

## 5. Historical records

Stored business dates are never rewritten. A request's `dueDate`, a warning's `validUntil`, a certificate's `expiryDate`
keep their calendar value forever. What follows the organization's **current** timezone is "today" — the day they are
compared with. If an organization changes its timezone, "is it overdue now?" is re-evaluated in the new zone; no stored
date moves (tested). Records keep no zone snapshot: a record of an employee who moved to an organization in another zone
is judged on the new organization's today. Closed payroll, approved leave and attendance keep their stored business dates
and are not recalculated by this rule.

## 6. Frontend

Date pickers default to `businessDateToday()` — today in the signed-in user's **business calendar zone** (their
organization's, from `/auth/me` → `businessCalendar.timezone`; Task 54), never `toISOString()` (UTC) and never just the
browser's zone — and submit `YYYY-MM-DD` unchanged. Task 54 demonstrated why: with the browser on Pacific/Kiritimati or
Pacific/Pago_Pago and the organization on Asia/Bangkok, the change-position effective date defaulted to tomorrow /
yesterday; it now defaults to the organization's date. Before sign-in the browser's date is used. Business dates are displayed with `formatCalendarDate`/`formatDate`, which show `2026-10-01` as 1 October in
every browser zone; instants are displayed in the viewer's zone. The server re-checks every business date against the
organization's zone, so a browser in a different zone than its organization can only propose a date, not decide one.

## 7. Known limitations

- A record has no timezone snapshot; "today" for it is its employee's *current* organization's today.
- Report Center date filters and unfiltered multi-organization report defaults use the reference organization's zone;
  per-row facts (overdue, validity, expiry, months) use each row's own organization.
- Organization-level sequence numbers (recruitment, documents without an owner) use the reference organization's year.
- Picker defaults use the signed-in user's own organization's zone; an HR user entering data for an employee of
  another organization gets their own organization's date as the default (the server validates against the subject's
  organization). Instants (timestamps) are displayed in the viewer's browser zone by design.
- `Asia/Bangkok` remains the database default for a new organization.
