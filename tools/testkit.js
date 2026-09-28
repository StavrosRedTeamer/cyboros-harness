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

// Rende ermetico un test rispetto allo STATO CONDIVISO del workspace: i file che i tool usano
// come stato globale — il limitatore di rate (`tools/.pace.json`), l'audit delle esecuzioni
// (`reports/tmp/run-audit.jsonl`), l'ancora della testa dei finding
// (`reports/tmp/findings-head-anchor.jsonl`), lo stato del proxy di egress
// (`reports/tmp/egress-proxy.json`) — finiscono in una fixture invece che nelle path reali.
//
// Perché serve: senza, due esecuzioni si influenzano a vicenda. Misurato il 2026-09-28: un `last`
// lasciato in `tools/.pace.json` ha portato `test-repeater-e2e` da 3,5 s a 8,3 s (il limitatore
// globale fa attendere la prima richiesta) e un `reports/tmp/egress-proxy.json` di un test ucciso
// a metà forza `HTTP_PROXY=http://127.0.0.1:9098` su OGNI binario spawnato da `run.js` — anche per
// l'operatore, dopo la suite.
//
// Chiamala PRIMA dei `require()` dei moduli che leggono quei path a load-time (`pace.js`,
// `egress-proxy.js`, `proxy-route.js`, `run.js`): come per `PACE_FILE` nei test già ermetici,
// l'ordine conta. Un valore già impostato esplicitamente dal test vince (non lo sovrascrive).
const STATE_ENV = {
  PACE_FILE: 'pace.json',                              // limitatore di rate globale (pace.js)
  RUN_AUDIT_FILE: 'run-audit.jsonl',                   // audit delle esecuzioni (accounting.js, run.js)
  FINDINGS_HEAD_ANCHOR_FILE: 'findings-head-anchor.jsonl', // ancora anti-tamper dei finding
  EGRESS_STATE_FILE: 'egress-proxy.json',              // stato del proxy di egress (run.js inietta HTTP_PROXY)
  OBSCURA_EGRESS_STATE: 'egress-proxy.json',           // stesso stato, letto da obscura.js
  ARTIFACT_LEDGER_FILE: 'artifact-ledger.jsonl',       // registro degli artefatti
  AUDIT_DIR: 'audit',                                  // audit-trail: default <ws>/artifacts/audit
};
function hermetic(tag) {
  const dir = fixture(tag || 'hermetic');
  for (const [k, f] of Object.entries(STATE_ENV)) {
    if (process.env[k] === undefined) process.env[k] = path.join(dir, f);
  }
  return dir;
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
  ok, okAsync, summary, fixture, writeScope, runCli, runCliAsync, hermetic,
  counts: () => ({ pass, fail }),
};
