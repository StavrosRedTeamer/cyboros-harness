// Side log dei fatti di verifica: append-only, incatenato (A3) e ancorato esternamente come
// findings.jsonl. Fail-closed su tutto ciò che non regge SU DISCO.
// Run: node tools/test-verification-log.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { ok, summary, fixture } = require('./testkit');

// Stato tutto in fixture (mai il workspace reale). DSH_WS_ROOT serve perché oracle.js rifiuta di
// scrivere receipt fuori dalla root del workspace (fail-closed per costruzione).
const dir = fixture('verification-log');
process.env.DSH_WS_ROOT = dir;
process.env.VERIFICATIONS_JSONL = path.join(dir, 'reports', 'verifications.jsonl');
process.env.VERIFICATIONS_HEAD_ANCHOR_FILE = path.join(dir, 'reports', 'tmp', 'v-anchor.jsonl');
process.env.ORACLE_LOG = path.join(dir, 'reports', 'tmp', 'oracle-log.jsonl');
process.env.ORACLE_ARTIFACTS = path.join(dir, 'artifacts', 'oracle');

const vlog = require('./verification-log');
const oracle = require('./oracle');
const chain = require('./chain-log');

function receipt(anchor) {
  const r = oracle.writeReceipt({ type: 'http-diff', anchor, data: { detail: 'verification-log test' } });
  assert.ok(r.ok, r.error);
  return { oracle: { type: 'http-diff', ref: r.ref, token: r.token }, evidence_quote: { file: r.ref, text: anchor } };
}

function rec(over) {
  return Object.assign({
    finding_key: 'h||idor', finding_seq: 1, outcome: 'verified',
    reason: '2/2 passed', runs: [{ status: 200, ok: true, reason: 'ok' }], verifier: 'test',
  }, receipt('outcome passed: 2/2 passed'), over || {});
}

// ── rifiuti: una rivendicazione di realtà senza prova su disco non entra nel log ──
ok('un record verified senza oracle è rifiutato', () => {
  const r = vlog.append({ finding_key: 'h||a', finding_seq: 1, outcome: 'verified', reason: 'x' });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /oracle/);
});

ok('un record verified con quote non verbatim è rifiutato', () => {
  const bad = rec({ finding_key: 'h||b' });
  bad.evidence_quote = { file: bad.oracle.ref, text: 'a paraphrase that is not in the file' };
  const r = vlog.append(bad);
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /verbatim|evidence_quote/);
});

ok('un esito failed non richiede un oracle (un tentativo fallito è un fatto)', () => {
  const r = vlog.append({ finding_key: 'h||c', finding_seq: 1, outcome: 'failed', reason: 'run 1/2 failed: status 500 !== 200' });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
});

ok('finding_seq deve essere un intero positivo', () => {
  for (const seq of [undefined, 0, -1, '2', 1.5]) {
    const r = vlog.append(rec({ finding_key: 'h||seq', finding_seq: seq }));
    assert.strictEqual(r.ok, false, `seq ${JSON.stringify(seq)} deve essere rifiutato`);
  }
});

ok('outcome deve essere verified|failed', () => {
  const r = vlog.append(rec({ finding_key: 'h||out', outcome: 'maybe' }));
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /outcome/);
});

// ── scritture ──
ok('un append scrive una riga incatenata e ancora la testa', () => {
  const r = vlog.append(rec());
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.ok(r.head_anchor && r.head_anchor.ok === true, 'ancora esterna scritta');
  const rows = vlog.read();
  const row = rows.find((x) => x.finding_key === 'h||idor');
  assert.strictEqual(row.kind, 'verification');
  assert.strictEqual(row.chain.seq, r.seq, 'la riga annunciata è quella appesa');
  const first = JSON.parse(chain.readLines(vlog.FILE())[0]);
  assert.strictEqual(first.chain.prev_sha256, chain.GENESIS, 'la prima riga del log parte da GENESIS');
});

ok('lo stesso esito identico è deduplicato, non appeso due volte', () => {
  const before = vlog.read().length;
  const r = vlog.append(rec());
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.deduped, true);
  assert.strictEqual(vlog.read().length, before, 'nessuna riga nuova');
});

ok('un esito cambIato è una riga nuova (vince l\'ultimo fatto)', () => {
  const before = vlog.read().length;
  const r = vlog.append({ finding_key: 'h||idor', finding_seq: 1, outcome: 'failed', reason: 'regression on re-run' });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(vlog.read().length, before + 1);
  const rows = vlog.read().filter((x) => x.finding_key === 'h||idor');
  assert.strictEqual(rows[rows.length - 1].outcome, 'failed', 'l\'ultimo record è quello che conta');
});

ok('verify() riporta catena e ancora esterne', () => {
  const r = vlog.verify();
  assert.strictEqual(r.ok, true, r.detail);
  assert.ok(r.chain.chained >= 3, 'almeno tre righe incatenate');
  assert.match(r.detail, /head anchor/);
});

// ── fail-closed: una catena rotta non si estende ──
ok('un append su una catena rotta è rifiutato (fail-closed)', () => {
  const file = vlog.FILE();
  const lines = chain.readLines(file);
  assert.ok(lines.length >= 3, 'servono almeno tre righe per rompere la catena nel mezzo');
  const tampered = JSON.parse(lines[1]);
  tampered.verifier = 'tampered by hand';
  lines[1] = JSON.stringify(tampered);
  fs.writeFileSync(file, lines.join('\n') + '\n');
  const broken = chain.verifyChain(chain.readLines(file));
  assert.strictEqual(broken.ok, false, 'la manomissione è rilevata');
  const r = vlog.append({ finding_key: 'h||after-tamper', finding_seq: 1, outcome: 'failed', reason: 'x' });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /hash-chain broken/);
  assert.match(r.error, /refusing to append/);
});

summary('verification-log');
