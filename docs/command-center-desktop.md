# Stavros Command Center — Desktop Edition (piano e work package)

**Obiettivo.** Portare il Command Center da dashboard web a **programma desktop** (`stavros-cc`)
che governa StavrosRedTeamer a 360°: campagna → missione → consenso → esecuzione → verifica →
report → prova. Riferimenti di settore: Cobalt Strike / Havoc / Sliver (console operatore,
sessioni, kill switch), Mythic / CALDERA (operazioni → task → artefatti → ATT&CK), reNgine /
Trickest (pipeline e scan engine), BloodHound (grafo), PlexTrac / Dradis / PwnDoc (ciclo del
finding, report cliente, retest).

**Differenziatori.** (1) **Inbox approvazioni**: il consenso dell'operatore (budget halt,
confirm-tier C2, opt-in intrusivi) diventa un token verificabile invece di una battuta in chat.
(2) **Evidence bundle** firmato: hash-chain findings + artifact-ledger + gate-log + approvazioni
in un pacchetto verificabile. (3) **Mission control deterministico**: le next action vengono dal
planner dell'harness, non da un LLM. (4) Offline-by-design, zero-dipendenze, un solo backend per
desktop / browser / telefono.

---

## 0. Guardrail non negoziabili (valgono per ogni WP)

1. **Nessun bypass dei guard.** Ogni scrittura resta wrapper su tool esistenti
   (`run.js`, `workflow.js`, `stavros.js`, `gate.js`, `budget.js`, `report-html.js`). L'app non
   esegue mai un'azione confirm-tier: la *consente*, poi l'agente la esegue con `--confirm`.
2. **Un solo backend vivo.** Lockfile + `reports/app/server.lock`. Un secondo avvio fa **attach**,
   non spawn (due PTY sulla stessa TUI Freebuff si pestano i piedi).
3. **Token di sessione** per ogni write (POST/DELETE) e per lo stream del terminale. Le GET di
   dati restano loopback-trusted come oggi.
4. **Fail-closed**: se un guard non carica (scope.json illeggibile) l'app mostra bloccato, non
   "consentito". Vale anche per il manifesto campagna e per le approvazioni.
5. **Dati cliente fuori da git**: `campaign.json`, `campaigns/`, `reports/approvals.jsonl`,
   `reports/campaign-history.jsonl`, `reports/app/` sono gitignored.
6. **Zero dipendenze npm, zero build, nessun asset esterno.** PyQt6 (shell) è opzionale a runtime:
   se manca → Chromium app-mode; se manca anche quello → browser.
7. **Nessuna nuova egress**: l'app parla solo con 127.0.0.1. I pannelli che escono davvero
   (`radar.js` → GitHub) lo dichiarano con un badge egress.
8. **Il TUI resta completo**: l'app è una superficie, non un gate. Chi non la usa non perde nulla.

---

## 1. Architettura

```
┌──────────────────────── stavros-cc (PyQt6 6.8.2, Wayland/X11) ────────────────────────┐
│ menubar · toolbar · statusrail · tray+notifiche · dialoghi nativi · QWebChannel bridge │
│  ┌──────────────────────────────┐  ┌───────────────────────────────────────────────┐  │
│  │ QWebEngineView               │  │ dock nativi: Approvals · Activity · Terminal  │  │
│  │ = SPA tools/gui/ (14 viste)  │  │ (xterm) · Doctor                              │  │
│  └──────────────────────────────┘  └───────────────────────────────────────────────┘  │
│  supervisore: spawn/health/restart (circuit breaker) · single instance (QLocalServer)  │
└───────────────────────────────────┬───────────────────────────────────────────────────┘
                                    │ http loopback + token + SSE (porta da lockfile)
┌───────────────────────────────────▼───────────────────────────────────────────────────┐
│ tools/gui-server.js (hardening invariato: loopback, Host/Origin, body cap)            │
│   └─ router additivo: tools/cc-{campaign,approvals,mission,ledger,graph,coverage}.js   │
│        letture: reports/*, state.db (RO) · scritture: wrapper sui tool esistenti       │
└──────────────────────────────────────────────────────────────────────────────────────┘
```
Fallback: `--web` (browser/telefono F3 via tunnel) e `--read-only` (ispezione senza scritture).

---

## 2. Modello dati

| File | Contenuto | Git |
|---|---|---|
| `campaign.json` | campagna attiva: cliente, RoE, finestra, obiettivi, superfici, team, budget, hash di scope.json | ignored |
| `campaigns/<id>.json` | archivio campagne (attivabili) | ignored |
| `reports/campaign-history.jsonl` | append-only: attivazioni/modifiche/archiviazioni | ignored |
| `reports/approvals.jsonl` | append-only: richieste, decisioni, token (hash, mai segreti) | ignored |
| `reports/app/server.lock` | istanza viva: `{pid, host, port, token, startedAt, url}` | ignored |
| `reports/app/*.log` | log shell/backend con rotazione | ignored |
| `artifacts/audit/*.jsonl` (esistente) | audit-trail hash-chained (riusato) | invariato |

---

## 3. Work package (uno per sessione)

Ogni WP è mergeabile da solo, con la dashboard sempre funzionante. "AC" = acceptance criteria
verificabili. La colonna *Dipende* dice cosa deve essere già in `main` prima di iniziare.

| WP | Titolo | Peso | Dipende |
|----|--------|------|---------|
| 0 | Stabilizzare il WIP | S | — |
| 1 | Fondazioni backend: istanza unica, token, handshake | M | 0 |
| 2 | Shell desktop (`stavros-cc`) | M | 1 |
| 3 | Campagna + template | M | 1 |
| 4 | Inbox approvazioni | L | 1,3 |
| 5 | Mission control + dispatch | M | 3,4 |
| 6 | Ledger · Grafo · Coverage · Report studio | L | 3 |
| 7 | Controllo 360° (config, team, arsenal, knowledge, radar, doctor) | M | 2 |
| 8 | IA a rail + polish (a11y, perf, split viste) | M | 5,6 |
| 9 | Distribuzione, doc, demo | S | 2..8 |

---

### WP0 — Stabilizzare il WIP (operatore)

**Cosa:** 348 path modificati + 61 untracked (fase A/B + vendor move) sono aperti. Non si
costruiscono 8 WP sopra un diff aperto.
**Deliverable:** commit (o stash) del lavoro in corso, `npm test` verde, branch pulito.
**AC:** `git status --porcelain` vuoto a parte i WP in corso. `npm test` exit 0.
**Nota:** lo fa l'operatore — l'app non c'entra.

---

### WP1 — Fondazioni backend: istanza unica, token, handshake ✅ (questa sessione)

**Deliverable**
- `tools/cc-instance.js`: lockfile atomico (`reports/app/server.lock`, override `CC_STATE_DIR`),
  `read/isAlive/write/clear/probe`, stale detection (pid morto ⇒ riuso), CLI `status|probe|release`.
- `tools/gui-server.js`: `--instance` (attach se c'è già un'istanza viva: stampa `SCC_ATTACH=<url>`
  ed esce 3), `--print-port` (`SCC_PORT=`, `SCC_URL=` con token), `--token auto|off|<valore>`
  (default `auto`), enforcement del token su POST/DELETE e su `/api/term/stream`,
  `GET /api/instance`, rilascio del lock su exit/SIGINT/SIGTERM, `SCOPE_FILE` che rispetta `SCOPE_JSON`.
- `tools/gui/app.js`: token da `?token=` → `sessionStorage` (URL ripulito), header
  `X-Stavros-Token` in `api()`, `?token=` sull'EventSource del terminale, banner read-only al 403.
- `start-command-center.sh`: genera il token, apre l'URL tokenizzato, `--attach` friendly.
- `.gitignore`: dati cliente + `reports/app/`.
- Test: `tools/test-cc-instance.js` (offline) e `tools/test-cc-server.js`
  (`// test-tags: loopback`).

**AC:** `npm test` verde; senza token ogni write risponde 403; con token 200; secondo avvio in
`--instance` fa attach (exit 3) invece di spawnare; il lock sparisce alla chiusura; la SPA apre
e legge i dati senza token, con banner che spiega perché le write sono disabilitate.

---

### WP2 — Shell desktop `stavros-cc`

**Deliverable**
- `tools/app/scc.py` (PyQt6): QMainWindow con menubar (File/Engagement/View/Actions/Tools/Help),
  toolbar (selettore campagna + chip stato + `⌘K` + Panic), statusbar, tray con colore di stato,
  notifiche desktop (con **discreet mode** e mute), geometria/dock salvati in QSettings,
  single instance (`QLocalServer`) con **handshake di raise**: il secondo lancio chiede alla
  finestra viva di sollevarsi, attende l'`ok` e solo allora esce; un peer muto (istanza vecchia o
  bloccata) viene scavalcato così la finestra si apre comunque — mai un'uscita silenziosa senza
  finestra, e se il backend non parte l'errore è mostrato in un dialog (non solo nel log),
  supervisore del backend (spawn → health → restart con
  circuit breaker), log in `reports/app/scc.log` con rotazione, `--read-only`, `--headless`,
  `--web`, `--kiosk`, fallback Chromium app-mode / browser.
- `tools/app/icons/stavros-cc.svg` (icona neon-duotone), `stavros-cc` (launcher),
  `install-scc-launcher.sh` (idempotente, `StartupWMClass`, Actions), `stavros-cc.desktop`.
- `tools/app/test_scc.py`: smoke test stdlib `unittest` in `QT_QPA_PLATFORM=offscreen`
  (finestra costruita, tray creato, supervisore chiama `--instance`).

**AC:** doppio click sull'icona → finestra nativa con icona propria e SPA dentro; chiudendo la
finestra il backend si ferma (tranne `--keep-server`); un secondo lancio solleva la finestra
esistente; nessun asset esterno; `--read-only` disabilita i pulsanti di scrittura.

---

### WP3 — Campagna + template

**Deliverable**
- `tools/cc-campaign.js`: schema v1, validazione fail-closed-ma-non-bloccante (campagna senza RoE
  ⇒ badge rosso, i guard non cambiano), scrittura atomica, `activate|update|archive|list`,
  drift detection dell'hash di `scope.json` (badge *stale* + ri-firma), storico append-only.
- `templates/campaign/*.json`: **web-app**, **internal-network**, **wireless**, **mobile**,
  **red-team-full** → superfici, gate applicabili, workflow YAML, matrice classi/ATT&CK, preset
  fleet (`docs/agents-fleet.yaml`).
- Route `GET/POST /api/cc/campaign*`; pannello *Campaign* nella SPA; wizard nativo nella shell.
- Rollup ore per fase/operatore dal ledger (gate transitions + job runs).

**AC:** creare/attivare/archiviare una campagna da wizard e da pannello; switch campagna **non**
riscrive `scope.json`; scope modificato fuori app ⇒ badge stale; `campaign.json` non entra in git.

---

### WP4 — Inbox approvazioni (human-in-the-loop)

**Deliverable**
- `tools/request-approval.js` (lato agente) + `tools/cc-approvals.js`: store append-only, token
  `{id, host, action_class, command_hash, scope_verdict, ttl, granted_by, note}`, coda pendenti in
  `operation-state.json` via CAS di `opstate.js`, `mint|list|consume|revoke|expire`.
- Integrazione **additiva e default-off**: `run.js` e `c2-guard.js` accettano `--approval <id>`;
  con policy `scope.json.host_ops.require_approval` attiva, un'azione confirm-tier senza token
  valido è rifiutata (fail-closed). Budget halt ⇒ card approvabile che esegue `budget.js reset --reason`.
- Pannello *Approvals* + badge tray + notifica; una riga in `ops/harness.md` (contratto lato agente).
- Test: token scaduto/riusato/hash sbagliato/host sbagliato; policy off ⇒ comportamento identico a oggi.

**AC:** un agente bloccato in TUI si sblocca dall'app; ogni decisione è una transizione opstate;
nessun percorso consente a un'azione confirm-tier di partire senza token quando la policy è on.

---

### WP5 — Mission control + dispatch

**Deliverable**
- `tools/cc-mission.js`: un payload con `next_actions` (`next-actions.js plan --json`),
  `coverage gaps` (`coverage-loop.js gaps --json`), `gates` (`gate.js`), `budget` (`budget.js check`),
  checkpoint autopilot, bloccati da scope, approvazioni pendenti — ognuno con *perché*, tier e costo.
- Route `GET /api/cc/mission`, `POST /api/cc/dispatch` (job runner esistente; confirm-tier ⇒ token).
- Pannello *Mission* con card azione → dispatch o richiesta di consenso; log SSE nel drawer.

**AC:** i numeri del pannello coincidono con l'output CLI (stessi moduli, test golden su fixture);
nessun dispatch parte fuori da `run.js`/`workflow.js`/`stavros.js`.

---

### WP6 — Ledger · Grafo · Coverage · Report studio

**Deliverable**
- `tools/cc-ledger.js`: unione di transizioni opstate, `gate-log.md`, `artifacts/audit/*.jsonl`,
  `artifact-ledger.jsonl`, stato della hash-chain (riuso di `gate.js`/`record-finding`), approvazioni;
  **evidence bundle** (tar/zip con manifest + hash) e export PDF (`printToPdf`).
- `tools/cc-graph.js`: proiezione da `reports/<host>-map.json` / `state.db` → nodi/archi (SVG,
  click-through ai findings). `tools/cc-coverage.js`: matrice classi + ATT&CK
  (`attack-coverage.js --json`).
- Pannelli *Ledger* (timeline con badge chain), *Graph*, *Coverage*, *Reports* (ciclo del finding,
  **retest diff**, `artifact-ledger evidence` con dialogo nativo, export).

**AC:** il verdetto della chain coincide con `gate.js`; il bundle si verifica con
`node tools/audit-trail.js verify` + `artifact-ledger.js verify`; grafo e coverage in sola lettura.

---

### WP7 — Controllo 360°

**Deliverable:** pannelli *Config* (scope/auth/wifi-scope/mobile-scope/c2.json con validazione live
attraverso gli stessi moduli), *Team* (`fleet.js plan|render` dry-run), *Arsenal*
(tool-registry + `tool-plane` mancanti + flusso `doctor.js --json`, install solo su conferma
tipizzata), *Knowledge* (`kb-search.js`, memoria RAG), *Radar* (run/status + proposte, **badge
egress**), *Doctor* (salute ambiente).

**AC:** ogni editor valida con il modulo esistente; nessun install senza conferma esplicita;
nessun pannello nuovo che scriva fuori dai wrapper.

---

### WP8 — IA a rail + polish

**Deliverable:** navigazione a rail (Engagement ▸ Campaign/Mission/Approvals/Ledger · Attack ▸
Findings/Pipeline/Sessions/Graph/Coverage · Control ▸ Config/Team/Arsenal/Knowledge · Console ▸
Freebuff/Reports), command palette con tutte le azioni, a11y (focus order, aria-live, AA),
`prefers-reduced-motion`, perf (`content-visibility`, nessun polling più aggressivo),
split di `app.js` in viste caricate progressivamente (sempre zero-build: handler statico esteso
per `.js/.css/.svg/.json` sotto `tools/gui/`).

**AC:** audit tastiera completo, nessun errore console, nessun asset esterno, `npm test` verde.

---

### WP9 — Distribuzione, doc, demo

**Deliverable:** `install-scc-launcher.sh` finale + uninstall, README + questo documento aggiornati,
`docs/f3-client-runbook.md` (l'app come client desktop di un backend tunnelato), unit systemd
user opzionale, **script demo 2 minuti**: lancio → wizard → mission → approvazione → dispatch →
finding → report → bundle.

**AC:** su macchina pulita: launcher → app funzionante; demo eseguita senza toccare la CLI.

---

## 4. Verifica (per ogni WP)

1. `npm test` (gate suite `tools/test-*.js`) verde; i nuovi test backend sono `offline` o
   `loopback` (`// test-tags: loopback`), mai `e2e`.
2. Smoke SPA headless: `chromium --headless --dump-dom "http://127.0.0.1:<port>/?token=<t>"`
   (oppure `node tools/dom-check.js --cdp-port <p>`) con assert su topbar/tab.
3. Check guardrail manuale: server su 127.0.0.1, Host/Origin invariati, nessun asset esterno nel
   tab Network, nessun endpoint che salti i guard.
4. `node tools/doctor.js --check` per l'ambiente; `node tools/cc-instance.js status` per l'istanza.

## 5. Fuori scope (v1)

Multi-utente/ruoli remoti (resta single-operator loopback; il telefono passa da tunnel),
`.deb`/AppImage, sostituzione del TUI, auth server-side oltre al token di sessione, copilot LLM
nel dock (roadmap), parità Windows per la shell (resta modalità browser).

## 6. Rischi

| Rischio | Mitigazione |
|---|---|
| PyQt6 assente su un'altra macchina | fallback Chromium app-mode → browser; Node resta l'unica dipendenza dura |
| QtWebEngine su Wayland | testato su XWayland/offscreen; `QT_QPA_PLATFORM` documentato |
| `app.js` monolitico che cresce | WP8: split progressivo senza build |
| Policy approvazioni che rompe il TUI | default-off + test di non-regressione sul comportamento attuale |
| Dati cliente in git | gitignore in WP1 + check in WP9 |

---

## 7. Prompts per sessione

Una sessione = un WP. Apri una sessione nuova e incolla la riga corrispondente: il prompt nomina
l'esito, non i passi, così l'agente resta libero sulla soluzione.

| WP | Prompt da incollare |
|----|---------------------|
| 0 | `Commit del WIP in corso (fase A/B + vendor move) così il tree è pulito: verifica npm test e non includere file non correlati.` |
| 1 | ✅ fatto — `tools/cc-instance.js`, token di sessione, attach, test offline+loopback |
| 2 | `Implementa WP2 del piano docs/command-center-desktop.md: la shell desktop PyQt6 stavros-cc che avvia e supervisiona il backend, con tray, notifiche e fallback Chromium.` |
| 3 | `Implementa WP3 del piano docs/command-center-desktop.md: modello campagna (manifest, template, storico) e pannello Campaign.` |
| 4 | `Implementa WP4 del piano docs/command-center-desktop.md: inbox approvazioni con token di consenso e integrazione additiva in run.js/c2-guard.js.` |
| 5 | `Implementa WP5 del piano docs/command-center-desktop.md: mission control che aggrega next-actions, coverage, gate e budget con dispatch.` |
| 6 | `Implementa WP6 del piano docs/command-center-desktop.md: ledger con evidence bundle, grafo del target, matrice di coverage e report studio con retest.` |
| 7 | `Implementa WP7 del piano docs/command-center-desktop.md: pannelli di controllo 360° (config, team, arsenal, knowledge, radar, doctor).` |
| 8 | `Implementa WP8 del piano docs/command-center-desktop.md: navigazione a rail, command palette completa, a11y/perf e split progressivo delle viste.` |
| 9 | `Implementa WP9 del piano docs/command-center-desktop.md: installer, documentazione e script demo di 2 minuti.` |

**Chiusura di ogni sessione:** `npm test` verde · check guardrail (loopback, nessun asset esterno,
nessun endpoint che salta i guard) · commit dei **soli** file del WP · `docs/command-center-desktop.md`
aggiornato (WP → ✅).

### Fatto in WP1 (riferimento)

File nuovi: `tools/cc-instance.js`, `tools/test-cc-instance.js`, `tools/test-cc-server.js`.
File modificati: `tools/gui-server.js` (token, `--instance`, `--print-port`, `/api/instance`, lock),
`tools/gui/app.js` (token in `api()`/EventSource + banner read-only), `tools/gui/app.css`,
`start-command-center.sh` (token + attach), `.gitignore` (dati cliente).

---

### Stato (sessione 2026-09-26) — WP2..WP9

Implementati sopra WP1. `npm test` = **88 PASS / 0 FAIL** (5 test nuovi: campaign, approvals,
mission, routes, panic). Ogni modulo riusa i tool esistenti; nessun guard è stato aggirato.

| WP | Stato | Note |
|----|-------|------|
| 2 Shell desktop | ✅ (🚧 notifiche) | `tools/app/scc.py` (tray con colore, supervisore spawn→health→restart con circuit breaker, single instance `QLocalServer`, QSettings geometria, `--read-only/--headless/--web/--kiosk/--keep-server`, fallback Chromium→browser), `tools/app/icons/stavros-cc.svg`, `stavros-cc`, `install-scc-launcher.sh`, `stavros-cc.desktop`,  `tools/app/pdf-export.py`, `tools/cc-panic.js`, `tools/app/test_scc.py` (8 test offscreen,
  incluso il raise fra due processi). 🚧 **mancano**: notifiche desktop con discreet mode/mute (tray + colore di stato ci sono). |
| 3 Campagna | ✅ | `tools/cc-campaign.js`, `templates/campaign/{web-app,internal-network,wireless,mobile,red-team-full}.json`, route `/api/cc/campaign*`, pannello Campaign + wizard. Rollup ore da gate-log + run-audit. |
| 4 Approvazioni | ✅ | `tools/cc-approvals.js` + `tools/request-approval.js`, store append-only, token `{id,host,action_class,command_hash,scope_verdict,ttl,granted_by,note}`, coda in opstate via CAS. Integrazione **additiva e default-off** in `run.js`/`c2-guard.js` (`--approval`, policy `host_ops.require_approval`). Pannello + badge. |
| 5 Mission control | ✅ | `tools/cc-mission.js` (next-actions + coverage-loop + gate + budget + checkpoint + approvazioni), `GET /api/cc/mission`, `POST /api/cc/dispatch` (allowlist tool, confirm-tier ⇒ token). Pannello Mission. |
| 6 Ledger/grafo/coverage | ✅ (🚧 report studio) | `tools/cc-ledger.js` (unione + chain == `gate.js` + evidence bundle tar.gz + manifest + `export-pdf`), `tools/cc-graph.js`, `tools/cc-coverage.js`, pannelli Ledger/Graph/Coverage. 🚧 **manca**: retest diff e ciclo finding avanzato dentro Reports. |
| 7 Controllo 360° | ✅ (🚧 install) | route+pannello Control: Config (redatto, validazione scope via `scope-guard`), Team (`fleet.js plan`), Arsenal (`tool-plane` + `doctor --json`), Knowledge (`kb-search.js`), Radar (badge egress dichiarato), Doctor. 🚧 **manca**: install tool su conferma tipizzata. |
| 8 IA + polish | ✅ (🚧 a11y) | rail a gruppi (Engagement/Attack/Control/Console), command palette estesa, split viste `views-engagement.js`/`views-control.js` (zero-build, handler statico con allowlist `.js/.css/.svg/.json`, basename-only), `prefers-reduced-motion`. 🚧 **manca**: audit tastiera completo e aria-live di dettaglio. |
| 9 Distribuzione | ✅ | `install-scc-launcher.sh` (+`--uninstall`), `scripts/demo-command-center.sh` (2 min, CC_ROOT temporaneo), README + questo doc + `docs/f3-client-runbook.md` (§9 client desktop tunnelato). |

**File nuovi WP2..WP9:** `tools/cc-util.js`, `tools/cc-campaign.js`, `tools/cc-approvals.js`,
`tools/request-approval.js`, `tools/cc-mission.js`, `tools/cc-ledger.js`, `tools/cc-graph.js`,
`tools/cc-coverage.js`, `tools/cc-router.js`, `tools/cc-panic.js`, `tools/app/*`,
`templates/campaign/*.json`, `tools/gui/views-engagement.js`, `tools/gui/views-control.js`,
`stavros-cc`, `install-scc-launcher.sh`, `scripts/demo-command-center.sh`,
test: `tools/test-cc-{campaign,approvals,mission,routes,panic}.js`.
**File modificati:** `tools/gui-server.js` (router additivo + static allowlist + `--read-only`),
`tools/run.js` (`--approval`), `tools/c2-guard.js` (policy token), `tools/gui/index.html`,
`tools/gui/app.js` (renderTab + palette), `tools/gui/app.css` (rail/panel), `docs/f3-client-runbook.md`.

**Prossimo passo concreto** per chi riprende: implementare le notifiche desktop + discreet mode in
`scc.py` (WP2), il retest diff in Reports (WP6), l'install con conferma tipizzata (WP7) e l'audit
tastiera (WP8).
