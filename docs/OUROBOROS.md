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
