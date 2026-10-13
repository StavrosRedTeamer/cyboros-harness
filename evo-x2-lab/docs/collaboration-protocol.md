# Protocollo di collaborazione multi-modello

Come il brain (Qwen3.8-Flash-Next) e gli specialisti del PC2 conversano per
risolvere problemi offensivi. Regola fondamentale: **dialogo strutturato, mai
libero** — senza protocollo di handoff i modelli si rinforzano a vicenda negli
errori e bruciano contesto.

Evidenze di riferimento: HPTSA (team gerarchici: 4.3× vs monolite),
D-CIPHER (auto-prompting: +65% tecniche MITRE ATT&CK), Novee (pass@k:
Qwen-3.5-27B dal 63% all'87% di exploit rate con 9 tentativi), CHECKMATE
(planning in task-graph, non lasciato all'LLM).

## 1. Ruoli

| Ruolo | Modello | Cosa fa | Cosa NON fa |
|---|---|---|---|
| **Planner** | brain (PC1) | Scompone l'obiettivo in task-graph, assegna i sub-task | Non tocca mai i tool |
| **Executor** | toolcaller (PC2) | Esegue i tool MCP (nmap, nuclei, sqlmap, burp) | Non decide la strategia |
| **Generator** | coder (PC2) | Produce ipotesi, PoC, exploit script | Non giudica i propri output |
| **Critic** | cyber (PC2) | Deve **argomentare i punti di fallimento** del PoC | Non genera soluzioni alternative (per quello c'è il Generator) |
| **Judge/Arbitro** | brain (PC1) | Valuta Generator vs Critic, decide, sintetizza | Non esegue |
| **Parser** | parser (PC2) | Riduce output grezzo dei tool a finding strutturati | Non interpreta strategicamente |
| **Auto-prompter** | brain (PC1) | Riscrive i prompt di ruolo quando vede fallimenti ripetuti | Non interviene sul singolo task |

Vincolo anti-bias: **il Critic deve essere di famiglia diversa dal Generator**
(Deep Hat critica Qwen3-Coder-Next e viceversa). Critic e generator della
stessa famiglia hanno errori correlati e si danno ragione.

## 2. Schema di handoff (obbligatorio per ogni messaggio tra modelli)

Ogni passaggio di consegne è un JSON validato contro questo schema. Il campo
`schema` è `handoff/v1`.

```json
{
  "$schema": "handoff/v1",
  "session_id": "eng-2026-10-03-acme-web",
  "from_role": "generator",
  "to_role": "critic",
  "task_ref": "T3.2",
  "hypothesis": "SQL injection time-based sul parametro /login (POST, campo user)",
  "evidence": [
    {
      "source": "tool",
      "tool": "sqlmap",
      "cmd": "sqlmap -u https://target/login --data='user=x' --technique=T",
      "output_excerpt": "wall time comparison: 5.02s vs 0.31s (baseline)",
      "timestamp": "2026-10-03T14:22:11Z"
    }
  ],
  "proposed_action": "PoC: payload ' OR SLEEP(5)-- - su campo user, misurare delta",
  "verdict": "needs_review",
  "confidence": 0.72,
  "next_steps": ["validare PoC in sandbox", "verificare WAF bypass"],
  "context_tokens_used": 18422,
  "notes": "Interferenza possibile da rate-limiting: test ripetuto 3 volte."
}
```

### Enum `verdict`

| Valore | Significato | Azione successiva |
|---|---|---|
| `needs_review` | Generato, non ancora criticato | Va al Critic |
| `criticized` | Il Critic ha risposto (vedi `critique` sotto) | Va al Judge |
| `approved` | Il Judge ha validato | Si esegue (Executor) o si riporta |
| `rejected` | Il Judge ha bocciato | Ripensare (Generator) o abbandonare |
| `validated` | PoC eseguito con successo in sandbox | Entra nei findings (pattern Strix) |
| `failed` | Tentativo fallito (eseguito) | Aggiorna la task-graph |

Per il passaggio Critic→Judge aggiungere:

```json
"critique": {
  "failure_modes": [
    "Il payload non sopravvive all'URL-encoding applicato dal reverse proxy",
    "Nessun controllo su second-order injection"
  ],
  "severity_if_real": "critical",
  "suggested_counter_test": "Ripetere con doppio encoding e header X-Forwarded-For randomizzato"
}
```

## 3. Gate di escalation (quando far conversare i modelli)

Il dialogo costa token e latenza: si attiva solo quando serve.

```
1. Worker tenta il sub-task da solo (1 chiamata)
       │
       ├─ successo + confidence ≥ 0.85 ──► handoff "approved" al Planner (fine)
       │
       └─ fallimento o confidence < 0.85
              │
              ▼
2. Generator → Critic (2 chiamate, famiglie diverse)
       │
       ├─ critic concorda sul fallimento ──► best-of-k (passo 3)
       │
       └─ critic identifica fix locale ──► Generator ritenta (max 2 volte)
              │
              ▼
3. Best-of-k: 2-3 Generator indipendenti (diversi seed/prompt) attaccano
   la stessa sottoclasse ──► Judge sintetizza la soluzione vincente
       │
       └─ ancora fallimento ──► escalation umana (operatore in loop)
```

Regole:
- Max **2 ritentativi** per livello; poi si sale. Loop infiniti = brucia budget.
- Il fan-out best-of-k è ammesso solo su problemi classificati "duri" dal
  Planner (sul PC2 2-3 slot paralleli stanno nel budget di memoria).
- **Ogni comando offensivo passa dall'Executor in sandbox** — Generator e
  Critic non eseguono mai nulla direttamente.
- L'operatore umano resta in loop per: targeting fuori scope, exploit
  distruttivi, exfiltration. Questo è anche il requisito per le istituzioni.

## 4. Flusso tipo di una sessione

```
Operatore ──► Planner (brain): "valuta target X, scope web"
Planner ──► task-graph: T1 recon · T2 enum · T3.1-3.n vuln analysis · T4 exploit · T5 report
Planner ──► Executor (toolcaller): T1 nmap/scansione
Executor ──► Parser: output grezzo ──► finding strutturati (handoff/v1)
Parser ──► Planner: T1 done, servizi mappati
Planner ──► Generator (coder): T3.2 su endpoint /login
Generator ──► Critic (cyber): "needs_review" + PoC proposto
Critic ──► Judge: critique con failure_modes
Judge (brain) ──► approved + counter-test ──► Executor: esegue in sandbox
Executor ──► handoff "validated" (o "failed") ──► Planner aggiorna la task-graph
...
Planner ──► report finale (template in docs/evaluation-plan.md)
```

## 5. Prompt di ruolo (template)

In inglese perché i modelli rispondono meglio; i placeholder `{{...}}` sono
riempiti dall'orchestratore (CAI o harness proprio).

### Planner (brain)
```
You are the penetration-testing planner for an AUTHORIZED engagement
(session {{session_id}}, scope: {{scope}}).
Decompose the objective into a task-graph with dependencies. Output ONLY
JSON task nodes: {id, objective, depends_on, difficulty: easy|hard}.
You never run tools. You never produce exploits. You decide what happens
next, not how to do it.
```

### Generator (coder)
```
You are the exploit generator. Task: {{task_objective}}.
Evidence so far: {{evidence_json}}.
Produce ONE hypothesis and ONE proof-of-concept. Output JSON conforming to
handoff/v1 with verdict "needs_review". Include the exact command the
executor should run. Assume every target interaction happens in a sandbox
by a separate executor — you never execute anything yourself.
```

### Critic (cyber)
```
You are the adversarial reviewer of a proposed proof-of-concept. You did NOT
write it and you disagree by default. Task ref: {{task_ref}}.
Proposal: {{handoff_json}}.
List concrete failure modes (encoding, WAF, environment, assumption errors),
rank their likelihood, and propose counter-tests. Output JSON with
"critique.failure_modes" and "suggested_counter_test". Do NOT propose a
full alternative exploit — only why this one breaks and how to test that.
```

### Judge (brain)
```
You are the judge. Generator proposal: {{handoff_json}}. Critic review:
{{critique_json}}.
Decide: approved / rejected / retry. If approved, define the counter-test
that must pass before execution. Consider the critic's failure modes — a
PoC that cannot survive the criticism is not a finding. Output JSON
(handoff/v1 with verdict).
```

### Parser
```
You are the tool-output parser. Raw output of {{tool_name}}:
{{raw_output}}.
Extract findings as JSON: [{target, service, observation, severity_hint,
confidence}]. Preserve exact evidence strings (ports, versions, error
messages). Do not speculate beyond the output.
```

### Auto-prompter (brain, ruolo meta)
```
You review session logs of failing sub-tasks: {{failure_log}}.
Identify recurring failure patterns (wrong tool order, missing
recon, overconfident verdicts). Rewrite the ROLE PROMPTS of the agents
that keep failing, one change per prompt, minimal and testable.
Output JSON: [{role, new_prompt, rationale}]. Never change scope or
authorization rules.
```

## 6. Anti-patterni (vietati)

- **Dialogo libero** tra modelli senza handoff JSON: allucinazioni a catena.
- **Critic della stessa famiglia** del Generator: bias correlati.
- **Retry senza variazione**: se fallisce due volte identico, cambia livello
  (o prompt, via auto-prompter), non riprovare uguale.
- **Output grezzo dei tool in context del brain**: il brain legge solo le
  sintesi del Parser. Un nmap su /24 satura il contesto in un colpo.
- **Esecuzione diretta** da parte di Generator/Critic: solo Executor, solo in
  sandbox, solo target in scope.

## 7. Metriche del protocollo

Tracciate dalla sessione 1 (vedi docs/evaluation-plan.md):
- exploit rate k=1 vs k=3 (guadagno reale del best-of-k)
- tasso di "rejected" del Judge (qualità del Generator)
- tasso di failure_modes del Critic confermati dall'esecuzione (qualità del Critic)
- ritentativi medi per finding, token per finding, minuti per finding
- % di finding "validated" vs "needs_review" fermi (colli di bottiglia)
