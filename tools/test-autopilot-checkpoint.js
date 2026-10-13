'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ck = require('./autopilot-checkpoint');

let pass = 0, fail = 0;
function ok(name, fn) {
  try { fn(); pass++; console.log(`  PASS ${name}`); }
  catch (e) { fail++; console.log(`  FAIL ${name} :: ${String(e.message).split('\n')[0]}`); }
}
function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-autopilot-ck-')); }

ok('defaultCheckpoint has version 1 and empty pending queue', () => {
  const cp = ck.defaultCheckpoint();
  assert.strictEqual(cp.version, 1);
  assert.deepStrictEqual(cp.pending_intrusive, []);
  assert.strictEqual(cp.tick, 0);
});
ok('read of missing file returns a default checkpoint', () => {
  const f = path.join(tmp(), 'nope.json');
  assert.strictEqual(ck.read(f).version, 1);
});
ok('read of corrupt file returns a default checkpoint (fail-safe)', () => {
  const d = tmp(); const f = path.join(d, 'cp.json');
  fs.writeFileSync(f, '{not json');
  assert.strictEqual(ck.read(f).tick, 0);
});
ok('write then read round-trips', () => {
  const d = tmp(); const f = path.join(d, 'cp.json');
  const cp = ck.defaultCheckpoint();
  cp.tick = 4; cp.prev_remaining = 7; cp.pending_intrusive.push({ id: 'x' });
  ck.write(cp, f);
  const back = ck.read(f);
  assert.strictEqual(back.tick, 4);
  assert.strictEqual(back.prev_remaining, 7);
  assert.strictEqual(back.pending_intrusive.length, 1);
});
ok('write is atomic: no leftover tmp file', () => {
  const d = tmp(); const f = path.join(d, 'cp.json');
  ck.write(ck.defaultCheckpoint(), f);
  const leftovers = fs.readdirSync(d).filter((n) => n !== 'cp.json');
  assert.deepStrictEqual(leftovers, []);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
