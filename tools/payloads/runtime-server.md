# Server runtime patch level — PHP engine and friends (detection reference)

> Class `config` (patch management), deliberately **not** `deser`. There is no payload here: the
> finding is a version, and every public trigger for the 2026 PHP bugs is an availability-destroying
> request. Record `suspected` from the version; nothing stronger without the operator's build proof.

The engine under the app is part of the attack surface, and a core CVE does not care how clean the
application code is: PHP parses the request body before a single line of the app runs. This file
exists so a patch-level finding has a home that is neither `deser` (wrong root cause) nor `supply-chain`
(that is dependencies).

## 1. Fingerprint the runtime

```
node tools/run.js httpx-toolkit -u <url> -tech-detect -status-code -json
```

- `tech: ["PHP"]` plus a `X-Powered-By: PHP/<version>` header is the easy case; many setups strip it.
- A `Server:` header naming Apache/nginx/LiteSpeed/Caddy tells you *which SAPI* matters: mod_php is
  the highest-risk deployment for PHP2Shell, PHP-FPM/php-cgi/FrankenPHP/LiteSpeed are also in scope.
- Error pages, `/.well-known/`, a `composer.lock` left in the docroot, and a `phpinfo()` page all
  leak the runtime version — read them for the version, do not upload anything.
- A reverse proxy can hide the real runtime: a PHP version in a header is evidence about *something*
  in the chain, not proof about the origin.

## 2. Decide applicability — fail closed

Fixed upstream versions for the 2026 pair: **8.5.12, 8.4.27, 8.3.36, 8.2.35**. Source backports were
published for **7.4, 8.0, 8.1**; **5.4–8.1** get no upstream support. Hard rules:

- version **below** a fix in the same branch ⇒ candidate (`suspected`), because a distro backport can
  keep the old upstream number and still be patched — check the vendor advisory (RHSA/USN/GLSA) or the
  installed package, not the banner;
- version **at or above** the fix for its branch ⇒ patched, do not report;
- unknown version and a PHP fingerprint ⇒ report the *gap* ("runtime version not exposed, patch level
  unverified"), never a CVE.

## 3. What not to send

- **No exploit, no OOM trigger, no `multipart/form-data` body built to fail.** Both 2026 paths need a
  request that drives PHP into an out-of-memory or fatal error; that is a destructive/availability
  action (rule 2) and needs explicit per-action confirmation — detection never does.
- **Do not read the disclosure path.** CVE-2026-109618 can return another request's worker memory
  inside a response cookie (passwords, session tokens, API keys, TLS keys). That is other users' data:
  out of scope for detection, and a reason to stop and report the version instead.
- A normal, small multipart upload to an endpoint that already accepts one proves only that PHP parses
  multipart bodies. It is not evidence about either CVE; do not write it up as such.

## 4. Disclosures 2026 (dated)

| Bug shape | CVE / advisory | Date | Affected | Probe |
|---|---|---|---|---|
| PHP2Shell — OOM corruption: out-of-memory handling interrupts a request with internal data only partially initialized, cleanup treats it as valid | CVE-2026-109618 / GHSA-w8hw-w9fx-j79w | 2026-10 | PHP ≥5.4 serving web requests (mod_php, PHP-FPM, php-cgi, FrankenPHP, LiteSpeed); fix 8.5.12 / 8.4.27 / 8.3.36 / 8.2.35 | version gate only; the trigger is a multipart body built to exhaust memory — confirm-tier at best |
| PHP2Shell — stale global state: request-owned state survives the free of its backing memory and a later request on the same worker reuses it (UAF, OPcache type confusion) | CVE-2026-109619 / GHSA-6wmf-4rv5-p3rp | 2026-10 | same branches and fixes; the `session.upload_progress` path is the confirmed one | version gate only; no probe |
| Unpatched runtime with no version exposure | (no CVE — reporting gap) | — | any PHP stack | record the missing-inventory gap as `info`, not as a vulnerability |

Disclosure timeline for the record: reported to PHP on 2026-08-11 (Calif, plus Wiz Research on
2026-08-24), details leaked 2026-10-20, release and public writeups 2026-10-21, exploitation observed
by Cloudflare at 07:43 UTC that morning — before the fix shipped.

## 5. Mitigations to report, never to apply

php.net's own interim guidance, for the report's remediation section:

- `memory_limit=-1` set where the application cannot override it (`php_admin_value` in the FPM pool or
  Apache config), so the controllable OOM path is removed;
- low `post_max_size` (8M without uploads, 32M with) and `upload_max_filesize` below it;
- decoded-size / multipart-part-count / header-count / nesting limits at the web server or proxy,
  including requests without a usable `Content-Length`;
- `session.upload_progress.enabled=0` and, on 8.5, `fatal_error_backtraces=0`, applied before request
  parsing (`php.ini`, pool or server config — not `ini_set()`);
- a container/cgroup boundary that kills one worker, not `RLIMIT_AS`/`RLIMIT_DATA`;
- the actual fix: update PHP or the distribution package; PHP 8.1 and older need a vendor backport.
  Note that rpms.remirepo.net shipped no update on release day.

## 6. Record

```
node tools/record-finding.js '{"severity":"Low","title":"PHP runtime below the PHP2Shell fix level (CVE-2026-109618/109619)","host":"HOST","endpoint":"-","class":"config","cwe":"CWE-16","verify_level":"suspected","status":"inconclusive","poc":"<X-Powered-By / vendor package version + the fixed version for that branch>"}'
```

`class: "config"` (patch management) with `cwe: "CWE-16"`; use `CWE-1104` instead if you file it as
component hygiene. Version match alone is `suspected` — `exploited` would require running the trigger,
which this file forbids. The record gate caps severity by verification level (suspected ⇒ Low max), so
the version gate is filed at **Low** with the CVE's 9.2 CVSS and the patch level in the PoC text; raise it
only if an oracle proves the impact. If the app is a dependency-scan target rather than a live host, the same rows
belong to `supply-chain`; do not double-count both.
