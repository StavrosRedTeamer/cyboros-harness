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
