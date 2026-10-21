#!/usr/bin/env node
// test-gui-theme.js — contratti statici della GUI (tema professionale + guida), zero dipendenze, offline.
//
// Perché esiste: il tema "pro" e la guida interattiva vivono in assets serviti su loopback
// (tools/gui/app.pro.css, tools/gui/guide.js) senza build e senza un gate che li guardi. Senza
// questo test, una regressione silenziosa — il default che torna "cyberdeck", un asset referenziato
// e mai committato, un URL esterno che rompe l'opsec zero-egress, o l'auto-apertura della guida che
// diventa persistente — passerebbe inosservata finché un clone non si rompe o un dato esce. Qui quei
// contratti diventano asserzioni. Non è un linter di stile: controlla solo proprietà che, se violate,
// sono difetti reali (default sbagliato, asset mancante, egress, rumore all'avvio).
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { ok, summary } = require('./testkit');

const GUI = path.join(__dirname, 'gui');
const read = (f) => fs.readFileSync(path.join(GUI, f), 'utf8');
const index = read('index.html');
const proCss = read('app.pro.css');
const guide = read('guide.js');

ok('index.html: il tema di default è "pro" (enterprise), non il cyberdeck', () => {
  // lo script inline applica il tema persistito con fallback 'pro', e l'overlay è un <link> attivo.
  assert.ok(/getItem\(\s*['"]cyboros-theme['"]\s*\)\s*\|\|\s*['"]pro['"]/.test(index),
    "l'inline theme script non usa 'pro' come default");
  assert.ok(/id=["']theme-pro-css["'][^>]*href=["']app\.pro\.css["']/.test(index),
    "manca il <link id=theme-pro-css href=app.pro.css> dell'overlay professionale");
});

ok('index.html: la topbar aggancia il pulsante Guida e carica guide.js', () => {
  assert.ok(/id=["']btn-guide["']/.test(index), 'manca il pulsante #btn-guide nella topbar');
  assert.ok(/<script[^>]+src=["']guide\.js["']/.test(index), 'index.html non carica guide.js');
  assert.ok(/<script[^>]+src=["']app\.js["']/.test(index), 'index.html non carica app.js');
});

ok('index.html: ogni asset locale referenziato esiste su disco (niente link morti nel clone)', () => {
  const refs = [];
  const re = /(?:href|src)=["']([^"']+)["']/g;
  let m;
  while ((m = re.exec(index))) {
    const u = m[1];
    if (/^(https?:)?\/\//.test(u) || u.startsWith('data:') || u.startsWith('#')) continue; // esterni/inline: non qui
    refs.push(u.replace(/^\.?\//, ''));
  }
  const missing = refs.filter((r) => !fs.existsSync(path.join(GUI, r)));
  assert.deepStrictEqual(missing, [], 'asset referenziati ma assenti in tools/gui/: ' + missing.join(', '));
});

ok("overlay e guida non usano '!important' (l'overlay vince per ordine di layer, non a forza)", () => {
  assert.ok(!/!important/.test(proCss), "app.pro.css contiene '!important'");
  assert.ok(!/!important/.test(guide), "guide.js contiene '!important'");
});

ok('opsec: la guida è offline — nessuna chiamata di rete e nessun URL esterno', () => {
  const net = [/\bfetch\s*\(/, /XMLHttpRequest/, /new\s+WebSocket/, /\bEventSource\b/, /\bimport\s*\(/, /navigator\.sendBeacon/];
  const hit = net.filter((r) => r.test(guide)).map((r) => r.source);
  assert.deepStrictEqual(hit, [], 'guide.js contiene primitive di rete: ' + hit.join(', '));
  assert.ok(!/https?:\/\//.test(guide), 'guide.js contiene un URL esterno');
  assert.ok(!/https?:\/\//.test(proCss), 'app.pro.css contiene un URL esterno (rompe zero-egress/offline)');
});

ok('guida: auto-apertura solo al primo avvio, memorizzata in localStorage', () => {
  assert.ok(/cyboros-guide-seen/.test(guide), "manca il flag localStorage 'cyboros-guide-seen'");
  // il flag viene SCRITTO (altrimenti l'auto-apertura si ripeterebbe ad ogni avvio)
  assert.ok(/setItem\(\s*['"]cyboros-guide-seen['"]/.test(guide), "il flag di prima-apertura non viene salvato");
});

summary('gui-theme');
