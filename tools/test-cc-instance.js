// Offline self-check for the Command Center single-instance lock (cc-instance.js).
// Run: node tools/test-cc-instance.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cyboros-cc-instance-'));
process.env.CC_STATE_DIR = tmp;

const cc = require('./cc-instance');

// ── no lock ────────────────────────────────────────────────────────────────
assert.strictEqual(cc.read(), null, 'no lock file → null');
assert.strictEqual(cc.isAlive(null), false);
assert.strictEqual(cc.isAlive({ pid: 0, port: 1 }), false);
const emptyClear = cc.clear();
assert.strictEqual(emptyClear.ok, true);
assert.strictEqual(emptyClear.removed, false);

// ── roundtrip ──────────────────────────────────────────────────────────────
const token = 'a'.repeat(48);
cc.write({
  pid: process.pid, host: '127.0.0.1', port: 8787, token,
  url: 'http://127.0.0.1:8787/?token=' + token, startedAt: '2026-09-26T00:00:00.000Z',
});
const back = cc.read();
assert.strictEqual(back.pid, process.pid);
assert.strictEqual(back.port, 8787);
assert.strictEqual(back.token, token);
assert.strictEqual(back.startedAt, '2026-09-26T00:00:00.000Z');
assert.strictEqual(cc.isAlive(back), true, 'our own pid counts as alive');
assert.strictEqual(cc.url(back), 'http://127.0.0.1:8787/?token=' + token, 'url() carries the token');
assert.strictEqual(cc.url({ port: 9, token: null, host: '127.0.0.1' }), 'http://127.0.0.1:9/', 'no token → plain url');

// the lock lives under CC_STATE_DIR, is private, and leaves no tmp residue
assert.strictEqual(cc.lockFile(), path.join(tmp, 'server.lock'));
assert.strictEqual(fs.statSync(cc.lockFile()).mode & 0o777, 0o600, 'lock is 0600');
assert.ok(!fs.existsSync(cc.lockFile() + '.' + process.pid + '.tmp'), 'no tmp residue');

// ── a live lock is never stolen ────────────────────────────────────────────
const claimBusy = cc.claim({ pid: process.pid + 1, host: '127.0.0.1', port: 9000 });
assert.strictEqual(claimBusy.ok, false);
assert.strictEqual(claimBusy.reason, 'live instance');
assert.strictEqual(cc.read().port, 8787, 'existing lock untouched');
const refused = cc.clear({ pid: process.pid + 999 });
assert.strictEqual(refused.ok, false, 'live lock owned by someone else is not removed');
assert.ok(cc.read(), 'lock still there after a refused clear');

// ── malformed lock is treated as absent (never throws) ──────────────────────
fs.writeFileSync(cc.lockFile(), '{ not json');
assert.strictEqual(cc.read(), null);
fs.writeFileSync(cc.lockFile(), JSON.stringify({ pid: 'x', port: 1 }));
assert.strictEqual(cc.read(), null, 'wrong field types → null');
fs.writeFileSync(cc.lockFile(), JSON.stringify({ pid: 1, port: 'x' }));
assert.strictEqual(cc.read(), null);

// ── stale lock (dead pid): taken over by claim, clearable without --force ───
cc.write({ pid: 999999, host: '127.0.0.1', port: 1234, token: null, url: 'http://127.0.0.1:1234/' });
assert.strictEqual(cc.isAlive(cc.read()), false, 'dead pid → not alive');
const took = cc.claim({ pid: process.pid, host: '127.0.0.1', port: 5555 });
assert.strictEqual(took.ok, true, 'stale lock is taken over');
assert.strictEqual(cc.read().port, 5555);
// clear() with neither owner pid nor --force must still refuse a LIVE lock —
// including one this process just claimed (only the owner releases itself).
const refusedLive = cc.clear();
assert.strictEqual(refusedLive.ok, false, 'ownerless clear() never removes a live lock');
const removed = cc.clear({ pid: process.pid });
assert.strictEqual(removed.ok, true);
assert.strictEqual(removed.removed, true);
assert.strictEqual(cc.read(), null);

(async () => {
  // ── probe against a dead pid: fails fast without any HTTP ────────────────
  cc.write({ pid: 999999, host: '127.0.0.1', port: 1, token: null, url: null });
  const st = await cc.probe(cc.read(), { timeoutMs: 300 });
  assert.strictEqual(st.ok, false);
  assert.strictEqual(st.alive, false);
  cc.clear({ force: true });

  // force-clear removes a live-foreign lock (explicit override only)
  cc.write({ pid: process.pid + 1, host: '127.0.0.1', port: 7777, token: null, url: null });
  assert.strictEqual(cc.clear({ force: true }).removed, true);
  assert.strictEqual(cc.read(), null);

  console.log('test-cc-instance: OK');
})().catch((e) => {
  console.error('FAIL: ' + ((e && e.stack) || e));
  process.exit(1);
});
