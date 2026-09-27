#!/usr/bin/env node
// Self-check for tools/pace.js: reservation monotonicity, non-blocking waitAsync,
// blocking wait, and PACE_FILE env override. Hermetic (temp pace file, no network).
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const paceFile = path.join(os.tmpdir(), 'pace-test-' + process.pid + '.json');
process.env.PACE_FILE = paceFile;                 // must be set BEFORE requiring pace
const pace = require('./pace');

async function main() {
  try { fs.rmSync(paceFile, { force: true }); } catch {}

  // 1) reserve() is monotonic: first call ~0 wait, immediate second call ~ the gap.
  const first = pace.reserve(2);                   // rps=2 -> gap=500ms
  assert.ok(first <= 10, 'first reservation waits ~0ms, got ' + first);
  const second = pace.reserve(2);
  assert.ok(second >= 450 && second <= 600, 'second reservation ~= gap (500ms), got ' + second);

  // 2) waitAsync does NOT block the event loop: a 20ms timer fires during the gap.
  try { fs.rmSync(paceFile, { force: true }); } catch {}
  pace.reserve(2);                                 // consume the slot
  let timerFired = false;
  setTimeout(() => { timerFired = true; }, 20);
  const t0 = Date.now();
  await pace.waitAsync(2);                          // ~500ms, non-blocking
  assert.ok(timerFired, 'waitAsync froze the event loop (20ms timer never fired)');
  assert.ok(Date.now() - t0 >= 400, 'waitAsync actually waited ~ the gap');

  // 3) wait() (sync) DOES block: a 20ms timer has not fired when it returns.
  try { fs.rmSync(paceFile, { force: true }); } catch {}
  pace.reserve(2);
  let syncTimerFired = false;
  setTimeout(() => { syncTimerFired = true; }, 20);
  pace.wait(2);                                     // ~500ms, blocking
  assert.strictEqual(syncTimerFired, false, 'sync wait should freeze the loop (timer not yet run)');

  // 4) PACE_FILE env override is honored (state written to the temp file).
  assert.strictEqual(pace.PACE_FILE, paceFile, 'PACE_FILE env override honored');
  assert.ok(fs.existsSync(paceFile), 'pace state written to the overridden file');

  try { fs.rmSync(paceFile, { force: true }); } catch {}
  console.log('pace: all tests passed');
}
main().catch((e) => { console.error(e); process.exit(1); });
