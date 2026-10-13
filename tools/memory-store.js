#!/usr/bin/env node
// memory-store.js — tool di CRISTALLIZZAZIONE (write-side del ciclo RAG).
//
// Invocato alla FINE di un engagement (o quando un finding complesso viene confermato):
// cristallizza la soluzione funzionante nel DB vettoriale locale (memory/rag-store.jsonl,
// sanificato dallo stesso sanitizer di tools/memory.js). Implementazione in tools/memory-rag.js
// (stesso schema di memory-store.js → memory.js: shim CLI + modulo condiviso + self-test).
//
// Uso:
//   node tools/memory-store.js --file entry.json
//   echo '{"target_stack":"...","vulnerability_class":"...","obstacle":"...","solution":"...","poc_snippet":"..."}' | node tools/memory-store.js --stdin
//
// Payload (target_stack / vulnerability_class / solution obbligatori):
//   { "target_stack": "Nginx, Spring Boot, ModSecurity",
//     "vulnerability_class": "SQLi",
//     "obstacle": "Il WAF bloccava la keyword UNION SELECT",
//     "solution": "Bypass con commenti SQL inline e URL encoding...",
//     "poc_snippet": " generalized, marker-based — MAI dati reali del target",
//     "source_ref": "reports/findings.jsonl#F-12", "tags": ["waf", "sqli"] }
//
// Quando usarlo: (1) finding complesso VERIFICATO con una soluzione non-ovvia, (2) a fine
// engagement per ogni tecnica che ha funzionato su uno stack riconoscibile. Generalizza SEMPRE
// (niente host/IP/credenziali — il sanitizer rifiuta e il recall è cross-engagement).
'use strict';

const { env } = require('./env');
const path = require('path');
const rag = require(path.join(__dirname, 'memory-rag.js'));

const MEMORY_DIR = env('MEMORY_DIR') || path.resolve(__dirname, '..', 'memory');

function readInputJson(argv) {
  const fs = require('fs');
  const fi = argv.indexOf('--file');
  if (fi !== -1 && argv[fi + 1]) return JSON.parse(fs.readFileSync(argv[fi + 1], 'utf8'));
  if (argv.includes('--stdin')) return JSON.parse(fs.readFileSync(0, 'utf8'));
  throw new Error('serve --file <json> oppure --stdin (JSON su stdin)');
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('-h') || argv.includes('--help') || !argv.length) {
    console.log(require('fs').readFileSync(__filename, 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'));
    process.exit(argv.includes('-h') || argv.includes('--help') ? 0 : 1);
  }
  try {
    const rec = rag.storeEntry(MEMORY_DIR, readInputJson(argv));
    console.log(JSON.stringify({ ok: true, id: rec.id, vulnerability_class: rec.vulnerability_class, target_stack: rec.target_stack }, null, 2));
  } catch (e) {
    process.stderr.write(`[memory-store] ERRORE: ${e.message}\n`);
    process.exit(1);
  }
}

main();
