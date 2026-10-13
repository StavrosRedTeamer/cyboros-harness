# Community scout #2 — web, HN e community, 2026-10-04 → 2026-10-09

> **Metodo e limiti.** Secondo giro dopo `docs/community-scout-2026-10.md` (2026-10-04). Reddit non è
> leggibile direttamente da questo ambiente (login wall/anti-bot), quindi il discovery è passato da
> ricerche indicizzate (`site:reddit.com/...`), Hacker News, roundup di settore (Help Net Security,
> GitHub Blog, blog vendor) e — per ogni candidato — **verifica sul repository GitHub** (README,
> licenza, feature, attività). I thread non sono stati letti per intero; le stelle sono indicative e
> datate al momento della lettura. Scritto il 2026-10-09. Qui c'è il **net-new** rispetto a scout #1
> e all'audit `docs/TOOL-ALTERNATIVES-AUDIT.md`: nessuno dei progetti sotto è già nel registry
> (99 binari registrati oggi) né già citato nei due documenti precedenti.

---

## TL;DR — le cinque cose che contano

1. **Vespasian** (Praetorian, Apache-2.0, Go) chiude il buco che `schemathesis` lascia aperto:
   discovery API da **traffico reale** (crawl o import Burp XML/HAR/mitmproxy) → spec
   **OpenAPI/GraphQL SDL/WSDL/.proto**. Pipeline a due stadi — cattura una volta, genera (anche
   offline) quante volte vuoi — è il pezzo upstream che manca fra `map.js`/`target-model.js` e
   `attack-api-stateful`. §1
2. **La pipeline Praetorian si completa**: `nerva` (fingerprint di servizio, 170+ protocolli) e
   `julius` (identificazione di servizi AI: Ollama/vLLM/LiteLLM/60+) sono altri due binari Go
   Apache-2.0 da `go install`, stesso pattern di brutus/titus. §1
3. **AI-Infra-Guard** (Tencent Zhuque Lab, Apache-2.0) copre in un colpo tre item aperti: self-test
   del layer LLM (jailbreak eval + benchmark di *loss-of-control* dell'agente), **vetting
   MCP/server/skills** (14 categorie di rischio, tassonomia T01–T09), scansione di **infra AI
   esposta** sui target (100+ componenti, 2000+ regole CVE). Con limiti dichiarati: nessuna
   autenticazione (solo localhost/lab) e falsi positivi documentati sulle skill. §2
4. **Il "guard plane" è diventato una categoria pubblica.** Anthropic `sandbox-runtime` (bwrap +
   netns rimossa + proxy con *decider*) è lo stampo da copiare per il guard a network namespace che
   l'audit chiedeva (item 6, §1.4); Prismor conferma che "la policy sta fuori dal modello" è la
   direzione del campo. §3
5. **Il conto del mondo reale.** ARTEX (AGPL) è finito in attacchi reali nel settore finanziario
   coreano e l'autore ha dovuto rafforzare le misure anti-abuso; RedAmon (MIT) rivendica 101/104 su
   XBOW **pubblicando la sessione grezza di ogni solve** e un audit di copertura auto-critico di 397
   classi. La tesi "policy nel runtime + evidenza" ha ora sia il contro-esempio sia il modello di
   pubblicazione da studiare. §5

---

## 1. Praetorian, seconda ondata (tutti Apache-2.0, Go, zero dipendenze)

Lo scout #1 ha registrato `brutus` e `titus`; l'org ha **93 repository** e la linea "12 Caesars"
(Apache-2.0 dichiarata per ogni tool) ne ha altri quattro maturi, tutti aggiornati in questa
settimana.

### Vespasian — API discovery da traffico reale
<https://github.com/praetorian-inc/vespasian> · blog: <https://www.praetorian.com/blog/vespasian-api-endpoint-discovery-tool/> (apr 2026)

- Cattura il traffico HTTP con un **crawl headless** (Chrome via go-rod) o lo **importa** da
  Burp Suite XML, HAR 1.2 e dump mitmproxy; classifica REST/GraphQL/WSDL (gRPC opt-in), fa probing
  attivo (OPTIONS, inferenza schema, introspection, reflection) e genera la spec nel formato nativo
  di ciascun tipo: **OpenAPI 3.0, GraphQL SDL, WSDL, .proto**.
- **Due stadi**: `capture → generate`. Il capture file è JSON ispezionabile; `generate` funziona
  **offline** sul capture importato — quindi `read`-tier — mentre `scan`/crawl è `active`-tier.
- Discipline che ci riguardano: **SSRF protection** (blocca private/loopback di default, flag
  esplicito per i target interni), **gating same-origin** di ogni probe (un URL assoluto di
  attaccante recuperato da un bundle JS non viene sondato), niente download di browser da mirror
  terzi salvo opt-in, telemetria Chrome disabilitata, supporto proxy http/socks5.
- Analisi statica di bundle JS e sourcemap in cascade, form HTML, e il recupero delle route
  **Next.js App Router** dai chunk (`/[vaultId]/page-<hash>.js → /vaults/{vaultId}`) — i near-miss
  sono riportati ma **mai** emessi come operazioni (esclusione strutturale, non di punteggio).

**Per noi.** L'audit (§6.5) dice che il buco più grande è il fuzzing stateful API, e `schemathesis`
lo copre — ma solo se esiste una spec. Fino a oggi l'unico percorso era un OpenAPI già pubblicato
(`--var spec_path=/openapi.json`). Vespasian è esattamente il passo che manca:

```text
run.js vespasian scan <url>          → capture.json           (active-tier, scope-gated)
run.js vespasian generate capture.json --target-url <url>      (read-tier su capture importato)
workflow attack-api-stateful --var spec_path=<spec generata>   (schemathesis, già registrato)
```

Con un plus che vale più della feature: il modello a due stadi rende la spec **un artefatto
riproducibile** — la cattura è nella catena di evidenza, la generazione si può rifare offline. La
CLI esatta e i flag vanno verificati in fase di registrazione; il tier è `active` per `scan`,
`read` per `generate` su file locali (l'estrazione host in `run.js` serve per il solo `scan`).

### Nerva — fingerprint di servizio veloce
<https://github.com/praetorian-inc/nerva> (~363★)

- 170+ protocolli TCP/UDP/SCTP, singolo binario, output strutturato; è già il pezzo centrale della
  pipeline nativa `naabu → nerva → brutus` (documentata anche da loro).
- **Per noi**: pre-fingerprint nella pipeline `scan` — `nmap -sV` resta l'autorità (script NSE,
  ingestione nel target model), nerva accelera e copre i protocolli che nmap classifica genericamente.
  Registry entry `active` (sonde di rete), `alternative: "nmap -sV"`, estrazione host da rivedere.

### Julius — identificazione di servizi AI
<https://github.com/praetorian-inc/julius> (~244★)

- `IP:Port → Ollama, vLLM, LiteLLM, …` (60+ servizi AI). "Simple LLM service identification".
- **Per noi, due usi**: (a) sui target — un vLLM/Ollama esposto è una superficie nuova (classe LLM
  già presente in `methodology-classes.md`, finora poco strumentata oltre `llm-inject.js`); (b) in
  casa — verifica del nostro endpoint locale (stesso spirito del doctor). Registry `active`
  (manda probe HTTP), estrazione host come per gli altri.

### La coda (watch, non priorità)

| Repo | Cosa | Perché no |
|---|---|---|
| [pius](https://github.com/praetorian-inc/pius) (~91★) | Asset discovery organizzativo: CT, passive DNS, 5 RIR, 20+ plugin | Sovrapposto a subfinder/amass/uncover; aggiunge solo le sorgenti RIR |
| [aurelian](https://github.com/praetorian-inc/aurelian) (~68★) | Recon cloud | Il posizionamento cloud è già deciso (audit §6.6: no Prowler; enumerazione nativa) |
| [trajan](https://www.praetorian.com/blog/building-bridges-breaking-pipelines-introducing-trajan/) (mar 2026) | Validazione attacchi su CI/CD (GitHub Actions) | Classe CI/CD fuori dal perimetro attuale web/host/wireless/mobile |

---

## 2. AI-Infra-Guard — la piattaforma AI red teaming (Tencent Zhuque Lab, Apache-2.0)

<https://github.com/Tencent/AI-Infra-Guard> · report tecnico: <https://arxiv.org/html/2606.31227v1>

Un solo progetto che copre tre superfici che ci riguardano, in release attiva (v4.6.2, 2026-09-17):

- **AI infra vulnerability scan**: fingerprint di 100+ componenti (Ollama, vLLM, ComfyUI, n8n,
  MLflow, Triton…) contro **2000+ regole CVE** — l'ultima release ne ha aggiunte 155 su 40+
  componenti. Input: URL/IP/CIDR/range di un servizio **vivo**, non codice.
- **MCP Server & Agent Skills scan**: 14 categorie di rischio, da sorgente o URL remoto; la CLI
  `aig-skill-scan` (pip) classifica con la tassonomia **T01–T09** (instruction hijacking, memory
  poisoning, payload remoti, codice malevolo, privilege escalation, persistenza, tool hijacking,
  dipendenze insicure, coding insicuro) e pubblica i numeri su SkillTrustBench (F1 ~0.98 sui modelli
  frontier). Include `mcp-scan` e `agent-scan` come CLI separate.
- **Jailbreak Evaluation** multi-turno (Many-Shot, PAIR, GOAT, ActorAttack) con confronto
  cross-modello, e — la parte che ci tocca di più — nuovi benchmark di **agent loss-of-control**
  (FORGE-Bench, RogueHandoff-20): esattamente la classe di rischio di `docs/THREAT-MODEL.md`.
- **Agent Scan** per workflow su piattaforme terze (Dify, Coze), ClawScan per OpenClaw, e un
  "Model & API Relay Checker" (fingerprinting di modelli, verifica firme, auditing di relay).

**Limiti dichiarati, da riportare così come sono**: nessun meccanismo di autenticazione ("should not
be deployed on public networks"); Help Net Security (2026-09-09) riporta che sulle skill pulite il
tool segnala falsi positivi fino al **18.67%**; il deployment è Docker (4GB+ RAM). Quindi: mai come
dipendenza dell'harness, mai esposto oltre localhost.

**Per noi, tre usi in ordine di valore:**

1. **Vetting pre-mount di MCP server e skill** (item 7 dello scout #1) — ora esiste uno stack
   concreto: AI-Infra-Guard (T01–T09) + `snyk/agent-scan` (che nella v0.6+ scansiona anche le
   **agent skills**: prompt injection, tool poisoning, toxic flows) + `cisco-ai-defense/mcp-scanner`.
   `mcp-guard-proxy` giudica a runtime; questo è il passo *prima* del mount, per i server di terze
   parti e per la nostra stessa cartella `skills/`.
2. **Self-test del layer LLM** — jailbreak eval e loss-of-control benchmark contro il modello locale
   (Ollama/REST): dialogo diretto con il threat model "contenuto ostile → agente", zero egress.
   Complementa `augustus` (item 4 dello scout #1, ancora aperto): augustus è il probe scanner Go da
   registrare; AIG è la piattaforma per i test più profondi, operator-side.
3. **Superficie AI dei target** — un host che espone Ollama/vLLM/ComfyUI è findings potenziali
   (`suspected`: la regola è CVE-gated e i FP sono documentati). Julius è il triage economico,
   AIG il passo profondo; entrambi via `run.js` con scope.

---

## 3. Il guard plane diventa una categoria: sandbox-runtime, Prismor, ToolHive

### Anthropic sandbox-runtime (srt) — Apache-2.0, research preview
<https://github.com/anthropics/sandbox-runtime> · npm `@anthropic-ai/sandbox-runtime`

È la risposta pronta alla domanda dell'audit (§1.4, priorità 6): **come si enforce-a la rete sotto
l'agente senza container**. Il design, da copiare (non da montare: è un pacchetto npm, la regola
zero-dep resta):

- Linux: **bubblewrap**, unprivileged; la **network namespace viene rimossa del tutto** e tutto il
  traffico passa da proxy sul host (HTTP proxy + SOCKS5) raggiungibili via **unix socket
  bind-montati** nel sandbox. Allowlist a default-deny, per dominio.
- Filesystem con semantica esplicita: write allow-only (default nega tutto), read deny-then-allow
  con la regola più specifica che vince; socket unix ristretti; monitoring delle violazioni.
- **`--control-fd`**: aggiornamenti di config a runtime via descrittore — solo le liste di rete
  hanno effetto su un processo già in corsa (il proxy le consulta per richiesta), il filesystem è
  compilato al wrap. Una riga invalida viene scartata con l'errore su stderr, la config precedente
  resta; un **file di config rotto è un errore, non un fallback ai default** — la stessa disciplina
  fail-closed dei nostri guard, scritta in un altro progetto.
- **`srt proxy`** standalone: proxy HTTP con un **decider esterno** raggiunto via descrittore
  ereditato — il modello esatto per un nostro "egress-proxy come unico camino" sotto bwrap.

Lezione da non saltare: srt ha avuto un **CVE di misconfigurazione (CVE-2025-66479)** corretto in
silenzio. Un sandbox va **sondato**, non dichiarato — esiste `controlplaneio/sandbox-probe` che
testa proprio questo. Se implementiamo il guard netns, il criterio di accettazione è un test che
prova che fuori-scope e IP interni *falliscono*, non che il wrapper parte.

**Per noi**: `tools/` guadagna la modalità forte `bwrap --unshare-net` + unix socket verso il nostro
egress proxy/decider, dichiarata per-tool nel registry (`containment: netns|none`), con l'esclusione
esplicita dei tool a raw socket (masscan, suite wireless, ARP) motivata nel THREAT-MODEL. MCP e
tool HTTP-class sono i primi candidati.

### Prismor — control plane per agenti di coding
<https://github.com/PrismorSec/prismor> · HNS 2026-09-23

Self-hosted, open source: osserva / approva in HITL / **blocca** ogni tool call di Claude Code,
Codex, Cursor *prima* dell'esecuzione (allow/warn/block), con log e controllo di leak di segreti.
Verdetto: nessuna dipendenza (il nostro runtime è nostro), ma è la **conferma di categoria** — esiste
anche una lista curata (`Ar9av/awesome-agent-control-plane`) di progetti con la stessa forma
architetturale. Utile nel posizionamento: noi il control plane **lo abbiamo dentro**, dal primo
giorno, non bolt-on.

### ToolHive (Stacklok, Apache-2.0) e l'aggiornamento di agent-scan

- **ToolHive**: runtime che esegue MCP server **in container**, con registry e operator K8s.
  Alternativa containerizzata al nostro mcp-guard-proxy; il container però è proprio l'isolamento
  che l'audit ha scartato (rompe raw socket/capability). Resta un'opzione operator-side per server
  MCP di terze parti: watch.
- **`snyk/agent-scan` v0.6+** ora copre anche le **agent skills** — aggiorna la nota dello scout #1
  (che lo citava solo per server MCP), nel contesto del vetting.

---

## 4. Mobile: Mobilytix e il taskflow Android di GitHub Security Lab

### Mobilytix — MCP server per il pentest Android (Apache-2.0)
<https://github.com/erev0s/Mobilytix>

- **63 tool** su streamable-HTTP MCP (o stdio): session management, riconoscimento (manifest,
  componenti esportati, framework detection, tampering), artefatti (Flutter AOT, React Native,
  web-hybrid, .NET, Unity), decompilazione e ricerca sorgenti, **secrets + SAST**, certificati,
  crypto, librerie native; dinamica su emulatore (install/launch, UI inspection, logcat, **script
  Frida**, screenshot), **traffico via mitmproxy** (capture/review/ricerca dati sensibili),
  findings e report. Persistenza di sessione con rehydration al riavvio.
- Benchmark pubblicato: **42 vulnerabilità** ground-truth su due app intenzionalmente vulnerabili
  (Allsafe + Ostorlab) → **90.5% recall a istanza, 97.6% a famiglia**, 4 miss; metodologia nel repo.
- Limiti dichiarati: iOS è futuro; l'intercettazione HTTPS è "assisted, not guaranteed" (pinning →
  follow-up manuale) — la stessa onestà delle nostre note mobile.

**Per noi**: è il pattern Super Trouper (scout #1 §4) declinato su Android, con in più un benchmark
serio. Non entra nell'harness (Docker + Python), ma: (a) si monta **operator-side dietro
`mcp-guard-proxy`** come capacità mobile aggiuntiva — i tool che wrappa (jadx/apktool/frida/
mitmproxy) sono già i nostri, il valore è la sessione strutturata e l'evidenza persistita; (b) il
benchmark 42-vuln è un riferimento per le nostre claim di copertura mobile; (c) la loro tassonomia di
tool è una checklist per `mobile.js`.

### GitHub Security Lab — seclab-taskflows (MIT) e le 24 vulnerabilità Android
<https://github.com/GitHubSecurityLab/seclab-taskflows> · blog: <https://github.blog/security/how-we-found-24-android-vulnerabilities-using-our-open-source-ai-security-agent/> (2026-09-28)

- Framework agentico YAML-driven con MCP, source-aware (Docker), che riconosce applicazioni Android,
  iOS e cross-platform. La **mobile entry-point collection** registra: componenti esportati, deep
  link, URL scheme, Universal Links, app extension, **WebView JavaScript bridge** — con permessi,
  export status e input filter, in una tabella `mobile_entry_point` dedicata.
- Risultati reali: 24 vulnerabilità Android trovate e divulgate (inclusi location tracking via
  OsmAnd e una catena di account takeover su Wikipedia); il loro agent gira su Copilot API
  (egress/cloud) e le audit durano ore con costi non banali.

**Per noi**: loro sono source-aware, noi black-box — complementari, non concorrenti. Da prendere:
(a) la **checklist di entry-point** come verifica di completezza di `mobile.js surface` (deep link,
URL scheme, bridge WebView sono classi che vale la pena controllare una per una); (b) il pattern
dell'output SQLite con colonna `has_vulnerability` e "most likely genuine" — un'altra forma della
stessa disciplina di onestà che noi applichiamo col tetto di severità.

---

## 5. Autonomia sotto i riflettori: ARTEX, RedAmon, Nightcrawler

### ARTEX — il contro-esempio pubblico (AGPL-3.0, Go + Next.js)
<https://github.com/Autumn-27/ARTEX> · ~1.5–2k★, 499 fork · vincitore della "agent+" challenge di Baidu · post: <https://zendot.org/en/posts/autumn-27-artex> · notizia: <https://www.mk.co.kr/en/economy/12170316>

- Sistema self-hosted di pentest autonomo con **approval-first**: le azioni possono passare da flussi
  intercept-and-approve con registri globali e card in chat che si espandono nel dettaglio completo
  della call; dashboard con consumo token, activity feed, trace per task, grafo di esplorazione e
  **mappa di copertura**; traffic recording e chat HITL; Postgres; binario singolo con frontend
  embedded; updater con SHA256 + smoke test + rollback.
- **Il fatto**: la stampa coreana riporta che ARTEX è stato trovato in attacchi reali nel settore
  finanziario; l'autore ha dichiarato di aver rafforzato le misure anti-abuso (i dettagli non sono
  verificabili da qui). È il caso di studio perfetto per la nostra tesi: un autonomous pentester
  senza guardie **nel runtime** diventa, nella pratica, un'arma riutilizzata da terzi.

**Per noi**: solo idee. Il pattern "registro delle approvazioni che si espande nel dettaglio della
call" è vicino al nostro inbox della Command Center + consent token — da confrontare; la mappa di
copertura è un cugino della coverage matrix. AGPL: mai codice.

### RedAmon — il modello di pubblicazione (MIT per il codice proprio)
<https://github.com/samugit83/redamon> · <https://www.redamon.org/>

- Stack Docker (7+ container: webapp, Postgres, **Neo4j**, agent, kali-sandbox, recon-orchestrator,
  **docker-broker**), agent LangGraph, grafo di attacco come fonte di verità, MCP "both ways" (usi
  qualsiasi server MCP come tool; guidi RedAmon da Claude Code), **human approval gates**, e una
  fase CypherFix che *implementa le fix e apre PR* sul repo del cliente.
- **Claim flagship**: 101/104 (**97.1%**) su XBOW web-security benchmark "fully black-box", con per
  ogni solve **la sessione grezza non editata** e una walkthrough riproducibile.
- **Audit di copertura**: PDF di 124 pagine su **397 classi** di bug bounty web, auto-valutato e
  auto-critico — 134 complete, 210 in backlog, **44 escluse con una decisione esplicita** per classe,
  con il modulo/scanner dietro ogni verdetto. È il formato di "coverage honesty" più forte visto
  finora.
- Il **docker-broker** (proxy filtrante sul socket Docker, così l'orchestrator può lanciare solo
  immagini di tool note) è il pattern di *restrizione* dei container, opposto a "container come
  isolamento".

**Per noi**: da studiare, non adottare (80–110GB di disco, Neo4j, stack pesante). Tre idee:
(a) la pubblicazione di sessione grezza per ogni risultato di benchmark è la versione
"third-party-verifiable" del nostro evidence bundle; (b) il formato dell'audit di copertura —
per-classe con esclusioni dichiarate — è il modello per una pagina del nostro coverage report;
(c) il docker-broker come restrizione, se mai serve lanciare container tool.

### Nightcrawler — l'agente interamente sul telefono (licenza non indicata)
<https://github.com/garagehq/nightcrawler> · Show HN 2026-08-03

- Agente di pentest autonomo che gira **tutto su smartphone** (OnePlus 8, Kali NetHunter root,
  modello locale LFM2.5-1.2B su GPU OpenCL): recon → enumerazione → exploit → report, con
  dashboard web C2, SQLite, **27 playbook di exploit** e DB CVE da 24.956 voci.
- Architettura a due strati per lo scope: **Scope Proxy** che valida ogni comando *prima*
  dell'esecuzione + config con `excluded_hosts`/`excluded_ports` (**SCADA/ICS 502/503 escluse**) e
  campo `authorization: ROE-*.pdf`; rate limiter con jitter; blocklist di comandi distruttivi.
- Filosofia: il modello 1.2B ha ~50% di comandi riusciti e l'agente lo compensa
  deterministicamente (garbage/duplicate/stuck detection; i playbook multi-step **bypassano l'LLM**).
  Risultati dichiarati: 72h autonomi, 30+ host, 2000+ comandi, 10+ vulnerabilità.
- La dashboard si maschera (header nginx, 404 vuoti verso la rete target) — stealth filtering.

**Per noi**: è il parente pubblico più vicino al canale F3, ma con lo split opposto (telefono fa
tutto, noi usiamo il telefono come client/C2). Da prendere: (a) l'idea di **escludere le porte
ICS/SCADA di default** — verificare se `scope.json` vuole un campo esplicito o basta la disciplina
documentata; (b) la conferma che "due strati" (guard + policy) è la forma giusta; (c) la loro
statistica onesta sul modello piccolo, coerente con le nostre note su HTB e sul runner locale.

---

## 6. Benchmark e letteratura — cosa citare

### Deng et al., "What Makes a Good LLM Agent for Real-world Penetration Testing?" — arXiv:2602.17622 (feb 2026)
<https://arxiv.org/abs/2602.17622> · fork funzionante: <https://github.com/sickwell/PentestGPT-v2>

- Survey di **28 sistemi** LLM-pentest con una tassonomia dei fallimenti che vale come indice dei
  problemi di design: **Type A — capability gaps (42%)**; **Type B — complexity barriers (58%:**
  context forgetting 18%, premature commitment 16%, exploration/exploitation imbalance 12%,
  multi-step chain failures 12%**)**.
- Il sistema della linea PentestGPT v2 (Excalibur) che ne esce: **38 interfacce di tool tipizzate**
  con schemi e pre/post-condizioni (+14% su XBOW in ablazione), Task Difficulty Assessment,
  **Evidence-Guided Attack Tree Search** (UCB), memory subsystem.
- Restano difficili, per loro: creatività fuori distribuzione, ambienti avversariali
  (**honeypot/canary token** — parola nostra), continuità cross-sessione.

**Per noi**: è la citazione esterna che inquadra esattamente le nostre scelte — i Type B sono la
classe che gate/coverage-loop/memoria/pipeline deterministica attaccano; le interfacce tipizzate
sono la direzione del nostro registry (`args_schema`); "ambienti avversariali" è il nostro
`THREAT-MODEL`/disciplina canary. Da mettere in `BENCHMARK.md`/`docs/METHODOLOGY.md` come
letteratura di posizionamento.

### Anti-contaminazione: CTFusion (ICML 2026) e 3CB
- **CTFusion** — arXiv:2605.11504, <https://arxiv.org/abs/2605.11504>: valutazione **streaming su CTF
  live** via MCP server su CTFd; dimostra che i benchmark CTF esistenti possono essere **inaffidabili**
  per gli agenti (contaminazione). È l'argomento esterno più forte per la nostra politica di
  benchmark a seed privato: il campo sta arrivando alla nostra stessa conclusione.
- **3CB** — arXiv:2410.09114 (APART): 15 challenge originali che coprono le categorie ATT&CK, nate
  anti-memorizzazione; usato nelle valutazioni AISI (i blog AISI 2026 citano CTF e cyber range come
  standard di valutazione).
- Contorno citabile: Cybench (40 task), NYU CTF Bench (200), AutoPenBench (ambienti Docker
  vulnerabili con metriche a milestone), CAIBench (meta-benchmark), XBOW (commerciale, 104 task —
  è il numero su cui RedAmon rivendica 97.1%: la nostra risposta di posizionamento è che XBOW misura
  *solve*, non *precisione della severità*).
- **`insidetrust/awesome-ai-pentest`** (CC0): lista curata compilata dal survey Deng et al. con 28+
  sistemi e la sezione benchmark — il miglior indice di campo trovato in questo giro; seed radar.

---

## 7. Cosa NON prendere

- **RedAmon / ARTEX come stack**: Docker+Neo4j / AGPL+Postgres — runtime estraneo, licenze ostili.
  Solo idee (pubblicazione sessioni, audit di copertura, approval records).
- **AI-Infra-Guard come dipendenza**: Docker, nessuna auth, FP documentati. Solo operator-side via
  `run.js` (localhost/lab) e come riferimento di tassonomia.
- **Prismor / sandbox-runtime come pacchetti**: npm, fuori dalla regola zero-dep. srt si *copia
  architetturalmente* (bwrap + proxy + decider), non si monta.
- **Mobilytix come harness**: Docker+Python; operator-side dietro mcp-guard-proxy.
- **Nightcrawler come stack**: richiede root/NetHunter e un modello on-device; per noi il telefono
  resta un client. Idee sì, codice no.
- **Container come isolamento primario**: riconfermato (audit §9); il docker-broker di RedAmon è una
  *restrizione*, non un'alternativa al netns.
- **Sift** (secrets su M365/SharePoint/Slack/Jira — HNS set 2026): superficie collaborativa SaaS
  fuori dalle classi attuali; watch.
- **Trajan** (CI/CD) e **aurelian/pius**: fuori perimetro o sovrapposti (vedi §1 coda).
- **Kali 2026.3**: non esiste ancora — l'ultima release è **2026.2** (29 giugno 2026), verificato
  sulla pagina releases ufficiale: niente nuovi tool Kali da minare in questa finestra.
- Visti ma non verificati a sufficienza in questa finestra: `Hadrian`, `Lyrie`, `Sandyaa`,
  `Armur-Ai/Pentest-Swarm-AI` — riproporre al prossimo giro se risalgono.

---

## 8. Priorità per Cyboros

Ordinate per valore/costo, dentro i vincoli (zero-dipendenze npm, Node ≥ 22, registry dei binari,
egress disciplinato). Gli item dello scout #1 restano validi: qui solo ciò che cambia.

| # | Azione | Costo | Valore |
|---|---|---|---|
| 1 | **Registrare `vespasian`** (read su `generate` offline, active su `scan`) + workflow `attack-api-discover` che chiude la catena capture → spec → `attack-api-stateful` (schemathesis) | S–M | Il buco API dell'audit §6.5 diventa end-to-end: spec generate dal traffico, non solo da doc pubblicata. La spec è un artefatto riproducibile (due stadi) |
| 2 | **Registrare `nerva` + `julius`**: nerva come pre-fingerprint nella pipeline `scan` (nmap resta autorità), julius per i servizi AI post-scan e la verifica dell'endpoint locale | S | Due JSON + due righe in `install-tools.sh`; copertura protocolli e superficie AI con zero nuove dipendenze |
| 3 | **AI-Infra-Guard come tool operatore** (via `run.js`, localhost/lab) + vetting skills/MCP con la tassonomia T01–T09 unito a `snyk/agent-scan` — chiude l'item 7 dello scout #1 con uno stack concreto | M | Vetting pre-mount + self-test LLM + scansione infra AI dei target, in un solo percorso documentato |
| 4 | **Guard netns sul modello `srt`**: `bwrap --unshare-net` + unix socket verso l'egress proxy/decider; dichiarazione `containment` per-tool; **test di superamento** (lezione CVE-2025-66479) | M–L | Item 6 dell'audit: "il modello è disciplinato" diventa "il kernel rifiuta" |
| 5 | **Mobile**: Mobilytix dietro `mcp-guard-proxy` (operator-side) + checklist entry-point di seclab-taskflows dentro `mobile.js surface` + cross-check del benchmark 42-vuln | M | La classe mobile guadagna una superficie MCP e una checklist verificata da terzi |
| 6 | **Benchmark/posizionamento**: citare Deng et al. (Type A/B), CTFusion (contaminazione), 3CB/AutoPenBench in `BENCHMARK.md`/`METHODOLOGY.md`; l'item 1 dello scout #1 (fixture negative, multi-run, dimostrato-vs-sottomesso) resta il lavoro sostanziale | S (docs) + M (item 1) | Allinea le nostre claim alla letteratura 2026 e le difende meglio (XBOW 97.1% incluso) |
| 7 | **Seed radar** con i nuovi org/repo: `praetorian-inc` (vespasian/julius/nerva), `Tencent/AI-Infra-Guard`, `PrismorSec`, `anthropics/sandbox-runtime`, `garagehq/nightcrawler`, `samugit83/redamon`, `Autumn-27/ARTEX`, `GitHubSecurityLab`, `insidetrust/awesome-ai-pentest`, `sickwell/PentestGPT-v2` | XS | Non ri-scoprirli fra un mese; il pipeline radar esiste già |
| 8 | **Watch**: Sift, ToolHive, Prismor, Trajan, aurelian, pius, Xalgorix (in evoluzione), `seclab-taskflow-agent` | — | Rivalutare al prossimo giro con criteri di adozione espliciti |

---

## Appendice — tabella progetti

| Progetto | Licenza | Linguaggio | Dove visto | Verdetto |
|---|---|---|---|---|
| [Vespasian](https://github.com/praetorian-inc/vespasian) | Apache-2.0 | Go | org Praetorian, blog apr 2026 | **Adopt candidate** (register + workflow) |
| [Nerva](https://github.com/praetorian-inc/nerva) | Apache-2.0 | Go | org Praetorian | **Adopt candidate** (registry) |
| [Julius](https://github.com/praetorian-inc/julius) | Apache-2.0 | Go | org Praetorian | **Adopt candidate** (registry) |
| [Pius](https://github.com/praetorian-inc/pius) | Apache-2.0 | Go | org Praetorian | Watch (sovrapposto al recon) |
| [Aurelian](https://github.com/praetorian-inc/aurelian) | Apache-2.0 | Go | org Praetorian | Watch (cloud già deciso) |
| [Trajan](https://www.praetorian.com/blog/building-bridges-breaking-pipelines-introducing-trajan/) | Apache-2.0 | Go | blog mar 2026 | Watch (classe CI/CD fuori perimetro) |
| [AI-Infra-Guard](https://github.com/Tencent/AI-Infra-Guard) | Apache-2.0 | Go + Python | HNS 2026-09-09 + repo | **Adopt candidate** (operatore; vetting + self-test) |
| [sandbox-runtime](https://github.com/anthropics/sandbox-runtime) | Apache-2.0 | TypeScript | repo (preview) | **Borrow** (stampo del guard netns) |
| [Prismor](https://github.com/PrismorSec/prismor) | n/d | n/d | HNS 2026-09-23 | Watch (conferma di categoria) |
| [ToolHive](https://github.com/stacklok/toolhive) | Apache-2.0 | Go | HNS set 2026 | Watch (MCP in container) |
| [Mobilytix](https://github.com/erev0s/Mobilytix) | Apache-2.0 | Python | repo | **Adopt candidate** (operator-side MCP mobile) |
| [seclab-taskflows](https://github.com/GitHubSecurityLab/seclab-taskflows) | MIT | Python | repo + GH blog 2026-09-28 | **Borrow** (checklist mobile, pattern output) |
| [ARTEX](https://github.com/Autumn-27/ARTEX) | AGPL-3.0 | Go + Next.js | r/Pentesting + zendot + mk.co.kr | Borrow idee (caso anti-misuse) |
| [RedAmon](https://github.com/samugit83/redamon) | MIT (proprio) | Python/Docker | repo + blog | Borrow idee (audit copertura, sessioni grezze) |
| [Nightcrawler](https://github.com/garagehq/nightcrawler) | n/d | Python | Show HN 2026-08-03 | Watch (precedente F3; esclusioni ICS) |
| [CTFusion](https://arxiv.org/abs/2605.11504) | paper | — | ICML 2026 | **Cite** (anti-contaminazione) |
| [3CB](https://arxiv.org/abs/2410.09114) | paper | — | APART / AISI | Cite (rigore dei benchmark) |
| [Deng et al. 2026](https://arxiv.org/abs/2602.17622) | paper | — | arXiv feb 2026 | **Cite** (tassonomia del campo) |
| [awesome-ai-pentest](https://github.com/insidetrust/awesome-ai-pentest) | CC0 | — | repo | Reference (indice di campo; seed radar) |
