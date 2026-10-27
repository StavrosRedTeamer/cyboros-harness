# Cyboros Sage — deep research locale (Sage-A1.5)

> Un run di ricerca che parte da un'icona sul desktop, legge fonti locali e web, e produce un
> report in cui **ogni affermazione ha una citazione verificata byte-per-byte**. Non è un chat
> con un modello: è una pipeline che usa un modello da ~3B attivi per proporre, e il codice per
> verificare. Le proposte che ne escono restano `draft` finché un umano non le approva.

## Perché esiste

La conoscenza dell'harness (`knowledge.md`, `refs/`, `skills/pentest-playbook/`, `docs/`) invecchia
con il dominio. `tools/radar.js` sorveglia l'ecosistema di *tool* (repo GitHub, stelle, licenze) e
analizza via provider cloud. Sage copre l'altra metà: **letteratura e advisories** (CVE/NVD,
vendor, paper, playbook) e **gap di capacità dell'harness**, con lo stesso principio che vale per
un finding — se non c'è la prova, non c'è l'affermazione.

Non sostituisce `radar` e non scrive nei playbook da solo: propone, l'operatore dispone.

## L'invariante

```
il modello propone  →  il codice verifica  →  il report contiene
```

1. Ogni fonte viene **congelata** in `artifacts/sage/<run>/sources/<sha256>.txt` prima di essere letta.
2. Ogni claim prodotto dal modello porta una `quote`; `tools/evidence-quote.js:validateQuote()`
   la rilegge DA DISCO e la accetta solo se è una sottostringa identica (byte per byte).
3. Le citazioni che non passano vengono scartate e **contate** nel report (sezione "Citazioni scartate").
4. `snapQuote()` ricostruisce i byte reali quando il modello cambia spaziature: la citazione che
   finisce nel report è sempre esatta per costruzione, mai "abbastanza simile".
5. Una proposta che non cita almeno un claim verificato viene scartata. Sotto 3 claim verificati
   non si generano proposte affatto: il report dice "evidenza insufficiente".

## Moduli

| modulo | cosa fa |
|---|---|
| `tools/sage/index.js` | CLI (`run`, `resume`, `chat`, `status`, `check`, `promote`) e ciclo di ricerca con checkpoint |
| `tools/sage/sources.js` | corpus locale + DDG/NVD/GitHub/arXiv, fetch con guardia SSRF, cache congelata, audit |
| `tools/sage/extract.js` | claim + quote per fonte, con `snapQuote` sul testo reale |
| `tools/sage/synth.js` | note e proposte, validazione meccanica, report markdown |
| `tools/sage/plan.js` | brief → domande, con fallback deterministico per lane |
| `tools/sage/redact.js` | scrubbing di host/IP in scope e segreti prima dell'egress |
| `tools/sage/state.js` | checkpoint atomico, budget, elenco run |
| `tools/sage/ask.js` | unico punto di domanda al modello (testo/JSON, parser tollerante) |

## Pipeline

```
brief → plan (2-6 domande) → per ogni domanda:
   search (corpus locale + DDG + NVD + GitHub/arXiv) → fetch (cache sha256, audit)
   → extract (claim + quote, gate) → [ripeti per fonte]
→ synth (claim → note + proposte) → report .md + .proposals.json → promote (manuale)
```

Ogni stadio è una **domanda singola con risposta JSON**: è il motivo per cui funziona con un modello
da 3B attivi, che non regge catene lunghe né contesti enormi. Il pianificatore ha un fallback
deterministico per lane, così un run parte anche se il modello non risponde in formato.

## Due lane

| lane | cosa cerca | motori |
|---|---|---|
| `offensive` | classi di vulnerabilità, tecniche, verifica riproducibile, tool | corpus locale, DDG, NVD |
| `capability` | capacità mancanti dell'harness, misurabilità, progetti OSS | corpus locale, DDG, GitHub, arXiv |

## Comandi

```bash
# 1. modello (una volta): ~22 GB, serve spazio e tempo
bash local/sage/download.sh --list      # cosa scarica
bash local/sage/download.sh             # scarica/riprende
bash local/sage/serve.sh --check        # carica, verifica /v1/models, esce 0/1

# 2. preflight del ricercatore (endpoint, JSON, quote-gate, redazione)
node tools/sage/index.js check

# 3. ricerca (job lungo, checkpoint su disco)
node tools/sage/index.js run --brief "HTTP request smuggling" --lane offensive
node tools/sage/index.js run --brief "gap di copertura su API stateful" --lane capability \
  --max-sources 12 --budget-min 90

# 4. dopo un'interruzione / per interrogare i risultati
node tools/sage/index.js resume <runId>
node tools/sage/index.js chat <runId>        # /claims per la lista, /q per uscire
node tools/sage/index.js status
```

Flag: `--max-sources N` (12) · `--budget-min N` (90) · `--questions N` (6) ·
`--chunks-per-source N` (2) · `--model sage|qwen` · `--endpoint URL` · `--open` · `--no-redact`.

`--model qwen` punta `local/config.local.json` (porta 8080): serve a validare la pipeline contro il
modello del pentest già installato, senza scaricare Sage.

## Servire il modello

| profilo | porta | config | note |
|---|---|---|---|
| Sage-A1.5 | 8092 | `local/sage/config.json` | default del ricercatore |
| Qwen3.6-35B abliterato | 8080 | `local/config.local.json` | default del pentest |

`local/sage/serve.sh` avvia llama.cpp con `-c 32768`, KV q8_0 e `--n-cpu-moe 36` (esperti in RAM).
Il valore è **misurato**, non scelto: su questa macchina 32 esperti mandavano in OOM `cudaMalloc`
(buffer di calcolo da 492 MiB), 36 carica con 4,3 GB di VRAM.
Su una RTX 4050 da 6 GB **un solo modello alla volta**: se la 8080 è occupata lo script si ferma e
chiede `--takeover`, che ferma l'altro server **per PID** (mai `pkill` per pattern). Se CUDA non si
inizializza, llama.cpp ripiegherebbe in silenzio sulla CPU: lo script lo intercetta e si ferma.

Attese misurate su questo hardware (35B/3B attivi, Q4_K_M, esperti su CPU): **~17-19 tok/s** e
**~1 minuto per fonte** (run reali: 3 fonti/3 min, 4 fonti/2 min dopo un resume). Quindi 12 fonti
stanno in **10-20 minuti**, non in due ore: la stima pessimistica iniziale è stata smentita dalla
misura. Resta comunque un job lungo e non una richiesta sincrona, ed è per questo che ha checkpoint
invece di un timeout.

## Egress, redazione, audit

La ricerca ha **egress aperto** (nessuna allowlist): è una decisione dell'operatore, e non è la
stessa cosa del traffico verso un target. Restano due protezioni che non limitano la ricerca:

- `tools/sage/redact.js` toglie host/IP di `scope.json`, **nome e cliente dell'engagement**
  (`campaign.json`), SSID/BSSID/seriali di `wifi-scope.json` e `mobile-scope.json`, e pattern di
  credenziali (email, Bearer, JWT, `sk-`, `gh[pousr]_`, AKIA) da **ogni** query prima dell'uscita. Sottodomini inclusi; i nomi che somigliano non vengono toccati;
  le parole troppo comuni ("pentest", "platform") sono escluse per non distruggere la query.
  I log riportano solo categoria e numero dei colpi, **mai il valore rimosso**.
- `artifacts/sage/<run>/egress.jsonl` registra ogni query (già ripulita), ogni URL fetchato,
  il numero di candidati e il path dell'artefatto congelato. `--no-redact` disattiva la pulizia:
  da usare solo se sai perché.

Il fetch rifiuta IP privati/link-local a **ogni hop** di redirect (`tools/ssrf-guard.js`), tronca il
corpo a 4 MB **mentre legge** (non dopo averlo materializzato) e va a 1 req/s per dominio. Scarta i
contenuti non testuali: un PDF non diventa testo passando da un `htmlToText`. Le fonti sono dati non
fiduciosi: lo stadio di estrazione non ha tool, e le istruzioni contenute in una pagina sono trattate
come testo.

## Quanto di una fonte viene davvero letto

Il modello non legge una fonte intera: legge i primi `--chunks-per-source` blocchi (default 2) di
~6k caratteri. È un limite di contesto, non un dettaglio: il report lo dichiara nella colonna
`blocchi` della tabella fonti (`2/6` = due blocchi su sei), perché "fonte letta" senza quel dato
sarebbe un'affermazione più larga del vero. Nel conteggio degli **scarti** finiscono sia le
citazioni che non tornano, sia le estrazioni che non hanno prodotto JSON: sono due guasti diversi
e il report li elenca per ragione.

## Output su disco

```
artifacts/sage/<run>/state.json            checkpoint (resume), budget, contatori
artifacts/sage/<run>/sources/<sha>.txt     fonte congelata = oggetto della citazione
artifacts/sage/<run>/claims.jsonl          claim tenuti (+ id C-0001…)
artifacts/sage/<run>/dropped.jsonl         scarti (citazione non valida o estrazione fallita) + ragione
artifacts/sage/<run>/egress.jsonl          audit delle uscite
reports/sage/<data>-<slug>.md              report leggibile
reports/sage/<data>-<slug>.proposals.json  proposte (schema compatibile con radar)
reports/sage/drafts/<slug>.md              bozza di playbook
```

`reports/` e `artifacts/` sono gitignored: contengono dati di engagement e non si versionano.

## Ciclo di vita di una proposta

1. Il run scrive la proposta con `"status": "draft"`.
2. L'operatore la legge nel report e nel `.proposals.json`.
3. Se la vuole adottare, mette `"status": "approved"` nel file.
4. `node tools/sage/index.js promote <SAGE-...>` genera la bozza in `reports/sage/drafts/`.
5. `... promote <SAGE-...> --apply` la scrive in `skills/pentest-playbook/references/<slug>.md`
   (rifiuta se il file esiste, salvo `--force`).

Nessuna scrittura automatica in `knowledge.md`: la conoscenza che gli agenti leggono si tocca a mano.

## Limiti noti

- **Vision**: il file `mmproj` viene scaricato ma non montato; le fonti sono testo.
- **Nessun parallelismo**: 6 GB di VRAM = una sola istanza di modello. Il loop è sequenziale.
- **Modello piccolo**: la qualità della sintesi è quella di un 3B attivi. Il gate sulle citazioni
  alza il pavimento (niente affermazioni senza prova) ma non il soffitto (poca profondità).
- **Architettura GGUF**: se il tuo build di llama.cpp non conosce `qwen35moe`, `serve.sh --check`
  fallisce con l'istruzione di rebuild. Nel frattempo la pipeline funziona con `--model qwen`.
- **Rate limit dei motori**: DDG/NVD possono rispondere 429; il singolo provider viene saltato, il
  run prosegue.

## Verifica

```bash
node tools/test-sage-redact.js     # redazione: host, sottodomini, segreti, hit senza valori
node tools/test-sage-extract.js    # quote-gate: snap sui byte reali, parafrasi rifiutata
node tools/sage/index.js check     # endpoint + round-trip + gate + redazione sul workspace reale
npm test                           # include i due test qui sopra (offline, senza rete)
```

## Installazione dell'icona

```bash
./scripts/install-sage-launcher.sh
```

Scrive `cyboros-sage.desktop` in `~/Scrivania` (o `~/Desktop`) con il path reale del repo, icona
`tools/app/icons/cyboros-cc.svg`, e apre `local/sage/sage.sh` in un terminale: nuova ricerca,
riprendi, chat, check dello stack, apri l'ultimo report. Il job resta staccato (`setsid`): chiudere
il terminale non lo uccide.
