# Account security and RBAC separation of duties (Task 45)

Three kinds of authority are kept apart. Holding one never implies another.

| Authority | Permissions | Grants |
|---|---|---|
| **A. Account administration** | `users.view/create/update/activate`, `account.manage_recovery`, and for privileged targets `users.manage_privileged` | creating accounts, editing login e-mail / employee link, activating, deactivating, issuing reset links, signing people out |
| **B. RBAC administration** | `roles.view`, `roles.manage` | changing role ↔ permission mappings; assigning roles to **other** users under the grant rules |
| **C. Business authority** | every other permission (payroll, compensation, ER, benefits, …) | the domain itself |

No business check accepts A or B; no service authorizes by role name.

## 1. Privileged accounts

An account is **privileged** when its *effective* permissions (union of its roles, read from the database) include
`roles.manage` or `users.manage_privileged` (`PRIVILEGED_ACCOUNT_PERMISSIONS`, `isPrivilegedAccount` in
`packages/shared/src/permissions.ts`). Role names play no part: a custom role holding `roles.manage` is privileged too.

Only a holder of **`users.manage_privileged`** may perform an account-security action on a privileged account other
than their own. Everyone else gets `403 PRIVILEGED_ACCOUNT_PROTECTED`, and nothing is written — no reset token, no audit
row claiming success, no session change, no field change. The check lives in one helper,
`assertCanAdministerAccount` (`apps/api/src/modules/users/account-guard.ts`), used by every path below.

| Endpoint / path | Can | Guarded |
|---|---|---|
| `POST /admin/users/:id/password-reset` | take over (a reset link is a way in) | yes |
| `POST /admin/users/:id/revoke-sessions` | deny access | yes |
| `PATCH /users/:id` (e-mail, employee link) | take over (login identity; the employee behind SELF-scope data) | yes |
| `PATCH /users/:id/roles` | change privilege / deny access | yes (+ grant rules, self-escalation, last-admin) |
| `PATCH /users/:id/activate` | restore access | yes |
| `PATCH /users/:id/deactivate` | deny access | yes (+ last-admin, no self) |
| offboarding completion (`deactivateUserWithTx`) | deny access | yes (the whole completion is refused; re-run with "keep account" or ask a privileged administrator) |
| `POST /users` | create privilege | grant rules: a role carrying `roles.manage` needs the full subset; `users.manage_privileged` is never granted by someone without it |
| `POST /account/reset-password` (consume) | — | token-bound; only a token issued through the guarded path exists |
| `POST /account/change-password`, `/account/sessions/revoke-others`, logout | own account only | unchanged |

`users.manage_privileged` is held by **SYSTEM_ADMIN** only (seeded, and added to existing databases by migration
`20261001090000_privileged_account_administration`). It is part of `CRITICAL_PERMISSIONS` (System Admin can never lose
it) and of `ADMINISTRATION_PERMISSIONS` (never granted or added by someone who lacks it). It grants no business access.

**Peer administrators.** A privileged administrator may administer another privileged administrator (reset, sign-out,
edit, deactivate, re-role) — deliberately, because that is the only recovery path for a locked-out administrator in a
system without e-mail. `LAST_SYSTEM_ADMIN`, `SELF_DEACTIVATION_NOT_ALLOWED` and `SELF_ROLE_REMOVAL_NOT_ALLOWED` still
apply, so the last active System Admin can never be deactivated or demoted by anyone.

**Own account.** The guard does not apply to your own account; your own password is changed with the current password,
you cannot deactivate yourself or remove your own System Admin role, and any change to your own roles is subject to the
self-escalation rule (§2).

## 2. `roles.manage` — administering other people's access

`roles.manage` means *administer roles for other users within the governance rules*. It never means *grant myself
authority*.

- **Self-assignment** (`PATCH /users/<me>/roles`): the effective permissions and data scope before and after are compared
  (`selfEscalation`). Any gained permission or wider scope (SELF→TEAM, SELF→ALL, TEAM→ALL) →
  `403 SELF_PRIVILEGE_ESCALATION_NOT_ALLOWED`. Removing roles, or adding a role that brings nothing new, is allowed.
- **Editing a role you hold** (`PATCH /roles/:id/permissions`): you may remove permissions, never add one you do not
  already have → `403 SELF_PRIVILEGE_ESCALATION_NOT_ALLOWED`.
- **Editing any other role** (governance of other users): business permissions may be added; administration permissions
  you lack (`ADMINISTRATION_PERMISSIONS`: users.\*, roles.\*, `users.manage_privileged`, `account.manage_recovery`) may
  not; and a role that would carry `roles.manage` must stay entirely within your own permissions (no crafted second
  super-administrator) → `403 ROLE_EDIT_ESCALATION_NOT_ALLOWED`.
- **Assigning roles to others** (`blockingGrantPermissions`): unchanged from Task 43 — a `roles.manage` holder may grant
  business permissions it does not hold, never administration permissions it lacks, and a role carrying `roles.manage`
  only if it is entirely within the grantor's permissions. Scope may never exceed the grantor's.
- Roles cannot be created, deleted or re-scoped through the API.

So the three Task 44 paths are closed: (A) self-assign HR_ADMIN, (C) add `compensation_planning.apply` to a held role,
(D) add it to EMPLOYEE for others and then self-assign EMPLOYEE — the edit in D is allowed as governance of other users;
the self-assignment is refused.

## 3. Governance limits (documented, not prevented)

- **Two administrators acting together** can still widen each other's access: A grants B a business role, B grants one
  back. Each grant is an audited `UPDATE_USER_ROLES` with its actor; two-person collusion is a governance matter.
- **An account administrator can create accounts.** A holder of `users.create` + `roles.manage` can create a new account
  and give it business roles (to another user, not themselves). The audit trail (`CREATE_USER`, actor, roles) is the
  control; review it.
- **Account recovery is takeover-capable by nature.** Without e-mail delivery, a recovery administrator
  (`account.manage_recovery`) receives the reset link. For ordinary (non-privileged) accounts this includes accounts
  holding business permissions the administrator lacks (e.g. System Admin issuing a link for an HR Admin). The issuance is
  audited; e-mail delivery (a later production-baseline task) takes the administrator out of the link path.

## 4. Security matrix (tested: `apps/api/tests/privileged-accounts.test.ts`)

Actions: issue reset link · PATCH e-mail · deactivate · change roles.

| Actor ↓ / Target → | Employee | Manager | HR_ADMIN | SYSTEM_ADMIN (privileged) |
|---|---|---|---|---|
| EMPLOYEE | 403 FORBIDDEN | 403 FORBIDDEN | 403 FORBIDDEN | 403 FORBIDDEN |
| HR | 403 FORBIDDEN | 403 FORBIDDEN | 403 FORBIDDEN | 403 FORBIDDEN |
| HR_ADMIN | allowed | allowed | allowed | **403 PRIVILEGED_ACCOUNT_PROTECTED** |
| SYSTEM_ADMIN (`users.manage_privileged`) | allowed | allowed | allowed | allowed (peer), except last-admin / self rules |

Self-escalation (tested): SYSTEM_ADMIN self-assign HR_ADMIN → 403; add `compensation_planning.apply` to the held
SYSTEM_ADMIN role → 403; a narrow RBAC role (`roles.manage` only) adding `compensation_planning.apply`, `payroll.manage`,
`employee_relations.manage` or `benefits.manage` to itself → 403; EMPLOYEE edited for others then self-assigned → 403;
SELF→TEAM / SELF→ALL self-assignment → 403; "Role Evil" (`roles.manage` + `compensation_planning.apply`) → 403. After all
of them, compensation Apply and payroll administration remain 403 and no salary record is written.

## 5. Logging and audit

Successful issuance, role changes, role-permission changes and (de)activation stay audited as before; tokens and
passwords are never logged or audited. Refusals are 403 with a stable code, write no audit row (existing policy: denied
requests appear in the request log), and add a structured warning (`privileged_account_action_refused`,
`self_escalation_refused`) with actor and target ids only.
