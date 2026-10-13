// test-tags: loopback
// Loopback E2E for the additive Command Center routes (cc-router.js) served by gui-server.js.
// Asserts: data reads work without a token, writes are 403 without it, /api/cc/* responds, and
// the WP8 static allowlist serves only known asset extensions. All state points at a mkdtemp.
// Run: node tools/test-cc-routes.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const WS = path.join(__dirname, '..');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'cyboros-cc-routes-'));
const TOKEN = 'a'.repeat(48);

const env = Object.assign({}, process.env, {
  CC_STATE_DIR: path.join(T, 'app'),
  GUI_PORT: '0', // ephemeral port: never collide with a Command Center the operator has open
  SCC_TOKEN: TOKEN,
  CC_ROOT: T,
  STATE_DB: path.join(T, 'state.db'),
  GATE_WS: path.join(T, 'gate-ws'),
  GATE_LOG_FILE: path.join(T, 'gate-log.md'),
  CC_OPSTATE_FILE: path.join(T, 'operation-state.json'),
  CC_APPROVALS_FILE: path.join(T, 'approvals.jsonl'),
  CC_CAMPAIGN_FILE: path.join(T, 'campaign.json'),
  CC_CAMPAIGNS_DIR: path.join(T, 'campaigns'),
  CC_HISTORY_FILE: path.join(T, 'reports', 'campaign-history.jsonl'),
  CC_TEMPLATES_DIR: path.join(WS, 'templates', 'campaign'),
  AUDIT_DIR: path.join(T, 'artifacts', 'audit'),
  RUN_AUDIT_FILE: path.join(T, 'run-audit.jsonl'),
  SCOPE_JSON: path.join(T, 'scope.json'),
  ALLOW_METADATA_TARGET: '1',
});
fs.mkdirSync(path.join(T, 'gate-ws', 'reports'), { recursive: true });
fs.writeFileSync(env.SCOPE_JSON, JSON.stringify({ allowed_hosts: ['lab.local'], allowed_ips: ['127.0.0.1'] }));

const child = spawn(process.execPath, [path.join(WS, 'tools', 'gui-server.js'), '--print-port', '--instance'], { cwd: WS, env });
let out = '';
let done = false;

function finish(code, msg) {
  if (done) return;
  done = true;
  try { child.kill('SIGKILL'); } catch { /* ignore */ }
  if (msg) (code === 0 ? console.log : console.error)(msg);
  process.exit(code);
}
child.stdout.on('data', (d) => { out += d.toString(); });
child.stderr.on('data', (d) => { out += d.toString(); });
setTimeout(() => finish(1, 'timeout waiting for server\n' + out), 15000);

function waitPort() {
  const m = out.match(/SCC_PORT=(\d+)/);
  return m ? Number(m[1]) : null;
}
function waitFor(fn, ms) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    (function poll() {
      const v = fn();
      if (v) return resolve(v);
      if (Date.now() - t0 > ms) return reject(new Error('waitFor timeout\n' + out));
      setTimeout(poll, 40);
    })();
  });
}
async function req(port, method, p, body, withToken) {
  const headers = {};
  // Dual-name window (Cyboros rename): new clients send X-Cyboros-Token, a client already
  // open on an earlier release still sends X-Stavros-Token and must not get a mute 403.
  if (withToken === 'legacy') headers['X-Stavros-Token'] = TOKEN;
  else if (withToken) headers['X-Cyboros-Token'] = TOKEN;
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch('http://127.0.0.1:' + port + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await res.json(); } catch { /* none */ }
  return { status: res.status, json };
}

(async () => {
  const port = await waitFor(waitPort, 10000);
  assert.ok(port > 0, 'server printed its port');

  // reads need no token (loopback-trusted, like the rest of the dashboard)
  const campaign = await req(port, 'GET', '/api/cc/campaign');
  assert.strictEqual(campaign.status, 200, 'GET campaign');
  assert.ok(Array.isArray(campaign.json.templates) && campaign.json.templates.includes('web-app'));

  const proc = await req(port, 'GET', '/api/cc/coverage');
  assert.strictEqual(proc.status, 200, 'GET coverage');

  const graph = await req(port, 'GET', '/api/cc/graph');
  assert.strictEqual(graph.status, 200, 'GET graph');

  const mission = await req(port, 'GET', '/api/cc/mission');
  assert.strictEqual(mission.status, 200, 'GET mission');
  assert.ok(mission.json.headline, 'mission headline present');

  const led = await req(port, 'GET', '/api/cc/ledger');
  assert.strictEqual(led.status, 200, 'GET ledger');

  const warroom = await req(port, 'GET', '/api/cc/warroom');
  assert.strictEqual(warroom.status, 200, 'GET warroom');
  assert.ok(Array.isArray(warroom.json.attention), 'warroom exposes its attention rail');
  assert.ok(warroom.json.headline, 'warroom composes the mission headline');
  assert.strictEqual(warroom.json.scope.fail_closed, false, 'scope fixture is not fail-closed');

  // writes require the session token
  const noTok = await req(port, 'POST', '/api/cc/approvals/request', { host: 'lab.local', action_class: 'c2', command: 'nmap lab.local' });
  assert.strictEqual(noTok.status, 403, 'write without token → 403');
  assert.strictEqual(noTok.json.tokenRequired, true);

  const apReq = await req(port, 'POST', '/api/cc/approvals/request', { host: 'lab.local', action_class: 'c2', command: 'nmap lab.local' }, true);
  assert.strictEqual(apReq.status, 200, 'write with token → 200');
  assert.strictEqual(apReq.json.scope_verdict, 'allowed');

  const apLegacy = await req(port, 'POST', '/api/cc/approvals/request', { host: 'lab.local', action_class: 'c2', command: 'nmap lab.local' }, 'legacy');
  assert.strictEqual(apLegacy.status, 200, 'legacy X-Stavros-Token still accepted during the rename window');

  const granted = await req(port, 'POST', '/api/cc/approvals/grant', { id: apReq.json.id }, true);
  assert.strictEqual(granted.status, 200, 'grant');
  const list = await req(port, 'GET', '/api/cc/approvals?all=1');
  assert.ok(list.json.rows.some((r) => r.id === apReq.json.id && r.status === 'granted'));

  // dispatch refuses a tool outside the allowlist even with a token
  const badDispatch = await req(port, 'POST', '/api/cc/dispatch', { argv: ['/bin/sh', '-c', 'id'] }, true);
  assert.strictEqual(badDispatch.status, 400, 'non-allowlisted dispatch refused');

  // Panic: token-gated + typed confirmation, checked server-side. The refusal paths are
  // tested here; the wrapper itself is exercised offline in test-cc-panic.js (running it
  // for real from a test could touch live process registries).
  const panicNoTok = await req(port, 'POST', '/api/cc/warroom/panic', { confirm: 'PANIC' });
  assert.strictEqual(panicNoTok.status, 403, 'panic without token → 403');
  const panicNoConfirm = await req(port, 'POST', '/api/cc/warroom/panic', { confirm: 'nope' }, true);
  assert.strictEqual(panicNoConfirm.status, 400, 'panic without typed confirmation refused');
  assert.strictEqual(panicNoConfirm.json.expected, 'PANIC');

  // Host focus: a write (campaign.host), so it needs the token and an active campaign, and
  // it answers with the NEW snapshot so the board does not need a second round trip.
  const focusNoTok = await req(port, 'POST', '/api/cc/warroom/focus', { host: 'lab.local' });
  assert.strictEqual(focusNoTok.status, 403, 'focus without token → 403');
  const focusNoCampaign = await req(port, 'POST', '/api/cc/warroom/focus', { host: 'lab.local' }, true);
  assert.strictEqual(focusNoCampaign.status, 400, 'focus without an active campaign refused');

  const made = await req(port, 'POST', '/api/cc/campaign/create', { template: 'web-app', client: 'acme' }, true);
  assert.strictEqual(made.status, 200, 'campaign created');
  const activated = await req(port, 'POST', '/api/cc/campaign/activate', { campaign: made.json.campaign }, true);
  assert.strictEqual(activated.status, 200, 'campaign activated');

  const focused = await req(port, 'POST', '/api/cc/warroom/focus', { host: 'https://Lab.Local:8443/x' }, true);
  assert.strictEqual(focused.status, 200, 'focus set');
  assert.strictEqual(focused.json.host_focus.host, 'lab.local', 'a pasted URL is normalized to its host');
  assert.strictEqual(focused.json.host_focus.in_scope, true, 'the fixture host is authorized');
  assert.strictEqual(focused.json.engagement.focus.source, 'campaign');
  assert.ok(Array.isArray(focused.json.ledger.feed), 'the focus answer carries the full snapshot');

  const cleared = await req(port, 'POST', '/api/cc/warroom/focus', { host: null }, true);
  assert.strictEqual(cleared.status, 200, 'focus cleared');
  assert.strictEqual(cleared.json.host_focus, null, 'the board goes back to the whole scope');
  assert.strictEqual(cleared.json.campaign.host, null, 'the manifest carries the cleared focus');

  // Arsenal install is gated by mode + a typed confirmation, checked server-side. None of
  // these start a job (that would install software from a test).
  const noConfirm = await req(port, 'POST', '/api/cc/arsenal/install', { mode: 'run' }, true);
  assert.strictEqual(noConfirm.status, 400, 'install without typed confirmation refused');
  assert.strictEqual(noConfirm.json.expected, 'INSTALL');
  const noMode = await req(port, 'POST', '/api/cc/arsenal/install', { confirm: 'INSTALL' }, true);
  assert.strictEqual(noMode.status, 400, 'install without a mode refused');
  const badMode = await req(port, 'POST', '/api/cc/arsenal/install', { mode: 'run; rm -rf /', confirm: 'INSTALL' }, true);
  assert.strictEqual(badMode.status, 400, 'mode is a closed set');

  // WP8 static allowlist: known view assets are served, unknown ones are not.
  const viewJs = await req(port, 'GET', '/views-engagement.js');
  assert.strictEqual(viewJs.status, 200, 'view asset served by the allowlist');
  const warView = await req(port, 'GET', '/views-warroom.js');
  assert.strictEqual(warView.status, 200, 'war room view asset served');
  const badStatic = await req(port, 'GET', '/passwd');
  assert.strictEqual(badStatic.status, 404, 'no file traversal / unknown assets');

  finish(0, 'test-cc-routes: OK');
})().catch((e) => finish(1, 'FAIL: ' + ((e && e.stack) || e)));
