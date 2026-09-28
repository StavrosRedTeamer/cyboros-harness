# Brief di missione — completare la Stavros Command Center Desktop Edition

> Copia-incolla tutto il blocco qui sotto in una sessione nuova. È autosufficiente: la sessione
> non ha bisogno di altro contesto. Tenerlo aggiornato (progresso, WP chiusi) fa ripartire una
> sessione interrotta senza rifare lavoro.

```text
MISSIONE: completa la "Stavros Command Center — Desktop Edition" in questo repository
(/home/stavros/Desktop/stavrosredteamer). Obiettivo finale: un programma desktop avviabile
(stavros-cc) che governa l'harness StavrosRedTeamer a 360° — campagna, missione, approvazioni,
esecuzione, verifica, report, prova — completo, testato e funzionante quando l'operatore torna.

## 0. Contesto — leggi prima di toccare qualsiasi cosa

- Ambiente: Parrot Security 7.3, KDE Plasma 6.3.6 su Wayland (DISPLAY :0), Node 22.23.3,
  Chromium e konsole presenti, PyQt6 6.8.2 con QtWebEngine/printToPdf/QtDBus già installati
  (PySide6 NON ha WebEngine; GTK4+WebKit2 4.1 e AyatanaAppIndicator sono alternative valide).
- Leggi integralmente: `docs/command-center-desktop.md` — è la specifica. Contiene architettura,
  guardrail, modello dati e i work package WP0..WP9 con deliverable, file toccati, acceptance
  criteria (AC) e dipendenze. Il §7 ha i prompt per singolo WP e lo stato di cosa è già fatto.
- Leggi anche: `AGENTS.md`, `README.md`, `knowledge.md`, `ops/harness.md`, e i moduli in `tools/`
  che dovrai riusare (elencati al §4 qui sotto). Non reimplementare nulla che esista già.
- Prodotto già esistente: `tools/gui-server.js` (backend HTTP loopback zero-dipendenze, PTY via
  `tools/fbpty.py`, job runner con SSE, static serving della SPA) e la SPA `tools/gui/`
  (`index.html`, `app.js`, `app.css`, `vendor/xterm.js`) con 7 tab. La SPA è già stata rifinita in
  6 fasi di redesign: densità, token neon-duotone, command palette, drawer, DAG della pipeline.
- **WP1 è GIÀ FATTO — non rifarlo, costruisci sopra:** istanza unica (`tools/cc-instance.js` con
  lockfile `reports/app/server.lock`, `claim/read/isAlive/probe/clear`, CLI `status|url|probe|release`),
  token di sessione obbligatorio su POST/DELETE e sugli stream interattivi, `--instance` (attach con
  `SCC_ATTACH=<url>` ed exit 3), `--print-port` (`SCC_PORT=`/`SCC_URL=`), `GET /api/instance`,
  rilascio del lock su SIGINT/SIGTERM, `SCOPE_FILE` che rispetta `SCOPE_JSON`. Lato SPA: token da
  `?token=` → `sessionStorage` (URL ripulito), header `X-Stavros-Token` in `api()`, `?token=` sugli
  EventSource, banner `#cc-readonly` al primo 403. Launcher `start-command-center.sh` con token e
  attach. Test: `tools/test-cc-instance.js` (offline) e `tools/test-cc-server.js` (loopback).
- Non sei in un ambiente pulito: il working tree può contenere molto lavoro non committato
  (fase A/B + vendor move in corso, centinaia di path). È lavoro dell'operatore: NON toccarlo,
  non ripristinarlo, non staggiarlo, non committarlo. Aggiungi/staggia/committa SOLO i file dei WP
  che implementi, per nome. Mai `git add -A`, mai `git push`.

## 1. Ordine di esecuzione

WP2 → WP3 → WP4 → WP5 → WP6 → WP7 → WP8 → WP9 (dipendenze al §3 del piano).
Prima di iniziare: `git status` (annota il WIP, non toccarlo) e `npm test` (deve essere verde).
Un WP alla volta, dalla specifica nel piano, senza saltare gli AC.

## 2. Regole non negoziabili (violarle = WP non accettato)

1. Nessun bypass dei guard: ogni scrittura è wrapper su tool esistenti (`run.js`, `workflow.js`,
   `stavros.js`, `gate.js`, `budget.js`, `report-html.js`). L'app non esegue MAI un'azione
   confirm-tier: la consente (token di approvazione), poi l'agente la esegue con `--confirm`.
2. Fail-closed: se un guard non carica (es. `scope.json` illeggibile) l'app mostra "bloccato",
   mai "consentito".
3. Zero dipendenze npm, zero build, nessun asset esterno (niente CDN/font remoti). La shell PyQt6 è
   OPZIONALE a runtime: se manca → Chromium app-mode; se manca anche quello → browser.
   Node resta l'unica dipendenza dura.
4. Loopback only + token: nessuna nuova egress. I pannelli che escono davvero (es. `radar.js` →
   GitHub) lo dichiarano con un badge.
5. La dashboard/TUI deve restare funzionante dopo ogni WP: mai una modifica che rompa
   `start-command-center.sh` o il flusso CLI. L'app è una superficie, non un gate.
6. Dati cliente fuori da git: `campaign.json`, `campaigns/`, `reports/approvals.jsonl`,
   `reports/campaign-history.jsonl`, `reports/app/` (già in `.gitignore`).
7. Non stampare mai segreti: loot = solo conteggio, come fa oggi `gui-server.js`.
8. Il panic switch ferma SOLO processi posseduti dall'harness (job spawnati dall'app, PTY, listener
   avviati dall'harness), è idempotente e scrive un'entry nel ledger. Mai kill arbitrari.

## 3. Cosa costruire (dettaglio nei WP del piano)

- WP2 `stavros-cc`: shell PyQt6 (`tools/app/scc.py`) con menubar, toolbar, statusbar, tray con
  colore di stato, notifiche desktop + discreet mode/mute, QSettings per geometria/dock, single
  instance (`QLocalServer`), supervisore del backend (spawn → health → restart con circuit breaker,
  log in `reports/app/scc.log`), `--read-only`, `--headless`, `--web`, `--keep-server`, fallback
  Chromium/browser; icona SVG, launcher `stavros-cc`, `install-scc-launcher.sh`, `.desktop` con
  `StartupWMClass`; smoke test stdlib `unittest` in `QT_QPA_PLATFORM=offscreen`.
- WP3 campagna: `tools/cc-campaign.js` (schema v1, validazione non bloccante, scrittura atomica,
  `activate|update|archive|list`, drift dell'hash di `scope.json`, storico append-only),
  `templates/campaign/*.json` (web-app, internal-network, wireless, mobile, red-team-full), route
  `/api/cc/campaign*`, pannello Campaign + wizard nativo, rollup ore dal ledger.
- WP4 approvazioni: `tools/request-approval.js` (lato agente) + `tools/cc-approvals.js` (store
  append-only, token `{id, host, action_class, command_hash, scope_verdict, ttl, granted_by, note}`,
  coda in `operation-state.json` via CAS di `opstate.js`), integrazione ADDITIVA e DEFAULT-OFF in
  `run.js`/`c2-guard.js` (`--approval <id>`, policy `scope.json.host_ops.require_approval`), budget
  halt come card approvabile (`budget.js reset --reason`), pannello + badge tray + una riga in
  `ops/harness.md` (costo token minimo: `knowledge.md` è 12,6 KB, non gonfiarlo).
- WP5 mission control: `tools/cc-mission.js` (next-actions + coverage gaps + gate + budget +
  checkpoint autopilot + approvazioni pendenti, ognuno con perché/tier), `/api/cc/mission`,
  `POST /api/cc/dispatch` (job runner esistente; confirm-tier ⇒ serve il token), pannello Mission.
- WP6 ledger/grafo/coverage/report: `tools/cc-ledger.js` (unione opstate transitions, `gate-log.md`,
  `artifacts/audit/*.jsonl`, `artifact-ledger.jsonl`, hash-chain findings, approvazioni + evidence
  bundle tar/zip con manifest e hash + export PDF via `printToPdf`), `tools/cc-graph.js`
  (target-model/state.db → nodi/archi), `tools/cc-coverage.js` (classi + ATT&CK), pannelli Ledger,
  Graph, Coverage e upgrade di Reports (ciclo finding, retest diff, `artifact-ledger evidence`).
- WP7 controllo 360°: Config (scope/auth/wifi-scope/mobile-scope/c2.json con validazione live
  attraverso gli stessi moduli), Team (`fleet.js plan|render` dry-run), Arsenal (tool-registry +
  tool-plane mancanti + `doctor.js --json`, install solo su conferma tipizzata), Knowledge
  (`kb-search.js`, memoria RAG), Radar (badge egress), Doctor.
- WP8 IA + polish: navigazione a rail (Engagement/Attack/Control/Console), command palette con tutte
  le azioni, a11y (focus order, aria-live, contrasto AA), `prefers-reduced-motion`, perf, e split
  progressivo di `app.js` in viste caricate con `<script>` (zero build: estendi l'handler statico di
  `gui-server.js` — oggi serve solo `/app.css`, `/app.js`, `/vendor/*`, `/reports/*` — con
  allowlist di estensioni `.js/.css/.svg/.json`, risoluzione basename-only, mai path traversal).
- WP9 distribuzione: installer + uninstall, README e `docs/command-center-desktop.md` aggiornati,
  `docs/f3-client-runbook.md` (app come client desktop di un backend tunnelato), unit systemd user
  opzionale, script demo di 2 minuti.

## 4. Moduli da riusare (non riscrivere)

`scope-guard.js` (verità di scope, env `SCOPE_JSON`), `opstate.js` (CAS + transitions + leases),
`budget.js` (halt, `reset --reason`), `gate.js` (fasi recon→map→test→authed→chains→report,
gate-log), `coverage.js`/`coverage-loop.js` (gap), `attack-coverage.js`/`attack-galaxy.js` (ATT&CK),
`next-actions.js`/`autopilot.js` (piano), `target-model.js`+`reports/state.db` (grafo, `node:sqlite`
read-only), `sessions.js`/`sliver.js`/`msf.js`/`c2-guard.js` (sessioni e tier auto/confirm),
`fleet.js`+`docs/agents-fleet.yaml` (team), `audit-trail.js` (hash-chain append-only),
`artifact-ledger.js` (azione→artefatto, verify), `report-html.js`, `doctor.js --json`,
`kb-search.js`/`memory-rag.js`, `radar.js`, `fbpty.py` (PTY). Convenzioni: `tools/*.js` flat,
zero-dipendenze, commenti in italiano o inglese come nel file, nessun header di licenza.

## 5. Test e verifica (obbligatori, con output reale — mai dichiarare verde senza averlo eseguito)

1. `npm test` (gate: `tools/run-tests.js` scopre `tools/test-*.js`; tag nell'header
   `// test-tags: loopback` o `// test-tags: e2e`). Scrivi un test per WP, flat in `tools/`,
   in stile repo (assert puri o `node:test`): deve fallire se il WP si rompe.
   Per testare il server usa `CC_STATE_DIR` e `SCOPE_JSON` su una tmpdir: MAI scrivere lo
   `scope.json` reale né i report reali.
2. Smoke SPA headless: `chromium --headless=new --dump-dom "http://127.0.0.1:<port>/?token=<t>"`
   (oppure `node tools/dom-check.js`), assert su topbar/tab; verifica che senza token le write
   rispondano 403 e che il banner `#cc-readonly` compaia.
3. Check guardrail manuale a fine WP: server su 127.0.0.1, Host/Origin invariati, nessun asset
   esterno (tab Network), nessun endpoint nuovo che salti i guard.
4. `node tools/doctor.js --check` e `node tools/cc-instance.js status` per l'ambiente/istanza.
5. Shell desktop: test offscreen; poi prova reale di lancio, tray, notifica, attach su istanza viva
   (secondo lancio non deve spawnare), chiusura finestra ⇒ backend fermo (salvo `--keep-server`),
   `--read-only` che disabilita i pulsanti di scrittura.
6. WP4: test su token scaduto/riusato/hash comando sbagliato/host sbagliato; e con policy OFF il
   comportamento deve essere identico a oggi (non-regressione).
7. WP5: i numeri del pannello devono coincidere con l'output CLI degli stessi moduli.
8. WP6: il verdetto della hash-chain deve coincidere con `gate.js`; l'evidence bundle si verifica
   con `node tools/audit-trail.js verify` e `node tools/artifact-ledger.js verify`.

## 6. Definition of done (missione completa)

- `stavros-cc` parte da icona/launcher: finestra nativa con icona propria, SPA dentro, tray con
  stato, notifiche, supervisore del backend, single instance, fallback funzionanti.
- Ciclo di campagna completo dall'app: wizard con template → missione (next action con perché) →
  approvazione (token) → dispatch (job con log live) → finding → ledger con chain verificata →
  report/esportazione → evidence bundle verificabile.
- Nessuna regressione: `npm test` verde, TUI/CLI intatte, `start-command-center.sh` funzionante,
  dashboard usabile da browser e dal telefono via tunnel.
- Doc aggiornati (README, piano con WP → ✅, runbook F3) e script demo di 2 minuti eseguibile.
- Commit per WP, messaggi descrittivi (perché, non solo cosa), solo i file del WP, mai push.

## 7. Se finisci il budget o resti bloccato

- Non lasciare il tree rosso: se stai a metà di un WP, porta il codice a uno stato che passa
  `npm test` e la dashboard che si apre, anche se la feature è parziale.
- Aggiorna `docs/command-center-desktop.md`: segna il WP come 🚧 con cosa manca, dove ti sei
  fermato e il prossimo passo concreto. Aggiorna anche questo brief se serve.
- Committa il lavoro del WP anche se incompleto (messaggio che dice cosa manca) e NON committare
  il WIP dell'operatore.
- Il rapporto finale deve elencare: WP chiusi/parziali, comandi eseguiti con esito reale, cosa
  resta, e come si avvia/testa il prodotto in 3 righe.

## 8. Comportamento

Non chiedere conferma per scelte reversibili: prendi il default sensato e annotalo nel riassunto
finale. Chiedi solo se una scelta è irreversibile o di sicurezza. Non descrivere ciò che faresti:
fallo. Preferisci modifiche minime e mirate, che rispettano lo stile dei file che tocchi.
```
