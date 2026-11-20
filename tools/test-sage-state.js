#!/usr/bin/env node
// test-sage-state.js — il budget è tempo ATTIVO, non tempo di calendario.
//
// Il difetto che questo test blocca: un run interrotto (Ctrl-C, sospensione, chiusura del
// laptop) e ripreso il giorno dopo si chiudeva al primo giro con "budget esaurito" e un
// report vuoto marcato `done` — un guasto presentato come esito, la stessa classe del
// resume senza piano. Ora il cronometro si ferma in pausa e riparte al resume.
'use strict';
const assert = require('assert');
const { ok, summary } = require('./testkit');
const state = require('./sage/state');

const NOW = Date.parse('2026-11-20T12:00:00Z');
const ago = (min) => new Date(NOW - min * 60000).toISOString();

ok('budget: stato senza cronometro → wall clock (compatibilità con i run vecchi)', () => {
  const st = { startedAt: ago(60), budgetMin: 90 };
  assert.strictEqual(Math.round(state.budgetLeft(st, NOW)), 30);
});

ok('budget: un resume dopo una pausa non eredita il tempo di calendario', () => {
  // Run di 90 minuti iniziato 24 ore fa: senza cronometro attivo il budget sarebbe -1350.
  const st = { startedAt: ago(24 * 60), budgetMin: 90, budgetSpentMin: 30 };
  state.resumeClock(st, NOW);
  assert.strictEqual(Math.round(state.budgetLeft(st, NOW)), 60);
  assert.strictEqual(Math.round(state.budgetLeft(st, NOW + 10 * 60000)), 50);
});

ok('budget: pauseClock mette da parte il tempo attivo e ferma il conteggio', () => {
  const st = { startedAt: ago(300), budgetMin: 90, budgetSpentMin: 0 };
  state.resumeClock(st, NOW);
  state.pauseClock(st, NOW + 12 * 60000);
  assert.strictEqual(Math.round(st.budgetSpentMin), 12);
  assert.ok(!('activeSince' in st), 'in pausa il cronometro non deve restare acceso');
  // Due ore di pausa non consumano budget: il tempo di calendario non conta più.
  assert.strictEqual(Math.round(state.budgetLeft(st, NOW + 132 * 60000)), 78);
});

ok('budget: resumeClock riparte dal tempo accumulato, non da zero', () => {
  const st = { startedAt: ago(300), budgetMin: 90, budgetSpentMin: 20 };
  state.pauseClock(st, NOW);
  assert.strictEqual(Math.round(st.budgetSpentMin), 20);
  state.resumeClock(st, NOW + 60 * 60000);
  assert.strictEqual(Math.round(state.budgetLeft(st, NOW + 65 * 60000)), 65);
});

ok('activeMin: usa il tempo attivo quando c\'è, il wall clock quando il run è vecchio', () => {
  const legacy = { startedAt: ago(45), budgetMin: 90 };
  assert.strictEqual(Math.round(state.activeMin(legacy, NOW)), 45);
  const tracked = { startedAt: ago(45), budgetMin: 90, budgetSpentMin: 5 };
  assert.strictEqual(Math.round(state.activeMin(tracked, NOW)), 5);
});

summary('sage-state');
