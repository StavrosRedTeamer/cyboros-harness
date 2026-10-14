#!/usr/bin/env node
// test-report-sarif.js — offline, no network, no engagement files touched (fixture scope only).
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { ok, summary, fixture, runCli } = require('./testkit');

const { buildSarif, severityAllowedAt, levelOf, fingerprint, loadFindings } = require('./report-sarif');

const dir = fixture('sarif');
const findingsFile = path.join(dir, 'findings.jsonl');
const out = path.join(dir, 'out.sarif');

function finding(over) {
  return Object.assign({
    severity: 'High',
    title: 'IDOR on orders',
    host: 'target.example',
    endpoint: 'https://target.example/api/orders/1',
    class: 'idor',
    verify_level: 'exploited',
    status: 'confirmed',
    cvss: 7.5,
    cwe: 'CWE-639',
  }, over);
}

// --- the ladder itself: same rule record-finding.js enforces ---------------------------
ok('severity ceiling: exploited allows up to High, proven_impact up to Critical', () => {
  assert.equal(severityAllowedAt('exploited', 'High'), true);
  assert.equal(severityAllowedAt('exploited', 'Critical'), false);
  assert.equal(severityAllowedAt('suspected', 'Low'), true);
  assert.equal(severityAllowedAt('suspected', 'Medium'), false);
  assert.equal(severityAllowedAt('proven_impact', 'Critical'), true);
  assert.equal(severityAllowedAt('proven_impact', 'Info'), true);
});

ok('unclassified findings are not promoted to a level', () => {
  assert.equal(levelOf({ verify_level: 'exploited' }), 'exploited');
  assert.equal(levelOf({}), null);
  assert.equal(levelOf({ verify_level: 'bogus' }), null);
});

// --- document shape --------------------------------------------------------------------
ok('emits a SARIF 2.1.0 run with one result per finding', () => {
  const doc = buildSarif([finding({}), finding({ title: 'Second', class: 'ssrf', cwe: 'CWE-918' })], {});
  assert.equal(doc.version, '2.1.0');
  assert.equal(doc.runs.length, 1);
  assert.equal(doc.runs[0].results.length, 2);
  assert.equal(doc.runs[0].tool.driver.name, 'Cyboros Harness');
});

ok('every result carries a ruleId and a message', () => {
  const doc = buildSarif([finding({})], {});
  const r = doc.runs[0].results[0];
  assert.equal(r.ruleId, 'idor');
  assert.equal(r.message.text, 'IDOR on orders');
});

ok('rules are deduplicated across findings of the same class', () => {
  const doc = buildSarif([finding({}), finding({ title: 'Another idor' })], {});
  const ids = doc.runs[0].tool.driver.rules.map((r) => r.id);
  assert.deepEqual(ids, ['idor']);
});

// --- the part that actually matters: evidence travels with the severity -----------------
ok('properties.cyboros carries verify_level and its ceiling', () => {
  const doc = buildSarif([finding({ verify_level: 'triggered', severity: 'Medium' })], {});
  const p = doc.runs[0].results[0].properties.cyboros;
  assert.equal(p.verify_level, 'triggered');
  assert.equal(p.severity, 'Medium');
  assert.equal(p.severity_ceiling, 'Medium');
});

ok('severity is level-mapped into SARIF error/warning/note', () => {
  const doc = buildSarif([
    finding({ severity: 'Critical', verify_level: 'proven_impact' }),
    finding({ severity: 'Medium', verify_level: 'triggered', class: 'xss' }),
    finding({ severity: 'Low', verify_level: 'suspected', class: 'config' }),
  ], {});
  const lv = doc.runs[0].results.map((r) => r.level);
  assert.deepEqual(lv, ['error', 'warning', 'note']);
});

ok('an unclassified finding is emitted and flagged, never promoted', () => {
  const doc = buildSarif([finding({ verify_level: undefined })], {});
  const p = doc.runs[0].results[0].properties.cyboros;
  assert.equal(p.verify_level, 'unclassified');
  assert.equal(p.severity_ceiling, null);
  assert.equal(doc.runs[0].results.length, 1, 'unclassified must still be reported, not dropped');
});

// --- compatibility window: both key sets are emitted for one release --------------------
ok('the properties bag is emitted under both keys, with identical content', () => {
  const doc = buildSarif([finding({ verify_level: 'triggered', severity: 'Medium' })], {});
  const r = doc.runs[0].results[0].properties;
  assert.deepEqual(r.cyboros, r.stavros);            // a consumer on the old key loses nothing
  assert.equal(r.cyboros.verify_level, 'triggered');
  assert.equal(r.cyboros.severity_ceiling, 'Medium');
  const inv = doc.runs[0].invocations[0].properties;
  assert.deepEqual(inv.cyboros, inv.stavros);
  assert.equal(inv.cyboros.severity_bounded_by_evidence, true);
});

ok('the driver and fingerprint use the new name, and the old keys stay for one release', () => {
  const doc = buildSarif([finding({})], {});
  assert.equal(doc.runs[0].tool.driver.name, 'Cyboros Harness');
  assert.equal(doc.runs[0].tool.driver.informationUri, 'https://github.com/stavrosredteamer/cyboros-harness');
  const fp = doc.runs[0].results[0].partialFingerprints;
  assert.equal(fp.cyborosFindingId, fp.stavrosFindingId);
});

// --- the refusal path: an incoherent record must not be laundered ----------------------
ok('REFUSES a record whose severity exceeds its verification level', () => {
  // A hand-edited / merged findings.jsonl that bypassed record-finding.js's writer.
  const doc = buildSarif([finding({ severity: 'Critical', verify_level: 'suspected' })], {});
  const inv = doc.runs[0].invocations[0].properties.cyboros;
  assert.equal(doc.runs[0].results.length, 0, 'the incoherent result must not be emitted');
  assert.equal(inv.findings_refused, 1);
  assert.equal(inv.findings_refused > 0 ? doc.runs[0].invocations[0].executionSuccessful : true, false);
});

ok('a coherent finding in the same file still exports', () => {
  const doc = buildSarif([
    finding({ severity: 'Critical', verify_level: 'suspected' }),
    finding({ severity: 'High', verify_level: 'exploited' }),
  ], {});
  assert.equal(doc.runs[0].results.length, 1);
  assert.equal(doc.runs[0].invocations[0].properties.cyboros.findings_refused, 1);
  assert.equal(doc.runs[0].invocations[0].properties.cyboros.findings_total, 2);
});

// --- fingerprints: stable across runs, different across findings -----------------------
ok('fingerprint is stable for the same finding and differs across findings', () => {
  const a = fingerprint(finding({}));
  const b = fingerprint(finding({}));
  const c = fingerprint(finding({ title: 'Other' }));
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.equal(a.length, 32);
});

// --- jsonl parsing: a torn last line must not be fatal ----------------------------------
ok('reads oracle/verify/evidence from the field names actually on disk', () => {
  // record-finding.js writes `oracle` as an OBJECT {type,ref,token}, not a flat string.
  const f = finding({
    oracle: { type: 'http-diff', ref: 'artifacts/oracle/x.json#3', token: 'ab12cd' },
    verify: { method: 'GET', url: 'https://target.example/api/orders/1', expect: { status: 200 } },
    evidence: { ref: 'reports/evidence/e1.md' },
    id: 'F-0001',
  });
  const p = buildSarif([f], {}).runs[0].results[0].properties.cyboros;
  assert.equal(p.oracle_ref, 'artifacts/oracle/x.json#3');
  assert.equal(p.oracle_type, 'http-diff');
  assert.equal(p.verify.method, 'GET');
  assert.equal(p.evidence_ref, 'reports/evidence/e1.md');
  assert.equal(p.finding_id, 'F-0001');
});

ok('a finding with no oracle exports null rather than inventing one', () => {
  const p = buildSarif([finding({})], {}).runs[0].results[0].properties.cyboros;
  assert.equal(p.oracle_ref, null);
  assert.equal(p.oracle_type, null);
});

ok('loadFindings skips blank lines and a torn trailing write', () => {
  const f = path.join(dir, 'torn.jsonl');
  fs.writeFileSync(f, JSON.stringify(finding({})) + '\n\n{"severity":"Low","ti');
  const loaded = loadFindings(f);
  assert.equal(loaded.length, 1);
});

ok('loadFindings on a missing file is empty, not a crash', () => {
  assert.deepEqual(loadFindings(path.join(dir, 'nope.jsonl')), []);
});

// --- CLI: writes a file, exits non-zero when it refused something ----------------------
ok('CLI writes a SARIF file and reports counts', () => {
  fs.writeFileSync(findingsFile, [finding({}), finding({ title: 'X', class: 'ssrf', cwe: 'CWE-918' })].map((f) => JSON.stringify(f)).join('\n') + '\n');
  const r = runCli(['tools/report-sarif.js', '--findings', findingsFile, '--out', out], { cwd: path.join(__dirname, '..') });
  assert.equal(r.status, 0, r.stderr);
  const doc = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(doc.runs[0].results.length, 2);
  const sum = JSON.parse(r.stdout.trim());
  assert.equal(sum.sarifVersion, '2.1.0');
  assert.equal(sum.emitted, 2);
});

ok('CLI exits non-zero when it refuses an incoherent record', () => {
  fs.writeFileSync(findingsFile, JSON.stringify(finding({ severity: 'Critical', verify_level: 'suspected' })) + '\n');
  const r = runCli(['tools/report-sarif.js', '--findings', findingsFile, '--out', out], { cwd: path.join(__dirname, '..') });
  assert.equal(r.status, 2, 'a dropped record must not look like a clean scan');
  const sum = JSON.parse(r.stdout.trim());
  assert.equal(sum.refused, 1);
});

summary('test-report-sarif');