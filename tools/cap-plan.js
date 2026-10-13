#!/usr/bin/env node
// cap-plan.js — legge tools/cap-manifest.json e produce il "piano dei privilegi" in forma
// piatta e stabile, consumata sia da grant-tool-caps.sh (applica) sia da capcheck.js
// (verifica). Zero dipendenze.
//
// Perche' un modulo e non uno snippet inline nello shell: la shell lo avrebbe dovuto
// quotare dentro `node -e`, e ogni quoting annidato e' un posto dove un percorso con uno
// spazio o un apice diventa un errore di sintassi invece di un errore utile. Qui la
// logica e' JavaScript normale, testabile, e lo shell fa solo `node tools/cap-plan.js`.
//
//   node tools/cap-plan.js              # righe TSV: KIND \t CHIAVE \t ARGOMENTI
//   node tools/cap-plan.js --json       # stesso contenuto come array JSON
//   require('./cap-plan')               // { loadManifest, plan, validateManifest }
'use strict';
const { env } = require('./env');
const fs = require('fs');
const path = require('path');

const DEFAULT_MANIFEST = path.join(__dirname, 'cap-manifest.json');

// Campi obbligatori per una riga `bins`. Un manifest che li dimentica fallisce qui, non
// a meta' dell'applicazione: e' lo stesso principio di validateRegistry su tool-registry.
function validateManifest(m, src) {
  const errs = [];
  if (!m || typeof m !== 'object' || Array.isArray(m)) {
    return [`${src}: il manifest deve essere un oggetto JSON`];
  }
  if (m.version !== 1) errs.push(`${src}: version deve essere 1 (trovato ${JSON.stringify(m.version)})`);
  const bins = m.bins;
  if (!bins || typeof bins !== 'object' || Array.isArray(bins) || !Object.keys(bins).length) {
    errs.push(`${src}: "bins" deve essere un oggetto non vuoto`);
  } else {
    for (const [bin, spec] of Object.entries(bins)) {
      if (/\s|\t|\n/.test(bin)) errs.push(`${src}: nome binario "${bin}" contiene spazi/TAB/newline (rompe il piano TSV)`);
      if (!spec || typeof spec !== 'object') { errs.push(`${src}: bins.${bin} deve essere un oggetto`); continue; }
      if (!Array.isArray(spec.caps) || !spec.caps.length) {
        errs.push(`${src}: bins.${bin}.caps deve essere un array non vuoto`);
        continue;
      }
      for (const c of spec.caps) {
        // Solo capability note: un typo qui significa che setcap fallisce a runtime, e
        // fallire a runtime e' il posto peggiore in cui accorgersene.
        if (typeof c !== 'string' || !/^cap_[a-z0-9_]+$/.test(c)) {
          errs.push(`${src}: bins.${bin}.caps ha un valore non-capability: ${JSON.stringify(c)}`);
        }
      }
      if (!spec.why) errs.push(`${src}: bins.${bin}.why mancante — ogni capability concessa va motivata`);
      if (spec.mode && !['network', 'wireless', 'host'].includes(spec.mode)) {
        errs.push(`${src}: bins.${bin}.mode deve essere network|wireless|host (trovato ${JSON.stringify(spec.mode)})`);
      }
    }
  }
  for (const [key, spec] of Object.entries(m.sysctl || {})) {
    if (!/^net\.[a-z0-9_.]+$/.test(key)) errs.push(`${src}: chiave sysctl "${key}" non sembra un net.* path`);
    if (!spec || typeof spec.want !== 'number') errs.push(`${src}: sysctl.${key}.want deve essere un numero`);
  }
  return errs;
}

function loadManifest(file) {
  const f = file || env('CAP_MANIFEST') || DEFAULT_MANIFEST;
  const raw = fs.readFileSync(f, 'utf8');
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (e) { const err = new Error(`cap-manifest non valido: ${e.message}`); err.code = 'E_JSON'; throw err; }
  const errs = validateManifest(parsed, f);
  if (errs.length) { const err = new Error(errs.join('\n')); err.code = 'E_SCHEMA'; throw err; }
  return { path: f, manifest: parsed };
}

// Piano piatto. L'ordine e' quello del manifest (le chiavi JSON preservano l'inserimento),
// cosi' l'output e' diffabile e non "random" a ogni esecuzione.
function plan(manifest) {
  const out = [];
  for (const [key, spec] of Object.entries(manifest.sysctl || {})) {
    out.push({ kind: 'SYSCTL', key, want: spec.want, persistFile: spec.persist_file || null, why: spec.why || null });
  }
  for (const [bin, spec] of Object.entries(manifest.bins || {})) {
    out.push({ kind: 'BIN', key: bin, caps: spec.caps.slice(), mode: spec.mode || 'network',
      why: spec.why || null, caveat: spec.caveat || null });
  }
  return out;
}

// Serializzazione TSV per lo shell: i campi sono gia' validati (nessun TAB/newline nei
// nomi), e i valori di sysctl sono numeri, quindi non serve escaping.
function toTsv(rows) {
  return rows.map((r) => (r.kind === 'SYSCTL'
    ? [r.kind, r.key, String(r.want), r.persistFile || ''].join('\t')
    : [r.kind, r.key, r.caps.join(',')].join('\t'))).join('\n');
}

module.exports = { DEFAULT_MANIFEST, loadManifest, plan, validateManifest, toTsv };

if (require.main === module) {
  // argv[2] e' il manifest. Era argv[3]: con `node cap-plan.js <file>` l'indice 3 non esiste,
  // l'argomento veniva ignorato e si leggeva SEMPRE il manifest di default — quindi lo
  // script, invocato con un manifest alternativo, produceva silenziosamente il piano di
  // quello vero. Il test lo intercetta passando un file rotto e pretendendo un errore.
  let loaded;
  try { loaded = loadManifest(process.argv[2]); }
  catch (e) {
    console.error(`cap-plan: ${e.message}`);
    process.exit(e.code === 'E_SCHEMA' ? 3 : 2);
  }
  const rows = plan(loaded.manifest);
  if (process.argv.includes('--json')) console.log(JSON.stringify(rows, null, 2));
  else console.log(toTsv(rows));
}
