// Vista effettiva: findings.jsonl (immutabile) fuso col side log delle verifiche. Le regole del
// fold, una per test — compresa quella che conta: senza side log la vista è IDENTICA alle righe
// registrate (retrocompatibilità), e la vista non promuove mai più di quanto il disco provi.
// Run: node tools/test-effective-findings.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { ok, summary, fixture } = require('./testkit');

// Ogni test ha la SUA fixture: i record si accumulano nel log, quindi condividere una directory
// significherebbe che un test legge gli esiti di un altro.
let DIR = '';
function reset() {
  DIR = fixture('effective-findings');
  process.env.DSH_WS_ROOT = DIR;
  process.env.FINDINGS_JSONL = path.join(DIR, 'reports', 'findings.jsonl');
  process.env.VERIFICATIONS_JSONL = path.join(DIR, 'reports', 'verifications.jsonl');
  process.env.VERIFICATIONS_HEAD_ANCHOR_FILE = path.join(DIR, 'reports', 'tmp', 'v-anchor.jsonl');
  process.env.ORACLE_LOG = path.join(DIR, 'reports', 'tmp', 'oracle-log.jsonl');
  process.env.ORACLE_ARTIFACTS = path.join(DIR, 'artifacts', 'oracle');
  return DIR;
}
reset();

const chain = require('./chain-log');
const vlog = require('./verification-log');
const eff = require('./effective-findings');
const oracle = require('./oracle');
const { key: keyOf } = require('./record-finding');

function writeFindings(rows) {
  const lines = [];
  for (const r of rows) lines.push(chain.buildChainedLine(Object.assign({}, r), lines));
  fs.mkdirSync(path.dirname(process.env.FINDINGS_JSONL), { recursive: true });
  fs.writeFileSync(process.env.FINDINGS_JSONL, lines.join('\n') + '\n');
}

function receipt(anchor) {
  const r = oracle.writeReceipt({ type: 'http-diff', anchor, data: { detail: 'effective-findings test' } });
  assert.ok(r.ok, r.error);
  return { oracle: { type: 'http-diff', ref: r.ref, token: r.token }, evidence_quote: { file: r.ref, text: anchor } };
}

function promote(finding, seq, anchor) {
  const r = vlog.append(Object.assign({
    finding_key: keyOf(finding), finding_seq: seq, outcome: 'verified',
    reason: '2/2 passed', verifier: 'test',
  }, receipt(anchor)));
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  return r;
}

// L'ultimo record scritto per una chiave (per sapere quale receipt cancellare).
function lastRecord(key) {
  const rows = vlog.read().filter((x) => x.finding_key === key);
  return rows[rows.length - 1];
}

const F1 = { severity: 'High', title: 'idor', host: 'h', endpoint: '/api/x', poc: 'x', status: 'confirmed', verify_level: 'exploited' };
const F2 = { severity: 'Medium', title: 'bfla', host: 'h', endpoint: '/api/y', poc: 'y', status: 'confirmed', verify_level: 'exploited' };
const F3 = { severity: 'Low', title: 'xss', host: 'h', endpoint: '/api/z', poc: 'z', status: 'inconclusive' };

ok('senza side log la vista è identica alle righe registrate (retrocompatibile)', () => {
  reset();
  writeFindings([F1, F2, F3]);
  const { findings, diagnostics } = eff.effectiveFindings();
  assert.strictEqual(findings.length, 3);
  assert.deepStrictEqual(diagnostics, [], 'nessuna diagnostica senza record');
  for (const f of findings) {
    assert.strictEqual(f.effective_status, f.registered_status, 'nessuna promozione senza record');
    assert.strictEqual(f.verified, false);
    assert.strictEqual(f.verification, null);
  }
});

ok('un esito verified con receipt valido sul disco promuove il finding', () => {
  reset();
  writeFindings([F1]);
  promote(F1, 1, 'outcome passed: F1 verified');
  const f = eff.effectiveFindings().findings[0];
  assert.strictEqual(f.effective_status, 'verified');
  assert.strictEqual(f.status, 'verified', 'status effettivo: la vista è drop-in per i consumer');
  assert.strictEqual(f.registered_status, 'confirmed', 'lo stato registrato resta leggibile');
  assert.strictEqual(f.verified, true);
  assert.ok(f.verified_at, 'verified_at preso dal record');
  assert.ok(f.oracle && f.oracle.ref.includes('artifacts/oracle/'), 'l\'oracle effettivo è quello del record');
  assert.strictEqual(f.verification.outcome, 'verified');
});

ok('un esito failed non promuove e resta visibile come fallimento', () => {
  reset();
  writeFindings([F2]);
  const r = vlog.append({ finding_key: keyOf(F2), finding_seq: 1, outcome: 'failed', reason: 'run 2/2 failed: status 403 !== 200' });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  const { findings, diagnostics } = eff.effectiveFindings();
  const f = findings[0];
  assert.strictEqual(f.effective_status, 'confirmed', 'nessuna promozione da un esito negativo');
  assert.strictEqual(f.verify_failed, true);
  assert.match(f.verify_reason, /403/);
  assert.ok(diagnostics.some((d) => /failed/.test(d.reason)), 'il fallimento è diagnosticato');
});

ok('se l\'oracolo sparisce dal disco la promozione cade (si ri-valida al fold)', () => {
  reset();
  const f3 = Object.assign({}, F3, { status: 'confirmed', verify_level: 'triggered' });
  writeFindings([f3]);
  promote(f3, 1, 'outcome passed: F3 verified');
  const artifact = path.join(DIR, lastRecord(keyOf(f3)).oracle.ref);
  assert.ok(fs.existsSync(artifact), 'il receipt esiste prima');
  fs.rmSync(artifact, { force: true });
  const { findings, diagnostics } = eff.effectiveFindings();
  assert.strictEqual(findings[0].effective_status, 'confirmed', 'nessuna promozione');
  assert.ok(diagnostics.some((d) => /no longer validates/.test(d.reason)), JSON.stringify(diagnostics));
});

ok('un record che punta a una riga successiva non si applica', () => {
  reset();
  writeFindings([F1, F2, F3]);
  const r = vlog.append(Object.assign({
    finding_key: keyOf(F3), finding_seq: 9, outcome: 'verified', reason: '2/2 passed', verifier: 'test',
  }, receipt('outcome passed: F3 earlier')));
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  const view = eff.effectiveFindings();
  assert.notStrictEqual(view.findings[2].effective_status, 'verified', 'una verifica non anticipa ciò che verifica');
  assert.ok(view.diagnostics.some((d) => /later finding line/.test(d.reason)), JSON.stringify(view.diagnostics));
});

ok('con più record per la stessa chiave vince l\'ultimo', () => {
  reset();
  writeFindings([F1]);
  promote(F1, 1, 'outcome passed: first');
  assert.strictEqual(eff.effectiveFindings().findings[0].effective_status, 'verified');
  const r = vlog.append({ finding_key: keyOf(F1), finding_seq: 1, outcome: 'failed', reason: 'regressioned on re-run' });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  const f = eff.effectiveFindings().findings[0];
  assert.strictEqual(f.effective_status, 'confirmed', 'l\'ultimo esito è un fallimento');
  assert.strictEqual(f.verify_failed, true);
});

ok('isPending è falsificabile: rivendica realtà senza prova valida → pendente', () => {
  reset();
  const good = Object.assign({ severity: 'High', title: 'good', host: 'h', endpoint: '/api/g', poc: 'g', status: 'confirmed' }, receipt('outcome passed: oracle-only'));
  writeFindings([
    { severity: 'High', title: 'no-oracle', host: 'h', poc: 'x', status: 'confirmed', oracle: { type: 'http-diff', ref: 'artifacts/oracle/missing.json', token: 'deadbeefdeadbeef' } },
    good,
    F3,
  ]);
  const rows = eff.effectiveFindings().findings;
  assert.strictEqual(eff.isPending(rows[0]), true, 'reality claim il cui oracle non regge più → pendente');
  assert.strictEqual(eff.isPending(rows[1]), false, 'reality claim con oracle valido → risolto (provato fino a confirmed)');
  assert.strictEqual(eff.isPending(rows[2]), false, 'livello ipotesi (inconclusive) → non pendente');
  const pending = eff.pendingFindings();
  assert.strictEqual(pending.length, 1, JSON.stringify(pending));
  assert.strictEqual(pending[0].key, 'h||no-oracle');
});

ok('un esito verificato ma non promuovibile rende il finding pendente', () => {
  reset();
  const f = { severity: 'High', title: 'rot', host: 'h', poc: 'x', status: 'confirmed' };
  writeFindings([f]);
  promote(f, 1, 'outcome passed: rot');
  fs.rmSync(path.join(DIR, lastRecord(keyOf(f)).oracle.ref), { force: true });
  const rows = eff.effectiveFindings().findings;
  assert.strictEqual(rows[0].effective_status, 'confirmed');
  assert.strictEqual(eff.isPending(rows[0]), true, 'una verifica registrata ma non sostanziabile è un pendente');
});

ok('--out esporta un ARRAY JSON, cioe` il formato che gen-bench.js eval accetta', () => {
  reset();
  writeFindings([F3]);
  const dest = path.join(DIR, 'out.json');
  const r = spawnSync(process.execPath, [path.join(__dirname, 'effective-findings.js'), 'list', '--out', dest], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  const parsed = JSON.parse(fs.readFileSync(dest, 'utf8'));
  assert.ok(Array.isArray(parsed), 'l\'export deve essere un array: {findings} viene respinto da eval');
  assert.strictEqual(parsed.length, 1);
  assert.strictEqual(r.stdout.trim(), dest + ' (1 findings)');
});

ok('--out senza percorso e` un usage error, non un file scritto a metà', () => {
  reset();
  const r = spawnSync(process.execPath, [path.join(__dirname, 'effective-findings.js'), 'list', '--out'], { encoding: 'utf8' });
  assert.strictEqual(r.status, 2, r.stdout);
});

summary('effective-findings');
