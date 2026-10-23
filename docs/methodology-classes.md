# Testing by class — dettaglio metodologico

> Dettaglio completo della fase "Testing by class"; knowledge.md tiene solo l'elenco classi one-line.
> Cerchiabile con `node tools/kb-search.js "bola ssrf ssti"`.

**Class names for `record-finding.js`** are the canonical keys of `tools/test-registry.json` —
use the dedicated key where one exists: `race`, `ws`, `cache-poison`, `saml`, `jwt`, `cors` for the
respective web classes; `cred-dump` (dcsync/secretsdump), `lateral` (relay/PtH/remote services) and
`privesc` (elevation vectors) for host/AD outcomes; `takeover`/`dns`/`email-auth`/`crypto` for the
DNS/TLS surfaces. Unknown keys are rejected fail-closed.

**Testing by class:** every class in `tools/test-registry.json` also carries a MITRE ATT&CK mapping
(`attack`: technique ids) — `node tools/attack-coverage.js --write` turns it into `reports/attack-matrix.md`
(planned coverage by class vs techniques executed on findings.jsonl). Taxonomy aligned to OWASP Top 10:2025 — A01 now explicit BOLA/BFLA; new 2025
classes `supply-chain` (A03) and `exceptional` (A10, error-handling) are in `tools/test-registry.json`
and tracked by `coverage.js`.

- **Injection — SQLi:** error-based, boolean/time-blind; `sqlmap` on candidate params.
  **ORM-level SQLi** (class `sqli`, see `tools/payloads/sqli-orm.md`) does not look like SQLi: the
  parameter becomes an *identifier* (sort/column/alias), an inline ID list, a JSON/JSONB cast type,
  or an order direction. 2026 examples: Drizzle identifier escaping (CVE-2026-39356), Hibernate
  `InlineIdsOrClauseBuilder` (CVE-2026-0603), Sequelize JSON cast (CVE-2026-30951) and Oracle
  `TO_DATE` prefix (CVE-2026-69240), TypeORM order direction (GHSA-9ggv-8w38-r7pm). Probe with a
  quote/backtick marker and `--diff`; a 500 alone is not a finding.
- **XSS (full reference `tools/payloads/xss.md`):** reflected/stored/DOM; `dalfox` for reflected;
  `dom-check.js` (CDP) for DOM/client-side (postMessage handlers, sinks, localStorage); confirm
  execution context, not just reflection. 2026 additions: sanitizer-output reparse (mXSS —
  DOMPurify <3.3.2, Jodit), framework i18n attribute bindings (Angular i18n-href/i18n-on*), and
  service workers that drop `credentials: 'omit'` or forward auth headers across a redirect.
- **AuthZ — BOLA/BFLA (OWASP 2025 A01, distinct):** `cyboros-authz`. Distinguish Broken **Object**
  Level AuthZ (BOLA, IDOR — same object id as another user) from Broken **Function** Level AuthZ
  (BFLA — low-priv user calling an admin function). Replay the request as a lower-priv/other user via
  `repeater.js --as <identity>`; compare status, bytes AND `--diff` body_similarity (same-length
  different-content is still an IDOR). Record BOLA/BFLA with class `bola`/`bfla`. La ripetizione su
  tutte le identità è meccanizzata: `node tools/permission-matrix.js --urls <file> --identities a,b`
  produce la matrice chi-vede-cosa e i candidati `suspected` (mai severità da lì: la registrazione
  passa da `record-finding.js`).
  **Middleware is not an authorization boundary** (class `authz`, full reference
  `tools/payloads/middleware-bypass.md`): when the check runs in middleware/proxy and the handler
  resolves the path itself, the two strings can differ — case, `//`, `/./`, `;`, `..;/`, encoded and
  over-decoded forms, base-prefix without a segment boundary, absolute-form target, H2 `:path`.
  The 2026 wave is entirely this: Next.js i18n data route and RSC prefetch (CVE-2026-44573/44575),
  Astro `x-astro-path` and deep-decode rewrites (CVE-2026-33768/59731), Nuxt routeRules case
  (CVE-2026-53721), Fastify/Nest canonicalization (CVE-2026-2293/2880), Spring Security
  `servlet-path` (CVE-2026-22754). Prove it with content, never with a status code.
- **SSRF:** parameters that fetch URLs (full reference: `tools/payloads/ssrf.md`). For BLIND SSRF
  start `node tools/oob.js listen`, inject `oob.js marker` into the param, wait, then `oob.js hits`
  — the target's fetch is the proof. Reflected SSRF: `--follow` the fetch or read the response body.
  Cloud metadata (169.254.169.254) only if explicitly allowed in scope.json `allowed_ips`.
  2026 additions: image optimizers with an over-broad `remotePatterns` allow-list
  (CVE-2026-94483), `rewrites()`/`redirects()` destination hosts built from request input
  (CVE-2026-64645), prerendered error pages that fetch the incoming Host (CVE-2026-25545), and MCP
  tool fetchers that validate the URL but not the *resolved* address — DNS rebinding
  (CVE-2026-53708) or IPv4-mapped IPv6 loopback (CVE-2026-49857).
- **XXE:** upload/XML endpoints — send an external-entity payload that fetches an `oob.js` marker
  (blind detection) or a local file entity (error-based); OOB hit = confirmed.
- **Other injection (command/template/header/open-redirect, SSTI, deser, NoSQLi, LFI, proto-pollution):**
  read `tools/payloads/<class>.md` first, then `nuclei` + manual via `repeater.js`. SSTI: fingerprint the
  engine from the error, confirm with a math marker (`{{7*7}}`→49). Deser/NoSQLi/LFI/proto-pollution:
  detection-only (error/time/reflect) until the user confirms escalation. Serialized input that is
  *revived* into JS is its own family (`tools/payloads/deserialization.md`): seroval `fromJSON`
  (CVE-2026-23737) and Qwik `server$` (CVE-2026-27971) take a value-type confusion, and the second is
  unauthenticated RCE — check the version, do not send a crafted body.
- **Prototype pollution (class `proto-pollution`):** `tools/payloads/prototype-pollution.md`. The
  pollute itself is the easy half; the 2026 findings are **gadgets** — a library that reads an
  inherited property and acts on it: axios `proxy`/`baseURL`/`transformResponse`/`validateStatus`
  (CVE-2026-40175…-44495), piscina/tinypool inherited worker `filename` (CVE-2026-55388,
  CVE-2026-104849), Handlebars inherited partial → XSS (CVE-2026-33916), DOMPurify inherited
  custom-element checks (CVE-2026-41238), n8n pagination → RCE (CVE-2026-44789). Test the gadget in
  a local harness with an inert key; on target, the marker is a changed decision, not a crash.
- **Client-side path traversal (class `cspt`):** a client-controlled path fragment (`location.hash`,
  `location.search`, a `postMessage` payload) is interpolated into a `fetch()`/XHR path, so the
  attacker can redirect the request to an endpoint the UI never calls; chain it with CSRF when that
  endpoint mutates state (Doyensec CSPT-to-CSRF). Detection: read the client code first
  (`analyze-bundle.js`, `dom-check.js`) for path concatenation from a controllable source, then
  replay both paths via `repeater.js --diff` — the proof is a request that reaches an API surface
  the page does not legitimately expose. Record class `cspt`, not `xss`.
- **Cache poisoning / deception (class `cache-poison`):** `node tools/cachepoison.js probe|deception`
  plus `tools/payloads/cache-poisoning.md`. 2026 shifted the bug into the **cache key**: a default key
  that omits the host (CVE-2026-2836), ambiguous concatenation of attacker-controlled fragments
  (nginx custom keys, 2026-09), and cross-route cache substitution in self-hosted Next.js SSG/ISR
  (CVE-2026-94543 / CVE-2026-94484, Vercel-hosted excluded). Test key collisions with two `Host`
  values and a cache-busted path; the proof is one object served for two distinct requests.
- **HTTP/2 desync (class `h2-desync`):** a front end speaking HTTP/2 that downgrades to HTTP/1.1
  upstream exposes H2.CL / H2.TE smuggling and cache poisoning through desync; the CL.TE/TE.CL/TE.TE
  checks in `desync.js` do not cover it. Detection: `desync.js` first, then confirm the front-end/CDN
  and upstream protocol versions (`httpx -http2`), and treat a status/timeout differential under H2
  as a candidate until reproduced. Detection-only: no cache poisoning against a live cache without
  explicit approval for that action.
- **File upload:** `repeater.js --upload file=./poc.html --form k=v` — extension/polyglot/content-type
  bypass, stored-XSS via upload, path traversal in filename, upload-to-RCE only with explicit approval.
- **Race conditions (TOCTOU):** `repeater.js --race 8` on redeem/coupon/transfer endpoints — look for
  multiple 2xx where one success is expected.
- **JWT:** `jwt.js attack` (alg:none, HS256 with leaked secrets) on any API that accepts Bearer JWTs.
- **CORS:** `cors.js --url` per API origin; reflected origin + `Allow-Credentials: true` = Critical.
- **GraphQL (class `graphql`; full reference `tools/payloads/graphql.md`):** `graphql.js introspect`
  (introspection enabled = finding), then `query` for BOLA on customer/user fields. Also: field-level
  authz through class/interface inheritance (CVE-2026-41856), Hasura computed-field row-filter
  omission (CVE-2026-54698), GET multiplex mutations (CVE-2026-19650), forged subscription identity
  from WebSocket connection params (CVE-2026-5423), and pre-execution fragment-chain exhaustion
  (GraphQL Java, 2026-09) — bounded, not a load test.
- **CSP:** `csp.js --url` — unsafe-inline/wildcard/missing frame-ancestors are findings.
- **WebSockets:** `ws.js` for chat/realtime endpoints (missing auth on connect, message injection).
- **Auth/session (class `authn`; full references `tools/payloads/oauth-oidc.md` + `jwt.md`):**
  login rate-limit/enumeration, password-reset & OTP/MFA flows, JWT alg:none/HS256/RS256-confusion
  + jku/x5u + the `crit` header, OAuth/OIDC redirect_uri & state flaws, session fixation, cookie
  flags (Secure/HttpOnly/SameSite). 2026 patterns worth checking by name: redirect_uri allow-list
  bypass through `..;/` (CVE-2026-3872), login CSRF via a plantable state/PKCE cookie
  (CVE-2026-18165), identity matched by email instead of `iss`/`sub` (CVE-2026-49757),
  `client_credentials` token accepted as a user token (CVE-2026-59358), MFA removal without the
  required assurance level (CVE-2026-3429), conditional-OTP skip driven by a proxy header
  (CVE-2026-96445), empty reset key (CVE-2026-107640), Host/X-Forwarded-Host reset poisoning
  (CVE-2026-27959, CVE-2026-42606).
- **CSRF (cyboros-csrf):** state-changing POST/PUT/PATCH/DELETE endpoints without a CSRF token (or
  with a stale one) + cookies with SameSite=None/absent. Cross-site request with
  `Origin: https://evil.example` via `repeater.js`; chain with a CORS reflection (read the response
  back) for Critical.
- **SAML (class `saml`):** `tools/payloads/saml.md` + `tools/saml.js`. Signature-optional and
  "verification error is success" (CVE-2026-28323, CVE-2026-15981) are tested before wrapping;
  XSW is still `--xsw 1..8` (CVE-2026-47201, CVE-2026-89043), plus algorithm confusion where the
  RSA public key is used as an HMAC secret (CVE-2026-15013) and broker paths that accept a disabled
  IdP or disabled client (CVE-2026-2603, CVE-2026-3047).
- **Cloud (cyboros-cloud; full reference `tools/payloads/cloud.md`):** metadata via SSRF
  (169.254.169.254 etc., only if `allowed_ips` allows), exposed S3/GCS/Azure buckets, provider
  fingerprint. Read the smallest proof (role NAME, not creds). 2026 adds **bucket ownership**: a
  predictable staging bucket the SDK does not verify (CVE-2026-2473; Unit 42 model-upload and
  reclaimed-stream research, no CVE) and object-key scope checked against a user-controlled key
  (CVE-2026-105811).
- **Server runtime patch level (class `config`, deliberately not `deser`; full reference
  `tools/payloads/runtime-server.md`):** the engine behind the app can be the finding. **PHP2Shell**
  (2026-10-21) is two unauthenticated RCEs in PHP itself — CVE-2026-109618, OOM handling leaves
  request data partially initialized (GHSA-w8hw-w9fx-j79w), and CVE-2026-109619, request state
  survives the free of its backing memory and a later request reuses it (GHSA-6wmf-4rv5-p3rp); both
  CVSS v4 9.2, every PHP ≥5.4 that serves requests, fixed in 8.5.12 / 8.4.27 / 8.3.36 / 8.2.35 with
  source backports for 7.4/8.0/8.1. Version gate only: fingerprint (`X-Powered-By`,
  `httpx-toolkit -tech-detect`, vendor package) and record `config` as `suspected` — a distro backport
  keeps the old upstream number, so a version below the fix is a candidate, not proof. Never send the
  trigger: it is a multipart body built to hit OOM/fatal error (availability, rule 2) and one path
  returns other requests' worker memory (passwords, tokens, TLS keys).
- **Data API / backend-as-a-service (class `data-api`):** Supabase/PostgREST and Firebase expose
  tables and documents directly to the browser SDK, so the flaw is authorization, not injection.
  Check RLS **and** table grants (a policy does not revoke a grant), exposed views/functions, Storage
  buckets and Realtime DB rules. Detection: with the public anon/publishable key, read a deliberately
  seeded canary row — never a `service_role` key, never real data — then repeat with a second identity
  to expose cross-tenant reads; write a canary row only with explicit confirmation. Record class
  `data-api`: a permissive rule is `triggered`, a cross-tenant read is `exploited`.
- **LLM / GenAI / Agentic AI (cyboros-llm):** `tools/payloads/llm-agentic.md` + `tools/payloads/mcp.md`.
  Detection-only, benign MARKER always. LLM01 prompt injection, LLM07 system-prompt leak, RAG poisoning
  (LLM08/ASI06), and Agentic AI 2026: ASI02 tool misuse / ASI03 identity (exposed `tools/list`,
  unauth-able `tools/call`/`resources/read` on an `/mcp` endpoint). OOB-mark the URL-fetching tools;
  never use a destructive/privileged tool. classify class `llm`/`mcp`. Two 2026 shapes to test by
  name: agent instructions served without auth (CVE-2026-40151, `/api/agents`) and a retrieval
  collection any authenticated user can overwrite — RAG poisoning, detectable by writing a marker
  from identity B and asking identity A a question (CVE-2026-28788, CVE-2026-44554).