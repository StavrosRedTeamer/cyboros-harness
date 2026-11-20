#!/usr/bin/env node
// test-sage-retry.js — un 429 non è un 404.
//
// Il difetto che questo test blocca: qualsiasi fetch fallito finiva in `completedUrls` e non
// veniva più ritentato, quindi un timeout o un 429 di dieci minuti perdeva la fonte per sempre;
// una pagina vuota spariva in silenzio, indistinguibile da una fonte mai provata. Ora i
// transitori vanno in `retry` (riprovati al resume), i permanenti in `discarded` con la ragione.
'use strict';
const assert = require('assert');
const { ok, summary } = require('./testkit');
const sources = require('./sage/sources');
const synth = require('./sage/synth');
const { recordFetchFailure, clearRetry, normUrl } = require('./sage/index');

const CAND = { url: 'https://example.org/a', title: 'A', provider: 'ddg' };
const fresh = () => ({ completedUrls: [], retry: [], discarded: [], sources: [], warnings: [] });
const transient = (msg = 'HTTP 503') => { const e = new Error(msg); e.transient = true; return e; };

ok('status HTTP: 429 e 5xx sono ritentabili, i 4xx no', () => {
  for (const s of [408, 425, 429, 500, 502, 503]) assert.ok(sources.statusIsTransient(s), `atteso transitorio: ${s}`);
  for (const s of [400, 401, 403, 404, 410]) assert.ok(!sources.statusIsTransient(s), `atteso permanente: ${s}`);
});

ok('errore transitorio: va in coda retry e NON viene marcato completato', () => {
  const st = fresh();
  assert.strictEqual(recordFetchFailure({ st, cand: CAND, question: 'q', error: transient() }), 'retry');
  assert.strictEqual(st.retry.length, 1);
  assert.strictEqual(st.retry[0].attempts, 1);
  assert.strictEqual(st.retry[0].question, 'q');
  assert.strictEqual(st.completedUrls.length, 0, 'un transitorio deve poter essere riprovato');
  assert.strictEqual(st.discarded.length, 0);
});

ok('il resume riprova; al terzo tentativo il transitorio diventa uno scarto', () => {
  const st = fresh();
  recordFetchFailure({ st, cand: CAND, question: 'q', error: transient() });
  recordFetchFailure({ st, cand: CAND, question: 'q', error: transient('rete: timeout') });
  assert.strictEqual(st.retry.length, 1, 'stessa URL = una sola voce');
  assert.strictEqual(st.retry[0].attempts, 2);
  assert.strictEqual(recordFetchFailure({ st, cand: CAND, question: 'q', error: transient() }), 'discard');
  assert.strictEqual(st.retry.length, 0);
  assert.ok(st.completedUrls.includes(normUrl(CAND.url)), 'dopo N tentativi non si riprova più');
  assert.ok(/tentativi esauriti/.test(st.discarded[0].reason), st.discarded[0].reason);
});

ok('errore permanente: scartato subito, con la ragione nel report', () => {
  const st = fresh();
  assert.strictEqual(recordFetchFailure({ st, cand: CAND, question: 'q', error: new Error('HTTP 404') }), 'discard');
  assert.strictEqual(st.retry.length, 0);
  assert.ok(st.completedUrls.includes(normUrl(CAND.url)));
  assert.ok(/404/.test(st.discarded[0].reason));
});

ok('pagina troppo corta: scarto meccanico, non un guasto da ritentare', () => {
  const st = fresh();
  const e = sources.discardError('testo utile troppo corto (12 caratteri)');
  assert.strictEqual(recordFetchFailure({ st, cand: CAND, question: 'q', error: e }), 'discard');
  assert.strictEqual(st.retry.length, 0);
  assert.ok(/troppo corto/.test(st.discarded[0].reason), st.discarded[0].reason);
});

ok('clearRetry: una fonte recuperata esce dalla coda', () => {
  const st = fresh();
  recordFetchFailure({ st, cand: CAND, question: 'q', error: transient() });
  clearRetry(st, CAND.url);
  assert.strictEqual(st.retry.length, 0);
});

ok('un transitorio non cancella la voce di coda di un\'altra domanda', () => {
  const st = fresh();
  recordFetchFailure({ st, cand: CAND, question: 'q1', error: transient() });
  recordFetchFailure({ st, cand: { url: 'https://example.org/b' }, question: 'q2', error: transient() });
  assert.strictEqual(st.retry.length, 2);
  clearRetry(st, CAND.url);
  assert.strictEqual(st.retry.length, 1);
  assert.strictEqual(st.retry[0].url, 'https://example.org/b');
});

function report(extra) {
  return synth.renderReport({
    st: { runId: 'r', lane: 'capability', model: 'sage', brief: 'x', startedAt: '2026-11-20T00:00:00Z' },
    sources: [], claims: [], notes: [], proposals: [], summary: 'sintesi',
    dropped: [], metrics: { sources: 0, kept: 0, dropped: 0, minutes: 0, tokPerSec: 0 }, proposalsSkipped: '',
    ...extra,
  });
}

ok('report: le fonti scartate e quelle da riprovare compaiono con la ragione', () => {
  const md = report({
    discarded: [{ provider: 'ddg', url: 'https://example.org/404', reason: 'HTTP 404' }],
    retryPending: [{ provider: 'ddg', url: 'https://example.org/503', attempts: 2, reason: 'HTTP 503' }],
  });
  assert.ok(md.includes('## Fonti scartate'), 'sezione scartate assente');
  assert.ok(/HTTP 404/.test(md));
  assert.ok(md.includes('## Fonti da riprovare'), 'sezione ritentabili assente');
  assert.ok(/\| 2 \| HTTP 503 \|/.test(md), 'tentativi non riportati');
  // Un run pulito non deve portarsi dietro sezioni vuote.
  const clean = report({});
  assert.ok(!clean.includes('## Fonti scartate'));
  assert.ok(!clean.includes('## Fonti da riprovare'));
});

summary('sage-retry');
