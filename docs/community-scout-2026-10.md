# Community scout — Reddit pentest/redteam, ottobre 2026

> **Metodo e limiti.** Reddit non è leggibile direttamente da questo ambiente (login wall e
> anti-bot su `reddit.com`, `old.reddit.com` e sui mirror). Il discovery è quindi passato da
> ricerche indicizzate (`site:reddit.com/r/redteamsec`, `r/Pentesting`, `r/netsec`,
> `r/cybersecurity`, `r/hackthebox`, `r/ReverseEngineering`) e **ogni progetto è stato poi
> verificato sul repository GitHub** — README, licenza, feature. I thread di commenti non sono
> stati letti per intero: la sezione "sentiment" in fondo riporta solo ciò che emerge da titoli
> e snippet, ed è marcata come tale. Scansione mirata, non esaustiva: i post citati vanno da
> febbraio 2026 (Praetorian) a ieri (AgentVetter, Super Trouper).
>
> Scritto il 2026-10-04. Contesto: `docs/TOOL-ALTERNATIVES-AUDIT.md` (2026-10-01) copre già
> schemathesis, h2csmuggler, netns, trufflehog, Camoufox, WPScan, SARIF. Qui c'è **ciò che
> l'audit non poteva sapere**: i rilasci delle ultime settimane e il filone AI-agentic visto
> dalle community.

---

## TL;DR — le cinque cose che contano

1. **Violin** (MIT) è il progetto pubblico più vicino alla nostra tesi: pentest agentico
   *supervised*, guardia obbligatoria al confine di esecuzione, finding legati a **ricevute
   di esecuzione firmate**. Non è un concorrente da adottare — è un dizionario di idee da
   confrontare con Ondata 7 (§1).
2. **Praetorian ha tre binari Go Apache-2.0 registrabili subito** — Brutus (credenziali,
   43 protocolli), Titus (segreti con validazione live + estrazione da binari/APK),
   Augustus (robustezza LLM, 210+ probe). Zero dipendenze, `go install`, si innestano nel
   pattern `install-tools.sh` + `tool-registry.json` (§2).
3. **XXERipper** (GPL-3.0) porta idee anti-falso-positivo che valgono oltre l'XXE: gating a
   indicatori multipli, fingerprinting differenziale dei parser, baselining statistico con
   veto graduati (§3).
4. **Sul versante AI/agentico** (OPFOR, AgentVetter, Super Trouper) il tema ricorrente è
   "attaccare la superficie agentica prima di montarla": suite OWASP Agentic/MCP, judge
   trace-aware, vetting sandbox di server MCP e skill (§4).
5. **Sul versante gestione engagement** (Red Clippy, Numasec, Laelaps) le idee migliori sono
   doctrine-in-handshake MCP, separazione observation/asset, metriche di copertura oneste e
   console attack-path interattiva (§5).

---

## 1. Violin — `Strategic-Automation/violin` (MIT, Python/Hermes)

- Post: r/redteamsec + r/SideProject, ~metà settembre 2026 — "I built Violin — an open-source
  AI pentesting workflow with scope checks and reproducible findings".
- Repo: <https://github.com/Strategic-Automation/violin> · benchmark doc:
  <https://github.com/Strategic-Automation/violin/blob/master/docs/BENCHMARKS.md>

È un profilo per l'agente Hermes (≥0.18), non un harness autonomo: fase
`SCOPING → RECON → VULN_RESEARCH → EXPLOITATION → POST_EXPLOITATION/PRIVESC/FLAGS → REPORTING
→ RETROSPECTIVE`, con un plugin `violin-guard` **obbligatorio** al confine di esecuzione
(12 tool registrati, nessuna allowlist di binari). Il confronto con noi è interessante proprio
perché le scelte sono vicine ma non identiche.

### Cosa hanno che noi non abbiamo (o abbiamo in forma diversa)

| Idea Violin | Stato in Cyboros | Cosa vale la pena prendere |
|---|---|---|
| **Ricevute di esecuzione firmate**: `violin_submit_finding` non accetta un finding senza una o più ricevute firmate che contengono la richiesta/risposta decisiva; la guardia **autentica ricevute e digest delle evidenze prima di appendere** a `evidence/findings.jsonl`; `evidence_outputs` dichiara nella stessa esecuzione i file il cui digest entra nella ricevuta | Ondata 7 (spec 2026-09-28, file in worktree: `chain-log`, `verification-log`, `effective-findings`, `rechain`) costruisce catena + side log + fold con ri-validazione di oracle e quote. Noi **rieseguiamo** la prova; loro la **autenticano** | Confronto diretto: la nostra catena dà integrità, la loro ricevuta dà anche *autenticità* (chi ha prodotto la prova, con digest dei byte salvati). Da decidere se il record di verifica debba referenziare i digest degli artefatti, e se `evidence_outputs` vada aggiunto al wrapper di esecuzione |
| **PTT (Pentest Task Tracking) con gating di fase**: una fase nuova richiede un task attivo sotto quella fase; i task non si spostano tra sezioni | Abbiamo coverage matrix, stage gate, workflow `enum-*`/`attack-*` | Il check "nessuna fase senza task" è piccolo e falsificabile: impedisce la deriva di fase che oggi il gate non vede |
| **Hypotheses ledger** (file separato, aggiornato quando l'evidenza cambia stato) | Non esiste un livello ipotesi distinto dal finding `suspected` | Un ledger di ipotesi è economico e sopravvive alla compressione del contesto; utile anche per il planner |
| **Batch review**: `exec_burst` → `review_batch` → settle; `rebind_pending_batch`, `heartbeat_done`; un solo modello di stato per comandi, burst, background, cancellazione | Consent token per il tier confirm; niente cadenza di review per l'active tier | Idea per la Command Center: review post-batch (leggera) accanto al gate dei token (pesante) |
| **Stato engagement su disco** che riprende dopo context compression | Campagne/missioni + `state.db` | Verificare che anche il nostro runner locale abbia un percorso di resume esplicito |
| **Benchmark**: calibrazione `known-good`/`known-bad` (il known-bad **deve** prendere zero credito), valutatore host-side assente dal container dell'agente, aggregazione multi-run (`mean pass@1`, `pass@k`, `pass^k`), metrica `unreported_demonstrated_ids` = gap tra ciò che il run ha **provato** e ciò che ha **sottomesso**, contratto di parità con Escape `escape-duck-store-2026-04` (20 casi) | `BENCHMARK.md` + `gen-bench.js` + `bench-provenance.js`; publish line con seed/agente/modello | **Il pezzo più alto-valore di tutta la scansione**: fixture negative di calibrazione, aggregazione multi-run, e soprattutto il gap *dimostrato vs sottomesso* — è il fratello automatico della nostra metrica di suppression |
| **Release gate unico** (`check-release`: registrazione plugin, schemi, snapshot skill, contratti di documentazione, lint, test) | `test-repo-invariants.js` + `doctor.js` | Da confrontare: se il nostro gate è sparso, un comando unico riduce l'attrito |
| **Reviewer kit** pubblicato per la valutazione indipendente (limiti noti + confronto con design autonomi) | `docs/LAUNCH-PLAN.md` ne ha l'esigenza | Articolo/pagina con limiti dichiarati e confronto: coerente con la nostra disciplina |

### Nota di onestà reciproca

Violin scrive nero su bianco che il gancio raw-terminal è "a best-effort safety net, not
network containment" — lo stesso caveat del nostro `SECURITY.md`. Per noi il passo più forte
resta il guard netns dell'audit (§1.4), non un gancio nel processo dell'agente.

---

## 2. Praetorian — tre binari Go da registrare (tutti Apache-2.0)

Post r/redteamsec, febbraio–marzo 2026; repo attivi adesso. Stesso profilo del nostro
installer: `go install`, singolo binario, zero dipendenze, output JSON/JSONL.

### Brutus — credential testing multi-protocollo
<https://github.com/praetorian-inc/brutus>

- 43 protocolli (SSH, RDP, MySQL, PostgreSQL, MSSQL, Oracle, Redis, SMB, LDAP, WinRM, SNMP,
  Docker, K8s, MQTT, Kafka, …), modalità `cautious|default|aggressive`, SOCKS5.
- Pipeline nativa: `naabu → nerva → brutus creds --json`; import di nmap XML e masscan JSON
  (mappa da solo `ms-wbt-server → rdp`, ecc.). Output **solo successi** in JSONL.
- `badkeys` (chiavi SSH note: Vagrant, F5, ExaGrid), enumerazione account (Kerberos,
  Teams/Entra device code), `--experimental-ai` per credenziali default su pannelli web.
- **Per noi**: è l'alternativa moderna a `medusa`/`hydra` (oggi registrati come `intrusive`).
  Tier `intrusive`, `alternative` dichiarata, un workflow `attack-creds` che parte dall'output
  di nmap/naabu che già produciamo. Il JSONL di successo alimenta l'oracle (ri-autenticazione)
  senza parsing di prosa.

### Titus — secrets scanner con validazione live
<https://github.com/praetorian-inc/titus>

- 487 regole (NoseyParker + Kingfisher), matching accelerato Hyperscan/Vectorscan con
  fallback pure-Go, **validazione live** delle credenziali, score 0–100 con modificatori
  (contesto di accessibilità pubblico/privato), `--score-scope` con enumerazione IAM (AWS) e
  permessi repo (GitHub PAT).
- **Estrazione da binari**: Office, PDF, archivi, SQLite, email, **APK/IPA**, extension; scan
  di immagini Docker/OCI **incluse le layer cancellate**; estensioni Burp e Chrome; output
  SARIF.
- **Per noi**: l'audit §6.2 vuole un passo di *validazione* (`trufflehog`) dopo
  `analyze-bundle.js`. Titus copre lo stesso buco con in più l'estrazione da APK/IPA (mobile)
  e lo scoring d'impatto — più vicino alla nostra tesi "severità ≤ evidenza" di quanto lo sia
  trufflehog. Da valutare come validatore o come `alternative` dichiarata.

### Augustus — LLM vulnerability scanner
<https://github.com/praetorian-inc/augustus>

- 210+ probe in 47 categorie (jailbreak, prompt injection, encoding, data extraction, agent
  attacks, guardrail bypass), 90+ detector, 28 provider **inclusi Ollama e REST custom**,
  buff di trasformazione (encoding, poesia, traduzione), strategie multi-turno
  Crescendo/GOAT/Hydra/Mischievous, output HTML/JSON/JSONL, singolo binario Go.
- **Per noi, due usi**:
  1. **Self-test** del nostro layer LLM: i contenuti dei target sono ostili e il modello locale
     è esposto a prompt injection. Puntato su Ollama/REST locale non esce dalla macchina —
     dialogo diretto con `docs/THREAT-MODEL.md`.
  2. **Testing di target LLM** più profondo di `llm-inject.js` + `payloads/llm-agentic.md`.
- **Idea da rubare**: il judge *trace-aware* (giudica le tool call, non solo il testo) è la
  forma giusta per l'oracle di un finding LLM; il report del **costo per run** (token e $
  per modello) è un tocco che i nostri report potrebbero avere.

> Nota egress: Augustus verso provider hosted è egress (chiave API, prompt fuori). Con Ollama/
> REST locale no. Stessa disciplina di `docs/egress-opsec.md`.

---

## 3. XXERipper — idee anti-FP oltre l'XXE (GPL-3.0, Python)

- Post: r/redteamsec + r/coolgithubprojects, fine settembre 2026.
- Repo: <https://github.com/kamalx06/XXERipper> (PyPI: `pip install xxeripper`; httpx+Flask,
  single-file).

Cosa fa di diverso, in ordine di quanto ci serve:

- **Gating a indicatori multipli**: "no single string match triggers a finding" — un finding
  nasce solo da più segnali concordanti. È la stessa disciplina del nostro tetto di severità,
  applicata alla *rivelazione*: da riusare come concetto nei probe oltre l'XXE.
- **Fingerprinting differenziale dei parser**: 11 stack XML (libxml2, Xerces, .NET, Java,
  Python, PHP, Ruby, Node, Perl, Go) con coppie test/controllo e cache su disco. Riduce i
  falsi positivi spiegando *quale* parser ha risposto.
- **Baselining statistico**: mediana, IQR, p95, entropia a finestra, con veto graduati — il
  rumore viene respinto senza sopprimere i veri positivi.
- **Coverage reporting**: ogni fase non eseguita è elencata con il motivo ("clean" ≠
  "incompleto"). Da confrontare con la nostra coverage matrix.
- **Catene a impatto** (XXE → IMDS → credenziali AWS → ATO; ~10 template) con estrazione del
  loot e snippet pronti — parente stretto di `chain.js`.
- **Ordine WAF-bypass**: prima le fasi core (~20 richieste), poi gli encoder (~1.500), così un
  hit diretto non resta sepolto.
- **Pre-auth replay** di richieste Burp (multi-step login), budget wall-clock, rate limit.
- Output JSON/SARIF/HTML, console web locale.

**Adozione**: come tool esterno `run.js` va benissimo (CLI separata, GPL ok per uso da
processo); **mai vendorizzato**. Le *idee* (gating multi-indicatore, fingerprinting
differenziale) sono la parte che vale di più e non hanno licenza.

---

## 4. Superficie AI/agentica: OPFOR, AgentVetter, Super Trouper

### Agent OPFOR — `KeyValueSoftwareSystems/agent-opfor` (Apache-2.0, TypeScript)
<https://github.com/KeyValueSoftwareSystems/agent-opfor>

- Adversary emulation per agenti AI/LLM app/server MCP: suite OWASP LLM Top 10, **Agentic AI
  Top 10**, **MCP Top 10**, API Top 10, bias EU AI Act; judge LLM; report HTML/JSON.
- Cinque entry point (CLI, browser extension, **MCP server**, skill, SDK); `opfor hunt` =
  campagna multi-agente autonoma (commander/operators/scout); **costo per run** contato per
  modello (attacker vs judge).
- **Trace-aware**: collegato a Langfuse/Netra il judge vede tool call e retrieval, non solo la
  risposta — intercetta PII che passa in una tool call senza arrivare all'utente.
- **Per noi**: (a) la mappatura dei test: i nostri `payloads/mcp.md` e `llm-agentic.md` sono
  detection-only e più stretti — le due suite OWASP Agentic/MCP sono un dizionario di probe
  con zero codice; (b) il judge trace-aware è l'evoluzione giusta dell'oracle LLM; (c) come
  tool esterno è npm/hosted — non adottabile dentro l'harness zero-dep.

### AgentVetter — `neomatrix369/AgentVetter` (MIT, nuovo)
<https://github.com/neomatrix369/AgentVetter> — post r/Pentesting di ieri.

Scansiona in sandbox (Modal) server MCP, **AI skills** e alberi di pacchetti con più scanner
(Snyk, Cisco, Tessl), con enfasi dichiarata sulla "coverage honesty". Piccolo (11★), ma il
concetto è il pezzo mancante del nostro guard plane: `mcp-guard-proxy` giudica ogni
`tools/call` **a runtime**; un passo di **vetting pre-mount** del server di terze parti è un
livello diverso. Riferimenti più maturi per lo stesso lavoro: `cisco-ai-defense/mcp-scanner` e
`snyk/agent-scan`.

### Super Trouper — `crissyfield/super-trouper` (release v0.4.0, ieri)
<https://github.com/crissyfield/super-trouper>

- MCP server **single-binary** che espone Frida agli agenti di coding per reverse engineering
  autorizzato di app **iOS**. Pattern architetturale: tool-surface complessa incapsulata in un
  server MCP che l'agente consuma a linguaggio naturale.
- **Per noi**: il mobile attuale è Android; questo è il riferimento per un eventuale track iOS
  e un buon esempio di come impacchettare una capacità (Frida) per gli agenti.

---

## 5. Gestione engagement: Red Clippy, Numasec, Laelaps

### Red Clippy — `CSPF-Founder/red-clippy` (GPL-3.0, Rust)
<https://github.com/CSPF-Founder/red-clippy>

- Pentest management **MCP-first** (SQLite + UI locale): scope/asset, observation, coverage
  (135 check WSTG + recon/network/cloud/OSINT), finding con CVSS 3.1/CWE/CVE/PoC/evidenza,
  **attack graph**, dashboard cross-engagement, multi-org.
- **Ingestion parser** per `nmap`, `burp`, `nessus`, `openvas`, `masscan`, `naabu`,
  `subfinder` con auto-detection — un agente butta l'output grezzo e il record si popola.
- **Red Team Instructions** consegnate **nell'handshake MCP** (per-engagement → org →
  built-in): la dottrina arriva al contesto dell'agente prima della prima tool call.
- **Per noi (idee, non codice)**: doctrine-in-handshake per `mcp-bridge.js`; separazione
  observation/asset (il rumore di recon non entra nello scope); i parser di ingestion come
  percorso di prima classe; la vista cross-engagement per i retest.

### Numasec — `FrancescoStabile/numasec` (AGPL-3.0, TypeScript/Bun)
<https://github.com/FrancescoStabile/numasec>

- Agente di sicurezza da terminale con "cyber operation kernel": target → operation → posture →
  runbook → tool locali → evidence → observations → findings → replay → report; operazioni
  durabili e ripristinabili, bundle di condivisione.
- Linguaggio che ci riguarda: "**weak signals can stay weak. Rejected claims remain visible.
  Reportable findings need proof.**" — la nostra stessa scala, detta in tre righe.
- **Knowledge broker** che separa *possibility* da *applicability* (KEV/EPSS) per un componente
  osservato — framing utile per `kb-search`/Radar: la possibilità CVE non è il finding.
- **Per noi**: stato di replay per finding (vicino a `verification-log`), "share bundle"
  (abbiamo gli evidence bundle), e il framing possibility/applicability nei report.

### Laelaps — `jydae/laelaps` (Apache-2.0, Swift)
<https://github.com/jydae/laelaps> — post r/Pentesting/r/hackthebox di 3 giorni fa.

- Console di **attack-path analysis per AD**: ingerisce collezioni SharpHound e
  bloodhound-python, mostra la directory come grafo; marchi come "owned" un oggetto che
  controlli e **ricalcola i percorsi di escalation** fino al controllo di ogni dominio, con la
  tecnica di ogni passo; controlli un altro oggetto e i percorsi si aggiornano.
- Stack (Swift/Hummingbird + Elasticsearch + React/Blueprint/cosmos.gl) **non adottabile** in
  un harness zero-dep; l'idea UI però sì: la vista Graph della Command Center guadagna un
  "what-if" (posseduto → percorsi che si ricalcolano) che oggi non ha.

---

## 6. Sentiment dalle community (fonte: titoli/snippet, thread non letti per intero)

- **"Reflecting on RSAC 2026 — Is Agentic Pentesting just VA?"** (r/Pentesting): la domanda se
  gli agenti siano solo vulnerability assessment è esattamente il buco che la nostra tesi
  attacca — argomento di posizionamento, non codice.
  <https://www.reddit.com/r/Pentesting/comments/1s4filz/reflecting_on_rsac_2026_is_agentic_pentesting/>
- **"Local LLMs for penetration testing: real-world performance"** (r/Pentesting): nel thread
  emerge che i modelli locali non stanno al passo con i frontier su velocità e ragionamento —
  coerente con la nostra nota onesta sulle HTB e con le aspettative del runner `local/`.
  <https://www.reddit.com/r/Pentesting/comments/1snwx8p/local_llms_for_penetration_testing_realworld/>
- **"Model cybersecurity restrictions for AI pentesting agents"** (r/Pentesting): i safeguard
  dei provider bloccano prompt cyber; argomento a favore del modello locale air-gapped.
  <https://www.reddit.com/r/Pentesting/comments/1vs7hqt/model_cybersecurity_restrictions_for_ai/>
- **Workflow Claude Code/Codex per pentest e bug bounty** (r/cybersecurity, r/bugbounty):
  l'adozione reale oggi è "agente dentro il flusso", con Numasec citato — conferma la nicchia
  supervised/verificata che occupiamo.
  <https://www.reddit.com/r/cybersecurity/comments/1ukdicf/using_claude_codecodex_for_pentesting/>
  <https://www.reddit.com/r/bugbounty/comments/1varh6i/been_using_claude_code_for_bug_bounty_for_4/>
- **r/netsec monthly discussion & tool thread** (ultimo mese): non leggibile da qui, ma è la
  fonte periodica giusta da monitorare per il prossimo giro.
  <https://www.reddit.com/r/netsec/comments/1w4c1cg/rnetsec_monthly_discussion_tool_thread/>

---

## 7. Cosa NON prendere

- **Laelaps come stack**, **Red Clippy/Numasec come codice** (GPL/AGPL + runtime estraneo):
  solo idee.
- **OPFOR come dipendenza**: npm/TypeScript, attacker+judge su LLM hosted (egress). Riferimento
  per le suite, non da montare.
- **Full DAST / estensioni Burp** (BurpAPISecuritySuite, il DAST AI con MITM proxy): centrati
  su Burp, fuori dal nostro modello di guardie.
- **EDR/WFP e primitive di evasion** (DutchOven, thread "EDR Blinding"): fuori dallo scope
  attuale (web/host autorizzato, OPSEC sì, evasione EDR no).
- **Mythic agent creato via prompt**: curioso, non pertinente.
- Già valutato nell'audit: respinti Prowler, MobSF, vector DB e le DAST platform;
  raccomandati e ancora da fare schemathesis e il guard netns. Vedi
  `docs/TOOL-ALTERNATIVES-AUDIT.md`.

---

## 8. Priorità per Cyboros

Ordinate per valore/costo, dentro i vincoli (zero-dipendenze npm, Node ≥ 22, registry dei
binari, egress disciplinato).

| # | Azione | Costo | Valore |
|---|---|---|---|
| 1 | **Benchmark hardening** dalle idee Violin: fixture negative (`known-bad` → zero credito), aggregazione multi-run (`mean pass@1`, `pass^k`), metrica **dimostrato vs sottomesso** | S–M, zero deps | Renderebbe misurabile il gap che oggi pubblichiamo solo come soppressione |
| 2 | ✅ **Fatto 2026-10-04** — `brutus` registrato (go install, registry `intrusive`, estrazione host in `run.js`, workflow `attack-creds` confirm-tier) | S | Sostituisce medusa/hydra con un binario Go JSONL; l'oracle può ri-autenticare |
| 3 | ✅ **Fatto 2026-10-04** — `titus` registrato (registry `read`, docs con disciplina egress su `--validate`/`--score-scope`); restano da valutare in un secondo tempo `--extract=all`, OCI e SARIF | S–M | Chiude il buco `suspected → exploited` sui segreti con in più lo scoring d'impatto |
| 4 | **Registrare `augustus`** + workflow di self-test sul modello locale (Ollama/REST) | M | Copre il threat model "contenuto ostile → agente" con un tool esterno, senza egress |
| 5 | **Ricevute/videnze**: decidere se il record di verifica di Ondata 7 deve autenticare i **digest degli artefatti** (modello Violin) e aggiungere `evidence_outputs` al wrapper di esecuzione | S (decisione) + M (se fatto) | Terza parte che ri-autentica la prova senza rieseguirla |
| 6 | **XXERipper**: idee multi-indicatore / fingerprinting differenziale nella classe XXE; oppure tool esterno `pipx` | M | Meno FP per classe (non solo XXE) |
| 7 | **MCP pre-mount vetting**: documentare/passare un vet step per server di terze parti (riferimenti: mcp-scanner Cisco, agent-scan Snyk, AgentVetter) | M | Completa `mcp-guard-proxy` (runtime) con un controllo prima del mount |
| 8 | **Command Center**: ingestion parser (Red Clippy) e vista Graph con "owned → percorsi ricalcolati" (Laelaps) | M–L | Due feature visibili, una per l'operatore e una per l'analisi |
| 9 | **Radar**: seed curato (org `praetorian-inc`, `super-trouper`, …) oltre alle topic query; fonte Reddit come estensione separata | XS | `tools/radar-scout.js` interroga già i topic GitHub; qui si aggiunge il canale community |

Nota su Radar: il pipeline esiste (`radar-scout` → `radar-analyst` → `radar-profiler`) e
l'indice segnala che il piano radar ha 26 check aperti ma i tool sono atterrati. Aggiungere
questi candidati come seed/cache è il modo naturale per non ri-scoprirli la prossima volta.

---

## Appendice — tabella progetti

| Progetto | Licenza | Linguaggio | Post | Verdetto |
|---|---|---|---|---|
| [Violin](https://github.com/Strategic-Automation/violin) | MIT | Python/Hermes | set 2026 | **Borrow** (ricevute, PTT, benchmark) |
| [Brutus](https://github.com/praetorian-inc/brutus) | Apache-2.0 | Go | feb 2026 | **Adopt candidate** |
| [Titus](https://github.com/praetorian-inc/titus) | Apache-2.0 | Go | feb 2026 | **Adopt candidate** (alternativa trufflehog) |
| [Augustus](https://github.com/praetorian-inc/augustus) | Apache-2.0 | Go | feb 2026 | **Adopt candidate** (self-test LLM) |
| [XXERipper](https://github.com/kamalx06/XXERipper) | GPL-3.0 | Python | set 2026 | Borrow idee / tool esterno |
| [Agent OPFOR](https://github.com/KeyValueSoftwareSystems/agent-opfor) | Apache-2.0 | TypeScript | ago 2026 | Borrow (suite OWASP, judge trace-aware) |
| [AgentVetter](https://github.com/neomatrix369/AgentVetter) | MIT | Python | ott 2026 | Watch |
| [Super Trouper](https://github.com/crissyfield/super-trouper) | MIT | Go | ott 2026 | Watch (track iOS) |
| [Red Clippy](https://github.com/CSPF-Founder/red-clippy) | GPL-3.0 | Rust | set 2026 | Borrow (doctrine, ingestion) |
| [Numasec](https://github.com/FrancescoStabile/numasec) | AGPL-3.0 | TypeScript | 2026 | Borrow (framing, replay) |
| [Laelaps](https://github.com/jydae/laelaps) | Apache-2.0 | Swift | ott 2026 | Borrow (idea Graph) |
