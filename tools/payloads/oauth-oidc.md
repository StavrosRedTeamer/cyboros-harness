# OAuth 2.0 / OIDC / session and password-reset flaws (detection-only reference)

> **Detection-only.** Use accounts you own on an in-scope test realm; never a victim's
> credentials, never a real reset email, never a state-changing write without explicit
> approval. `node tools/scope-guard.js check <url>` first (exit 0). A redirect that fires is
> `triggered`; an access token issued to the wrong principal is `exploited`.

## 1. Map the flows

Take the client from the bundle instead of guessing paths: `node tools/analyze-bundle.js <url>`
extracts `authorize`, `token`, `callback`, `logout`, reset and OTP endpoints plus embedded
client ids. Enumerate, per flow: `response_type`/`grant_type`, `redirect_uri` registrations,
`state`/`nonce`/PKCE handling, cookie names set on `/authorize`, and the reset/OTP endpoints.

## 2. `redirect_uri` validation

Replay the authorize request with a test `redirect_uri` and read whether the browser is
redirected (`302 Location`) or the IdP errors:

```
node tools/repeater.js --url "https://idp/authorize?response_type=code&client_id=<id>&redirect_uri=<probe>&state=MARKER"
```

Probe set: an unregistered host, a registered host with a different path/port, `https://reg@evil`,
`https://reg.evil`, `..;/` inside a registered path prefix, and a duplicate `redirect_uri`.
`..;/` is the 2026 Keycloak path-traversal bypass (CVE-2026-3872); a redirect pattern that
resolves to an untrusted host is the Backstage case (CVE-2026-32235). A 302 to your host with
`code=` in the query is `exploited`; a 302 that only carries the error is not a finding.

## 3. state / nonce / PKCE

- **Login CSRF**: can a sibling host set the `state`/PKCE cookies (`CVE-2026-18165`,
  `@fastify/oauth2`)? Two browser profiles, one attacker-owned, is enough to prove it.
- **Code isolation**: replay one authorization code twice and against a second client; a
  code accepted outside its single-use/client scope is `CVE-2026-4282`-class.
- **Fixation**: note the session id before `/authorize` and after the callback; if the
  pre-auth id survives authenticated, it is `CVE-2026-7507`-class.

## 4. Identity matching and token confusion

Register two test identities that share an email but differ in `iss`/`sub`; if the second
resolves to the first account, the matcher is keyed on email (`CVE-2026-49757`). Take a
`client_credentials` token and replay it as a user bearer token (`CVE-2026-59358`). Decode an
ID token and check that a mismatched `at_hash`/`c_hash` is rejected rather than ignored
(`CVE-2026-28498`). Offline `alg`/claim work: `tools/payloads/jwt.md`.

## 5. MFA, OTP and password reset

- Delete an enrolled OTP from a password-only session: success without re-proving assurance
  level is `CVE-2026-3429`-class.
- Add `X-Forwarded-For`/`X-Real-IP` to a login: if the realm's conditional-OTP rule skips the
  challenge, the header is trusted (`CVE-2026-96445`).
- Submit a reset with an empty/absent key for an account with no pending reset
  (`CVE-2026-107640`); then vary `Host`/`X-Forwarded-Host` and compare the link host in the
  response or mail sink (`CVE-2026-27959`, `CVE-2026-42606`).

## 6. Disclosures 2026 (dated)

| Technique | CVE / advisory | Date | Affected | Probe |
|---|---|---|---|---|
| redirect_uri allowlist bypass | CVE-2026-32235 | 2026-03 | `@backstage/plugin-auth-backend` < 0.27.1 (DCR/CIMD enabled) | unregistered host in `redirect_uri` |
| error redirect unvalidated (implicit/hybrid) | CVE-2026-44681 | 2026-05 | Authlib <= 1.6.11, 1.7.0 | omit `openid`, watch `redirect_uri` |
| account matched by email, not iss/sub | CVE-2026-49757 | 2026-06 | AshAuthentication >= 0.1.0 < 4.14.0; 5.0.0-rc.0–<5.0.0-rc.10 | two identities, same email |
| login CSRF via plantable state/PKCE cookie | CVE-2026-18165 | 2026-08 | `@fastify/oauth2` >= 7.2.0 < 8.3.0 | sibling host sets cookie, completes flow |
| `at_hash`/`c_hash` fail-open | CVE-2026-28498 | 2026-03 | Authlib <= 1.6.8 | ID token, mismatched hash, unsupported alg |
| user token reused as client auth | CVE-2026-59358 | 2026-10 | UAA v3.7.0–v79.6.0; CF Deployment <= v60.4.0 | `client_credentials` grant with user token |
| OIDC redirect_uri bypass | CVE-2026-7504 | 2026-05 | Keycloak < 26.6.2; backports 26.2.16, 26.4.12 | boundary-case destinations |
| implicit-flow bypass / token disclosure | CVE-2026-7571 | 2026-05 | Keycloak < 26.6.2; backports 26.4.12 (26.7.0 also fixed) | altered client data |
| redirect_uri bypass via `..;/` | CVE-2026-3872 | 2026-04 | Keycloak < 26.5.7; backports 26.2.15, 26.4.11 | traversal inside registered prefix |
| forged code accepted across isolation | CVE-2026-4282 | 2026-04 | Keycloak < 26.5.7; backports 26.2.15, 26.4.11 | replay code, second client |
| JWT alg confusion in Authorization Grant | CVE-2026-11800 | 2026-06 | Keycloak JWT Authorization Grant (range not stated) | unexpected-alg assertion |
| DPoP proof replay | CVE-2026-41707 | 2026-08 | Spring Security 6.5.0–6.5.11, 7.0.0–7.0.6, 7.1.0 | replay a used `jti` |
| OIDC login session fixation | CVE-2026-7507 | 2026-05 | Keycloak < 26.6.2; backports 26.2.16, 26.4.12 | pre-auth session id survives |
| session fixation on login | CVE-2026-9507 | 2026-06 | osTicket v1.18.2 | `OSTSESSID` not rotated |
| OTP removal without AAL | CVE-2026-3429 | 2026-03 | Keycloak ≤ 26.5.6 (fix 26.5.7); 26.4.11 and 26.6.0 also fixed | password-only session deletes OTP |
| conditional OTP skip via proxy header | CVE-2026-96445 | 2026-09 | Keycloak Conditional OTP (range not stated) | `X-Forwarded-*` on login |
| reset state validation bypass | CVE-2026-18963 | 2026-08 | Red Hat build of Keycloak >=26.0.0 <26.4.15; >=26.5.0 <26.6.6; >=26.7.0 <26.7.2 | reset without action token |
| reset link poisoning | CVE-2026-42606 | 2026-04 | AzuraCast <= 0.23.5 | `X-Forwarded-Host` in link |
| Host-header reset poisoning | CVE-2026-27959 | 2026-02 | Koa 3.x < 3.1.2, 2.x < 2.16.4 | malformed `Host` in reset URL |
| empty reset key bypass | CVE-2026-107640 | 2026-10 | Enswitch supported branches 3.13–4.4 (4.2 confirmed); fixes r21680+ (3.13–4.3), commit c2c981578+ (4.4) | omit key, no pending reset |

## 7. Record

`node tools/record-finding.js '{"severity":"High","title":"OAuth redirect_uri allowlist bypass","host":"HOST","endpoint":"/authorize","class":"authn","cwe":"CWE-601","verify_level":"triggered","poc":"<request + 302 Location>"}'`
— CWE-287 for token/identity confusion, CWE-352 for the login-CSRF case, CWE-384 for fixation.
Session-cookie issues record under class `session`.
