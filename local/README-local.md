# Cyboros Harness — Edizione LOCALE (modello abliterato via llama.cpp)

Versione **secondaria** dell'harness, ottimizzata per girare **senza cloud** su un modello
locale abliterato (es. **Qwen3.6-35B-A3B abliterated Q4_K_M** servito da `llama-server`).

## Perché è separata

Il runner normale (`freebuff`) è un **servizio hosted**: il modello gira sui server di
Codebuff/Freebuff e non si può puntare a un endpoint locale. Questa edizione è un **runner
autonomo** (`local/run-local.js`, Node ≥ 22, zero dipendenze npm) che:

- guida il **motore deterministico esistente** (`tools/` — scope-guard, pipeline Kali,
  gate, record-finding, chain…): i guardrail restano **nel codice**, non nel prompt;
- chiama il **modello locale** (API OpenAI di llama.cpp) **solo** nelle fasi di giudizio;
- collassa i **28 agenti cloud in 5 agenti di fase** con prompt corti, adatti a un modello
  ~3B-attivi: **niente preambolo anti-rifiuto** (il modello è abliterato, non rifiuta),
  niente boilerplate ripetuto, contesto tagliato e output clippato.

## Prerequisiti

1. `llama-server` attivo con il modello abliterato e l'API OpenAI su `127.0.0.1:8080`
   (vedi `~/Desktop/llm-locale-TODO.md`). Serve `--jinja` per il tool-calling:
   ```bash
   ~/llama.cpp/build/bin/llama-server \
     -m ~/models/qwen36-35b-abl/Qwen3.6-35B-A3B-abliterated-Q4_K_M.gguf \
     -c 131072 -ngl 99 --n-cpu-moe 36 -fa on -ctk q8_0 -ctv q8_0 \
     -t 4 --jinja --parallel 1 --host 127.0.0.1 --port 8080
   ```
2. `scope.json` compilato (è l'autorizzazione scritta; vuoto = tutto bloccato).
3. Node ≥ 22 (già richiesto dal progetto).

## Uso

```bash
# smoke test: verifica endpoint LLM + tools (non tocca target)
node local/run-local.js --check

# run completa guidata dalle fasi (recon-map -> web-test -> report)
node local/run-local.js <host-in-scope>

# una sola fase
node local/run-local.js <host> --phase recon-map
node local/run-local.js <host> --phase web-test --class sqli
node local/run-local.js <host> --phase report

# stampa system+task senza chiamare l'LLM (debug dei prompt)
node local/run-local.js <host> --dry

# --watch: stampa la conversazione completa, giro per giro, in tempo reale
node local/run-local.js <host> --phase web-test --class sqli --watch
node local/run-local.js <host> --phase web-test --class sqli --watch --watch-clamp 2000
```

### `--watch` — guardare l'assessment mentre avviene

`--watch` stampa su stdout cosa dice il modello a ogni giro, quale tool chiama con quali
argomenti, e **cosa il tool ha risposto**, poi il `FINAL`. Serve a capire *perché* un finding
non è stato trovato, che è la domanda che il punteggio finale non risponde mai.

Per seguirlo in un secondo terminale:

```bash
# terminale 1 (Freebuff)
node local/run-local.js 127.0.0.1:3001 --phase web-test --class sqli --watch 2>&1 | tee /tmp/bench-live.log

# terminale 2 (monitoraggio)
tail -f /tmp/bench-live.log
```

`--watch-clamp N` tronca ogni blocco a N caratteri (default 600); per output di tool
voluminosi conviene alzarlo, o abbassarlo se ti interessa solo la forma delle azioni.

**`--watch` è puramente osservativo**: non cambia grammatica, streaming, dispatch né
terminazione del loop, quindi un run con `--watch` resta confrontabile con uno senza. Il
test che lo garantisce è `tools/test-local-watch.js`. Nota che **non** è lo streaming
token-per-token: quello (`stream`/`onToken` in `local/llm.js`) esiste ed è usato dal REPL,
ma è incompatibile con la grammatica GBNF, e disattivarla cambierebbe la configurazione
misurata dal benchmark.
```

### Modalità `--plan` — recon autonomo → opzioni → **attesa dell'operatore**

```bash
node local/run-local.js <host> --plan                 # il flusso completo
node local/run-local.js <host> --plan --dry           # offline: niente LLM, niente rete, niente file
node local/run-local.js <host> --plan --no-auto-recon # salta la parte deterministica
node local/run-local.js <host> --plan --all           # includi anche le azioni già coperte
```

Fa tre cose e poi **si ferma**:

1. **Recon autonomo** — esegue la fase `recon-map` (pipeline recon/enumerate + mappa in
   `reports/<host>-map.json`).
2. **Auto-recon deterministico** — esegue dal grafo le azioni del planner
   (`tools/next-actions.js`) che sono *ammesse dallo scope-guard*, **non intrusive** e non già
   coperte. Le opt-in (sqlmap/netexec/coercion…) **non** vengono mai eseguite qui.
3. **Menu + STOP** — presenta le prossime azioni raggruppate per tier e aspetta la scelta:

```
 RICOGNIZIONE — sola lettura
  [ 1] snmp:161 — porta SNMP aperta: snmpwalk con community di default (sola lettura)
        $ node tools/workflow.js run workflows/enum-snmp.yaml -t <host>
 VERIFICA ATTIVA — non intrusiva
  [ 2] http:80 — servizio HTTP: fingerprint + probe (httpx/whatweb)
        $ node tools/workflow.js run workflows/enum-http.yaml -t <host>
 OFFENSIVO — intrusivo (conferma esplicita)
  [ 3] http-param:80 — endpoint con parametri: test injection  ⚠ richiede conferma
        $ node tools/run.js sqlmap -u <url> --batch --level 1 --risk 1

 Comandi: [numero] esegui · r ricarica il piano · w fase web-test · h fase host · R report · q esci
```

Regole della modalità (`local/plan.js`, testato da `tools/test-local-plan.js`):

- le opzioni **non le inventa il modello**: le produce il planner deterministico, già taggate
  col verdetto dello scope-guard; il modello serve solo per le fasi di giudizio (`w`/`h`/`R`);
- le azioni **fuori scope non sono nemmeno selezionabili** (elencate a parte, non numerate);
- un comando che contiene un **segreto** (`<secret>`) non viene mai eseguito: va a mano;
- il tier **intrusivo richiede una conferma esplicita in-sessione** (y/N) anche dopo la scelta:
  non esiste un percorso che lo esegua senza il tuo ok;
- il piano è **filtrato sull'host richiesto e i suoi sottodomini**: nessuna azione di altri
  engagement presente nel grafo può finire nel menu;
- senza TTY (script/cron) si ferma dopo aver salvato il piano: nessuna scelta implicita;
- ogni run lascia `reports/<host>-next-actions.json` e `.md` (piano presentato + scelte fatte).

## Launcher sul desktop (un clic)

```bash
./scripts/install-local-agent-launcher.sh     # scrive ~/Desktop/cyboros-agente-locale.desktop
```

Doppio clic su **"Cyboros — Agente Locale"** → si apre konsole con il launcher
`local/agent-local.sh`, che:

1. **avvia il modello solo se non è già attivo** (`curl :8080/v1/models`; se spento lancia
   `serve.sh` e aspetta il caricamento mostrando l'avanzamento — la finestra resta aperta);
2. se il server attivo è quello *CHAT* (`serve-chat.sh`, **DRY** attivo) avvisa e propone il
   riavvio pulito: il DRY tronca gli argomenti ripetuti dei tool (`192.168 → 192.16`);
3. apre un menu:

```
    1) Agente interattivo (REPL) — chatti e lui chiama i tool guardati
    2) Recon → opzioni → mi fermo in attesa della tua scelta  (--plan)
    3) Stato del modello (VRAM / sampler / tok-s)
    4) Smoke test dell'harness (endpoint + tools + GBNF)
    q) Esci
```

Da terminale, gli stessi percorsi senza menu:

```bash
bash local/agent-local.sh                      # menu
bash local/agent-local.sh <host>               # REPL sul target
bash local/agent-local.sh --plan <host>        # recon -> opzioni -> STOP
bash local/agent-local.sh --status             # VRAM/sampler + misura tok/s (~60 token)
bash local/agent-local.sh --check              # smoke test offline
```

## Configurazione — `local/config.local.json`

- `endpoint`: `base_url`, `model`, `api_key` (llama.cpp ignora la chiave).
- `sampling`: temperatura bassa (0.4) per tool-calling pulito; `max_tokens` per turno.
- `runtime`: `max_tool_iters`, `context_char_budget` (taglio duro del contesto),
  `tool_output_clip_chars`, `native_tools` (function-calling OpenAI) con
  `text_protocol_fallback` (il modello emette `ACTION: {json}` se non fa tool_calls nativi).
- `runtime.use_grammar` (**consigliato: true**): vincola l'output a `ACTION:{json}|FINAL`
  con una **grammatica GBNF** (`local/grammar.js`), costruita per fase sui tool ammessi.
  È la leva che rende affidabile il tool-calling su un modello debole senza addestrare nulla:
  niente JSON rotto, niente nome-tool inventato. Forza il protocollo testuale (disattiva i
  tool nativi per quella chiamata) e **si spegne da sola** se il server rifiuta la grammatica.
- `runtime.allow_thinking` (default false): consente un blocco `<think>…</think>` iniziale
  per i modelli reasoning; tienilo `false` per il massimo determinismo nel tool-calling.

### Grammatica GBNF — come funziona

Per ogni fase il runner genera una grammatica che ammette, per turno, SOLO:

```
ACTION: {"tool":"<uno dei tool della fase>","args":{ …json valido… }}
FINAL: <testo libero>
```

`llama-server` la riceve nel campo `grammar` di `/v1/chat/completions` e la applica in
decoding: il `tool` è vincolato all'enum dei tool della fase, gli `args` a JSON valido. La
validazione fine dei campi resta al dispatch (`tools-bridge.js`). Requisiti: `--jinja` non
serve in modalità grammatica (usa il protocollo testuale, non i tool nativi). Verifica live
con `node local/run-local.js --check` (fa una prova vincolata e conferma che l'azione è
parsata). Per tornare ai tool nativi OpenAI: `use_grammar: false`.
- `route`: mappa classe/subagent originale → fase; `phases`: ordine delle fasi.

## Le 5 fasi (`local/agents-local/index.js`)

| Fase | Copre gli agenti cloud | Tool esposti |
|---|---|---|
| `recon-map` | recon, osint, network, ad, mapper | scope_check, pipeline, run_tool, read/write_file, kb_search |
| `web-test` | sqli, xss, authz, authn, csrf, ssrf, injection, cloud, llm, idor | + record_finding, memory_recall |
| `host` | breach, postex, lateral, persist, privesc, cleanup, exploit | scope_check, run_tool, record_finding… |
| `wireless` | wireless, hardware, mobile | idem (scope wireless separato) |
| `report` | vet, reporter | read/write_file, record_finding |

## RAG semantico ibrido (opzionale)

Il RAG del progetto (`tools/memory-rag.js`) è di base **lessicale** (feature-hashing, offline,
zero-dip): matcha parole in comune, non il significato. Puoi attivare un **recall ibrido**
(dense semantico + lessicale) che matcha parafrasi/sinonimi e il mix IT/EN/ZH del repo, tenendo
tutto **in locale**.

1. Servi un modello di embedding con un **secondo** `llama-server` (piccolo, sta anche in CPU):
   ```bash
   # es. bge-m3 (multilingue) o multilingual-e5, in GGUF
   llama-server -m ~/models/bge-m3-Q8_0.gguf --embeddings \
     --host 127.0.0.1 --port 8081
   ```
2. In `config.local.json` metti `embeddings.enabled: true` (url/model già puntati a `:8081`).
   `run-local.js` esporta da solo `CYBOROS_EMBED_URL/MODEL/KEY` e `CYBOROS_RAG_ALPHA` ai tool.
3. Ricalcola i vettori delle voci già in memoria (una tantum):
   ```bash
   node tools/memory-rag.js reembed          # backfill dei record senza dense
   node tools/memory-rag.js stats            # verifica with_dense e dense_backend
   node tools/memory-rag.js recall "waf union select spring boot"   # mostra (ibrido d=../l=..)
   ```

A prova di fallimento: se il server di embedding è **spento o assente**, il RAG torna
automaticamente al lessicale — nessun crash, nessuna regressione. `alpha` (0–1) regola il peso
del dense nella fusione (default 0.6). Difesa OPSEC: l'endpoint deve essere **locale**; per uno
remoto serve `CYBOROS_EMBED_ALLOW_REMOTE=1` (così la memoria non esce per sbaglio).

## Sicurezza — invariata

- `scope-guard` è **hard-enforced** dentro `run.js`/`repeater.js`: il modello non lo bypassa.
- Il runner fa uno **scope_check duro** sull'host prima di ogni fase e si ferma se fuori scope.
- Azioni intrusive (lateral/persist/deauth/distruttive) **non** vengono eseguite dagli agenti:
  vengono messe in `FINAL` in attesa di conferma esplicita dell'operatore.
- `run_tool` instrada SOLO tramite il wrapper guardato; `write_file` solo sotto `reports/`.

## Componenti

```
local/
├── config.local.json      # endpoint/sampling/routing/budget
├── llm.js                 # client OpenAI per llama.cpp + tool-loop + fallback testuale
├── tools-bridge.js        # schema function-calling + dispatch ai tools/ guardati
├── agents-local/
│   ├── _shared.js         # disciplina minima condivisa (no anti-rifiuto)
│   └── index.js           # i 5 agenti di fase
├── plan.js                # modalita' --plan: planner->menu per tier->STOP in attesa dell'operatore
├── run-local.js           # il runner autonomo (driver)
└── README-local.md        # questo file
```

## Limiti noti

- Un modello ~3B-attivi sbaglia più spesso il JSON dei tool: il fallback testuale mitiga, ma
  tieni `max_tool_iters` basso e preferisci le fasi singole.
- La pipeline deterministica (`tools/cyboros.js`) fa il lavoro meccanico pesante; l'LLM serve
  per triage/verifica/report. Non aspettarti che il modello locale "buchi" da solo.
- Nessuna integrazione MCP (chrome-devtools) in questa edizione: solo tool locali.

## chat-local.js — REPL interattivo "al tuo comando" (2026-09-14)

Chat da terminale che esegue i TOOL REALI guardati (stesso motore di run-local.js), un passo
alla volta al comando dell'operatore. I tool ATTIVI (pipeline/run_tool) chiedono conferma y/N
se `/auto` è off. Niente GBNF in chat (fa collassare la risposta su questo modello): usa i tool
nativi + fallback testuale ACTION:. Il thinking è off per reattività (config allow_thinking).

    bash ~/models/qwen36-35b-abl/serve.sh          # server PULITO (no DRY) — obbligatorio: chat-local fa tool-calling
    node local/chat-local.js                       # apri il REPL

    # NB: NON usare serve-chat.sh (DRY) col REPL: il DRY corrompe gli argomenti dei tool
    # ripetuti (es. l'IP target viene troncato 192.168->192.16->192.1). serve-chat.sh e'
    # solo per la chat PURA senza tool. Verificato dal vivo il 2026-09-14.
    node local/chat-local.js <host> --phase web-test --class sqli --auto

Comandi: /target /phase /class /tools /scope /auto /reset /state /help /quit.
Cambiare fase/target/classe azzera la conversazione (system per-fase diverso).

Modifiche additive richieste (retro-compatibili, run-local invariato): local/llm.js — runAgent
accetta `history` (multi-turno); _completionBody onora allow_thinking via chat_template_kwargs.

### Metriche live + estetica "agent terminal" (2026-09-14)

Il REPL ora mostra la **velocità in tempo reale** e una veste ispirata agli agent terminal
(stile Hermes di Nous Research). Solo ANSI, **zero dipendenze npm**, solo built-in Node 22.

- **Banner d'avvio**: nome + modello + endpoint in un box, con uno **spinner** (braille) durante
  la connessione al modello.
- **Durante ogni turno**:
  - **prefill**: spinner `⠋ prefill…` finché il modello elabora il prompt (prima del 1º token);
  - **generazione**: riga di stato che si aggiorna dal vivo (con `\r` + `\x1b[K`), es.
    `⏱  prefill 380 tok/s · gen 33.4 tok/s · 128 tok · 3.9s`, con una **preview** in coda del
    testo che sta scrivendo — `prefill` da `prompt_per_second`, `gen` da `predicted_per_second`;
  - **riepilogo** finale stabile: `✔ prefill … · gen … tok/s · N tok · durata`.
  - Le righe **tool** (`· tool <name> …`) si inseriscono senza sovrapporsi alla riga viva.

Come funziona (additivo, non-stream invariato): `local/llm.js` espone un path **streaming SSE**
(`_postStream`) attivato solo quando `runAgent` riceve `stream:true` con i callback
`onToken` / `onTimings` / `onFirstToken`. Aggiunge al body `stream:true` + `timings_per_token:true`,
parsa a mano gli eventi `data:` (fino a `[DONE]`), accumula `delta.content` e ricompone i
`delta.tool_calls` per indice (il tool-loop resta identico). Le `timings` di llama.cpp
(`prompt_per_second` = prefill, `predicted_per_second` = generazione) sono normalizzate e passate
alla TUI. **Senza** questi parametri il comportamento è identico a prima: `run-local.js`,
`--check`, il preflight e le fasi autonome con GBNF restano **non-stream** e invariati (la GBNF
non è mai in streaming). Un unico `setInterval` a 90 ms ridisegna la riga viva dallo stato
corrente: i callback aggiornano solo i numeri, **niente polling per-token** che rallenti il
modello debole.

## `local/fleet/` — i 26 specialisti come playbook (2026-09-26)

I 26 file `cyboros-*.ts` (più `cyboros.ts`, l'orchestratore originale) **non stanno più in
`.agents/`**. Motivo: il core Freebuff si auto-aggiorna a ogni avvio del launcher
(`~/.config/manicode/freebuff`), e con la 0.0.203 la validazione pre-invio fallisce quando
`.agents/` contiene molte definizioni — senza dire perché (`Agent validation failed
unexpectedly`, `errors: []` sul log `log.jsonl`). Empiricamente: 2 agenti reggono, 23 no.
Nessun preflight esistente lo intercetta, perché modelli e tool erano tutti validi.

Ora `.agents/` contiene **un solo file**, `cyboros-root.ts` (displayName **Cyboros**), che:

- ha un **id locale** (`cyboros-root`), non uno preso dal registry. L'id collidingi è una
  trappola: il validatore risolve `base3-free-deepseek-flash` contro il template *bundled*,
  non contro il file locale, e rifiuta con `Non-empty spawnableAgents array requires the
  'spawn_agents' tool` descrivendo un agente che non è quello che hai scritto;
- contiene il contratto d'engagement di `local/fleet/cyboros.ts` — regole byte-identiche,
  meno i passaggi di delega agli sub-agent;
- ha `spawnableAgents: []` e `run_terminal_command`, e pilota il motore deterministico
  (`tools/cyboros.js`, `run.js`, `workflow.js`, `planner.js`, `coverage.js`, `gate.js`,
  `chain.js`) seguendo i playbook di `local/fleet/`.

Il modello è fissato in `~/.config/manicode/settings.json` (`"freebuffModel":
"deepseek/deepseek-v4-flash"`) invece di dipendere dal picker. Attenzione: quel campo è uno
slug di **modello**, non un agent id — `Ra` è il catalogo dei modelli e l'agente principale ne
deriva (`HuA()`/`OaH[]`, slug → `base3-free-<slug>`). Un valore che non è uno slug noto viene
scartato in silenzio e si ripiega sul default, che può cambiare a ogni auto-aggiornamento:
`tools/vet-agents-vs-freebuff.js` controlla anche questo.

`launch-freebuff.sh` esegue `tools/vet-agents-vs-freebuff.js` **fail-closed** prima di
`exec freebuff`: confronta modelli e tool con il binario installato e replica le regole note
dello schema agente (id non collidingi col registry, `spawn_agents` presente se
`spawnableAgents` non è vuoto, ogni id referenziato definito in `.agents/`, i tre prompt
presenti). Così un prossimo auto-aggiornamento che cambia le regole si vede all'avvio invece
di manifestarsi come TUI muta. `CYBOROS_SKIP_VET=1` salta il controllo.

### L'identità del main agent NON viene da `.agents/` (2026-09-26)

L'approccio "un solo root in `.agents/`" è corretto per la **validazione**, ma non serve a
 cambiare l'identità. Con la 0.0.203 `mainAgentState.agentType` è **sempre** un wrapper
bundled: `settings.json:freebuffModel` è uno slug di modello (`Ra` è il catalogo dei modelli,
non degli agenti) e l'agente ne deriva — `"deepseek/deepseek-v4-flash"` →
`"base3-free-deepseek-flash"` via `HuA()`/`OaH[]`. Non esiste `--agent`, e `settings.json`
non ha un override del system prompt. `cyboros-root.ts` viene comunque caricato e
registrato (`fileContext.agentTemplates["cyboros-root"]._sourceFilePath`): è un sub-agent
valido, non il main agent.

L'identità entra quindi dai **knowledge file**, che la CLI inietta nel prompt in quest'ordine:

| offset | blocco | sorgente | dice |
|---|---|---|---|
| `0` | header di sistema | built-in | "You are Buffy, the coding agent behind Codebuff" |
| `883` | ` ```AGENTS.md ` | progetto | contratto d'engagement (2,5 KB) |
| `3404` | ` ```~/.AGENTS.md ` | home | router identità (3,7 KB) |
| `33059` | `# Working with the user` | built-in | policy dei tool |
| `33305` | `# Freebuff Meta-information` | built-in | "You are the AI agent behind Freebuff" |

Quindi l'identità entra dai **knowledge file**, che la CLI inietta nel prompt in quest'ordine:

| offset | blocco | sorgente | dice |
|---|---|---|---|
| `0` | header di sistema | built-in | "You are Buffy, the coding agent behind Codebuff" |
| `893` | ` ```AGENTS.md ` | progetto | contratto d'engagement, **opt-in** |
| `4368` | ` ```~/.AGENTS.md ` | home | router (3,9 KB) |
| `11592` | `# Freebuff Meta-information` | built-in | "You are the AI agent behind Freebuff" |

### Cyboros è opt-in: `@cyboros` come primo messaggio (2026-09-26)

Il default è tornato quello del prodotto. **Cyboros si attiva solo se il primo messaggio
della conversazione inizia con il token `@cyboros`**; ogni altra sessione resta l'agente di
coding predefinito, anche dentro questa cartella. La cartella non cambia l'identità — cambia
il token.

I due pezzi che lo descrivono:

- `AGENTS.md` di progetto riapre con un blocco `ATTIVAZIONE — questo contratto è opt-in`, che
  dichiara esplicitamente che senza token il file resta documentazione del repository e non
  una personalità;
- `~/.AGENTS.md` (home) è il router: default = identità del prodotto, con l'unico opt-in
  `@cyboros` in testa. Dice anche che il token si legge **una volta sola** — `@cyboros` a
  metà conversazione non ri-arma niente, e toglierlo non la disarma.

Nota sul trigger: se la TUI intercetta la `@` con un popup di autocomplete, il token
arriverebbe alterato. Se è il caso, il fallback è un token senza `@` (es. `cyboros:`), che
nel prompt si cambia in un punto solo — router e `AGENTS.md` di progetto.

Verifica del wiring (non legge i messaggi: controlla che le condizioni dell'opt-in siano nel
prompt):

```bash
node tools/check-identity.js
```

### I due canali non vedono gli stessi knowledge file

| | `AGENTS.md` di progetto | `~/.AGENTS.md` |
|---|---|---|
| CLI | sì (offset ~893) | sì (offset ~4368) |
| Desktop | **no** | sì (offset 883, unica leva) |

Conseguenze operative:

- il router in `~/.AGENTS.md` tiene il §5 "When a Freebuff session misbehaves", che rimanda a
  `AGENTS.md` §"Freebuff CLI — meccanica dell'harness" senza duplicarne i 4 KB: è un puntatore,
  non una copia, così resta indipendente dalla dimensione;
- **il prompt è uno snapshot preso alla creazione del thread.** Dopo aver toccato un knowledge
  file, le sessioni già aperte non cambiano: serve un thread nuovo. Verificato sul Desktop, che
  continuava a servire i 26 KB della spec precedente su un prompt di 33.985 caratteri;
- per ispezionare il prompt Desktop:
  `sqlite3 ~/.config/freebuff-desktop/projects/<proj>-<uuid>/desktop-v2.db "select harness_state from threads order by rowid desc limit 1;" > /tmp/hs.json`
  — il dump supera 1 MB, quindi su file e non via `execSync` (ENOBUFS).

```
[identity] mode      opt-in '@cyboros' — inattivo finche' il primo messaggio non inizia con il token

  offset  sorgente
        0  built-in  "You are Buffy"
      925  progetto  contratto d engagement (opt-in)
     4880  router    default = identita del prodotto
     5126  router    opt-in sul token
    11691  built-in  "AI agent behind Freebuff"
```

**L'ordine delle regole conta più della loro presenza.** Una versione intermedia del router
metteva "l'harness dichiara l'identità ⇒ quella vale" al punto 1 e il contratto di progetto
al punto 2: l'header a offset 0 *è* l'harness che dichiara un'identità, quindi la regola 1
scattava sempre e la 2 non veniva mai valutata. Il sintomo ("ha letto le regole del workspace
ma resta Buffy") è indistinguibile da un modello disobbediente, ed è costato due round di
tentativi. `check-identity.js` esiste per rendere quella distinzione meccanica.

Prompt: 34.206 → 12.719 caratteri. I 26 KB della vecchia "Assistant Operating Specification"
(non ripristinati: dichiaravano "the assistant is GLM 5.3 Flash" e vincevano su tutto il
resto) stanno in `~/.assistant-spec.md`, da leggere on demand.

I file in `local/fleet/` restano agenti Freebuff validi: per usarli con la CLI cloud
ricopiare quello che serve in `.agents/` **una classe per volta** (la validazione è il
limite, non la sintassi — ogni file da solo va). Per il runner locale non servono: `local/`
li collassa già in 5 fasi (`local/agents-local/index.js`).

MCP `chrome-devtools` omesso dal root di proposito: è una variabile in più su una validazione
che non è ispezionabile. Per il DOM/CDP usa `tools/dom-check.js` e `tools/verify-finding.js`.

### I prompt della flotta non vengono iniettati, e cosa ne segue (2026-09-28)

Il `systemPrompt` di un file di `local/fleet/` o di `.agents/` è il prompt di **quel** sub-agente
quando viene spawnato: non entra nel prompt del main agent. Verificato sul prompt assemblato
(16.704 caratteri, `tools/check-identity.js`): zero byte di `ops/harness.md` e zero menzioni di
`AUTHORIZED ENGAGEMENT` — i soli due knowledge file iniettati sono `<progetto>/AGENTS.md` e
`~/.AGENTS.md`. Quindi deduplicare la flotta **non** libera margine nel prompt del main agent, e
un "rimando" a `ops/harness.md` non è una copia che arriva: arriva solo se l'agente lo legge.

La duplicazione era comunque reale (86 KB su 185 KB, fino a 29 copie della stessa riga). Il taglio
l'ha fatta così, distinguendo i due casi:

- **Regole di procedura** (8 bullet di disciplina, paragrafo RAG): il proprietario è
  `ops/harness.md`, quindi il prompt tiene un **indice compresso** — ogni regola, la sua soglia e il
  suo comando, in-context — e il proprietario tiene il testo esteso (nuova sezione `## Memoria (RAG)`).
  Nessuna regola è perduta: `test-repo-invariants` verifica che tutte esistano ancora nel proprietario.
- **Blocco identità/autorizzazione** (`AUTHORIZED ENGAGEMENT: …`, 800 B in 29 file): resta
  **byte-identico nel prompt**. Non è pigrizia: quel blocco non ha proprietario esterno, e il
  fallimento che previene (rifiutare un task in-scope) avviene **prima** della prima lettura, quindi
  nessun puntatore può prevenirlo. Le varianti di classe (es. `cyboros-llm`, `cyboros-exploit`) sono
  restate intere.

Risultato: flotta 184.810 → 154.296 byte, duplicazione 86.086 → 51.986 byte (di cui 22.400 il blocco
di autorizzazione che è deliberato). `tools/test-repo-invariants.js` ha tre ratchet nuovi: nessuna
riga ≥100 caratteri ripetuta in ≥3 file fuori dall'allowlist canonico dichiarato, i blocchi canonici
devono essere ancora presenti, e ogni regola compressa deve esistere in `ops/harness.md`.
