#!/usr/bin/env node
// Offline self-check for the RAG memory layer (tools/memory-rag.js + shims memory-store.js /
// memory-recall.js). Hermetic: temp CYBOROS_MEMORY_DIR + SCOPE_JSON fixture, no network,
// no real memory/ touched. Run: node tools/test-memory-rag.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-rag-test-'));
process.env.CYBOROS_MEMORY_DIR = dir; // shims spawnate sotto ereditano questo dir
const scopeFile = path.join(dir, 'scope.json');
fs.writeFileSync(scopeFile, JSON.stringify({ allowed_hosts: ['inspiriratest.com'], allowed_ips: [] }));
process.env.SCOPE_JSON = scopeFile; // sanitizer fixture: host in-scope da rifiutare

const rag = require('./memory-rag');

// --- 1) embedding deterministico + L2 ---
const v1 = rag.embedRecord({ target_stack: 'spring boot', vulnerability_class: 'SQLI', solution: 'waf union select bypass' });
const v1b = rag.embedRecord({ target_stack: 'spring boot', vulnerability_class: 'SQLI', solution: 'waf union select bypass' });
assert.deepStrictEqual(v1, v1b, 'embedding deterministico');
let norm = 0;
for (const [, val] of v1) norm += val * val;
assert.ok(Math.abs(Math.sqrt(norm) - 1) < 1e-3, 'vettore L2-normalizzato, norm=' + Math.sqrt(norm));
assert.ok(v1.length > 0 && v1.length <= rag.DIM && v1[0][0] < v1[1][0], 'sparso, ordinato, nnz<=DIM');
assert.ok(Math.abs(rag.cosine(v1, v1b) - 1) < 1e-3, 'coseno(v,v)~=1');

// --- 2) store: valida, sanifica, id progressivi ---
const a = rag.storeEntry(dir, {
  target_stack: 'Nginx, Spring Boot, ModSecurity',
  vulnerability_class: 'SQLi',
  obstacle: 'il WAF bloccava la keyword UNION SELECT con 403 su ogni tentativo',
  solution: 'bypass con commenti SQL inline (UNION/**/SELECT) piu URL double-encoding del separatore; funziona perche il WAF normalizza prima del motore regole',
  poc_snippet: "' UNION/**/SELECT+1,2,3-- -",
  source_ref: 'reports/findings.jsonl#F-12',
  tags: ['waf', 'sqli', 'bypass'],
});
assert.strictEqual(a.id, 'RAG-0001', 'primo id RAG-0001');
assert.strictEqual(a.sanitized, true, 'voce pulita marcata sanitized');
assert.ok(a.vec && a.vec.length, 'vettore persistito');

const b = rag.storeEntry(dir, {
  target_stack: 'IIS, ASP.NET, Azure WAF',
  vulnerability_class: 'Deserialization',
  obstacle: 'ViewState validation key non impostata, payload serializzato rifiutato',
  solution: 'generare payload con machineKey noti di default e testare errori differenziali; marker benigno nel body per conferma',
  tags: ['deserialization', 'viewstate'],
});
assert.strictEqual(b.id, 'RAG-0002');

// --- 3) validazione: schema sbagliato rifiutato ---
assert.throws(() => rag.storeEntry(dir, { target_stack: 'x', vulnerability_class: 'SQLi', solution: 'abbastanza lunga qui' }), /target_stack/, 'target_stack corta rifiutata');
assert.throws(() => rag.storeEntry(dir, { target_stack: 'spring boot', vulnerability_class: 'SQLi' }), /solution/, 'solution mancante rifiutata');
assert.throws(() => rag.storeEntry(dir, { target_stack: 'spring boot', vulnerability_class: 'SQLi', solution: 'test di soluzione', tags: 'nope' }), /tags/, 'tags non-array rifiutati');

// --- 4) sanitizer: dati di engagement NON entrano ---
const SOL = 'soluzione valida abbastanza lunga per passare la validazione';
for (const [label, extra] of [
  ['in-scope host', { solution: 'works on inspiriratest.com staging panel padded padding' }],
  ['ip literal', { solution: SOL, obstacle: 'pivot via 192.0.2.235 ssh guarded padded' }],
  ['email', { solution: SOL, obstacle: 'admin contact admin@lumen.trading leaked padded' }],
]) {
  assert.throws(() => rag.storeEntry(dir, {
    target_stack: 'spring boot', vulnerability_class: 'SQLi', ...extra,
  }), /sanitizer/, `sanitizer rifiuta ${label}`);
}

// --- 5) recall: ranking per similarita ---
const hits = rag.recallEntries(dir, 'come bypassare WAF su Spring Boot per SQLi, UNION SELECT bloccato');
assert.ok(hits.length >= 1, 'recall restituisce risultati');
assert.strictEqual(hits[0].rec.id, 'RAG-0001', 'la voce Spring/ModSecurity rank 1, got ' + hits[0].rec.id);
const hitsB = rag.recallEntries(dir, 'viewstate machinekey deserialization');
assert.strictEqual(hitsB[0].rec.id, 'RAG-0002', 'la voce IIS/ViewState rank 1 per la sua query');
assert.deepStrictEqual(rag.recallEntries(dir, 'zzz qqq xxx unrelated topic words'), [], 'query senza overlap -> vuoto (MIN_SCORE)');

// --- 6) filtro classe + limit ---
const filtered = rag.recallEntries(dir, 'waf union select bypass', { cls: 'sqli' });
assert.ok(filtered.length && filtered[0].rec.id === 'RAG-0001', 'filtro --class case-insensitive');
assert.deepStrictEqual(rag.recallEntries(dir, 'waf union select bypass', { cls: 'xss' }), [], 'filtro classe senza match -> vuoto');
const limited = rag.recallEntries(dir, 'waf bypass sql deserialization', { limit: 1 });
assert.strictEqual(limited.length, 1, 'limit rispettato');

// --- 7) retire: esclusa dal recall ---
const r = rag.retireEntry(dir, 'RAG-0002', 'tecnica superata');
assert.strictEqual(r.status, 'retired');
assert.ok(!rag.recallEntries(dir, 'viewstate machinekey deserialization').some((h) => h.rec.id === 'RAG-0002'), 'retired esclusa');
assert.ok(rag.recallEntries(dir, 'viewstate machinekey deserialization', { }).length === 0, 'nessun fallback sulla retired');

// --- 8) INDEX + stats ---
rag.rebuildIndex(dir);
const idx = fs.readFileSync(path.join(dir, rag.INDEX_FILE), 'utf8');
assert.ok(idx.includes('RAG-0001') && idx.includes('# RAG index'), 'index contiene gli id');
const st = rag.stats(dir);
assert.strictEqual(st.entries_total, 2);
assert.strictEqual(st.active, 1);
assert.strictEqual(st.retired, 1);
assert.strictEqual(st.with_poc, 1);

// --- 9) shim E2E: memory-store.js / memory-recall.js (stesso dir via env) ---
const env = { ...process.env, CYBOROS_MEMORY_DIR: dir, SCOPE_JSON: scopeFile };
const storeRun = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'memory-store.js'), '--stdin'], {
  cwd: ROOT, env, encoding: 'utf8', timeout: 20000,
  input: JSON.stringify({
    target_stack: 'WordPress, PHP 8, Cloudflare',
    vulnerability_class: 'XSS',
    obstacle: 'wp nonce ripreso ma output-encoded dal tema',
    solution: 'payload in attributo SVG con load event e senza parentesi, sale oltre la sanificazione del tema',
    tags: ['xss', 'wordpress'],
  }),
});
assert.strictEqual(storeRun.status, 0, 'memory-store.js shim ok: ' + storeRun.stderr);
assert.ok(/RAG-0003/.test(storeRun.stdout), 'shim assegna RAG-0003: ' + storeRun.stdout);

const recallRun = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'memory-recall.js'), 'wordpress svg xss nonce theme'], {
  cwd: ROOT, env, encoding: 'utf8', timeout: 20000,
});
assert.strictEqual(recallRun.status, 0, 'memory-recall.js shim ok: ' + recallRun.stderr);
assert.ok(/\[RAG-0003\]/.test(recallRun.stdout), 'shim recall trova la voce appena cristallizzata: ' + recallRun.stdout);

const recallJson = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'memory-recall.js'), 'wordpress svg xss', '--json'], {
  cwd: ROOT, env, encoding: 'utf8', timeout: 20000,
});
assert.strictEqual(recallJson.status, 0);
const parsed = JSON.parse(recallJson.stdout);
assert.ok(!('vec' in parsed[0]), '--json non serializza il vettore');
assert.ok(parsed.every((h) => typeof h.score === 'number'), '--json include lo score');

fs.rmSync(dir, { recursive: true, force: true });
console.log('test-memory-rag.js: ALL PASS');
