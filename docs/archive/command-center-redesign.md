# Piano d'implementazione — Nuovo Stavros Command Center

Redesign della dashboard web locale (`tools/gui/` servita da `tools/gui-server.js`).
Obiettivo: portare la console a livello dei migliori operator-console/recon-dashboard
della community (Havoc, Mythic, reNgine, Trickest, BloodHound) **senza perdere**
l'identità HUD neon-duotone già presente e **senza introdurre dipendenze**.

## 0. Vincoli non negoziabili (guardrail)

Questi valgono per **ogni** fase. Una PR che li viola va rifiutata.

1. **Zero dipendenze / zero build.** Niente React/Vue/Tailwind/bundler. Solo
   HTML + CSS + JS vanilla, come oggi. Unico vendored ammesso: `vendor/xterm.css`
   (già presente). Nessun asset caricato da CDN (tool offline/loopback).
2. **Sicurezza invariata.** Il server resta bound su loopback, Host/Origin check,
   body cap, e **non bypassa mai i guard**: nessun nuovo endpoint di scrittura che
   salti `scope-guard`/`stavros.js`/`report-html.js`. Le write restano wrapper sui
   tool esistenti.
3. **Identità visiva.** Palette neon-duotone (cyan = interattivo, magenta =
   brand/live, severity ramp come unica saturazione piena) mantenuta. Il redesign
   cambia **densità e IA**, non ridipinge il tema.
4. **Accessibilità = non regredisce.** Restano ruoli ARIA, `tablist`/`tabpanel`,
   focus visibile, navigazione da tastiera. Contrasto AA sul testo dati.
5. **Nessuna nuova richiesta di rete verso l'esterno.** Font di sistema/monospace
   locali (già `JetBrains Mono` con fallback stack).

## 1. Stato attuale (baseline)

- **Backend** `tools/gui-server.js` (~810 righe, node http zero-dep, PTY, SQLite RO).
  API già disponibile:
  `GET /api/health|overview|findings|scope|scope/check|pipeline|sessions|loot/count|reports|jobs`,
  `GET /api/term/status|stream`, `POST /api/scope|pipeline/resume|reports/generate|term/{start,stop,input,resize}`.
- **Frontend** `tools/gui/`: `index.html` (68 righe, topbar + 7 tab), `app.js`
  (~997 righe, una `render<Tab>()` per sezione), `app.css` (~518 righe, HUD).
  Tab: **Overview · Findings · Pipeline · Scope · Sessions · Reports · Freebuff**.
- Payload già ricchi: `overview` ha `findings.bySeverity/byStatus`, `scope` counts,
  `pipeline.phases`, `sessions.active/artifactsTotal`; `pipeline` ha `phases`
  (ordinate, con status), `runs`, `targets`; `sessions` ha `rows`.

**Conseguenza:** ~80% del lavoro è frontend. Le aggiunte backend sono poche e isolate
(trend findings, edge/tempistiche fasi) — elencate per fase.

## 2. Architettura frontend target

Introdurre un piccolo **component layer** vanilla, senza framework:

- `tools/gui/app.css` → riorganizzato in 3 strati con `@layer`:
  `tokens` (variabili già esistenti, consolidate) → `primitives`
  (`.stat-tile`, `.data-table`, `.chip`, `.panel`, `.node`, `.rail`) → `views`
  (regole specifiche per tab). Evolvere, non riscrivere: i token neon restano.
- `tools/gui/app.js` → estrarre helper riusabili in cima al file (nessun nuovo
  file, resta single-page servita così com'è):
  `el(tag, props, children)` (mini hyperscript ~15 righe), `statTile()`,
  `dataTable({columns, rows, onRow})`, `severityChip(sev)`, `sparkline(points)`
  (SVG inline), `drawer(node)` (pannello dettaglio laterale).
- I `.bak`/`.v1-forensic` esistenti restano come storico; nessun nuovo file sparso.

Ogni `render<Tab>()` viene riscritta per **comporre** i primitives invece di
concatenare stringhe HTML ad hoc.

## 3. Fasi

Ogni fase è una PR autonoma, mergeabile, con la dashboard sempre funzionante.
"AC" = acceptance criteria (verificabili a mano su `./start-command-center.sh`).

### Fase 1 — Foundation: token, primitives, shell (frontend)
Prepara il terreno, zero cambi di funzionalità.
- Consolidare le variabili in un blocco `@layer tokens` unico; aggiungere token
  mancanti (spaziature, raggi, ombre non-glow per le card, stati hover/active).
- Implementare gli helper JS (`el`, `statTile`, `dataTable`, `chip`, `drawer`,
  `sparkline`) con test manuale su una pagina scratch.
- **Status rail** persistente sotto la topbar (scope/rps/gate/sessions già nei
  badge → promuoverli a rail sempre visibile con stato colore).
- **Command palette** (`Ctrl/⌘-K`): salto tab + azioni rapide (refresh, resume
  pipeline, genera report). Solo client-side, nessun endpoint nuovo.
- **AC:** nessuna regressione visiva sui tab esistenti; palette apre/naviga da
  tastiera; rail riflette `/api/overview`.
- Backend: **nessuna modifica.**

### Fase 2 — Overview in stile stat-tile + trend (rif. reNgine)
- Riga di **stat-tile** in cima: findings per severità (critical/high/medium/low),
  coverage/rps, sessioni attive, loot count. Ognuna cliccabile → porta al tab
  filtrato.
- **Sparkline** "findings nel tempo" (SVG inline) dai timestamp di
  `reports/findings.jsonl`.
- Card "ultimo run pipeline" + "report recenti" (già in payload).
- **AC:** i numeri combaciano con `/api/overview`; click su tile-severity apre
  Findings pre-filtrato per quella severità.
- Backend: aggiungere `findings.trend` (array `{day, count}`) a `overviewPayload()`
  aggregando i timestamp di `findings.jsonl` (read-only, nessun guard toccato).

### Fase 3 — Findings: tabella densa filtrabile + drawer (rif. Nuclei/BloodHound)
- Riscrivere `renderFindings` con `dataTable`: colonne severità (chip colorata),
  titolo, host/endpoint, CWE, status; **sticky header**, ordinamento per colonna,
  ricerca già presente mantenuta.
- **Drawer** laterale al click su riga: dettaglio finding (descrizione, evidence,
  request/response se presenti) senza cambiare pagina.
- Filtri rapidi: chip severità + status (toggle), riflessi in querystring
  `/api/findings`.
- **AC:** paginazione e ricerca esistenti continuano a funzionare; drawer apre/chiude
  con `Esc`; nessuna evidence/loot con segreti stampata oltre a quanto già esposto.
- Backend: `findingsPayload` invariato salvo eventuale campo evidence già presente.

### Fase 4 — Pipeline come grafo di fasi (rif. Trickest)
- Visualizzare le `phases` (recon → scan → enumerate → …) come **DAG orizzontale**
  di nodi (SVG/flexbox), con stato per nodo (done/running/failed/pending) usando la
  severity/status color system. Badge "resumable"/"unclosed" già calcolati dal backend.
- Timeline sotto: `runs` recenti; pannello `targets` con hosts/ports/endpoints.
- Pulsante **Resume** invariato (`POST /api/pipeline/resume`, wrapper su tool).
- **AC:** i nodi riflettono `pipeline.phases`; Resume compare solo se
  `resumePossible`; nessun bypass guard.
- Backend: opzionale — aggiungere `started_at/ended_at` per nodo se già in `phases`
  (solo SELECT extra, RO). Se non c'è, la durata si omette.

### Fase 5 — Sessions: tabella agenti + console agganciata (rif. Havoc/Mythic)
- `renderSessions` → `dataTable` agenti (id, status, host, obtained_via, #artifacts).
- Selezione riga → pannello dettaglio con lista artifacts e, dove ha senso, la
  **console** xterm già esistente agganciata alla sessione (riuso `renderTermTab`).
- **AC:** conteggio active combacia con `/api/sessions`; artifacts non espongono
  segreti oltre al comportamento attuale (loot resta solo-conteggio).
- Backend: **nessuna modifica** (payload già completo).

### Fase 6 — Rifinitura trasversale
- **Scope** e **Reports**: riallineare al nuovo component layer (form scope con
  validazione live via `/api/scope/check`, lista report con preview).
- **Motion & stati**: transizioni sobrie (rispetta `prefers-reduced-motion`),
  empty-state coerenti, skeleton di caricamento.
- **Responsive**: la dashboard regge da ~1024px in giù (tabelle in
  `overflow-x:auto`, niente scroll orizzontale del body).
- **Perf**: `content-visibility:auto` sui pannelli fuori vista; nessun polling più
  aggressivo di oggi.
- **A11y pass**: focus order, aria-live sui toast, contrasto AA verificato.
- **AC:** audit manuale tastiera-only completo; nessun errore console; loopback +
  Host/Origin check intatti.

## 4. Ordine consigliato e dipendenze

```
Fase 1 (foundation)  ─┬─> Fase 2 (overview)
                      ├─> Fase 3 (findings)
                      ├─> Fase 4 (pipeline)
                      └─> Fase 5 (sessions)
                                   └─> Fase 6 (polish, chiude tutto)
```

La Fase 1 sblocca le altre (primitives condivisi). Le fasi 2–5 sono indipendenti tra
loro e parallelizzabili. La Fase 6 va per ultima.

## 5. Verifica (per ogni fase)

1. `./start-command-center.sh --no-open --port 8799` → apri, controlla il tab toccato.
2. `npm test` (gate suite) verde — il redesign non deve rompere i test `tools/test-*.js`.
3. Check manuale guardrail: server ancora su `127.0.0.1`, nessun asset esterno in
   Network tab, nessun endpoint di scrittura nuovo che salti i guard.
4. Diff CSS: i token neon non cambiano valore senza motivo.

## 6. Fuori scope (esplicito)

- Nessun multi-utente/auth server-side (resta single-operator loopback).
- Nessun DB nuovo: si legge solo ciò che i tool già scrivono in `reports/`.
- Nessuna riscrittura del backend PTY/term (si riusa).
- Nessun framework, nessun passaggio di build.

## 7. Stima grossolana

| Fase | Peso | Backend |
|------|------|---------|
| 1 Foundation | M | — |
| 2 Overview   | S | trend findings (piccolo) |
| 3 Findings   | M | — |
| 4 Pipeline   | M | opz. tempistiche fasi |
| 5 Sessions   | S | — |
| 6 Polish     | M | — |

Backend totale: 2 aggiunte read-only piccole e isolate. Tutto il resto è
`tools/gui/{app.js,app.css,index.html}`.
