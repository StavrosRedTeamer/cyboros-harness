#!/usr/bin/env node
// test-kit.js — scaffolding condiviso delle suite (zero dipendenze, nessuna magia).
//
// Perché esiste: 30+ file di test reimplementavano lo stesso contatore pass/fail, lo stesso
// `ok()`, lo stesso riassunto e lo stesso `process.exit(fail ? 1 : 0)`. Trenta copie dello stesso
// codice sono trenta posti dove correggere lo stesso bug (il formato del messaggio di fallimento
// era già divergente in tre varianti), e sono il motivo per cui la suite pesa 14k righe contro
// 33k di motore.
//
// Uso:
//   const { ok, okAsync, summary, fixture, writeScope, runCli } = require('./test-kit');
//   ok('descrizione', () => { assert.strictEqual(a, b); });
//   await okAsync('descrizione async', async () => { ... });
//   summary('nome-suite');   // stampa il riassunto ed esce con 0/1
//
// I test vengono passati come `check(name, fn)` in due dialetti storici (`ok`/`check`): sono lo
// stesso contratto, esportati entrambi per non riscrivere i call-site.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

let pass = 0;
let fail = 0;

function report(name, e) {
  fail++;
  const first = e && e.message ? String(e.message).split('\n')[0] : String(e);
  console.log(`  FAIL ${name} :: ${first}`);
}

function ok(name, fn) {
  try { fn(); pass++; console.log(`  PASS ${name}`); }
  catch (e) { report(name, e); }
}

async function okAsync(name, fn) {
  try { await fn(); pass++; console.log(`  PASS ${name}`); }
  catch (e) { report(name, e); }
}

// Riassunto + exit code: il gate del runner è l'exit code, mai l'output.
function summary(label) {
  const who = label ? `${label}: ` : '';
  console.log(`\n${who}${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
}

// Directory temporanea per fixture: SEMPRE dentro mkdtemp, mai path reali del repo.
function fixture(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${tag || 'test'}-`));
}

// Scope di comodo per un test: scrive il file e restituisce il path da mettere in SCOPE_JSON.
function writeScope(dir, obj) {
  const file = path.join(dir, 'scope.json');
  fs.writeFileSync(file, JSON.stringify(obj));
  return file;
}

// Processo figlio SINCRONO: solo per target che non vivono in questo processo (un server di
// fixture nello stesso processo verrebbe congelato dal blocco dell'event loop).
function runCli(args, opts) {
  const o = opts || {};
  return spawnSync(process.execPath, args, {
    cwd: o.cwd, env: o.env, encoding: 'utf8', timeout: o.timeout || 60000,
  });
}

// Processo figlio ASINCRONO: obbligatorio quando il target è servito da questo stesso processo.
function runCliAsync(args, opts) {
  const o = opts || {};
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: o.cwd, env: o.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => resolve({ status: -1, stdout, stderr: String(e) }));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

module.exports = {
  ok, okAsync, summary, fixture, writeScope, runCli, runCliAsync,
  counts: () => ({ pass, fail }),
};
