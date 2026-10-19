# Runtime indipendente con API key proprie — design spec

**Data:** 2026-10-19 · **Repo:** cyboros-harness · **Stato:** design, in attesa di revisione
**Decisioni già prese con l'operatore:** superficie primaria **CLI-first**; perimetro provider v1
**solo OpenAI-compatibile**; egress cloud **opt-in per profilo** (`egress: local|cloud`) con
`--local-only` come blocco duro. Restano invariati: zero dipendenze npm (gate CI), Node ≥ 22,
guard fail-closed, severità incapace di superare l'evidenza.

## 1. Il problema, in una frase

Il motore, i guard e il layer di prova sono già indipendenti dal fornitore; l'unico pezzo che
dipende ancora da Freebuff è il **runtime del modello** — avvio, prompt, tool surface, sessioni,
provenienza — e finché vive lì l'harness non è distribuibile a un terzo che non abbia Freebuff e
non può usare le proprie chiavi.

## 2. Obiettivo e non-obiettivi

**Obiettivo.** Da un clone pulito, con Node 22 e una chiave in una variabile d'ambiente,
`cyboros agent run <host> --profile <p>` esegue un assessment completo guidando lo stesso motore
deterministico, senza installare nulla, senza telemetria, senza che Freebuff esista sul sistema.
Ogni run è riproducibile: provider, modello, prompt hash, config hash e usage finiscono nel
ledger.

**Non è in questa spec.** Nessuna nuova capacità offensiva; nessuna modifica a `scope-guard`,
`ssrf-guard`, `record-finding`, `gate`, `oracle` o al formato di `findings.jsonl`; nessun cambio
di comportamento dei guard; nessuna adozione di framework agentici esterni. `local/` non viene
rimosso in questa fase: diventa un profilo del nuovo runtime.

## 3. Cosa esiste già (misurato sul worktree, 2026-10-19)

| fatto | misura / percorso |
|---|---|
| moduli JS in `tools/` | **268**, di cui **116** `test-*.js` |
| dipendenze npm | **0** (`package.json` non ha `dependencies`; CI lo impone) |
| client LLM già scritto | `local/llm.js` — OpenAI-compatibile, retry/backoff, SSE, context trim, clip output, loop-guard fuzzy, GBNF, fallback testuale |
| ponte modello → tool | `local/tools-bridge.js` — schema function-calling, dispatch a `run.js`/`scope-guard`, write confinato a `reports/` |
| driver di fase | `local/run-local.js` (fasi e `--plan`), `local/chat-local.js` (REPL) |
| usage | `tools/accounting.js` definisce `{tokens_in, tokens_out, cost, source}` |
| budget | `tools/budget.js` — cap engagement/classe, halt persistente, exit 3/4 |
| superficie UI | `tools/gui-server.js` + SPA, token di sessione, loopback-only, SSE |
| accoppiamenti Freebuff | `launch-freebuff.sh`, `.agents/cyboros-root.ts`, 28 file in `local/fleet/`, `AGENTS.md` + `~/.AGENTS.md` (offset), `tools/check-identity.js`, `tools/bench-provenance.js` |

Il lavoro è quindi un'**estrazione con generalizzazione**, non una riscrittura: il loop e il ponte
esistono già; mancano multi-provider, sessioni persistenti, prompt versionati, cattura automatica
dell'usage e la rimozione dei punti di avvio Freebuff.

## 4. Architettura

I livelli L0–L3 restano intatti. Nasce un solo livello nuovo, L4, e nessun altro:

```
cyboros agent (CLI)              Command Center (PyQt6/SPA)
        │                                  │
        └──────────────┬───────────────────┘
                       ▼
              runtime/  — L4
              ├── providers/   openai-compatible
              ├── loop.js      tool-loop, retry, loop-guard, budget hook
              ├── session.js   SQLite + events.jsonl, resume
              ├── prompts.js   composizione, hash, budget di contesto
              ├── tools.js     registry → run.js / repeater.js / pipeline
              ├── usage.js     → schema accounting.js
              └── doctor.js    config, chiavi mascherate, endpoint, tool
                       │
        L2 guard (invariati) → L1 proof (invariato) → L0 engine (invariato)
```

**Perché `runtime/` alla radice.** È un livello architetturale, non un tool: `tools/` contiene il
motore e i suoi 116 test, `local/` è oggi un'edizione parallela. Tenerlo separato rende visibile
la sostituzione di Freebuff e impedisce che il nuovo loop venga assorbito nel motore. I test
restano in `tools/test-runtime-*.js`, perché `tools/run-tests.js` scopre solo quel pattern.

| file | responsabilità |
|---|---|
| `runtime/cli.js` | parsing comandi/flag, exit code, wiring; nessuna logica di dominio |
| `runtime/config.js` | schema, validazione fail-closed, risoluzione env/keyring, hash della config |
| `runtime/providers/index.js` | registry, capability negotiation, error taxonomy |
| `runtime/providers/openai.js` | `/v1/chat/completions`, tool-calling nativo, SSE, usage |
| `runtime/loop.js` | un turno agente: modello → tool → osservazione, limiti, loop-guard |
| `runtime/session.js` | store append-only, resume, trace, ancoraggio dell'head |
| `runtime/prompts.js` | contratto + fase + indice tool + fatti engagement; sha256 |
| `runtime/tools.js` | schemi generati da `tools/tool-registry.json`; dispatch guardato |
| `runtime/usage.js` | normalizzazione usage e scrittura nel ledger/budget |
| `runtime/doctor.js` | preflight: config, chiave presente (mascherata), endpoint, binari, scope |

## 5. Contratto del provider

Interfaccia unica; gli adapter traducono, il loop non conosce il fornitore.

```js
// runtime/providers/index.js
async function createProvider(profile) -> Provider

// Provider
{
  id, type, egress,                       // 'local' | 'cloud'
  capabilities: {                         // negoziate, non assunte
    nativeTools, streaming, jsonSchema, grammar, systemRole, images,
    maxContext, maxOutput
  },
  async complete({
    messages, tools, toolChoice, stream, signal,
    grammar, temperature, maxTokens, onToken
  }) -> {
    text,                                 // string, anche vuota
    toolCalls: [{ id, name, args }],      // args già parsato, mai stringa
    usage: { tokens_in, tokens_out, cost, source },
    finishReason, raw
  }
}
```

Forma canonica dei messaggi, indipendente dal fornitore:

```js
{ role: 'system' | 'user' | 'assistant' | 'tool', content: string,
  toolCalls?: [{ id, name, args }], toolCallId?: string }
```

**Adapter v1: solo `openai-compatible`.** Copre OpenAI, OpenRouter, Groq, Together, Fireworks,
DeepSeek, xAI, Mistral, vLLM, llama.cpp, Ollama, LM Studio. Le differenze reali da gestire sono
tre: `tool_calls` in streaming (ricomposizione per `index`), `usage` opzionale (llama.cpp non lo
emette sempre), e header extra per OpenRouter. Gli adapter nativi Anthropic/Gemini restano fuori
da v1 per decisione dell'operatore; l'interfaccia è già pronta a ospitarli senza toccare il loop.

**Config.** Template versionato `runtime/providers.example.json`; il file reale sta in
`runtime/providers.json` (gitignored) oppure nel path passato con `--config`. Schema:

```json
{
  "version": 1,
  "default_profile": "llama",
  "allow_cloud": false,
  "profiles": {
    "llama": {
      "type": "openai-compatible",
      "base_url": "http://127.0.0.1:8080/v1",
      "model": "local",
      "api_key_env": "CYBOROS_LOCAL_KEY",
      "egress": "local",
      "max_context": 32768,
      "max_output": 2048
    },
    "openrouter": {
      "type": "openai-compatible",
      "base_url": "https://openrouter.ai/api/v1",
      "model": "vendor/model",
      "api_key_env": "OPENROUTER_API_KEY",
      "egress": "cloud",
      "timeout_ms": 120000,
      "headers": {}
    }
  },
  "roles": {
    "orchestrator": "llama",
    "recon": "llama",
    "tester": "llama",
    "verifier": "llama",
    "reporter": "llama"
  }
}
```

**Regole delle chiavi.**

- Solo `api_key_env` (o `api_key_keyring` con `secret-tool`/`security`). Il campo `api_key` inline
  è **rifiutato** dalla validazione: è l'unico modo per impedire che una chiave finisca in un
  commit come è successo a `local/config.local.json`.
- Ordine di risoluzione: env → keyring → errore `provider_key_missing`. Nessun fallback silenzioso.
- La chiave non entra mai nel prompt, nei log, nei trace o in `reports/`. `doctor` e i messaggi
  d'errore mostrano solo prefisso e ultime 4 cifre.
- `--api-key` non esiste: gli argv sono visibili in `ps`.

**Error taxonomy.** `provider_unreachable`, `provider_auth`, `provider_rate_limited`,
`provider_context_overflow`, `provider_bad_response`, `provider_refusal`. I primi tre hanno retry
con backoff e jitter; `context_overflow` riduce il contesto e riprova una volta; `refusal` non è
un retry: è un esito, registrato come evento e restituito all'operatore.

## 6. Loop e sicurezza del dispatch

Il loop è estratto da `local/llm.js` e mantiene ciò che già funziona: retry, trim del contesto,
clip degli output, loop-guard (identico + fuzzy), fallback al protocollo testuale, streaming SSE.
Aggiunge quattro cose:

1. **Validazione prima del dispatch.** Gli argomenti sono validati contro lo schema del tool
   (`runtime/tools.js`) prima di eseguire; un argomento fuori schema è un errore del modello, non
   un'esecuzione. `write_file` resta confinato a `reports/`, `run_tool` accetta solo binari del
   registry, niente stringhe di shell.
2. **Cancellazione.** `AbortController` propagato dal CLI al provider e ai tool; Ctrl-C chiude il
   turno e lascia la sessione riprendibile.
3. **Usage per chiamata.** Ogni risposta produce `usage` e lo passa a `runtime/usage.js`.
4. **Budget hook.** Prima di ogni tool-call: `tools/budget.js check`; dopo: `tick`. Cap superato
   → halt persistente, exit 3/4, nessuna azione successiva.

Il modello resta un **proponente**, non un'autorità: ogni tool passa da `run.js`, `repeater.js`,
`workflow.js` o `cyboros.js`; nessun binario viene invocato direttamente. MCP si monta solo via
`tools/mcp-guard-proxy.js`.

## 7. Sessioni, prompt, provenienza

**Sessioni.** `reports/agent/sessions/<id>/` con:

```
meta.json     { id, started_at, host, phase, profile, model, provider,
                prompt_sha256, config_sha256, resumed_from }
events.jsonl  { seq, ts, type, ... }   type: user|assistant|tool_call|tool_result|usage|error|approval
session.db    node:sqlite — turns(id, role, content, tool_calls_json, created_at)
```

`events.jsonl` è append-only e incatenato (`prev_sha256` per riga), con l'head finale in
`reports/agent/anchors.jsonl`: stessa disciplina di `chain-log.js`, così un replay non può
riscrivere la storia. `resume` ricostruisce il contesto dagli eventi e dagli ultimi N turni, non
da uno snapshot opaco. Risolve il problema documentato in `ops/harness.md`: oggi il prompt è uno
snapshot preso alla creazione del thread, quindi una modifica non arriva alle sessioni aperte.

**Prompt.** `runtime/prompts/contract.md` (contratto d'engagement, bounded), 
`runtime/prompts/phases/<fase>.md` (le 5 fasi di `local/agents-local/`), indice dei tool, fatti
dell'engagement (scope, path della mappa, conteggio finding). `prompts.js` calcola lo sha256 della
composizione e lo scrive in `meta.json` e in ogni riga di provenienza. `knowledge.md` resta la
fonte umana estesa: il prompt ne porta l'indice compresso, non il file intero.

**Provenienza.** `tools/bench-provenance.js` oggi legge i log di Freebuff; il runtime scrive una
riga propria con `provider`, `model`, `prompt_sha256`, `config_sha256`, `temperature`, `seed` e
`usage`. `gen-bench.js` consuma quella riga. Nessun dato di engagement nel ledger.

## 8. Egress e segreti

- `allow_cloud` è `false` di default. Un profilo cloud si usa solo se la config lo consente e la
  run passa `--allow-cloud`; `--local-only` ignora la config e fallisce se un ruolo risolve su un
  provider cloud.
- Prima dell'invio a un provider cloud, i messaggi passano dal redattore (riuso del sanitizer di
  `memory/`): host in scope e credenziali nota vengono sostituiti con segnaposto. Il redattore non
  è una garanzia di anonimato: è una riduzione del danno, e va dichiarato così.
- `runtime/providers.json` è gitignored; i file di sessione stanno sotto `reports/` (già
  gitignored); il test `test-runtime-secrets.js` verifica che nessuna chiave finisca nei log.
- `docs/THREAT-MODEL.md` e `SECURITY.md` vanno aggiornati: con chiavi proprie il provider è un
  nuovo confine di egress, e il prompt injection dal target è un attacco all'agente, non solo al
  target.

## 9. Superficie CLI

Bozza dettagliata — transcript, stati di attesa, contratto NDJSON, exit code:
[interfaccia CLI di `cyboros agent`](2026-10-19-agent-cli-interface.md).

```
cyboros agent run <host> [--phase <p>] [--class <c>] [--profile <p>]
                         [--plan] [--allow-cloud] [--local-only]
                         [--budget <file>] [--watch] [--dry] [--json]
cyboros agent chat [<host>] [--phase <p>] [--profile <p>] [--tools <a,b>] [--auto]
cyboros agent resume <session-id> [--watch] [--json]
cyboros agent trace <session-id> [--json] [--tail]
cyboros agent sessions [--host <h>] [--json]
cyboros agent doctor [--live] [--json]
cyboros agent providers list|check [<profile>] [--json]
```

Exit code, allineati a quelli esistenti:

| code | significato |
|---|---|
| 0 | successo |
| 1 | fallimento / blocco del guard (come `scope-guard`) |
| 2 | uso errato |
| 3 | budget di engagement superato (come `budget`) |
| 4 | budget di classe superato (come `budget`) |
| 5 | provider o config non validi |
| 6 | gate che rifiuta il report |

Ogni comando accetta `--json` dove ha senso; `--dry` non chiama il provider e stampa prompt,
config risolta e tool esposti.

## 10. Migrazione di `local/`

`local/` non viene cancellato in questa fase. Diventa un **profilo**:

- `local/config.local.json` resta come esempio, ma la chiave si sposta in `CYBOROS_LOCAL_KEY`;
- `local/run-local.js` e `chat-local.js` diventano wrapper sottili su `runtime/cli.js`;
- `local/llm.js` e `local/tools-bridge.js` vengono estratti in `runtime/` e restano come re-export
  deprecati finché i test esistenti non sono migrati.

Regola: **un solo loop**. Se `local/` mantiene una copia del loop, il progetto torna ad avere due
runtime che divergono.

## 11. Milestone e criteri di accettazione

| # | contenuto | fatto quando |
|---|---|---|
| **M0** | `runtime/config.js`, `providers/openai.js`, `loop.js`, `cli.js run --phase`, mock provider | una run su host in scope con chiave in env funziona senza Freebuff; `npm test` verde e senza rete |
| **M1** | sessioni, resume, trace, usage → accounting/budget | Ctrl-C + resume riproducono la prossima azione; il costo è nel ledger |
| **M2** | `doctor`, `providers check`, `--local-only`, redattore, budget hook completo | `doctor` distingue config valida, chiave assente (mascherata), endpoint irraggiungibile, binario mancante |
| **M3** | `/api/agent/*` + SSE nel Command Center | una run si guida dalla UI senza terminale e senza bypassare i guard |
| **M4** | provenienza dal ledger; rimozione di `launch-freebuff.sh`, `.agents/`, `vet-agents`, `check-identity`, `bench-provenance` | `grep -ri freebuff` non trova più nulla di load-bearing |
| **M5** | verifier cross-model, playbook specialisti, bench con provenance | una riga di `bench-history.jsonl` basta a rifare la run |

M0 è il gate: se il loop estratto non riproduce il comportamento di `local/llm.js` sui test
esistenti, non si passa oltre. I test nuovi sono `tools/test-runtime-*.js`, eremitici, con un
server mock su loopback; il live test è taggato `e2e`.

## 12. Rischi e mitigazioni

| rischio | mitigazione |
|---|---|
| due loop che divergono | `local/` diventa wrapper; test di parità sul comportamento |
| modello locale debole + tool nativi | grammatica GBNF come capability, non default; fallback testuale invariato |
| API dei provider che cambia | fixture registrate + `doctor --live`; adapter isolati in un file |
| prompt che deriva da `knowledge.md` | hash + test che verifica la presenza delle regole canoniche |
| costo fuori controllo | budget hook su ogni tool-call; usage automatico; halt persistente |
| chiave in un commit | `api_key` inline rifiutato; `providers.json` gitignored; test sui segreti |
| egress non dichiarato | `allow_cloud` false di default; `--local-only` duro; riga di provenienza con `egress` |

## 13. Decisioni rinviate

- Adapter nativi Anthropic/Gemini: dopo M2, se il tool-calling via shim OpenAI si dimostra
  insufficiente sui test di classe.
- Espansione da 5 fasi a 28 specialisti: dopo M1, e solo come playbook con tool set esplicito.
- Firma dei report con una chiave dell'operatore: fuori scope finché non esiste un formato di
  report firmato.

## 14. Cosa rende il risultato "professionale"

Un solo entrypoint; exit code documentati; `--json` sulle superfici macchina; provenance completa
in ogni artefatto; resume e trace; nessuna telemetria; nessun auto-update che possa rompere il
runtime; zero dipendenze; un test eremitico per ogni adapter; e un `doctor` che dice la verità
invece di indovinare.
