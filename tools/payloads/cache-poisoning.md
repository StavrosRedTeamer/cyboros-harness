# Web cache poisoning / cache deception (detection-only reference)

Driven by `tools/cachepoison.js`. Targets any response served through a caching layer (CDN, reverse
proxy, Varnish, Cloudflare, Fastly, nginx proxy_cache). Two attack families:

- **Cache poisoning** — an *unkeyed* input (a header the cache forwards to origin but omits from the
  cache key) influences the response; the tainted response is then served from cache to other users.
- **Cache deception** — a dynamic/authenticated page is coerced into being cached publicly by making
  it *look* like a static asset, so an attacker can read another user's cached content.

> **Scope discipline.** `node tools/scope-guard.js check <url>` first (exit 0). Detection uses a
> BENIGN marker only. A **persistent** poisoning that would serve the tainted response to OTHER
> users is impactful → **confirm-tier** (`--confirm "<reason>"` + explicit approval). Never leave a
> cache poisoned; if you must prove persistence, use a self-scoped key you can evict, and record it.
>
> **Detection-only.** The 2026 cache-key rows are tested with cache-busted paths and benign markers;
> a poisoned shared object left in place is an incident, not evidence.

## 1. Find the cache

Look for response headers: `Age`, `X-Cache: HIT/MISS`, `CF-Cache-Status`, `X-Served-By`,
`X-Cache-Hits`, `Cache-Control: public / s-maxage`. `node tools/cachepoison.js probe <url>` reads all
of these for you.

## 2. Unkeyed-input poisoning (benign marker)

Send a benign marker via a header a cache commonly leaves unkeyed; if it reflects in the body AND
the response is cacheable, it is a poisoning candidate:

```
node tools/cachepoison.js probe https://target/path
```

Headers tested: `X-Forwarded-Host`, `X-Forwarded-Scheme`, `X-Forwarded-Proto`, `X-Forwarded-Port`,
`X-Forwarded-Server`, `X-Forwarded-Prefix`, `X-Host`, `X-Original-URL`, `X-Rewrite-URL`,
`X-Original-Host`, `X-HTTP-Host-Override`, `Forwarded`.

Classic impact: `X-Forwarded-Host: marker.example` reflected into an absolute `<script src>` /
`<link href>` / redirect ⇒ stored XSS or resource hijack for every cached viewer. Prove reflection
first with the marker, then reason about the sink — do NOT ship a live malicious host.

Also test **unkeyed query params** and **fat-GET** (body on a cached GET), and cache-key normalization
quirks (case, trailing `?`, duplicate params).

## 3. Cache deception

```
node tools/cachepoison.js deception https://target/account
```

Appends static-looking suffixes to a dynamic path (`/stavros.css`, `;.css`, `.json`, `%0Astavros.css`,
`/%2e%2e/stavros.css`) and flags any that return dynamic/authed content while becoming publicly
cacheable. Confirm by requesting the cached path unauthenticated in a second session (that is the PoC).

## 4. Verify + record

A candidate is a LEAD. Confirm the shared-cache hit with a second, uncredentialed request, then
`node tools/record-finding.js` with `verify_level: triggered` (reflected+cacheable) or `proven_impact`
(you read another principal's response from cache). `cwe`: CWE-524 (cache) / CWE-525; map to the
concrete impact (XSS → CWE-79, info-leak → CWE-200).

## 5. 2026: cache-key and cache-surface bugs

The unkeyed-header case above is the *classic* shape. The 2026 disclosures are mostly about the
**cache key itself** (what it omits or how it concatenates) and about **desync feeding the cache**,
which `cachepoison.js probe` cannot see — those need the key-collision checks below.

| Bug shape | CVE / advisory | Date | Affected | Check |
|---|---|---|---|---|
| Default key omits host | CVE-2026-2836 / GHSA-f93w-pcj3-rggc | 2026-03 | Pingora `pingora-cache` ≤0.7.0, alpha proxy-caching with the default key | request the same path with two different `Host`/`:authority` values; one response served for both = key collision |
| Absolute-form target | CVE-2026-34475 / VSV00018 | 2026-03 | Varnish Cache ≤8.0.0, 6.0.16 | root-path absolute-form request; compare routing and cached object |
| H2→H1 desync poisoning | CVE-2026-50052 / VSV00019 | 2026-05 | Varnish with `+http2`, ranges above | framing differential on a staging pair; then check the cached object for the smuggled prefix |
| H2 TE downgrade | CVE-2026-58150 / GHSA-5cvm-p8jm-mcrf | 2026-07 | ATS 8.0.0–8.1.9, 9.0.0–9.2.14, 10.0.0–10.1.3 | same differential, cache-busted path only |
| Cross-route cache substitution | CVE-2026-94543 / GHSA-4jqv-mc3x-m676 | 2026-09 | Next.js 15.0.0–<15.5.27, 16.0.0–<16.3.8, self-hosted Pages Router SSG/ISR | in staging, request route B and read route A; a marker written through one route appearing on the other is the proof |
| Root catch-all poisons shared cache | CVE-2026-94484 / GHSA-mcj8-r9mp-w47p | 2026-09 | Next.js same ranges, root-level catch-all + SSG/ISR | request a crafted path under the catch-all, then re-read a sibling page |
| Cache-key injection (ambiguous concatenation) | no CVE — YesWeHack research | 2026-09 | nginx custom keys concatenating attacker-controlled fragments | split a value across two adjacent key components; if the two distinct requests share one cached object, the key is ambiguous |
| Range response stored as full object | no CVE — proposed in research, not demonstrated | 2026-08 | unspecified | on a cache-busted resource, ask for a `Range`, then request the full object unauthenticated |

Only the first row is a plain key-collision test; the desync rows are confirm-tier on a live
cache and stay `suspected` until reproduced on staging. The last row is a hypothesis from a
research paper — do not report it as an observed behaviour.
