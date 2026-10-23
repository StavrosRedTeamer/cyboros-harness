# Stavros payload references

Ready-to-use detection payloads for the classes that don't have a dedicated tool, plus the
reference blocks that carry each class's dated disclosure corpus. Agents read the relevant
file before testing a class. Every payload uses a BENIGN marker (unique string / arithmetic /
time) — never a destructive action.

## Files

| File | Class |
|---|---|
| `ssti.md` | Server-Side Template Injection (Jinja2/Twig/Freemarker/Velocity/Go/Ruby) + the 2026 stored-template wave (FreeMarker/Twig/Jinja, SpEL, OGNL) |
| `deserialization.md` | Java / .NET / PHP / Python-pickle deserialization plus Node revived-JSON (`fromJSON`, Qwik `server$`) — detection only |
| `lfi.md` | Path traversal / LFI / RFI + PHP wrappers |
| `runtime-server.md` | Server runtime patch level (class `config`): fingerprint PHP/Apache/FPM, version-gate engine CVEs (PHP2Shell) — **no trigger is ever sent** |
| `nosqli.md` | NoSQL injection (MongoDB operators, auth-bypass JSON) + 2026 operator-in-a-string-field cases and Cypher |
| `prototype-pollution.md` | Prototype pollution (server + client side) + the 2026 gadget table (axios, SandboxJS, locutus, piscina/tinypool, handlebars, DOMPurify) |
| `sqli-orm.md` | ORM / query-builder SQLi: dynamic identifiers, inline ID predicates, JSON-cast types, order direction (Drizzle, Hibernate, Sequelize, TypeORM) |
| `xss.md` | Client-side: DOM/reflected/stored, mXSS and sanitizer reparse, CSP bypass, postMessage/JSONP origin checks, service-worker request rewriting |
| `ssrf.md` | SSRF: reflected, blind (OOB), and the 2026 fetch surfaces — image optimizers, Host-header prerender, MCP fetchers |
| `oauth-oidc.md` | OAuth 2.0 / OIDC / session / MFA / password-reset flaws (redirect_uri, state+PKCE, identity matching, reset poisoning) |
| `jwt.md` | JWT/JWS/JWE validation flaws: alg:none, key confusion, `crit`, non-HTTP `jku`, RSA1_5 oracle |
| `middleware-bypass.md` | Authorization enforced in middleware vs. the handler: path normalization, case, dot-segments, prefix/base, absolute-form, H2 `:path` |
| `cloud.md` | Cloud/edge reachable from the web: bucket ownership and squatting, object-key scope, edge/proxy Host routing |
| `graphql.md` | GraphQL and API gateways: introspection, field-level authz, GET multiplex, subscriptions, pre-execution exhaustion |
| `llm-agentic.md` | LLM / GenAI / Agentic AI (OWASP LLM Top 10 2025/26 + Agentic AI 2026) — detection-only; §8 points at the 2026 bridge-bug corpus and dates the system-prompt-exposure and RAG-overwrite rows |
| `mcp.md` | MCP server / tool-calling surface (OWASP Agentic AI 2026 ASI02/03/05) — detection-only; §6 holds the 2026 table (20 rows, 2026-01→08) and the `2026-07-28` authorization-spec checks |
| `smuggling.md` | HTTP request smuggling / desync (CL.TE / TE.CL / TE.TE) — detection-only; runs via `tools/desync.js`. 2026 table adds the parser-differential wave: case-sensitive TE, chunk extensions, HTTP/1.0 framing, H3→H1, H2→H1, absolute-form, CRLF-powered desync |
| `cache-poisoning.md` | Web cache poisoning (unkeyed inputs) / cache deception — detection-only; runs via `tools/cachepoison.js`. 2026 table adds cache-**key** bugs (host omitted, ambiguous concatenation, cross-route substitution) and desync feeding a cache |
| `saml.md` | SAML / XML Signature Wrapping (XSW1–8, sig-strip, NameID tamper) — detection-only; minted via `tools/saml.js`, replayed via `tools/repeater.js` |
| `injection.md` | OS command injection, header injection/CRLF, open redirect — detection-only; runs via `tools/repeater.js` + `tools/oob.js` |
| `jndi-spel-ognl.md` | JNDI (Log4Shell family) + SpEL/OGNL/EL expression injection — OOB marker on our own listener, math marker (`49`) |
| `nextjs-rsc.md` | Next.js / React Server Components: middleware bypass (CVE-2025-29927), image optimizer (55173/57752), Server Action authz, RSC CVE (55182) via SBOM — **no serialized RSC payload** |
| `data-api.md` | Supabase/PostgREST + Firebase: RLS vs grants, views, RPC, Storage, Realtime rules — canary row, public key only |
| `cspt.md` | Client-side path traversal → CSRF chain (source→sink in the bundle, `--vary` with traversal segments) |
| `upload-bypass/gen-polyglot-jpeg.js` | Valid-JPEG/script polyglot for magic-byte/MIME upload filters (see `upload-bypass/README.md`) |

## Dated disclosures

Every file written or refreshed after 2026-10-21 carries a dated disclosures table (heading varies:
`Disclosures 2026 (dated)`, `2026 disclosures`, `2026: <surface> disclosures`): one row per technique
with CVE/advisory id, `YYYY-MM`, affected product+version, and the probe. That table is the
provenance record — a technique without an id and a date is not in the corpus — and the narrative
sections above it carry the method, not a second copy of the ids. The batch summary
lives in `tools/test-registry.json` → `_meta.standards.note_2026-10-21`.

## Rules of use

1. **In scope only** — `node tools/scope-guard.js check <url>` first (exit 0 = allowed).
2. **Detect before exploit.** Confirm reflection / error / timing with the smallest marker first;
   only escalate to a real payload with explicit user confirmation.
3. **Substitute `MARKER`** with a unique token per run (e.g. `stavros-a1b2c3`) so you can attribute
   the response back to YOUR request and avoid tripping WAF dedupe.
4. **Time-based payloads** — cap the sleep (≤ 7s) and honor `max_requests_per_second`.
5. **Deserialization / RCE payloads** are for *detection* and *proof-of-concept* only. Actual
   RCE payloads require explicit per-action approval (knowledge.md rule 2).
