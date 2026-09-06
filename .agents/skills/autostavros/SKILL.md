---
name: autostavros
description: Attiva la modalità AUTOPILOT per il pentest in corso — pianificazione ed esecuzione deterministica delle prossime azioni dal target-model, anti-loop (loop-watch + dry-streak), stop garantiti (DONE/BARRIER/BUDGET/STUCK), approvazione umana per le azioni intrusive. Opt-in esplicito: va invocata SOLO su richiesta dell'operatore, mai di default.
metadata:
  category: pentest
---

# Autopilot Stavros — protocollo operativo

> Modalità OPT-IN: si attiva solo quando l'operatore la chiede (questo comando). NON è la modalità di
> default: il flusso normale resta persona-driven con approvazione umana per azione.

## Ruoli

- **Autopilot (`tools/autopilot.js`, driver deterministico)**: pianifica dal target-model ad ogni tick,
  compone UN verdetto (circuit-breaker: loop-watch + continuation + coverage + budget), esegue solo
  azioni auto-tier, mette in coda le intrusive per approvazione umana, checkpoint a ogni tick.
- **Tu (persona)**: esegui il loop (`plan` → `tick` → `approve` → `tick` …), interpreti i risultati,
  fai il lavoro creativo che il planner non copre (XSS manuale, authz, OOB, exploit-dev, MCP browser),
  e riporti all'operatore. MAI inventare un passo: il controllo di flusso è 100% nell'autopilot.

## Preflight (fail-closed, blocca subito se manca)

1. `scope.json` presente e **caricabile** (vuoto = nulla eseguito; non caricabile = STUCK).
2. Stato seedato: almeno un target nel target-model (`reports/state.db`). Se `targetsCount == 0`
   l'autopilot risponde STUCK "fai il seed prima" — seeda con `node tools/stavros.js scan <host>`
   o un workflow (`node tools/workflow.js run workflows/recon-baseline.yaml -t <host>`) SE l'operatore
   lo autorizza, poi riparti.

## Il loop istruito

1. `node tools/autopilot.js plan --json` — dry-run: verdetto + azioni ordinate + coda intrusive.
   Mostra all'operatore il riassunto (verdetto, remaining, executable, intrusive) e le ragioni.
2. `node tools/autopilot.js tick --yes --json` — esegue il set auto-tier (in-scope, non coperto,
   non intrusivo) attraverso `run.js`/`workflow.js` (stessi guard: scope, enforce, pacing, budget).
   Dopo il tick riporta: `verdict`, `ran` (cosa ha eseguito e con quale exit), `remaining`,
   `pending_intrusive`.
3. Se il tick emette `approval_needed` (o `pending_intrusive > 0`): mostra all'operatore la coda
   con i comandi salvati (campo `.cmd`). L'operatore decide con
   `node tools/autopilot.js approve --batch <id> --yes` (o `all`); poi esegui TU i comandi
   approvati da `reports/autopilot/approved-intrusive.jsonl` — l'autopilot NON lancia mai gli
   intrusivi, e `--include-intrusive` NON esiste su run.js.
4. Ripeti tick finché verdetto terminale, poi riporta e chiedi come procedere.

## Verdetti di stop (interpretali così)

- `DONE` (exit 0) — coverage completa: nessun gap rimasto. Proponi il report (gate P3 invariato).
- `BARRIER` (exit 3) — nessuna riduzione dei gap per K≥2 tick. RIPRENDIBILE: riporta il plateau,
  chiedi all'operatore se cambiare approccio (lavoro creativo extra-planner) e poi `resume`.
- `BUDGET` (exit 4) — ceiling di budget raggiunto. Ferma, riporta la spesa.
- `STUCK` (exit 5) — scope rotto / stato vuoto / tutto fallito / loop senza alternative. Riporta le
  ragioni; solo dopo intervento dell'operatore si riparte con `node tools/autopilot.js resume`.
- `SKIP` — loop-watch ha individuato una firma ripetuta: NON rieseguirla; il tick la salta da solo.

## Regole che restano invariate (non derogabili dall'autopilot)

- Tutto ciò che tocca un target passa da `run.js`/`workflow.js`/`repeater.js` (scope-guard incluso)
  o da MCP previo `node tools/scope-guard.js check <url|host>` exit 0.
- Destructive/high-impact: conferma esplicita in-session dell'operatore per QUELLA azione.
- Verification levels, false-positive duty, minimal-impact proof, install valve: invariati
  (ops/harness.md).
- Se un comando dell'autopilot fallisce (exit≠0), NON ripeterlo identico: registra, prosegui col
  tick successivo o chiedi. L'audit `reports/tmp/run-audit.jsonl` alimenta loop-watch da solo.
- `AUTOPILOT_ACTION_TIMEOUT` (ms, default 600000) limita ogni singola azione del tick.

## Output macchina

Tutti i comandi accettano `--json` (`plan/tick/status/resume/approve`) per parsing deterministico.
Checkpoint: `reports/autopilot/checkpoint.json` (non committare `reports/`).