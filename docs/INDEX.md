# Indice della documentazione

> **Generato** da `node tools/docs-index.js` leggendo i file reali (titolo, primo paragrafo,
> dimensione, avanzamento delle checkbox dei piani). Non si modifica a mano: rigeneralo.
> `tools/test-repo-invariants.js` fallisce se è rimasto indietro rispetto ai file.

**Superficie viva:** 27 documenti · **piani:** 3 · **archivio:** 3 file superati.

## Root del repo

- [**AGENTS.md — StavrosRedTeamer**](AGENTS.md) — Operatore AI per operazioni di pentest autorizzate (web/host, wireless, mobile). · 5,0 KB
- [**Benchmark**](BENCHMARK.md) — Public security benchmarks are in the model's training data. "Solved" on OWASP Juice · 7,0 KB
- [**Changelog**](CHANGELOG.md) — All notable changes to this project are documented here. Dates are commit dates. · 18,1 KB
- [**StavrosRedTeamer**](README.md) — A penetration-testing harness where a finding is only a finding if code can prove it — · 10,8 KB
- [**Security Policy**](SECURITY.md) — StavrosRedTeamer is offensive-security tooling. It executes reconnaissance and · 4,1 KB
- [**Stavros — Web Red Team Methodology & Rules of Engagement**](knowledge.md) — Shared brain for every Stavros agent — read before acting. Detail lives in docs/ (map at bottom); · 12,3 KB
- [**Piano di ottimizzazione workspace Stavros (Red Teamer harness)**](piano-ottimizzazione-stavros.md) — Data: 10 settembre 2026 · Repo: stavrosredteamer (Freebuff) · Branch: `command-center-redesign` · 11,4 KB
- [**Handoff — sessione con AUTOPILOT attivo (opt-in)**](session-prompt-autostavros.md) — Sei Stavros, orchestratore red-team. In questa sessione l'operatore richiede ESPLICITAMENTE la · 2,0 KB

## `docs/` — riferimento

- [**Architecture**](docs/ARCHITECTURE.md) — The whole design follows from one decision: the model decides what to try; the · 8,8 KB
- [**Glossary**](docs/GLOSSARY.md) — The harness uses a small set of terms with exact meanings. They are load-bearing: · 3,3 KB
- [**Launch plan**](docs/LAUNCH-PLAN.md) — Most AI pentest agents are built to *find* things. The bottleneck in this field · 13,8 KB
- [**Measuring whether an AI pentest agent's findings are real**](docs/METHODOLOGY.md) — An agent that reports everything it can think of scores 100% recall and is · 7,3 KB
- [**Recording the demo**](docs/RECORDING.md) — $ DEMO_FAST=1 DEMO_PACE=3 ./tools/demo.sh · 5,0 KB
- [**`refs/` — provenance, licensing, and why it is not in this repository**](docs/REFS-PROVENANCE.md) — The corpus is not wholly first-party. Its own `refs/README.md` states that · 5,0 KB
- [**Threat model: attacking StavrosRedTeamer itself**](docs/THREAT-MODEL.md) — Not the target. The target is supposed to be attacked — that is the job. What is · 7,3 KB
- [**What the published benchmarks measure, and what they leave out**](docs/TOOL-LANDSCAPE.md) — As of mid-2026 there is real, serious work here, and none of it is · 6,3 KB
- [**Stavros Command Center — Desktop Edition (piano e work package)**](docs/command-center-desktop.md) — Obiettivo. Portare il Command Center da dashboard web a programma desktop (`stavros-cc`) · 22,2 KB
- [**Egress gateway & anonymized egress (red-team OPSEC)**](docs/egress-opsec.md) — To force third-party HTTP(S) binaries through the scope allowlist, start the proxy first: · 2,4 KB
- [**docs/f3-client-runbook.md — Poco F3 come client dell'harness stavros**](docs/f3-client-runbook.md) — ┌─────────────────────── Poco F3 (client) ───────────────────────┐ · 8,4 KB
- [**docs/f3-rom-alioth.md — Poco F3 (alioth): ROM dedicata per il client harness**](docs/f3-rom-alioth.md) — (`docs/egress-opsec.md`). Le uniche app extra: Termux (F-Droid) e nulla altro. · 7,6 KB
- [**Host exploitation (post-web: C2 / post-ex / lateral) + threat intel**](docs/host-exploitation.md) — Confirm-tier is refused unless `--confirm "<reason>"` is passed, which needs your explicit in-session · 9,1 KB
- [**Testing by class — dettaglio metodologico**](docs/methodology-classes.md) — Class names for `record-finding.js` are the canonical keys of `tools/test-registry.json` — · 4,8 KB
- [**Mobile (Android) — methodology & tool detail**](docs/mobile.md) — (`127.0.0.1`, `localhost`) o un serial USB esplicitamente in allowlist (device fisico autorizzato). · 4,9 KB
- [**System Prompt Dump — StavrosRedTeamer**](docs/system-prompt-dump.md) — Nessun dato di target, credenziale o output di engagement lascia la macchina. Vedi `docs/egress-opsec.md`. · 4,8 KB
- [**Toolbox — dettaglio per-tool (knowledge.md tiene la tabella compatta)**](docs/toolbox.md) — (it refuses out-of-scope hosts; supports `-l -`/`--stdin` AND a piped stdin for target lists; every · 16,8 KB
- [**Wireless (modalità separata)**](docs/wireless.md) — WiFi is a SEPARATE mode from the web/network pipeline: targets are BSSIDs/ESSIDs/stations/channels, · 6,1 KB

## `ops/` — regole della harness

- [**ops/harness.md — regole condivise della harness (disciplina, tool-wiring, MCP)**](ops/harness.md) — Pentest discipline (full rules: `knowledge.md` — "Verification levels", "False-positive duty", "WAF awareness", "Install valve", "Adversarial content  · 17,3 KB

## Piani

- [**Stavros Radar Implementation Plan**](docs/superpowers/plans/2026-09-08-stavros-radar.md) — Goal: Create an autonomous intelligence and capability-scouting tool for StavrosRedTeamer that analyzes the local codebase, discovers relevant open-so · 26,0 KB · 0/26 check
- [**Offensive Batch 2 — Implementation Plan (6 workstream)**](docs/superpowers/plans/2026-09-26-offensive-batch2-plan.md) — Goal: Sei capacità offensive indipendenti per l'harness: matrice permessi multi-identità (Gate P1), ingest OpenAPI/Swagger, wordlist adattive dal targ · 25,5 KB · 0/34 check
- [**Stavros Radar — Design Specification**](docs/superpowers/specs/2026-09-08-stavros-radar-design.md) — Status: Approved · 7,6 KB

## Archivio — piani superati

Stanno in `docs/archive/`, fuori dalla superficie viva, con il motivo in
[`docs/archive/README.md`](archive/README.md). Il criterio non è una checkbox spuntata
(nessuno le spunta) ma una prova di atterraggio: la voce di CHANGELOG o l'artefatto che esiste.

- [**Brief di missione — completare la Stavros Command Center Desktop Edition**](docs/archive/command-center-desktop-brief.md) — MISSIONE: completa la "Stavros Command Center — Desktop Edition" in questo repository · 12,3 KB — 2026-09-28 — brief per completare WP2–WP9: atterrati (CHANGELOG 2026-09-26)
- [**command-center-pro-draft.html**](docs/archive/command-center-pro-draft.html) — <!DOCTYPE html> · 79,7 KB — 2026-09-28 — bozza di design mai collegata al backend («DESIGN DRAFT — not wired to the backend»), superata dalla console atterrata (WP2–WP9)
- [**Piano d'implementazione — Nuovo Stavros Command Center**](docs/archive/command-center-redesign.md) — Redesign della dashboard web locale (`tools/gui/` servita da `tools/gui-server.js`). · 9,3 KB — 2026-09-28 — redesign della dashboard: le fasi 1–6 sono atterrate (CHANGELOG 2026-09-08)
