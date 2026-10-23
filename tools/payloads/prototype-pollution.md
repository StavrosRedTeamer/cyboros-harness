# Prototype pollution (server + client)

Happens when user input is merged into an object without a key allowlist, letting an
attacker set `__proto__` / `constructor.prototype` and poison every object in the process
(or the page's JS context).

> **Detection-only.** Inert keys only (`MARKER`, `pp_probe`); never override `toString`/
> `hasOwnProperty`, never pollute a production process to prove a library gadget.

## Server-side (Node/Express, JSON body)

```json
{"__proto__": {"isAdmin": true}}
{"__proto__": {"admin": true}}
{"constructor": {"prototype": {"isAdmin": true}}}
{"__proto__.isAdmin": true}
```

Detect by observing a changed default on a reflected object, or via an OOB side effect:

```json
{"__proto__": {"status": "MARKER"}}
```

## Client-side (URL fragment / JSON in `location` sinks)

```
?__proto__[MARKER]=x
?__proto__.MARKER=x
#__proto__[MARKER]=x
```

Then in `dom-check.js --eval` check `Object.prototype.MARKER`:

```js
({}).MARKER !== undefined || Object.prototype.hasOwnProperty('MARKER')
```

## Confirmation

- **Server:** pollute then trigger a feature that reads the polluted key (e.g. a config
  flag, an auth check) — smallest observable change wins.
- **Client:** use `dom-check.js` `--eval '({}).MARKER'` to confirm the key landed on
  `Object.prototype`.

## Notes

- `Object.freeze(Object.prototype)` / `Object.create(null)` defenses mean the pollute
  silently no-ops — check before claiming.
- Keep keys benign (`MARKER`, `x`) — never `toString`/`hasOwnProperty` overrides that could
  break the target or you'll DoS it by accident.

## 2026: polluted defaults and gadget chains

The 2026 wave is not "find the merge sink" — it is **a library that reads an inherited property
and acts on it**. So the useful test is a local harness: install the affected version, set one
inert key on `Object.prototype`, and observe whether the library consumes it. On a live target the
marker is a changed *decision* (an authz check that passes, a worker that loads, a header that
appears) — never a crash you caused.

| Gadget | CVE / advisory | Date | Affected | Local marker test |
|---|---|---|---|---|
| `__lookupGetter__` sandbox escape | CVE-2026-25142 / GHSA-9p4w-fq8m-2hp7 | 2026-01 | SandboxJS ≤0.8.26 | can sandboxed code reach a prototype getter at all |
| `hasOwnProperty` shadow → host pollution | CVE-2026-25586 / GHSA-jjpw-65fv-8g48 | 2026-02 | SandboxJS ≤0.8.28 | does a sandbox-set marker reach `Object.prototype` |
| `parse_str` guard bypass (`includes`) | CVE-2026-25521 / GHSA-rxrv-835q-v5mh | 2026-02 | locutus 2.0.12–<2.0.39 | override `includes`, parse a marker key path |
| `parse_str` guard bypass (`RegExp.test`) | CVE-2026-33994 / GHSA-vc8f-x9pp-wf5p | 2026-03 | locutus 2.0.39–<3.0.25 | same, via `test` |
| `extendDefaults` forbidden-key bypass (`indexOf`) | CVE-2026-27212 / GHSA-hmx5-qpq5-p643 | 2026-02 | swiper 6.5.1–<12.1.2 | make `indexOf` miss, pass an inert key |
| Inherited partial rendered by Handlebars | CVE-2026-33916 / GHSA-2qvq-rjwj-gvw9 | 2026-03 | handlebars 4.0.0–<4.7.9 | inherited partial name → does it render |
| Merge/conversion property injection | CVE-2026-29063 / GHSA-wf6x-7x77-mvgw | 2026-03 | Immutable.js <3.8.3; 4.0.0-rc.1–<4.3.8; 5.0.0–<5.1.5 | returned object exposes an inherited key (no global pollution) |
| Sanitizer inherits custom-element checks | CVE-2026-41238 / GHSA-v9jr-rg53-9pgp | 2026-04 | DOMPurify 3.0.1–<3.4.0 | harmless custom element survives sanitization |
| Pagination param → global pollution → RCE | CVE-2026-44789 / GHSA-c8xv-5998-g76h | 2026-05 | n8n <1.123.43, 2.0.0-rc–<2.20.7, 2.21.0–<2.22.1 | own property appears on `Object.prototype` |
| Worker `filename` inherited | CVE-2026-55388 / GHSA-x9g3-xrwr-cwfg · CVE-2026-104849 / GHSA-85c8-ppgw-ccpr | 2026-06 / 2026-08 | piscina ≤4.9.2; 5.0.0-alpha.0–≤5.1.4; 6.0.0-rc.1–<6.0.0-rc.2 · tinypool <2.1.2 | does `run(task, opts)` load an inherited filename |
| `apos.util.set` patch operators → authz bypass | CVE-2026-53609 / GHSA-6h5j-32cf-4253 | 2026-06 | apostrophe ≤4.30.0 | `$pullAll` path with an inert key |
| Velocity `#set` path assignment | CVE-2026-44966 / GHSA-j658-c2gf-x6pq | 2026-05 | velocityjs ≤2.1.5 (no fix listed) | `#set` a deep path, read `Object.prototype` |
| Inherited type lookup at code generation | CVE-2026-44291 / GHSA-75px-5xx7-5xc7 | 2026-05 | protobufjs ≤7.5.5, 8.0.0–8.0.1 | generated output contains an inherited marker (do not execute it) |
| Axios inherited-config gadgets | CVE-2026-40175, -42033, -42035, -42041, -42264, -44494, -44495 | 2026-04 | axios per advisory: -40175 `1.0.0–<1.15.x`; -42033/-42035/-42041 `>=1.0.0 <1.15.1`, `<=0.31.0`; -42264 `>=1.0.0 <1.15.2` (1.x only); -44494 `>=1.0.0 <1.16.0` (1.x only); -44495 `>=1.0.0 <1.15.2`, `>=0.19.0 <0.31.1` | inherited `proxy`/`baseURL`/`transformResponse`/`validateStatus` must not be used (loopback mock only) |

Record class `proto-pollution` (CWE-1321); when the gadget gives authz bypass or RCE, record the
impact class too and link the pair with `node tools/chain.js`. A version match is `suspected`; a
marker that changes behaviour is `triggered`; another principal's data or code execution is
`exploited` and needs explicit approval.
