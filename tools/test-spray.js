#!/usr/bin/env node
// Offline self-check for the spray tool (spray.js). No network, no real accounts: a fake attempt()
// drives the schedule and we assert the confirm gate, scope gate and lockout-aware capping.
// Run: node tools/test-spray.js
'use strict';
const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spray-test-'));
fs.writeFileSync(path.join(tmp, 'scope.json'), JSON.stringify({ allowed_ips: ['10.0.0.0/24'], allowed_hosts: ['corp.local'], max_requests_per_second: 100 }));
process.env.SCOPE_JSON = path.join(tmp, 'scope.json');
process.env.RUN_AUDIT_FILE = path.join(tmp, 'audit.jsonl');
process.env.LOOT_JSONL = path.join(tmp, 'loot.jsonl');

const spray = require('./spray');
let pass = 0, fail = 0;
function ok(name, fn) { try { fn(); pass++; console.log(`  PASS ${name}`); } catch (e) { fail++; console.log(`  FAIL ${name}: ${e.message}`); } }
async function okA(name, fn) { try { await fn(); pass++; console.log(`  PASS ${name}`); } catch (e) { fail++; console.log(`  FAIL ${name}: ${e.message}`); } }

// ---- lockout-aware capping (pure) -------------------------------------------
ok('unknown threshold -> 1 attempt (fail-closed)', () => assert.strictEqual(spray.safeAttemptsPerWindow(undefined), 1));
ok('threshold 0/none -> 1 attempt', () => assert.strictEqual(spray.safeAttemptsPerWindow(0), 1));
ok('threshold 5 -> 4 attempts (margin of 1)', () => assert.strictEqual(spray.safeAttemptsPerWindow(5), 4));
ok('schedule caps passwords to threshold-1', () => {
  const s = spray.buildSchedule(['a', 'b'], ['p1', 'p2', 'p3', 'p4', 'p5'], 3);
  assert.strictEqual(s.passwords_used, 2);       // 3-1
  assert.strictEqual(s.capped, true);
  assert.strictEqual(s.schedule.length, 4);      // 2 passwords * 2 users
});
ok('schedule uncapped when few passwords', () => {
  const s = spray.buildSchedule(['a'], ['p1'], 5);
  assert.strictEqual(s.capped, false);
});

// ---- scope gate -------------------------------------------------------------
ok('in-scope target passes scope', () => assert.strictEqual(spray.scopeCheck('10.0.0.5').ok, true));
ok('out-of-scope target fails scope', () => assert.strictEqual(spray.scopeCheck('8.8.8.8').ok, false));

// ---- confirm + orchestration ------------------------------------------------
(async () => {
  await okA('refuses without --confirm BEFORE any attempt', async () => {
    let tried = 0;
    const res = await spray.runSpray('10.0.0.5', { users: ['a'], passwords: ['p'], attempt: async () => { tried++; return { success: false }; } });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.stage, 'confirm');
    assert.strictEqual(tried, 0, 'no attempt may fire without confirm');
  });

  await okA('refuses out-of-scope even with --confirm', async () => {
    const res = await spray.runSpray('8.8.8.8', { confirm: 'x', users: ['a'], passwords: ['p'], attempt: async () => ({ success: true }) });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.stage, 'scope');
  });

  await okA('runs capped schedule and vaults a valid hit', async () => {
    const seen = [];
    const res = await spray.runSpray('10.0.0.5', {
      confirm: 'authorized: lab engagement', users: ['alice', 'bob'], passwords: ['P1', 'P2', 'P3', 'P4'],
      lockoutThreshold: 3, paceMs: 0,
      attempt: async (u, p) => { seen.push(`${u}:${p}`); return { success: u === 'bob' && p === 'P2' }; },
    });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.attempts, 4);           // capped to 2 passwords * 2 users
    assert.strictEqual(res.valid_count, 1);
    assert.deepStrictEqual(res.valid, [{ user: 'bob' }]);
    // password must NEVER appear in the audit log
    const audit = fs.readFileSync(process.env.RUN_AUDIT_FILE, 'utf8');
    assert.ok(!/P2/.test(audit), 'password must not be audited');
    // valid pair goes to the loot vault
    assert.match(fs.readFileSync(process.env.LOOT_JSONL, 'utf8'), /sprayed-credential/);
  });

  console.log(`\nspray: ${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})();
