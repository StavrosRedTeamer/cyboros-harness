# Middleware and path-normalization authorization bypass (detection-only)

> **Detection-only.** Every probe here is a GET to a path you are already authorized to test; the
> point is to see whether the *protected* handler answers. `node tools/scope-guard.js check <url>`
> first (exit 0). Never brute-force a variant list at full rate, and never use a bypass to read
> real user data — one canary response (a page title, a marker) is the proof.

## 1. The shape

An authorization decision is made by a layer that parses the request path **differently** from the
layer that serves it: middleware vs router, proxy vs app, CDN rule vs origin. The check sees
`/public/...`; the handler resolves `/admin/...`. It is not a missing check — it is a check applied
to a different string.

Four families, all worth one pass each:

1. **Case** — `/Admin`, `/aDmIn`.
2. **Separators** — `//admin`, `/admin/`, `/admin;.css`, `/admin;foo=bar`, `/admin%2f..`.
3. **Dot segments / encoding** — `/./admin`, `/admin/../admin`, `/%2e%2e/admin`, double-encoded
   `%252f`, over-decoded paths (some routers stop after N iterations).
4. **Prefix / base confusion** — a base of `/app` stripped without a segment boundary, so
   `/appX/admin` becomes `/admin`; locale/prefix routes (`/en/admin`) that skip middleware.

Transport-level variants belong to the same family and are usually missed: **absolute-form**
request target (`GET http://host/admin HTTP/1.1`), backslashes (`/admin\..\public`), a malformed
`Host` port (`Host: target:80@evil`), and an H2 `:path` without a leading slash.

## 2. Probe recipe

Baseline first, unauthenticated, on the exact protected path (add `--as <low-priv-identity>` only
when `auth.json` has one and the role boundary is what you are testing):

```
node tools/repeater.js --url https://TARGET/admin --show-body
```

Expect 401/403/302-to-login. Then walk the variants one at a time and compare **status, body
length and body similarity** against that baseline:

```
node tools/repeater.js --url "https://TARGET/Admin" --show-body
node tools/repeater.js --url "https://TARGET//admin" --show-body
node tools/repeater.js --url "https://TARGET/./admin" --show-body
node tools/repeater.js --url "https://TARGET/admin/..;/admin" --show-body
node tools/repeater.js --url "https://TARGET/appX/admin" --show-body
```

Add `--diff` against a saved baseline body when the lengths are close (same-length different-
content is the interesting case). Do **not** automate a 500-variant spray; the families above are
the ones with real 2026 disclosures behind them.

## 3. Reading the result

| Observation | Meaning |
|---|---|
| Variant returns the protected page/content where baseline is 401/403 | bypass — `triggered` |
| Variant returns 200 but the login page or a generic shell | route matched, handler still gated — not a finding |
| Variant 404 while baseline 403 | the protected route was never reached — not a finding |
| Different `Location` on the redirect | the check and the handler disagree about the path — a lead, reproduce with a canary |
| Same status, different body (`--diff` < 1.0) | possible partial bypass (metadata, error detail) — record `suspected` |

A bypass is proven by **content**, not by status: a page title, a canary record, an admin-only
string. If you cannot name what you read, you have a lead.

## 4. Disclosures 2026 (dated)

| Framework / layer | CVE / advisory | Date | Affected | Variant to try |
|---|---|---|---|---|
| Next.js i18n data route skips middleware | CVE-2026-44573 / GHSA-36qx-fr4f-26g5 | 2026-05 | Next.js 12.2.0–<15.5.16, 16.0.0–<16.2.5 (Pages Router + i18n) | `/_next/data/<buildId>/<page>.json` unauthenticated |
| Next.js dynamic-route parameter injection | CVE-2026-44574 / GHSA-492v-c6pp-mqqv | 2026-05 | Next.js 15.4.0–<15.5.16, 16.0.0–<16.2.5 | encoded route-parameter forms of a protected dynamic route |
| Next.js RSC segment prefetch | CVE-2026-44575 / GHSA-267c-6grr-h53f | 2026-05 | Next.js 15.2.0–<15.5.16, 16.0.0–<16.2.5 | `.rsc` and segment-prefetch URL variants |
| Next.js Turbopack + single locale | CVE-2026-64642 / GHSA-6gpp-xcg3-4w24 | 2026-07 | Next.js App Router + Turbopack + one locale; fixed 15.5.21 / 16.2.11 (range not stated) | protected route and its locale variant |
| Astro internal path override | CVE-2026-33768 / GHSA-mr6q-rp88-fx84 | 2026-03 | `@astrojs/vercel` <10.0.2 | `x-astro-path` / `x_astro_path` on a public path |
| Astro rewrite vs middleware after deep decode | CVE-2026-59731 / GHSA-vj59-8hwv-xxmv | 2026-07 | Astro 6.4.7 (fix 6.4.8) | path encoded past the decoder's 10-iteration limit |
| Astro base prefix without segment boundary | CVE-2026-84376 / GHSA-376h-93r7-7g6f | 2026-08 | Astro ≤7.2.3 (fix 7.2.4) | base `/app` + `/appX/admin` |
| Nuxt routeRules case mismatch | CVE-2026-53721 / GHSA-mm7m-92g8-7m47 · CVE-2026-71315 / GHSA-hxvh-4h3w-prp9 | 2026-06 / 2026-07 | Nuxt 3.11.0–<3.21.7, 4.0.0–<4.4.7 · 3.21.7–<3.21.10, 4.4.7–<4.5.1 | vary case on a route guarded by `routeRules.appMiddleware` |
| Fastify/Nest path canonicalization | CVE-2026-2293 / GHSA-r4wm-x892-vjmx | 2026-02 | `@nestjs/platform-fastify` ≤11.1.13 | `//route`, `/route;x`, trailing slash with the router options enabled |
| middie path-scoped guard skipped | CVE-2026-2880 / GHSA-8p85-9qpw-fwgw | 2026-02 | `@fastify/middie` <9.2.0 | `/secret` vs `//secret`, `/secret;foo=bar` |
| Express middleware in child scope / URL-normalization gap | CVE-2026-33807 / GHSA-hrwm-hgmj-7p9c · CVE-2026-33808 / GHSA-6hw5-45gm-fj88 | 2026-04 | `@fastify/express` ≤4.0.4 | parent/child prefixes, duplicate slashes, semicolons |
| Spring Boot actuator health-group path overlap | CVE-2026-22731 / GHSA-8hfc-fq58-r658 | 2026-03 | Spring Boot 3.4.0–<3.4.15, 3.5.0–<3.5.12, 4.0.0-M1–<4.0.4 | app endpoint declared under a health-group path |
| Spring Boot Cloud Foundry actuator path | CVE-2026-22733 / GHSA-mgvc-8q2h-5pgc | 2026-03 | Spring Boot ≤2.7.31, 3.0.0–3.3.17, 3.4.0–<3.4.15, 3.5.0–<3.5.12, 4.0.0-M1–<4.0.4 | endpoint declared under the CF actuator path |
| Spring Security XML `servlet-path` | CVE-2026-22754 / GHSA-4vrc-j85c-598c | 2026-04 | Spring Security 7.0.0–7.0.4 | the protected endpoint under that servlet path |
| Django admin forged POSTs | CVE-2026-4277 / GHSA-pwjp-ccjc-ghwg · CVE-2026-4292 / GHSA-mmwr-2jhp-mc7j | 2026-04 | Django 4.2.0–4.2.29, 5.2.0–5.2.12, 6.0.0–6.0.3 | forged inline-formset / `list_editable` POST as a low-priv admin user |
| Django editable-PK formset | CVE-2026-87975 | 2026-10 | Django 5.2 <5.2.18, 6.0 <6.0.9, 6.1 <6.1.2 | edit-only formset with a forged PK |
| DRF `AdminRenderer` leak on invalid write | CVE-2026-73229 / GHSA-g47c-3xmw-q6m2 | 2026-08 | DRF ≤3.17.1 (fix 3.17.2) | invalid POST to a POST-allowed/GET-denied view, read the 400 |
| Apache `mod_userdir` `/./` equivalence | CVE-2026-79768 | 2026-10 | Apache 2.4.0–2.4.68 (fix 2.4.69) | userdir resource via a `/./`-equivalent path |
| Traefik Host port / rootless target | CVE-2026-88877 / GHSA-9rch-gvf7-hrfc · CVE-2026-88009 / GHSA-f52w-8j3h-j724 | 2026-09 | 88877: Traefik 3.7.0–3.7.11 (fix 3.7.12) · 88009: v2 <2.11.57, v3 <3.7.13 | malformed/empty Host port; rootless request target |
| Gateway/agent Host auth | CVE-2026-49468 / GHSA-4xpc-pv4p-pm3w · CVE-2026-50194 / GHSA-58f6-6rj2-3v8r | 2026-05 | 49468: LiteLLM <1.84.0 · 50194: Steeltoe.Management.Endpoint ≤4.1.0, EndpointCore 3.2.2–3.3.0 | management route with a spoofed Host/Host:port |

## 5. Record

Record as `authz` (CWE-863; CWE-288 when the bypass is an alternate path/auth mechanism), with the
exact request that returned protected content and the baseline that did not. `verify_level:
triggered` when a marker page is reachable; `exploited` only if the content belongs to another
principal. A version match with no reproduced variant is `suspected` — and it is worth recording,
because the variant list above is what turns it into a test.
