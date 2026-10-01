#!/usr/bin/env node
// test-analyze-bundle-secrets.js — offline, hermetic. trufflehog is STUBBED on PATH so the
// test never touches the network: validation is egress, and a test that egressed would be
// exactly the "zero egress" violation the harness claims not to commit.
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { ok, summary, fixture, runCli } = require('./testkit');

const { analyze, secretValues, SECRET_PATTERNS } = require('./analyze-bundle');
const ROOT = path.join(__dirname, '..');

const dir = fixture('ab-secrets');
const BUNDLE = path.join(dir, 'app.js');
const FAKE = 'supersecretvalue123';
const AWS = 'AKIA0123456789ABCDEF';
fs.writeFileSync(BUNDLE, `const a="${AWS}";\nconst config = { api_key: "${FAKE}" };\n`);

// A stub that reports one finding as VERIFIED, so the mapping code is exercised without egress.
const STUB_DIR = path.join(dir, 'bin');
fs.mkdirSync(STUB_DIR, { recursive: true });
fs.writeFileSync(path.join(STUB_DIR, 'trufflehog'), [
  '#!/usr/bin/env node',
  '// reads the candidate file path from argv and reports a synthetic verified secret',
  'const fs = require("fs");',
  'const f = process.argv[process.argv.indexOf("filesystem") + 1];',
  'const raw = fs.readFileSync(f, "utf8").trim();',
  'process.stdout.write(JSON.stringify({DetectorName:"Generic", Raw:raw, RawV2:raw, Verified:true}) + "\\n");',
].join('\n'), { mode: 0o755 });
const PATH_WITH_STUB = `${STUB_DIR}${path.delimiter}${process.env.PATH || ''}`;

// --- extraction: the default path must stay masked and offline ---------------------------
ok('SECRET_PATTERNS is one shared list used by both paths', () => {
  assert.ok(Array.isArray(SECRET_PATTERNS) && SECRET_PATTERNS.length > 0);
});

ok('secretValues yields the FULL value (validation needs it)', () => {
  const vals = secretValues(fs.readFileSync(BUNDLE, 'utf8'));
  const flat = vals.map((v) => v.value);
  assert.ok(flat.includes(FAKE), 'the raw value must be reachable for validation');
  assert.ok(flat.includes(AWS));
});

ok('default extraction still emits only masked previews', () => {
  const out = analyze(fs.readFileSync(BUNDLE, 'utf8'));
  assert.ok(out.secrets.length >= 2);
  for (const s of out.secrets) {
    assert.ok(!('value' in s), 'analyze() must not expose a raw value field');
    assert.ok(s.value_preview.length < FAKE.length, 'preview must be truncated');
  }
  assert.ok(!JSON.stringify(out).includes(FAKE), 'the full secret must not appear in analyze() output');
});

// --- confirm-tier: fail closed -------------------------------------------------------------
ok('--validate-secrets without --confirm refuses and never runs', () => {
  const r = runCli(['tools/analyze-bundle.js', BUNDLE, '--validate-secrets'], { cwd: ROOT });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  const j = JSON.parse(r.stderr.trim());
  assert.equal(j.error, 'validation is confirm-tier');
  assert.equal(j.confirmed, undefined);
});

// --- validation with the stub: the mapping, and no leakage ---------------------------------
ok('with --confirm, validation runs and reports detector + type, never the secret', () => {
  const r = runCli(['tools/analyze-bundle.js', BUNDLE, '--validate-secrets', '--confirm', 'test'], {
    cwd: ROOT, env: Object.assign({}, process.env, { PATH: PATH_WITH_STUB }),
  });
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.candidates, 2);
  assert.equal(j.confirmed.length, 1, 'the stub reports exactly one');
  assert.equal(j.confirmed[0].detector, 'Generic');
  assert.ok(j.confirmed[0].type, 'the candidate must be matched back to its type');
  assert.ok(/^[0-9a-f]{16}$/.test(j.confirmed[0].fingerprint), 'a non-reversible fingerprint, not the value');
  assert.equal(j.confirmed[0].raw, undefined, 'raw must not be emitted at all');
  assert.equal(j.trufflehog.available, true);
  assert.ok(!r.stdout.includes(FAKE), 'the credential must never reach stdout');
  assert.ok(!r.stdout.includes(AWS), 'the credential must never reach stdout');
});

ok('the temporary 0600 candidate file is removed, raw values leave nothing behind', () => {
  runCli(['tools/analyze-bundle.js', BUNDLE, '--validate-secrets', '--confirm', 'test'], {
    cwd: ROOT, env: Object.assign({}, process.env, { PATH: PATH_WITH_STUB }),
  });
  const os = require('os');
  const leftovers = fs.readdirSync(os.tmpdir()).filter((d) => d.startsWith('analyze-bundle-'));
  assert.deepStrictEqual(leftovers, [], 'temp dirs must not survive: ' + leftovers.join(', '));
});

ok('a missing trufflehog degrades to available:false instead of crashing', () => {
  const empty = path.join(dir, 'empty-bin');
  fs.mkdirSync(empty, { recursive: true });
  const r = runCli(['tools/analyze-bundle.js', BUNDLE, '--validate-secrets', '--confirm', 'test'], {
    cwd: ROOT, env: Object.assign({}, process.env, { PATH: empty }),
  });
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.trufflehog.available, false);
  assert.deepStrictEqual(j.confirmed, []);
});

ok('a bundle with no secrets validates to zero candidates, still exit 0', () => {
  const clean = path.join(dir, 'clean.js');
  fs.writeFileSync(clean, 'const x = 1; export default x;');
  const r = runCli(['tools/analyze-bundle.js', clean, '--validate-secrets', '--confirm', 'test'], {
    cwd: ROOT, env: Object.assign({}, process.env, { PATH: PATH_WITH_STUB }),
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).candidates, 0);
});

summary('test-analyze-bundle-secrets');