# SSRF (detection-only reference)

Targets: any parameter the **server** fetches (image/PDF renderers, import-by-URL, webhooks, link
previews, error pages). Class `ssrf`, CWE-918, OWASP API7.

> **Detection-only.** Cloud metadata (`169.254.169.254`, `metadata.google.internal`, `100.100.100.200`)
> is reachable ONLY when `scope.json`'s `allowed_ips` lists that address/CIDR — the guard refuses it
> otherwise, and that refusal is the answer, not a puzzle to work around. When allowed, read the
> smallest proof: the **role NAME** from the metadata document, never a credential. Blind tests use a
> unique OOB marker; no internal port scans, no service exploitation through the SSRF.

## 1. Find URL-fetching parameters

`node tools/scope-guard.js check <url>` (exit 0) before the first request. Then look for values that
are URLs or hostnames: `url=`, `image=`, `src=`, `callback=`, `webhook=`, `feed=`, `avatar=`,
`redirect=`, `next=`, `file=`, `import=`, `preview=`. Framework giveaways: `/_next/image?url=`,
`/cdn-cgi/image/`, `?format=pdf`, HTML-to-PDF endpoints, "import from URL" forms.

```
node tools/analyze-bundle.js <url>        # endpoints + query params + absolute URLs in the bundle
```

## 2. Reflected SSRF

Point the parameter at an in-scope second host you control or at a path on the target itself:

```
node tools/repeater.js --url "https://target/fetch?url=https://canary.in-scope/" --follow --show-body
```

A body/`--diff` difference between two canary paths proves the server fetched them. Same body for a
non-existent path proves nothing — the renderer may be cached, stubbed or blocked.

## 3. Blind SSRF

```
node tools/oob.js listen                       # daemon; state in reports/tmp/oob.json
node tools/oob.js marker                       # unique token for THIS run
node tools/repeater.js --url "https://target/webhook?u=http://<oob-host>/<marker>"
node tools/oob.js hits --tail 20               # the target's fetch is the proof
```

One hit from the target's egress IP = `triggered`. No hit = inconclusive, not "not vulnerable":
egress filtering, DNS-only resolution and allow-lists all look identical from outside.

## 4. 2026 SSRF paths

Five shapes recur in the 2026 rows below; each is a *second* resolver or a *trusted* hostname, not a
missing URL check:

- a framework fetch helper whose allow-list (`remotePatterns`, `rewrites()` destinations) is
trusted as if it were an egress filter — an allow-listed hostname you control DNS for is enough;
- a Host-derived fetch (prerendered error pages) — compare a missing path's body with and without
  `--header "Host: <canary>"`;
- a raw request-target the edge normalizes differently from the app (backslash paths) — send it with
  `repeater.js`, never a browser;
- an exposed model/tool API that fetches a caller-supplied URL (vision APIs, MCP HTTP fetchers);
- a validator that resolves once and connects again (DNS rebinding), or that filters IPv4 only
  (`::ffff:127.0.0.1`).

For every one of them the payload is an OOB-marked URL on a canary **you own**; the hit is the
proof, and a blocked probe proves nothing about a production allow-list.

## 5. Disclosures 2026 (dated)

| Technique | CVE / advisory | Date | Affected | Probe |
|---|---|---|---|---|
| Image-optimizer SSRF via allow-listed host | CVE-2026-94483 | 2026-09 | Next.js `>=16.0.0 <16.3.8` | `/_next/image?url=` + DNS-controlled allow-listed host |
| Rewrite/redirect host interpolation | CVE-2026-64645 | 2026-07 | Next.js `>=12.0.0 <15.5.21`, `>=16.0.0 <16.2.11` | canary host in the parameter behind the rule |
| Prerendered error-page Host fetch | CVE-2026-25545 | 2026-02 | `@astrojs/node <9.5.4` (SSR + custom error page) | 404 with `Host: <canary>` |
| Backslash path to Worker/`/cdn-cgi/` | CVE-2026-3125 | 2026-03 | `@opennextjs/cloudflare <1.17.1` | raw `\` path via repeater |
| Vision API image fetch | CVE-2026-33626 | 2026-04 | LMDeploy `<=0.12.2` | OOB-marked image URL |
| DNS rebinding in gateway URL validation | CVE-2026-53708 | 2026-06 | `mcp-contextforge-gateway <1.0.3` | owned domain resolving twice |
| IPv4-mapped IPv6 loopback bypass | CVE-2026-49857 | 2026-05 | `auth-fetch-mcp <=3.0.1` | `http://[::ffff:127.0.0.1]/<canary>` |

## 6. Record

`class: "ssrf"`, `cwe: CWE-918`. Severity follows what was reached: a reflected canary on a public
host is `triggered`/Medium; a metadata role name or an internal service response is `exploited`;
reading credentials is out of scope for detection. Attach the request/response or the OOB hit line
as `poc` — an OOB marker without a hit is `suspected`.

```
node tools/record-finding.js '{"severity":"Medium","title":"Blind SSRF via webhook parameter","host":"HOST","endpoint":"POST /webhook","class":"ssrf","cwe":"CWE-918","verify_level":"triggered","poc":"<reports/tmp/oob hits line + request>"}'
```
