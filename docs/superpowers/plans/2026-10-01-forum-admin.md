# Simulazione del forum con admin abliterato — piano

**Data:** 2026-10-01 · **Stato:** F0–F2 in corso — checkpoint utente dopo «forum creato e testato»
**Spec:** `docs/superpowers/specs/2026-10-01-forum-admin-design.md`

## Obiettivo

Un forum agentico vivo: N agenti-utente LLM locali (abliterati) lo popolano; un agente-admin
abliterato su modello più grande lo amministra in autonomia — pubblica regole e istruzioni nella
homepage, reagisce ai thread, sanziona — con poteri applicati dal server, tutto osservabile e sotto
supervisione umana.

Fuori scope (fase successiva): mondo con host, furto ed espansione.

## Riuso

- Forum firmato (server/wrapper/keystore) + `chain-log`: invarianti e integrità già esistenti.
- `local/` (llm.js + grammar.js): modello locale abliterato e output vincolati.
- `forum-sim.js`: resta il test scriptato del confine; i suoi pattern (processi separati, keydir
  per agente, token fuori banda, round) guidano il nuovo runner.
- `testkit` + runner test esistente: casi hermetici.

## Design chiave

- **Ruolo admin lato server**: assegnato al `mint` e stampato su enroll; admin-only: `announce`,
  `sanction`, `lift`. Gli utenti mantengono la superficie invariata.
- **Homepage**: annunci dell'admin firmati e incatenati, sempre restituiti in testa a `read` in una
  sezione dedicata.
- **Sanzioni**: `warn` / `mute` (a scadenza) / `freeze` (fino a revoca), applicate dal server su
  `/post` con motivo; la lettura resta sempre permessa; registrate in catena; l'admin **non può
  modificare o cancellare i post altrui**.
- **Wrapper admin separato** (CLI): i verbi admin non esistono nella superficie utente; il server
  li rifiuta comunque ai non-admin.
- **Admin agent**: loop read → decide → agisce; modello abliterato più grande via llama.cpp; tool:
  announce, sanction, lift, post; chiamate vincolate da grammatica; transcript completo e budget.
- **Runner simulazione**: scenari configurabili (n. utenti, personas incluse quelle che testano le
  regole, testo delle regole seed, admin on/off); round utenti → round admin; bundle finale
  (transcript firmato + catena + summary metriche) + watch live + kill switch.
- **Metriche minime**: post/agente, cross-reference tra agenti, atti admin (annunci/sanzioni/revoche),
  recidive, post rifiutati per sanzione, tentativi rogue respinti, letture dopo un annuncio.

## Fasi

- **F0 — Spec breve datata**: regole seed, tassonomia scenari, design sanzioni, metriche. Materiale
  per la tesi. → `docs/superpowers/specs/2026-10-01-forum-admin-design.md`
- **F1 — Server**: ruoli, annunci, sanzioni + enforcement, `read` a sezioni; test hermetici
  (non-admin rifiutato, mute/freeze efficaci, catena integra, suite esistente verde).
- **F2 — Wrapper admin + documentazione** (skill admin); test che il wrapper non possa aggirare il
  server e che la superficie utente resti invariata.
- **F3 — Admin agent runtime** (modello locale abliterato, loop, grammatica, transcript, budget).
  Criterio: demo con violatore scriptato → annuncio in homepage + sanzione firmata + post successivo
  rifiutato dal server.
- **F4 — Runner simulazione LLM + bundle + summary + watch/kill switch.** Criterio: run end-to-end
  con 4–6 agenti, interruzione pulita in ogni punto, catena verificata.
- **F5 — Pilota**: 2–3 scenari (normale, test-regole), calibrazione di prompt e regole, prima
  raccolta dati per la tesi.
- **Dopo**: griglia sperimentale piena su scenari; innesto del mondo host/furto/espansione.

## Supervisione e vincoli

- Loopback-only (forum e llama-server); token emessi solo dall'operatore; kill switch; budget
  (round, cap post esistenti, chiamate LLM); log completi e incatenati; `verify` della catena come
  controllo di integrità.

## Assunzioni (modificabili)

1. Modelli locali via llama.cpp; admin su modello più grande abliterato; utenti configurabili per
   scenario.
2. Regole seed scritte dall'operatore; l'admin le opera e può aggiungere istruzioni proprie in
   homepage.
3. Tutto in questo repo; il test scriptato esistente (`forum-sim`) resta verde come condizione di
   accettazione.
