// Offline self-check for the panic switch (cc-panic.js): stops ONLY registered harness tasks,
// is idempotent, and records one audit-trail entry per run. All state in a mkdtemp.
// Run: node tools/test-cc-panic.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'cyboros-cc-panic-'));
process.env.PROC_REGISTRY_FILE = path.join(T, 'proc-registry.json');
process.env.AUDIT_DIR = path.join(T, 'artifacts', 'audit');
process.env.CC_ROOT = T;

const panic = require('./cc-panic');
const registry = require('./proc-registry');

(async () => {
  // a stand-in "harness task": a live child we register under a task-id
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 250));
  registry.register({ taskId: 'scan-1', pid: child.pid, bin: 'nmap', via: 'test' });
  assert.strictEqual(registry.load().tasks['scan-1'].status, 'running');

  const exited = new Promise((res) => child.on('exit', res));
  const before = panic.main([]);
  assert.strictEqual(before, 0);
  const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r('timeout'), 3000))]);
  assert.notStrictEqual(code, 'timeout', 'registered task was signalled');
  assert.strictEqual(registry.load().tasks['scan-1'].status, 'terminated');

  // idempotent: nothing left running → no-op, still ok
  const again = panic.main([]);
  assert.strictEqual(again, 0);

  // one audit entry per run, hash-chained
  const verify = require('./audit-trail').verifyAuditFile();
  assert.strictEqual(verify.ok, true, 'audit trail intact');
  const lines = require('./audit-trail').readLines(require('./audit-trail').auditFile());
  const panicEntries = lines.map((l) => JSON.parse(l)).filter((e) => e.event === 'panic');
  assert.ok(panicEntries.length >= 2, 'one ledger entry per panic run');
  assert.ok(panicEntries.some((e) => (e.stopped || []).some((s) => s.task_id === 'scan-1')));

  console.log('test-cc-panic: OK');
  process.exit(0);
})().catch((e) => { console.error('FAIL: ' + ((e && e.stack) || e)); process.exit(1); });
