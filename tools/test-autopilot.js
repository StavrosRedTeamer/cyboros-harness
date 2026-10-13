'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ap = require('./autopilot');

let pass = 0, fail = 0;
function ok(name, fn) {
  try { fn(); pass++; console.log(`  PASS ${name}`); }
  catch (e) { fail++; console.log(`  FAIL ${name} :: ${String(e.message).split('\n')[0]}`); }
}

ok('classify partitions by the two-tier gate', () => {
  const actions = [
    { host: 'a', tier: 'read', requires_optin: false, blocked: false, covered: false },
    { host: 'a', tier: 'active', requires_optin: false, blocked: false, covered: true },  // covered -> not executable
    { host: 'a', tier: 'active', requires_optin: false, blocked: true, covered: false },  // blocked -> not executable
    { host: 'a', tier: 'intrusive', requires_optin: true, blocked: false, covered: false }, // intrusive -> queue
  ];
  const c = ap.classify(actions);
  assert.strictEqual(c.executable.length, 1);
  assert.strictEqual(c.executable[0].tier, 'read');
  assert.strictEqual(c.intrusive.length, 1);
  assert.strictEqual(c.covered.length, 1);
  assert.strictEqual(c.blocked.length, 1);
});
ok('an intrusive action is NEVER in the executable set (fail-closed)', () => {
  const c = ap.classify([{ tier: 'intrusive', requires_optin: true, blocked: false, covered: false }]);
  assert.strictEqual(c.executable.length, 0);
  assert.strictEqual(c.intrusive.length, 1);
});
ok('budgetHalted returns a boolean and never throws', () => {
  const v = ap.budgetHalted();
  assert.strictEqual(typeof v, 'boolean');
});
ok('tick on empty state writes a checkpoint and does not execute', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-autopilot-tick-'));
  const env = {
    STATE_DB: path.join(d, 'x.db'), RUN_AUDIT_FILE: path.join(d, 'a.jsonl'),
    AUTOPILOT_CHECKPOINT: path.join(d, 'cp.json'), SCOPE_JSON: path.join(d, 'scope.json'),
    BUDGET_CONFIG_FILE: path.join(d, 'no-budget.json'),
  };
  fs.writeFileSync(env.SCOPE_JSON, '{}'); // loadable but empty -> scopeOk=true, nothing authorized
  const { spawnSync } = require('child_process');
  const r = spawnSync(process.execPath, [path.join(__dirname, 'autopilot.js'), 'tick', '--yes', '--json'],
    { encoding: 'utf8', env: Object.assign({}, process.env, env) });
  assert.ok(fs.existsSync(env.AUTOPILOT_CHECKPOINT), 'checkpoint written');
  const out = JSON.parse(r.stdout);
  assert.ok(['DONE', 'STUCK', 'BARRIER', 'PROCEED'].includes(out.verdict));
  assert.deepStrictEqual(out.ran, []); // nothing executable on empty state
});
ok('executeAction refuses cmds outside the guarded entrypoints (defense-in-depth)', () => {
  const r = ap.executeAction({ cmd: 'node tools/evil.js --pwn' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.exit, null);
});
ok('cmdSignature derives loop-watch-compatible signatures from cmd strings', () => {
  const sig = ap.cmdSignature('node tools/run.js nmap -p 80 target.test');
  assert.strictEqual(sig, 'nmap -p N target.test');
});
ok('releaseBatch(all) empties the queue and returns the approved items', () => {
  const cp = { pending_intrusive: [{ signature: 'sqlmap a', batch: 'b1' }, { signature: 'nxc b', batch: 'b1' }] };
  const r = ap.releaseBatch(cp, 'all');
  assert.strictEqual(r.approved.length, 2);
  assert.strictEqual(cp.pending_intrusive.length, 0);
});
ok('releaseBatch(id) releases only the matching batch', () => {
  const cp = { pending_intrusive: [{ signature: 'x', batch: 'b1' }, { signature: 'y', batch: 'b2' }] };
  const r = ap.releaseBatch(cp, 'b1');
  assert.strictEqual(r.approved.length, 1);
  assert.strictEqual(cp.pending_intrusive.length, 1);
  assert.strictEqual(cp.pending_intrusive[0].batch, 'b2');
});

// --- execution path over a REAL populated model (review fix: tests must cover execute) ---
const NMAP_XML = `<?xml version="1.0"?>
<nmaprun><host>
  <address addr="192.168.77.94" addrtype="ipv4"/>
  <ports>
    <port protocol="tcp" portid="445"><state state="open"/><service name="microsoft-ds"/></port>
  </ports>
</host></nmaprun>`;

function withEnv(d, scopeBody, fn) {
  const dbPath = path.join(d, 'state.db');
  const tm = require('./target-model');
  const db = tm.open(dbPath);
  try { tm.ingest(db, 'nmap', NMAP_XML, {}); } finally { if (db && typeof db.close === 'function') db.close(); }
  const scope = path.join(d, 'scope.json');
  fs.writeFileSync(scope, scopeBody);
  const keys = ['STATE_DB', 'SCOPE_JSON', 'FINDINGS_JSONL', 'RUN_AUDIT_FILE', 'COVERAGE_REPORTS_DIR', 'BUDGET_CONFIG_FILE'];
  const prev = {};
  for (const k of keys) { prev[k] = process.env[k]; }
  process.env.STATE_DB = dbPath;
  process.env.SCOPE_JSON = scope;
  process.env.FINDINGS_JSONL = path.join(d, 'findings.jsonl');
  process.env.RUN_AUDIT_FILE = path.join(d, 'run-audit.jsonl');
  process.env.COVERAGE_REPORTS_DIR = d;
  process.env.BUDGET_CONFIG_FILE = path.join(d, 'no-budget.json');
  try { fn(); } finally {
    for (const k of keys) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; }
  }
}

ok('populated model -> executable actions carry real guarded cmds (execution path)', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-autopilot-exec-'));
  withEnv(d, JSON.stringify({ targets: ['192.168.77.94'] }), () => {
    const inp = ap.gatherInputs();
    assert.ok(inp.executable.length > 0, 'expected executable actions from a populated model');
    for (const a of inp.executable) assert.match(String(a.cmd), /^node tools\/(run|workflow)\.js /);
  });
});
ok('host outside scope.json is planned blocked, NEVER executable (fail-closed scope)', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-autopilot-scope-'));
  withEnv(d, '{}', () => { // loadable but empty: authorizes nothing
    const inp = ap.gatherInputs();
    assert.strictEqual(inp.executable.length, 0, 'no action may be executable with an empty scope');
    assert.ok(inp.blocked.length > 0, 'planned actions must be blocked, not silently dropped');
  });
});
ok('loop-watch signal reaches the driver: audit loop -> gatherInputs loopWatch + SKIP verdict', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-autopilot-lw-'));
  withEnv(d, JSON.stringify({ targets: ['192.168.77.94'] }), () => {
    // 5 nmap esecuzioni IDENTICHE (firma normalizzata) -> loop consecutive
    const rows = [];
    for (let i = 0; i < 5; i++) rows.push({ ts: '2026-08-31T00:00:0' + i + 'Z', bin: 'nmap', args: ['-p', '80', '192.168.77.94'] });
    fs.writeFileSync(process.env.RUN_AUDIT_FILE, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

    const inp = ap.gatherInputs();
    assert.strictEqual(inp.loopWatch.loop, true, 'readEvents deve arrivare fino a analyze');
    assert.strictEqual(inp.loopWatch.mode, 'consecutive');
    assert.strictEqual(inp.loopWatch.signature, 'nmap -p N N.N.N.N');

    // il segnale arriva al circuit-breaker: verdetto SKIP sulla firma in loop
    const cp = require('./autopilot-checkpoint').defaultCheckpoint();
    const verdict = ap.verdictFor(inp, cp, false);
    assert.strictEqual(verdict.verdict, 'SKIP');
    assert.strictEqual(verdict.blockedSignature, 'nmap -p N N.N.N.N');
  });
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
