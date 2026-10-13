# evo-x2-lab — Lab AI locale per red teaming su 2× GMKtec EVO-X2

Setup per una startup di penetration testing/red teaming: due GMKtec EVO-X2
(Ryzen AI Max+ 395, 128 GB LPDDR5X-8000, Radeon 8060S gfx1151) che ospitano
in locale un brain strategico e un pool di modelli specializzati, collegati
tramite routing API.

## Architettura

```
[Operatore/Client]
      │
      ▼
[Gateway OpenAI-compatible — nginx (njs), porta 8080]
      │ smista per campo "model"
      ├── PC1 (10.0.0.1) "Brain": Qwen3.8-Flash-Next-Heretic (~85 GB, 262K ctx)
      │     ruoli: PLANNER · JUDGE · ARBITRO · AUTO-PROMPTER
      └── PC2 (10.0.0.2) "Worker Pool":
            ├── coder exploit   Qwen3-Coder-Next (MoE 80B/3B attivi) — GENERATOR
            ├── tool caller     gpt-oss-20B (3.6B attivi)           — EXECUTOR
            ├── parser output   Qwen3.5-9B                          — PARSING
            ├── specialista cyber Deep Hat V2 30B (vs Qwen-3.5-27B) — CRITIC
            ├── triage difens.  CyberSecQwen-4B (opzionale)
            └── RAG             BGE-M3 + Qwen3-Reranker
[Agent layer] CAI + MCP (nmap, nuclei, burp, metasploit) in Docker/Kali sandbox
```

Principi chiave (dai benchmark 2026 e dai progetti operativi):
- **Routing API, non tensori**: nessuno split di modelli via RPC su 2.5GbE
  (~6 tok/s misurati = inutilizzabile per agent loop).
- **MoE con pochi parametri attivi > dense**: l'APU è bandwidth-bound
  (~256 GB/s); un dense 27B è risultato 4× più lento di un MoE su questo hardware.
- **Dialogo strutturato, non libero**: planner→executor, generator→critic,
  best-of-k con judge; handoff in JSON e gate di escalation
  (vedi [docs/collaboration-protocol.md](docs/collaboration-protocol.md)).
- **Solo PoC validati** eseguendo (pattern Strix): i finding senza prova
  eseguibile sono rumore.
- **Il vero modello cyber è il fine-tune proprietario** (Fase 5): le tracce
  delle engagement sono il fosso competitivo; i modelli community sono bootstrap.

## Contenuto

| Path | Cosa è |
|---|---|
| [docs/setup-evo-x2.md](docs/setup-evo-x2.md) | Playbook: BIOS, Ubuntu, kernel, ROCm 7.2 nativo, build+validazione llama.cpp, systemd, rete |
| [docs/collaboration-protocol.md](docs/collaboration-protocol.md) | Protocollo di collaborazione multi-modello: schema JSON di handoff, gate di escalation, prompt di ruolo |
| [docs/evaluation-plan.md](docs/evaluation-plan.md) | Bake-off modelli (generalisti vs cyber) e A/B ensemble (solo vs critic+judge), metriche e criteri di accettazione |
| [deploy/models.yaml](deploy/models.yaml) | Matrice modelli: ruolo, quant, memoria, porta, parametri di lancio, alternative del bake-off |
| [deploy/nginx-gateway.conf](deploy/nginx-gateway.conf) + [deploy/nginx/router.js](deploy/nginx/router.js) | Gateway OpenAI-compatible con routing per campo `model` |
| [deploy/docker-compose.yml](deploy/docker-compose.yml) | Stack worker PC2, gateway e sandbox tool |
| [scripts/validate-llamacpp-build.sh](scripts/validate-llamacpp-build.sh) | Validazione build di llama.cpp (le build possono corrompere l'output silenziosamente su questo hardware) |
| [scripts/benchmark.sh](scripts/benchmark.sh) | Benchmark per-modello: prompt processing, generazione, concorrenza |

## Ordine d'uso

1. **Fase 0** — Setup hardware/OS su entrambe le macchine: [docs/setup-evo-x2.md](docs/setup-evo-x2.md).
2. **Fase 1** — PC1: scaricare Qwen3.8-Flash-Next-Heretic (quant dinamico Unsloth/Atomic, hash pinnati), avviare `llama-server`, validare la build, benchmarkare.
3. **Fase 2** — PC2: worker pool da [deploy/models.yaml](deploy/models.yaml) + gateway.
4. **Fase 3** — Agent layer: CAI + server MCP in Docker/Kali sandbox, audit trail attivo.
5. **Fase 4** — Bake-off e A/B: [docs/evaluation-plan.md](docs/evaluation-plan.md). Le decisioni di produzione si prendono solo qui, sui dati tuoi.
6. **Fase 5** — Fine-tune LoRA (Qwen-3.5-27B e 9B) sulle tracce raccolte: il modello cyber definitivo.

## Promemoria operativi

- Flag obbligatori su Strix Halo: `--no-mmap -ngl 99 -fa 1`.
- Kernel ≥ 6.16.9; con kernel 6.17+ usare ROCm 7.2 **nativo** (non container).
- Validare ogni build di llama.cpp prima di promuoverla ([scripts/validate-llamacpp-build.sh](scripts/validate-llamacpp-build.sh)).
- Pinnare gli hash dei quant; solo builder fidati (Unsloth, Atomic, Qwen ufficiali, Kindo).
- Per clienti istituzionali: audit trail di ogni comando, air-gap opzionale, provenienza dati di fine-tune documentata.
