#!/usr/bin/env node
// test-tags: offline
// tools/env.js è l'unico posto dove il prefisso vecchio sopravvive: la finestra di deprecazione
// esiste perché un env var caduto non produce un errore visibile, produce report scritti altrove.
const assert = require('assert/strict');
const { ok, summary } = require('./testkit');

function fresh() {
  // Il modulo legge process.env a ogni chiamata: nessuna cache da invalidare, ma il require
  // deve essere ripreso dopo aver manipolato l'ambiente del processo.
  delete require.cache[require.resolve('./env')];
  return require('./env');
}

ok('CYBOROS_* vince su STAVROS_*', () => {
  process.env.CYBOROS_DEMO = 'nuovo';
  process.env.STAVROS_DEMO = 'vecchio';
  const { env } = fresh();
  assert.equal(env('DEMO'), 'nuovo');
  delete process.env.CYBOROS_DEMO; delete process.env.STAVROS_DEMO;
});

ok('STAVROS_* resta leggibile come deprecazione', () => {
  process.env.STAVROS_DEMO = 'vecchio';
  const { env } = fresh();
  assert.equal(env('DEMO'), 'vecchio');
  delete process.env.STAVROS_DEMO;
});

ok('assente del tutto: torna il default, e stringa vuota vale assente', () => {
  const { env } = fresh();
  assert.equal(env('DEMO', 'dflt'), 'dflt');
  process.env.CYBOROS_DEMO = '';
  assert.equal(env('DEMO', 'dflt'), 'dflt');
  delete process.env.CYBOROS_DEMO;
});

summary('test-env');
