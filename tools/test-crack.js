#!/usr/bin/env node
// Offline self-check for the offline cracker (crack.js). No hashcat/john, no GPU: a fake runner
// returns a canned potfile and we assert detection, loot wiring, command assembly and parsing.
// Run: node tools/test-crack.js
'use strict';
const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crack-test-'));
process.env.LOOT_JSONL = path.join(tmp, 'loot.jsonl');
process.env.CYBOROS_CRACK_DIR = path.join(tmp, 'crack');
process.env.RUN_AUDIT_FILE = path.join(tmp, 'audit.jsonl');

const crack = require('./crack');
let pass = 0, fail = 0;
function ok(name, fn) { try { fn(); pass++; console.log(`  PASS ${name}`); } catch (e) { fail++; console.log(`  FAIL ${name}: ${e.message}`); } }
async function okA(name, fn) { try { await fn(); pass++; console.log(`  PASS ${name}`); } catch (e) { fail++; console.log(`  FAIL ${name}: ${e.message}`); } }

// ---- detection --------------------------------------------------------------
ok('detect kerberoast -> 13100', () => assert.strictEqual(crack.detect('$krb5tgs$23$*svc$CORP$svc*$abc').mode, 13100));
ok('detect asrep -> 18200', () => assert.strictEqual(crack.detect('$krb5asrep$23$user@CORP:aa').mode, 18200));
ok('detect bcrypt -> 3200', () => assert.strictEqual(crack.detect('$2b$12$abcdefghijklmnopqrstuv').mode, 3200));
ok('detect sha512crypt -> 1800', () => assert.strictEqual(crack.detect('$6$salt$hashhashhash').mode, 1800));
ok('detect NTLM 32hex -> 1000', () => assert.strictEqual(crack.detect('a'.repeat(32)).mode, 1000));
ok('detect unknown -> null', () => assert.strictEqual(crack.detect('not-a-hash'), null));
ok('modesTable non-empty', () => assert.ok(crack.modesTable().length > 5));

// ---- loot wiring ------------------------------------------------------------
fs.writeFileSync(process.env.LOOT_JSONL, [
  JSON.stringify({ loot_id: 'a1', host: 'dc01', title: 'kerberoast svc', secret: '$krb5tgs$23$*svc$CORP.LOCAL$svc*$deadbeef' }),
  JSON.stringify({ loot_id: 'b2', host: 'dc01', title: 'api key', secret: 'sk-not-a-hash-value' }),
].join('\n') + '\n');
ok('crackableFromLoot filters to real hashes only', () => {
  const c = crack.crackableFromLoot();
  assert.strictEqual(c.length, 1);
  assert.strictEqual(c[0].loot_id, 'a1');
  assert.strictEqual(c[0].mode, 13100);
});

// ---- command assembly -------------------------------------------------------
ok('buildHashcat uses -m mode -a 0', () => {
  const b = crack.buildHashcat('/tmp/h.txt', 13100, { wordlist: '/tmp/w.txt' });
  assert.strictEqual(b.bin, 'hashcat');
  assert.deepStrictEqual(b.args.slice(0, 5), ['-m', '13100', '-a', '0', '/tmp/h.txt']);
});
ok('buildJohn uses --format', () => {
  const b = crack.buildJohn('/tmp/h.txt', 'krb5tgs', { wordlist: '/tmp/w.txt' });
  assert.strictEqual(b.bin, 'john');
  assert.ok(b.args[0].startsWith('--format='));
});

// ---- parseCracked -----------------------------------------------------------
ok('parseCracked matches hash:plaintext', () => {
  const hashes = [{ hash: '$krb5tgs$23$*svc$CORP.LOCAL$svc*$deadbeef', mode: 13100 }];
  const got = crack.parseCracked('$krb5tgs$23$*svc$CORP.LOCAL$svc*$deadbeef:Summer2026!', hashes);
  assert.strictEqual(got.length, 1);
  assert.strictEqual(got[0].plaintext, 'Summer2026!');
});

// ---- crack() with injected runner + writes plaintext back to vault ----------
(async () => {
  await okA('crack() recovers plaintext and vaults it (never target contact)', async () => {
    const hashes = crack.crackableFromLoot();
    const res = await crack.crack(hashes, {
      runner: async () => ({ status: 0, stdout: `${hashes[0].hash}:Winter2026!` }),
    });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.cracked_count, 1);
    const vault = fs.readFileSync(process.env.LOOT_JSONL, 'utf8');
    assert.match(vault, /cracked-credential/);
    assert.match(vault, /Winter2026!/);
  });

  await okA('crack() refuses when no mode determinable', async () => {
    const res = await crack.crack([{ hash: 'unknownformat' }], { runner: async () => ({ status: 0, stdout: '' }) });
    assert.strictEqual(res.ok, false);
  });

  console.log(`\ncrack: ${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})();
