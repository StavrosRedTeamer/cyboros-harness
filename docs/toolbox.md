# Toolbox — dettaglio per-tool (knowledge.md tiene la tabella compatta)

> Dettaglio completo dei flag per ogni tool. knowledge.md è il contratto (one-liner); questo file
> è il "come" — leggilo su richiesta o cercalo con `node tools/kb-search.js "<query>"`.
> Tutti i tool girano via `run_terminal_command`; ogni binario di terze parti passa da run.js.

- **Variabili d'ambiente (`tools/env.js`):** i moduli leggono la configurazione da un solo posto —
  `env('TMP')` cerca `CYBOROS_TMP`, poi `STAVROS_TMP` (deprecato), poi il default. Il prefisso
  corrente è `CYBOROS_*`; `STAVROS_*` resta letto per una release, e una stringa vuota vale come
  assente. Un modulo nuovo che leggesse `process.env` direttamente resterebbe fuori da questa
  finestra: passa da `tools/env.js`.

- **Scope-safe binary runner:** run every third-party network tool via `node tools/run.js <bin> [args]`
  (it refuses out-of-scope hosts; supports `-l -`/`--stdin` AND a piped stdin for target lists; every
  invocation is audited to `reports/tmp/run-audit.jsonl`). `--dry-run` prints the hosts + verdict
  without executing. **Never run a scanner binary directly — always through `run.js`.**
  E.g. `node tools/run.js nuclei -u https://host -tags injection`.
- **Bundle miner:** `node tools/analyze-bundle.js <url|localfile>` → JWTs (decoded role/ref/exp),
  Supabase projects, secrets, endpoints. It FOLLOWS `sourceMappingURL` into `.map` files and extracts
  `sourcesContent` — reconstructed source is where the richest secrets live. Run this on every
  JS/HTML bundle FIRST.
  - **Credential validation (opt-in, EGRESS, confirm-tier):**
    `node tools/analyze-bundle.js <url|localfile> --validate-secrets --confirm "<reason>"`
    L'estrazione trova candidati ma non distingue una chiave viva da una revocata — ed è
    esattamente il bordo `suspected`→`exploited` che `chain.js` già modella (leaked key +
    broken authz → ATO). `trufflehog` chiude quel bordo: prova la credenziale e dice se
    autentica. **Rifiuta senza `--confirm`**, perché validare è egress (chiama l'API del
    provider). Il valore grezzo **non viene mai persistito`: va in un file temporaneo `0600`
    fuori dal workspace, rimosso in un `finally`; l'output riporta detector, tipo e un
    `fingerprint` sha256 troncato (corrisponde a `secret_fingerprint` del loot vault, non
    recuperabile). Senza i flag il comportamento è invariato: estrazione offline mascherata.
- **Precise tampering:** `node tools/repeater.js --url <u> [--vary p=v1,v2] [--as <identity>] [flags]`
  (hard scope guard; global pacing from scope.json; auto backoff on 429). `--as` loads a bearer/headers
  from `auth.json` for authed / IDOR tests. `--vary` sets a query param; for a **path-based** id
  (IDOR on `/Order/123`) or a **body** field put a literal `FUZZ` where the value goes and it's substituted:
  `--url ".../Order/FUZZ" --vary "id=1,2,3"` or `--data '{"id":"FUZZ"}' --vary "id=1,2"`. Add `--show-body`
  to capture the first 2KB of each response — use it to *confirm* a finding (leaked row, error string,
  reflected payload) instead of guessing from length. Every result carries a `headers` object with the
  security-relevant response headers (CSP/HSTS/XFO, set-cookie flags) — read it for missing-header and
  cookie-flag findings.
  - `--diff` adds body_similarity (0..1) vs baseline in --vary mode — catches **same-length
    different-content** IDOR that byte-diffs miss.
  - `--follow` follows redirects (scope re-checked each hop); `--session <file>` is a host-keyed
    cookie jar + variable store. `--extract "name=regex"` captures a value from a response into the
    session, and `{{name}}` in `--url/--data/--header` substitutes it — **this is how you chain
    multi-step PoCs** (login -> grab token -> authed request).
  - `--race <n>` fires n concurrent identical requests (TOCTOU / double-redemption).
  - `--upload field=path --form k=v` builds a multipart upload (file-upload testing).
  - `--timeout <ms>` (default 10s) prevents a hanging endpoint from stalling the run.
- **JWT attacks:** `node tools/jwt.js decode <token>` / `verify <token> --key <s>` /
  `forge <token> --alg none|HS256|RS256 --key <s> [--set role=admin] [--set-header kid=..|jku=..]` /
  `attack <url> --token <jwt> --keys <file|k1,k2> [--set role=admin] [--show-body]` — attack diffs
  baseline vs alg:none vs HS256-with-known-secrets vs RS256->HS256 **alg-confusion** (put the leaked
  PUBLIC key in `--keys`). `--set-header` injects `kid`/`jku`/`x5u` for jku/x5u attacks. No hand-crafted forgery.
- **CORS:** `node tools/cors.js --url <u> [--origins ...]` — per-origin ACAO/credentials verdict
  (reflected origin + credentials = Critical).
- **CSP:** `node tools/csp.js --url <u>` (or `--header "policy"`) — flags unsafe-inline/eval, wildcard
  sources, missing frame-ancestors/object-src/base-uri, cleartext http:. Deterministic, no guessing.
- **Headers / cookie flags (A02 hardening):** `node tools/header-check.js <url>` (scope-gated,
  DNS-rebinding-safe) — evaluates in one shot: CSP (reuses csp.js flags), HSTS, X-Frame-Options,
  X-Content-Type-Options, Referrer-Policy, Permissions-Policy, Server banner AND cookie flags
  (Secure/HttpOnly/SameSite). ```--record``` emits a ready `config`-class finding. This is the fast
  A02 (Security Misconfiguration, #2 in 2025) check — run it on every live host after recon.
- **HTTP request smuggling / desync:** `node tools/desync.js <url>` (scope-gated, detection-only,
  safe) — runs CL.TE / TE.CL / TE.TE probes on YOUR OWN connection and reports `likely`+
  confidence; read `tools/payloads/smuggling.md` before chaining to a real impact (confirm-tier).
  Class `smuggling` (CWE-444).
- **Property-based stateful API fuzzing:** `node tools/workflow.js run workflows/attack-api-stateful.yaml -t https://<host> [--var spec_path=/openapi.json] [--var checks=all]`
  — schemathesis (pipx, MIT) genera i casi dalla specifica e verifica che il server rispetti
  ANCORA lo schema dopo input invalidi: copre struttura, non forma. È l'unico strumento
  dell'arsenale che attacca BOLA/mass-assignment lungo il lifecycle e la state-dependent authz
  senza che l'input derivi da un'ipotesi dell'agente. `checks` default `not_a_server_error`:
  `all` esercita anche metodi distruttivi e va usato solo su endpoint di test, mai su dati reali.
  `examples` (default 50) è il tetto Hypothesis = numero di richieste reali: abbassarlo su WAF.
- **h2c smuggling (detection-only):** `node tools/workflow.js run workflows/attack-h2c.yaml -t https://<proxy/path>`
  — `h2csmuggler` in modalità `-t/--test`: sonda e riporta, NON tunnella. Il binario senza `-t`
  stabilisce il tunnel verso endpoint interni ed è **confirm-tier** (regola tier-2), quindi mai
  in un workflow automatico. Attenzione al falso positivo: su HTTPS il rilevamento è quasi
  sempre vero, su HTTP in chiaro può non essere altro che un proxy h2c che risponde all'upgrade
  senza inoltrarlo — per questo il finding nasce `triggered` e la prova resta differenziale.
- **Credential testing (confirm-tier):** `node tools/workflow.js run workflows/attack-creds.yaml -t <host> --var port=22 --var protocol=ssh`
  — `brutus` (Praetorian, Apache-2.0, 43 protocolli) prova le credenziali **default** del
  servizio in `--mode cautious` e stampa in JSON **solo i successi**. È un attacco a credenziali:
  tocca account reali, quindi va eseguito SOLO con approvazione esplicita in sessione
  (knowledge.md regola 2) e mai in un loop; con la policy `scope.host_ops.require_approval`
  attiva in scope.json passa `--var approval=<id>`. Per liste utente/password
  (`-U users.txt -P pass.txt`), chiavi SSH note (`brutus badkeys`) o scan da un XML nmap
  (`--nmap-file`) usa `node tools/run.js brutus ...` con la stessa regola di conferma.
- **Secrets scan con Titus (alternativa a trufflehog):** `node tools/run.js titus scan <github.com/org/repo|path> [--extract=all] [--format json]`
  — 487 regole, scoring 0–100, estrazione da binari (Office/PDF/archivi, **APK/IPA**) e scan di
  immagini OCI incluse le layer cancellate. `--validate` e `--score-scope` sono **egress**
  (chiamano le API del provider, come la validazione di analyze-bundle): confirm-tier, stessa
  disciplina di docs/egress-opsec.md. In run.js un repo remoto è un host da scope.json; le
  scansioni di file locali passano dal percorso operatore (run.js rifiuta una invocazione senza
  host per design, fail-closed).
- **Payload references (classes without a dedicated tool):** `tools/payloads/` — `ssti.md`,
  `deserialization.md`, `lfi.md`, `nosqli.md`, `prototype-pollution.md`, `llm-agentic.md`, `mcp.md`,
  `smuggling.md`. Read the matching file before testing that class; substitute a unique `MARKER` and
  detect-before-exploit.
- **GraphQL:** `node tools/graphql.js introspect <url> [--header "K: V"]` (saves the schema, lists
  queries/mutations — introspection enabled is itself a finding), `types`/`fields` to explore, and
  `query <url> '<gql>'` to execute BOLA/authorization probes.
- **Out-of-band (blind SSRF/XXE):** `node tools/oob.js listen` (daemon), `marker`, `hits [--tail N] [--marker <t>]`,
  `stop`. Inject the marker URL into URL-fetching params / XXE payloads; `hits` proves the fetch, and
  `--marker <token>` attributes a hit back to the exact payload that fired. Use `--public-url
  http://<LAN-IP>:9099/` if the target can't reach 127.0.0.1. If the `interactsh-client` binary is
  installed, it's an alternative (`-o reports/oob/interactsh.jsonl -json`).
- **WebSockets:** `node tools/ws.js --url ws://host/path [--message ...]` (Node >= 22).
- **Client-side / DOM XSS:** `node tools/dom-check.js <url>` needs Chrome with
  `--remote-debugging-port=9222`. Reports postMessage handlers, localStorage keys, inline-script sinks
  (innerHTML/eval/document.write), forms, javascript: links. `--eval 'js'` confirms a PoC.
  Alternative backend senza Chrome: `--backend obscura` (auto-avvia un server CDP effimero, vedi sotto).
- **Obscura headless browser (antidetect, opzionale):** wrapper scope-gated `node tools/obscura.js`.
  Engine Rust CDP-compatibile (Apache-2.0, github.com/h4ckf0r0day/obscura) installato version-pinnato
  nella root vendor ESTERNA (tools/vendor-dir.js: $CYBOROS_VENDOR_DIR → ~/.local/share/stavros/vendor
  → legacy workspace vendor/) da `install-tools.sh`; stato: `node tools/obscura.js status`. Comandi:
  `fetch <url> [--stealth] [--dump html|text|links|markdown] [--eval js] [--screenshot f]` (una pagina,
  scope-checked), `scrape <url...> --concurrency n` (parallelo, concurrency clampata: pace.js NON vede
  i worker interni), `serve --port 9222 --stealth` (server CDP per dom-check). Ogni URL e scope-checked
  PRIMA dell'exec (fail-closed, audit su run-audit.jsonl); se l'egress gateway e attivo il traffico
  Obscura e PINNATO al gateway (`--proxy http://127.0.0.1:<port>`) — stessa enforcement di run.js.
  Usi: (1) `dom-check.js <url> --backend obscura` quando chromium non c'e; (2) browsing stealth per
  testare bot-detection/WAF su target in-scope; (3) screenshot di pagine dietro challenge. ATTENZIONE:
  il motore NON e Chromium — usa Obscura per SCOPRIRE superficie e conferma i DOM-XSS su Chrome reale;
  il progetto e giovane (pin della versione, mai aggiornare senza re-test).
- **Structured endpoint map:** `node tools/map.js add '<json>'` / `candidates <host>` — the mapper
  records endpoints + candidate params per vuln class in `reports/<host>-map.json`; testers consume
  `map.js candidates` instead of freeform markdown (deterministic handoff).
- **Attack chains:** `node tools/chain.js` links findings.jsonl entries into exploitable chains
  (leaked key + broken authz -> ATO). Run it before writing the report.
- **CVSS:** `node tools/cvss.js 'AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H'` -> real v3.1 base score; put the
  score/vector into `record-finding.js` (`cvss`, `cvss_vector` fields).
- **EPSS / CWE (offline + live):** `node tools/epss.js CVE-2021-44228` / `node tools/epss.js --cwe CWE-79` —
  embedded, APPROXIMATE EPSS score + CWE title/description. `record-finding.js` auto-fills `epss`
  from `cve`/`cves` when present. A missing CVE is "unknown", never 0.0.
  **Live upgrade:** `node tools/threatintel.js refresh CVE-... [CVE-...]` pulls NVD API v2 + CISA KEV +
  the official FIRST EPSS API into `reports/cache/threatintel/` (TTL'd, offline-safe). After a refresh,
  `record-finding.js` compiles `kev:true` (+ date/ransomware flag), a precise CWE and reference URLs
  from the cache; `node tools/threatintel.js lookup CVE-... [--refresh]` shows the merged intel.
- **Exploit lookup (offline + vendor PoC archive):** `node tools/searchsploit.js <cve|service>` -> normalized
  exploit-db records (JSON); `--jsonl reports/searchsploit.jsonl` appends them. Fold into the report with
  `report-html.js --sploit reports/searchsploit.jsonl`. Second local source: hash-pinned PoC archives in
  `vendor/mirror/` (indexed by `node tools/vendor-mirror.js index-poc` into `vendor/poc-archive/index.json`)
  — results appear as `poc_archive` entries pointing INTO the sealed zip. NEVER extract or run them from
  the harness; an operator opens one file inside an isolated lab only. Pull/refresh snapshots with
  `node tools/vendor-mirror.js pull <owner>/<repo>` and re-verify pins with `... verify`.
- **WordPress scan (detection-only):** `node tools/workflow.js run workflows/attack-wp.yaml -t <url> --var api_token=<t>`
  — due passate: `wp-check.js` fingerprinta la versione core dagli artefatti pubblici (zero
  token, zero egress) e dice se una CVE core è applicabile; poi `wpscan` (via `run.js`,
  `risk_tier: active`) trasforma versione+plugin+temi in un elenco CVE dal database WPScan.
  Senza `api_token` wpscan gira in modalità free con copertura CVE ridotta. L'ordine non è
  decorativo: se il fingerprint fallisce il secondo step non parte.
  `node tools/wp-check.js <base-url>` da solo fingerprints WP core version
  from public artifacts (meta/feed generator, readme.html, /wp-json/) and gates CVE-2026-63030 /
  CVE-2026-60137 applicability (WP 6.9–7.0.1). It never sends exploit payloads: applicable CVEs go to
  `record-finding.js` as `verify_level:suspected` until proven on a lab/authorized instance.
- **Upload-bypass payloads:** `tools/payloads/upload-bypass/` — `gen-polyglot-jpeg.js` builds a VALID
  JPEG that is also a sh/pwsh/bat script (payload after the EOI marker) to test magic-byte/MIME-sniff
  upload filters. Default embedded command = benign MARKER echo; custom scripts are an operator decision
  in an authorized engagement/lab. Read `upload-bypass/README.md` before use.
- **Standards registry (WSTG/ASVS/CWE/API-Top10):** `tools/test-registry.json` maps each vuln class to
  methodology pointers. `map.js candidates <host>` returns a `refs` block per class (testers read the
  standard first); `record-finding.js` accepts `"class":"idor"` (validated against the registry) and
  auto-attaches a `standards` block (or derives it from `cwe`). Unknown class = recording refused.
- **ATT&CK coverage matrix:** `node tools/attack-coverage.js [--host <h>] [--json] [--write]` — the
  offensive-coverage view per MITRE ATT&CK technique, from `test-registry.json` (`attack` per class +
  `extra_surfaces`). PLANNED = techniques reachable by a harness class; EXECUTED = techniques recorded
  on `findings.jsonl` (an explicit `technique: T####` wins, otherwise the finding's `class` is mapped
  through the same registry). `--write` emits `reports/attack-matrix.md` — a report-gate (P3) input;
  run it before the report gate, like `coverage.js <host> --write`.
- **Privilegi minimi dei binari di attacco (niente prompt di password):** `node tools/capcheck.js`
  dice lo stato REALE — `net.ipv4.ip_unprivileged_port_start` e le capability per binario — con
  `--json`, `--quiet`, `--mode network|wireless|host` e `--require <mode>` (preflight, esce 1 se la
  modalità non è operativa; `--require` con una modalità inesistente esce 2). Scrive
  `reports/tmp/cap-state.json`. È il modo onesto di sapere se un tool gira davvero senza sudo: le
  capability spengono a ogni `apt upgrade`, e proseguire convinto del contrario costa un fermo a
  metà engagement. **Non è un fail-closed sul target**: dice cosa manca *sulla macchina*, quindi
  lanciarlo non è un'azione d'attacco. Applica con `sudo ./grant-tool-caps.sh [--check|--print]`.
- **Manifest e piano dei privilegi (sorgente unica):** `tools/cap-manifest.json` dichiara, per
  binario, le capability minime e **perché** servono; `tools/cap-plan.js` lo valida e lo rende un
  piano piatto (TSV per lo shell, `--json` per il resto) che consumano sia l'installer sia
  `capcheck.js`. Ogni capability concessa a mano e non dichiarata qui è drift, e come tale
  visibile. Un manifest rotto esce 3 senza applicare nulla.
- **Knowledge retrieval:** `node tools/kb-search.js index` builds an FTS5 index over `knowledge.md` +
  `docs/**/*.md` (`--docs` adds `reports/*.md`); `node tools/kb-search.js "query terms" [--limit N]`
  returns heading-scoped snippets — use it instead of re-reading the whole methodology.
- **HTML report:** `node tools/report-html.js [--findings <f>] [--state <db>] [--sploit <j>] [--out <f>]`
  -> standalone HTML (severity + CVSS + CWE + EPSS + chains + recon). Markdown remains the source of truth.
- **SARIF export (interoperabilità):** `node tools/report-sarif.js [--findings <f>] [--out <f>] [--host <h>]`
  -> SARIF 2.1.0 da `findings.jsonl`, per GitHub code scanning / DefectDojo / qualsiasi SIEM
  (`--out -` va su stdout). Ogni result porta in `properties.stavros` cio che SARIF non ha un
  campo per: `verify_level`, il suo `severity_ceiling`, `status`, `oracle_ref`/`oracle_type`,
  il blocco `verify` rieseguibile e `evidence_ref`. **Rifiuta** un record la cui severity eccede
  il `verify_level` (stessa regola di `record-finding.js`) e in quel caso **esce 2**: un run che
  ha perso record non può presentarsi come scan pulito. Un finding senza `verify_level` esce
  come `unclassified`, mai promosso. Zero dipendenze, offline.
- **Attack galaxy (shape view):** `node tools/attack-galaxy.js [--findings <f>] [--out <f>] [--host <h>]`
  -> `reports/attack-galaxy.html`, a self-contained force graph of the engagement: host nodes sized by
  finding count, finding nodes coloured by severity, magenta edges = the attack chains `chain.js` found.
  Drag/pan/zoom, click for the full PoC + remediation, filter by severity, chain membership or day.
  `--print` dumps the host rollup on stdout. Zero deps and ZERO egress: no CDN, no remote font, no
  remote asset of any kind (asserted by `test-attack-galaxy.js`), so the file works air-gapped; the
  layout seed is derived from the corpus, so the same findings always draw the same picture.
- **Breach hunting (OSINT):** `node tools/run.js h8mail -t <email> -sk -j reports/tmp/h8mail-<ts>.json`
  — lookup email/password nei breach (HIBP v3, Snusbase, Leak-Lookup, Hunter.io o dump locali via
  `-lb`/`-bc`/`-gz`; BSD-3). run.js estrae il **dominio** da `user@dom` (args, stdin, file `-t`) e lo
  scope-checka: email di domini fuori scope, o target senza dominio/IP (username nudi), falliscono in
  fail-closed. `-j` scrive JSON — normalizza con `parsers.js parseH8mailJson`; hit confermati →
  `record-finding.js` con campo `secret` (loot vault). Chiavi API via `-k "hibp=...,snusbase=..."` o file
  config `-c`; `-q username|ip|hash|domain` per query non-email (l'IP viene scope-checkato, username no).
- **Record a finding:** `node tools/record-finding.js '{"severity":"High","title":..,"host":..,"endpoint":..,"poc":..,"status":"confirmed","cvss":8.1,"cvss_vector":"AV:N/...","cwe":"CWE-200","cve":"CVE-2021-44228","remediation":"..."}'`
  → appends to `reports/findings.jsonl` (deduped). Evidence in `poc`/`remediation`/`notes` is
  auto-redacted (JWTs, cookies, `Bearer` tokens, API keys stripped) before it hits disk. Do this for
  EVERY confirmed finding. If a finding carries a `secret` field (a looted hash/key/token), the raw
  material is written to the gitignored loot vault `reports/loot.jsonl` and the finding keeps only a
  `secret_fingerprint` + `loot_id` — never put raw secrets anywhere else.
- **Active Directory orchestrator:** `node tools/ad.js <op> <host> [opts]` — structured, scope + tier
  gated AD front end (the AD analog of wifi.js; see docs/host-exploitation.md for relay/coercion).
  Ops: `enum` `roast` `adcs` `bloodhound` `enum-relay` `enum-coerce` `enum-delegation` `enum-mssql`
  (AUTO) · `dcsync` `secretsdump` `coerce` `relay` (CONFIRM, need `--confirm "<reason>"`;
  coerce/relay also need a listener registered in `reports/sessions.json`). Passwords via `--pass-file`.
- **Service-surface planner + workflows:** `next-actions.js` proposes single read-only presence probes
  for open non-HTTP ports (21 ftp, 161 snmp, 1433 mssql, 2049 nfs, 2375/2376 docker, 6379 redis,
  9200/9300 elasticsearch, 10250/10255 kubelet, 27017 mongo) — one request each, no credentials, and an
  action is suppressed when the port is already covered. The proposals target the `workflows/enum-*.yaml`
  seeds (`enum-redis`, `enum-mongo`, `enum-container`, `enum-snmp`, `enum-mssql`); run one with
  `node tools/workflow.js run workflows/enum-<x>.yaml -t <host>` (dry-run supported). Container/K8s
  output is ingested with `node tools/target-model.js ingest container <file> --target <host>` and shows
  as the `container` coverage row.
- **Subdomain takeover + DNS hygiene:** `node tools/takeover.js scan <domain>` (detection-only, read-only)
  — reuses existing recon subs (no new massive resolution), resolves CNAME/HTTP against provider
  placeholder fingerprints, and runs SPF/DMARC/AXFR/wildcard checks; writes `reports/takeover-<domain>.json`.
  Takeover claims are `suspected` + single-request verify; the claim-check PoC stays a manual operator step.
- **Mobile (Android):** `node tools/mobile.js <check|status|static|surface|fetch-apk|firebase-audit|install|shell|frida|intercept|ca-install|reset>`.
  Targets are packages/adb serials/APK hashes from `mobile-scope.json` (separate scope, fail-closed).
  `fetch-apk` downloads only from a declared `apk_sources` URL and refuses on sha256 mismatch;
  `frida` picks the hook from the static pass (Flutter → `disable-flutter-tls.js`, PairIP → repack hint);
  `surface` records exported components/deeplinks into `reports/<pkg>-map.json`; `firebase-audit` does
  ONE read-only existence probe per Firebase asset. Full detail in docs/mobile.md.
- **Autopilot (opt-in):** `node tools/autopilot.js` — the deterministic outer control loop
  (plan/loop/stop/checkpoint) for a long engagement; it runs other tools through the guarded
  entrypoints and *returns* directives instead of calling a model, so the flow is replayable and
  fail-closed. `tools/autopilot-checkpoint.js` persists the checkpoint it resumes from.
- **Test gate:** `node tools/run-tests.js` discovers `tools/test-*.js`, classifies each by its
  `// test-tags:` header (offline / loopback / e2e) and runs them with a per-test timeout; it is
  the only gate (`npm test`). `--jobs N` sets the workers (default 2), `--only <substring>`,
  `--list`, `--json`, `--e2e`. A test that rewrites an engagement file (`scope.json`, `auth.json`…)
  is reported as a violation, not just a failure.
- **Release verification:** `node tools/verify-tag.js [ref]` clones the ref into a temp dir and runs
  the four release gates **in that clone** (`test-repo-invariants`, `doctor --check`, `check-identity`,
  `npm test`), printing the commit it resolved and a per-check line; exit 1 keeps the clone for
  diagnosis. Defaults to the last tag; `--remote` clones from `origin` instead of the local repo,
  `--repo <path>` / `--ref <r>` point elsewhere, `--keep` leaves the clone. Why it exists: a tag
  measured in the working tree is not verified — `v0.1.0` was declared green that way, and a clean
  clone of the same tag had a red gate.
- **Agent forum (identità firmata, una sola iscrizione per credenziale):** per far collaborare più
  agenti su un ambiente simulato, ognuno con una identità che non può duplicare né rubare.
  L'invariante ("una sola identità, nessuna impersonation") è imposto dal **server**, non dal prompt:
  il prompt dice *cosa fare*, il server dice *chi sei* — quindi regge anche sotto prompt injection.
  - `node tools/forum-server.js mint --label <ruolo>` — l'operatore emette **un** token single-use
    (fuori banda: l'agente non può coniarsene uno). `--port N` / `serve` per il servizio (loopback
    only, porta effimera di default, endpoint in `reports/tmp/forum/endpoint.json`), `roster`,
    `verify`.
  - `node tools/forum.js enroll --token <T> | whoami | post "<testo>" | read [--since N] | keyring` — l'unica
    superficie che il modello vede. **Non esistono `--as` né `--print-key`**: l'`agent_id` è derivato
    dal keyfile, ogni post firma autore+timestamp+nonce+hash del corpo con Ed25519. Quindi
    impersonare non è *vietato*, è non scrivibile; e nessun verbo stampa il segreto. `keyring` dice
    dove sta la chiave senza rivelarla (vedi `forum-keystore.js` sotto).
  - `node tools/forum-sim.js run [--agents N]` — N agenti in **processi separati**, due round
    (osservare, poi rispondere), su un ambiente simulato in mkdtemp. Riporta
    `agents_that_replied_to_another` (deve valere `agents_enrolled`: la collaborazione si misura
    sui messaggi che citano un altro autore) e `rogue_refused / rogue_attempts` (ri-iscriversi,
    impersonare, replay, body-tamper: devono essere respinti **tutti**). Exit 1 se un invariante cede.
  - Bootstrap dell'agente: `skills/agent-forum/SKILL.md`. Prove: `tools/test-agent-forum.js`.
- **Agent identity custody (`forum-keystore.js`):** where the agent's private key lives and whether it is
  readable. `0600` is a **permission, not an encryption** — a reader of the filesystem, or an
  external observer (the case in a purpose-built study environment), got the key in plaintext. Three
  backends, chosen by availability, never plaintext-if-something-better-exists:
  - **`linux-keyring`** (default where `keyctl` exists) — the key lives in the kernel user keyring and
    is **never written to disk**. On disk there is only `{agent_id, backend, keystore:{desc,ring}}`. UID-scoped
    and volatile: it dies with the session, so the identity must be re-seeded. Strongest, and the most awkward.
  - **`passphrase`** — key on disk but **encrypted at rest**: AES-256-GCM under a scrypt(N=2^14,r=8,p=1) key,
    fresh salt per instance. Disk holds salt, iv, auth tag, ciphertext. The passphrase arrives out of band
    (`FORUM_KEYSTORE_PASSPHRASE`, `..._FILE`, or a hidden TTY prompt) and is **never** in the keyfile or the
    prompt. Portable and persistent.
  - **`plaintext`** — pre-keystore keyfile, kept for compatibility and for minimal containers/CI.
    `node tools/forum.js keyring` reports it as `encrypted_at_rest: false`, so it is declared, not silent.
  Fail-closed in two places: no passphrase means no enrollment (signing in plaintext is worse than not
  signing), and a wrong passphrase is **indistinguishable** from a tampered ciphertext — AES-GCM rejects
  both the same way, so the error is not an oracle.
  Env: `FORUM_KEYSTORE` (force a backend), `FORUM_KEYSTORE_PASSPHRASE`, `FORUM_KEYSTORE_PASSPHRASE_FILE`.
- **Documentation index:** `node tools/docs-index.js` regenerates `docs/INDEX.md` from the real files
  (title, first paragraph, size, plan checkbox progress); `--check` writes nothing and exits 1 when the
  index is stale, which is what `test-repo-invariants` runs. The superseded plans it lists live in
  `docs/archive/`, with the landing evidence for each move in `docs/archive/README.md`.