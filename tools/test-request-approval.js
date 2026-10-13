// request-approval.js è il lato AGENTE del consent token: deposita la richiesta e riporta lo
// stato. Era uno dei quattro moduli del motore senza alcuna menzione in un test — e sta sul
// percorso che il THREAT-MODEL §5 nomina. Qui si prova il glue (parsing CLI + delega a
// cc-approvals + exit code), mentre il token in sé è coperto da test-cc-approvals.
// Run: node tools/test-request-approval.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { ok, summary, fixture, runCli } = require('./testkit');

const DIR = fixture('request-approval');
const TOOL = path.join(__dirname, 'request-approval.js');
const CC = path.join(__dirname, 'cc-approvals.js');
const ROOT = path.join(__dirname, '..');

process.env.CC_APPROVALS_FILE = path.join(DIR, 'approvals.jsonl');
process.env.CC_OPSTATE_FILE = path.join(DIR, 'operation-state.json');
process.env.SCOPE_JSON = path.join(DIR, 'scope.json');
fs.writeFileSync(process.env.SCOPE_JSON, JSON.stringify({ allowed_hosts: ['lab.local'] }));

const cli = (args) => runCli([TOOL].concat(args), { cwd: ROOT, env: process.env });
const cc = (args) => runCli([CC].concat(args), { cwd: ROOT, env: process.env });

ok('senza --host/--action esce 2 con la usage (nessuna richiesta depositata)', () => {
  const before = fs.existsSync(process.env.CC_APPROVALS_FILE) ? fs.readFileSync(process.env.CC_APPROVALS_FILE, 'utf8') : '';
  const r = cli(['--action', 'c2']);
  assert.strictEqual(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /usage/);
  const after = fs.existsSync(process.env.CC_APPROVALS_FILE) ? fs.readFileSync(process.env.CC_APPROVALS_FILE, 'utf8') : '';
  assert.strictEqual(after, before, 'usage path: nessuna scrittura');
});

ok('una richiesta valida deposita il token e stampa l\'id', () => {
  const r = cli(['--host', 'lab.local', '--action', 'c2', '--command', 'nmap lab.local', '--reason', 'test', '--ttl', '120']);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  const j = JSON.parse(r.stdout);
  assert.strictEqual(j.ok, true);
  assert.match(j.id, /^ap-[0-9a-f]{12}$/);
  assert.strictEqual(j.scope_verdict, 'allowed', 'il verdetto di scope viene dal runtime, non dal chiamante');
  assert.match(j.message, /approval requested/);
  // Il valore arriva allo STORE (request() non ri-espone ttl_sec: la prova è la riga depositata).
  const row = fs.readFileSync(process.env.CC_APPROVALS_FILE, 'utf8').split('\n').filter(Boolean)
    .map((l) => JSON.parse(l)).find((x) => x.id === j.id);
  assert.strictEqual(row.type, 'request');
  assert.strictEqual(row.ttl_sec, 120, '--ttl arriva allo store');
  assert.strictEqual(row.host, 'lab.local');
  assert.strictEqual(row.requested_by, 'agent');
});

ok('`status <id>` su una richiesta pendente esce 3 ("aspetto l\'operatore")', () => {
  const req = JSON.parse(cli(['--host', 'lab.local', '--action', 'c2', '--command', 'nmap lab.local']).stdout);
  const r = cli(['status', req.id]);
  assert.strictEqual(r.status, 3, r.stdout + r.stderr);
  assert.strictEqual(JSON.parse(r.stdout).status, 'pending');
});

ok('`status <id>` dopo il grant esce 0 e nomina l\'operatore', () => {
  const req = JSON.parse(cli(['--host', 'lab.local', '--action', 'c2', '--command', 'nmap lab.local']).stdout);
  assert.strictEqual(cc(['grant', req.id, '--by', 'operator', '--note', 'ontest']).status, 0);
  const r = cli(['status', req.id]);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  const j = JSON.parse(r.stdout);
  assert.strictEqual(j.status, 'granted');
  assert.strictEqual(j.granted_by, 'operator');
});

ok('`status` di un id sconosciuto esce 1 con un errore esplicito', () => {
  const r = cli(['status', 'ap-nope']);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /unknown approval id/);
});

ok('un host fuori scope produce un verdetto bloccato (fail-closed)', () => {
  const r = cli(['--host', 'evil.example', '--action', 'c2', '--command', 'nmap evil.example']);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.strictEqual(JSON.parse(r.stdout).scope_verdict, 'blocked');
});

summary('request-approval');
