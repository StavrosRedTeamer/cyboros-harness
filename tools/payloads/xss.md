# Client-side XSS, CSP and postMessage bypasses (detection-only reference)

> **Detection-only.** Every probe below uses a BENIGN MARKER (`stavros-<hex>`) so a hit is
> attributable to your own request; do not ship a live malicious host or a weaponised payload.
> `node tools/scope-guard.js check <url>` first (exit 0 = allowed). Escalation past a marker —
> a real session, a real victim, a live exfil sink — needs explicit in-session approval.

## 1. Fingerprint the rendering stack

```
node tools/analyze-bundle.js <url>        # framework, sinks, client-side routes, CSP meta
node tools/dom-check.js <url>             # DOM-XSS: sources/sinks observed over CDP
```

Look for the framework version (Angular, React, Vue, Marko, Handlebars, DOMPurify, a WYSIWYG
editor) and for `innerHTML`/`insertAdjacentHTML`/`eval` sinks fed by `location.*`,
`postMessage`, `document.referrer` or stored fields. Version is half the PoC: several 2026
findings are sanitizer bypasses fixed in a named patch release.

## 2. Probe the sinks (reflection vs execution)

```
node tools/repeater.js --url "https://target/search?q=stavros-MARKER" --show-body
node tools/dom-check.js "https://target/#stavros-MARKER"
```

- Marker escaped ⇒ **no XSS** — record nothing. Marker raw in an attribute or `<script>` ⇒
  candidate, `triggered` only once a browser executes it (a marker that sets `document.title`
  is enough).
- Marker reaching a client-side sink without a server round-trip (hash, `postMessage`,
  storage) ⇒ DOM-XSS: prove execution in `dom-check.js`, not by reading source. A
  `javascript:` string in the body proves nothing.

## 3. mXSS and sanitizer-output reparse

A sanitizer that is correct for the context it tested can be wrong for the context the app
reinserts the output into (e.g. DOMPurify `<3.3.2`, Jodit `<4.12.28` with MathML/raw-text
nesting). The check is reparse, not payload:

1. Take the sanitized output the app stores (a comment, a profile field, an editor document).
2. Reinsert it into every wrapper context the UI uses (table, `<noscript>`, SVG, MathML,
   `<style>` sibling) and re-serialize.
3. If an `on*` attribute or a `<script>` node reappears after the second parse, the sanitizer
   output is not context-free ⇒ `triggered`; execution in the browser ⇒ `exploited` per the
   severity ceiling in `knowledge.md`.

Editor and markdown pipelines are the highest-yield surface for this class: clean-HTML
endpoints, "preview" endpoints and paste handlers.

## 4. postMessage and JSONP origin checks

Review every listener in the bundle for `addEventListener('message', …)`:

- `event.origin` compared with `includes()`/`startsWith()`/a substring ⇒ bypassable by
  `https://target.example.evil.tld` or `https://evil-target.example` (`CVE-2026-26861/26862`,
  locize `<4.0.21`, TripleLift `video-bundle.js`).
- No `event.origin` check at all, or a handler that writes `event.data` into DOM/attributes
  ⇒ cross-origin DOM XSS.

Benign probe: from an unrelated origin's console, `postMessage` a marker object to the page and
read the DOM; a marker that lands is the finding. JSONP: send `?callback=stavrosMARKER` and
check identifier validation (`CVE-2026-42548`).

## 5. Service-worker request rewriting

A service worker rebuilds every matched fetch. Check that `credentials: 'omit'`,
`redirect: 'error'`, `cache: 'no-store'` survive the rebuild and that `Authorization` /
`Cookie` / `Proxy-Authorization` are stripped on a cross-origin redirect (Angular
`CVE-2026-50169`, `CVE-2026-50184`, `CVE-2026-54264`). DevTools → Application → Service
Workers, replay the fetch, inspect the outgoing request; a surviving header is `triggered`
(credential leak), not an XSS.

## 6. Disclosures 2026 (dated)

| Technique | CVE / advisory | Date | Affected | Probe |
|---|---|---|---|---|
| SVG `<script>` URL binding bypasses sanitization | CVE-2026-22610 | 2026-01 | Angular `@angular/compiler`/`core` ≤18.2.14; 19.0.0-next.0–<19.2.18; 20.0.0-next.0–<20.3.16; 21.0.0-next.0–<21.0.7; 21.1.0-next.0–<21.1.0-rc.0 | review dynamic `href`/`xlink:href` on SVG `<script>`; marker round-trip |
| XSS through translated ICU messages | CVE-2026-27970 | 2026-02 | Angular core ≤18.2.14; 19.0.0-next.0–<19.2.19; 20.0.0-next.0–<20.3.17; 21.0.0-next.0–≤21.1.5; 21.2.0-next.0–≤21.2.0-rc.0 | translated-string field rendered as markup |
| i18n-marked security-sensitive bindings | CVE-2026-32635 | 2026-03 | Angular `@angular/compiler`/`core` 17.0.0-next.0–≤18.2.14; 19.0.0-next.0–<19.2.20; 20.0.0-next.0–<20.3.18; 21.0.0-next.0–<21.2.4; 22.0.0-next.0–<22.0.0-next.3 | grep templates for `i18n-href`/`i18n-src`/`i18n-action` |
| Translated event-handler attributes | CVE-2026-69151 | 2026-07 | Angular ≤19.2.25; 20.0.0-next.0–<20.3.27; 21.0.0-next.0–<21.2.19; 22.0.0-next.0–<22.0.1 | `i18n-on*` on static `onerror`/`onclick` |
| Mixed-case closing-tag breakout in `<script>`/`<style>` | CVE-2026-41591 | 2026-04 | Marko `<5.38.36`, `@marko/runtime-tags` `<6.0.164` | interpolate marker inside script/style, vary tag case |
| mXSS on sanitizer output reparsed in another wrapper | CVE-2026-65914 | 2026-03 | DOMPurify `<3.3.2` | sanitize → reinsert per app context → reserialize |
| MathML/raw-text carrier hides handler from cleaner | CVE-2026-58263 | 2026-06 | Jodit `<4.12.28` | editor clean-HTML path, inspect serialized `on*` |
| Stored DOM XSS via milestone selection | CVE-2026-26276 | 2026-03 | Gogs `<=0.13.3` (fix 0.14.2) | milestone name → New Issue dropdown render |
| Follow-up stored DOM XSS after the first fix | CVE-2026-52807 | 2026-06 | Gogs `<0.14.3` | same path, reparse check |
| Stored DOM XSS in selected-count IDs | CVE-2026-61807 | 2026-06 | Snipe-IT `<=8.6.1` | manufacturer/supplier name → `data-selected-count-id` |
| Browser CSP enforcement bypass | CVE-2026-17674 | 2026-07 | Chrome `<151.0.7922.72` | crafted HTML vs deployed CSP, fixed-build diff |
| Stored XSS via trigger/webhook nodes | CVE-2026-27578 / GHSA-2p9h-rqjw-gm92 | 2026-02 | n8n `<1.123.22`, 2.0.0–`<2.9.3`, 2.10.0–`<2.10.1` | node response rendered as HTML by the consumer of the trigger |
| Trusted Types policy state survives `clearConfig()` | CVE-2026-65899 / GHSA-vxr8-fq34-vvx9 | 2026-06 | DOMPurify `<3.4.9` | `RETURN_TRUSTED_TYPE` output after a config reset; not a browser TT bypass |
| Go `html/template` escaping/context tracking | CVE-2026-32289 | 2026-04 | Go `<1.25.9`, 1.26.0-0–`<1.26.2` | template rendered with attacker-influenced context → XSS, not SSTI |
| postMessage origin check via substring | CVE-2026-26861 | 2026-02 | CleverTap Web SDK `<1.15.3` | crafted subdomain origin passes `includes()` |
| Missing `event.origin` validation, cross-origin DOM XSS | CVE-2026-41886 | 2026-04 | locize client SDK `<4.0.21` | foreign-origin postMessage writes DOM |
| Unvalidated JSONP callback | CVE-2026-42548 | 2026-04 | Flight PHP `<3.18.1` | `?callback=stavrosMARKER` |
| SW drops `credentials: 'omit'` on rebuilt request | CVE-2026-50184 | 2026-05 | `@angular/service-worker` ≤18.2.14; 19.0.0-next.0–<19.2.23; 20.0.0-next.0–<20.3.22; 21.0.0-next.0–<21.2.15; 22.0.0-next.0–<22.0.0-rc.2 | DevTools outgoing request after interception |
| SW forwards auth headers across cross-origin redirect | CVE-2026-54264 | 2026-06 | `@angular/service-worker` ≤19.2.25; 20.0.0-next.0–<20.3.25; 21.0.0-next.0–<21.2.17; 22.0.0-next.0–<22.0.1 | header survival on redirect |
| Query-string prototype pollution → Vue DOM XSS | CVE-2026-113659 | 2026-10 | ApostropheCMS `<4.33.0` | `__proto__[pp_probe]=marker` on admin page |

## 7. Record

```
node tools/record-finding.js '{"severity":"Medium","title":"Reflected XSS in /search q","host":"HOST","endpoint":"GET /search?q=","class":"xss","cwe":"CWE-79","verify_level":"triggered","poc":"marker executed: document.title set from q"}'
```

Severity follows `verify_level`: raw reflection = `suspected` (Low), executed script in your own
browser = `triggered` (Medium/High), script running in another user's session or a stored payload
served to a different principal = `exploited`/`proven_impact`. Never claim `exploited` from a
reflection alone.
