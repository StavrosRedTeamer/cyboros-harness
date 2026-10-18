#!/usr/bin/env node
// Local knowledge retrieval over knowledge.md + docs/** + tools/payloads/** + workflows/*.yaml
// (+ reports/*.md with --docs) — glassmind-style context bundles for the agents (repo-vet
// churchofmalware plan QW10). SQLite FTS5 via node:sqlite (Node >= 22.5, zero npm deps).
//
//   node tools/kb-search.js index                 # rebuild reports/kb-index.db
//   node tools/kb-search.js "query terms" [--limit 5] [--docs]   # search (findings included only with --docs)
//
// Perché payloads e workflow sono nel corpus di default: sono metodologia, non dati di
// engagement (a differenza di reports/), e sono esattamente ciò che un agente deve ritrovare
// prima di testare una classe — «come si conferma un CSPT» non deve richiedere di aprire a
// mano quattro .md. `--docs` resta l'unico modo per includere reports/.
//
// Chunking: one row per markdown heading section (heading kept as context); un file YAML senza
// heading produce un solo chunk con l'intero file — i workflow sono piccoli e restano leggibili.
// Every chunk is an owned plain-text copy — no live objects are persisted.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DB_PATH = () => process.env.KB_INDEX_DB || path.join(ROOT, 'reports', 'kb-index.db');

// Corpus: knowledge.md + docs + payloads + workflows always; reports/*.md only with --docs
// because report bodies are engagement evidence and pollute methodology queries.
function walk(dir, kind, re, root = ROOT) {
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(dir); } catch { return out; }
  for (const e of entries) {
    if (e === 'tmp' || e === '.git' || e === 'node_modules') continue;
    const full = path.join(dir, e);
    let st = null;
    try { st = fs.statSync(full); } catch { continue; }
    if (st.isDirectory()) out.push(...walk(full, kind, re, root));
    else if (re.test(e)) out.push({ file: path.relative(root, full), kind });
  }
  return out;
}

// `root` esiste perché il corpus deve essere verificabile su una fixture: un clone pulito
// non ha `reports/`, e un test che pretende un file di engagement lì dentro è verde solo
// sulla macchina di chi ha già lavorato (la classe di difetto di test-repo-invariants).
function corpusFiles(includeReports, root = ROOT) {
  const files = [
    { file: 'knowledge.md', kind: 'knowledge' },
    ...walk(path.join(root, 'docs'), 'docs', /\.md$/i, root),
    ...walk(path.join(root, 'tools', 'payloads'), 'payloads', /\.md$/i, root),
    ...walk(path.join(root, 'workflows'), 'workflows', /\.ya?ml$/i, root),
  ];
  if (includeReports) files.push(...walk(path.join(root, 'reports'), 'reports', /\.md$/i, root));
  return files;
}

// Split markdown into {heading, body} chunks at ## / ### boundaries (H1 stays preamble).
function chunksOf(text) {
  const lines = String(text || '').split(/\r?\n/);
  const chunks = [];
  let cur = { heading: '(preamble)', body: [] };
  for (const line of lines) {
    const m = line.match(/^(#{2,3})\s+(.*)$/);
    if (m) {
      if (cur.body.join('').trim()) chunks.push({ heading: cur.heading, body: cur.body.join('\n').trim() });
      cur = { heading: m[2].trim(), body: [line] };
    } else {
      cur.body.push(line);
    }
  }
  if (cur.body.join('').trim()) chunks.push({ heading: cur.heading, body: cur.body.join('\n').trim() });
  return chunks;
}

// Quote every token so user input never becomes FTS query syntax.
function safeQuery(q) {
  const toks = String(q || '').split(/\s+/).map((t) => t.trim()).filter(Boolean).slice(0, 12);
  return toks.map((t) => '"' + t.replace(/"/g, '') + '"').join(' AND ');
}

function openDb(file) {
  const DatabaseSync = require('node:sqlite').DatabaseSync;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('CREATE VIRTUAL TABLE IF NOT EXISTS kb USING fts5(doc, heading, body)');
  return db;
}

function index(opts) {
  opts = opts || {};
  const includeReports = !!opts.includeReports;
  const dbFile = opts.dbFile || DB_PATH();
  try { fs.rmSync(dbFile, { force: true }); fs.rmSync(dbFile + '-wal', { force: true }); fs.rmSync(dbFile + '-shm', { force: true }); } catch {}
  const db = openDb(dbFile);
  let indexed = 0;
  const skipped = [];
  for (const f of corpusFiles(includeReports)) {
    let text;
    try { text = fs.readFileSync(path.join(ROOT, f.file), 'utf8'); } catch { skipped.push(f.file); continue; }
    for (const c of chunksOf(text)) {
      db.prepare('INSERT INTO kb (doc, heading, body) VALUES (?, ?, ?)').run(f.file, c.heading, c.body);
      indexed++;
    }
  }
  const total = db.prepare('SELECT COUNT(*) AS n FROM kb').get().n;
  db.close();
  return { ok: true, db: dbFile, chunks_indexed: indexed, rows: total, skipped };
}

function search(q, opts) {
  opts = opts || {};
  const limit = Math.min(Math.max(1, Number(opts.limit) || 5), 25);
  const dbFile = opts.dbFile || DB_PATH();
  if (!fs.existsSync(dbFile)) return { ok: false, error: 'index missing — run: node tools/kb-search.js index' };
  const db = openDb(dbFile);
  const match = safeQuery(q);
  if (!match) { db.close(); return { ok: false, error: 'empty query' }; }
  let rows = [];
  try {
    rows = db.prepare(
      'SELECT doc, heading, snippet(kb, 2, \'[\', \']\', \' … \', 24) AS snip, bm25(kb) AS score FROM kb WHERE kb MATCH ? ORDER BY score LIMIT ?'
    ).all(match, limit);
  } catch (e) {
    db.close();
    return { ok: false, error: 'query failed: ' + e.message };
  }
  db.close();
  return { ok: true, query: q, matches: rows.map((r) => ({ doc: r.doc, heading: r.heading, snippet: r.snip, score: Number(r.score.toFixed(3)) })) };
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const flag = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
  if (argv[0] === 'index') {
    console.log(JSON.stringify(index({ includeReports: argv.includes('--docs') }), null, 2));
    process.exit(0);
  }
  const q = argv.find((a, i) => a !== '--limit' && a !== '--docs' && (flag('--limit') == null || i !== argv.indexOf('--limit') + 1));
  if (!q) {
    console.error('usage: node tools/kb-search.js index | "<query>" [--limit N] [--docs]');
    process.exit(2);
  }
  const r = search(q, { limit: Number(flag('--limit') || 5), includeReports: argv.includes('--docs') });
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.ok && r.matches.length ? 0 : r.ok ? 1 : 2);
}

module.exports = { corpusFiles, chunksOf, safeQuery, index, search, DB_PATH, walk };
