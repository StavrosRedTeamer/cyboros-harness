# Interfaccia CLI di `cyboros agent` — bozza

**Data:** 2026-10-19 · **Stato:** bozza per revisione
**Spec di riferimento:** [runtime indipendente con API key proprie](2026-10-19-independent-runtime-design.md)
**Bozza visiva:** [agent-console.html](../../mockups/agent-console.html) — tre viste (Console, Terminal, First run), dati sintetici.
**Decisione:** CLI-first. La UI del Command Center consuma la stessa API in M3 e non introduce
scorciatoie: tutto ciò che si può fare da CLI passa dai guard, e la CLI non ha un flag che li salti.

## 1. Principi

1. **Umano di default, macchina con `--json`.** In modalità umana l'output va su stdout; in
   `--json` stdout contiene **solo** NDJSON, e il progresso va su stderr.
2. **La decisione del guard è visibile.** Scope, tier, budget e profilo compaiono nell'header
   della run e in ogni rifiuto. Un rifiuto non ha un override: si corregge `scope.json`.
3. **Nessun segreto sullo schermo.** Le chiavi si mostrano solo come `sk-…a1b2`. Mai argv,
   mai prompt, mai log.
4. **Una schermata, una decisione.** Le azioni confirm-tier mostrano comando esatto, verdetto di
   scope e motivo, poi aspettano. Nessun `--yes` globale.
5. **Osservabilità senza effetti.** `--watch` stampa la conversazione ma non cambia grammatica,
   dispatch o terminazione (invariante già testata da `tools/test-local-watch.js`).
6. **Fail-closed anche sull'assenza di TTY.** Un'azione confirm-tier richiede un TTY o un
   approval token già concesso; in pipe si ferma.

## 2. Albero dei comandi

```
cyboros agent
├── run <host>        [--phase <p>] [--class <c>] [--profile <p>] [--plan]
│                     [--allow-cloud] [--local-only] [--budget <file>]
│                     [--watch] [--dry] [--json]
├── chat [<host>]     [--phase <p>] [--profile <p>] [--tools <a,b>] [--auto]
├── resume <session>  [--watch] [--json]
├── trace <session>   [--json] [--tail]
├── sessions          [--host <h>] [--json]
├── doctor            [--live] [--json]
└── providers         list | check [<profile>] [--json]
```

Globali: `--config <path>`, `--cwd <dir>`, `--no-color`, `--quiet`, `--verbose`, `--version`,
`--help`. `--api-key` **non esiste**.

`run` senza `--phase` esegue la sequenza dello stage-gate (`recon-map → web-test → host →
wireless → report`) e si ferma al primo gate che non passa.

## 3. Prima esecuzione

```
$ cyboros agent run app.example.com --phase web-test

✖ config: runtime/providers.json non trovata
  template  runtime/providers.example.json
  crea      cp runtime/providers.example.json runtime/providers.json
  chiavi    solo variabili d'ambiente (es. OPENROUTER_API_KEY)
  verifica  cyboros agent doctor
  exit 5
```

`doctor` è il preflight che dice la verità, senza indovinare:

```
$ cyboros agent doctor

cyboros agent 0.2.0 · node 22.14.0
┌────────────────────────┬────────┬──────────────────────────────────────────────┐
│ check                  │ esito  │ dettaglio                                    │
├────────────────────────┼────────┼──────────────────────────────────────────────┤
│ config                 │ PASS   │ runtime/providers.json · schema v1           │
│ profilo default        │ PASS   │ llama (egress local)                         │
│ ruoli                  │ PASS   │ 5/5 risolti                                  │
│ chiave llama           │ WARN   │ CYBOROS_LOCAL_KEY assente (llama.cpp la ignora)│
│ endpoint llama         │ SKIP   │ --live non passato                           │
│ scope.json             │ PASS   │ 2 host · 1 CIDR · fail-closed                │
│ prompt                 │ PASS   │ contract.md + 5 fasi · sha256 9c1e…          │
│ sessioni               │ PASS   │ reports/agent/ sessione scrivibile           │
│ tool esterni           │ WARN   │ sqlmap assente (install-tools.sh)            │
│ budget                 │ PASS   │ 240 req · 90 min · 500k tok                  │
└────────────────────────┴────────┴──────────────────────────────────────────────┘
```

Exit: `0` tutto PASS/WARN, `5` almeno un FAIL, `2` uso errato.

## 4. `run` — transcript umano

```
$ cyboros agent run app.example.com --phase web-test --class sqli --profile openrouter

┌ cyboros agent ────────────────────────────────────────────────────────────────┐
│ target   app.example.com             scope   IN SCOPE (scope.json: 1 host)    │
│ fase     web-test · sqli             model   vendor/model · openrouter        │
│ egress   cloud (autorizzato)         budget  0/240 req · 0/90 min · 0/500k tok│
│ prompt   9c1e… · config 4a7d…        sessione 01J8Z…                          │
└───────────────────────────────────────────────────────────────────────────────┘

▸ web-test · sqli  (mappa: reports/app.example.com-map.json, 18 endpoint)
  · memory_recall   "spring boot jdbc sqli"                 3 tecniche (RAG-0012, RAG-0041, RAG-0090)
  · run_tool        sqlmap -u https://…/api/orders?id=1 --batch --level 1
                                                            12.1s · 1 sospetto
  · repeater        GET /api/orders?id=1%27%20AND%201%3D1--  200 · marker assente

  finding  suspected · SQL injection (param id) · /api/orders
           verify_level suspected → severity massima Low
           reports/findings.jsonl#a41f

  finding  triggered · SQL injection time-based · /api/orders
           oracle 5/5 · 2.8s · evidenza reports/app.example.com/oracle-9f2.json
           verify_level triggered → severity massima Medium

✔ fase completata · 6 tool call · 18.2k in / 2.1k out · $0.041 · 41.7s
  prossimo  cyboros agent run app.example.com --phase web-test --class authz
  sessione  01J8Z…  (cyboros agent resume 01J8Z…)
```

Regole del transcript:

- l'header è l'unico posto in cui compaiono profilo, egress e budget;
- ogni tool call mostra nome, bersaglio e durata; un tool che fallisce mostra `exit N` e la classe
  d'errore, non lo stack;
- un finding mostra sempre `verify_level` e il ceiling di severity, mai solo la severity;
- la riga finale è l'unica che riassume il costo, e contiene il comando successivo.

## 5. Stati che aspettano l'operatore

**Confirm-tier.**

```
⚠ CONFIRM-TIER — richiesta approvazione
  azione   lateral movement · smb · 10.0.0.12
  comando  node tools/run.js netexec smb 10.0.0.12 -u svc -p ***
  scope    IN SCOPE (allowed_ips 10.0.0.0/8) · tier confirm
  motivo   playbook host/lateral, passo 3
  [y] approva una volta   [n] salta   [d] dettagli   [q] interrompi
```

L'approvazione è **single-use, host-bound e registrata** in `reports/approvals.jsonl` (stesso
store di `cc-approvals.js`). In assenza di TTY:

```
✖ approval richiesta per un'azione confirm-tier, ma stdin non è un TTY
  apri un terminale, oppure concedi il token dalla inbox del Command Center
  exit 1
```

**Fuori scope.**

```
✖ scope-guard: evil.example non è autorizzato
  host in scope   app.example.com, api.example.com
  per autorizzare aggiungi l'host a scope.json (autorizzazione scritta), poi riprova
  exit 1
```

Nessun flag `--force`, `--unsafe` o `--skip-scope`. Se il guard è troppo stretto, si allarga
l'autorizzazione, non si aggira il guard.

**Budget.**

```
■ BUDGET HALT — engagement
  cap     240 richieste · usate 240
  stato   operation-state.json · halted
  sblocco node tools/budget.js reset --reason "<perché l'operatore sblocca>"
  exit 3
```

**Contesto.**

```
! contesto 198k/200k: riduco a 120k e riprovo (1/1)
```

**Gate.**

```
✖ gate report: coverage matrix incompleta (3 classi senza esito)
  apri   reports/coverage-app.example.com.md
  exit 6
```

## 6. `run --plan`

Il flusso già esistente di `local/plan.js` resta identico nella sostanza: recon deterministico →
menu per tier → **STOP**. Le opzioni non le inventa il modello; arrivano da `tools/next-actions.js`
già taggate con il verdetto di scope. Le azioni fuori scope non sono numerabili.

```
PIANO — app.example.com

 RICOGNIZIONE
  [1] http:80 — fingerprint + probe (httpx/whatweb)
      $ node tools/workflow.js run workflows/enum-http.yaml -t app.example.com
 VERIFICA ATTIVA
  [2] http-param:80 — endpoint con parametri: test injection
      $ node tools/run.js sqlmap -u https://app.example.com/api/orders?id=1 --batch --level 1
 OFFENSIVO — richiede conferma
  [3] smb:445 — enumerazione share          ⚠ confirm-tier

 [numero] esegui · r ricarica · w web-test · h host · R report · q esci
```

## 7. `chat` — REPL

```
$ cyboros agent chat app.example.com --phase web-test --profile openrouter

target app.example.com · phase web-test · profile openrouter · scope IN SCOPE
/help per i comandi · Ctrl-D esce

you › testa l'IDOR su /api/orders/42 con l'identità user_b
agent › [scope_check] IN SCOPE
        [run_tool] repeater GET /api/orders/42 as user_b → 200, body_similarity 0.98
        ...
```

Comandi: `/target /phase /class /profile /tools /scope /auto /state /cost /resume /quit`.
`/auto` governa solo le azioni non intrusive; il confirm-tier chiede sempre.

## 8. `resume`, `trace`, `sessions`

```
$ cyboros agent resume 01J8Z…
sessione 01J8Z… · app.example.com · web-test/sqli · 14 eventi
ultimo   tool_result run_tool exit 0 (12.1s)
riprendo dal turno 5 · contesto 12.4k · prompt 9c1e…
```

```
$ cyboros agent trace 01J8Z…

seq  ora       tipo            dettaglio
  1  10:02:11  run_start       app.example.com · web-test/sqli · openrouter
  2  10:02:12  provider_call   18.2k in · 412 out · $0.003
  3  10:02:12  tool_call       scope_check app.example.com → allow
  4  10:02:13  tool_result     scope_check exit 0
  …
 14  10:02:53  run_end         ok · 6 tool call · $0.041
```

`trace --tail` segue la sessione live. `trace --json` restituisce l'event log invariato, senza
trasformazioni, così un consumatore può verificare la catena `prev_sha256`.

```
$ cyboros agent sessions --host app.example.com
01J8Z…  2026-10-19 10:02  app.example.com  web-test/sqli   ok       $0.041
01J7Q…  2026-10-18 16:40  app.example.com  recon-map       halted   3/4 budget
```

## 9. `--json` — contratto NDJSON

Una riga, un oggetto, su stdout. Il progresso umano va su stderr. `run` e `trace` emettono
NDJSON; `doctor`, `providers` e `sessions` emettono un singolo oggetto JSON.

```json
{"seq":1,"ts":"2026-10-19T10:02:11Z","type":"run_start","session":"01J8Z…","target":"app.example.com","phase":"web-test","class":"sqli","profile":"openrouter","model":"vendor/model","egress":"cloud","scope":"in_scope","prompt_sha256":"9c1e…","config_sha256":"4a7d…","budget":{"max_requests":240,"max_minutes":90,"max_tokens":500000}}
{"seq":2,"ts":"…","type":"provider_call","iter":1,"usage":{"tokens_in":18200,"tokens_out":412,"cost":0.003,"source":"provider"}}
{"seq":3,"ts":"…","type":"tool_call","tool":"scope_check","args":{"target":"app.example.com"},"verdict":"allow"}
{"seq":4,"ts":"…","type":"tool_result","tool":"scope_check","exit":0,"duration_ms":41}
{"seq":5,"ts":"…","type":"finding","id":"a41f","severity":"Low","verify_level":"suspected","class":"sqli","endpoint":"/api/orders"}
{"seq":6,"ts":"…","type":"approval_required","action":"lateral","tier":"confirm","command":"…","scope":"in_scope"}
{"seq":7,"ts":"…","type":"error","class":"provider_auth","profile":"openrouter","status":401}
{"seq":8,"ts":"…","type":"run_end","status":"ok","tool_calls":6,"usage":{"tokens_in":18200,"tokens_out":2100,"cost":0.041,"source":"provider"},"session":"01J8Z…"}
```

Tipi ammessi: `run_start`, `provider_call`, `assistant`, `tool_call`, `tool_result`, `finding`,
`approval_required`, `budget_halt`, `error`, `run_end`. Ogni evento porta `seq` e `ts`; gli eventi
sono gli stessi scritti in `events.jsonl`, quindi `trace --json` è la loro riproduzione esatta.

`usage.cost` è `null` quando il provider non lo espone: il runtime non inventa un prezzo.

## 10. Errori ed exit code

| code | quando | esempio |
|---|---|---|
| 0 | run completata | `run_end status ok` |
| 1 | guard o esecuzione bloccata | fuori scope, approval senza TTY, tool fallito |
| 2 | uso errato | flag sconosciuto, `--phase` inesistente |
| 3 | budget engagement | `BUDGET HALT` |
| 4 | budget di classe | `BUDGET HALT · classe recon` |
| 5 | config/provider | file assente, schema invalido, chiave mancante, 401 |
| 6 | gate | report rifiutato |

Ogni errore è una riga sola con `✖`, la causa e il comando che la risolve. Niente stack trace
in modalità umana; `--verbose` lo aggiunge su stderr.

## 11. Regole di terminale

- Larghezza massima 100 colonne; se il terminale è più stretto, il box si riduce e le colonne
  secondarie vanno a capo.
- `NO_COLOR` o `TERM=dumb` disattivano colore e caratteri Unicode di disegno; restano `OK/FAIL`
  e `->`.
- Un carattere per stato: `✔` ok, `!` warn, `✖` errore, `■` halt, `⚠` attenzione.
- Ctrl-C: il primo interrompe il tool corrente e chiude il turno in modo riprendibile; il secondo
  esce. La sessione resta su disco in entrambi i casi.
- I prompt si leggono solo dal TTY. In pipe, un'azione che richiede input fallisce con exit 1.
- `--quiet` sopprime il progresso umano, non gli errori. `--verbose` aggiunge trace su stderr.

## 12. Cosa non c'è, deliberatamente

- Nessun `--api-key`, nessun `--force`, nessun `--skip-scope`, nessun `--yes` globale.
- Nessuna modalità che scriva fuori da `reports/` o che invochi un binario senza `run.js`.
- Nessun prezzo inventato: `cost` è `null` se il provider non lo dichiara.
- Nessun auto-update: la versione è quella del checkout.
- Nessuna telemetria, nessun identificatore di installazione.

## 13. Modalità interattiva (TUI)

Prototipo eseguibile: [`runtime/tui.js`](../../../runtime/tui.js) — zero dipendenze. Senza `--live`
è una shell: nessuna chiamata al modello, nessuna scrittura. Con `--live` il turno passa a
[`runtime/live.js`](../../../runtime/live.js), che chiama un provider OpenAI-compatible e dispatcha
solo attraverso la superficie guardata.

- avvio: `npm run tui` oppure `node runtime/tui.js [host]`; `--demo` per il walkthrough SQLi;
- `--live`: provider da `runtime/providers.json` (o `--config <file>`, che vale anche per `/model`).
  La chiave viene solo da `api_key_env`; un `api_key` inline è rifiutato (`config_inline_key`). Un
  profilo `egress: cloud` richiede `allow_cloud: true` nel file **e** `--allow-cloud`; senza il flag
  la run non parte (`cloud_requires_flag`). `--allow-cloud` da solo implica `--live`, quindi
  `cyboros --allow-cloud` connette all'avvio invece di aprire una shell. La chiave viene
  dall'ambiente, oppure da `~/.config/cyboros/<profile>.env` (mode 600, `KEY=value` o
  `export KEY=value`; l'ambiente vince, un file leggibile da altri utenti è rifiutato con
  `key_file_permissions`). `llama` punta a `127.0.0.1:8080` per l'air-gapped;
- un solo assistente: la stessa sessione risponde alle domande e fa l'ingaggio. Una domanda
  (finding, report, sessioni, metodologia) si risolve con i tool read-only — `findings_query`,
  `sessions_list`, `session_read`, `read_file`, `kb_search`, `memory_recall` — senza scansionare;
  un'azione sul target richiede `scope_check` e poi `run_tool`/`pipeline`. Un saluto non fa partire
  nulla. Il turno non richiede un target: serve solo per le azioni di rete;
- tool reali: `scope_check` invoca `tools/scope-guard.js`, `run_tool` invoca `tools/run.js` (scope,
  enforce, gating, cache disattivata nel loop), `record_finding` invoca `record-finding.js`,
  `write_file` è confinato a `reports/`. Il modello vede l'output vero e decide il passo dopo;
- reasoning e streaming: `reasoning_content` del provider è emesso in streaming sotto `✻` (dim),
  la risposta token per token sotto `⏺`; `/thinking off` nasconde il reasoning. Il footer del turno
  riporta durata, token in/out e costo quando il provider lo dichiara (`stream_options.include_usage`
  quando il gateway lo supporta). `timings_per_token` è opt-in per profilo: i gateway generici lo
  rifiutano con 400;
- conferma: un binario `risk_tier: intrusive` non parte senza l'approvazione numerata, che viene
  scritta in `reports/approvals.jsonl` (`granted`/`denied`/`stopped`). In `--task` senza TTY la run
  esce `1` e il binario non viene eseguito; nel REPL interattivo l'operatore resta al comando;
- sessione: `reports/agent/sessions/<id>/events.jsonl` con `run_start`, `user`, `tool_call`,
  `tool_result`, `approval_required`, `provider_call` (usage token), `run_end`. `--task "…"` esegue
  un turno e chiude, `--live` da solo apre il REPL;
- banco di prova: `demo/target.js` (loopback, difetti sintetici) + `demo/scope.demo.json`, vedi
  [`demo/README.md`](../../../demo/README.md). È l'unico modo previsto di provare il loop attivo
  senza toccare un ingaggio reale;
- autorizzazione reale: fuori da `--demo` il REPL legge `scope.json` (o `--scope <file>`,
  con `SCOPE_JSON` come override) tramite `tools/scope-guard.js`. Un file assente o vuoto blocca
  tutto; `/target` fuori scope non cambia nulla, un host posizionale fuori scope esce `1`.
  `--demo` usa una allowlist sintetica (`app.example.com`, `api.example.com`) e lo dichiara;
- `/findings` e `/sessions` leggono in sola lettura `reports/findings.jsonl` e
  `reports/agent/sessions/<id>/meta.json`; se il ledger manca lo dicono, non inventano finding;
- transcript inline, nella forma di Claude Code: box d'ingresso arrotondato con `>` e
  placeholder, hint row sotto (`? for shortcuts` a sinistra, modo/target/costo a destra); il
  messaggio inviato diventa una banda grigia con `>`; l'assistente apre con `⏺` e le continuazioni
  sono allineate sotto il testo; il tool è `⏺ nome(args)` con un solo `⎿` e la coda indentata
  (`… +N lines (/details to expand)`); il reasoning è dim sotto `✻` e chiude con
  `✻ Thought for Ns`; il turno chiude con `✻ Worked for Ns · N tokens · $cost`; `◆` resta per i
  finding. Il Markdown è reso — grassetto, inline code, liste, tabelle allineate con celle che
  vanno a capo, code block — sia in streaming sia a fine turno
  ([`runtime/render.js`](../../../runtime/render.js));
- input box: [`runtime/inputline.js`](../../../runtime/inputline.js) è un editor raw-mode minimale
  (ridisegno del box, history, tab completion, ctrl+c/d, paste, larghezza CJK), perché readline non
  può disegnare un box attorno alla riga che possiede. Fuori da un TTY resta readline: `--script`,
  pipe e `--task` non cambiano;
- menu dei comandi: digitando `/` sopra il box compare la lista dei comandi con la descrizione,
  filtrata mentre scrivi; ↑/↓ spostano la selezione, Enter esegue il comando evidenziato, Tab lo
  inserisce lasciando il box aperto per gli argomenti, Esc chiude il menu. `?` a input vuoto apre
  il pannello delle scorciatoie; `shift+tab` cicla la modalità (ask → plan → auto) e la hint row
  la mostra. `\` + Enter va a capo nel prompt;
- consenso egress: senza `--live` la TUI è shell e un messaggio non esce. Se `providers.json`
  dichiara un profilo con chiave in ambiente, al primo messaggio compare un frame che nomina
  provider, modello ed egress (`cloud`/`local`) e cosa lascia l'host; il sì vale per la sessione,
  viene registrato come evento (`cloud_consent`) e soddisfa il requisito cloud al posto del flag
  `--allow-cloud`, che resta obbligatorio per `cyboros --live` e per `--task`. Il no viene
  ricordato (niente domande a ogni turno); `/live --allow-cloud` è la via esplicita. Senza chiave
  il frame non compare e la TUI dice quale env manca. Le frasi che nominano SQL injection o
  authz non avviano più il demo scriptato: il demo resta dietro `/demo`;
- prompt di conferma: la richiesta di approvazione è un frame unico con le opzioni navigabili
  con le frecce (numeri e Invio funzionano, Esc sceglie l'uscita sicura); senza TTY lo stesso
  frame viene stampato una volta e la run esce `1`, senza auto-approvare;
- colori: palette neutra di Claude Code — chrome grigio, testo chiaro, un solo accento caldo per
  logo, finding e selezioni, verde/giallo/rosso semantici per esito, warning ed errore, blu tenue
  per i comandi; in plan mode il bordo del box passa al blu, come in Claude Code; nessun colore
  quando `--no-color` o `NO_COLOR`, dove il box degrada in ASCII;
- approvazione confirm-tier numerata: `1 Approve once · 2 Skip · 3 Details · 4 Stop`.
  Senza TTY rifiuta e ferma la run (`exit 1`); `--demo-approve` è l'unica deroga, per test e CI;
- status line: target · fase/classe · provider/modello · ctx · costo · richieste · modo;
- slash command: `/help`, `/demo`, `/scope`, `/target`, `/phase`, `/class`, `/model`, `/live`,
  `/plan`, `/auto`, `/ask`, `/budget`, `/findings`, `/gate`, `/trace`, `/status`, `/permissions`,
  `/details`, `/thinking`, `/compact`, `/sessions`, `/resume`, `/clear`, `/quit`;
- modalità `ask` (default), `auto` (solo tool non intrusivi) e `plan` (read-only);
- `--script` legge i comandi da stdin per test e demo. `--no-color` / `TERM=dumb` disattivano
  colore e caratteri Unicode (larghezza massima 100 colonne); `--ascii` fa lo stesso tenendo il colore;
- test: `node tools/test-tui.js` e `node tools/test-runtime-live.js` (ermetici, offline — il
  provider è un HTTP server locale; il runner li scopre da solo).

Senza `--live` restano scriptati modello e transcript del walkthrough; autorizzazione, ledger dei
finding e sessioni sono quelli veri. Con `--live` sono veri anche modello, tool e approvazione. Il
passo ancora aperto non è più il dispatch ma il runtime di fase: `runtime/loop.js` deve comporre i
28 agenti di `local/fleet/`, il planner per tier e la ripresa di una sessione, invece di esporre il
solo turno singolo.

## 14. Questioni aperte

- Formato del session id: ULID (ordinabile, senza dipendenze) oppure `<timestamp>-<rand>`.
  La bozza usa ULID, ma la scelta va fissata prima di M1 perché entra nei path.
- `--plan` dentro `run` o comando separato (`cyboros agent plan`)? La bozza lo tiene come flag per
  non duplicare la superficie; da verificare con l'uso reale.
- Il transcript umano deve mostrare i token per singola chiamata o solo il totale di fase? La
  bozza mostra il totale e lascia il dettaglio a `trace`.
