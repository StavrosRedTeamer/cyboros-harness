#!/usr/bin/env node
// Offline self-check for cloud-enum.js. No network, no cloud CLIs: injected probe/runner.
// Run: node tools/test-cloud-enum.js
'use strict';
const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-test-'));
process.env.LOOT_JSONL = path.join(tmp, 'loot.jsonl');
process.env.RUN_AUDIT_FILE = path.join(tmp, 'audit.jsonl');

const cloud = require('./cloud-enum');
let pass = 0, fail = 0;
function ok(name, fn) { try { fn(); pass++; console.log(`  PASS ${name}`); } catch (e) { fail++; console.log(`  FAIL ${name}: ${e.message}`); } }
async function okA(name, fn) { try { await fn(); pass++; console.log(`  PASS ${name}`); } catch (e) { fail++; console.log(`  FAIL ${name}: ${e.message}`); } }

// ---- provider classify ------------------------------------------------------
ok('classify s3', () => assert.strictEqual(cloud.classify('https://acme-backups.s3.amazonaws.com/'), 'aws-s3'));
ok('classify gcs', () => assert.strictEqual(cloud.classify('https://storage.googleapis.com/acme/'), 'gcs'));
ok('classify azure', () => assert.strictEqual(cloud.classify('https://acme.blob.core.windows.net/'), 'azure-blob'));
ok('classify unknown', () => assert.strictEqual(cloud.classify('https://example.com/'), null));

// ---- candidate generation ---------------------------------------------------
ok('candidates include affixed names', () => {
  const c = cloud.candidates('acme', ['secret']);
  assert.ok(c.includes('acme'));
  assert.ok(c.includes('acme-backup'));
  assert.ok(c.includes('acme-secret'));
});
ok('candidates sanitize input', () => assert.ok(cloud.candidates('Acme Corp!').every((n) => /^[a-z0-9-]+$/.test(n))));

// ---- ACL classification -----------------------------------------------------
ok('200 + listing xml -> public-listable High', () => { const v = cloud.classifyBucketResult('aws-s3', { status: 200, body: '<ListBucketResult><Contents>x</Contents></ListBucketResult>' }); assert.strictEqual(v.state, 'public-listable'); assert.strictEqual(v.severity, 'High'); });
ok('403 -> exists-private', () => assert.strictEqual(cloud.classifyBucketResult('aws-s3', { status: 403, body: '' }).state, 'exists-private'));
ok('404 -> absent', () => assert.strictEqual(cloud.classifyBucketResult('aws-s3', { status: 404, body: '' }).state, 'absent'));

// ---- IAM read-only commands (no write verbs) --------------------------------
ok('aws iam commands are read-only', () => {
  const cmds = cloud.iamReadCommands('aws');
  const flat = cmds.map(([b, a]) => `${b} ${a.join(' ')}`).join(' | ');
  assert.ok(/get-caller-identity/.test(flat));
  assert.ok(!/create|delete|put|attach-.*-policy --policy|update/i.test(flat), 'no mutating verbs');
});

// ---- probe with injected send -----------------------------------------------
(async () => {
  await okA('probeBuckets reports a public-listable hit', async () => {
    const probe = async (url) => url.includes('acme-backup.s3') ? { status: 200, body: '<ListBucketResult><Contents/></ListBucketResult>' } : { status: 404, body: '' };
    const res = await cloud.probeBuckets('acme', { probe, providers: ['aws-s3'] });
    assert.ok(res.hits.find((h) => h.name === 'acme-backup' && h.state === 'public-listable'));
  });

  await okA('probeBuckets skips out-of-scope (blocked) without crashing', async () => {
    const res = await cloud.probeBuckets('acme', { probe: async () => ({ blocked: 'out of scope' }), providers: ['aws-s3'] });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.hits.length, 0);
  });

  await okA('enumIam refuses when no key in vault', async () => {
    const res = await cloud.enumIam('aws', { runner: async () => ({ status: 0, stdout: '' }) });
    assert.strictEqual(res.ok, false);
    assert.match(res.reason, /no cloud key/);
  });

  await okA('enumIam uses looted key via ENV not argv', async () => {
    fs.writeFileSync(process.env.LOOT_JSONL, JSON.stringify({ loot_id: 'k1', title: 'aws access key', secret: 'AKIAEXAMPLE:secretpart' }) + '\n');
    let sawSecretInArgs = false, sawEnv = false;
    const res = await cloud.enumIam('aws', {
      lootId: 'k1',
      runner: async (bin, args, env) => { if (args.join(' ').includes('secretpart')) sawSecretInArgs = true; if (env && env.AWS_SECRET_ACCESS_KEY === 'secretpart') sawEnv = true; return { status: 0, stdout: '{"Arn":"arn:aws:iam::1:user/x"}' }; },
    });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(sawSecretInArgs, false, 'secret must not be in argv');
    assert.strictEqual(sawEnv, true, 'secret passed via env');
  });

  console.log(`\ncloud-enum: ${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})();
