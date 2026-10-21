# Changelog

All notable changes to this project are documented here. Dates are commit dates.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [Semantic Versioning](https://semver.org/) (pre-1.0: a minor bump may carry breaking
changes). `v0.1.0` (2026-09-28) is the first tagged release; the latest is `v0.2.0` (2026-10-20).

## [Unreleased]

### Added

- **Il Command Center ha un'identità: ruoli, account e audit dell'attore vero.** Prima
  c'era un solo token condiviso: le scritture erano gated, ogni lettura era
  loopback-trusted, e ogni azione era attribuita a una stringa scelta dal chiamante
  (`actor: "mallory"` finiva nel log). Ora `tools/identity.js` autentica ogni richiesta
  (cookie di sessione da account scrypt, oppure il token macchina come principal
  `service`) e autorizza per ruolo — `viewer` legge, `operator` esegue, `admin` gestisce
  gli account — su letture *e* scritture. Il terminale e lo stream dei job richiedono
  `operator`: una shell non è una vista read-only. L'audit trail hash-chained registra
  `auth.login`, `access.denied`, `console.write` e `user.*` con l'identità autenticata;
  `cc-router` consuma `ctx.actor` e ignora `body.actor`, e la nota di modifica di
  `scope.json` porta il nome di chi l'ha fatta.
- **Account in un file validato (`users.json`, 0600) e una CLI per crearli.**
  `node tools/users.js add <nome> --role admin --generate` è il primo passo (la password
  non è mai un argomento: finirebbe in history e in `ps`); `passwd`, `role`, `disable`,
  `remove`, `list` completano la gestione, e l'ultimo admin abilitato non può essere
  rimosso, demoto o disabilitato. Un file corrotto fallisce chiuso: il server parte,
  dichiara l'errore e rifiuta ogni login.
- **Seam per un backend identità esterno.** `CYBOROS_AUTH_PROVIDER=<file.js>` carica un
  provider `{ name, authenticate(req, ctx) -> principal|null }` consultato prima del
  token macchina: un OIDC/SSO entra senza toccare un route handler. Un provider che
  lancia, o che restituisce un ruolo sconosciuto, non autentica nessuno.
- `docs/IDENTITY.md` (matrice dei ruoli, gestione account, sessione, audit, seam OIDC) e
  la superficie di login del Command Center (`/login`, chip utente e sign-out).

### Changed

- **Le letture del Command Center non sono più anonime.** `GET /api/overview` senza
  sessione risponde `401` (prima `200`), e un test che assumeva il contrario è stato
  aggiornato: la superficie dati di un engagement non è pubblica nemmeno su loopback.
- Il token di avvio resta per launcher e automazione, ma vale `operator` e non gestisce
  account; aprire `/?token=…` lo scambia con un cookie di sessione e reindirizza, così
  la credenziale non vive più nel JavaScript della pagina.

- **Il Command Center dichiara l'istanza che sta servendo.** Due console con data root
  diversi erano indistinguibili: la barra di stato non diceva né porta né albero. Ora
  `/api/overview` porta `instance` (host, porta, data root, file di configurazione, e
  `packaged` quando i dati vivono fuori dall'albero del codice) e la barra mostra
  `instance 127.0.0.1:8787 · packaged` e `data <root>`, col path completo nel tooltip. La
  riga resta anche quando un poll fallisce o si cambia tab.
- **Il report HTML è in inglese, come il resto del prodotto.** Le sezioni copertura e
  costi erano in italiano (`Copertura & accuratezza`, `Candidati`, `Per agente`) e il
  documento consegnato al cliente citava file interni (`scope.json`, `state.db`,
  `tools/report-html.js`). Ora ogni stringa è inglese e descrive l'esito, non il file —
  `Coverage & accuracy`, `Cost & usage`, `Status legend` — e `test-report-html` rifiuta i
  marcatori italiani.
- **Le righe di stato parlano la lingua dell'operatore.** `no operation-state.json`,
  `no sessions in reports/sessions.json`, `no reports/state.db` diventano «no operation
  started yet», «no sessions yet», «no run yet»; il rail chiama lo scope «authorized
  targets» invece del nome del file.

## [0.2.0] — 2026-10-20

### Fixed

- **`timings_per_token` non fa più cadere lo streaming sui gateway generici.** Il campo è
  specifico di llama.cpp: un gateway OpenAI-compatible risponde `400 unsupported_parameter`, il
  loop ricadeva in silenzio sul non-stream e la TUI perdeva thinking e token live. Ora è opt-in
  per profilo (`timings_per_token: true`) e l'uso in streaming viaggia in `stream_options`.
- **`record_finding` dichiara nel contratto le prove che pretende.** Lo schema del tool esponeva
  solo i campi «editoriali»; `status: confirmed` però richiede un `oracle {type,ref,token}` e una
  `evidence_quote {file,text}` verificate su disco, e l'agente doveva indovinarle leggendo gli
  errori (in una run reale ha sprecato sei iterazioni e non ha registrato il finding). Ora
  entrambe sono nello schema con la ricetta (`oracle.js record`, risposta grezza salvata in
  `reports/` con `write_file`, quote letterale), e il system prompt live lo ripete.
- **Il loop-guard non blocca più il retry dopo un errore di validazione.** La seconda
  `record_finding` con il solo `cvss_vector` corretto veniva scartata come variante della prima,
  che era fallita. Ora il fuzzy non si applica quando l'output precedente è un errore
  (`exit ≠ 0` / `ERRORE`): una correzione dopo un rifiuto è progresso, non un loop.
- **Il loop-guard fuzzy non scambia più due probe diversi per la stessa azione.** Il confronto a
  bigrammi su `tool + args` trattava `curl -H "X-User: alice" …/orders/42` e
  `curl -H "X-User: bob" …/orders/42` come una ripetizione: il secondo probe veniva sostituito
  dall'output del primo e l'enumerazione si bloccava proprio dove serviva (due identità, due
  oggetti). `local/llm.js` confronta ora anche la forma delle chiavi (aggiungere `oracle` a una
  `record_finding` è evidenza nuova, non un refuso) e accetta `loop_guard.exempt_tools`;
  `runtime/live.js` esenta `run_tool` dal fuzzy. Resta il dedup delle azioni identiche, mentre URL,
  header e campi nuovi sono evidenza nuova. Regressioni coperte in `tools/test-runtime-live.js`;
  i tre scenari storici restano verdi in `local/test-loop-guard.js`.
- **La CI è verde su un runner nudo.** `keyringAvailable()` verificava solo che `keyctl show @u`
  rispondesse: in un container il keyring può esistere e negare la lettura, quindi l'identità
  salvata diventava irrecuperabile e `test-agent-forum`/`test-forum-admin` fallivano. La
  disponibilità è ora un roundtrip reale (add/search/pipe/unlink); i test che non riguardano la
  custodia forzano un backend esplicito e quello del keyring si salta quando non è utilizzabile.
  `test-cap-privs` e `test-sb2` isolano i requisiti della macchina (soglia porte, `nmap`), che sul
  runner non sono soddisfatti.
- **`npm test` torna verde su un clone pulito.** Il test del corpus di `kb-search` chiamava
  `corpusFiles(true)` sul workspace e pretendeva un file in `reports/`: quella cartella è
  gitignored, quindi su un clone pulito — cioè nel gate di release e in CI — `test-repo-vet`
  falliva, mentre qui era verde perché il workspace ha 734 MB di evidenza. `corpusFiles` accetta
  ora un `root` (default invariato) e il test costruisce la propria fixture in mkdtemp.
- **I gate sono per ingaggio, e un gate non passa più senza il suo artefatto.** `gate.js status`
  ignorava l'host e `checkNoPending` guardava l'intero `findings.jsonl`: il report di un host era
  bloccato da finding pending di altri ingaggi, e un pass di un altro host sbloccava il successivo.
  Ora `pass/check <fase> <host>` filtrano findings, pending, verify, oracle, evidenceQuote,
  pocReplay e coverage su quell'host; il pass è taggato `host=` nel gate-log e non vale per altri.
  Il gate `map` richiede `reports/<host>-map.json` (prima passava senza mappa); il gate `test`
  interroga il gate `map` per lo stesso host invece di cercare la stringa `cyboros/map` nel log
  globale; il gate `report` boccia qualunque classe `missed` e una matrice il cui header nomina un
  altro host (prima bastava che il file contenesse una pipe). `report-html.js` applica lo stesso
  scope al proprio controllo del gate.
- **La matrice di copertura non viene più sovrascritta da un altro host.** `coverage.js --write`
  scriveva sempre `reports/coverage-matrix.md`: l'ingaggio successivo distruggeva la matrice del
  precedente e il gate leggeva dati sbagliati. Ora è `reports/coverage-<host>.md`, e `--write`
  avvisa su stderr quando manca la mappa (senza mappa ogni classe risulta `missed`).
- **Il tetto di severità non si aggira omettendo `verify_level`.** Il ceiling di
  `record-finding.js` era condizionato al campo: un finding `High`/`Critical` senza `verify_level`
  passava senza prova (è così che una riga `inconclusive` ha preso severità High). Ora
  `verify_level` è obbligatorio per High/Critical; i record promossi da `--verify` restano esenti.
- **`--help` non esegue più il tool.** `coverage.js` stampava la matrice dell'host `--help`,
  `record-finding.js` rispondeva con un errore JSON, `analyze-bundle.js` apriva `--help` come file
  (ENOENT) e `chain.js` cercava un findings file chiamato `--help`.
- **Uccidere il wrapper non libera la porta.** `node tools/kill-port.js <port>` risolve il PID del
  listener dal kernel (`ss -ltnp`, `lsof` fallback), manda il segnale, attende la morte e rilegge il
  kernel per confermare che la porta è libera (`--dry-run`, `--json`, `--signal`, `--udp`).

### Changed

- **La matrice Node della CI non è più decorativa.** Mancava `actions/setup-node`: entrambi i job
  giravano sul Node preinstallato nell'immagine e `tests (node 24)` eseguiva la 22. Ora il job
  installa la versione della matrice; la suite è verde su 22.23.3 e 24.22.0.
- **Il repository GitHub si chiama `cyboros-harness`.** README, `package.json` e SARIF puntavano
  già lì: il rename rende validi clone URL, homepage e issue tracker.
- **Il bootstrap del forum è uscito dal prompt.** `AGENTS.md` entra verbatim nel system prompt di
  ogni sessione: il paragrafo operativo del forum (541 byte) ora vive in `ops/harness.md` §Forum e
  il contratto ne tiene solo il puntatore. L'assemblato scende da 20.269 a ~19.900 caratteri, sotto
  il tetto di 20 KB che `check-identity.js` misura — il gate di release era rosso di 269 caratteri.
- **La matrice di copertura deriva le classi dal registry, non da una lista cablata.**
  `tools/coverage.js` aveva 20 nomi hardcoded: 32 classi di `tools/test-registry.json` (jwt, cors,
  graphql, race, cache-poison, smuggling, ssti, xxe, llm, mcp, privesc…) non comparivano mai in
  matrice, e 8 nomi usati dalla matrice non erano chiavi valide per `record-finding.js` (un finding
  `class: "file-upload"` veniva rifiutato). Ora le classi si derivano dal registry, i cinque nomi
  storici restano alias di display (una sola riga per classe) e `reports/<host>-map.json` viene letto
  in tutte e tre le forme realmente presenti — inclusa quella che `map.js` scrive
  (`endpoints[].candidates`), che prima dava "zero candidati" su una mappa piena. Invariante in
  `tools/test-coverage.js`.
- **Il progetto si chiama Cyboros Harness** — repo, package npm, i cinque `bin`, le etichette
  mostrate e il motore deterministico (`tools/cyboros.js`). Il rebrand non tocca la storia:
  `CHANGELOG.md`, le run registrate e i piani datati restano come erano. Design e mappatura in
  [`docs/superpowers/specs/2026-10-13-cyboros-rebrand-design.md`](docs/superpowers/specs/2026-10-13-cyboros-rebrand-design.md).
- **Le variabili d'ambiente passano a `CYBOROS_*`** da un solo modulo, `tools/env.js`: `env('TMP')`
  cerca `CYBOROS_TMP`, poi `STAVROS_TMP`, poi il default. Il prefisso vecchio resta letto per una
  release — un env var caduto non produce un errore visibile, produce report scritti altrove, quindi
  la finestra è esplicita invece che silenziosa. Una stringa vuota vale come assente.
- **Il formato dati verso terzi passa a `properties.cyboros`.** Nel SARIF il sacco delle proprietà,
  il `partialFingerprints` di deduplica e il driver (`Cyboros Harness`) usano il nome nuovo; le
  chiavi `properties.stavros` / `stavrosFindingId` restano emesse per una release, perché un
  consumatore terzo già cablato sulla vecchia chiave (GitHub code scanning, DefectDojo) perderebbe
  in silenzio il `verify_level` e il tetto di severità — l'unica cosa che un consumatore generico
  non può dedurre. Stessa finestra sull'header di sessione del Command Center: il server accetta
  `X-Cyboros-Token` e ancora `x-stavros-token`, il client emette solo il nuovo. Sul filo verso il
  target il marker benigno diventa `CYBOROS-MARKER` e lo User-Agent `CyborosReproducer/1.0`; le run
  antecedenti al 2026-10-13 restano attribuibili cercando `STAVROS-MARKER` (nota di compatibilita` in
  [`tools/payloads/upload-bypass/README.md`](tools/payloads/upload-bypass/README.md)).
- **Il bootstrap F3 non cabla più il nome della cartella del workspace.** `tools/f3-client-setup.sh`
  risolve il nome interrogando il PC (`cyboros-harness`, o `stavrosredteamer` prima del rebrand) e
  accetta `--pc-ws-dir` per forzarlo. Un `rsync --delete` verso una cartella inesistente copia zero
  file ed esce 0: il nome cablato era quindi un guasto silenzioso che sarebbe scattato alla rinomina.
  La `cwd:` del profilo sul telefono segue lo stesso nome risolto.

### Added

- **La chiave può stare in `~/.config/cyboros/<profile>.env` e `--allow-cloud` connette.** La
  risoluzione è ambiente → file per profilo (mode `600`, `KEY=value` o `export KEY=value`); un file
  leggibile da altri utenti viene rifiutato con `key_file_permissions`. Serve a non dover fare
  `source` a mano in ogni shell: `cyboros --allow-cloud` ora implica `--live` e parte già connesso,
  invece di mostrare «Shell only» con il modello elencato come autorizzato. Il flag resta
  l'autorizzazione esplicita per l'egress cloud; senza di esso vale il consenso al primo messaggio.
- **`cyboros` è conversazionale: il consenso cloud si dà al primo messaggio.** Con un profilo in
  `providers.json` e la chiave in ambiente, la TUI chiede una volta — in un frame che nomina
  provider, modello ed egress e cosa lascia l'host — se mandare il turno al modello. Il sì vale
  per la sessione ed è registrato come `cloud_consent`; il no viene ricordato. `cyboros --live`
  e `--task` continuano a pretendere `--allow-cloud`, e `/live --allow-cloud` è la via esplicita.
  Spariscono anche gli avvii impliciti del demo: una frase che nomina SQL injection o authz ora è
  un messaggio per il modello, non un walkthrough sintetico su `app.example.com`; il demo resta
  dietro `/demo`.
- **Menu, colori e navigazione come Claude Code.** La TUI ora ha il menu dei comandi: digitando
  `/` sopra il box compare la lista filtrata con le descrizioni, `↑`/`↓` spostano la selezione,
  `Enter` esegue il comando evidenziato, `Tab` lo inserisce lasciando il box aperto per gli
  argomenti, `Esc` chiude. `?` a input vuoto apre il pannello delle scorciatoie, `shift+tab` cicla
  ask → plan → auto (la hint row lo mostra) e `\` + Enter va a capo. La richiesta di approvazione
  è un frame unico con le opzioni navigabili con le frecce (numeri e Invio funzionano, `Esc`
  sceglie l'uscita sicura) e senza TTY resta stampata una volta con exit 1. Palette riscritta su
  quella di Claude Code — chrome grigio, testo chiaro, un accento caldo per logo/finding/selezioni,
  verde/giallo/rosso semantici, blu tenue per i comandi — al posto del neon magenta/cyan. I frame
  a piena larghezza disabilitano l'auto-wrap durante il disegno: senza, ogni redraw era sfasato di
  una riga e il frame di approvazione lasciava il bordo superiore nel transcript.
- **`cyboros` apre la TUI.** Il binario dichiarato nel `package.json` non è più solo la pipeline:
  senza sottocomando (o con un flag della TUI) su un terminale passa a `runtime/tui.js`; con un
  sottocomando — `cyboros scan host`, `status`, `resume` — resta la pipeline meccanica, e senza TTY
  l'usage esce ancora `2`, quindi pipe e test non cambiano. `install-cyboros-launcher.sh` crea il
  symlink idempotente in `~/.local/bin` (stesso schema di `install-cyboros-cc-launcher.sh`).
  `node:sqlite` è ora caricato pigramente da `tools/state.js`: un `cyboros` che non apre il DB non
  stampa più l'`ExperimentalWarning` sopra il box.
- **Interfaccia rifatta sulla forma di Claude Code.** L'ingresso è un box arrotondato ridisegnato a
  ogni tasto ([`runtime/inputline.js`](runtime/inputline.js): history, tab completion, ctrl+c/d,
  paste, larghezza CJK) con `>` e placeholder; la riga sotto porta `? for shortcuts` a sinistra e
  modo/target/costo a destra. Il messaggio inviato diventa una banda grigia con `>`, il transcript
  usa `⏺` per assistente e tool, un solo `⎿` con la coda indentata e `… +N lines (/details to
  expand)` per i risultati lunghi, `✻` dim per il reasoning chiuso da `✻ Thought for Ns`, e un
  footer di turno `✻ Worked for Ns · N tokens · $cost`. Le risposte sono Markdown reso — grassetto,
  inline code, liste, tabelle con colonne allineate e celle che vanno a capo invece di sbordare,
  code block — sia in streaming sia a turno completo ([`runtime/render.js`](runtime/render.js)).
  Readline resta solo fuori da un TTY (`--script`, pipe, `--task`).
- **Un solo assistente: conversazione e ingaggio nella stessa sessione.** La TUI non è più un
  loop che parte appena riceve testo. Il system prompt live distingue una domanda (finding,
  report, sessioni, metodologia) da un'azione sul target: la prima si risolve con i nuovi tool
  read-only `findings_query`, `sessions_list`, `session_read` (più `read_file`/`kb_search`),
  la seconda richiede `scope_check` e i tool guardati. Un turno senza target è valido — serve solo
  per le azioni di rete — e un saluto non avvia più recon. `plan` resta la modalità read-only
  esplicita.
- **Reasoning e risposta in streaming, resa tipo Claude Code.** `local/llm.js` estrae
  `reasoning_content` sia dal path SSE sia da quello JSON e lo espone con `onThinkingDelta` /
  `onThinkingDone`; la TUI lo stampa dim sotto `✻` mentre arriva, la risposta token per token
  sotto `⏺`, chiude i blocchi prima di ogni tool call e mostra nel footer durata, token e costo
  (`stream_options.include_usage` quando il gateway lo supporta). Nuovo `/thinking on|off`.
- **La TUI può guidare un modello vero, con lo stesso dispatch guardato.** `runtime/live.js`
  collega `runtime/tui.js` a un provider OpenAI-compatible (`runtime/providers.json`, gitignored):
  la chiave si legge solo da una env dichiarata (`api_key_env`), un `api_key` inline è rifiutato, e
  un profilo cloud richiede **sia** `allow_cloud: true` nel file **sia** `--allow-cloud` in riga di
  comando. Il loop riusa `local/llm.js` (tool loop, retry, trim del contesto) e il dispatch di
  `local/tools-bridge.js`: `scope_check` è il guard reale, `run_tool` passa da `tools/run.js` (quindi
  scope + enforce + gating), `record_finding` da `record-finding.js`, `write_file` resta sotto
  `reports/`. Un binario `intrusive` si ferma su un'approvazione numerata, registrata in
  `reports/approvals.jsonl`; senza TTY una run `--task` esce `1` senza eseguire il binario. Gli
  eventi (`run_start`, `tool_call`, `tool_result`, `approval_required`, `provider_call` con usage)
  finiscono in `reports/agent/sessions/<id>/events.jsonl`. Test ermetici: `tools/test-runtime-live.js`
  (provider HTTP locale, nessuna rete), con `tools/test-tui.js` a copertura della shell.
- **Target demo autorizzato per provare il loop attivo.** `demo/target.js` è un negozio sintetico
  su `127.0.0.1` con tre difetti deliberati — IDOR su `/api/users/:id`, BOLA su `/api/orders/:id`
  (basta che `X-User` esista) e XSS riflessa su `/search?q=` — e `demo/scope.demo.json` è
  l'autorizzazione loopback da usare via `SCOPE_JSON`. `demo/README.md` documenta la sequenza
  completa; la prova attesa (`X-User: bob` su un ordine di alice) resta `triggered`, non `exploited`.
- **Quattro payload reference nuove, tutte detection-only.** `tools/payloads/nextjs-rsc.md`
  (fingerprint versione, middleware bypass CVE-2025-29927, image optimizer 55173/57752, Server
  Action come endpoint di autorizzazione) non contiene **nessun** flusso RSC serializzato: la
  CVE-2025-55182 è RCE non autenticata e si prova dall'SBOM, non sparando un gadget. `data-api.md`
  (Supabase/PostgREST: RLS **e** grants, viste senza `security_invoker`, RPC `SECURITY DEFINER`,
  Storage, Realtime; Firebase: `shallow=true`, regole dedotte dal comportamento) lavora canary-first
  con la sola chiave `anon`; `cspt.md` (sink di navigazione dal bundle → catena CSRF) e
  `jndi-spel-ognl.md` (marker OOB sul nostro listener, `49` come marker matematico) chiudono le
  classi che non avevano un tool dedicato. Ognuno ha la tabella di mapping osservazione → classe →
  `verify_level`, così un finding non nasce da un'etichetta inventata.
- **`kb-search` indicizza anche `tools/payloads/**` e `workflows/*.yaml`.** Il corpus di default era
  `knowledge.md` + `docs/**`: la metodologia per classe c'era, ma i payload e i workflow —
  esattamente ciò che serve *prima* di testare — restavano fuori. `reports/` continua a richiedere
  `--docs`, perché lì dentro c'è evidenza di engagement e non metodologia.
- **Il RAG store parte con 18 tecniche cristallizzate.** `memory/rag-store.jsonl` + `RAG-INDEX.md`
  (rigenerato a ogni mutazione) coprono authz, cache poison, data-API, JWT, SSTI/JNDI, race, MCP,
  prototype pollution, GraphQL, CSRF-chain e altro. Ogni voce ha stack + ostacolo + soluzione
  generalizzata, passa lo stesso sanitizer delle lezioni (niente host/IP/email/token di scope) ed è
  richiamabile con `node tools/memory-recall.js "<stack> <classe> <ostacolo>"`. In `knowledge.md` il
  recall diventa il **passo 0** prima di ogni classe: un hit è una procedura già funzionata, non una
  prova, e va riprovata sul target.
- **Due workflow di classe nuovi e `zaproxy` nel registry.** `workflows/attack-nextjs.yaml`
  (fingerprint → middleware bypass con e senza header, controllo anonimo della stessa route, image
  optimizer, bundle) e `workflows/attack-dataapi.yaml` (bundle/chiavi pubbliche → lettura `anon`
  sulla tabella canary → Storage pubblico → regole Realtime) sono read-tier, ogni step con
  `on_error: continue` e artefatto su disco. Per il passo di fingerprint `tools/analyze-bundle.js`
  entra tra i guard wrapper ammessi da `workflow.js`: i suoi fetch passano già da `scope-guard`
  (DNS/IP-pinned). `zaproxy` (installato, ma invisibile a `run.js`) è ora nel registry (100 → 101,
  `active`, `alternative: nuclei`), quindi instradabile con scope + enforce.
- **Tre classi nuove nella tassonomia web**: `cspt` (client-side path traversal → catena CSRF),
  `data-api` (Supabase/PostgREST RLS+grants, Firebase rules) e `h2-desync` (HTTP/2→HTTP/1.1
  downgrade, H2.CL/H2.TE). Mapping CWE/WSTG/ASVS/OWASP-API e procedura di test detection-only in
  `docs/methodology-classes.md`; nessun payload RCE.
- **Credential testing con Brutus e secrets scan con Titus**, dalla scansione community di
  ottobre (`docs/community-scout-2026-10.md`). `go install` in `install-tools.sh`/`.ps1` e due
  voci in `tools/tool-registry.json` (97 → 99): `brutus` `intrusive` (43 protocolli, JSONL di
  soli successi, `alternative: medusa`) e `titus` `read` (`alternative: trufflehog`, scoring
  0–100, estrazione da APK/IPA, scan di immagini OCI incluse le layer cancellate). `run.js`
  impara a estrarre l'host da `brutus --target <host:port>` (senza, ogni run moriva su "no
  target host found" prima di arrivare al tool) e il nuovo workflow **`attack-creds`** fa il
  default-credential audit di UN servizio — `--mode cautious`, confirm-tier: solo con
  approvazione esplicita in sessione e, con `scope.host_ops.require_approval` attivo,
  `--var approval=<id>`. `--validate`/`--score-scope` di Titus sono egress confirm-tier.
- **Il Command Center ha una War Room.** Con l'operazione in corso, Mission dice *cosa fare* e il
  Ledger *cosa è successo*: `tools/cc-warroom.js` aggiunge la board che dice **cosa sta succedendo
  adesso**, in un solo snapshot read-only che compone i moduli esistenti — headline, azioni,
  approvazioni, gate e budget di mission; chain e feed del ledger; job runner; sessioni; coverage;
  mappa di esposizione; scope fail-closed — più orologio della finestra e burn budget con ETA al
  ritmo medio. `GET /api/cc/warroom` è l'endpoint; il delta è client-side (nessuno stato sul
  server): le tile cambiate fanno flash e le righe nuove del feed sono marcate. La vista
  `tools/gui/views-warroom.js` porta l'attention rail ordinata crit→warn→info, il drawer PANIC con
  conferma tipizzata (`POST /api/cc/warroom/panic`, wrapper su `cc-panic.js` — solo processi
  dell'harnes) e il TV mode fullscreen, leggibile da un secondo monitor o dal telefono via tunnel
  F3 (read-only). Nulla di nuovo può scrivere: il dispatch resta in Mission.
  **I numeri si attribuiscono alla campagna attiva dichiarando la base, mai deducendola:** nessun
  record dell'harnes porta un `campaign_id`, quindi l'attribuzione è temporale — la finestra RoE
  se la campagna ne ha una, altrimenti l'attivazione letta dallo storico append-only — e le tile
  guidano con i numeri della campagna tenendo il totale di workspace nell'hint (findings
  «campaign» vs 128 workspace, gate pass della campagna vs 6/6 workspace), il feed si filtra per
  campagna o workspace e un pannello *Campaign record* mostra cosa l'engagement ha prodotto
  davvero (finding, run eseguiti/rifiutati, approvazioni, gate pass, classi coperte su quelle
  dichiarate dal template). Se la campagna non ha né finestra né attivazione lo dice invece di
  inventare numeri: nessuna riga di feed viene marcata in-campagna per silenzio.
  `tools/test-cc-warroom.js` (offline: fail-closed, composizione, chain, burn/ETA, attention,
  attribuzione di campagna e caso non attribuibile) e route loopback in `tools/test-cc-routes.js`.
- Privilegi minimi per i binari di attacco, così l'agente non deve fermarsi a chiedere la password
  sudo all'operatore a metà engagement. Tre pezzi: `tools/cap-manifest.json` dichiara per ogni
  binario le capability minime **e il perché**; `grant-tool-caps.sh` le applica con `setcap` piu
  `net.ipv4.ip_unprivileged_port_start=0` per i bind sotto 1024; `tools/capcheck.js` verifica lo
  stato reale e `tools/cap-plan.js` valida il manifest e produce il piano che entrambi consumano.
  `cap_net_raw`/`cap_net_admin` su 19 binari (masscan, nmap, hping3, naabu, rustscan, arping,
  arpspoof, ettercap, suite aircrack, hcxdumptool/hcxpcapngtool, reaver, hostapd, dnsmasq, iw,
  iwconfig, ifconfig). Verificato empiricamente, non dichiarato: `masscan`, `naabu`, `hping3`,
  `ettercap`, `arpspoof` passano dal raw socket a utente, e il bind su 445 e 53 funziona.
  `install-tools.sh` chiude con la Fase 6 che invoca lo script.
- Il perché di **capability e non `NOPASSWD` sudo** è dichiarato in `docs/THREAT-MODEL.md`:
  `nmap --script=<file>` esegue Lua **come root**, quindi una regola NOPASSWD su nmap sarebbe una
  shell root per chi può scrivere un file; `setcap` concede un insieme di capability, non un uid.
  Il costo è detto altrettanto chiaro: `cap_net_admin` manipola interfacce ed è vettore di
  escalazione su alcuni kernel. I tool Python (responder, ntlmrelayx) non vengono toccati
  nell'interprete — coperti dalla soglia delle porte.

- `tools/report-sarif.js` — la prima uscita machine-readable della harness: SARIF 2.1.0 da
  `findings.jsonl`, accettato da GitHub code scanning e DefectDojo senza adattamenti. Fino ad
  ora c'era solo HTML, nonostante `tools/radar-profiler.js` dichiarasse gia `sarif` fra le
  capability di reporting: l'incoerenza e' chiusa. Ogni result porta in `properties.stavros`
  cio che SARIF non ha un campo per — `verify_level`, il suo `severity_ceiling`, `status`,
  `oracle_ref`/`oracle_type`, il blocco `verify` rieseguibile, `evidence_ref` — perche' la
  severity limitata dalle prove e' l'unica cosa che un consumatore generico non puo' dedurre.
  **Rifiuta** un record la cui severity eccede il `verify_level` (stessa regola di
  `record-finding.js`) ed esce 2 in quel caso: un run che ha perso record non puo' presentarsi
  come scan pulito. Un finding senza livello esce `unclassified`, mai promosso. 17 test offline.
  Verificato sui 128 finding reali del workspace: 128 emessi, 0 rifiutati, 106 con oracolo.
- 3 workflow offensivi: `attack-api-stateful` (property-based stateful API fuzzing dalla spec
  con schemathesis — copre BOLA/mass-assignment sul lifecycle e state-dependent authz, le classi
  su cui la harness e' piu' debole, perche' l'input deriva dal CONTRATTO e non dall'ipotesi
  dell'agente), `attack-h2c` (smuggling h2c detection-only) e `attack-wp` (fingerprint core
  zero-token + CVE plugin/temi via wpscan).
- 14 voci in `tools/tool-registry.json` (83 → 97 binari). Quattro erano **gia' installate** da
  `install-tools.sh` ma non registrate — `uncover`, `shuffledns`, `mapcidr`,
  `interactsh-client` — quindi passavano da `run.js` senza `risk_tier`, `timeout_ms` o
  `rate_class`: `shuffledns` e' un martello DNS e `pace.js` non aveva nulla su cui leggersi.
  Le altre dieci sono i binari apt installati ma non dichiarati, fra cui `medusa` e `dirb`,
  strumenti di credenziali oggi raggiungibili senza tier. Nessuna rimossa: registrate con tier
  onesti, che e' l'obiettivo di sicurezza.

### Changed

- **Command Center · la sezione Graph e' una mappa di esposizione per host.** Il vecchio canvas
  disegnava ogni porta scansionata come un nodo e non reggeva il modello: la proiezione leggeva
  `h.host`/`h.state` dove lo snapshot espone `address`/`alive`, quindi tutti gli host collassavano
  in un unico nodo `host:undefined` con id duplicati e i porti uguali su host diversi si
  accavallavano; endpoint e finding restavano orfani (archi verso un host che non esisteva) e
  finivano fuori canvas. La proiezione ora e' per host — un host per indirizzo, **fuso fra target
  IP e hostname** — con porte deduplicate (vince il fingerprint piu' ricco, un'osservazione `open`
  prevale su `filtered`/`closed`), servizi raggruppati dalle sole porte aperte (una porta filtrata
  non e' esposizione),  endpoint e finding agganciati per hostname/URL e un punteggio di rischio per l'ordinamento.
  La proiezione fonde **due fonti di verita'**: il target model (`state.db`) e il ledger dei
  finding (`reports/findings.jsonl`), perche' `record-finding.js` non ha mai scritto nel target
  model — dei target scansionati solo 4 host esistono nel model mentre i finding ne referenziano
  27: senza il merge la board mostrava 4 host su 28. Un host che vive solo nel ledger nasce dalle
  sue righe di finding (niente porte, niente endpoint), e' marcato `solo ledger` sulla card —
  cosi' non si legge come uno scan negativo — e resta agganciato ai finding che lo nominano; i
  target che non hanno prodotto ne' host, ne' endpoint, ne' finding finiscono in `empty_targets`,
  mostrati in un pannello a parte invece di sparire. Il dedup ledger-vs-model scarta un finding
  solo se proviene dal model, ha stesso url e stessa severity (chiavi piu' deboli perdevano 8
  finding su 128). La vista e' una board di triage: ricerca libera, filtro "solo con finding",
  ordinamento per rischio/finding/porte/host, drawer con le tabelle complete di porte, endpoint e
  finding. Gli endpoint restano testo e non link: la console e' read-only e non deve emettere
  richieste verso un target perche' e' stata aperta una tab. Sopra le card c'e' il grafo di
  relazione host → servizi aperti → finding: una banda orizzontale per host, quindi nessun arco
  fra cluster e nessun incrocio; i servizi sono aggregati (`http 80, 443, 8080, 8443` e' un nodo,
  non quattro) e i finding si appendono al servizio che possiede la porta del loro URL, altrimenti
  all'host — cosi' si vede a colpo d'occhio che 5 finding di 10.20.0.10 stanno tutti sul servizio
  `http`. Focus al click (le altre bande si attenuano) e drawer sul nodo; cliccando un finding il
  suo percorso host → servizio → finding resta acceso mentre il resto della banda sbiadisce, cosi'
  la catena che spiega perche' quell'host e' esposto si legge direttamente invece di ricostruirla
  a occhio. Il canvas e' limitato agli 8 host piu' a rischio e segue filtri e ordinamento delle
  card. 10 test offline in
  `tools/test-cc-graph.js` (merge fra le due fonti e host solo-ledger, `empty_targets`, dedup
  porte, aggancio per hostname, ordinamento per rischio, id senza `undefined`, workspace vuoto).

### Fixed

- **Validazione delle credenziali in bundle:** `analyze-bundle.js --validate-secrets --confirm "<reason>"`
  chiude il bordo `suspected`→`exploited` che `chain.js` gia' modellava: l'estrazione trova candidati
  ma non sa distinguere una chiave viva da una revocata, e `trufflehog` lo sa. Scelta deliberata:
  **solo validazione**, non `uncover` ne' `interactsh-client`, che restano registrati ma usati da
  nessun workflow — qui il costo di egress e' il piu' basso e il guadagno il piu' alto (una chiave
  che autentica e' la prova che mancava). E' **confirm-tier** e fallisce chiuso senza `--confirm`,
  perche' validare chiama l'API del provider. Il valore grezzo non viene mai persistito: file
  temporaneo `0600` fuori dal workspace, rimosso in un `finally`, output con solo detector/tipo/
  `fingerprint` sha256 troncato. `SECRET_PATTERNS` e' ora una lista condivisa fra estrazione e
  validazione, che non possono piu' divergere su cosa e' un candidato.
- `docs/THREAT-MODEL.md` enumera **dove finisce il confine dei guard**: tre rotte che lo aggirano
  (MCP montato nudo, binario invocato fuori da `run.js`, nessun egress a livello di kernel) e perche'
  il guard a network namespace non e' stato adottato — masscan, tuning di interfaccia, ARP spoofing
  e tun/tap non funzionano in una netns, e sono esattamente gli strumenti delle modalita' wireless e
  host-exploitation. Scritto, non lasciato implicito.
- `h2csmuggler`: la CLI upstream e' uno script Python (`h2csmuggler.py`, dipendenza `h2`), ma
  `go install github.com/BishopFox/h2csmuggler` compila solo `demo.go` e produce un binario che
  non e' lo scanner — si installa con hash pin in `install-tools.sh`, branch `master` (non
  `main`) e sha256 verificato. `-t/--test` e' la modalita' detection; senza `-t` lo stesso
  binario stabilisce il tunnel verso endpoint interni ed e' confirm-tier, mai in un workflow.
- `wp-check.js` aggiunto a `CMD_PREFIXES` in `tools/workflow.js`: si auto-scope-checka gia'
  (`scope-guard inScope()` prima di qualsiasi tocco di rete, verificato che blocca fuori
  scope), quindi era un guard legittimo escluso solo perche' mancava la voce — senza,
  `attack-wp` non validava nel dialetto workflow.

- `tools/forum-keystore.js` + verbo `node tools/forum.js keyring` — la chiave privata dell'agente non sta
  più in chiaro nel keyfile. **`0600` è un permesso, non una cifratura**: chi leggeva il filesystem — o
  un analizzatore esterno, che è il caso d'uso di un ambiente di studio — otteneva la chiave. Tre backend
  scelti per disponibilità, mai il plaintext se esiste qualcosa di meglio:
  - **`linux-keyring`** (default dove c'è `keyctl`): la chiave sta nel kernel keyring e **non viene mai
    scritta su disco**; sul file c'è solo `{agent_id, backend, keystore}`. Scoped all'utente e volatile,
    quindi l'identità va ri-seminaata a ogni sessione — il più forte e il più scomodo;
  - **`passphrase`**: su disco solo ciphertext (AES-256-GCM su chiave scrypt N=2^14, salt per-istanza);
    la passphrase arriva fuori banda e non è mai nel keyfile né nel prompt;
  - **`plaintext`**: il keyfile di prima, per retrocompatibilità, dichiarato `encrypted_at_rest: false`.
  Fallisce chiuso in due punti: senza passphrase non si iscrive (firmare in chiaro è peggio che non
  firmare), e passphrase sbagliata e ciphertext manomesso sono **indistinguibili** — AES-GCM li rifiuta
  allo stesso modo, quindi l'errore non è un oracolo.
  Correzione conseguente: il test che prima asseriva "la chiave è persistita nel keyfile" verifica ora
  l'opposto — nessun materiale chiave su disco in nessun backend tranne `plaintext`, dichiarato.

- `tools/forum-server.js`, `tools/forum.js`, `tools/forum-sim.js` + `skills/agent-forum/SKILL.md` —
  un forum multi-agente dove l'identità è **assegnata dal server** e l'iscrizione è **one-shot**, per
  testare comunicazione e collaborazione tra più agenti su ambienti simulati. L'invariante richiesto
  ("un agente, una sola identità, nessuna impersonation") è imposto dal runtime, non dal prompt:
  il prompt dice *cosa fare*, il server dice *chi sei*.
  - l'`agent_id` è derivato dalla pubkey e il display calcolato lato server: non esiste un campo
    `username` da scegliere, quindi l'impersonation non è vietata, è **non esprimibile**;
  - il token di iscrizione è single-use e single-use anche in chiave: su disco c'è solo lo sha256,
    quindi un dump di `state.json` non consegna credenziali utilizzabili;
  - ogni post firma con Ed25519 autore + timestamp + nonce + hash del corpo: replay, body-tamper e
    cambio d'autore invalidano la firma, e il transcript è append-only incatenato con ancora
    esterna (`tools/chain-log.js`), quindi riscrivere un messaggio è rilevabile;
  - `tools/forum.js` è l'unica superficie che il modello vede: **non ha `--as` né `--print-key`**, la
    chiave privata sta in un keyfile `0600` e `loadPrivate` non è esportata. Un prompt injection può
    far *chiedere* all'agente di firmare, non rubare la firma per firmare come un altro;
  - `tools/forum-sim.js run` avvia N agenti in **processi separati** su un ambiente simulato in
    mkdtemp, due round (osservare, poi rispondere): riporta quanti agenti hanno risposto a un altro
    autore e quanti tentativi rogue (ri-iscriversi, impersonare, replay, body-tamper) sono stati
    respinti. Exit 1 se un invariante cede.
  Correzioni fatte strada facendo, perché erano difetti reali e non dettagli: il server teneva lo
  stato in memoria dal boot e rigettava i token coniati da un altro processo; `lastJson` leggeva solo
  l'ultima riga e perdeva l'output indentato di `read`, così la collaborazione non veniva neppure
  esercitata; e un `spawnSync` nel test bloccava l'event loop del server che ospitava in-process.
- `tools/test-agent-forum.js` — 23 check loopback sulle quattro proprietà (iscrizione one-shot,
  impersonation, replay, body-tamper) più il rilevamento della manomissione del transcript.
  Il controllo "il wrapper non stampa il segreto" è una **prova a runtime** (si eseguono i verbi e si
  cerca il materiale chiave nell'output), non un grep sul sorgente: il grep produceva falsi positivi
  sui messaggi d'aiuto e falsi negativi su un `console.log(JSON.stringify(r))` che riversa un
  oggetto contenente `d`. Verificato con un controllo negativo — disabilitando la verifica della
  firma il simulatore scende a 8/16 tentativi respinti e esce 1, quindi il test ha denti.

- `tools/f3-client-setup.sh` — l'arsenale arm64 dentro il proot Kali ora include l'intera linea
  mobile (`apktool`, `jadx`, `apksigner`, `zipalign`, `androguard`, jar `libsmali-java`, `apkid` e
  `drozer`) e un installer proot-safe: due bug reali lo tenevano fuori dal telefono. `apkid` e
  `smali` non esistono nei repo Kali e un nome sconosciuto **aborta l'intera transazione apt**
  (nessun pacchetto installato, in silenzio); inoltre `jadx`/`apksigner` tirano `default-jre` e con
  esso `systemd`/`dbus`/`gtk`, i cui postinst falliscono sotto proot (niente PID1) lasciando `dpkg`
  mezzo-configurato. L'installer neutralizza quei postinst durante l'installazione, completa con
  `dpkg --configure -a`, riprova e li ripristina: `dpkg --audit` resta vuoto a fine run. Una nuova
  invariante in `tools/test-repo-invariants.js` impedisce il ritorno dei due bug.
- `tools/chain-log.js`, `tools/verification-log.js`, `tools/effective-findings.js` — la verifica come
  **fatto nuovo** invece che come modifica di un fatto vecchio. `findings.jsonl` è append-only,
  incatenato (A3) e ancorato esternamente, quindi una verifica fatta *dopo* la registrazione non
  aveva un posto dove finire, e l'unico percorso esistente (vedi sotto) riscriveva il file. Ora i
  fatti di verifica vivono in un side log con la stessa disciplina (`reports/verifications.jsonl`:
  append-only, catena, ancora esterna — la meccanica in un solo posto, `chain-log.js`), e lo stato
  di un finding è una **vista calcolata**: `findings.jsonl` fuso col side log, fail-closed verso il
  basso e con l'oracle **ri-validato su disco al momento del fold**, così un artefatto cancellato
  toglie la promozione. Il gate legge la vista per `verify`, `noPending`, `oracle`, `evidenceQuote` e
  `pocReplay`; gli altri consumer continuano a vedere lo stato registrato (la direzione prudente).
- `tools/rechain.js` — l'unica via di ripristino per una catena rotta, che finora non esisteva (la
  parola "riconciliata" compariva una volta sola, in un commento nel sorgente). Backup prima di
  scrivere, ricostruzione della catena sul contenuto **esistente** (cambia solo `chain`), e una voce
  `findings-rechain` con testa vecchia, testa nuova e **motivo obbligatorio** prima della nuova
  ancora: una riscrittura diventa un fatto leggibile nella storia invece di un'anomalia
  indistinguibile da un attacco. `--confirm "<motivo>"` è obbligatorio, come per le altre azioni
  distruttive del repo.
- Cinque file di test nuovi (`tools/test-verification-log.js`, `test-effective-findings.js`,
  `test-rechain.js`, `test-vendor-dir.js`, `test-request-approval.js`) e tre estesi
  (`test-verify-finding.js`, `test-gate-chain.js`, `test-cc-approvals.js`). Due di questi moduli —
  `vendor-dir.js` e `request-approval.js` — non erano menzionati in **nessun** test, e `vendor-dir.js`
  decide quale binario viene risolto ed eseguito.
- `docs/superpowers/specs/2026-09-28-findings-integrity-design.md` — il design (le evidenze E1–E4, le
  regole del fold, la sequenza).
- `tools/permission-matrix.js` — la campagna di autorizzazione multi-identità (BOLA/BFLA, artefatto
  Gate P1, batch2 WS1): ripete ogni endpoint come ogni identità e produce la matrice chi-vede-cosa,
  con i candidati a `verify_level: 'suspected'` — la registrazione resta di `record-finding.js,
  perché solo lì esistono il ceiling di severità e la disciplina dell'oracolo. Solo metodi sicuri di
  default; un metodo state-changing richiede `--methods` **e** `--confirm "<motivo>"`. Un'identità che
  risolve a zero header non diventa una richiesta anonima (fail-closed; `anon` è l'unica identità
  senza header, ed è esplicita). `exec` è iniettabile, quindi i test girano offline.
- `parsers.parseOpenApi` + `target-model.js ingest openapi <spec> --target <host>` (batch2 WS2) —
  OpenAPI 3.x e Swagger 2.0 → endpoint nel target model, idempotente. Fail-soft come tutti i
  `parse*`: input degradato → `[]`, mai un throw; un `$ref` non risolto non diventa un parametro
  inventato; un path relativo senza `--target` non inventa un host (conteggio 0 + nota). Serve a
  dare alla campagna di autorizzazione l'elenco REALE degli endpoint invece di indovinarli.
- `daily-maintenance.js` guadagna la rotazione di `temp/` (step 4): **report** delle voci stantie per
  default, archiviazione solo con `--rotate-temp`, soglia `--rotate-days`/`$STAVROS_TEMP_ROTATE_DAYS`
  (default 7). Non cancella: usa `workspace-gc.js`, che copia e verifica sha256 prima di toccare la
  sorgente e annulla se la verifica non torna. Su questa macchina sono 268 MB di lavoro di engagement
  in 19.661 file, che prima crescevano senza una policy.

### Fixed

- **Un percorso documentato poteva congelare la prova.** `knowledge.md` indicava
  `verify-finding.js batch` per la verifica batch: quella modalità riscriveva le righe di
  `findings.jsonl` in place, rompendo la catena A3 per costruzione, e da lì `record()` rifiuta ogni
  append e il gate `chain` fallisce. `batch` ora verifica, scrive il receipt dell'oracolo e **appende**
  al side log; `verifyFile()` resta esportato ma è **fail-closed** su un log incatenato (`refusing to
  rewrite`). Il test lo prova in modo diretto: `findings.jsonl` è byte-identico prima e dopo il batch.
- **Promuovere `confirmed` → `verified` era impossibile in append-only.** `record()` deduplica su
  `host|endpoint|title` e rispondeva `deduped:true` senza aggiornare nulla: l'unico modo di registrare
  l'esito di una verifica successiva era la riscrittura del file, cioè il guasto qui sopra.
  `recordWithVerify` su una chiave già presente appende ora il record di verifica al side log (e il
  risultato deduplicato porta il `seq` della riga esistente, che è ciò a cui il record punta).
- **`checkNoPending` era vacuo.** `pending` era definito come `status === 'pending'`, ma `validate()`
  impone lo status e ammette solo `confirmed|inconclusive|verified`: su un corpus registrato dal
  validator attuale il check **non poteva fallire**, quindi uno dei tre criteri dichiarati del gate
  ("nessun report senza copertura completa, nessun pending, almeno un verificato") era decorativo.
  La definizione nuova è falsificabile: pendente è una rivendicazione di realtà la cui prova non
  regge su disco (verifica fallita, oracle non più valido, o esito `verified` che non promuove).
- `tools/vendor-dir.js` rifiuta ora i percorsi con `..` o NUL: l'helper sceglie *quale binario* viene
  eseguito, quindi un percorso che esce dalla root non si risolve (prima veniva composto).

### Security

- **La race grant/use del consent token.** `cc-approvals.consume()` è read-then-write: due processi
  che consumavano lo **stesso** token nello stesso istante vedevano entrambi `granted` e appendeva
  entrambi la riga `consume` — un token dichiarato "single-use" non era atomico, ed è esattamente la
  superficie che `docs/THREAT-MODEL.md` §5 nomina ("the race between grant and use"). La sezione
  critica è ora protetta da un lock file (`openSync(..., 'wx')`, atomico sul filesystem; lock stantio
  rotto dopo 30 s; lock non acquisibile entro 3 s → `blocked`, fail-closed). Il test lancia **quattro
  consumatori concorrenti** sullo stesso id e pretende che ne vinca esattamente uno — la proprietà,
  non l'implementazione. Replay, host sbagliato, comando diverso e scadenza erano invece **già**
  coperti da `test-cc-approvals.js`: la voce del threat model si riduce a questo caso, e questo è il
  motivo per cui era scritto come caso singolo e non come cantiere.

### Changed

- `daily-maintenance.js` si esegue solo come CLI: un `require()` del modulo avviava una manutenzione
  completa (refresh KEV, mirror dei repo, reindex della knowledge base) come effetto collaterale
  dell'import. Ora `main()` è protetto come nel resto del repo, e il modulo espone `rotateTemp`
  perché i test possano esercitarlo.
- La meccanica di catena e ancora esterna è uscita da `record-finding.js` in `tools/chain-log.js`
  (comportamento invariato: le sue export restano, `test-record-finding` 31/31 e `test-ondata6`
  36/36 sul refactor). Prima di estrarla ho **misurato** i consumer: 28 file leggono
  `findings.jsonl`, quindi il fold è rimasto nella vista — `gate.js` ci passa subito, gli altri no.
- La suite passa da 95 a **103 test** e il motore da 142 a **147 moduli**; i conteggi dichiarati in
  `README.md` seguono la realtà, come impone `tools/test-repo-invariants.js`.

- `tools/verify-tag.js`: verifica un ref **in un clone temporaneo** invece che nell'albero di lavoro,
  eseguendoci i quattro gate di release (`test-repo-invariants`, `doctor --check`, `check-identity`,
  `npm test`) e stampando il commit risolto. È la lezione di `v0.1.0`, che era stato dichiarato verde
  misurandolo nell'albero locale mentre un clone pulito dello stesso tag falliva l'indice della
  documentazione. `tools/test-verify-tag.js` prova la proprietà che conta — con l'albero di lavoro
  sporco il tag committato resta verde, con lo stesso guasto committato e taggato esce 1 ed è il
  clone conservato a dirlo. La suite passa da 94 a 95 test.

### Fixed

- **`ops/radar.service` puntava a una scrivania che non esiste.** `WorkingDirectory=%h/Scrivania/…`,
  mentre su questa macchina la scrivania è `%h/Desktop` (lo dice `xdg-user-dir DESKTOP`, ed è il
  percorso che ogni altro artefatto installabile usa): l'unità non sarebbe partita. Ora punta a
  `%h/Desktop/cyboros-harness`. A monte, `tools/test-repo-invariants.js` ha un gate nuovo: ogni
  percorso cablato in un `.desktop`/`.service` deve risolvere dentro il checkout, e le cartelle
  della macchina che lo contengono (che non sono del repo) vengono segnalate a parte.

## [0.1.0] — 2026-09-28

Prima release taggata. Il tag `v0.1.0` è su un albero verificato **al momento del tag**:
`npm test` 94 PASS / 0 FAIL / 1 SKIP, `doctor --check` exit 0, `check-identity` coerente,
`test-repo-invariants` verde. Tutto ciò che segue è quanto si è accumulato fino a qui.

### Added
- `tools/test-repo-history.js` — a gate on the git **history**, which nothing checked before:
  every ref must be free of engagement paths (`refs/`, `temp/`, `reports/`, `evidence/`,
  `*.bak.json`, `scope.json`…), every pair of refs must share an ancestor, and no blob may exceed
  1 MiB. It runs in CI as the `history` job, which checks out with `fetch-depth: 0` because a
  shallow clone cannot answer any of those questions (the tool says so loudly instead of passing).
  An index-only gate was what let the two problems below survive for months.
- Apache-2.0 license and a `SECURITY.md` with a safe-harbor policy, a private
  disclosure channel, and an explicit statement of which vulnerability classes
  count as guardrail bypasses.
- GitHub Actions CI: runs the offline suite on Node 22 and 24, asserts the
  zero-dependency invariant, and fails if engagement data (`temp/`, `scope.json`,
  `auth.json`, `c2.json`, `*.bak.json`, `reports/`, `artifacts/`) is ever tracked.
- `docs/ARCHITECTURE.md` — the guard / model / tool separation, the evidence ladder,
  and the deliberate non-goals.
- `npm run test:ci` — the suite with 2 workers, for CI where determinism of ordering
  matters less than wall time. `npm test` stays sequential by design.
- `tools/testkit.js` — the test scaffolding the suite kept copying (counter, `ok`,
  `okAsync`, `summary`, plus `fixture`/`writeScope`/`runCli`/`runCliAsync` helpers).
  `test-attack-coverage`, `test-loop-watch` and `test-reflector` already use it; the
  remaining copies are a ratchet in `test-repo-invariants`, so new tests cannot add a
  thirty-first variant of the same twelve lines.
- `tools/test-repo-invariants.js` — an offline gate on the repository's claims about
  itself: the counts declared in `README.md` must match the real test/agent/workflow/module
  counts, the prompt budget of the knowledge files cannot be exceeded, no CHANGELOG entry
  may "replace" `X` with `X`, no doc may point at a `tools/*.js` that does not exist, no
  new engine module may arrive without a line of documentation, the agent fleet must be
  coherent (unique ids, required fields, resolvable `spawnableAgents`), the test scaffold
  cannot be re-copied, and no hostname from the current `scope.json` may appear in a file
  tracked by git. Its two baselines (undocumented modules, copied scaffolding) are
  ratchets: they can only shrink.
- `tools/mcp-guard-proxy.js` — the supported way to close the one architectural hole
  this project documents about itself. Mounting a third-party MCP server behind it puts
  `scope-guard` and `ssrf-guard` in series with that server: every `tools/call` is judged
  with the same functions the in-process tools use (`inScope`, `net.resolveAndGuard` for the
  DNS-rebinding layer, `checkAddress` on the pinned address), blocked calls never reach the
  server and answer the agent with an explicit error, and every verdict (`allow-scoped`,
  `allow-unscoped`, `block`) is appended to `reports/tmp/mcp-guard.jsonl`. Limits are
  declared in the header and in `docs/ARCHITECTURE.md`: targets are extracted from the
  arguments, and an in-scope hostname that cannot be resolved is refused (fail-closed).
- `tools/test-mcp-guard-proxy.js` — offline coverage for the proxy: passthrough of
  non-`tools/call` methods, block outside scope, block of the metadata tier even when
  `scope.json` authorizes it, allow on an in-scope target, the audit trail, request-order
  preservation, and the judgement function directly for the rebinding and fail-closed cases.
- `doctor.js --show-hosts` / `--fix-perms` — the human-readable output redacts the
  engagement allowlist by default (`N host + M CIDR`), because that output lands in
  screenshots and reports (`--json` stays complete: the Command Center is its consumer),
  and a new section 7 reports engagement secrets readable by other users on the same
  machine, with `--fix-perms` to set them to 0600. `doctor --check` exits 1 while any of
  them is exposed.

### Changed
- Documentation has an index again, and it is **generated**: `docs/INDEX.md` is written by
  `node tools/docs-index.js` from the real files (title, first paragraph, size, and for plans the
  checkbox progress), so it cannot drift the way a hand-maintained index does —
  `test-repo-invariants` runs it with `--check` and fails if the index is stale. It also gave the
  live surface its shape back: the root and `docs/` listed reference documents and plans side by
  side with nothing saying which was which.
- Superseded plans moved to `docs/archive/` (three files: the Command Center redesign plan, the
  desktop WP2–WP9 mission brief, and the never-wired design draft), with the landing evidence for
  each move in `docs/archive/README.md` and the archive listed from the generated index. The
  criterion is evidence, not ticks: `docs/superpowers/plans/2026-09-08-stavros-radar.md` has 26 of
  26 checkboxes open while its three `radar-*.js` tools shipped, so a checked box proves nothing
  here. `piano-ottimizzazione-stavros.md` stays on the live surface on purpose — its Fase B (stop
  vendoring binaries) has not landed.
- `README.md` engine-module count corrected 139 → 140: `tools/workspace-gc.js` had been added
  without updating it, so `test-repo-invariants` was failing on a clean checkout of `master`.
- The test suite is hermetic on shared state and parallel by default. An fs-audit preload
  attributed every in-repo write to a test: **22 of 94 tests wrote into the workspace, 130
  distinct paths, 6 destinations shared by two or more tests** — including three shared files
  (`reports/tmp/run-audit.jsonl` ×6, `reports/tmp/findings-head-anchor.jsonl` ×5,
  `reports/tmp/egress-proxy.json` ×3) and the global rate limiter `tools/.pace.json`. Both
  interference channels were then exercised, not assumed: a leftover `last` in the pace file
  took `test-repeater-e2e` from 3.5 s to **8.3 s** (the limiter blocks the thread for the
  global gap), and a leftover egress state file made `run.js` inject
  `HTTP_PROXY=http://127.0.0.1:9098` — a dead port — into **every** binary it spawns, i.e. the
  environment of every other test, and of the operator after the suite. `tools/testkit.js` now
  exports `hermetic()`, which points the eight state env knobs the engine already had
  (`PACE_FILE`, `RUN_AUDIT_FILE`, `FINDINGS_HEAD_ANCHOR_FILE`, `ARTIFACT_LEDGER_FILE`,
  `AUDIT_DIR`, `EGRESS_STATE_FILE`, `OBSCURA_EGRESS_STATE`) at a fixture; 16 tests call it.
  `run.js`, `egress-proxy.js` and `proxy-route.js` gained the one knob they lacked
  (`EGRESS_STATE_FILE`, default unchanged). Result: **11 of 94 tests write in-repo, 44 paths,
  and zero files shared with another test** (the three remaining shared destinations are
  directory `mkdir`s). The two re-run experiments now come back clean (3.5 s, assertions
  unaffected).
- `npm test` runs with 2 workers by default (`--jobs 1` still serializes). Measured before the
  change at `--jobs 1`, five interleaved rounds on the same 12-core machine, same work: 42.2 s
  median (one round 194 s — a uniformly ×5–6 slower run across *all* tests, i.e. the shared
  machine, reported rather than averaged away); `--jobs 2` 22.7 s median, `--jobs 4` 13.6 s,
  with PASS=94 / FAIL=0 / SKIP=1 in all nine runs. CI stays on `--jobs 2` on purpose: GitHub's
  runners were not measurable from here.
- `UNDOCUMENTED_BASELINE` tightened 47 → 41: six entries had become stale (reality was 41), so
  the gate was carrying six names it no longer needed to excuse — two of them
  (`memory-recall.js`, `memory-store.js`) because `ops/harness.md` now owns the RAG rule. The
  other ratchet, `OWN_SCAFFOLD_BASELINE` (39 tests that still copy the counter/`ok()` instead of
  importing `tools/testkit.js`), is unchanged: hermeticity moved *state* into fixtures, it did
  not touch the scaffolding, and migrating a file is a different job with a different contract
  (several tests use `ok(name, condition)` while the kit takes `ok(name, fn)`).
- Agent-fleet prompts de-duplicated against their single owner. The eight discipline rules and
  the RAG recall paragraph were copied verbatim into 19–29 of the 29 `.ts` files in
  `local/fleet/` + `.agents/`: 86 KB of the fleet's 185 KB, up to 29 byte-identical copies of the
  same 800-byte line. The copies could not be replaced by a bare reference, because the prompt
  assembly was measured first: `ops/harness.md` is a *pointer target*, not an injected knowledge
  file — zero of its bytes reach the assembled prompt (only `<project>/AGENTS.md` and
  `~/.AGENTS.md` are injected), so the owner never "arrives" on its own. Each prompt therefore
  keeps a **compressed in-context index** (every rule with its threshold and its command) and the
  owner keeps the extended text, now including a `## Memoria (RAG)` section it was missing. The
  authorization block stays byte-identical in all 29 files: it has no external owner, and the
  failure it prevents — refusing an in-scope task — fires *before* the first file read, so no
  pointer can prevent it. Class-specific variants (`stavros-llm`, `stavros-exploit`) were left
  intact rather than flattened. Fleet 184,810 → 154,296 bytes, duplicate blocks 86,086 → 51,986.
- `tools/test-repo-invariants.js` gained a three-part ratchet on that de-duplication: no line
  ≥100 characters may repeat in ≥3 fleet files outside the declared canonical allow-list (the
  authorization block, the harness pointer, the compressed index, the RAG pointer, the MCP
  config), the canonical blocks must still be present in every file that must carry them (so the
  first check cannot be passed by deleting them), and every rule compressed out of the prompts
  must still exist in `ops/harness.md` — "no instruction lost" as a machine check.
- `README.md` rewritten in English around the evidence-discipline and guardrail
  positioning, with the previously unstated differentators (zero dependencies,
  air-gapped operation, offline test suite) stated up front. Corrects stale
  structure claims: agents live in `local/fleet/`, and `vendor/` is no longer
  part of the repository. Its declared numbers now track reality (92 tests executed
  in ~1 minute, 28 agent definitions, 139 engine modules) and a test keeps them
  there instead of a stale 89/217.
- Real client names removed from documentation, scripts and test fixtures
  (`com.example.fest`, `acme.test`). Three tracked files still carried one client
  hostname after the previous pass — `local/plan.js`, `tools/stavros.js`,
  `tools/test-local-plan.js` — and now use RFC 2606 `.example` names.
- `doctor.js` counts the agent fleet where it actually lives (`local/fleet/` plus the
  root agent in `.agents/`). It previously required 20 `.agents/*.ts` files, so a
  healthy checkout — and CI — reported `core rotto=SÌ` on every run. `scope.json` is
  gitignored by design and no longer counts as a broken cardinal file.
- `vet-agents-vs-freebuff.js` vets both agent directories (29 agents) instead of the
  single root file left in `.agents/`, fails closed when it finds nothing to vet, and
  reports the Freebuff-only prompt fields as one aggregated advisory for `local/fleet/`
  instead of 28 errors (that schema binds the CLI, not the local runner).
- `tools/test-authn-depth.js` and `tools/test-sc1.js` are hermetic: own `SCOPE_JSON`,
  own `PACE_FILE`, no operator lab host, no dependence on the ambient `scope.json`.
  The race-watch checks in `test-authn-depth` failed intermittently in a full-suite run
  because the global cross-process limiter (`tools/.pace.json`) spread the `--race`
  volley out; `test-sc1` asserted a real HTTP 200 from a LAN-only lab address, so the
  offline gate could not pass anywhere else.

### Fixed
- `run-tests.js` now fingerprints the engagement files (`scope.json`, `auth.json`, `c2.json`,
  `wifi-scope.json`, `mobile-scope.json`) before and after every test: a test that rewrites the
  operator's written authorization — directly, or through a tool that falls back to the default
  path instead of an env override — fails loudly with the file names instead of being invisible.
- `gui-server.js saveScope()` cannot silently shrink the authorization any more: removing
  hosts requires `confirm_removals:true`, the serialized result is validated before the write,
  and the previous version is copied to `scope.*.bak.json` (gitignored) first. Writes through
  the service also re-apply 0600 to the engagement files.
- `test-sc1.js` no longer contacts an operator lab host (it binds its own loopback
  server and uses the documented opt-in), and the client lab address is gone from the
  tracked tests and fixtures.
- The Freebuff harness-mechanics notes moved from `AGENTS.md` to `ops/harness.md`
  (identical text, ~7 KB): they are maintenance reference for the wiring, and having them
  in every system prompt is what pushed the assembled prompt to 24 KB against the ~20 KB
  budget the workspace sets for itself. `test-repo-invariants` now holds that budget as a
  gate, and `check-identity.js` distinguishes "prompt too big" from "measurement taken on a
  snapshot older than the knowledge files" instead of reporting a stale number as a failure.
- `.gitignore` covers editor swap files (`*.kate-swp`, `*.swp`) and a `local-only/` home for
  one-off engagement scripts: a swap file of `scope.json` holds the same engagement data as the
  file itself, and the per-name rules for one-off scripts only catch the names someone thought of.
  CI asserts the ignore rules still cover the engagement paths, instead of listing them by hand.
- `.gitignore` never matched `scripts/probe-*.py` against `scripts/probe_ajax.py`,
  letting one-off engagement scripts — containing live session keys — through.
- `.gitignore` did not cover `temp/` (265 MB of per-engagement work: decompiled
  APKs, captured target HTML, caches, real hosts) or `scope.*.bak.json`.
- New stray backup files (`*.bak`, `*.v1-forensic`, `*.orig`, `*.rej`) are now
  ignored.

### Security
- The git history was rewritten to remove two things that a published clone would have exposed,
  neither of which is visible from the working tree or the index. **`refs/`** — the corpus with
  the licensing gap documented in `docs/REFS-PROVENANCE.md` — had been taken out of the index and
  gitignored, but was still present in 131 blobs (2.3 MB) across the history of `master`;
  `git filter-repo` rewrote all 31 commits without it. **`perf/pacing-and-cache`** was a lineage
  with no common ancestor with `master` (25 commits, root 2026-08-22) that carried ~70 MB of
  uncompressed engagement material — a 37 MB `arduino-cli`, a client source map
  (`evidence/noa4-synaptic/joinnoa-main.map`), a captured page (`evidence/raw/kela_succ.html`) —
  and was pushed to `origin`. A history with no common ancestor never reaches `master` through a
  merge, so no review of this repository would have shown it. It was deleted from `origin` and
  locally, along with `command-center-redesign` (an ancestor of `master`, nothing unique). The
  repository is one lineage again: pack 49.49 MiB → 2.08 MiB, objects 5,317 → 722, `.git`
  52 MB → 2.3 MB, refs/ blobs in history 131 → 0. Every commit got a new SHA, and the pre-rewrite
  state is preserved in a `git bundle --all` kept outside the repository and never pushed.

## 2026-09-26 — Command Center (WP2–WP9)

A desktop surface over the harness: campaign → mission → approval → execution →
verification → report → evidence. It is a surface, not a gate — it adds no bypass
and every write is a wrapper over an existing tool.

- **WP2** PyQt6 desktop shell `stavros-cc` with a panic switch that stops only
  harness-owned processes.
- **WP3** campaign model, templates, additive `/api/cc/*` router.
- **WP4** approval inbox with consent tokens (additive, default-off) — a confirm-tier
  action cannot start without a granted, non-reusable, host-bound token.
- **WP5–WP6** mission control, ledger/evidence bundle with hashed manifest, attack
  graph, coverage views.
- **WP7–WP8** engagement/attack/control rail, zero-build view split.
- **WP9** two-minute end-to-end demo, plan status, F3 tunneled-client runbook.

## 2026-09-27 — Local runtime and agent fleet split

- The 28 agent definitions moved from `.agents/` to `local/fleet/` (pure rename),
  separating the Freebuff-managed set from the runner that drives `tools/` directly.
- `local/`: a standalone runner (llm, grammar, plan, chat, tools-bridge, loop-guard)
  with its own config and no cloud dependency.
- `tools/`: radar (scout/profiler/analyst), Frida scripts, mobile pairing and
  repack, attack galaxy and coverage, portal, takeover, distiller, embeddings,
  cc-arsenal, tool-path, plus the harness self-probes
  `vet-agents-vs-freebuff.js` / `check-identity.js`.
- `workflows/`: 14 reusable `enum-*` / `attack-*` pipelines (HTTP, JWT, GraphQL,
  LDAP, SMB, Mongo, MSSQL, Redis, SNMP, container).

## 2026-09-10 — Context and binary footprint

- **Fase A**: `knowledge.md` reduced to 12 KB (from 41.8 KB) and the playbook
  `SKILL.md` split into `references/`, cutting the always-in-context load for all
  28 agents.
- **Fase B**: heavy vendored binaries (obscura, frida-server) moved to an external
  root resolved through `tools/vendor-dir.js`, keeping them out of the repository.

## 2026-09-08 — GUI redesign (phases 1–6)

Design tokens, primitives, rail and palette; overview stat tiles and findings trend;
a dense findings table with detail drawer; the pipeline rendered as a phase DAG;
sessions agent table with detail drawer; and cross-cutting polish for scope, reports,
accessibility, performance and responsive layout.

## 2026-09-06 — Initial workspace

The harness as a self-contained folder: zero-dependency tool engine, agent fleet,
engagement methodology, and the scope guards that everything else sits on top of.
