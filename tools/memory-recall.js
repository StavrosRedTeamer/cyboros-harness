#!/usr/bin/env node
// memory-recall.js — tool di RICHIAMO (read-side del ciclo RAG).
//
// PRIMA di attaccare una superficie: genera l'embedding della query (stack tecnologico +
// ostacolo) e interroga il DB vettoriale locale per i top-k risultati simili, restituendoli
// in Markdown compatto pronto per l'LLM. Implementazione in tools/memory-rag.js
// (stesso schema di memory-store.js → memory.js).
//
// Uso:
//   node tools/memory-recall.js "Come bypassare WAF su Spring Boot per SQLi"
//   node tools/memory-recall.js "<stack tecnologico identificato dal recon>" --limit 3 --json
//   node tools/memory-recall.js "union select blocked spring" --class SQLi
//
// Query efficace: stack tecnologico + classe + ostacolo (es. "spring boot modsecurity union select
// blocked"), nello stile del campo target_stack/obstacle con cui le voci sono state cristallizzate.
'use strict';

const path = require('path');
const fs = require('fs');
const rag = require(path.join(__dirname, 'memory-rag.js'));

const MEMORY_DIR = process.env.STAVROS_MEMORY_DIR || path.resolve(__dirname, '..', 'memory');

function optValue(argv, flag, dflt) {
  const i = argv.indexOf(flag);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : dflt;
}
function hasFlag(argv, f) { return argv.includes(f); }

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('-h') || argv.includes('--help')) {
    console.log(fs.readFileSync(__filename, 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'));
    return;
  }
  const query = argv.find((a) => !a.startsWith('--') && a !== optValue(argv, '--class', '\u0000') && a !== optValue(argv, '--limit', '\u0000')) || '';
  try {
    if (!query.trim()) throw new Error('serve una query: memory-recall "<stack tecnologico + ostacolo>"');
    const hits = await rag.recallHybrid(MEMORY_DIR, query, {
      cls: optValue(argv, '--class', null),
      limit: parseInt(optValue(argv, '--limit', '3'), 10),
    });
    if (hasFlag(argv, '--json')) {
      console.log(JSON.stringify(hits.map(({ rec, score }) => ({ score: +score.toFixed(3), ...rec, vec: undefined })), null, 2));
    } else if (!hits.length) {
      console.log('nessuna soluzione cristallizzata simile — procedi con la metodologia standard');
    } else {
      for (const h of hits) console.log(ragFormat(h) + '\n');
    }
  } catch (e) {
    process.stderr.write(`[memory-recall] ERRORE: ${e.message}\n`);
    process.exit(1);
  }
}

// formatter condiviso (identico a memory-rag.js fmtHit, evitato per non allargare l'export)
function ragFormat(hit) {
  const r = hit.rec;
  const lines = [
    `[${r.id}] score=${hit.score.toFixed(2)} │ ${r.vulnerability_class} │ ${r.target_stack}` +
      (r.tags && r.tags.length ? ` │ tags:${r.tags.join(',')}` : ''),
  ];
  if (r.obstacle) lines.push(`  obstacle: ${r.obstacle}`);
  lines.push(`  solution: ${r.solution}`);
  if (r.poc_snippet) lines.push(`  poc: ${r.poc_snippet}`);
  if (r.source_ref) lines.push(`  ev: ${r.source_ref}`);
  return lines.join('\n');
}

main().catch((e)=>{process.stderr.write("[memory-recall] ERRORE: "+e.message+"\n");process.exit(1);});
