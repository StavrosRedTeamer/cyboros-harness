// vendor-dir.js decide QUALE binario viene eseguito (root esterna → workspace legacy), quindi la
// sua risoluzione è una superficie da testare, non da verificare a mano. Era uno dei quattro
// moduli del motore senza alcuna menzione in un test.
// Run: node tools/test-vendor-dir.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { ok, summary, fixture, runCli } = require('./testkit');

const DIR = fixture('vendor-dir');
const EXT = path.join(DIR, 'ext');
const TOOL = path.join(__dirname, 'vendor-dir.js');
const vd = require('./vendor-dir');

function withEnv(over, fn) {
  const saved = {};
  for (const k of Object.keys(over)) { saved[k] = process.env[k]; if (over[k] === undefined) delete process.env[k]; else process.env[k] = over[k]; }
  try { return fn(); } finally {
    for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}

ok('$CYBOROS_VENDOR_DIR vince su tutto', () => {
  withEnv({ CYBOROS_VENDOR_DIR: EXT, XDG_DATA_HOME: path.join(DIR, 'xdg') }, () => {
    assert.strictEqual(vd.vendorRoot(), path.resolve(EXT));
  });
});

ok('senza override vale $XDG_DATA_HOME/stavros/vendor', () => {
  const xdg = path.join(DIR, 'xdg');
  withEnv({ CYBOROS_VENDOR_DIR: undefined, XDG_DATA_HOME: xdg }, () => {
    assert.strictEqual(vd.vendorRoot(), path.join(xdg, 'stavros', 'vendor'));
  });
});

ok('senza né override né XDG si torna a ~/.local/share/stavros/vendor', () => {
  withEnv({ CYBOROS_VENDOR_DIR: undefined, XDG_DATA_HOME: undefined }, () => {
    assert.ok(/\.local[\\/]share[\\/]stavros[\\/]vendor$/.test(vd.vendorRoot()), vd.vendorRoot());
  });
});

ok('resolveVendor trova un file nella root esterna', () => {
  const bin = path.join(EXT, 'tools', 'demo', 'demo-bin');
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(bin, '#!/bin/sh\n');
  withEnv({ CYBOROS_VENDOR_DIR: EXT }, () => {
    assert.strictEqual(vd.resolveVendor('tools/demo/demo-bin'), bin);
    // gli slash iniziali sono normalizzati, non rifiutati (i chiamanti passano path relativi)
    assert.strictEqual(vd.resolveVendor('/tools/demo/demo-bin'), bin);
    // noLegacy continua a trovare la root esterna
    assert.strictEqual(vd.resolveVendor('tools/demo/demo-bin', { noLegacy: true }), bin);
  });
});

ok('un file assente risolve a null (mai un path inventato)', () => {
  withEnv({ CYBOROS_VENDOR_DIR: EXT }, () => {
    assert.strictEqual(vd.resolveVendor('tools/nope/nope-bin'), null);
    assert.strictEqual(vd.resolveVendor('tools/nope/nope-bin', { noLegacy: true }), null);
    assert.strictEqual(vd.resolveVendor(''), null);
    assert.strictEqual(vd.resolveVendor(undefined), null);
  });
});

ok('traversal e NUL sono rifiutati (questo helper sceglie il binario da eseguire)', () => {
  withEnv({ CYBOROS_VENDOR_DIR: EXT }, () => {
    assert.strictEqual(vd.resolveVendor('../../../etc/passwd'), null);
    assert.strictEqual(vd.resolveVendor('tools/../../outside'), null);
    assert.strictEqual(vd.resolveVendor('tools/demo/../demo/demo-bin'), null, 'anche un traversal che torna dentro è rifiutato: il percorso non si interpreta');
    assert.strictEqual(vd.resolveVendor('tools/de\0mo'), null);
  });
});

ok('la CLI stampa la root risolta', () => {
  const r = runCli([TOOL], { env: Object.assign({}, process.env, { CYBOROS_VENDOR_DIR: EXT }) });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout.trim(), path.resolve(EXT));
});

summary('vendor-dir');
