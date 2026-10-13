# Ondata 7 — Integrità e promozione della prova (design spec)

**Data:** 2026-09-28 · **Repo:** stavrosredteamer · **Stato:** design, in attesa di revisione
**Percorso scelto:** "integrità prima, capacità dopo" (Percorso 1). La coda di capacità
(`docs/superpowers/plans/2026-09-26-offensive-batch2-plan.md`, WS2→WS1) resta il ciclo
successivo, con la sua spec e il suo piano: qui non si tocca.

## 1. Il problema, in una frase

Il registro dei finding è **append-only, incatenato e deduplicato per chiave**, ma la
verifica è un fatto che arriva **dopo** la registrazione: oggi il sistema non ha un posto
dove scriverla, e l'unico percorso esistente la scrive **riscrivendo il file**, che è
esattamente ciò che la catena A3 vieta.

## 2. Le quattro evidenze che aprono la spec

Tutte verificate leggendo il codice il 2026-09-28; nessuna è ancora riprodotta da un test,
ed è la ragione per cui il primo passo della sequenza è un test che le dimostra.

**E1 — la documentazione insegna una mossa che rompe la prova, e il recovery non esiste.**
`knowledge.md:99` indica `verify-finding.js batch` come percorso batch per i finding con
blocco `verify`; l'header di `tools/verify-finding.js` (righe 10-13) dichiara che quella
modalità riscrive le righe in place e che "`record()` rifiuterà gli append finché non è
riconciliata". Rifiuta davvero (`tools/record-finding.js`, `record()` → `verifyFindingsChain`
con `ok:false` ⇒ `refusing to append`), e `tools/gate.js` ha il check `chain` che fa
**fallire lo stage gate**. Un grep di `rechain|re-chain|reconcile|repair.*chain` su codice e
documenti trova **una sola occorrenza**: quel commento. Non esiste il tool di ripristino.

**E2 — l'anchor esterna rende la ricatena ingenua un secondo guasto.** `chainHead` in
`gate.js` confronta l'ultima voce di `reports/tmp/findings-head-anchor.jsonl` con la riga
`seq` del file. Riscrivere `findings.jsonl` rigenerando la catena cambia l'hash di quella
riga: la catena torna internamente coerente e **la anchor non torna**. Chi cerca di
riparare senza saperlo passa da "catena rotta" a "catena manomessa".

**E3 — promuovere `confirmed` → `verified` è impossibile in append-only.** `record()`
deduplica su `key() = host|endpoint|title` e risponde `{ok:true, deduped:true}` **senza
aggiornare nulla**: un finding già registrato non può ricevere il risultato di una verifica
successiva. L'unica via è la riscrittura — cioè E1. Il buco quindi non è teorico: è il
percorso normale di un engagement (registro `triggered`, verifico dopo, voglio `verified`).

**E4 — `checkNoPending` è vacuo su un corpus valido.** `gate.js`:
`pending = findings.filter((f) => f.status === 'pending' || (!f.status && !f.verified))`.
Ma `validate()` in `record-finding.js` **impone** `status` e ammette solo
`confirmed|inconclusive|verified`: su un corpus registrato dal validator attuale il check
non può fallire (può farlo solo su righe legacy pre-A1). Uno dei tre criteri dichiarati del
gate — "coverage completa, nessun finding pendente, almeno uno verificato, o nessun report"
— è quindi decorativo nella formulazione attuale.

**Contesto utile (ridimensionato con onestà).** Il `THREAT-MODEL` §5 nomina il consent
token come superficie da attaccare (replay, riuso cross-host, race). `tools/test-cc-approvals.js`
**copre già** replay (`consumed token cannot be reused`), host sbagliato, comando
diverso, scadenza e grant su scope bloccato. Non copre la **race grant/use**: non c'è
nessun test di concorrenza. Questo riduce quella voce a un caso singolo, non a un cantiere.
Restano inoltre 4 moduli su 144 senza alcuna menzione in un test (`request-approval`,
`vendor-dir`, `views-control`, `vet-agents-vs-freebuff`); di questi solo `vendor-dir.js`
decide *quale binario viene eseguito* (env → XDG → legacy) e ha logica non banale.

## 3. Principio di design

> **La verifica è un fatto nuovo, non la modifica di un fatto vecchio.**

Da cui: `findings.jsonl` diventa **immutabile**; i fatti di verifica vivono in un **side log
append-only, incatenato e ancorato con le stesse regole**; lo stato "effettivo" di un
finding è una **vista calcolata**, non un campo riscritto. La vista è **fail-closed verso il
basso**: senza un record di verifica valido un finding resta quello che era. Nessun percorso
può promuovere qualcosa, solo registrare perché promuoverlo.

## 4. Componenti

### 4.1 `tools/chain-log.js` (nuovo, ~80 righe)
Estrae la meccanica di catena oggi dentro `record-finding.js` (`sha256Hex`,
`buildChainedLine`, `verifyFindingsChain`, `appendHeadAnchor`, `verifyHeadAnchor`) in un
modulo parametrizzato su `{file, anchorFile, genesis}`. `record-finding.js` lo consuma senza
cambi di comportamento (le sue export restano, per i consumer attuali: `gate.js`,
`audit-trail.js`, `model-routing.js` e i test). Serve a garantire che il side log abbia
**la stessa** disciplina invece di una copia che diverge.

### 4.2 `tools/verification-log.js` (nuovo, ~120 righe)
Side log append-only `reports/verifications.jsonl` (override `VERIFICATIONS_JSONL`), con la
propria anchor esterna (`reports/tmp/verifications-head-anchor.jsonl`). Un record:

```json
{ "kind": "verification", "finding_seq": 12, "finding_key": "host|/api/x|idor",
  "outcome": "verified", "runs": [{"status":200,"ok":true,"reason":"ok"}],
  "oracle": {"type":"http-diff","ref":"artifacts/oracle/<t>.json","token":"<t>"},
  "evidence_quote": {"file":"artifacts/oracle/<t>.json","text":"outcome passed: 2/2 passed"},
  "verifier": "verify-finding/batch", "ts": "…", "chain": {"seq":1,"prev_sha256":"0…0","ts":"…"} }
```

Fail-closed: se la catena del side log è rotta non si appende e si esce ≠ 0. Il record di un
esito **negativo** è ammesso e desiderabile (`outcome:'failed'`): un tentativo di verifica
fallito è un fatto della prova come uno riuscito.

### 4.3 `tools/effective-findings.js` (nuovo, ~90 righe)
`fold(findings, verifications)` → vista. Regole, in ordine:

1. nessun record per `finding_key` ⇒ `effective_status` = status registrato (fail-closed);
2. `outcome:'failed'` ⇒ `verify_failed` esposto, **nessuna** promozione;
3. `outcome:'verified'` ⇒ promozione **solo se** l'oracle del record si rivalida su disco
   (`oracle.validateOracle`) **e** la quote è verbatim (`evidence-quote.validateQuote`) al
   momento del fold — mai fidandosi del record;
4. più record per la stessa chiave ⇒ vince **l'ultimo**; il `finding_seq` del record deve
   puntare a una riga esistente e un record non promuove un finding registrato **dopo** di
   esso (una verifica non può anticipare ciò che verifica);
5. ogni record non applicato è riportato in `diagnostics` (perché non ha promosso).

### 4.4 Wiring
- `verify-finding.js`: `batch` **non scrive più** `findings.jsonl`; verifica e appende al
  side log, poi stampa il riepilogo. `verifyFile()` resta esportato ma **rifiuta** (exit ≠ 0,
  messaggio esplicito) se il file contiene righe incatenate. `one` invariato.
- `record-finding.js`: `recordWithVerify` su chiave già presente **non** risponde più solo
  `deduped:true`: appende il record di verifica al side log e lo riporta nel risultato; il
  risultato deduplicato porta il `seq` della riga esistente, che è ciò a cui il record punta.
  Nessun `resolveEffective()` qui: `record-finding` non importa la vista (nessun ciclo di require),
  la vista si legge da `tools/effective-findings.js`.
- `gate.js`: i check `findings`/`verify`/`oracle`/`evidenceQuote`/`noPending`/`pocReplay`
  leggono la **vista**; nuovo check `chainHeadVerifications`.
- `checkNoPending` riformulato in modo **falsificabile**: è pendente un finding che rivendica
  realtà e non ha né `outcome` nel side log né un oracle valido, oppure ha `verify_failed`.
- Documenti: `knowledge.md:99` e `ops/harness.md:38` smettono di indicare il percorso che
  riscrive.
- **Non-goals sul wiring:** i 27 altri consumer di `findings.jsonl` non cambiano. Il fold è
  opt-in; solo il gate ci passa subito. Chi legge le righe grezze vede lo stato registrato —
  cioè il comportamento fail-closed, non un over-claim.

### 4.5 `tools/rechain.js` (nuovo, ~140 righe)
Riconciliazione di una catena rotta, con la ricatena **registrata come evento**:
`--reason` e `--confirm` obbligatori; backup `.pre-rechain.<ts>` (gitignored) prima di
toccare; ricostruzione della catena sul contenuto esistente (nessuna riga modificata);
append al log dell'anchor di `{kind:'findings-rechain', old_head_sha256, new_head_sha256,
seq, reason, backup, ts}` **prima** della nuova ancora. `verifyHeadAnchor` riporta la
presenza di rechain precedenti nel `detail` (informativo, non fallimento): la riscrittura
resta visibile e motivata invece di essere un'anomalia indistinguibile da un attacco.

## 5. Test (tutti offline, zero rete)

| File | Cosa prova |
|---|---|
| `test-verification-log.js` (nuovo) | catena del side log; rifiuto su catena rotta; record negativo ammesso |
| `test-effective-findings.js` (nuovo) | nessun record ⇒ nessuna promozione; `failed` ⇒ nessuna promozione; oracle cancellato dal disco ⇒ nessuna promozione; due record ⇒ vince l'ultimo; `finding_seq` successivo ⇒ non applica |
| `test-rechain.js` (nuovo) | catena rotta → rechain → catena valida, anchor aggiornata, backup presente, voce `rechain` nel log; rifiuto senza `--reason` |
| `test-verify-finding.js` (estensione) | `batch` non modifica `findings.jsonl` (hash del file invariato) e appende al side log; `verifyFile` con righe incatenate esce ≠ 0 |
| `test-gate-chain.js` (estensione) | i check leggono la vista; `noPending` **fallisce** su un reality-claim senza esito; `pocReplay` richiede `exp/<id>.py` per i verified *effettivi* |
| `test-vendor-dir.js` (nuovo) | `$STAVROS_VENDOR_DIR` > XDG > legacy; `noLegacy`; rifiuto di `..` e NUL (gli slash iniziali restano normalizzati, come si aspetta ogni chiamante) |
| `test-request-approval.js` (nuovo) | parsing CLI, delega a `cc-approvals`, fail-closed su azione sconosciuta |
| `test-cc-approvals.js` (estensione) | **race**: due `consume` concorrenti sullo stesso id ⇒ esattamente uno `ok` (CAS via `opstate`) |

**Ratchet** in `test-repo-invariants.js`: la baseline dei moduli senza alcun test scende da 4
a 0 (oppure a 1, con `views-control` escluso **per scelta dichiarata**, non per dimenticanza);
e nessun documento può raccomandare un comando che riscrive un file incatenato.

## 6. Retrocompatibilità e rischi

- **Byte-identico senza side log.** Su un repo senza `reports/verifications.jsonl` il fold
  restituisce esattamente lo status registrato: un test lo asserisce. Il rischio "secondo
  posto dove sta la verità" è mitigato tenendo `effective-findings.js` come **unico** punto
  di fold (gate + report), non come regola replicata.
- **Il side log è un secondo formato da mantenere.** Alternativa più piccola: fare solo
  4.4-primo-punto (batch smette di riscrivere) senza side log — costo minore, ma lascia E3
  aperto, cioè "promuovere è impossibile". Lo scarto è dichiarato, non nascosto.
- **Nessun cambio di formato dei finding**: la catena A3 del corpus esistente non si tocca.
- **Nessun commit autonomo** (regola workspace §3): a fine lavoro le modifiche restano non
  committate con un riepilogo.

## 7. Sequenza di esecuzione

1. **Test che dimostrano E1/E3** (falliscono sul codice attuale): è il primo passo perché
   finora le evidenze sono lette, non riprodotte.
2. `chain-log.js` + refactor di `record-finding.js` senza cambi di comportamento
   (`npm test` deve restare 95 PASS).
3. `verification-log.js` + `effective-findings.js` + wiring `verify-finding.js`.
4. Wiring `gate.js` (vista, `noPending` falsificabile, `chainHeadVerifications`).
5. `rechain.js`.
6. Test dei moduli scoperti + race del consent token.
7. Documenti (`knowledge.md`, `ops/harness.md`, `docs/ARCHITECTURE.md` L0/L1) + ratchet.

## 8. Verifica finale

`npm test` (95 PASS attesi + 5 file di test nuovi e 3 estesi), `node tools/doctor.js --check`
exit 0, `node tools/test-repo-invariants.js` verde, `node tools/check-identity.js` coerente, e
un **end-to-end su fixture**: registra un finding `triggered` → batch-verify → il gate
`chain` è **ok** (prima falliva) → il finding risulta `verified` nella vista → il check
`pocReplay` chiede il reproducer.

**Vincoli di repo che il piano deve rispettare** (non sono opzionali, un gate li controlla):
il conteggio dei test dichiarato in `README.md` va riallineato al numero reale, perché
`tools/test-repo-invariants.js` lo impone; questa spec aggiunge un file sotto `docs/`, e
l'indice legge `git ls-files`, quindi finché il file non è tracciato il gate resta verde — ma
**al primo commit va rieseguito `node tools/docs-index.js`** per rigenerare `docs/INDEX.md`;
ogni nuovo modulo vuole una riga di documentazione, altrimenti la baseline `UNDOCUMENTED_BASELINE` cresce"; e il
gate non passa con un `tools/*.js` citato da un documento e inesistente.
