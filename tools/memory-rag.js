#!/usr/bin/env node
// memory-rag.js — memoria vettoriale LOCALE (RAG) per tecniche trasferibili cross-engagement.
//
// Completamento del ciclo memory/: tools/memory.js distilla lezioni greppabili; QUESTO tool
// cristallizza le soluzioni funzionanti in un DB vettoriale locale e le richiama per SIMILARITÀ
// semantica (stack tecnologico + ostacolo), non solo per keyword. Il DB risiede nel workspace
// (memory/rag-store.jsonl, committato e sanificato) — zero servizi cloud, zero dipendenze npm.
//
// Embedding: feature hashing (FNV-1a) su token + bigram, DIM=512, L2-normalizzato. Deterministico,
// offline, senza modelli esterni — la similarità coseno su hashing N-gram cattura l'overlap
// lessicale stack/tecnica che serve al recall ("spring boot waf union" ≈ "springboot waf union select").
// Design vincolato dal repo: ZERO dipendenze runtime (niente chromadb/sqlite-vec/hnswlib-node).
//
// Commands:
//   store  --file <json> | --stdin      valida+sanifica+embedda e appende (record vettoriale)
//   recall "<query>" [--class c] [--limit 3] [--json]     top-k per similarità coseno (solo active)
//   retire RAG-0007 [--reason s]        esclude dal recall (lezione falsa/superata)
//   stats | index
//
// Payload accettato da `store` (i campi obbligatori sono target_stack, vulnerability_class, solution):
//   { "target_stack": "Nginx, Spring Boot, ModSecurity",
//     "vulnerability_class": "SQLi",
//     "obstacle": "Il WAF bloccava la keyword UNION SELECT",
//     "solution": "Bypass con commenti SQL inline e URL encoding...",
//     "poc_snippet": "...", "source_ref": "reports/...", "tags": ["waf","sqli"] }
//
// Sanitizer: riusa sanitizeViolations() di tools/memory.js (host in scope, IP, email, JWT, blob,
// chiavi credential-like) — nessun dato di engagement entra nello store. Poc_snippet va generalizzato.
//
// Self-test: node tools/test-memory-rag.js
'use strict';

const fs = require('fs');
const path = require('path');
const mem = require('./memory'); // riuso il sanitizer e i parser jsonl (fonte unica delle garanzie)

const ROOT = path.resolve(__dirname, '..');
const MEMORY_DIR = process.env.STAVROS_MEMORY_DIR || path.join(ROOT, 'memory');
const STORE_FILE = 'rag-store.jsonl';
const INDEX_FILE = 'RAG-INDEX.md';

const DIM = 512;
const DEFAULT_LIMIT = 3;          // il plan: top-3 risultati
const MIN_SCORE = 0.05;           // sotto questa similarità il hit è rumore: non restituito

// ---------- embedding: feature hashing (FNV-1a 32-bit) ----------
function fnv1a32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

function tokenize(s) {
  return String(s || '').toLowerCase().match(/[a-z0-9_.+-]{2,}/g) || [];
}

// Pesi per campo: stack/classe/tags sono le chiavi del recall (query-time), ostacolo il contesto,
// soluzione il corpo, il poc conta poco (rumore). Questi pesi valgono sia lato store che query.
const FIELD_WEIGHTS = [
  ['tags', 2.5], ['vulnerability_class', 2.0], ['target_stack', 2.0],
  ['obstacle', 1.5], ['solution', 1.0], ['poc_snippet', 0.5],
];

// sparse vector [[idx, val], ...] ordinato per idx, L2-normalizzato
function embedRecord(rec) {
  const counts = new Map(); // token -> peso cumulato
  for (const [field, w] of FIELD_WEIGHTS) {
    const v = rec[field];
    if (v == null) continue;
    const text = Array.isArray(v) ? v.join(' ') : String(v);
    const toks = tokenize(text);
    for (let i = 0; i < toks.length; i++) {
      counts.set(toks[i], (counts.get(toks[i]) || 0) + w);
      if (i + 1 < toks.length) { // bigram: contesto locale ("union select", "spring boot")
        const bg = toks[i] + '_' + toks[i + 1];
        counts.set(bg, (counts.get(bg) || 0) + w * 0.5);
      }
    }
  }
  const acc = new Map(); // hashedIdx -> valore con segno
  for (const [tok, weight] of counts) {
    const idx = fnv1a32(tok) % DIM;
    const sign = (fnv1a32(tok + '\u241fsign') & 1) ? 1 : -1;
    acc.set(idx, (acc.get(idx) || 0) + sign * weight);
  }
  let norm = 0;
  for (const val of acc.values()) norm += val * val;
  norm = Math.sqrt(norm) || 1;
  const vec = [...acc.entries()].sort((a, b) => a[0] - b[0])
    .map(([idx, val]) => [idx, +(val / norm).toFixed(5)]);
  return vec;
}

function embedQuery(query) {
  return embedRecord({ solution: String(query || '') });
}

function cosine(a, b) {
  if (!a || !b || !a.length || !b.length) return 0;
  let dot = 0;
  for (let i = 0, j = 0; i < a.length && j < b.length;) {
    if (a[i][0] === b[j][0]) { dot += a[i][1] * b[j][1]; i++; j++; }
    else if (a[i][0] < b[j][0]) i++;
    else j++;
  }
  return dot; // entrambi L2-normalizzati => dot == coseno
}

// ---------- store ----------
function validateEntry(e) {
  const errs = [];
  if (typeof e.target_stack !== 'string' || e.target_stack.trim().length < 2) errs.push('target_stack: stringa (>=2 char), es. "Nginx, Spring Boot"');
  if (typeof e.vulnerability_class !== 'string' || e.vulnerability_class.trim().length < 2) errs.push('vulnerability_class: stringa (>=2 char), es. "SQLi"');
  if (typeof e.solution !== 'string' || e.solution.trim().length < 8) errs.push('solution: stringa descrittiva (>=8 char)');
  if (e.obstacle != null && typeof e.obstacle !== 'string') errs.push('obstacle: stringa');
  if (e.poc_snippet != null && typeof e.poc_snippet !== 'string') errs.push('poc_snippet: stringa');
  if (e.tags != null && !Array.isArray(e.tags)) errs.push('tags: array di stringhe');
  return errs;
}

function storeEntry(dir, input) {
  const errs = validateEntry(input);
  if (errs.length) throw new Error('validazione fallita:\n  - ' + errs.join('\n  - '));
  const rec = {
    id: null,
    ts: new Date().toISOString(),
    target_stack: String(input.target_stack).trim(),
    vulnerability_class: String(input.vulnerability_class).trim().toUpperCase(),
    obstacle: String(input.obstacle || '').trim(),
    solution: String(input.solution).trim(),
    poc_snippet: String(input.poc_snippet || '').trim(),
    source_ref: String(input.source_ref || '').trim(),
    tags: Array.isArray(input.tags) ? input.tags.map((t) => String(t).toLowerCase()) : [],
    status: 'active',
    sanitized: true,
    vec: null,
  };
  // stesso sanitizer delle lezioni: niente host in scope / IP / email / token / credenziali
  const probe = { ...rec, vec: undefined };
  const violations = mem.sanitizeViolations(probe);
  if (violations.length) {
    throw new Error('sanitizer: dati di engagement rilevati — generalizza la voce prima di salvare:\n  - ' +
      violations.map((s) => s.replace(/\n/g, ' ')).join('\n  - '));
  }
  rec.vec = embedRecord(rec);
  const store = mem.readJsonl(memPath(dir, STORE_FILE));
  rec.id = nextId(store);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(memPath(dir, STORE_FILE), JSON.stringify(rec) + '\n');
  rebuildIndex(dir);
  return rec;
}

function memPath(dir, name) { return path.join(dir, name); }

function nextId(records) {
  let max = 0;
  for (const r of records) {
    const m = /^RAG-(\d+)$/.exec(r.id || '');
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return 'RAG-' + String(max + 1).padStart(4, '0');
}

// ---------- recall ----------
function recallEntries(dir, query, opts = {}) {
  const limit = opts.limit || DEFAULT_LIMIT;
  const qVec = embedQuery(query);
  const qTokens = new Set(tokenize(query));
  const out = [];
  for (const rec of mem.readJsonl(memPath(dir, STORE_FILE))) {
    if (rec.status !== 'active') continue;
    if (opts.cls && String(rec.vulnerability_class).toUpperCase() !== opts.cls.toUpperCase()) continue;
    const score = cosine(qVec, rec.vec);
    if (score < MIN_SCORE) continue;
    // bonus deterministico per overlap lessicale esplicito (stack/classe citati nella query)
    const recTokens = new Set([
      ...tokenize(rec.target_stack), ...tokenize(rec.vulnerability_class), ...(rec.tags || []),
    ]);
    let overlap = 0;
    for (const t of qTokens) if (recTokens.has(t)) overlap++;
    out.push({ rec, score: score + overlap * 0.05, base: score });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}

// ---------- lifecycle / index / stats ----------
function retireEntry(dir, id, reason) {
  const file = memPath(dir, STORE_FILE);
  const store = mem.readJsonl(file);
  const rec = store.find((r) => r.id === id);
  if (!rec) throw new Error(`${id} non trovata`);
  rec.status = 'retired';
  rec.retire_reason = reason || '';
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, store.map((r) => JSON.stringify(r)).join('\n') + '\n');
  fs.renameSync(tmp, file);
  rebuildIndex(dir);
  return rec;
}

function fmtHit(hit) {
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

function rebuildIndex(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const store = mem.readJsonl(memPath(dir, STORE_FILE));
  const byClass = {};
  for (const r of store) (byClass[r.vulnerability_class] = byClass[r.vulnerability_class] || []).push(r);
  let md = '# RAG index — soluzioni cristallizzate (grep-first)\n\n';
  md += '> Rigenerato da `tools/memory-rag.js` ad ogni mutazione. Non editare a mano.\n';
  md += '> Recupero per similarità: `node tools/memory-rag.js recall "<stack+ostacolo>"`. Voci retired escluse.\n\n';
  for (const cls of Object.keys(byClass).sort()) {
    md += `## ${cls} (${byClass[cls].length})\n`;
    for (const r of byClass[cls]) {
      const flag = r.status !== 'active' ? ` ⚠${r.status}` : '';
      md += `- ${r.id}${flag} [${r.target_stack}] ${r.solution.slice(0, 110)}\n`;
    }
    md += '\n';
  }
  if (!store.length) md += '_Vuoto: nessuna soluzione ancora cristallizzata._\n';
  fs.writeFileSync(memPath(dir, INDEX_FILE), md);
}

function stats(dir) {
  const store = mem.readJsonl(memPath(dir, STORE_FILE));
  const count = (fn) => store.filter(fn).length;
  return {
    entries_total: store.length,
    active: count((r) => r.status === 'active'),
    retired: count((r) => r.status === 'retired'),
    with_obstacle: count((r) => !!r.obstacle),
    with_poc: count((r) => !!r.poc_snippet),
  };
}

// ---------- CLI ----------
function readInputJson(argv) {
  const fi = argv.indexOf('--file');
  if (fi !== -1 && argv[fi + 1]) return JSON.parse(fs.readFileSync(argv[fi + 1], 'utf8'));
  if (argv.includes('--stdin')) return JSON.parse(fs.readFileSync(0, 'utf8'));
  throw new Error('serve --file <json> oppure --stdin (JSON su stdin)');
}
function optValue(argv, flag, dflt) {
  const i = argv.indexOf(flag);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : dflt;
}
function hasFlag(argv, f) { return argv.includes(f); }

function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const dir = MEMORY_DIR;
  try {
    switch (cmd) {
      case 'store': {
        const rec = storeEntry(dir, readInputJson(argv));
        console.log(JSON.stringify({ ok: true, id: rec.id, class: rec.vulnerability_class, nnz: rec.vec.length }, null, 2));
        break;
      }
      case 'recall': {
        const query = argv[1] && !argv[1].startsWith('--') ? argv[1] : '';
        if (!query.trim()) throw new Error('serve una query: recall "<stack tecnologico + ostacolo>"');
        const hits = recallEntries(dir, query, {
          cls: optValue(argv, '--class', null),
          limit: parseInt(optValue(argv, '--limit', String(DEFAULT_LIMIT)), 10),
        });
        if (hasFlag(argv, '--json')) {
          console.log(JSON.stringify(hits.map(({ rec, score }) => ({ score: +score.toFixed(3), ...rec, vec: undefined })), null, 2));
        } else if (!hits.length) {
          console.log('nessuna soluzione cristallizzata simile — procedi con la metodologia standard');
        } else {
          for (const h of hits) console.log(fmtHit(h) + '\n');
        }
        break;
      }
      case 'retire': {
        const r = retireEntry(dir, argv[1], optValue(argv, '--reason', ''));
        console.log(`${r.id}: retired (${r.retire_reason || 'no reason'}) — escluso dal recall`);
        break;
      }
      case 'stats':
        console.log(JSON.stringify(stats(dir), null, 2));
        break;
      case 'index':
        rebuildIndex(dir);
        console.log(`RAG-INDEX rigenerato: ${path.relative(ROOT, memPath(dir, INDEX_FILE))}`);
        break;
      default:
        console.log([
          'usage:',
          '  node tools/memory-rag.js store --file entry.json | --stdin',
          '  node tools/memory-rag.js recall "<query>" [--class c] [--limit n] [--json]',
          '  node tools/memory-rag.js retire RAG-0007 [--reason s]',
          '  node tools/memory-rag.js stats | index',
        ].join('\n'));
        process.exit(cmd ? 1 : 0);
    }
  } catch (e) {
    process.stderr.write(`[memory-rag] ERRORE: ${e.message}\n`);
    process.exit(1);
  }
}

module.exports = {
  storeEntry, recallEntries, retireEntry, rebuildIndex, stats,
  embedRecord, embedQuery, cosine, tokenize, fnv1a32,
  STORE_FILE, INDEX_FILE, DIM, DEFAULT_LIMIT, MIN_SCORE,
};

if (require.main === module) main();
