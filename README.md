# StavrosRedTeamer — workspace standalone (Freebuff)

Harness di **web/host penetration testing** su **Freebuff (Codebuff)**: un orchestratore
multi-agente, **Stavros**, che pianifica l'assessment e delega a sub-agent specializzati.
Questa cartella è **auto-contenuta**: motore tool zero-dipendenze (`tools/`), agenti
(`.agents/*.ts`), metodologia (`knowledge.md`, `skills/`, `refs/`, `ops/harness.md`) e
tool vendored (`vendor/`). Nessuna dipendenza da altri progetti o cartelle esterne.

> Uso consentito SOLO su sistemi tuoi o con **autorizzazione scritta** (pentest concordato,
> bug bounty in-scope, lab). Lo scope-guard è **fail-closed**: con `scope.json` vuoto
> blocca tutto.

## Avvio

```bash
./launch-freebuff.sh        # pre-flight (scope, CLI, Chrome) + avvio TUI
# equivalente:
freebuff --cwd "$(pwd)"
```

Poi chiedi, es.: *"Stavros, assess https://target.com — full web pentest"*.
Stavros legge `knowledge.md` + playbook + `scope.json`, lancia recon → mapper → tester →
reporter (stage-gate + coverage matrix) e scrive i risultati in `reports/`.

Launcher grafico: `stavros-freebuff.desktop` (Exec già puntato a questa cartella).
Console web opzionale: `node tools/gui-server.js` → http://127.0.0.1:8787 (o `npm run console`).

## Parrot OS (questo dispositivo)

Adattato a **Parrot Security (echo / Debian 13)** con KDE Plasma:

- **Node ≥ 22 obbligatorio** per il Command Center (`tools/gui-server.js` usa `node:sqlite`).
  L'apt di Parrot fornisce solo Node 20 → installa la 22 LTS:
  `curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs`
  (in alternativa `nvm install 22`). La TUI `freebuff` gira anche su Node 20.
- **Chromium** non è preinstallato (solo Firefox): serve per `dom-check.js` (CDP) e per l'MCP
  `chrome-devtools`. `./install-tools.sh` lo installa (`apt install chromium`).
- **Terminale**: `open-freebuff-terminal.sh` usa **konsole** (default KDE su Parrot); fallback
  qterminal / mate-terminal / x-terminal-emulator / xterm.
- **Pacchetti**: alcuni nomi differiscono da Kali — `bind9-dnsutils` (era `dnsutils`),
  `httpx-toolkit` (era `httpx`), `naabu` al posto di `rustscan`. Tool solo-Kali
  (`ghauri`, `xsstrike`, `lfimap`) sono installati via `pipx`; `linkfinder`/`tplmap`/`nosqlmap`
  via git upstream (l'installer lo segnala). Verifica finale: `node tools/doctor.js`.


## Struttura

```
stavrosredteamer/
├── .agents/*.ts        # 28 agenti Freebuff (orchestratore + specialisti) — il cuore
├── ops/harness.md      # regole condivise (disciplina, tool-wiring, MCP) — grep su richiesta
├── skills/pentest-playbook/  # playbook operativo: SKILL.md = scheletro; references/ = dettaglio (tool-manual, hunting-surface, client-side, verification-reporting)
├── refs/               # knowledge base per classe di vulnerabilità
├── knowledge.md        # metodologia + regole di engagement (contratto compatto; il dettaglio è in docs/)
├── docs/               # dettaglio metodologico per-tool (toolbox, host-exploitation, egress-opsec, wireless, methodology-classes) — indicizzato da kb-search.js
├── tools/              # motore zero-dipendenze (scope-guard, repeater, pipeline, C2, wifi, GUI, test)
├── vendor/             # tool vendored: script vetted piccoli (noauth_finder, aptpp); i binari grossi (obscura, frida-server) li installa install-tools.sh fuori dal repo
├── memory/             # memoria RAG locale delle soluzioni
├── reports/            # output run: findings.jsonl, state.db, report HTML (storico incluso)
├── scope.json          # COMPILA QUESTO: fail-closed finché non autorizzi i target
├── auth.json           # (opzionale) identità per il pass autenticato
├── wifi-scope.json     # (opzionale) modalità wireless separata
├── c2.json             # (opzionale) profili listener host exploitation
└── install-tools.sh    # installer binari (Parrot OS/Debian; equivalente .ps1 per Windows)
```

## Scope (obbligatorio, prima cosa)

Compila `scope.json`:

```json
{
  "allowed_hosts": ["target.com", "api.target.com"],
  "allowed_ips": ["127.0.0.1", "10.0.0.0/8"],
  "max_requests_per_second": 2
}
```

Verifica: `node tools/scope-guard.js check https://target.com` (exit 0 = consentito).
Vale anche per `auth.json` (verifica identità: `node tools/login.js <identità>`) e
`wifi-scope.json` (`node tools/wifi-guard.js check <BSSID>`).

## Test

`npm test` — un unico gate per tutta la suite (`tools/test-*.js`, classificati
offline/loopback/e2e). `npm run test:list` mostra la classificazione, `npm run test:all`
include i test live.

## Workflow di modifica

Questa è la **fonte**: per modificare un agente edita direttamente `.agents/<id>.ts`
(poi riavvia Freebuff per ricaricarlo). Per la metodologia: `knowledge.md` (contratto) +
`docs/` (dettaglio), `ops/harness.md`, `refs/`, `skills/pentest-playbook/` (SKILL.md scheletro +
`references/` per il dettaglio). Non c'è alcun passaggio di generazione/sync in questa cartella.

## MCP nativo (Freebuff >= 0.0.156)

Il campo `mcpServers` nelle definizioni `.ts` attiva i server MCP: i tool compaiono come
`<server>__<tool>` (es. `chrome-devtools__navigate_page`). Attivo di default:
`chrome-devtools` (browser headless, richiede Chrome) solo sugli agenti di superficie
browser/DOM. Config di riferimento: `mcp.example.json`.

> ⚠️ **Sicurezza**: i tool MCP NON passano dai guard in-process (`repeater.js`/`run.js`).
> L'agente è istruito a scope-checkare manualmente (`node tools/scope-guard.js check <url>`)
> prima di usare un tool MCP su un target, e a preferire run.js/repeater.js per il tampering.
