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
- **XSS:** reflected/stored/DOM; `dalfox` for reflected; `dom-check.js` (CDP) for DOM/client-side
  (postMessage handlers, sinks, localStorage); confirm execution context, not just reflection.
- **AuthZ — BOLA/BFLA (OWASP 2025 A01, distinct):** `cyboros-authz`. Distinguish Broken **Object**
  Level AuthZ (BOLA, IDOR — same object id as another user) from Broken **Function** Level AuthZ
  (BFLA — low-priv user calling an admin function). Replay the request as a lower-priv/other user via
  `repeater.js --as <identity>`; compare status, bytes AND `--diff` body_similarity (same-length
  different-content is still an IDOR). Record BOLA/BFLA with class `bola`/`bfla`. La ripetizione su
  tutte le identità è meccanizzata: `node tools/permission-matrix.js --urls <file> --identities a,b`
  produce la matrice chi-vede-cosa e i candidati `suspected` (mai severità da lì: la registrazione
  passa da `record-finding.js`).
- **SSRF:** parameters that fetch URLs. For BLIND SSRF start `node tools/oob.js listen`, inject
  `oob.js marker` into the param, wait, then `oob.js hits` — the target's fetch is the proof.
  Reflected SSRF: `--follow` the fetch or read the response body. Cloud metadata (169.254.169.254)
  only if explicitly allowed in scope.json `allowed_ips`.
- **XXE:** upload/XML endpoints — send an external-entity payload that fetches an `oob.js` marker
  (blind detection) or a local file entity (error-based); OOB hit = confirmed.
- **Other injection (command/template/header/open-redirect, SSTI, deser, NoSQLi, LFI, proto-pollution):**
  read `tools/payloads/<class>.md` first, then `nuclei` + manual via `repeater.js`. SSTI: fingerprint the
  engine from the error, confirm with a math marker (`{{7*7}}`→49). Deser/NoSQLi/LFI/proto-pollution:
  detection-only (error/time/reflect) until the user confirms escalation.
- **File upload:** `repeater.js --upload file=./poc.html --form k=v` — extension/polyglot/content-type
  bypass, stored-XSS via upload, path traversal in filename, upload-to-RCE only with explicit approval.
- **Race conditions (TOCTOU):** `repeater.js --race 8` on redeem/coupon/transfer endpoints — look for
  multiple 2xx where one success is expected.
- **JWT:** `jwt.js attack` (alg:none, HS256 with leaked secrets) on any API that accepts Bearer JWTs.
- **CORS:** `cors.js --url` per API origin; reflected origin + `Allow-Credentials: true` = Critical.
- **GraphQL:** `graphql.js introspect` (introspection enabled = finding), then `query` for BOLA on
  customer/user fields.
- **CSP:** `csp.js --url` — unsafe-inline/wildcard/missing frame-ancestors are findings.
- **WebSockets:** `ws.js` for chat/realtime endpoints (missing auth on connect, message injection).
- **Auth/session (cyboros-authn):** login rate-limit/enumeration, password-reset & OTP/MFA
  flows, JWT alg:none/HS256/RS256-confusion + jku/x5u, OAuth/OIDC redirect_uri & state flaws,
  session fixation, cookie flags (Secure/HttpOnly/SameSite).
- **CSRF (cyboros-csrf):** state-changing POST/PUT/PATCH/DELETE endpoints without a CSRF token (or
  with a stale one) + cookies with SameSite=None/absent. Cross-site request with
  `Origin: https://evil.example` via `repeater.js`; chain with a CORS reflection (read the response
  back) for Critical.
- **Cloud (cyboros-cloud):** metadata via SSRF (169.254.169.254 etc., only if `allowed_ips` allows),
  exposed S3/GCS/Azure buckets, provider fingerprint. Read the smallest proof (role NAME, not creds).
- **LLM / GenAI / Agentic AI (cyboros-llm):** `tools/payloads/llm-agentic.md` + `tools/payloads/mcp.md`.
  Detection-only, benign MARKER always. LLM01 prompt injection, LLM07 system-prompt leak, RAG poisoning
  (LLM08/ASI06), and Agentic AI 2026: ASI02 tool misuse / ASI03 identity (exposed `tools/list`,
  unauth-able `tools/call`/`resources/read` on an `/mcp` endpoint). OOB-mark the URL-fetching tools;
  never use a destructive/privileged tool. classify class `llm`/`mcp`.