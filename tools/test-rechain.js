// rechain.js: riconciliazione di una catena rotta. Il punto del test è la differenza tra una
// ricatena INGENUA (che passa da "catena rotta" a "catena manomessa") e una riconciliazione
// REGISTRATA: backup, evento nell'anchor log, e ancora nuova coerente.
// Include il caso insidioso: l'ultima riga manomessa NON rompe la catena (nessuna riga dopo di
// lei la controlla) e si vede solo dal mismatch con l'ancora esterna.
// Run: node tools/test-rechain.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { ok, summary, fixture } = require('./testkit');

let DIR = '';
function reset() {
  DIR = fixture('rechain');
  process.env.DSH_WS_ROOT = DIR;
  process.env.FINDINGS_JSONL = path.join(DIR, 'reports', 'findings.jsonl');
  process.env.FINDINGS_HEAD_ANCHOR_FILE = path.join(DIR, 'reports', 'tmp', 'findings-head-anchor.jsonl');
  process.env.ORACLE_LOG = path.join(DIR, 'reports', 'tmp', 'oracle-log.jsonl');
  process.env.ORACLE_ARTIFACTS = path.join(DIR, 'artifacts', 'oracle');
  return DIR;
}
reset();

const rf = require('./record-finding');
const rechain = require('./rechain');
const chain = require('./chain-log');

const FILE = () => process.env.FINDINGS_JSONL;
const ANCHOR = () => process.env.FINDINGS_HEAD_ANCHOR_FILE;

// Un finding che NON rivendica realtà: nessun oracle richiesto, quindi il test misura la catena
// e non lo strato della prova (coperto da test-record-finding / test-effective-findings).
function record(title) {
  const r = rf.record(JSON.stringify({ severity: 'Low', title, host: 'h', poc: 'x', status: 'inconclusive' }));
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  return r;
}

function rewriteLine(n, mutate) {
  const lines = chain.readLines(FILE());
  const obj = JSON.parse(lines[n - 1]);
  mutate(obj);
  lines[n - 1] = JSON.stringify(obj);
  fs.writeFileSync(FILE(), lines.join('\n') + '\n');
}

function setupThree() {
  reset();
  record('one'); record('two'); record('three');
  assert.strictEqual(chain.verifyChain(chain.readLines(FILE())).ok, true, 'catena sana dopo tre record');
  assert.strictEqual(rechain.plan().healthy, true, 'log sano');
}

ok('plan() legge catena e ancora esterna e dichiara il log sano', () => {
  setupThree();
  const p = rechain.plan();
  assert.strictEqual(p.chain.chained, 3);
  assert.strictEqual(p.legacy_preserved, 0);
  assert.strictEqual(p.would_rechain, 3);
  assert.strictEqual(p.first_chained_line, 1);
  assert.ok(p.head && p.head.seq === 3);
});

ok('run() rifiuta di riscrivere un log sano (anche con motivo valido)', () => {
  setupThree();
  const before = fs.readFileSync(FILE());
  const r = rechain.run({ reason: 'non dovrebbe servire' });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /intact|healthy/);
  assert.deepStrictEqual(fs.readFileSync(FILE()), before, 'file intatto: nessuna riscrittura');
});

ok('run() senza --confirm non tocca nulla (confirm-tier)', () => {
  setupThree();
  rewriteLine(2, (o) => { o.title = 'two-tampered'; });
  const before = fs.readFileSync(FILE());
  const r = rechain.run({});
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /reason is required/);
  assert.deepStrictEqual(fs.readFileSync(FILE()), before, 'file intatto: nessun --confirm, nessuna scrittura');
});

ok('ULTIMA riga manomessa: la catena resta valida, l\'ancora no — e run() ripara', () => {
  setupThree();
  rewriteLine(3, (o) => { o.title = 'three-tampered'; });
  assert.strictEqual(chain.verifyChain(chain.readLines(FILE())).ok, true, 'la catena da sola non lo vede (nessuna riga dopo)');
  const p = rechain.plan();
  assert.strictEqual(p.healthy, false, 'l\'ancora esterna sì: log non sano');
  assert.match(p.anchor.detail, /mismatch/);
  const r = rechain.run({ reason: 'title changed by hand while editing the log; verified against my notes' });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.ok(fs.existsSync(r.backup), 'backup scritto prima di toccare l\'originale');
  const after = rechain.plan();
  assert.strictEqual(after.chain.ok, true, 'catena ricostruita');
  assert.strictEqual(after.anchor.ok, true, 'ancora nuova coerente con la testa');
  assert.strictEqual(after.healthy, true);
  const title = JSON.parse(chain.readLines(FILE())[2]).title;
  assert.strictEqual(title, 'three-tampered', 'il contenuto NON viene riscritto: la ricatena tocca solo `chain`');
});

ok('riga centrale manomessa: catena rotta, run() ripara e REGISTRA l\'evento', () => {
  setupThree();
  rewriteLine(2, (o) => { o.title = 'two-tampered'; });
  const p = rechain.plan();
  assert.strictEqual(p.healthy, false);
  assert.strictEqual(p.chain.ok, false);
  assert.match(p.chain.reason, /prev_sha256 mismatch/);
  const r = rechain.run({ reason: 'byte flipped mid-log by a failing editor' });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(r.break_reason && /prev_sha256 mismatch/.test(r.break_reason), true, String(r.break_reason));
  assert.strictEqual(rechain.plan().healthy, true);
  // La storia della riscrittura è un FATTO leggibile nell'anchor log, non un'anomalia.
  const anchors = chain.readJsonl(ANCHOR());
  const ev = anchors.filter((a) => a.kind === 'findings-rechain');
  assert.strictEqual(ev.length, 1, 'una voce di riconciliazione');
  assert.match(ev[0].reason, /byte flipped/);
  assert.ok(ev[0].old_head_sha256 && ev[0].new_head_sha256, 'testa vecchia e nuova entrambe registrate');
  assert.ok(ev[0].backup, 'il backup è citato dalla voce');
  assert.notStrictEqual(ev[0].old_head_sha256, ev[0].new_head_sha256);
  // E la verifica standard ora vede la riscrittura come riconciliata, non come manomissione.
  const vh = rf.verifyHeadAnchor();
  assert.strictEqual(vh.ok, true, vh.detail);
  assert.match(vh.detail, /riconciliazione/);
});

ok('un log solo-legacy non ha una catena da ricostruire', () => {
  reset();
  fs.mkdirSync(path.dirname(FILE()), { recursive: true });
  fs.writeFileSync(FILE(), JSON.stringify({ severity: 'Low', title: 'legacy', host: 'h', poc: 'x', status: 'inconclusive' }) + '\n');
  const rb = rechain.rebuild(FILE());
  assert.strictEqual(rb.ok, false);
  assert.match(rb.error, /no chained line/);
});

ok('una riga non parsabile DENTRO il suffisso incatenato blocca la ricatena', () => {
  setupThree();
  const lines = chain.readLines(FILE());
  lines[1] = '{not json';
  fs.writeFileSync(FILE(), lines.join('\n') + '\n');
  const rb = rechain.rebuild(FILE());
  assert.strictEqual(rb.ok, false);
  assert.match(rb.error, /not a JSON object/);
});

summary('rechain');
