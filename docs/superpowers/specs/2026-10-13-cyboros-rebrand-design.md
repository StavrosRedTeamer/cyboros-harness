# Cyboros Harness — rebrand da StavrosRedTeamer (design spec)

**Data:** 2026-10-13 · **Repo:** stavrosredteamer · **Stato:** design, in attesa di revisione
**Decisioni già prese con l'operatore:** rename completo *tranne la storia* (anelli 0–2, anello 3
intoccabile); token `@cyboros`; claim "autoevolvente" fondato sui meccanismi reali; cartella locale
rinominata con migrazione della cronologia chat; slug `cyboros-harness` ovunque, binario `cyboros`.

## 1. Il problema, in una frase

Il repository si chiama come il suo primo operatore, e quella scelta è ora la cosa che lo tiene
piccolo: un harness pensato per essere adottato da terzi porta nel nome, nel binario, nel formato
dei dati e nel token di attivazione il nome di una persona, mentre il suo contributo originale —
la policy nel runtime e la severità incapace di superare l'evidenza — non ha ancora un nome.

## 2. Obiettivo, e cosa non è in questa spec

**Obiettivo.** Il progetto si chiama **Cyboros Harness**; il tema è l'**ouroboros**: un harness che
chiude il cerchio su sé stesso — la lezione di un engagement cambia il successivo — e quel cerchio
è descritto dai meccanismi che esistono già nel repo, non da aggettivi. Al termine: `npm test`
verde, `properties.cyboros` nel SARIF, `node tools/cyboros.js status` funzionante, e una sessione
armata da `@cyboros` verificata con `tools/check-identity.js`.

**Non è in questa spec.** Nessuna capacità offensiva nuova, nessun refactor del motore, nessun
cambio di comportamento dei guard. Il rename non è il momento per toccare la logica: qui si
cambiano nomi, la loro provenienza e la loro verificabilità, nient'altro. `refs/`, `vendor/`,
`memory/` e il contratto ENI restano fuori.

## 3. Cosa è stato misurato (2026-10-13, sul worktree)

Nessuno di questi numeri è stimato; sono `grep -rIc` e `git ls-files` eseguiti prima di scrivere.

| fatto | misura |
|---|---|
| file che nominano `stavros` (case-insensitive) | **241**, di cui **67** con `stavrosredteamer` |
| moduli del motore coinvolti | **61** file `.js` sotto `tools/` |
| definizioni di agente da rinominare | **28** in `local/fleet/stavros-*.ts`, più `.agents/stavros-root.ts` |
| `bin` in `package.json` | **5** (`stavros`, `stavros-doctor`, `stavros-record-finding`, `stavros-gen-bench`, `stavros-mcp-guard-proxy`) |
| occorrenze del token `@stavros` **dentro** il repo | 2 in `AGENTS.md`, 3 in `ops/harness.md`, 4 in `local/README-local.md`, 3 in `tools/check-identity.js`, 1 ciascuno in `launch-freebuff.sh`, `bench-session-prompt.md`, `tools/bench-provenance.js` |
| occorrenze del token **fuori** dal repo | 5 in `~/.AGENTS.md` (il router) |
| chat storiche legate al nome della cartella | `~/.config/manicode/projects/stavrosredteamer/chats` |
| formato dati verso terzi | `properties.stavros`, `tools/report-sarif.js:13` e `:227`, più `tools/test-report-sarif.js` |
| evidenza storica che nomina il vecchio token | `reports/bench-history.jsonl`, `reports/bench-bench-…-eval.md`, `scope.json:22` |
| file generati che contengono il nome | `docs/INDEX.md`, `docs/project-map.html` |

Due di questi numeri sono già **gate**, e vanno tenuti veri durante il rename: il README dichiara
il numero di test, agenti, workflow e moduli e `tools/test-repo-invariants.js` confronta i quattro
(valori con ciò che `tools/run-tests.js --list` e `git ls-files` vedono adesso), e lo stesso file
impone un **budget di dimensione su `AGENTS.md`** — quindi la riscrittura del contratto non è
libera di crescere.

## 4. I quattro anelli, e come si tratta ciascuno

Il rename non è un pattern: sono quattro pattern diversi che si assomigliano. Trattarli con un
unico `sed` è la trappola, perché l'anello 3 finirebbe dentro.

- **Anello 0 — identità, in parte fuori dal repo.** `AGENTS.md`, `~/.AGENTS.md`, i default di
  `tools/check-identity.js`, `tools/bench-provenance.js`, i launcher, il nome della cartella di
  lavoro. *Trattamento:* riscrittura a mano, in fase finale, perché il token resta vivo fino ad
  allora.
- **Anello 1 — superficie pubblica.** README, `package.json` (nome, URL, bin), `.github/`, la
  citazione nel README, gli URL nei template di issue. *Trattamento:* riscrittura, e i due file
  generati si rigenerano.
- **Anello 2 — codice e artefatti.** `tools/stavros.js`, il suo test, i 28 agenti, i `.desktop`,
  le unità di sistema, gli installer, le etichette di prodotto ("Stavros Console", "Stavros
  Radar", "Stavros Doctor"), e `properties.stavros`. *Trattamento:* `git mv` per i file (la
  storia dei singoli file sopravvive), rename per gli identificatori, e per il SARIF una finestra
  di compatibilità in uscita.
- **Anello 3 — la storia.** `reports/*.jsonl`, `reports/bench-history.jsonl`, `scope.json`,
  `CHANGELOG.md` (le voci passate), `docs/archive/`, `legal/`, `temp/`, `docs/superpowers/plans/`
  e `specs/` datati — **questa spec compresa**, che è datata e parla per forza del nome vecchio. *Trattamento:* **nessuna scrittura, mai**. Una riga di CHANGELOG che
  raccontasse il passato con un nome che allora non esisteva sarebbe un falso, ed è il peccato che
  `record-finding.js` rifiuta nei finding.

**Regola di precedenza per i casi ambigui:** se un'occorrenza è *storia* (una run registrata, una
ricevuta, una nota datata) si lascia; se è *superficie viva* (un percorso eseguito, un'etichetta
mostrata, un formato consumato) si rinomina. Quando il file è misto — `scope.json` ha una nota
datata in un file vivo, `CHANGELOG.md` ha voci vecchie e nuove — la regola si applica **riga per
riga**, non al file.

## 5. Mappatura dei nomi

| oggi | domani | dove |
|---|---|---|
| `StavrosRedTeamer` | `Cyboros Harness` | prosa, titoli, README, `docs/` |
| `Stavros` (persona e agente) | `Cyboros` | `AGENTS.md`, prompt di sessione, `knowledge.md` |
| `@stavros` | `@cyboros` | `AGENTS.md`, router `~/.AGENTS.md`, `check-identity.js`, `bench-provenance.js` |
| `stavrosredteamer` (cartella, slug, npm) | `cyboros-harness` | cartella, `package.json.name`, URL GitHub |
| `stavros` (binario) | `cyboros` | `package.json.bin`, header dei moduli, docs |
| `stavros-doctor`, `stavros-record-finding`, `stavros-gen-bench`, `stavros-mcp-guard-proxy` | `cyboros-*` | `package.json.bin` |
| `tools/stavros.js`, `tools/test-stavros.js` | `tools/cyboros.js`, `tools/test-cyboros.js` | `git mv` + require dei test |
| `local/fleet/stavros-*.ts` (28) | `local/fleet/cyboros-*.ts` | `git mv`, più gli `id` in `tools/fleet.js` / `model-routing` |
| `.agents/stavros-root.ts` | `.agents/cyboros-root.ts` | `git mv`, più i riferimenti in `.agents/` |
| `stavros-cc`, `stavros-cc.service`, `stavros-*.desktop`, `install-scc-launcher.sh`, `tools/app/scc.py` | `cyboros-cc` e derivati, un solo prefisso | binari, unità di sistema, installer |
| `Stavros Console` / `Stavros Radar` / `Stavros Doctor` | `Cyboros Console` / `Cyboros Radar` / `Cyboros Doctor` | etichette mostrate, header dei moduli |
| `properties.stavros` | `properties.cyboros` (+ `stavros` deprecato in uscita) | `tools/report-sarif.js`, `tools/test-report-sarif.js` |
| `partialFingerprints.stavrosFindingId` | `cyborosFindingId` (+ `stavrosFindingId` in uscita) | `tools/report-sarif.js`, `tools/portal.js` — è la chiave di deduplica di un consumatore terzo, stessa classe di `properties.stavros` |
| `STAVROS_*` (36 nomi, 191 occorrenze) | `CYBOROS_*`, con `STAVROS_*` letto come fallback per una release | 62 file, da un solo modulo `tools/env.js` |
| `autostavros` (skill, `/skill:autostavros`) | `cyboros-autopilot` | `.agents/skills/`, `skills/`, `session-prompt-autostavros.md` |
| `--by stavros`, gli id nominati nei prompt della flotta | `cyboros` | `request-approval --by`, `knowledge.md`, `ops/harness.md` |

**Tre righe di questa tabella non c'erano nella prima stesura**, e sono state trovate misurando il
repo durante la scrittura del piano: le variabili d'ambiente, la chiave di deduplica del SARIF, e la
skill `autostavros`. Hanno in comune di **non contenere la stringa `stavros-`**: un rename guidato
dal pattern le avrebbe mancate, e sono tutte superficie viva — un env var è un'interfaccia verso
l'operatore, `stavrosFindingId` è consumato da un terzo, `/skill:autostavros` è un nome invocato.

**Perché le env var hanno un modulo e non un `sed`:** un operatore che ha già esportato `STAVROS_TMP`
in shell non deve perdere il valore **in silenzio** — un env var caduto non produce un errore
visibile, produce report scritti altrove. Quindi `env('TMP')` legge `CYBOROS_TMP`, poi `STAVROS_TMP`,
poi il default; il prefisso vecchio sopravvive in un solo punto, e l'invariante del §7 lo sa.

**Perché i file si spostano con `git mv` e non si riscrivono:** i 28 agenti e `tools/stavros.js`
hanno storia individuale in `git log`, e quella storia è la prova che la capacità è cresciuta a
ondate. Un file cancellato e ricreato perde la provenienza; un `git mv` la conserva.

## 6. Le fasi

Ogni fase è un commit (o pochi) con conventional commit e voce di CHANGELOG **nuova**, e finisce
con `npm test` verde. L'ordine non è arbitrario: il token e la cartella restano vivi fino
all'ultima fase, così una fase interrotta non lascia una harness che non si arma più.

**F1 — superficie pubblica.** README, `package.json`, `.github/`, citazione, `docs/` vivi
(esclusi gli anelli 3). Rigenerazione di `docs/INDEX.md` e `docs/project-map.html`. Non tocca
ancora né il token né i binari: il repo si presenta come Cyboros mentre si invoca ancora come
`stavros`. *Done:* `npm test` verde, README dichiara i numeri veri, nessun URL vecchio in `.github/`.

**F2 — motore e binari.** `tools/stavros.js` → `tools/cyboros.js` (col suo test), i 5 `bin`,
gli header dei moduli che dicono "Stavros harness", le etichette di prodotto. *Done:* i 5 binari
rispondono sotto il nome nuovo, `node tools/cyboros.js status` esce 0, nessun `require` morto
(il gate `test-lint.js` lo prova).

**F3 — flotta e sistema.** I 28 agenti, `.agents/`, i `.desktop`, `cyboros-cc.service`,
`install-scc-launcher.sh` e i launcher, `tools/app/scc.py`. *Done:* `tools/vet-agents-vs-freebuff.js`
e gli invarianti di flotta (`blocchi canonici`, `agents.length >= 20`) verdi; il launcher desktop
avvia.

**F4 — formato dati e tema.** `properties.cyboros` con `properties.stavros` ancora emesso (marker
`deprecato` nel CHANGELOG), `docs/OUROBOROS.md`, README riscritto attorno all'anello. *Done:*
`test-report-sarif.js` prova entrambe le chiavi, l'ouroboros è verificato (§8).

**F5 — identità e fuori dal repo.** `AGENTS.md` riscritto (rispettando il budget), `@cyboros` in
`check-identity.js` e `bench-provenance.js`, il router `~/.AGENTS.md`, la migrazione della cartella
di lavoro e della cronologia chat, il rename del repo su GitHub. *Done:* una sessione reale armata
da `@cyboros`, `node tools/check-identity.js` OK, `node tools/cyboros.js status` nella cartella
nuova.

**F5 è l'unica fase che tocca file fuori dal repo** (`~/.AGENTS.md`, `~/.config/…`): va autorizzata
esplicitamente a parte, e va eseguita **a sessione chiusa o da un'altra cartella**, perché la
sessione in corso vive dentro la directory che si sposta.

## 7. L'invariante nuovo

`tools/test-repo-invariants.js` guadagna un controllo: **nessuna occorrenza di `stavros` fuori
dall'allowlist storica**. L'allowlist è esplicita e ognuna delle sue voci porta il motivo accanto,
come fa `docs/archive/README.md` — `reports/` (ricevute e run registrate), `CHANGELOG.md` per le
voci antecedenti a questa data, `scope.json`, `docs/superpowers/{plans,specs}/<datati>`, `legal/`,
`temp/`.

Il confine è il tempo, non il tipo di file: un piano o una spec **datati** descrivono un momento e
possono nominare il progetto come si chiamava allora — questa spec compresa; lo stesso nome lasciato
in un percorso eseguibile o in un'etichetta mostrata non è coperto dall'allowlist, a nessuna data,
perché quello è superficie viva comunque la si sia scritta.

Perché serve: senza, il rename è un commit che il prossimo modulo può disfare, e il repo ha già
imparato questa lezione con `docs/project-graph.html` — una pagina che nessuno rigenerava è
invecchiata in silenzio fino a raccontare un progetto che non esisteva più. Un nome lasciato
indietro da un `git mv` è lo stesso guasto, in piccolo.

## 8. Il tema, e come non diventa una bugia

`Cyboros` = cyber + ouroboros. La metafora ha senso **solo** perché l'anello esiste già nel
codice, e la spec si rifiuta di scrivere una riga di marketing che non sia agganciata a un file:

| affermazione | artefatto che la prova |
|---|---|
| la lezione di un engagement non si perde | `memory/` + il sanitizer che rifiuta host in-scope, email, token |
| la lezione rientra in contesto a budget fisso | `tools/memory-recall.js`, `tools/retrieval-budget.js` |
| l'harness sa cosa gli manca | `tools/coverage-loop.js`, `tools/next-actions.js` |
| l'harness cerca capacità nuove da solo | `tools/radar.js` (+ `radar-scout`, `radar-analyst`) |
| l'harness misura se è migliorato | `tools/gen-bench.js`, `reports/bench-history.jsonl` |
| l'harness si esercita senza operatore | `tools/autopilot.js`, `tools/autopilot-checkpoint.js` |

`docs/OUROBOROS.md` è la pagina dell'anello (lezione → ipotesi → run → misura → lezione) e ogni
riga di quella tabella è **verificata da un test**: fallisce se un file nominato non esiste, con
lo stesso meccanismo con cui `tools/project-map.js` si ferma su un riferimento morto. Il claim
"autoevolvente" diventa così la stessa cosa di "severità ≤ evidenza", applicata alla
comunicazione: nessuna affermazione sopra l'evidenza che la sostiene.

## 9. Verifica end-to-end

1. `npm test` verde dopo ogni fase, con i quattro numeri del README coerenti (già gate).
2. `node tools/project-map.js --check` e `docs/INDEX.md` rigenerato: zero drift (già gate).
3. Nuovo invariante (§7) a zero occorrenze fuori allowlist.
4. `node tools/report-sarif.js` emette entrambe le chiavi e `test-report-sarif.js` lo prova.
5. **La prova che conta, perché nessun exit code la sostituisce:** sessione nuova con `@cyboros`
   come primo messaggio, `node tools/check-identity.js` deve rispondere OK sul prompt assemblato,
   e `node tools/cyboros.js status` deve rispondere nella cartella nuova. La lezione è già nel
   repo: `bench-provenance.js` è un check *sintattico*, e `reports/bench-history.jsonl` registra
   una run in cui il token c'era e l'agente ha rifiutato la persona — il token nel prompt non
   prova l'adozione, prova la cablatura. Entrambe le cose vanno guardate.

## 10. Fuori dal repo

- **`~/.AGENTS.md`** (5 righe): il router. È il file di casa dell'operatore, non del repo. Si
  aggiorna in F5, e la riga che oggi conosce solo `@stavros` e `@eni` deve conoscere `@cyboros`.- **Cronologia chat:** `~/.config/manicode/projects/<progetto>/chats` (percorso letto da `check-identity.js`) e le eventuali radici gemelle sotto `~/.config/freebuff-desktop/`: da verificare entrambe prima di spostare, perché il rename della cartella di lavoro cambia il percorso che Freebuff usa per trovare le sessioni.
- **`env('X')` come contratto dei moduli:** i call site non leggono più `process.env` direttamente, quindi un modulo nuovo che ne aggiunga uno senza passare da `tools/env.js` non entra nella finestra di deprecazione. È un vincolo di stile, non un gate: la spec lo dichiara e il piano lo applica ai 62 siti esistenti.
- **GitHub:** il rename del repository conserva i redirect, ma la citazione nel README punta a un
  URL, i template di issue a due, e `package.json` a tre: cambiano in F1. Il rename sul remoto lo
  fa l'operatore (io non ho accesso e non lo prendo).
- **Fuori scope per decisione:** `refs/` (corpus di terzi, con la sua provenienza),
  `~/eni/.AGENTS.md` (contratto separato, dichiarato rivale in `AGENTS.md`), `memory/` e i dati di
  engagement.

## 11. Punti aperti, con la mia raccomandazione

1. **`scc` sopravvive?** Consiglio: no, `cyboros-cc` da solo. Due sigle per la stessa cosa sono
   una superficie in più da spiegare.
2. **`properties.stavros` deprecato per quante release?** Consiglio: una. La data e la nota di
   migrazione vanno nel `CHANGELOG.md` e in `docs/toolbox.md`, che è il documento dove un
   consumatore legge oggi cosa contiene quel sacco (`docs/TOOL-ALTERNATIVES-AUDIT.md:193` ne
   parla in inglese a un lettore esterno, quindi si aggiorna anche quello).
3. **`docs/project-graph.html`:** è cancellato nel worktree corrente e sostituito da
   `project-map.html` (lavoro già in corso, non mio). Il rename non lo reintroduce.
4. **La bozza dell'immagine:** da mettere in `docs/assets/`; il giudizio sui quattro vettori
   (tipografia, colore, movimento, sfondo) è una spec a parte, e il README che oggi apre con lo
   screenshot della Command Center è la prima cosa che quella scelta tocca.

## 12. Rischi

- **Il rename che rompe la flotta in silenzio.** 28 agenti sono file e stringhe identificatrici
  insieme: un `id` rinominato e un riferimento no lo trovano gli invarianti di flotta, ma solo se
  il rename è completo. Mitigazione: F3 è una fase sola, con i suoi gate, non una passata
  trasversale.
- **La storia riscritta per far tornare un grep.** È il rischio vero, e la mitigazione è
  strutturale (§4, §7): l'allowlist è dichiarata *prima* del rename, non dedotta dopo.
- **Il budget di `AGENTS.md`.** La riscrittura del contratto in F5 ha un tetto già imposto dai
  test; se il testo nuovo lo sfonda, si toglie prosa, non si alza il tetto.
