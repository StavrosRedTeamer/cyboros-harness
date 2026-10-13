// Offline self-check for the oracle verifier (security/correctness path -> must have a test).
// Run: node tools/test-verify-finding.js
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
const HERM = require('./testkit').hermetic('verify-finding'); // stato condiviso in fixture, non nel workspace (vedi testkit.js)
// Ondata 7: i receipt dell'oracolo devono vivere DENTRO la root del workspace (fail-closed), quindi
// la fixture è anche la ws-root di questo test.
process.env.DSH_WS_ROOT = HERM;
process.env.ORACLE_LOG = path.join(HERM, 'reports', 'tmp', 'oracle-log.jsonl');
process.env.ORACLE_ARTIFACTS = path.join(HERM, 'artifacts', 'oracle');
const { verifyOne, checkExpect } = require('./verify-finding');

// mock exec: returns canned responses in order, repeating the last one.
const mk = (responses) => { let i = 0; return async () => responses[i++] || responses[responses.length - 1]; };

(async () => {
  // status + body_contains, N/N pass -> verified
  let r = await verifyOne(
    { verify: { url: 'https://h/x', expect: { status: 200, body_contains: 'marker' } } },
    { times: 2, exec: mk([{ status: 200, body: 'has marker here' }, { status: 200, body: 'has marker here' }]) });
  assert.strictEqual(r.verified, true, 'N/N pass -> verified');
  assert.strictEqual(r.runs.length, 2);

  // one run fails expect.status -> not verified (fails fast)
  r = await verifyOne(
    { verify: { url: 'https://h/x', expect: { status: 200 } } },
    { times: 2, exec: mk([{ status: 200, body: '' }, { status: 500, body: '' }]) });
  assert.strictEqual(r.verified, false, 'a failing run -> not verified');

  // body_contains missing -> not verified
  r = await verifyOne(
    { verify: { url: 'https://h/x', expect: { status: 200, body_contains: 'secret' } } },
    { times: 1, exec: mk([{ status: 200, body: 'nope' }]) });
  assert.strictEqual(r.verified, false);

  // body_similarity_to: exec is called once for baseline, then per run
  r = await verifyOne(
    { verify: { url: 'https://h/2', expect: { status: 200, body_similarity_to: 'https://h/1' } } },
    { times: 1, exec: mk([{ status: 200, body: 'alpha beta gamma delta' }, { status: 200, body: 'alpha beta gamma omega' }]) });
  assert.strictEqual(r.verified, true, 'similar bodies (0.75 >= 0.6) pass');

  // no verify block -> verified:false, clear reason
  r = await verifyOne({ title: 'x' }, {});
  assert.strictEqual(r.verified, false);
  assert.match(r.reason, /no verify/);

  // verifyFile: in-place update of findings that carry a verify block (mock exec)
  const { verifyFile } = require('./verify-finding');
  const vtmp = path.join(os.tmpdir(), 'vf-' + process.pid + '.jsonl');
  fs.writeFileSync(vtmp,
    JSON.stringify({ title: 'a', verify: { url: 'https://h/x', expect: { status: 200 } } }) + '\n' +
    JSON.stringify({ title: 'b' }) + '\n');
  const res = await verifyFile(vtmp, { exec: async () => ({ status: 200, body: '' }) });
  assert.strictEqual(res.updated, 1, 'one finding verified');
  const after = fs.readFileSync(vtmp, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
  assert.strictEqual(after[0].status, 'verified');
  assert.ok(after[0].verified_at, 'verified_at stamped');
  assert.strictEqual(after[1].status, undefined, 'finding without verify block untouched');
  fs.rmSync(vtmp, { force: true });

  // record-finding inline verify hook (offline, injected verifier + temp findings file)
  const { recordWithVerify } = require('./record-finding');
  const ftmp = path.join(os.tmpdir(), 'rf-' + process.pid + '.jsonl');
  process.env.FINDINGS_JSONL = ftmp;
  const passing = { severity: 'High', title: 'idor', host: 'h', poc: 'x', verify: { url: 'https://h/x', expect: { status: 200 } } };
  const ok = await recordWithVerify(JSON.stringify(passing), async () => ({ verified: true, runs: [], reason: '2/2' }));
  assert.ok(ok.ok, 'recorded');
  const rec = fs.readFileSync(ftmp, 'utf8').split('\n').filter(Boolean).map(JSON.parse).find((x) => x.title === 'idor');
  assert.strictEqual(rec.status, 'verified', 'passing verify -> status verified');

  const failing = { severity: 'Low', title: 'idor2', host: 'h', poc: 'x', verify: { url: 'https://h/y', expect: { status: 200 } } };
  await recordWithVerify(JSON.stringify(failing), async () => ({ verified: false, runs: [], reason: 'boom' }));
  const rec2 = fs.readFileSync(ftmp, 'utf8').split('\n').filter(Boolean).map(JSON.parse).find((x) => x.title === 'idor2');
  assert.strictEqual(rec2.status, 'confirmed', 'failing verify -> stays confirmed');
  assert.strictEqual(rec2.verify_failed, true);
  fs.rmSync(ftmp, { force: true });
  delete process.env.FINDINGS_JSONL;

  // ── Ondata 7 (E1/E3): `batch` verifica e APPENDE al side log; findings.jsonl resta INTATTO ──
  // Era il buco: il percorso documentato (knowledge.md: `verify-finding.js batch`) riscriveva le
  // righe in place, rompendo la catena A3, e da lì `record()` rifiuta ogni append.
  const { verifyBatch } = require('./verify-finding');
  const chainLog = require('./chain-log');
  const vlog = require('./verification-log');
  const vdir = fs.mkdtempSync(path.join(os.tmpdir(), 'vfbatch-'));
  const ffile = path.join(vdir, 'findings.jsonl');
  const row = {
    severity: 'High', title: 'idor-batch', host: 'h', endpoint: '/api/x', poc: 'x',
    status: 'confirmed', verify_level: 'triggered',
    verify: { url: 'https://h/x', expect: { status: 200 } },
  };
  fs.writeFileSync(ffile, chainLog.buildChainedLine(row, []) + '\n');
  const beforeBatch = fs.readFileSync(ffile);
  process.env.VERIFICATIONS_JSONL = path.join(vdir, 'verifications.jsonl');
  process.env.VERIFICATIONS_HEAD_ANCHOR_FILE = path.join(vdir, 'v-anchor.jsonl');
  const batchOut = await verifyBatch({ file: ffile, exec: async () => ({ status: 200, body: '' }) });
  assert.strictEqual(batchOut.checked, 1, JSON.stringify(batchOut));
  assert.strictEqual(batchOut.verified, 1);
  assert.strictEqual(batchOut.appended, 1);
  assert.deepStrictEqual(fs.readFileSync(ffile), beforeBatch, 'E1: findings.jsonl NON viene toccato dal batch');
  assert.strictEqual(chainLog.verifyChain(chainLog.readLines(ffile)).ok, true, 'la catena resta intatta');
  const vrecs = vlog.read();
  assert.strictEqual(vrecs.length, 1, 'un fatto di verifica nel side log');
  assert.strictEqual(vrecs[0].outcome, 'verified');
  assert.strictEqual(vrecs[0].finding_seq, 1, 'punta alla riga del finding');
  assert.ok(vrecs[0].oracle && vrecs[0].evidence_quote, 'con oracle e quote sul disco');

  // idempotenza: un secondo batch non ri-verifica ciò che risulta già verificato
  const again = await verifyBatch({ file: ffile, exec: async () => ({ status: 200, body: '' }) });
  assert.strictEqual(again.skipped_verified, 1);
  assert.strictEqual(again.checked, 0);

  // fail-closed: `verifyFile` non riscrive un log incatenato (E1, alla radice)
  const refused = await verifyFile(ffile, { exec: async () => ({ status: 200, body: '' }) });
  assert.strictEqual(refused.ok, false);
  assert.match(refused.error, /refusing to rewrite/);
  assert.deepStrictEqual(fs.readFileSync(ffile), beforeBatch, 'verifyFile non ha toccato nulla');
  delete process.env.VERIFICATIONS_JSONL;
  delete process.env.VERIFICATIONS_HEAD_ANCHOR_FILE;

  console.log('verify-finding: all tests passed');
})();
