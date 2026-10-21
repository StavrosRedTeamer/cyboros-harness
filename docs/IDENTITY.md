# Identity and access control

The Command Center has accounts. Every `/api` request — read or write — is
authenticated, and then authorized by role. There is no anonymous data surface:
`GET /api/overview` without a session is `401`, and a viewer's `POST /api/scope`
is `403` before its body is even parsed.

The whole model lives in [`tools/identity.js`](../tools/identity.js). Route
handlers receive `principal` and never see a credential; the server calls
`authorize(principal, url, method)` exactly once per request.

## Roles

| Role | May | Typical holder |
|---|---|---|
| `viewer` | read findings, scope, pipeline, sessions, reports (`GET /api/*`, `/reports/*.html`) | client stakeholder, engagement manager, auditor |
| `operator` | everything a viewer does, plus scope edits, pipeline resume, report generation, approvals, the terminal | pentester running the engagement |
| `admin` | everything an operator does, plus account management (`GET/POST/DELETE /api/users`) | team lead / engagement owner |

A live terminal stream (`/api/term/stream`) and job output (`/api/jobs/*/events`)
require `operator`, not `viewer`: a shell is not a read-only view.

A role is enforced server-side. Hiding a button in the UI is convenience, never a
control — the API refuses independently.

## Accounts

Accounts live in **one file**: `users.json`, next to `scope.json` (a different path
is allowed with `CYBOROS_USERS_FILE`, which is also how containers and tests point
it elsewhere). It is versioned, strictly validated, and must be mode `0600` — if it
is group/other-readable it is tightened automatically, and if it cannot be
tightened every login is refused rather than trusted.

```bash
node tools/users.js add alice --role operator --generate
node tools/users.js list
node tools/users.js passwd alice --password-stdin < /run/secrets/alice
node tools/users.js role alice admin
node tools/users.js disable alice        # ends alice's live sessions immediately
node tools/users.js remove alice
```

The first admin is a CLI step on purpose, the same way `scope.json` is: it must be
possible to create an operator when the console is not running, and a password
must never travel as an argument (shell history, `ps`). `--generate` prints a
32-character password exactly once; `--password-stdin` reads a secret from a file
or a pipe.

Rules the file and CLI both enforce:

- username `^[a-z0-9][a-z0-9._-]{1,31}$`, lower-cased;
- role is one of `viewer`, `operator`, `admin` — nothing else authenticates;
- password ≥ 12 characters and not equal to the username; stored as
  `scrypt$N$r$p$salt$key` (N=16384, r=8, p=1), never in the clear, never echoed;
- the last enabled admin cannot be removed, demoted or disabled;
- a broken `users.json` fails **closed**: the console starts, reports the error,
  and refuses every login until an admin fixes the file.

Administrators do the same from the console: the **Users** tab
([`tools/gui/views-admin.js`](../tools/gui/views-admin.js)) lists accounts, changes
roles, disables, removes, resets passwords and creates accounts, over
`GET/POST /api/users` and `POST/DELETE /api/users/:name`. Password hashes are never
returned by any endpoint.

## Sessions

- Password check → opaque 32-byte session id in a `HttpOnly`, `SameSite=Strict`,
  `Path=/` cookie (`Secure` when the request arrives over HTTPS). The page never
  stores a credential.
- Absolute lifetime 12 h, idle timeout 2 h, both checked on every request.
- The account is re-read on every request, so disabling a user or changing a role
  takes effect on the next request, not on the next login. A removed account takes
  its sessions with it.
- Five failed logins in five minutes lock that username for 60 s
  (`429` + `Retry-After`). Unknown users cost the same time as wrong passwords.
- `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`.

## The service token

The startup token (`--token`, printed in the launcher URL, `SCC_TOKEN` in scripts)
is a **machine** credential, not an account. It authenticates as principal
`service` with role `operator` (`--token-role` changes the role, deliberately an
admin-only decision made on the command line). It cannot manage accounts.

Opening `/?token=<service token>` exchanges it for a session cookie and redirects,
so the launcher keeps working while the credential stops living in page
JavaScript.

## Audit

Every decision is written to the existing hash-chained audit trail
([`tools/audit-trail.js`](../tools/audit-trail.js), `artifacts/audit/<date>.jsonl`):

| event | actor | when |
|---|---|---|
| `auth.login` | the username | success, failure, lockout |
| `auth.logout` | the username | explicit sign-out |
| `access.denied` | the principal, or `anonymous` | 401 / 403 |
| `console.write` | the principal | every authorized mutation |
| `user.create` / `user.update` / `user.remove` | the principal, or `cli:<os user>` | account changes |

The actor is always the authenticated identity. A request body may contain
`actor: "someone-else"` and it is ignored — approvals, campaign changes, scope
notes and dispatch consume `ctx.actor`, which the server fills from the session.
Scope changes are also recorded inside `scope.json` itself
(`Cyboros Console update by alice — added 1 host(s): …`).

## Adding another identity backend (OIDC, mTLS, SSO proxy)

The seam is one function. A provider is an object:

```js
// /etc/cyboros/oidc-provider.js
module.exports = {
  name: 'oidc',
  // Returns a principal or null. May be async. Throw → treated as "no principal".
  async authenticate(req, ctx) {
    const token = (req.headers.authorization || '').replace(/^Bearer /, '');
    if (!token) return null;
    const claims = await verifyJwtWithYourIdp(token); // your code
    return { username: claims.preferred_username, role: claims.cyboros_role, display_name: claims.name };
  },
};
```

Enable it at boot:

```bash
CYBOROS_AUTH_PROVIDER=/etc/cyboros/oidc-provider.js node tools/gui-server.js
```

What the seam guarantees, and what it does not:

- providers are consulted **before** the service token and **after** a session
  cookie, in registration order;
- a provider that throws, or returns an unknown role or empty username, is
  ignored — it cannot authenticate anybody by failing;
- `role` must be one of `viewer|operator|admin`; mapping IdP groups to roles is
  the provider's job (return the mapped role, not the group name);
- no route handler changes: `authenticate()` is the only entry point, and
  `authorize()` keeps its table.

Because the console binds to loopback, an OIDC deployment normally sits behind a
reverse proxy that terminates TLS and forwards `X-Forwarded-Proto: https` (the
session cookie becomes `Secure` automatically when it sees that header) and
`X-Forwarded-For` (used as the audit `ip`).

## What is not here yet

Single-tenant by design: one installation, one engagement workspace, one
`users.json`. Multi-client tenancy, SCIM provisioning, per-engagement roles and
token revocation lists are out of scope for this layer and are tracked as product
work, not as security debt — the authorization table is the place they will land.
