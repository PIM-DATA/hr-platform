# Account recovery and session security

How somebody who cannot sign in gets back in, and what an administrator can and cannot do about it. Written for the
HR administrator handling the call and the engineer supporting the deployment.

---

## 1. The honest shape of recovery here

This system sends no email, SMS or chat message — there is no provider, and pretending otherwise would mean a
"we sent you a link" screen that nothing follows. So there are exactly two paths:

| Situation | Path |
|---|---|
| The user knows their password and wants a new one | **Account security → Change password** (self-service) |
| The user cannot sign in at all | An administrator **issues a one-time reset link** and delivers it by a channel the organization already trusts |

What no one can do, by design:

- **No one can read a password**, including a System Admin: only a bcrypt hash is stored.
- **No administrator can set another person's password.** The old `POST /users/:id/reset-password` endpoint was
  removed in Task 18 — an administrator who could set a password could sign in as that person, and the audit trail
  would show only that person's own account acting.
- There is **no shared default password** and no self-registration.

## 2. Change your own password

**Account security** (user menu → Account security), or `POST /api/v1/account/change-password`.

- The current password must be proven; a wrong one changes nothing (`CURRENT_PASSWORD_INCORRECT`).
- The new password must differ from the current one and be at least **8 characters** (one policy, shared by every
  path that sets a password: `packages/shared/src/schemas/account.ts`).
- On success **every session is revoked — including the browser making the change** — and every outstanding reset
  link for that account is revoked. The user signs in again with the new password.

## 3. Issue a reset link (administrator)

**Administration → Users → key icon**, or `POST /api/v1/admin/users/:userId/password-reset`
(permission `account.manage_recovery`: HR Admin, System Admin).

What happens:

1. A 256-bit URL-safe token is generated. Only its **SHA-256 hash** is stored (`password_reset_tokens.token_hash`),
   exactly as session tokens are.
2. Any earlier unused link for that account is revoked in the same transaction, so **at most one link is ever live**.
3. The link is returned **once**, shown in the dialog, and held in the browser's memory until the dialog closes.
   Nothing caches it; the server cannot show it again. If it is lost, issue a new one.
4. The audit records that a link was issued and when it expires — never the token.

Rules and limits:

- The link is built from **`PUBLIC_APP_URL`** (falling back to the first `CORS_ORIGIN`), never from the request's
  `Host` header — a forged header must not be able to produce a link pointing at an attacker's site.
- Default lifetime **60 minutes** (`PASSWORD_RESET_TTL_MINUTES`, 5–1440).
- An administrator cannot issue a link **to themselves** (`USE_CHANGE_PASSWORD`) — use the change-password screen,
  which proves the current password.
- A deactivated account gets no link (`USER_INACTIVE`). Reactivate first; a reset never reactivates anybody.
- **Deliver it over a channel you trust**, and treat it like a temporary credential: anyone holding the link can set
  that password until it is used or expires.

## 4. Using a link

`/reset-password?token=…` → the user chooses a new password.

- The page moves the token into memory and **replaces the URL immediately**, because a URL is bookmarked, shared and
  kept in history far longer than the token is valid. The token is submitted in the request body.
- Every failure — unknown, expired, already used, revoked by a newer link, deactivated account — returns the **same**
  generic message. A distinct "this account does not exist" would turn the endpoint into an account-enumeration tool.
- The endpoint is unauthenticated (it has to be) and rate-limited to **10 attempts per 15 minutes per IP**.
- On success: the password is set, the token is marked used, and **all sessions and all other reset tokens for that
  account are revoked**. The row is locked with `SELECT … FOR UPDATE` first, so two people racing the same link can
  never both set a password — exactly one succeeds.

## 5. Sessions

- **Account security** lists the caller's own sessions (address, browser, signed-in and expiry times, which one is
  "this device"). Token hashes are never part of that shape.
- **Sign out other devices** (`POST /account/sessions/revoke-others`) keeps the current browser and drops the rest.
- **Administration → Users → sign-out icon** (`POST /admin/users/:userId/revoke-sessions`, `account.manage_recovery`)
  signs a user out everywhere — for a lost laptop or a suspected compromise. It does **not** change the password, so
  the user can sign straight back in; pair it with a reset link when the password itself may be known.
- Every one of these actions is audited (`CHANGE_OWN_PASSWORD`, `ISSUE_PASSWORD_RESET`, `RESET_USER_PASSWORD`,
  `REVOKE_OTHER_SESSIONS`, `ADMIN_REVOKE_USER_SESSIONS`) with counts only — never a token or a password.

## 6. Operations

- Spent tokens are security artifacts with no value once they age out:
  `npm run ops:cleanup-reset-tokens -- --days 30` removes expired, used and revoked rows older than the given number
  of days (default 30). Safe to run on a schedule; it never touches live links.
- Logs contain the request path only — **query strings are stripped before logging** in both the request logger and
  the error handler, so a token pasted into a URL cannot end up in a log file.

## 7. What is deliberately not here

- Self-service "forgot password" by email/SMS (no provider is integrated — see `docs/production-readiness.md`).
- Multi-factor authentication, SSO/SAML/OIDC, self-registration.
- Breached-password checking, password history, forced rotation.
- Account lockout on failed resets beyond the per-IP rate limit.
