// Offline self-check for WP4 — approval inbox (cc-approvals.js) + the additive,
// default-off policy gate in run.js / c2-guard.js.
// Run: node tools/test-cc-approvals.js
// Isolated via mkdtemp: approvals store, opstate, scope, audit all live in the tmpdir.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, spawn } = require('child_process');

const WS = path.join(__dirname, '..');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'cyboros-cc-approvals-'));
process.env.CC_APPROVALS_FILE = path.join(T, 'approvals.jsonl');
process.env.CC_OPSTATE_FILE = path.join(T, 'operation-state.json');
process.env.SCOPE_JSON = path.join(T, 'scope.json');
fs.writeFileSync(process.env.SCOPE_JSON, JSON.stringify({ allowed_hosts: ['lab.local', '127.0.0.1'] }, null, 2));

const A = require('./cc-approvals');
const G = require('./c2-guard');

// ── request: scope verdict is computed with the runtime truth, fail-closed ───
const inReq = A.request({ host: 'lab.local', actionClass: 'c2', command: 'nmap lab.local', by: 'agent' });
assert.strictEqual(inReq.ok, true);
assert.strictEqual(inReq.scope_verdict, 'allowed');
const outReq = A.request({ host: 'evil.example', actionClass: 'c2', command: 'nmap evil.example' });
assert.strictEqual(outReq.scope_verdict, 'blocked', 'out-of-scope host → blocked verdict');

// ── before grant the token is useless ───────────────────────────────────────
let v = A.verify(inReq.id, { host: 'lab.local', command: 'nmap lab.local' });
assert.strictEqual(v.ok, false, 'pending token is not usable');

// ── grant, then verify the full tuple ───────────────────────────────────────
assert.strictEqual(A.grant(inReq.id, { actor: 'op', note: 'ok' }).ok, true);
v = A.verify(inReq.id, { host: 'lab.local', command: 'nmap lab.local' });
assert.strictEqual(v.ok, true, 'granted + matching command/host verifies');
assert.strictEqual(v.token.granted_by, 'op');

// wrong command → blocked (hash mismatch)
assert.strictEqual(A.verify(inReq.id, { host: 'lab.local', command: 'nmap other.local' }).ok, false);
// wrong host → blocked
assert.strictEqual(A.verify(inReq.id, { host: 'other.local', command: 'nmap lab.local' }).ok, false);
// unknown id → blocked
assert.strictEqual(A.verify('ap-nope', { host: 'lab.local', command: 'nmap lab.local' }).ok, false);

// ── consume once; a token is single-use ─────────────────────────────────────
const c1 = A.consume(inReq.id, { host: 'lab.local', command: 'nmap lab.local', actor: 'agent' });
assert.strictEqual(c1.ok, true);
const c2 = A.consume(inReq.id, { host: 'lab.local', command: 'nmap lab.local', actor: 'agent' });
assert.strictEqual(c2.ok, false, 'consumed token cannot be reused');
assert.strictEqual(A.list({ all: true }).find((t) => t.id === inReq.id).status, 'consumed');

// ── a granted token scoped to out-of-scope host still fails closed ──────────
A.grant(outReq.id, { actor: 'op' });
assert.strictEqual(A.verify(outReq.id, { host: 'evil.example', command: 'nmap evil.example' }).ok, false, 'blocked scope verdict cannot be overridden by a grant');

// ── expiry folds lazily and blocks an old grant ─────────────────────────────
const oldId = 'ap-old';
fs.appendFileSync(process.env.CC_APPROVALS_FILE, JSON.stringify({
  type: 'request', id: oldId, ts: new Date(Date.now() - 3600000).toISOString(),
  host: 'lab.local', action_class: 'c2', command_hash: A.commandHash('nmap lab.local'),
  scope_verdict: 'allowed', ttl_sec: 900, requested_by: 'agent',
}) + '\n');
A.grant(oldId, { actor: 'op' });
assert.strictEqual(A.verify(oldId, { host: 'lab.local', command: 'nmap lab.local' }).ok, false, 'expired grant is refused');
assert.strictEqual(A.list({ all: true }).find((t) => t.id === oldId).status, 'expired');

// ── policy: DEFAULT OFF must change nothing ─────────────────────────────────
const scopeOff = { allowed_hosts: ['lab.local'] };
assert.strictEqual(A.policy(scopeOff).enabled, false);
assert.strictEqual(A.requireToken(scopeOff, {}).required, false, 'policy off → gate inert');
// c2-guard behaviour identical to before (same assertions as test-c2-guard)
assert.strictEqual(G.enforce('persistence -m registry', { confirm: 'x' }, scopeOff).ok, true);
assert.strictEqual(G.enforce('persistence -m registry', {}, scopeOff).ok, false);

// ── policy ON: confirm-tier needs a valid token, not just --confirm ─────────
const scopeOn = { allowed_hosts: ['lab.local'], host_ops: { require_approval: true } };
assert.strictEqual(A.policy(scopeOn).enabled, true);
const blocked = G.enforce('persistence -m registry', { confirm: 'x' }, scopeOn);
assert.strictEqual(blocked.ok, false, 'policy on: --confirm alone is not enough');
assert.strictEqual(blocked.approvalRequired, true);

const tok = A.request({ host: 'lab.local', actionClass: 'persist', command: 'persistence -m registry' });
A.grant(tok.id, { actor: 'op' });
const approved = G.enforce('persistence -m registry', { approval: tok.id, host: 'lab.local' }, scopeOn);
assert.strictEqual(approved.ok, true, 'policy on + valid token → allowed');
assert.strictEqual(approved.approved, true);

// ── run.js: --approval is consumed, policy off = no regression, policy on = gate
function runCli(scopeBody, args) {
  const scopeFile = path.join(T, 'scope-' + Math.random().toString(36).slice(2) + '.json');
  fs.writeFileSync(scopeFile, JSON.stringify(scopeBody));
  const env = Object.assign({}, process.env, {
    SCOPE_JSON: scopeFile,
    CC_APPROVALS_FILE: process.env.CC_APPROVALS_FILE,
    CC_OPSTATE_FILE: process.env.CC_OPSTATE_FILE,
    RUN_AUDIT_FILE: path.join(T, 'audit.jsonl'),
    AUDIT_DIR: path.join(T, 'audit'),
    TOOL_REGISTRY: path.join(T, 'registry.json'),
    TOOL_PLANE_OUT: path.join(T, 'plane.json'),
  });
  if (!fs.existsSync(env.TOOL_REGISTRY)) fs.writeFileSync(env.TOOL_REGISTRY, '{}');
  return spawnSync(process.execPath, [path.join(WS, 'tools', 'run.js')].concat(args), { cwd: WS, env, encoding: 'utf8' });
}
const DRY = ['--dry-run', '--approval', 'bogus', 'nmap', '-sV', '--top-ports', '100', '127.0.0.1'];
const rNoPolicy = runCli({ allowed_hosts: ['127.0.0.1'] }, DRY);
assert.strictEqual(rNoPolicy.status, 0, 'policy off: a bogus --approval does not change behaviour\n' + rNoPolicy.stdout + rNoPolicy.stderr);
const rPolicy = runCli({ allowed_hosts: ['127.0.0.1'], host_ops: { require_approval: true } }, DRY);
assert.strictEqual(rPolicy.status, 1, 'policy on: missing token blocks the run');
assert.ok(/approval/.test(rPolicy.stderr), 'block message names the approval gate');

// ── Ondata 7: la race grant/use — consumo CONCORRENTE dello stesso token ──────
// `consume` è read-then-write: senza lock due processi vedono entrambi `granted` e consumano
// entrambi lo stesso token "single-use". Il THREAT-MODEL §5 nomina esattamente questa superficie.
// Qui si prova la proprietà che conta: su N consumatori concorrenti ne vince ESATTAMENTE uno.
const raceReq = A.request({ host: 'lab.local', actionClass: 'c2', command: 'nmap lab.local', by: 'agent' });
A.grant(raceReq.id, { actor: 'op' });
const CONC = 4;
(async () => {
  const runs = await Promise.all(Array.from({ length: CONC }, () => new Promise((resolve) => {
    const child = spawn(process.execPath, [
      path.join(WS, 'tools', 'cc-approvals.js'), 'consume', raceReq.id,
      '--host', 'lab.local', '--action', 'c2', '--command', 'nmap lab.local', '--by', 'agent',
    ], { cwd: WS, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('close', (status) => resolve({ status, out }));
  })));
  const won = runs.filter((r) => r.status === 0);
  assert.strictEqual(won.length, 1,
    `esattamente un consume concorrente deve vincere, ne hanno vinti ${won.length}\n` + runs.map((r) => `${r.status}: ${r.out.trim()}`).join('\n'));
  assert.strictEqual(A.list({ all: true }).find((t) => t.id === raceReq.id).status, 'consumed');
  console.log(`test-cc-approvals: OK (race: 1/${CONC} consumatori hanno vinto)`);
})();
