# HTTP Request Smuggling / HTTP/2 desync (detection-only)

Targets: any app sitting **behind a front-end/proxy/load-balancer/CDN** (the backend does
the TLS termination or the front-end parses the request differently). Class `smuggling`,
CWE-444 (HTTP Response Splitting/Smuggling). Use the dedicated tool
`node tools/desync.js <url>` for the CL.TE / TE.CL / TE.TE probes; this file explains when
to run it and how to read the result.

> **Scope & safety.** `desync.js` is scope-gated and DNS-rebinding-safe (net.js pinning),
> just like every other network tool. It only measures whether YOUR OWN single connection
> desyncs — it never injects a second user's traffic and never delivers a malicious
> smuggled request to a victim. Detection-only: never use desync to strip a WAF for other
> clients.
>
> **Detection-only.** The 2026 rows below are version-gated hypotheses until the differential
> reproduces on a staging pair; nothing here is fired at a production cache without approval.

## When to test it

- Any `HTTP/1.1 on 443` fronted by Nginx/Apache + upstream app server or cloud LB.
- If `Server:` differs between a direct hit and a proxied path (front-end vs back-end).
- High-security targets (banking, cloud-vulnerable) per OWASP Top 10 2025 A06
  (vulnerable components) + WSTG-INPV-15.

## Probes (via desync.js)

```bash
node tools/desync.js https://target.com            # all probes, full report
node tools/desync.js https://target.com --probe cl.te
node tools/desync.js https://target.com --probe te.cl
```

### What each probe means
- **CL.TE** — front-end trusts `Content-Length`, back-end trusts `Transfer-Encoding`.
  A `CL` body that contains a `0\r\n\r\n` chunk terminator can make the back-end treat the
  remainder as a NEW request (the smuggled bytes). On our own socket we observe a follow-up
  request either failing (400/abort) or — if the backend parses our smuggled bytes — the
  connection behaving differently than baseline.
- **TE.CL** — reverse. Obfuscated `Transfer-Encoding` variants (e.g. `Transfer-Encoding:
  chunked ` with trailing space, or a second TE header) can hide from the front-end while
  the back-end honors `Content-Length`.
- **TE.TE** — back-end parses a TE syntax the front-end rejects (e.g. `chunked;foo=bar`).

## Reading the result (honest assessment)

`desync.js` returns `likely: true|false` and a `confidence` per probe plus a follow-up
observable. Treat it as **`suspected` → `triggered`** only:

- `likely:true` + a reproducible follow-up error/reflection on a SECOND independent run
  (run it 3x; desync is flaky by nature) ⇒ verify_level `triggered`, severity up to **High**
  only with a real impact shown — a desync alone is Medium.
- A desync that you can chain to **bypass a WAF / poison a cache** is a critical finding,
  but PROVING impact on a live target is confirm-tier: do not attempt on a production
  target without explicit operator approval. Detection stays benign.
- If the probe is flaky or times out randomly on baseline too, mark it `suspected`/Low and
  note the ambiguity — do not force it.

## Reporting

```bash
node tools/record-finding.js '{"severity":"Medium","title":"HTTP Request Smuggling (TE.CL)","host":"HOST","endpoint":"/","class":"smuggling","cwe":"CWE-444","cvss":6.5,"cvss_vector":"AV:N/AC:H/PR:N/UI:N/S:U/C:L/I:H/A:N","verify_level":"triggered","poc":"<desync.js JSON + follow-up observable>","remediation":"Set all proxies/load-balancers and back-ends to the SAME request-parsing (drop TE-only requests or CL when TE present), reject obfuscated Transfer-Encoding, upgrade to HTTP/2-aware front-ends (fixes most CL.TE/TE.CL), and disable HTTP/1.1 downgrade where the LB is HTTP/2."}'
```

No `verify` block can re-fire a desync reliably (it needs the exact socket sequence), so
attach the tool's raw JSON output as evidence instead.

## 2026: parser-differential disclosures

The classic CL.TE/TE.CL/TE.TE pair is no longer where most of these bugs are found. The 2026
wave is **one component disagreeing with itself** (or with its own downgrade path): a case-
sensitive TE value, a chunk-extension grammar, an HTTP/1.0 framing rule, an H2→H1 rewrite.
`desync.js` only covers the first three rows of the table below — everything else needs a
raw-socket test against a staging front-end/backend pair, never a live production pair.

| Differential | CVE / advisory | Date | Affected | Cheapest check |
|---|---|---|---|---|
| Case-sensitive TE value (TE.TE) | CVE-2026-23527 / GHSA-mp2g-9vg9-f4cg | 2026-01 | h3 ≤1.15.4 (fix 1.15.5) | send `Transfer-Encoding: Chunked` through the proxy; compare h3's framing with the front end's |
| Premature `Upgrade` forwarding | CVE-2026-2833 / GHSA-xq2h-p299-vjwv | 2026-03 | Pingora ≤0.7.0 (fix 0.8.0) | bytes after an `Upgrade` request are forwarded before the backend answers `101` |
| HTTP/1.0 + TE framing | CVE-2026-2835 / GHSA-hj7x-879w-vrp7 | 2026-03 | Pingora ≤0.7.0 (fix 0.8.0) | HTTP/1.0 request with TE / multiple transfer-codings; compare close-delimited framing |
| Invalid chunk extensions | CVE-2026-24880 / GHSA-563x-q5rq-57qp | 2026-04 | Tomcat 7.0.0–7.0.109, 8.5.0–8.5.100, 9.0.0.M1–9.0.115, 10.1.0-M1–<10.1.52, 11.0.0-M1–11.0.18 | proxy and Tomcat disagree on the chunk boundary |
| H3→H1 body-length mismatch | CVE-2026-33555 / GHSA-5mp8-rq5m-pj7m | 2026-04 | HAProxy 2.6–<3.3.6 with HTTP/3 | a closed empty-payload QUIC stream is forwarded with a length it did not announce |
| Absolute-form request target | CVE-2026-34475 / VSV00018 | 2026-03 | Varnish Cache ≤8.0.0, 6.0.16; Enterprise ≤6.0.16r11 | `GET http://host/ HTTP/1.1` against VCL that forwards `req.url` unchecked |
| H2→H1 `Transfer-Encoding` forwarding | CVE-2026-58150 / GHSA-5cvm-p8jm-mcrf | 2026-07 | ATS 8.0.0–8.1.9, 9.0.0–9.2.14, 10.0.0–10.1.3 | TE in an HTTP/2 request is downgraded instead of rejected |
| H2 parsing → backend desync + cache poison | CVE-2026-50052 / VSV00019 | 2026-05 | Varnish ≤9.0.2, 7.6.0–8.0.1, 6.0.14–6.0.17 with `+http2` | compare the H2 front-end view with the H1 backend framing |
| Duplicate/multi-valued TE + bare-LF | CVE-2026-63382 / GHSA-q39v-w2g7-gr8j | 2026-07 | libevent `evhttp` ≤2.1.12, 2.2.1-alpha | duplicate and comma-separated TE values, bare-LF chunk delimiters |
| Response desync / inline header injection | no confirmed CVE — PortSwigger research (ATS finding, id unverified) | 2026-08 | Apache Traffic Server | two responses or inline headers on one connection after a method/body edge case |
| CRLF-powered desync | no CVE — PortSwigger research | 2026-08 | among the paper's examples: nginx configs normalizing `$uri` into `proxy_pass` | encoded CRLF is re-emitted as upstream request syntax; watch response boundaries and queues |
| Protocol ruler / shared-parser confusion | no CVE — PortSwigger research | 2026-08 | black-box method, no product | use backend parsing limits as a length ruler to find bytes the front end transforms |

Two consequences for reporting: (a) a component-version match is not a finding — it is a lead,
recorded `suspected` until the differential reproduces 3× on a staging pair; (b) the response-
queue variants can poison a cache, which is `triggered` at best without a second-principal read.
The 2026 "range cache poisoning" idea is explicitly *proposed, not demonstrated* in the source —
do not report it as a technique that works.