# Cyboros Harness Rebrand Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Il repository si presenta, si invoca e si arma come **Cyboros Harness** — nome, binari,
flotta, formato dati e token — mentre l'evidenza storica resta esattamente com'era.

**Architecture:** Cinque fasi (F1 superficie pubblica → F2 motore e binari → F3 flotta e sistema →
F4 formato dati e tema → F5 identità), ognuna con `npm test` verde alla fine. Il token `@cyboros` e
la cartella di lavoro cambiano **solo in F5**, così una fase interrotta non lascia una harness che
non si arma più. Il rename dei file passa da `git mv` (la storia individuale sopravvive); il rename
degli identificatori passa da una mappatura unica (§0) e da un invariante che impedisce al nome
vecchio di rientrare nel codice dopo il rename.

**Tech Stack:** Node ≥ 22, zero dipendenze, suite hermetico/parallela (`tools/run-tests.js`), gate
già esistenti (`tools/test-repo-invariants.js`, `tools/docs-index.js --check`,
`tools/project-map.js --check`, `tools/test-lint.js`).

**Spec:** [`docs/superpowers/specs/2026-10-13-cyboros-rebrand-design.md`](../specs/2026-10-13-cyboros-rebrand-design.md)

## Global Constraints

Valgono per **ogni** task, anche quando il task non li ripete.

1. **Nessuna scrittura sulla storia.** `reports/`, `CHANGELOG.md` (voci passate), `docs/archive/`,
   `docs/superpowers/{plans,specs}/` datati, `legal/`, `temp/`, `scope.json`, `refs/`, `memory/`,
   `vendor/` — mai toccati. Una voce di CHANGELOG che raccontasse il passato con un nome che allora
   non esisteva è un falso: è il peccato che `tools/record-finding.js` rifiuta nei finding.
2. **Nessuna modifica di comportamento.** Si cambiano nomi, provenienza e verificabilità. Nessuna
   logica di guard toccata, nessuna dipendenza aggiunta (`npm test` fallisce se ne appare una).
3. **I numeri del README viaggiano col file.** Ogni task che aggiunge/rimuove un file sotto
   `tools/*.js`, un `test-*.js`, un agente o un workflow aggiorna nello stesso commit i quattro
   numeri dichiarati nel README (`N tests`, `N agent definitions`, `N reusable`, `N modules`).
   Il numero esatto lo detta il gate: `node tools/test-repo-invariants.js` nomina la discrepanza.
4. **`AGENTS.md` resta entro 6000 caratteri** (`AGENTS_MD_BUDGET` in
   `tools/test-repo-invariants.js`). Se il testo nuovo sfonda, si toglie prosa — non si alza il tetto.
5. **`git mv`, non cancella-e-ricrea**, per ogni file che esiste già: la storia individuale è la
   prova che la capacità è cresciuta a ondate.
6. **Un commit per task**, conventional commit (`docs:`, `chore:`, `refactor:`), con voce di
   CHANGELOG **nuova** (mai riscritta).
7. **Patch e liste di file si generano da `git ls-files`**, mai da `find`: un file non tracciato non
   esiste per chi clona, e il rename deve atterrare su ciò che è pubblicato.
8. **Ogni task chiude con** `npm test` (exit 0) e `node tools/test-repo-invariants.js` (exit 0).

## Review Focus

Le classi di input che la spec implica ma che nessun test del repo copre oggi. Ognuna riceve il suo
test nel task che possiede il codice.

1. **Un operatore che esporta ancora `STAVROS_TMP`/`STAVROS_REPORTS`** — un env var caduto in
   silenzio scrive i report altrove senza errore visibile. *Test: `tools/test-env.js`, precedenza
   `CYBOROS_*` e fallback `STAVROS_*`.*
2. **Un consumatore SARIF terzo già cablato su `properties.stavros`** — il giorno del rename, se la
   chiave sparisse, GitHub code scanning e DefectDojo perderebbero `verify_level` e il tetto di
   severità senza dirlo. *Test: `tools/test-report-sarif.js`, entrambe le chiavi presenti e
   coerenti.*
3. **Un documento datato che entra nell'indice live** — `docs/INDEX.md` è generato e indicizza anche
   i piani datati: se l'invariante anti-drift non conoscesse questo caso, l'indice diventerebbe
   rosso per aver fatto il suo lavoro. *Test: l'invariante stesso, con l'allowlist motivata.*
4. **Un `docs/OUROBOROS.md` che promette una capacità e nomina un file inesistente** — il claim
   "autoevolvente" senza artefatto. *Test: `tools/test-ouroboros-doc.js`, ogni percorso citato
   esiste.*
5. **Un `git mv` completo a metà** — un `require('./stavros')` sopravvissuto a un `id` di flotta
   rinominato: verde in locale, rosso a clone pulito. *Test: `tools/test-lint.js` (già esistente,
   copre il require morto) più l'invariante anti-drift nella sua forma "nome nel **nome** del file".*

---

## §0 · La mappatura (unica fonte di verità)

| oggi | domani |
|---|---|
| `StavrosRedTeamer` | `Cyboros Harness` |
| `Stavros` (persona, agente, prosa) | `Cyboros` |
| `@stavros` | `@cyboros` |
| `stavrosredteamer` (cartella, slug, npm) | `cyboros-harness` |
| `stavros` (binario) | `cyboros` |
| `stavros-doctor` / `-record-finding` / `-gen-bench` / `-mcp-guard-proxy` | `cyboros-*` |
| `STAVROS_*` (36 env var, 191 occorrenze) | `CYBOROS_*`, con `STAVROS_*` in fallback |
| `stavros-cc`, `scc` | `cyboros-cc` (un solo prefisso, `scc` non sopravvive) |
| `autostavros` (skill) | `cyboros-autopilot` |
| `Stavros Console` / `Radar` / `Doctor` | `Cyboros Console` / `Radar` / `Doctor` |
| `properties.stavros` | `properties.cyboros` (+ `stavros` per una release) |
| `partialFingerprints.stavrosFindingId` | `cyborosFindingId` (+ `stavrosFindingId` per una release) |
| `https://github.com/CSI-entitymorton/stavrosredteamer` | `.../cyboros-harness` |

**File tracciati con il nome vecchio nel nome: 42** (misurato con `git ls-files | grep -i stavros`),
di cui 28 in `local/fleet/`, 2 documenti datati (allowlist), 3 `.desktop`, 1 icona SVG, 1 unità di
servizio, 1 launcher, 2 moduli (`tools/stavros.js`, `tools/test-stavros.js`), 4 altro
(`.agents/stavros-root.ts`, `.agents/skills/autostavros/`, `session-prompt-autostavros.md`,
`piano-ottimizzazione-stavros.md` → allowlist).

**Comando base per la patch di prosa** (esclude l'anello storico; `git ls-files` non vede i file
ignorati come `reports/` e `scope.json`):

```bash
patch_live() {   # $1 = pattern ERE, $2 = sostituzione
  git ls-files \
    | grep -vE '^(CHANGELOG\.md|docs/archive/|docs/superpowers/(plans|specs)/|legal/)' \
    | grep -vE '^(docs/INDEX\.md|docs/project-map\.html|piano-ottimizzazione-stavros\.md)$' \
    | grep -vE '^(reports/|temp/)' \
    | xargs -r grep -lE "$1" -- \
    | xargs -r sed -i -E "s|$1|$2|g"
}
```

Dopo ogni patch: `node tools/docs-index.js && node tools/project-map.js` (i due file generati si
rigenerano, non si editano a mano) e `node tools/test-repo-invariants.js`.

### §0-bis · L'inventario delle famiglie (misurato, non indovinato)

**Perché esiste.** Il §0 è una mappatura di nomi; la superficie reale è un vocabolario. Misurato con
`git ls-files` meno l'anello storico: **470 file vivi tracciati, 222 dei quali nominano il progetto,
225 token distinti**. Un rename guidato da un pattern copre le famiglie che il pattern prevede e
lascia le altre — e le altre, qui, hanno consumatori fuori dal repo.

> **Trappola già pagata una volta, in questa sessione.** L'esclusione dell'anello storico va scritta
> **senza** `$` in fondo all'alternanza: `grep -vE '^(CHANGELOG\.md|docs/archive/|docs/superpowers/(plans|specs)/)$'`
> pretende che la riga sia *esattamente* uno di quei percorsi, quindi non esclude niente, e l'inventario
> «vivo» include in silenzio la storia (236 file invece di 222). Prima di usare una lista di file,
> **provarla**: `xargs -r grep -l 'x' -- < lista | grep -E '^(docs/archive|docs/superpowers|CHANGELOG)'`
> deve essere vuoto.

| famiglia | occ. | consumatore | trattamento | task |
|---|---|---|---|---|
| `StavrosRedTeamer` (prosa di marca) | 83 | lettore umano | rinomina | F1 |
| `Stavros` (persona) | 310 | il modello, nel prompt | rinomina | F2 (header), F5 (contratto) |
| `@stavros` (token) | 28 | l'operatore | rinomina | F5 |
| `stavrosredteamer` (slug/npm/cartella) | 60 | git, npm, path della chat | rinomina + migrazione | F1, F5 |
| `stavros.js` (CLI) | 88 | l'operatore | rinomina | F2 |
| `stavros-cc`, `scc` | 44 | launcher, Desktop Entry | rinomina | F2 |
| `STAVROS_*` (36 env) | 191 | shell dell'operatore | `CYBOROS_*` + fallback | F2 |
| `properties.stavros`, `stavrosFindingId` | 23 | GitHub code scanning, DefectDojo | emissione doppia | F4 |
| `autostavros` (skill) | 18 | `/skill:autostavros` invocato | rinomina | F2 |
| `local/fleet/stavros-*` + id | 28 file | la flotta, il router di spawn | `git mv` + id | F3 |
| `X-Stavros-Token` (header HTTP) | 6 | il client CC (`tools/gui/app.js`) e due test | **accettare entrambi** | F4 |
| `StavrosReproducer/1.0`, `STAVROS-MARKER` | 5 | **i log del target** e l'evidenza | **emissione doppia** · deciso | F4 |
| `hermes-stavros`, `f3-stavros` | 13 | **il telefono e il PC** (dir, fork, commento della chiave ssh) | **solo nel repo: il device resta** · deciso | gate §7 |
| `99-stavros-unprivileged-ports.conf` | 1 | **`/etc/sysctl.d/` della macchina** | **resta: è già installato** · deciso | gate §7 |
| `dev.stavros.TrustAllX509` | 1 | il processo instrumentato (Frida) | rinomina, senza fretta | F2 |
| `StavrosCC`, `chrome-stavros`, `stavros.css`, `stavros-cc.svg` | 10 | window manager, `/tmp`, asset | rinomina | F2 |
| prefissi di sessione e fixture (`stavros-slv-sess-`, `stavros-loot-`, `stavros-a1b2c3`, …) | ~20 | nessuno fuori dai test | rinomina | F2 |

**Le famiglie con un consumatore fuori dal repo, e perché non si toccano in velocità.**

- **`X-Stavros-Token`** è un header HTTP che `tools/gui/app.js` invia e `test-cc-routes.js` /
  `test-cc-server.js` verificano. Come per le env var, si **accetta il vecchio e si emette il nuovo**
  per una release: un client già aperto su una versione precedente del server non deve ricevere 403
  senza spiegazione.
- **`STAVROS-MARKER` e `StavrosReproducer/1.0` sono prova, non branding.** Il marker benigno serve ad
  attribuire un'esecuzione al nostro artefatto, e il User-Agent del PoC finisce nei log del target.
  Rinominarli rende non più riconoscibili le evidenze degli engagement **già chiusi**. Restano com'e-
  sono finché l'operatore non decide se emettere entrambi (nuovo marker + vecchio riconosciuto) o
  accettare la rottura della continuità.
- **`hermes-stavros` è una cartella sul telefono e un fork sul PC** (`/home/stavros/.hermes-stavros/profiles/`,
  `rsync` PC → device in `tools/f3-client-setup.sh`). Rinominarla qui senza rinominarla là rompe il
  canale F3 al primo `rsync`.
- **`f3-stavros` è il commento della chiave SSH** con cui il device riconosce il PC
  (`ssh-keygen -F f3-stavros`): sui device già provisionati la chiave è in `authorized_keys` con quel
  commento, e cambiarlo fa fallire il provisioning in modo silenzioso.
- **`99-stavros-unprivileged-ports.conf` è un file in `/etc/sysctl.d/`** già creato su ogni macchina
  che ha girato `capcheck`: rinominarlo in `tools/cap-manifest.json` lascia il vecchio file al suo
  posto e il manifest che punta a un path inesistente.

**Regola:** nessuna famiglia si rinomina prima di avere una riga in questa tabella. Le cinque voci
marcate *operatore* o *rimandato* si eseguono in F5, e il loro `--check` è la prova end-to-end del
§9 della spec, non un grep.

---

## Task 1: F1 — `package.json` e i template di issue

**Files:**
- Modify: `package.json`
- Modify: `.github/ISSUE_TEMPLATE/config.yml`, `.github/ISSUE_TEMPLATE/bug_report.yml`,
  `.github/ISSUE_TEMPLATE/feature_request.yml`
- Test: `node tools/test-repo-invariants.js` (gate esistente), `npm test`

**Interfaces:**
- Consumes: §0 (mappatura).
- Produces: il nome npm `cyboros-harness` e gli URL nuovi, che F4 (SARIF `informationUri`) e F5
  (README, citazione) useranno.

- [x] **Step 1: Sostituire nome, URL e descrizione in `package.json`**

`name` → `cyboros-harness`; `repository.url` → `git+https://github.com/CSI-entitymorton/cyboros-harness.git`;
`bugs.url` → `https://github.com/CSI-entitymorton/cyboros-harness/issues`;
`homepage` → `https://github.com/CSI-entitymorton/cyboros-harness#readme`;
`description` → aggiungere la chiusura dell'anello dopo la frase esistente:

```json
"description": "A penetration-testing harness where a finding is only a finding if code can prove it: policy enforced in the runtime, severity capped by evidence, and lessons from one engagement carried into the next. Zero dependencies, offline-capable.",
```

`bin` **non si tocca in questo task** (F2): il repo si presenta come Cyboros mentre si invoca ancora
come `stavros`.

- [x] **Step 2: Sostituire gli URL nei tre template**

```bash
patch_live 'https://github\.com/CSI-entitymorton/stavrosredteamer' 'https://github.com/CSI-entitymorton/cyboros-harness'
```

- [x] **Step 3: Verificare che nessun URL vecchio resti nei template**

Run: `grep -rn "stavrosredteamer" .github/ || echo "pulito"`
Expected: `pulito`

- [x] **Step 4: Aggiornare il conteggio dei test nel README se è cambiato**

Non cambia (nessun test aggiunto). Verifica comunque:
Run: `node tools/test-repo-invariants.js`
Expected: exit 0.

- [x] **Step 5: Commit**

```bash
git add package.json .github/
git commit -m "docs(brand): il repository si presenta come Cyboros Harness"
```

---

## Task 2: F1 — README

**Files:**
- Modify: `README.md`
- Test: `node tools/test-repo-invariants.js` (i quattro numeri), `node tools/docs-index.js --check`

**Interfaces:**
- Consumes: nome e URL del Task 1.
- Produces: il testo di intestazione (`# Cyboros Harness`) che il Task 15 (invariante) pretenderà
  pulito; la frase-di-tesi che F4 (Task 12) estende all'ouroboros.

- [x] **Step 1: Sostituire titolo, tagline e URL**

**Ambito esplicito, non un `patch_live` globale.** Misurato: `StavrosRedTeamer` compare in **57 file
vivi** (di cui 6 in F1), e una patch senza ambito rinominerebbe `AGENTS.md` (che è di F5), i 28 agenti (F3), i
`.desktop` e `tools/app/**` (Task 6), e `tools/report-sarif.js` — il cui `driver.name` deve cambiare
**con il suo test** (Task 9), perché `test-report-sarif.js:50` lo asserisce: rinominarlo qui renderebbe
la suite rossa in F1, il cui criterio di done è `npm test` verde.

```bash
# I file di F1: il README, il generatore della mappa (che rende il titolo), i due documenti vivi
# che nominano il prodotto, e il testo di licenza.
F1="README.md tools/project-map.js SECURITY.md LICENSE docs/THREAT-MODEL.md docs/command-center-desktop.md"
grep -l 'StavrosRedTeamer' $F1 2>/dev/null   # dry run: cosa cambierebbe davvero
sed -i 's|StavrosRedTeamer|Cyboros Harness|g' $F1
sed -i 's|github\.com/CSI-entitymorton/stavrosredteamer|github.com/CSI-entitymorton/cyboros-harness|g' $F1
```

Il dry run è un passo, non una formalità: se nomina un file che non è di F1, quello è un task che si
sta allargando.

**`LICENSE:189`** contiene `Copyright 2026 StavrosRedTeamer contributors`: rinominarlo in `Cyboros
Harness contributors`, come deciso — **non cambia il titolare** (sono «i contributori», non una
persona) ed evita che un testo legale nomini un progetto che non esiste più.

`docs/system-prompt-dump.md` è un **dump di un prompt assemblato** — una fotografia, al pari di una
ricevuta — e il suo titolo nomina il nome vecchio: va in `REBRAND_ALLOWLIST` con il motivo, non
riscritto, perché un dump riscritto non è più una prova di cosa diceva il prompt.

- [x] **Step 2: Sostituire i riferimenti all'operatore e alle etichette di prodotto**

```bash
patch_live 'Stavros (Console|Radar|Doctor)' 'Cyboros \1'
```

I comandi del README **restano `node tools/stavros.js …`** in questo task: il binario cambia in F2,
e un README che insegna un comando inesistente è un rosso per chi clona.

- [x] **Step 3: Verificare che i quattro numeri dichiarati siano ancora veri**

Run: `node tools/test-repo-invariants.js`
Expected: exit 0. Se fallisce su `README dichiara N moduli`, il colpevole è un nome di modulo
cambiato in prosa: correggere la prosa, non il numero.

- [x] **Step 4: Rigenerare gli artefatti dipendenti e verificare**

Run:
```bash
node tools/docs-index.js && node tools/project-map.js && \
node tools/docs-index.js --check && node tools/project-map.js --check
```
Expected: exit 0, nessun output di errore.

- [x] **Step 5: Commit**

```bash
git add README.md docs/INDEX.md docs/project-map.html
git commit -m "docs(brand): README e indice sotto il nome Cyboros Harness"
```

---

## Task 3: F2 — `git mv` del motore e del suo test

**Files:**
- Rename: `tools/stavros.js` → `tools/cyboros.js`
- Rename: `tools/test-stavros.js` → `tools/test-cyboros.js`
- Modify: `tools/test-cyboros.js:4` (header), `tools/test-repo-vet.js` (`require('./stavros')`)
- Test: `tools/test-cyboros.js`, `tools/test-lint.js` (require morto), `npm test`

**Interfaces:**
- Consumes: niente (il modulo esporta la stessa superficie di prima).
- Produces: `require('./cyboros')` come unico nome del motore deterministico; il Task 4 ci punterà i
  cinque `bin`.

- [x] **Step 1: Spostare i due file conservando la storia**

```bash
git mv tools/stavros.js tools/cyboros.js
git mv tools/test-stavros.js tools/test-cyboros.js
```

- [x] **Step 2: Aggiornare i require e i riferimenti al path**

```bash
git ls-files | xargs -r grep -lnE "require\('\./stavros'\)|tools/stavros\.js|test-stavros\.js" -- \
  | grep -vE '^(CHANGELOG\.md|docs/archive/|docs/superpowers/(plans|specs)/)' \
  | xargs -r sed -i -E "s|require\('\./stavros'\)|require('./cyboros')|g; s|tools/stavros\.js|tools/cyboros.js|g; s|test-stavros\.js|test-cyboros.js|g"
```

Attesi: `tools/test-cyboros.js`, `tools/test-repo-vet.js`, `tools/analyze-bundle.js`,
`tools/mobile.js`, `tools/proc-registry.js`, `tools/testkit.js`, `tools/test-wifi.js`,
`tools/wifi.js`.

- [x] **Step 3: Verificare che il test del motore giri sotto il nome nuovo**

Run: `node tools/test-cyboros.js`
Expected: PASS, exit 0.

- [x] **Step 4: Verificare che nessun require punti a un file non tracciato**

Run: `node tools/test-lint.js`
Expected: exit 0 (è il gate che ha già preso un `require` morto in passato).

- [x] **Step 5: Aggiornare i numeri se il conteggio dei test è cambiato**

Run: `npm test`
Expected: exit 0. Se `test-repo-invariants` nomina un conteggio, il numero non è cambiato (rename,
non aggiunta) — quindi un fallimento qui significa un file di troppo o in meno: indagare prima di
toccare il README.

- [x] **Step 6: Commit**

```bash
git add -A tools/
git commit -m "refactor(engine): il motore deterministico si chiama cyboros"
```

---

## Task 4: F2 — i cinque `bin` e le etichette di prodotto

**Files:**
- Modify: `package.json` (`bin`)
- Modify: gli header dei moduli che dicono "Stavros harness" e le etichette mostrate
  (`tools/doctor.js`, `tools/gen-bench.js`, `tools/radar*.js`, `tools/gui/*`, `tools/gui-server.js`)
- Test: `node tools/test-repo-invariants.js`, i cinque binari invocati a mano

**Interfaces:**
- Consumes: `tools/cyboros.js` (Task 3).
- Produces: `node tools/cyboros.js status` funzionante — è la riga che F5 (§9 della spec) userà come
  prova end-to-end.

- [x] **Step 1: Rinominare i `bin`**

```json
"bin": {
  "cyboros": "tools/cyboros.js",
  "cyboros-doctor": "tools/doctor.js",
  "cyboros-record-finding": "tools/record-finding.js",
  "cyboros-gen-bench": "tools/gen-bench.js",
  "cyboros-mcp-guard-proxy": "tools/mcp-guard-proxy.js"
}
```

- [x] **Step 2: Rinominare le etichette di prodotto e la prosa degli header**

```bash
patch_live 'Stavros (Console|Radar|Doctor|harness)' 'Cyboros \1'
patch_live '\bStavros\b' 'Cyboros'
```

L'ultima riga è volutamente larga: in F2 deve restare senza corrispondenze **solo** l'anello
storico e i file generati. Un colpo d'occhio:

```bash
git grep -nIE '\bstavros' -- ':!CHANGELOG.md' ':!docs/archive' ':!docs/superpowers' ':!docs/INDEX.md' ':!docs/project-map.html' ':!piano-ottimizzazione-stavros.md' | head -40
```

Ogni riga che resta e non è `STAVROS_*` (Task 5) è un residuo da chiudere qui.

- [x] **Step 3: Verificare che i cinque binari rispondano**

Run:
```bash
node tools/cyboros.js status >/dev/null && \
node tools/doctor.js --check >/dev/null; echo "doctor exit $?"
```
Expected: `cyboros.js status` exit 0. `doctor` può uscire 1 (binari di terze parti assenti su questa
macchina) — è atteso e non è un fallimento; **≥ 2** sarebbe un guasto dei cardini.

- [x] **Step 4: Rigenerare la mappa e verificare**

Run: `node tools/project-map.js && node tools/project-map.js --check && npm test`
Expected: exit 0.

- [x] **Step 5: Commit**

```bash
git add package.json tools/ docs/INDEX.md docs/project-map.html
git commit -m "refactor(cli): i binari passano a cyboros-*"
```

---

## Task 5: F2 — le variabili d'ambiente `STAVROS_*` → `CYBOROS_*`

**Perché è un task a sé.** 36 nomi distinti, 191 occorrenze, 62 file: è un'interfaccia verso
l'operatore allo stesso titolo dei `bin`, e **non era nella mappatura della spec** — trovata durante
la stesura di questo piano. Lasciarla fuori significherebbe un buco nell'invariante proprio nel
punto in cui la spec ha detto di non farne.

**Files:**
- Create: `tools/env.js`
- Create: `tools/test-env.js`
- Modify: i 62 file che leggono `process.env.STAVROS_*` (il gate li elenca)
- Test: `tools/test-env.js`

**Interfaces:**
- Consumes: niente.
- Produces: `const { env } = require('./env')` → `env('TMP', defaultPath)`. Ogni call site diventa
  `env('TMP')`, e il fallback `STAVROS_TMP` resta leggibile per una release.

- [x] **Step 1: Scrivere il test che fallisce**

```js
#!/usr/bin/env node
// test-tags: offline
const assert = require('assert/strict');
const { ok, summary } = require('./testkit');

function fresh() {
  // Il modulo legge process.env a ogni chiamata: nessuna cache da invalidare, ma il require
  // deve essere ripreso dopo aver manipolato l'ambiente del processo.
  delete require.cache[require.resolve('./env')];
  return require('./env');
}

ok('CYBOROS_* vince su STAVROS_*', () => {
  process.env.CYBOROS_DEMO = 'nuovo';
  process.env.STAVROS_DEMO = 'vecchio';
  const { env } = fresh();
  assert.equal(env('DEMO'), 'nuovo');
  delete process.env.CYBOROS_DEMO; delete process.env.STAVROS_DEMO;
});

ok('STAVROS_* resta leggibile come deprecazione', () => {
  process.env.STAVROS_DEMO = 'vecchio';
  const { env } = fresh();
  assert.equal(env('DEMO'), 'vecchio');
  delete process.env.STAVROS_DEMO;
});

ok('assente del tutto: torna il default, e stringa vuota vale assente', () => {
  const { env } = fresh();
  assert.equal(env('DEMO', 'dflt'), 'dflt');
  process.env.CYBOROS_DEMO = '';
  assert.equal(env('DEMO', 'dflt'), 'dflt');
  delete process.env.CYBOROS_DEMO;
});

summary('test-env');
```

- [x] **Step 2: Eseguirlo e verificare che fallisca**

Run: `node tools/test-env.js`
Expected: FAIL con `Cannot find module './env'`.

- [x] **Step 3: Scrivere il modulo**

```js
#!/usr/bin/env node
// env.js — un solo posto per le variabili d'ambiente dell'harness.
//
// Il prefisso è passato da STAVROS_ a CYBOROS_ il 2026-10-13. Un operatore che ha già esportato
// STAVROS_TMP in shell, o un'unità di sistema che lo passa, non deve perdere il valore in
// silenzio: un env var caduto non produce un errore visibile, produce report scritti altrove.
// Quindi per una release CYBOROS_X è preferito e STAVROS_X resta letto.
'use strict';

// Nome senza prefisso: env('TMP') legge CYBOROS_TMP, poi STAVROS_TMP.
function env(name, dflt) {
  const v = process.env['CYBOROS_' + name] ?? process.env['STAVROS_' + name];
  return v === undefined || v === '' ? dflt : v;
}

module.exports = { env };
```

- [x] **Step 4: Eseguirlo e verificare che passi**

Run: `node tools/test-env.js`
Expected: PASS, exit 0.

- [x] **Step 5: Migrare i call site**

```bash
git ls-files | grep '\.js$' | grep -vE '^(CHANGELOG\.md|docs/|reports/|temp/)' \
  | xargs -r grep -l 'process\.env\.STAVROS_\|process\.env\[.STAVROS_' -- > /tmp/env-sites.txt
wc -l /tmp/env-sites.txt
```

Per ogni file elencato: aggiungere `const { env } = require('./env');` (path relativo corretto:
`./env` da `tools/`, `../tools/env` da `local/`), poi sostituire

- `process.env.STAVROS_X` → `env('X')`
- `process.env['STAVROS_X']` → `env('X')`

Attenzione a **non** toccare `tools/env.js` stesso (è l'unico posto dove il prefisso vecchio deve
restare) e ai siti dentro le stringhe di shell/heredoc in `tools/f3-client-setup.sh`,
`grant-tool-caps.sh`, `local/run-local.js`, `local/chat-local.js`: lì la sostituzione è
`STAVROS_X` → `${CYBOROS_X:-${STAVROS_X:-}}` quando il valore è un path opzionale, oppure
`CYBOROS_X` quando è la nostra unità di sistema che lo esporta (quelle in `ops/`).

- [x] **Step 6: Verificare che il vecchio prefisso sopravviva solo nel fallback**

Run:
```bash
git grep -nI 'STAVROS_' -- ':!tools/env.js' ':!CHANGELOG.md' ':!docs/archive' ':!docs/superpowers' ':!docs/INDEX.md' ':!piano-ottimizzazione-stavros.md' | head -20
```
Expected: nessuna riga. Ogni riga residua è un call site non migrato.

- [x] **Step 7: Aggiornare i numeri del README e la documentazione dei flag**

`tools/env.js` è un modulo nuovo (+1) e `tools/test-env.js` un test nuovo (+1): aggiornare i due
numeri nel README. Documentare la finestra di deprecazione in `docs/toolbox.md` e in una voce nuova
di `CHANGELOG.md`.

- [x] **Step 8: Verificare**

Run: `npm test`
Expected: exit 0, con i due numeri del README aggiornati.

- [x] **Step 9: Commit**

```bash
git add tools/env.js tools/test-env.js tools/ local/ docs/ README.md CHANGELOG.md
git commit -m "refactor(env): CYBOROS_* sostituisce STAVROS_*, con il vecchio prefisso in fallback"
```

---

## Task 6: F2 — il nome vecchio nel nome dei file: launcher, sistema, icona

**Files:**
- Rename: `stavros-cc` → `cyboros-cc`, `stavros-cc.desktop` → `cyboros-cc.desktop`,
  `stavros-command-center.desktop` → `cyboros-command-center.desktop`,
  `stavros-freebuff.desktop` → `cyboros-freebuff.desktop`,
  `tools/app/stavros-cc.service` → `tools/app/cyboros-cc.service`,
  `tools/app/icons/stavros-cc.svg` → `tools/app/icons/cyboros-cc.svg`
- Modify: `install-launcher.sh`, `install-scc-launcher.sh`, `install-command-center-launcher.sh`,
  `install-local-agent-launcher.sh`, `scripts/demo-command-center.sh`, `tools/app/*.py`,
  `ops/radar.service`, `ops/radar.timer`, `ops/install-radar-timer.sh`
- Test: `node tools/test-repo-invariants.js`, `npm test`

**Interfaces:**
- Consumes: §0; il preposto `cyboros-` fissato in F1–F2.
- Produces: un solo prefisso `cyboros-` per ogni artefatto installabile (`scc` non sopravvive).

- [x] **Step 1: Rinominare gli artefatti**

```bash
git mv stavros-cc cyboros-cc
git mv stavros-cc.desktop cyboros-cc.desktop
git mv stavros-command-center.desktop cyboros-command-center.desktop
git mv stavros-freebuff.desktop cyboros-freebuff.desktop
git mv tools/app/stavros-cc.service tools/app/cyboros-cc.service
git mv tools/app/icons/stavros-cc.svg tools/app/icons/cyboros-cc.svg
```

- [x] **Step 2: Aggiornare i riferimenti (incluso `scc`)**

```bash
patch_live '\bscc\b' 'cyboros-cc'
patch_live '\bstavros-cc\b' 'cyboros-cc'
patch_live 'install-scc-launcher\.sh' 'install-cyboros-cc-launcher.sh'
git mv install-scc-launcher.sh install-cyboros-cc-launcher.sh
```

- [x] **Step 3: Verificare che il servizio sia coerente con il file spostato**

Run:
```bash
grep -n "ExecStart\|cyboros-cc" tools/app/cyboros-cc.service ops/radar.service
```
Expected: ogni `ExecStart` punta a un file esistente (`test -x` su ciascuno).

- [x] **Step 4: Verificare**

Run: `npm test`
Expected: exit 0.

- [x] **Step 5: Commit**

```bash
git add -A .
git commit -m "refactor(launcher): un solo prefisso cyboros- per gli artefatti installabili"
```

---

## Task 7: F2 — `session-prompt-autostavros.md` e la skill `autostavros`

**Perché è un task a sé.** `autostavros` non è `stavros-*`: è una skill invocata per nome
(`/skill:autostavros`) e un file di prompt che la nomina. Un rename parziale qui rompe l'autopilot
senza che nessun gate se ne accorga — l'invariante di flotta conta i blocchi canonici, non i nomi
delle skill.

**Files:**
- Rename: `.agents/skills/autostavros/` → `.agents/skills/cyboros-autopilot/`,
  `skills/autostavros/` → `skills/cyboros-autopilot/`,
  `session-prompt-autostavros.md` → `session-prompt-cyboros-autopilot.md`
- Modify: frontmatter `name:` e titolo della skill, ogni riferimento a `/skill:autostavros`
- Test: `npm test`, e l'invocazione documentata

**Interfaces:**
- Consumes: §0.
- Produces: `name: cyboros-autopilot` come unico nome della skill.

- [x] **Step 1: Spostare skill e prompt**

```bash
git mv .agents/skills/autostavros .agents/skills/cyboros-autopilot
git mv skills/autostavros skills/cyboros-autopilot
git mv session-prompt-autostavros.md session-prompt-cyboros-autopilot.md
```

- [x] **Step 2: Rinominare l'identificatore della skill e la prosa**

```bash
patch_live '\bautostavros\b' 'cyboros-autopilot'
patch_live 'Autopilot Stavros' 'Cyboros Autopilot'
```

- [x] **Step 3: Verificare che nome e percorso combacino**

Run:
```bash
grep -n "^name:" .agents/skills/cyboros-autopilot/SKILL.md skills/cyboros-autopilot/SKILL.md
grep -n "cyboros-autopilot" session-prompt-cyboros-autopilot.md
```
Expected: entrambe le skill dichiarano `name: cyboros-autopilot`; il prompt la nomina come
`/skill:cyboros-autopilot`.

- [x] **Step 4: Notare la duplicazione (non risolverla qui)**

`piano-ottimizzazione-stavros.md:79` registra che le due copie della skill sono identiche e che va
deciso quale percorso carica Freebuff (DECISION POINT 1). Il rename le porta entrambe al nome nuovo
**senza** risolvere la duplicazione: è una decisione dell'operatore, e non appartiene a un rename.

- [x] **Step 5: Verificare**

Run: `npm test`
Expected: exit 0.

- [x] **Step 6: Commit**

```bash
git add -A .
git commit -m "refactor(agents): la skill autopilot si chiama cyboros-autopilot"
```

---

## Task 8: F3 — la flotta (28 agenti + root)

**Files:**
- Rename: `local/fleet/stavros-*.ts` (28 file) → `local/fleet/cyboros-*.ts`; `stavros.ts` →
  `cyboros.ts`
- Rename: `.agents/stavros-root.ts` → `.agents/cyboros-root.ts`
- Modify: gli `id:` interni, `local/README-local.md`, i riferimenti in `ops/`, `knowledge.md`
- Test: l'invariante di flotta (`id unici`, `spawnableAgents` risolvibili), `npm test`

**Interfaces:**
- Consumes: §0.
- Produces: id di flotta `cyboros*`; il Task 15 (invariante) si aspetta `.agents/cyboros-root.ts`.

- [x] **Step 1: Spostare i 28 file e il root, in un colpo solo**

```bash
for f in $(git ls-files local/fleet | grep -E 'stavros'); do
  git mv "$f" "$(echo "$f" | sed 's|/stavros|/cyboros|')"
done
git mv .agents/stavros-root.ts .agents/cyboros-root.ts
```

- [x] **Step 2: Rinominare gli `id` e le stringhe identificatrici dentro gli agenti**

```bash
patch_live '\bstavros-' 'cyboros-'
patch_live "'stavros'" "'cyboros'"
patch_live '\bStavros\b' 'Cyboros'
```

`spawnableAgents` cita gli id: se un id è rinominato e un riferimento no, l'invariante di flotta lo
dice per nome.

- [x] **Step 3: Verificare che gli id risolvano**

Run: `node tools/test-repo-invariants.js`
Expected: exit 0. Un fallimento nomina `${where}: spawnableAgents referenzia 'X', che non esiste` —
correggere il riferimento, non il nome.

- [x] **Step 4: Verificare l'aderenza al binario Freebuff**

Run: `node tools/vet-agents-vs-freebuff.js`
Expected: exit 0 (o SKIP esplicito se il binario non è installato — il vet è un pre-flight locale).

- [x] **Step 5: Verificare che la flotta conti ancora 28 file**

Run: `ls local/fleet/*.ts | wc -l`
Expected: `28`. Un numero diverso significa un `git mv` perso o un file duplicato.

- [x] **Step 6: Commit**

```bash
git add -A .
git commit -m "refactor(fleet): i 28 agenti e il root si chiamano cyboros"
```

---

## Task 9: F4 — il formato dati: `properties.cyboros`

**Files:**
- Modify: `tools/report-sarif.js` (`toResult`, `buildSarif`), `tools/portal.js`
  (`stavrosFindingId`)
- Modify: `tools/test-report-sarif.js`
- Modify: `tools/gen-poc.js` (User-Agent del reproducer), `tools/payloads/upload-bypass/gen-polyglot-jpeg.js`
  (default del marker), `tools/payloads/upload-bypass/README.md` (nota di compatibilità)
- Modify: `docs/toolbox.md`, `docs/TOOL-ALTERNATIVES-AUDIT.md:193`
- Test: `tools/test-report-sarif.js`

**Interfaces:**
- Consumes: `fingerprint()` (esistente, invariata).
- Produces: `runs[0].results[i].properties.cyboros` e `…invocations[0].properties.cyboros`;
  `partialFingerprints.cyborosFindingId`; `tool.driver.name = 'Cyboros Harness'`. Le chiavi
  `stavros`/`stavrosFindingId` restano emesse per una release. Sul filo verso il target, il nuovo
  `CyborosReproducer/1.0` e il nuovo `CYBOROS-MARKER`, con il vecchio marker ancora riconoscibile
  nella nota di compatibilità.

- [x] **Step 1: Estendere il test perché pretenda entrambe le chiavi**

In `tools/test-report-sarif.js`, sostituire l'assert su `properties.stavros` e aggiungere:

```js
ok('il sacco delle proprietà è emesso sotto entrambe le chiavi, con lo stesso contenuto', () => {
  const doc = buildSarif([finding({ verify_level: 'triggered', severity: 'Medium' })], {});
  const r = doc.runs[0].results[0].properties;
  assert.deepEqual(r.cyboros, r.stavros);            // il consumatore vecchio non perde nulla
  assert.equal(r.cyboros.verify_level, 'triggered');
  assert.equal(r.cyboros.severity_ceiling, 'Medium');
  const inv = doc.runs[0].invocations[0].properties;
  assert.deepEqual(inv.cyboros, inv.stavros);
  assert.equal(inv.cyboros.severity_bounded_by_evidence, true);
});

ok('driver e fingerprint usano il nome nuovo, e il vecchio resta per una release', () => {
  const doc = buildSarif([finding({})], {});
  assert.equal(doc.runs[0].tool.driver.name, 'Cyboros Harness');
  assert.equal(doc.runs[0].tool.driver.informationUri, 'https://github.com/CSI-entitymorton/cyboros-harness');
  const fp = doc.runs[0].results[0].partialFingerprints;
  assert.equal(fp.cyborosFindingId, fp.stavrosFindingId);
});
```

- [x] **Step 2: Eseguirlo e verificare che fallisca**

Run: `node tools/test-report-sarif.js`
Expected: FAIL — `properties.cyboros` è `undefined`.

- [x] **Step 3: Implementare l'emissione doppia**

In `toResult()`, la riga finale diventa:

```js
    // Due chiavi per una release: `cyboros` è il nome nuovo, `stavros` resta emesso perché un
    // consumatore terzo (GitHub code scanning, DefectDojo) già cablato su quella chiave non perda
    // in silenzio il verify_level e il tetto di severità — che sono l'unica cosa che un
    // consumatore generico non può dedurre. Deprecazione: una release, con la nota in CHANGELOG.
    partialFingerprints: { cyborosFindingId: fingerprint(f), stavrosFindingId: fingerprint(f) },
    properties: { cyboros: props, stavros: props },
```

In `buildSarif()`, il driver e l'invocazione:

```js
      name: 'Cyboros Harness',
      version: require('../package.json').version,
      informationUri: 'https://github.com/CSI-entitymorton/cyboros-harness',
```

```js
        shortDescription: { text: f.class ? `Cyboros vulnerability class: ${f.class}` : (f.cwe || 'unclassified') },
```

```js
        properties: {
          cyboros: inv,
          stavros: inv,
        },
```

dove `inv` è l'oggetto oggi scritto inline (`findings_total`, `findings_emitted`, `findings_refused`,
`refused`, `severity_bounded_by_evidence`): estrarre la costante una volta sola per non duplicare la
verità.

- [x] **Step 4: Eseguire il test e il CLI**

Run:
```bash
node tools/test-report-sarif.js && \
node tools/report-sarif.js --findings /dev/null --out - | grep -c '"cyboros"'
```
Expected: PASS, exit 0; il grep conta ≥ 2 (una per il result, una per l'invocation) su un file vuoto
resta 1 (solo l'invocation) — il punto è che il comando non esploda.

- [x] **Step 5: I marcatori di evidenza (decisione: emettere entrambi)**

`STAVROS-MARKER` serve ad attribuire un'esecuzione al nostro artefatto e `StavrosReproducer/1.0` è lo
User-Agent del PoC: entrambi **finiscono nei log del target**. Il codice nuovo emette il nome nuovo e
le evidenze già chiuse restano riconoscibili con il vecchio.

```js
// tools/gen-poc.js — il User-Agent del reproducer
    req.add_header('User-Agent', 'CyborosReproducer/1.0')
```

```js
// tools/payloads/upload-bypass/gen-polyglot-jpeg.js — il marker benigno
  const marker = String(opts.marker || 'CYBOROS-MARKER').replace(/[\r\n]/g, '');
```

In `tools/payloads/upload-bypass/README.md` la frase va riscritta per dire **entrambi**: il marker è
`CYBOROS-MARKER`, e le run antecedenti al 2026-10-13 usavano `STAVROS-MARKER`, quindi si cerca l'uno
o l'altro. Quella nota è l'unico posto dove la stringa vecchia sopravvive in superficie viva, ed è già
in `REBRAND_ALLOWLIST` con il motivo (Task 14).

- [x] **Step 6: Documentare la finestra**

`docs/toolbox.md` e `docs/TOOL-ALTERNATIVES-AUDIT.md:193` nominano il sacco in inglese per un lettore
esterno: aggiornarli a `properties.cyboros` con una riga che dice che `properties.stavros` è emesso
ancora per una release. Voce nuova di `CHANGELOG.md`.

- [x] **Step 7: Commit**

```bash
git add tools/report-sarif.js tools/test-report-sarif.js tools/portal.js tools/gen-poc.js \
  tools/payloads/ docs/ CHANGELOG.md
git commit -m "feat(format): properties.cyboros e i marcatori di prova sotto il nome nuovo"
```

---

## Task 10: F4 — `docs/OUROBOROS.md` e il test che lo àncora

**Files:**
- Create: `docs/OUROBOROS.md`
- Create: `tools/test-ouroboros-doc.js`
- Test: `tools/test-ouroboros-doc.js`

**Interfaces:**
- Consumes: i sei artefatti già nel repo (`tools/memory-recall.js`, `tools/retrieval-budget.js`,
  `tools/coverage-loop.js`, `tools/next-actions.js`, `tools/radar.js`, `tools/gen-bench.js`,
  `tools/autopilot.js`, `memory/`).
- Produces: la pagina del tema; il Task 12 la cita dal README.

- [x] **Step 1: Scrivere il test che fallisce**

```js
#!/usr/bin/env node
// test-tags: offline
// docs/OUROBOROS.md sostiene che il claim "autoevolvente" è vero perché ogni sua affermazione
// punta a un artefatto del repo. Un test che non lo verifica lascerebbe il documento libero di
// raccontare capacità che nessuno ha: lo stesso peccato che record-finding.js rifiuta nei finding,
// applicato alla comunicazione.
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { ok, summary } = require('./testkit');

const ROOT = path.join(__dirname, '..');
const DOC = path.join(ROOT, 'docs', 'OUROBOROS.md');

ok('ogni artefatto citato dalla pagina esiste davvero', () => {
  const doc = fs.readFileSync(DOC, 'utf8');
  const missing = [];
  let claimed = 0;
  for (const line of doc.split('\n')) {
    if (!line.trim().startsWith('|')) continue;
    for (const m of line.matchAll(/`([^`]+)`/g)) {
      const p = m[1].trim().replace(/\/$/, '');
      // Solo percorsi: niente prosa fra backtick, niente nomi di flag o moduli senza cartella.
      if (!/^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.*-]+)+$/.test(p)) continue;
      claimed++;
      if (!fs.existsSync(path.join(ROOT, p))) missing.push(p);
    }
  }
  assert.ok(claimed >= 6,
    `la pagina nomina ${claimed} artefatti: la tabella dei claim si è svuotata`);
  assert.deepStrictEqual(missing, [],
    'claim senza artefatto (o percorso sbagliato): ' + missing.join(', '));
});

ok('il ciclo è dichiarato nei suoi passi', () => {
  const doc = fs.readFileSync(DOC, 'utf8');
  for (const step of ['lezione', 'ipotesi', 'run', 'misura']) {
    assert.ok(new RegExp(step, 'i').test(doc), `il ciclo non nomina il passo "${step}"`);
  }
});

summary('test-ouroboros-doc');
```

- [x] **Step 2: Eseguirlo e verificare che fallisca**

Run: `node tools/test-ouroboros-doc.js`
Expected: FAIL con `ENOENT … docs/OUROBOROS.md`.

- [x] **Step 3: Scrivere `docs/OUROBOROS.md`**

Struttura richiesta (i percorsi devono esistere, il test lo verifica):

```markdown
# L'anello — perché questo harness si chiama Cyboros

**Cyboros** = cyber + ouroboros. La metafora è vera qui perché è già nel codice: l'harness
chiude il cerchio su sé stesso, e la lezione di un engagement cambia il successivo. Questa
pagina esiste per rendere quella frase **verificabile**: ogni riga della tabella qui sotto
nomina l'artefatto che la sostiene, e `tools/test-ouroboros-doc.js` fallisce se un file
nominato non esiste.

## Il ciclo

`lezione` → `ipotesi` → `run` → `misura` → `lezione`

1. **Lezione.** `memory/` accumula technique→outcome sanificati tra engagement. Il sanitizer
   rifiuta host in-scope, email, token e credenziali: una lezione che portasse fuori il
   contesto di un cliente sarebbe un incidente, non un miglioramento.
2. **Ipotesi.** `tools/next-actions.js` e `tools/coverage-loop.js` leggono cosa manca
   (copertura incompleta, classe non testata, finding senza verifica) e ne fanno il piano
   della sessione.
3. **Run.** `tools/autopilot.js` + `tools/autopilot-checkpoint.js` eseguono il piano senza
   operatore, con stop garantiti (DONE/BARRIER/BUDGET/STUCK) e checkpoint riprendibili.
4. **Misura.** `tools/gen-bench.js` scrive ogni run in `reports/bench-history.jsonl` con seed,
   agente e modello: senza quei tre, una percentuale non è un risultato. `tools/radar.js`
   cerca capacità nuove (tool, tecniche, riferimenti) quando la misura dice che il ciclo è
   fermo.

## Cosa sostiene ogni affermazione

| affermazione | artefatto che la prova |
|---|---|
| la lezione di un engagement non si perde | `memory/` + il sanitizer |
| la lezione rientra in contesto a budget fisso | `tools/memory-recall.js`, `tools/retrieval-budget.js` |
| l'harness sa cosa gli manca | `tools/coverage-loop.js`, `tools/next-actions.js` |
| l'harness cerca capacità nuove da solo | `tools/radar.js`, `tools/radar-scout.js` |
| l'harness misura se è migliorato | `tools/gen-bench.js`, `reports/bench-history.jsonl` |
| l'harness si esercita senza operatore | `tools/autopilot.js`, `tools/autopilot-checkpoint.js` |

## Il limite, dichiarato

L'anello non è un agente che riscrive sé stesso. È un ciclo **guidato dall'operatore**: la
lezione entra in contesto, l'ipotesi la propone il piano, la misura è un benchmark che gira
offline. Nessuna capacità nuova nasce senza una review umana — `tools/radar.js` propone,
l'operatore approva. Il nome dice "si morde la coda"; il codice dice "chiude il ciclo, con
un umano sul bordo". Questa è la versione vera.
```

- [x] **Step 4: Eseguirlo e verificare che passi**

Run: `node tools/test-ouroboros-doc.js`
Expected: PASS, exit 0. Se fallisce su un percorso, il percorso nella pagina è sbagliato: correggere
la pagina.

- [x] **Step 5: Aggiornare i numeri e rigenerare l'indice**

`tools/test-ouroboros-doc.js` è un test nuovo: aggiornare il conteggio dei test nel README. Poi
`node tools/docs-index.js && node tools/docs-index.js --check` (la nuova pagina entra nell'indice).

- [x] **Step 6: Verificare**

Run: `npm test`
Expected: exit 0.

- [x] **Step 7: Commit**

```bash
git add docs/OUROBOROS.md tools/test-ouroboros-doc.js docs/INDEX.md README.md
git commit -m "docs(brand): la pagina dell'anello, e il test che la ancora agli artefatti"
```

---

## Task 11: F4 — README: il tema diventa la tesi

**Files:**
- Modify: `README.md`
- Test: `node tools/test-repo-invariants.js`, `node tools/docs-index.js --check`

**Interfaces:**
- Consumes: `docs/OUROBOROS.md` (Task 10).
- Produces: la frase di tesi che F5 non tocca più.

- [x] **Step 1: Aprire il README con il nome del tema, non con l'origine**

Nel blocco centrale, dopo la riga del titolo, sostituire l'attuale tesi con una che nomini l'anello e
lo agganci alla pagina appena scritta (il link deve essere relativo: `docs/OUROBOROS.md`):

```markdown
**A penetration-testing harness where a finding is only a finding if code can prove it —
and where the lesson of one engagement changes the next.**

[Apache-2.0](LICENSE) · zero dependencies · offline-capable · 114 tests, hermetic and parallel

[Cyboros](docs/OUROBOROS.md): cyber + ouroboros. The loop is not marketing — every claim on
that page names the file that proves it.
```

Il numero `114 tests` è un esempio: va messo quello che `node tools/test-repo-invariants.js` accetta
(nomina lui il valore corretto se è sbagliato).

- [x] **Step 2: Far puntare alla pagina dell'anello dalla sezione Documentation**

Aggiungere in cima all'elenco dei link:

```markdown
- [`docs/OUROBOROS.md`](docs/OUROBOROS.md) — the loop, and the artifact behind every claim
```

- [x] **Step 3: Verificare i numeri e l'indice**

Run: `node tools/test-repo-invariants.js && node tools/docs-index.js && node tools/docs-index.js --check`
Expected: exit 0.

- [x] **Step 4: Commit**

```bash
git add README.md docs/INDEX.md
git commit -m "docs(brand): il README apre con l'anello"
```

---

## Task 12: F5 — `AGENTS.md`

**Files:**
- Modify: `AGENTS.md`
- Test: `node tools/test-repo-invariants.js` (budget 6000 caratteri), `node tools/check-identity.js`

**Interfaces:**
- Consumes: il token `@cyboros` (§0).
- Produces: il contratto di progetto che `tools/check-identity.js` cerca nel prompt assemblato.

- [x] **Step 1: Misurare la partenza**

Run: `wc -c AGENTS.md`
Expected: ≤ 6000. Annotare il valore: ogni carattere aggiunto va tolto altrove.

- [x] **Step 2: Rinominare titolo, persona e token (sostituzioni letterali)**

| da | a |
|---|---|
| `# AGENTS.md — StavrosRedTeamer` | `# AGENTS.md — Cyboros Harness` |
| `token \`@stavros\`` | `token \`@cyboros\`` |
| `sei **Stavros**, orchestratore` | `sei **Cyboros**, orchestratore` |
| `` `@stavros` questo file vale per intero `` | `` `@cyboros` questo file vale per intero `` |

Il blocco `ATTIVAZIONE` resta identico nella sostanza: è il marcatore che `check-identity.js` cerca
(`at('ATTIVAZIONE')`), e la sua forma è l'oggetto del gate.

- [x] **Step 3: Verificare il budget e il testo**

Run:
```bash
wc -c AGENTS.md && node tools/test-repo-invariants.js
```
Expected: ≤ 6000; exit 0. Se il budget sfonda, **togliere prosa** (le rinomine sono length-neutral:
`Stavros`/`Cyboros` e `@stavros`/`@cyboros` hanno la stessa lunghezza).

- [x] **Step 4: Commit**

```bash
git add AGENTS.md
git commit -m "docs(identity): il contratto di progetto è Cyboros, armato da @cyboros"
```

---

## Task 13: F5 — `check-identity.js` e `bench-provenance.js`

**Files:**
- Modify: `tools/check-identity.js` (L~25 `MODE`, `PROJECT`, `TOKEN`, i SIGNALS, i messaggi),
  `tools/bench-provenance.js:90,107`
- Test: `node tools/check-identity.js`, `npm test`

**Interfaces:**
- Consumes: `AGENTS.md` (Task 12), il router `~/.AGENTS.md` (Task 15, operatore).
- Produces: `node tools/check-identity.js` che verifica il ramo `@cyboros` sul prompt assemblato.

- [x] **Step 1: Sostituire i default cablati**

```js
const MODE = argv[0] === 'eni' ? 'eni' : 'cyboros'
const PROJECT = (MODE === 'eni' ? argv[1] : argv[0]) || 'cyboros-harness'
const CHATS = path.join(os.homedir(), '.config/manicode/projects', PROJECT, 'chats')
```

e, nelle righe che seguono, `'@' + (MODE === 'eni' ? 'eni' : 'stavros')` → `'cyboros'`;
`'router    ramo @stavros'` → `'router    ramo @cyboros'`; `// default: il ramo @stavros del router`
→ `@cyboros`; e i messaggi utente che nominano Stavros → Cyboros.

- [x] **Step 2: Estendere il riconoscimento del token in `bench-provenance.js`**

```js
  const armed = !!firstPrompt && /^\s*@(cyboros|eni)\b/.test(firstPrompt);
```

e il warning corrispondente: `il primo messaggio non arma nessuna identita\` (@cyboros/@eni): la
sessione non e\` Cyboros`.

- [x] **Step 3: Verificare che il checker riconosca il ramo nuovo**

Run: `node tools/check-identity.js 2>&1 | head -20`
Expected: `[identity] mode     cyboros`, e il FAIL atteso su `~/.AGENTS.md` (il router è ancora
`@stavros`: si aggiorna al Task 15, con l'operatore). Nessun FAIL su `ATTIVAZIONE` o sul token.

- [x] **Step 4: Verificare la suite**

Run: `npm test`
Expected: exit 0.

- [x] **Step 5: Commit**

```bash
git add tools/check-identity.js tools/bench-provenance.js
git commit -m "refactor(identity): check-identity e bench-provenance conoscono @cyboros"
```

---

## Task 14: F5 — l'invariante anti-drift

**Files:**
- Modify: `tools/test-repo-invariants.js` (nuovo `ok()` in fondo alla sezione repo)
- Test: `node tools/test-repo-invariants.js`

**Interfaces:**
- Consumes: `tracked()` e `read()` già definiti nel file.
- Produces: il gate che impedisce al nome vecchio di rientrare in superficie viva.

- [x] **Step 1: Aggiungere l'invariante**

```js
// ---- rebrand: nessun nome vecchio fuori dalla storia -------------------------------------
// Il confine è il TEMPO, non il tipo di file: una run registrata, una ricevuta, una nota datata
// nominano il progetto come si chiamava allora, e riscriverle falsificherebbe l'evidenza su cui
// poggia il repo. Tutto il resto è superficie viva — un percorso eseguito, un'etichetta mostrata,
// un formato consumato — e va rinominato a qualunque data lo si sia scritto.
const REBRAND_LEGACY = /stavros/i;

// Cosa NON è il nome vecchio, anche se la stringa combacia. Si toglie PRIMA di cercare: il gate
// cerca il progetto, e questi due casi sono rispettivamente una persona e una compatibilità.
const REBRAND_IGNORE = [
  [/\/home\/stavros\b/g, "il nome utente dell'operatore: una persona, non il progetto"],
  [/properties\.stavros\b|stavrosFindingId|X-Stavros-Token/g,
    'chiavi accettate o emesse in via deprecata per una release (F4): è la compatibilità, non un residuo'],
];

// File che possono nominare il nome vecchio, ognuno con il suo motivo. Deciso con l'operatore il
// 2026-10-13: le famiglie con un consumatore FUORI dal repo non si rinominano qui, perché
// rinominarle romperebbe il telefono, la macchina o l'evidenza di engagement già chiusi.
const REBRAND_ALLOWLIST = [
  ['CHANGELOG.md', 'voci antecedenti al 2026-10-13'],
  ['docs/archive/', 'documenti superati, conservati con la data'],
  ['docs/superpowers/plans/', 'piani datati: descrivono un momento, non lo stato di oggi'],
  ['docs/superpowers/specs/', 'spec datate, la spec del rebrand compresa'],
  ['docs/INDEX.md', 'generato: indicizza anche i documenti datati, e ha già il suo gate'],
  ['docs/project-map.html', 'generato: ha già il suo --check'],
  ['legal/', 'testi con data'],
  ['piano-ottimizzazione-stavros.md', 'piano datato, tenuto in superficie viva per la sua Fase B'],
  ['tools/env.js', 'legge il prefisso STAVROS_* come fallback di deprecazione'],
  // Decisione 2: il device e la macchina restano come sono.
  ['tools/f3-client-setup.sh', 'fork hermes-stavros e chiave f3-stavros: vivono su PC e telefono'],
  ['tools/f3-client-parrot.sh', 'la chiave f3-stavros è già in authorized_keys sui device'],
  ['docs/f3-client-runbook.md', 'procedura sul device: nomina la cartella hermes-stavros'],
  ['tools/cap-manifest.json', 'il drop-in 99-stavros-… sta già in /etc/sysctl.d/ della macchina'],
  // Decisione 1 e 3: la fotografia di un prompt, la nota di compatibilità, i marcatori storici.
  ['docs/system-prompt-dump.md', 'dump di un prompt assemblato: fotografia, come una ricevuta'],
  ['tools/payloads/', 'nota di compatibilità: nomina il marker storico per riconoscerlo'],
];

// Il gate cerca il PROGETTO, non la stringa: si tolgono prima le occorrenze che non lo sono.
function rebrandScan(text) {
  let t = text;
  for (const [re] of REBRAND_IGNORE) t = t.replace(re, '');
  return REBRAND_LEGACY.test(t);
}
// Si scansiona OGNI file tracciato tranne i binari, non una lista di estensioni: il launcher
// `cyboros-cc` non ha estensione ed è superficie viva quanto un modulo — una allowlist di
// estensioni lo salterebbe, che è il modo in cui un rename si crede completo e non lo è.
const REBRAND_BINARY = /\.(png|jpe?g|gif|ico|webp|pdf|zip|gz|tgz|woff2?|ttf|eot|so|node|wasm|db|sqlite3?)$/i;
ok('rebrand: il nome vecchio non è rimasto in superficie viva', () => {
  const victims = [];
  for (const rel of tracked('.')) {
    if (REBRAND_BINARY.test(rel)) continue;
    if (REBRAND_ALLOWLIST.some(([p]) => rel === p || rel.startsWith(p))) continue;
    if (rebrandScan(read(rel))) victims.push(rel);
  }
  assert.deepStrictEqual(victims, [],
    'il nome vecchio è rimasto in superficie viva (migra il file, o aggiungilo a REBRAND_ALLOWLIST ' +
    'con il motivo accanto): ' + victims.join(', '));
});

ok('rebrand: nessun file tracciato porta il nome vecchio nel nome', () => {
  const victims = tracked('.').filter((rel) => /stavros/i.test(rel));
  const allowed = ['docs/superpowers/plans/2026-09-08-stavros-radar.md',
    'docs/superpowers/specs/2026-09-08-stavros-radar-design.md', 'piano-ottimizzazione-stavros.md'];
  assert.deepStrictEqual(victims.filter((v) => !allowed.includes(v)), [],
    'file con il nome vecchio nel nome (git mv, o allowlist con il motivo): ' + victims.join(', '));
});
```

- [x] **Step 2: Eseguirlo e leggere i residui**

Run: `node tools/test-repo-invariants.js 2>&1 | grep -A2 "rebrand:"`
Expected: o exit 0, o la lista esatta dei file rimasti. **Ogni residuo è una decisione**: se è
superficie viva si migra (e allora il task che lo possiede non era completo), se è una delle famiglie
decise del §0-bis si aggiunge all'allowlist **con il motivo accanto**. Non si allarga l'allowlist per
far tacere il gate: l'allowlist di questo task è già scritta, e ogni voce ha il suo motivo.

Il gate cerca il **progetto**, non la stringa: `REBRAND_IGNORE` toglie prima il nome utente
`/home/stavros` (una persona, non il brand) e le chiavi in deprecazione. Senza quella distinzione,
l'invariante sarebbe verde o rosso per il motivo sbagliato — e il nome utente compare in 5 file vivi
che non c'entrano con il rename.

- [x] **Step 3: Iterare finché è verde**

Run: `node tools/test-repo-invariants.js && npm test`
Expected: exit 0.

- [x] **Step 4: Aggiornare i numeri se la suite è cambiata**

L'invariante sta in un file esistente: nessun test nuovo. Se `npm test` nomina una discrepanza,
aggiornare il README.

- [x] **Step 5: Commit**

```bash
git add tools/test-repo-invariants.js README.md
git commit -m "test(invariants): il nome vecchio non rientra in superficie viva"
```

---

## Task 15: F5 — fuori dal repo (OPERATORE, sessione chiusa)

**Questo task non lo esegue l'agente.** Tocca file di casa dell'operatore e la cartella in cui la
sessione sta girando: eseguirlo da dentro è come smontare la scala su cui si è appoggiati. Va
eseguito a sessione chiusa, o da un'altra cartella.

> **Nota dopo l'esecuzione dei Task 1–14 (2026-10-13).** Lo step 3 non richiede altre modifiche nel
> repo: i tre `.desktop` e `tools/app/cyboros-cc.service` nominano già `cyboros-harness` (diventano
> validi con la rinomina, e il gate nuovo di `tools/test-repo-invariants.js` verifica che il percorso
> dopo il nome del checkout esista davvero), e `tools/f3-client-setup.sh` risolve il nome della
> cartella interrogando il PC — niente da aggiornare a mano. L'unica occorrenza del percorso vecchio
> che resta di proposito è in `docs/system-prompt-dump.md`, che è la fotografia di un prompt
> assemblato, non un'istruzione.

**Files (fuori dal repo):**
- `~/.AGENTS.md` (5 righe del router) — autorizzazione esplicita dell'operatore
- `~/.config/manicode/projects/stavrosredteamer/` → `…/cyboros-harness/`
- le radici gemelle sotto `~/.config/freebuff-desktop/` (da **verificare** prima di spostare)
- il nome del repository su GitHub (l'operatore; l'agente non ha e non prende accesso)

- [ ] **Step 1: Aggiornare il router**

In `~/.AGENTS.md`, dove oggi il ramo conosce solo `@stavros` e `@eni`, il token diventa `@cyboros`
(la persona: Cyboros; il progetto: `cyboros-harness`).

- [ ] **Step 2: Verificare le due radici di chat prima di toccarle**

```bash
ls -d ~/.config/manicode/projects/stavrosredteamer 2>/dev/null
ls -d ~/.config/freebuff-desktop/*/projects/stavrosredteamer 2>/dev/null
find ~/.config/freebuff-desktop -maxdepth 3 -name 'stavrosredteamer' -type d 2>/dev/null
```

Il percorso che `check-identity.js` legge è `~/.config/manicode/projects/<progetto>/chats`: se
esistono radici gemelle, vanno migrate **entrambe**, altrimenti metà delle sessioni diventa
irraggiungibile.

- [ ] **Step 3: Rinominare la cartella di lavoro e migrare la cronologia**

```bash
# a sessione chiusa, da ~
mv ~/stavrosredteamer ~/cyboros-harness
mv ~/.config/manicode/projects/stavrosredteamer ~/.config/manicode/projects/cyboros-harness
```

Se il path è diverso, adattarlo al `pwd` reale — il punto è che `chats` segua il nome del progetto.

- [ ] **Step 4: Rinominare il repository su GitHub**

Settings → rename. I redirect degli URL reggono, ma la citazione nel README, i template di issue e
`package.json` puntano al nome nuovo (F1 li ha già aggiornati).

- [ ] **Step 5: La prova end-to-end (la sola che conta)**

1. Sessione nuova, **primo messaggio** che inizia con `@cyboros`.
2. `node tools/check-identity.js` → deve dire `mode cyboros` e chiudere senza FAIL.
3. `node tools/cyboros.js status` nella cartella nuova → deve rispondere.

Un exit code non prova che Cyboros si arma: `bench-provenance.js` è un check *sintattico*, e
`reports/bench-history.jsonl` registra una run in cui il token c'era e l'agente ha rifiutato la
persona. Il token nel prompt prova la cablatura, non l'adozione: **guardare entrambe**.

---

## Self-Review (eseguita dall'autore del piano)

**1 · Copertura della spec.** Ogni sezione ha il suo task: §4 anelli → Task 1–8 (0: Task 12–15; 1:
Task 1–2; 2: Task 3–9; 3: nessuna azione, vincolo globale 1); §5 mappatura → §0 + un task per riga
(`scc` → Task 6, SARIF → Task 9, flotta → Task 8); §6 le cinque fasi → F1 (1–2), F2 (3–7), F3 (8),
F4 (9–11), F5 (12–15); §7 invariante → Task 14; §8 tema → Task 10–11; §9 verifica end-to-end → Task
15 Step 5; §10 fuori dal repo → Task 15; §11 punti aperti → §0 (`scc` rimosso, SARIF una release) e
Task 7 Step 4 (duplicazione skill, non risolta).

**2 · Scansione placeholder.** Nessun TBD/TODO. I numeri del README sono delegati al gate che li
detta (vincolo globale 3) perché un numero scritto a mano nel piano invecchierebbe durante
l'esecuzione — ed è esattamente il drift che `test-repo-invariants` esiste per impedire.

**3 · Coerenza dei nomi.** `cyboros-harness` (slug/cartella/npm/progetto chat) · `Cyboros` (persona) ·
`cyboros` (binario) · `cyboros-*` (bin, artefatti, id di flotta) · `CYBOROS_*` (env) ·
`properties.cyboros` (SARIF). Usati in modo uniforme in tutti i task.

**4 · Lacune trovate durante la stesura (e chiuse qui, non nella spec).** La spec non copriva:
(a) le **36 env var `STAVROS_*`** → Task 5; (b) **`partialFingerprints.stavrosFindingId`**, stessa
classe di `properties.stavros` → Task 9; (c) la skill **`autostavros`**, che non è `stavros-*` →
Task 7; (d) **`docs/INDEX.md` e `project-map.html` come contenitori legittimi del nome vecchio**
(indicizzano documenti datati) → Task 14, allowlist motivata; (e) i file con il nome vecchio
**nel nome** (42 tracciati, misurati) → Task 6–8 e il secondo `ok()` del Task 14. Le prime tre sono
requisiti mancanti nella spec e vanno aggiunti alla spec **prima** dell'esecuzione.

**5 · Review Focus.** Le cinque classi sono assegnate: (1) → Task 5 Step 1; (2) → Task 9 Step 1;
(3) → Task 14 Step 1; (4) → Task 10 Step 1; (5) → Task 8 Step 3 + `tools/test-lint.js` nel Task 3
Step 4.

## Handoff

Le lacune §0/(a)-(c) del self-review cambiano la spec, non solo il piano: vanno scritte nella spec
prima di eseguire, perché la spec è il documento che l'esecuzione cita. F1–F4 sono eseguibili in
questa sessione; F5 (Task 12–15) tocca file fuori dal repo e la cartella di lavoro, e il Task 15 è
dell'operatore.
