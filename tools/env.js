#!/usr/bin/env node
// env.js — un solo posto per le variabili d'ambiente dell'harness.
//
// Il prefisso è passato da STAVROS_ a CYBOROS_ il 2026-10-13. Un operatore che ha già esportato
// STAVROS_TMP in shell, o un'unità di sistema che lo passa, non deve perdere il valore in
// silenzio: un env var caduto non produce un errore visibile, produce report scritti altrove.
// Quindi per una release CYBOROS_X è preferito e STAVROS_X resta letto.
//
// Uso: const { env } = require('./env'); const dir = env('TMP', os.tmpdir());
// I call site non leggono più process.env direttamente: un modulo nuovo che ne aggiungesse uno
// senza passare di qui resterebbe fuori dalla finestra di deprecazione.
'use strict';

// Nome senza prefisso: env('TMP') legge CYBOROS_TMP, poi STAVROS_TMP.
function env(name, dflt) {
  const v = process.env['CYBOROS_' + name] ?? process.env['STAVROS_' + name];
  return v === undefined || v === '' ? dflt : v;
}

module.exports = { env };
