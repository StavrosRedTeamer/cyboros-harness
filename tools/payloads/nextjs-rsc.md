# Next.js / React Server Components — detection reference

> **Detection-only.** This file contains **no serialized RSC payload and no exploit**: the
> 2025 RSC deserialization flaw is proved by *version inventory*, not by firing a gadget at a
> production app. Escalation past the checks below needs explicit in-session approval.

The React Server Components (RSC) model moves data into a serialized stream and exposes
"Server Actions" as unlabeled HTTP endpoints (`Next-Action: <hash>`). That gives three
distinct surfaces to test — routing/authorization, the image optimizer, and the action
endpoint — plus a dependency surface you can only read, not probe.

## 0. Fingerprint before anything

```
node tools/run.js httpx-toolkit -u <url> -title -tech-detect -status-code -json
```

Look for `X-Powered-By: Next.js`, `__NEXT_DATA__`, `/_next/static/…`, and the framework
version in the build manifest or the `x-nextjs-*` / `Vary: RSC, Next-Router-State-Tree`
headers. A version is the whole PoC for CVE-2025-55182 / CVE-2025-66478 (see §4).

## 1. Middleware is not an authorization boundary (CVE-2025-29927, 2025-03)

Affected: `11.1.4–<12.3.5`, `13.0.0–<13.5.9`, `14.0.0–<14.2.25`, `15.0.0–<15.2.3`. Next.js
honored an externally supplied internal header. If the app protects routes
in middleware alone, request a **protected canary route** with the header set:

```
node tools/repeater.js --url <url><protected_path> \
  --header "x-middleware-subrequest: middleware:middleware:middleware:middleware:middleware"
```

Interpretation, in order:
- `200` where an anonymous request gets `307/401/403` → candidate bypass (`triggered`).
- Same status but different body/`--diff` similarity → still a candidate; compare bodies.
- Both blocked → the app either patched the header or does not use middleware for authz. Do
  **not** conclude "safe": test the route-level check separately with a second identity.

Repeat once with the header in mixed case and once with a duplicated header — proxies
normalize differently and the edge is where the bug lives.

## 2. Image optimizer (CVE-2025-55173 / CVE-2025-57752, 2025-08; `<14.2.31`, `15.0.0–15.4.4`)

The optimizer fetches remote images and caches the result. Two conditions matter:

```
node tools/repeater.js --url "<url>/_next/image?url=<approved_local_path>&w=64&q=75"
```

- **Content injection / download priming** (55173): an attacker-controlled external image
  response becomes content the site serves, or primes a `Content-Disposition` download. Confirm
  with a harmless local asset only — never a remote host you do not control. This is content
  injection, not SSRF: the advisory does not describe a server-side fetch of an internal host.
- **Cache-key confusion** (57752): images served under `Cookie`/`Authorization` can be cached
  and returned to another identity. Test with **two identities and two markers**:
  request as A, then as B, and check whether B's response contains A's marker. A cross-identity
  read is `exploited`; a cacheable personalized response without cross-read is `triggered`.

Check `images.remotePatterns` / `images.domains` scope before testing: an over-broad pattern is
a finding on its own (`config`, Low) even when no gadget is reachable.

## 3. Server Action enumeration (read-only)

Action hashes are in the client bundle: grep the build output for `Next-Action` and the
`createServerReference` calls, or inspect source maps if published. Then:

```
node tools/repeater.js --url <url> --method POST \
  --header "Next-Action: <hash>" --header "Content-Type: text/plain;charset=UTF-8" \
  --data "<benign-marker>"
```

What is being tested is **authorization**, not deserialization: does the action enforce the
same checks as the UI? A `200` with an unexpected state change from an unauthenticated or
low-privilege identity is a BOLA/BFLA finding (class `bola`/`bfla`), not `nextjs`. Do not send
crafted multi-part RSC streams to try to trigger code execution.

## 4. RSC deserialization (CVE-2025-55182 / Next.js CVE-2025-66478, 2025-12)

Affected: `react-server-dom-webpack`/`-parcel`/`-turbopack` 19.0.0, 19.1.0, 19.1.1, 19.2.0; Next.js
15.x, 16.x, and 14.3.0-canary.77+ using the App Router.

**Prove it from the SBOM, not the wire.** Check the lockfile / dependency inventory for
`react-server-dom-*` and the Next.js App Router version; React's advisory says apps that
support RSC can be affected even without an explicit Server Function endpoint.

- Affected dependency present + reachable App Router → `triggered` (config/supply-chain
  evidence), patch level unknown → `suspected`.
- Never send a serialized RSC body to a production target: the class is unauthenticated RCE
  and a malformed probe can crash the worker (availability impact outside the mandate).

## 5. Record

| Observation | Class | verify_level |
|---|---|---|
| protected route reachable via middleware header | `nextjs` (or `authz` if the impact is access control) | triggered → exploited after a second identity confirms data access |
| optimizer returns attacker content / cross-identity cache | `cache-poison` | triggered / exploited |
| action callable without the UI's authorization | `bola`/`bfla` | triggered |
| affected RSC dependency in the SBOM | `supply-chain` | suspected (triggered only with a version proof) |

`cwe`: CWE-285/CWE-862 (missing authorization), CWE-444 (desync-adjacent), CWE-502
(deserialization) for the dependency finding. The middleware bypass is **not** CWE-79: do not
file it as XSS because the response body changed.
