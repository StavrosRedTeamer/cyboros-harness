#!/usr/bin/env node
// tools/test-embeddings.js — test del backend dense semantico + recall ibrido del RAG.
// Ermetico: nessuna rete. Verifica che senza backend il dense sia disabilitato (fallback
// lessicale, nessuna regressione) e che, iniettando vettori dense, la fusione ibrida funzioni.
// test-tags: offline
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Assicura che il dense sia OFF per questo test (nessun endpoint).
delete process.env.STAVROS_EMBED_URL;

const emb = require('./embeddings');
const rag = require('./memory-rag');

// --- embeddings.js: disabilitato senza URL, coseno denso, guardia OPSEC ---
assert.strictEqual(emb.isEnabled(), false, 'dense disabilitato senza STAVROS_EMBED_URL');

(async () => {
  const none = await emb.embedTexts(['x']);
  assert.strictEqual(none, null, 'embedTexts ritorna null quando disabilitato (fallback lessicale)');

  const u = emb.l2normalize([3, 4]);
  assert.ok(Math.abs(Math.hypot(u[0], u[1]) - 1) < 1e-4, 'l2normalize normalizza');
  assert.ok(Math.abs(emb.denseCosine([1, 0], [1, 0]) - 1) < 1e-9, 'denseCosine(v,v)=1');
  assert.ok(Math.abs(emb.denseCosine([1, 0], [0, 1])) < 1e-9, 'denseCosine ortogonali=0');
  assert.strictEqual(emb.denseCosine([1, 0], [1, 0, 0]), 0, 'denseCosine dim diverse=0');

  // --- recall IBRIDO: iniezione di dvec/qDense senza rete ---
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ragdense-'));
  try {
    // due voci con dense finti ortogonali: A allineata alla query, B no
    const a = rag.storeEntry(dir, {
      target_stack: 'Spring Boot', vulnerability_class: 'SQLi',
      solution: 'bypass del waf con commenti inline', tags: ['waf'],
    }, { dvec: [1, 0, 0, 0], dmodel: 'test' });
    const b = rag.storeEntry(dir, {
      target_stack: 'Express Node', vulnerability_class: 'XSS',
      solution: 'escape rotto in attributo html', tags: ['csp'],
    }, { dvec: [0, 1, 0, 0], dmodel: 'test' });
    assert.ok(a.dvec && a.dvec.length === 4, 'dvec persistito nel record A');
    assert.ok(b.dvec && b.dvec.length === 4, 'dvec persistito nel record B');

    // query dense allineata ad A; testo lessicale neutro per isolare il segnale dense
    const hybrid = rag.recallEntries(dir, 'qualcosa di generico', { qDense: [1, 0, 0, 0], alpha: 1, limit: 2 });
    assert.ok(hybrid.length >= 1, 'recall ibrido restituisce risultati');
    assert.strictEqual(hybrid[0].rec.id, a.id, 'con alpha=1 vince il record col dense allineato (A)');
    assert.strictEqual(hybrid[0].mode, 'hybrid', 'modalità ibrida attiva quando c\'è qDense+dvec');
    assert.ok(Math.abs(hybrid[0].dense - 1) < 1e-6, 'dense cosine ~1 per A');

    // senza qDense: puramente lessicale, nessun crash, mode=lex
    const lex = rag.recallEntries(dir, 'waf bypass spring', { limit: 2 });
    assert.ok(lex.every((h) => h.mode === 'lex'), 'senza qDense il recall è lessicale');

    // reembed richiede il backend: senza, deve fallire in modo pulito (non corrompere lo store)
    await assert.rejects(() => rag.reembedAll(dir), /backend dense non configurato/, 'reembed senza backend fallisce chiaramente');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log('test-embeddings.js: ALL PASS');
})().catch((e) => { console.error('test-embeddings.js: FAIL —', e.message); process.exit(1); });
