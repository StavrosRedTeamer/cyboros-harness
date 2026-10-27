#!/usr/bin/env node
// test-sage-synth.js — il codice fa da giudice sulle proposte.
//
// Tre regole provate qui, tutte senza rete:
//   1. una proposta che non cita un claim VERIFICATO non esiste;
//   2. gli id portano il run (due ricerche nello stesso giorno producevano lo stesso id e
//      `promote` poteva applicare la proposta sbagliata — bug trovato in verifica reale);
//   3. sotto la soglia di claim verificati non si generano proposte, e il report lo dice.
'use strict';
const assert = require('assert');
const { ok, okAsync, summary } = require('./testkit');
const synth = require('./sage/synth');

function fakeLlm(payload) {
  return { async runAgent() { return { text: typeof payload === 'string' ? payload : JSON.stringify(payload), messages: [], finish_reason: 'stop' }; } };
}

const CLAIM = (id) => ({
  id, question: 'q', claim: `affermazione ${id}`, quote: `citazione reale per ${id}`,
  confidence: 'high', source: 'artifacts/sage/x/sources/aa.txt', at: '2026-10-27T00:00:00Z',
});

ok('dedupeClaims: la stessa affermazione da due fonti conta una volta', () => {
  const out = synth.dedupeClaims([
    CLAIM('C-0001'),
    { ...CLAIM('C-0002'), claim: 'Affermazione   C-0001' },   // stesso testo normalizzato
    { ...CLAIM('C-0003'), claim: 'cosa diversa' },
  ]);
  assert.deepStrictEqual(out.map((c) => c.id), ['C-0001', 'C-0003']);
});

ok('validateProposals: scarta senza claim validi, normalizza priorità e sforzo', () => {
  const known = new Set(['C-0001']);
  const out = synth.validateProposals([
    { name: 'Buona', priority: 'P1', riskEffort: 'low', proposal: 'x'.repeat(60), claim_ids: ['C-0001', 'C-9999'] },
    { name: 'Senza evidenza', priority: 'P1', proposal: 'y'.repeat(60), claim_ids: ['C-0404'] },
    { name: 'Senza testo', claim_ids: ['C-0001'] },
  ], known, { idPrefix: 'SAGE-20261027-120000-capability' });
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].riskEffort, 'LOW');
  assert.deepStrictEqual(out[0].claim_ids, ['C-0001']);
  assert.strictEqual(out[0].id, 'SAGE-20261027-120000-capability-01');
  assert.strictEqual(out[0].status, 'draft');
});

ok('validateProposals: id progressivi e unici per run', () => {
  const known = new Set(['C-0001']);
  const raw = [1, 2].map((n) => ({
    name: `P${n}`, proposal: 'z'.repeat(60), claim_ids: ['C-0001'],
  }));
  const a = synth.validateProposals(raw, known, { idPrefix: 'SAGE-20261027-120000-offensive' });
  const b = synth.validateProposals(raw, known, { idPrefix: 'SAGE-20261027-130000-offensive' });
  assert.deepStrictEqual(a.map((p) => p.id), ['SAGE-20261027-120000-offensive-01', 'SAGE-20261027-120000-offensive-02']);
  assert.notStrictEqual(a[0].id, b[0].id);
});

(async () => {
  await okAsync('synthesize: con 2 claim non genera proposte e lo dichiara', async () => {
    const claims = [CLAIM('C-0001'), CLAIM('C-0002')];
    const res = await synth.synthesize({
      llm: fakeLlm({
        summary: 'sintesi',
        notes: [{ title: 'n', body: 'b', claim_ids: ['C-0001'] }],
        proposals: [{ name: 'P', proposal: 'w'.repeat(60), claim_ids: ['C-0001'] }],
      }),
      brief: 'x', lane: 'capability', claims, questions: ['q'], runId: '20261027-120000-capability',
    });
    assert.deepStrictEqual(res.proposals, []);
    assert.ok(/almeno 3 claim/.test(res.proposalsSkipped), res.proposalsSkipped);
    const md = synth.renderReport({
      st: { runId: 'r', lane: 'capability', model: 'sage', brief: 'x', startedAt: '2026-10-27T00:00:00Z' },
      sources: [{ provider: 'local', title: 'refs/x.md', rel: 'artifacts/sage/r/sources/aa.txt', claims: 2 }],
      claims, notes: res.notes, proposals: [], summary: res.summary,
      dropped: [{ reason: 'quote non trovata nel testo', claim: 'c', quote: 'q' }],
      metrics: { sources: 0, kept: 2, dropped: 1, minutes: 1, tokPerSec: 10 }, proposalsSkipped: res.proposalsSkipped,
    });
    assert.ok(md.includes('Non generate:'), md.slice(0, 600));
    assert.ok(md.includes('Citazioni scartate'));
    // La resa per fonte è visibile: è ciò che distingue "non pertinente" da "estrazione rotta".
    assert.ok(/\| local \| refs\/x\.md \| 2 \|/.test(md), md.slice(-900));
  });

  await okAsync('synthesize: con 4 claim tiene solo la proposta che cita un claim reale', async () => {
    const claims = ['C-0001', 'C-0002', 'C-0003', 'C-0004'].map(CLAIM);
    const res = await synth.synthesize({
      llm: fakeLlm({
        summary: 'sintesi',
        notes: [],
        proposals: [
          { name: 'Buona', proposal: 'p'.repeat(60), claim_ids: ['C-0002'], priority: 'P3', riskEffort: 'HIGH' },
          { name: 'Inventata', proposal: 'p'.repeat(60), claim_ids: ['C-0042'] },
        ],
      }),
      brief: 'x', lane: 'offensive', claims, questions: ['q'], runId: '20261027-120000-offensive',
    });
    assert.strictEqual(res.proposals.length, 1);
    assert.strictEqual(res.proposals[0].id, 'SAGE-20261027-120000-offensive-01');
    assert.strictEqual(res.proposals[0].lane, 'offensive');
    assert.strictEqual(res.proposalsSkipped, '');
  });

  await okAsync('synthesize: modello che non produce JSON → note deterministiche, niente proposte', async () => {
    const claims = ['C-0001', 'C-0002', 'C-0003'].map(CLAIM);
    const res = await synth.synthesize({
      llm: fakeLlm('non sono json'), brief: 'x', lane: 'offensive', claims, questions: ['q'], runId: 'r',
    });
    assert.strictEqual(res.origin, 'fallback');
    assert.deepStrictEqual(res.proposals, []);
    assert.ok(res.notes.length > 0, 'le note di fallback devono esistere');
    assert.ok(res.notes[0].body.includes('affermazione C-0001'));
  });

  summary('sage-synth');
})();
