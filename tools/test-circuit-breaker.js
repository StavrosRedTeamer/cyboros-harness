'use strict';
const assert = require('assert');
const cb = require('./circuit-breaker');

let pass = 0, fail = 0;
function ok(name, fn) {
  try { fn(); pass++; console.log(`  PASS ${name}`); }
  catch (e) { fail++; console.log(`  FAIL ${name} :: ${String(e.message).split('\n')[0]}`); }
}
const base = {
  loopWatch: { loop: false, signature: null, count: 0, mode: null },
  continuation: { loop: false, all_failed: false, error_classes: [] },
  remaining: 3, prevRemaining: 5, dryStreak: 0, executableCount: 2, targetsCount: 1,
  budgetHalted: false, scopeOk: true, opts: { dryK: 2 },
};
const m = (over) => Object.assign({}, base, over);

ok('budget halt wins over everything', () => {
  assert.strictEqual(cb.decide(m({ budgetHalted: true, remaining: 0 })).verdict, 'BUDGET');
});
ok('broken scope -> immediate STUCK (fail-closed), even with remaining 0', () => {
  assert.strictEqual(cb.decide(m({ scopeOk: false, remaining: 0 })).verdict, 'STUCK');
});
ok('empty state (no targets) -> STUCK, never a false DONE', () => {
  assert.strictEqual(cb.decide(m({ targetsCount: 0, remaining: 0 })).verdict, 'STUCK');
});
ok('remaining 0 -> DONE', () => {
  assert.strictEqual(cb.decide(m({ remaining: 0 })).verdict, 'DONE');
});
ok('all_failed with no executable -> STUCK', () => {
  assert.strictEqual(cb.decide(m({ continuation: { loop: false, all_failed: true, error_classes: ['unknown'] }, executableCount: 0 })).verdict, 'STUCK');
});
ok('all_failed but executable remain -> not STUCK', () => {
  assert.notStrictEqual(cb.decide(m({ continuation: { loop: false, all_failed: true, error_classes: [] }, executableCount: 2 })).verdict, 'STUCK');
});
ok('loop-watch consecutive -> SKIP with signature', () => {
  const r = cb.decide(m({ loopWatch: { loop: true, signature: 'nmap -p N', count: 6, mode: 'consecutive' } }));
  assert.strictEqual(r.verdict, 'SKIP');
  assert.strictEqual(r.blockedSignature, 'nmap -p N');
});
ok('dry streak >= K -> BARRIER', () => {
  assert.strictEqual(cb.decide(m({ remaining: 5, prevRemaining: 5, dryStreak: 2 })).verdict, 'BARRIER');
});
ok('forward progress -> PROCEED', () => {
  assert.strictEqual(cb.decide(m({})).verdict, 'PROCEED');
});
ok('reasons is always an array', () => {
  assert.ok(Array.isArray(cb.decide(m({})).reasons));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
