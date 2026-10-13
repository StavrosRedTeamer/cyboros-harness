# Alternative-tools audit — what the harness should adopt, borrow, or leave alone

> Written 2026-10-01 from a read of the actual tree (`tools/` 264 entries, 83 registered
> binaries, `install-tools.sh` 67 apt + 14 go + pipx) plus external research (GitHub release
> pages, ProjectDiscovery docs, vendor docs, the 2026 DAST/pentest-agent comparison literature).
>
> **Purpose:** find where something better exists, and — more often — say plainly when the
> current thing is already the better choice. Four of the twenty-odd sections below end in
> "don't change", and those are the important ones.
>
> **Constraint applied to every recommendation:** the harness is zero-npm-dependency, Node ≥ 22,
> air-gap-capable, and enforced through `run.js` → `tool-registry.json`. Any suggestion that
> breaks those is marked as such even when it is otherwise the better tool. Where a candidate
> is *not* wired to a guard, that is the actual finding, not the candidate's quality.

---

## 0. The headline

Three concrete gaps, in priority order:

1. **Four binaries are already installed by `install-tools.sh` but are absent from
   `tool-registry.json`** — `uncover`, `shuffledns`, `mapcidr`, `interactsh-client` are
   `go install`ed by the installer and never registered, so they run through `run.js` as
   unregistered (WARNING, no `risk_tier`, no `timeout_ms`, no `rate_class`, no recovery
   `alternative`). This is a real hole in the guard plane, not a missing feature. §1.
2. **No machine-readable output format.** `report-html.js` emits standalone HTML only; the
   repo has no SARIF emitter despite `radar-profiler.js` already listing `'sarif'` as a
   reporting capability it claims. That single omission is what blocks DefectDojo, GitHub
   code scanning, and any downstream SIEM from consuming a run. §4.
3. **`desync.js` covers CL.TE / TE.CL / TE.TE and nothing else.** h2c smuggling
   (`BishopFox/h2csmuggler`) is absent, and h2c is the class with published in-the-wild
   exploitation. §3.

And one place where the harness is *ahead* of everything the research turned up: the
verification oracle. Nothing in the public tool landscape — commercial or open — re-executes
its own findings under a scope guard. That should not be replaced by anything.

---

## 1. Guard-plane gaps (highest value, smallest diff)

### 1.1 Unregistered binaries

`install-tools.sh` `GO_TOOLS` installs:

```
projectdiscovery/uncover        ← NOT in tool-registry.json
projectdiscovery/shuffledns     ← NOT in tool-registry.json
projectdiscovery/mapcidr        ← NOT in tool-registry.json
projectdiscovery/interactsh-client ← NOT in tool-registry.json
```

`run.js --registry-check` exits 0 anyway, because the design is deliberately
non-blocking for unknown binaries ("un binario NON registrato produce solo un WARNING non
bloccante"). That is the right call for robustness — but it means these four ship on every
operator machine with **no declared risk tier and no pacing class**. `shuffledns` in
particular is a DNS-resolution hammer (`rate_class: aggressive` is what every comparable
entry declares), and `pace.js` has nothing to read.

**Recommendation:** add four registry entries. Pure data, no code change:

```json
"uncover":            { "args_schema": "-e shodan -q <query>", "risk_tier": "read",  "timeout_ms": 600000,  "rate_class": "normal",     "alternative": "subfinder", "read_only": true },
"shuffledns":         { "args_schema": "-d <list> -silent",       "risk_tier": "active","timeout_ms": 3600000,  "rate_class": "aggressive", "alternative": "dnsx",      "read_only": false },
"mapcidr":            { "args_schema": "-cidr <cidr> -silent",    "risk_tier": "read",  "timeout_ms": 600000,  "rate_class": "normal",     "alternative": null,         "read_only": true },
"interactsh-client":  { "args_schema": "-json -o <file>",         "risk_tier": "read",  "timeout_ms": 3600000,  "rate_class": "normal",     "alternative": null,         "read_only": true }
```

**Verification before landing:** `uncover` v1.2.1 added `daydaymap` and NerdyData engines
(confirmed in the release notes) — confirm no source is one the operator has not consented
to, since uncover queries third-party search engines and therefore *is* egress. See §10.

### 1.2 Nine more installed-but-unregistered apt binaries

`wpscan`, `xsser`, `medusa`, `theharvester`, `recon-ng`, `fierce`, `dnsenum`, `dirb`,
`eyewitness`. Each currently runs through `run.js` with no tier. `medusa` and `dirb` are
credential-attack tools: they should *never* be reachable without a declared `risk_tier:
intrusive`.

**Recommendation:** either register them with honest tiers, or drop them from
`APT_PKGS`. `wpscan` is the one with real value (§6.4).

### 1.3 RustScan: repo moved, and `cyboros.js` still calls the old name

`tools/cyboros.js:383` invokes `rustscan`. The canonical repo is now **`bee-san/RustScan`**
(the `RustScan/rustscan` path 302-redirects). Last release **2.4.1**, February — the project
is alive but its release cadence is a fraction of ProjectDiscovery's, and `naabu` is already
installed, already registered, and already the declared `alternative` for it.

> **Correzione (2026-10-01, in sede di attuazione).** Avevo raccomandato di eliminare il ramo.
> Letto il codice, **non è codice morto**: è un *fallback* che scatta solo quando `naabu`
> non torna con porte, e l'ingestione autoritativa è comunque `nmap -sV` che segue di due
> righe. La rimozione non guadagna funzionalita' (nmap scrive i porti lo stesso) e toglie
> resilienza sulle macchine dove naabu manca — `naabu` è `required: false` in `tool-plane.js`.
> **La raccomandazione era quindi piu' debole di quanto presentato, e il ramo resta.** La voce
> di registro `rustscan` resta comunque, come `alternative` di `naabu`.

### 1.4 The MCP bypass is real and cheap to close

`SECURITY.md` and `README.md` both concede it: MCP-mounted tools bypass every in-process
guard unless routed through `mcp-guard-proxy.js`. The research on agent sandboxing (2026)
converges on the same answer the harness currently only documents: **the enforceable
boundary is a network namespace with an nftables ruleset, not process-level discipline.**
Bubblewrap gives an unprivileged user-namespace netns with no root and no daemon; OpenShell
(Landlock + seccomp + netns + policy-enforced egress) is the production-grade reference.

**Recommendation:** add a netns guard wrapper under `tools/` (bwrap `--unshare-net` + an
nftables allowlist derived from `scope.json`) and document it as the *stronger* mode alongside
`mcp-guard-proxy.js`. This is the single highest-leverage item in the audit: it converts
"the model is disciplined" into "the kernel refuses", which is the design principle the
README already claims and the one place the current implementation is weakest. It does not
replace the existing guards — it sits below them.

---

## 2. Recon

| Current | Verdict |
|---|---|
| `subfinder` + `amass` + `dnsx` | **Keep.** Correct choices; no 2026 successor displaces them. |
| `katana` + `gau` + `waybackurls` | **Keep.** Katana is the consensus JS-aware crawler (a 2026 comparison table puts it well above gospider and hakrawler on JS execution). |
| `httpx` | **Keep.** |
| *(gap)* | **`uncover`** — Shodan/Censys/FOFA/Zoomeye/Hunter/Daydaymap. Installed, unregistered (§1.1). Complements passive-DNS recon with *certificate and service* discovery, which none of the current tools cover. Register it. |
| *(gap)* | **`shuffledns`** — massive DNS resolution over a subdomain list. Installed, unregistered. This is the natural completion of the `subfinder → dnsx → httpx` chain: subfinder finds names, shuffleddns resolves them at scale, httpx fingerprints the survivors. |
| *(gap)* | **`tlsx`** / **`asnmap`** / **`cvemap`** — sibling ProjectDiscovery tools, same install path. tlsx in particular surfaces TLS misconfig and SAN enumeration that nothing current does. Lower priority; the registry entry is free once the installer is edited. |

**Do not adopt:** `assetfinder`, `findomain`, `recon-ng`. Subfinder subsumes the first
two; `recon-ng` is an abandoned all-in-one OSINT framework with dependency rot, and it is
currently sitting unregistered in `APT_PKGS`.

---

## 3. Vulnerability scanning and desync

### 3.1 Nuclei: keep, but consume its SARIF

Nuclei is the right scanner and the repo already installs it plus `TEMPLATE-REVIEW-GUIDE`
upstream discipline. Two things the harness leaves on the table:

- `-sarif-export <file>` is upstream-supported. See §4 — this is free interoperability.
- The community AI-template repo (`nuclei-templates-ai`) covers public CVEs with no
  hand-written template yet. That is a coverage gain with zero new code, gated by the same
  `requires` precheck the workflow dialect already has.

### 3.2 `desync.js` — add h2c

Current probes: CL.TE, TE.CL, TE.TE. Missing: **h2c smuggling** (`BishopFox/h2csmuggler`,
Apache-2.0, Go, ships a reusable library). SL Cyber published *H2C Smuggling in the Wild*
documenting real-world proxy and load-balancer exploitation bypassing authentication to
reach internal endpoints. This is the one smuggling class with demonstrated exploitation
against exactly the nginx/CDN front-ends this harness's targets sit behind.

**Recommendation:** register `h2csmuggler` and add an `attack-h2c` workflow alongside the
existing desync probe. Detection-only by default, consistent with `desync.js`'s current
posture, confirm-tier for the smuggling PoC.

### 3.3 ZAP as a second opinion — worth it, with a caveat

`Nuclei` is signature-driven; `ZAP`'s active scanner is stateful-DOM-driven and finds logic
adjacent issues nuclei structurally cannot. The MDPI empirical comparison (Albahar et al.)
still has ZAP scoring highest among non-commercial tools. ZAP's Automation Framework has a
REST API that maps cleanly onto the harness's workflow dialect (`activeScan` job, auth via
`replacer`).

**Caveat, stated plainly:** ZAP's own docs say the active scanner "actively attacks your
applications" — that is `risk_tier: intrusive`, and it needs its own confirm path, not the
`active` treatment nuclei gets. Adding ZAP widens the guard surface, not just the tool list.
Worth it only if the operator wants a second engine; it is not a drop-in.

---

## 4. Reporting — the biggest single omission

`report-html.js` produces a self-contained HTML file. `findings.jsonl` is the machine
source of truth. There is **no SARIF emitter anywhere in `tools/`**, even though
`radar-profiler.js:20` lists `'sarif'` among the reporting capabilities this harness claims
to have. That is an inconsistency worth fixing regardless of anything else in this report.

**Why it matters more than it looks:**

- SARIF is the OASIS standard for exactly this shape of data and is accepted by **GitHub
  code scanning** and **DefectDojo** out of the box, with deduplication handled by the
  consumer.
- The harness's most distinctive artifact — a severity that is *bounded by evidence*, with
  `verify_level`, `status`, and a machine-reexecuted oracle — maps cleanly onto SARIF's
  `properties` bag. That mapping has never been written down, and it is the cheapest possible
  way to show the severity-ceiling thesis to someone who uses normal tooling.
- Zero dependencies: SARIF is JSON. The emitter is ~150 lines.

**Recommendation:** a new module (proposed: `report-sarif.js`) reading `findings.jsonl`,
emitting `sarifVersion 2.1.0`, with
`properties.stavros.{verify_level,status,oracle_url,evidence_chain}` on each result. Then
`radar-profiler.js`'s claim becomes true.

Secondary: **CycloneDX VEX** is the right format if the harness ever wants to express
"this finding is *not* exploitable against this deployment" as a first-class, standards-
consumable statement. That is a bigger commitment and the `verify_level` ladder already
covers the same ground internally. Defer.

---

## 5. Verification and the memory loop — keep, and consider one upgrade

The verification ladder, the oracle, `verify-finding.js`'s append-only `verifications.jsonl`,
the `rechain.js` A3 chain, `gen-poc.js`'s Python reproducer — this is the differentiated
part, and the external research confirms nothing open-source does it. Xalgorix (Apache-2.0)
comes closest with "an independent verifier re-exploits every finding before it's reported",
and Strix with PoC validation; both do it *inside* their agent loop rather than in a
separate process the model cannot reach, and neither publishes precision.

**Do not replace.** If anything, this is the asset worth exporting.

One upgrade worth considering, in `kb-search.js` only: it is pure FTS5/BM25. `memory-rag.js`
already does lexical+dense hybrid with a tunable alpha. FTS5+vector fused with RRF is the
standard 2026 local-RAG recipe and needs no new dependency if the dense backend stays
optional-and-fail-open the way `embeddings.js` already is. **Low priority** — `kb-search`
indexes ~27 markdown documents; the recall problem isn't retrieval quality, it's corpus size.

---

## 6. Per-category sweep

### 6.1 Headless browser — Obscura is the right call

The harness runs Obscura (`h4ckf0r0day/obscura`, Rust, ~20k stars) as the antidetect engine
with Chromium as the real-browser fallback. This is correct and current. The 2026 antidetect
landscape splits cleanly:

- **Patchright / rebrowser-patches / nodriver** — Chromium/Playwright patches. Strong, but
  Chromium-derived, and the benchmark literature shows both pass Google and get gated by
  Medium.
- **Camoufox** — Firefox engine patched in C++. Passes where vanilla Playwright, vanilla
  Chromium, *and* rebrowser-patches all get blocked. The strongest open-source antidetect
  browser by the available benchmark (651 verdicts across 7 tools).

Camoufox is worth a second provider **specifically for WAF/anti-bot challenge work**, because
it is a genuinely different engine — a second engine that shares Chromium's fingerprint
surface isn't a second opinion. Constraint cost: it's a Python Playwright package, so it
breaks the zero-npm-deps rule *if wired into the harness*; it stays a valid operator-side
`run.js` target, and `docs/egress-opsec.md` already treats operator-run external tools as a
first-class path. Verdict: **add as an optional provider for the WAF-probe case, not as a
replacement.** The current pinning discipline (`v0.2.3`, "mai aggiornare senza re-test") is
exactly right for a young engine — keep it.

### 6.2 Secrets in bundles — a real coverage gap

`analyze-bundle.js` mines JWTs, Supabase projects, endpoints, and hardcoded keys from
`sourceMappingURL` → `.map` → `sourcesContent`. That is the right approach and better than
the classic LinkFinder/SecretFinder regex scripts, which are unmaintained and produce
unverified hits.

The gap is **verification**. `trufflehog` is registered but `analyze-bundle.js` doesn't call
it, and trufflehog's differentiator is exactly the missing half: 800+ detectors with
**active credential validation** — it confirms the key is live before reporting. For an
engagement where a leaked key chains to ATO (`chain.js` already models that link), "this key
validates" is the difference between `suspected` and `exploited`.

**Recommendation:** `analyze-bundle.js` emits candidate keys → `trufflehog filesystem` as a
confirm-tier verification step, not a discovery step. This is consistent with the existing
tier model and needs no new dependency. Note it *is* egress (validation calls the provider's
API), so it belongs under the same egress discipline as everything in `docs/egress-opsec.md`.

### 6.3 OOB — the in-house listener is a feature, not a bug

`oob.js` is a zero-dep local listener with marker attribution (`hits --marker <t>` maps a
callback back to the exact payload that fired). `interactsh-client` is the installed
alternative and is unregistered (§1.1).

Interactsh's real advantages are a **public DNS domain** (blind SSRF against an internal-only
target, which the docs already flag with `--public-url` as a manual workaround) and
multi-protocol support (DNS, HTTP, SMTP, LDAP…). Its cost is that the domain is
`*.oast.pro` — a shared, publicly-loggable infrastructure that an operator's target can
observe. Under this harness's zero-egress OPSEC posture that is disqualifying for anything
but lab use.

**Verdict: keep `oob.js` as primary. Register `interactsh-client` with `read_only: true`** so
it is at least tiered and audited when an operator explicitly reaches for it.

> **Correzione (2026-10-01, in sede di attuazione).** L'item più avanti di questo documento
> proponeva di "costruire properly" `--public-url` con un dominio DNS fornito dall'operatore.
> **Era già implementato**: `oob.js` accetta `--public-url http://<nome-dns>:port/`, lo valida
> con `ssrf-guard` e lo registra nello state file. Verificato: `oob.js listen --public-url
> http://oast.example.internal:19099/` parte pulito. Il rischio di Interactsh che avevo
> descritto (dominio pubblico condiviso, terze parti che osservano) è quindi già evitabile —
> nessun lavoro richiesto. La raccomandazione era ridondante.

### 6.4 WordPress — `wp-check.js` is a rounding error next to WPScan

`wp-check.js` fingerprints core version from public artifacts and gates **two** CVEs
(`CVE-2026-63030`, `CVE-2026-60137`). WPScan ships a curated WordPress vulnerability
database covering core, plugins, *and* themes, with real-world CVE data behind it — and it is
**already installed by `install-tools.sh` and unregistered** (§1.2).

**Recommendation:** register `wpscan` at `risk_tier: active` with `requires_key` semantics on
its API token. Keep `wp-check.js` — it's the zero-API-token, zero-egress path and stays the
offline fallback. The two compose correctly: `wp-check.js` establishes the version,
WPScan turns version+plugins into a CVE list.

### 6.5 API testing — the largest genuine capability gap

Current API surface: `map.js` (endpoint map), `arjun` (parameter discovery), OpenAPI
ingest in `target-model.js`, `repeater.js` authed diffing, `attack-graphql`.

Missing: **stateful API fuzzing.** The state of the art is `Schemathesis` (MIT,
property-based from OpenAPI *or GraphQL*, Hypothesis-driven, with a stateful-testing mode and
custom hooks for non-standard auth) and Microsoft's `RESTler` (stateful REST fuzzing). The
published comparison work on OpenAPI fuzzing finds Schemathesis delivers the best results of
the three tools evaluated.

This matters specifically for this harness's thesis. The classes it is worst at are exactly
the ones a stateful property fuzzer is good at — BOLA across resource lifecycles,
mass-assignment, sequence-dependent authz. And Schemathesis emits structured failure output
that feeds `record-finding.js`'s oracle format cleanly.

**Constraint cost:** `pipx install schemathesis` fits the existing installer pattern
(h8mail is already pipx). It is MIT. It runs as a plain binary behind `run.js`. **This is
the best cost/benefit addition in the entire audit.**

### 6.6 Cloud — `cloud-enum.js` versus the field

`cloud-enum.js` does its own probing. The 2026 field: Prowler is the only *actively
maintained* option (CloudSploit's community edition has minimal updates, ScoutSuite is
abandoned), CloudFox is the best discovery-first tool for unfamiliar accounts, CloudBrute
enumerates resources.

**Recommendation: do not adopt Prowler.** It is a large Python dependency tree, it requires
live cloud credentials (which puts engagement data in a third-party API surface, against
`docs/egress-opsec.md`), and its output is compliance-oriented rather than exploit-oriented.
The one piece worth lifting cheaply is **CloudBrute-style resource enumeration**, which is a
naming-pattern fuzzer — small enough to implement natively in `cloud-enum.js` without a new
dependency.

### 6.7 AD / host post-ex — no change

`ad.js` + `netexec`/`impacket`/`bloodhound-python`/`certipy-ad`/`responder`/`coercer` is a
standard, current AD toolchain. `privesc-catalog.json` is a differentiator (catalog-driven
privesc rather than tool-driven) and has no external equivalent to borrow from.

### 6.8 C2 — Sliver is the right default

Sliver vs Havoc vs Mythic vs Covenant. Sliver wins on multi-protocol (HTTP/HTTPS/DNS/mTLS/
WireGuard), cross-platform, Go (single static binary, `go install`, already in the
installer's world), and active maintenance. Mythic is a Team Cymru project — heavier ops
burden for no capability this harness needs. Havoc is smaller/C++ but narrower.

**No change.** `c2-guard.js` is the actual contribution here, not the C2 binary.

### 6.9 Wireless — no change

`wifi.js` + `airmon-ng`/`airodump-ng`/`aireplay-ng`/`aircrack-ng`/`hcxdumptool`/`reaver`
plus `hostapd`/`dnsmasq` for the captive-portal tier. `hcxpcapngtool` for hash conversion is
the detail most people miss and this harness has it.

### 6.10 Mobile — MobSF is the honest gap, and it stays a gap

`mobile.js` covers static (apktool/jadx), `surface`, `fetch-apk` with sha256 pinning,
`firebase-audit`, frida/obtainium, CA install. MobSF is the dominant open-source MAST
platform — static + dynamic + API extraction + reporting for both Android and iOS.

**Recommendation: do not adopt MobSF into the harness.** It is a Django + Redis stack, it
wants to *run* the app in an emulator/real device (which is exactly the destructive-surface
`mobile-scope.json` exists to gate), and it conflicts with the zero-dependency posture
outright. It remains valid as an operator-run tool through `run.js` with its own scope file.
`android-fuzzing`-class gaps (MobSF's DAST) are real but are out of scope for this harness's
architecture.

---

## 7. What to delete or deprecate

| Item | Reason |
|---|---|
| `recon-ng` from `APT_PKGS` | Abandoned all-in-one framework, dependency rot. **Non rimosso**: registrato con tier, che raggiunge l'obiettivo di sicurezza senza toccare la macchina dell'operatore. |
| `dirb`, `medusa` from `APT_PKGS` unless registered | Credential-attack tools. **Registrati** come `intrusive`: tier dichiarato invece che rimozione. |
| ~~`rustscan` branch in `cyboros.js:383`~~ | **Non rimosso** — è un fallback attivo quando `naabu` non torna con porte, non codice morto. Vedi §1.3. |

---

## 8. Priority list

| # | Action | Cost | Value |
|---|---|---|---|
| 1 | New SARIF emitter + wire `radar-profiler`'s existing `'sarif'` claim | ~150 LOC, zero deps | Unlocks GitHub code scanning, DefectDojo, any SIEM. Fixes an internal inconsistency. |
| 2 | Register `uncover`, `shuffledns`, `mapcidr`, `interactsh-client` | 4 JSON lines | Closes a live guard-plane hole on every installed machine. |
| 3 | Register `wpscan`; wire it behind `wp-check.js`'s version fingerprint | 1 JSON line + 1 workflow | Turns a 2-CVE gate into a full WordPress CVE surface. |
| 4 | `schemathesis` via pipx + `attack-api-stateful` workflow | 1 installer line + 1 YAML | Fills the largest capability gap (BOLA/sequence authz). MIT. |
| 5 | `h2csmuggler` + `attack-h2c` workflow | 1 JSON line + 1 YAML | Covers the one smuggling class with in-the-wild exploitation. |
| 6 | New netns guard script (bwrap + nftables from `scope.json`) | New script, documented as stronger mode | Kernel-enforced egress. The design principle the README already claims. |
| 7 | Register or drop the other 9 unregistered apt binaries | JSON or one-line edits | Removes unlabeled intrusive-tier reachability. |
| 8 | `analyze-bundle.js` → `trufflehog` confirm step | Small | Key *validation*, which is the `suspected`→`exploited` edge `chain.js` needs. |
| 9 | ~~`report-html` `--public-url` for OOB~~ | **Già fatto**: `oob.js` accetta già un dominio DNS dell'operatore. Vedi la correzione in §6.3. |
| 10 | Camoufox as an optional second antidetect engine | Optional, operator-side | A genuinely different engine for WAF challenge work. |

---

## 9. Explicitly *not* recommended

Naming these because "we looked at it and said no" is the useful half of an audit.

- **Anything that replaces the verification oracle.** The 2026 landscape (Xalgorix, Strix,
  Shannon, PentAGI, CAI, HexStrike, VulnBot) all stop at "the agent validates its own
  findings" — in-loop, model-reachable, unmeasured. The harness runs the oracle in a
  separate process under a scope guard and publishes the precision/suppression numbers
  nobody else publishes. This is the asset.
- **Docker-based sandboxing** as the primary isolation. Every 2026 comparison reaches the
  same verdict: containers drop `NET_ADMIN`/`NET_RAW`/`SYS_PTRACE`, which breaks masscan,
  interface tuning, ARP spoofing, and tun/tap — i.e. exactly what this harness does. Xalgorix
  ships `--privileged` and calls the container "disposable" as a workaround, which is a
  disclaimer, not an isolation boundary. Namespace-level (bwrap) is the correct shape.
- **Prowler / CloudSploit / ScoutSuite.** Credential-requiring, egress-hostile, wrong output
  shape.
- **MobSF.** Dependency violation plus a device-execution surface that fights `mobile-scope.json`.
- **A vector DB.** `memory-rag.js` already does hybrid retrieval in a JSONL file with zero
  dependencies and fail-open semantics. Adding Qdrant/LanceDB/Chroma to hold 27 markdown
  documents' worth of knowledge is not an improvement.
- **Dropping Obscura for Camoufox.** Different engines, both current. Additive, not
  substitutive — see §6.1.
- **Full DAST platform adoption** (Burp Pro, Invicti, Pentera, NodeZero). They are the
  correct answer for an organization that wants a managed continuous-testing program. They
  are the wrong answer for a harness whose thesis is that the severity decision belongs in
  code the model cannot argue with — every one of them puts a reviewer, and therefore a
  person, in the severity loop.

---

## 10. Open questions for the operator

1. **Egress posture vs. tool quality.** `uncover` (third-party search engines),
   `trufflehog` (credential validation), Interactsh (public domain) are each individually
   better than the in-house equivalent and each individually violate the zero-egress rule in
   `docs/egress-opsec.md`. Do these become operator-only tools behind `run.js` with an
   explicit opt-in, or stay unregistered and unused?
2. **Is `--privileged` acceptable anywhere?** §6.2/§9 argue namespaces, but if the F3
   proot path (Kali under Termux) needs capabilities a netns cannot give, the portable
   fallback has to be decided explicitly rather than by accident.
3. **SARIF or VEX first?** SARIF is 150 lines and unblocks DefectDojo/GitHub today. VEX
   would express "not exploitable here" as a standard statement, which is closer to the
   severity-ceiling thesis but is a larger commitment. Recommend SARIF first regardless.