// test-tags: loopback
// The access-control matrix, proven through the real HTTP surface of
// tools/gui-server.js: anonymous is refused a read, a viewer is refused every
// write, an operator writes but cannot manage accounts, an admin manages them, the
// service token acts as `service` (operator) and not as an admin, logout ends the
// session, and the audit trail records the authenticated actor rather than the
// `actor` a request body claims. Everything runs against a mkdtemp tree.
// Run: node tools/test-console-rbac.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const identity = require('./identity');

const WS = path.join(__dirname, '..');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'cyboros-rbac-'));
const USERS = path.join(T, 'users.json');
const SCOPE = path.join(T, 'scope.json');
const AUDIT_DIR = path.join(T, 'artifacts', 'audit');
const APPROVALS = path.join(T, 'approvals.jsonl');
const SERVICE_TOKEN = 's'.repeat(48);
const PW = 'a long enough pass';
const ADMIN_PW = 'admin long enough pass';

fs.writeFileSync(SCOPE, JSON.stringify({ allowed_hosts: [], allowed_ips: [], max_requests_per_second: 2 }, null, 2));
fs.mkdirSync(path.join(T, 'reports'), { recursive: true });
// A report file exists so /reports/<name> is an authorization test, not a 404 test.
fs.writeFileSync(path.join(T, 'reports', 'sample-report.html'), '<html><body>report</body></html>');

const seed = identity.createIdentity({ usersFile: USERS, serviceToken: null, auditSink: () => ({ ok: true }) });
for (const [username, role, password] of [
  ['root', 'admin', ADMIN_PW],
  ['opa', 'operator', PW],
  ['view', 'viewer', PW],
]) {
  const r = seed.addUser({ username, role, password }, { actor: 'test' });
  assert.strictEqual(r.ok, true, 'seed ' + username + ': ' + (r.error || ''));
}

const env = Object.assign({}, process.env, {
  CC_ROOT: T,
  CC_STATE_DIR: path.join(T, 'app'),
  SCOPE_JSON: SCOPE,
  AUDIT_DIR,
  CC_APPROVALS_FILE: APPROVALS,
  GUI_PORT: '0',
  SCC_TOKEN: SERVICE_TOKEN,
});
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
setTimeout(() => finish(1, 'timeout waiting for server\n' + out), 20000);

function waitPort() {
  const m = out.match(/SCC_PORT=(\d+)/);
  return m ? Number(m[1]) : null;
}
async function waitFor(fn, ms) {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('waitFor timeout\n' + out);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function call(port, method, p, opts) {
  const o = opts || {};
  const headers = {};
  if (o.cookie) headers.cookie = o.cookie;
  if (o.token) headers['x-cyboros-token'] = o.token;
  if (o.host) headers.host = o.host;
  if (o.body) headers['content-type'] = 'application/json';
  const res = await fetch('http://127.0.0.1:' + port + p, {
    method,
    headers,
    body: o.body ? JSON.stringify(o.body) : undefined,
    redirect: 'manual',
  });
  let json = null;
  try { json = await res.json(); } catch { /* html/text */ }
  return { status: res.status, json, setCookie: res.headers.get('set-cookie') };
}

// fetch() refuses to set Host (a forbidden header), so the rebinding guard is
// probed with the raw http client that a malicious page would be up against.
function rawStatus(port, p, headers) {
  return new Promise((resolve, reject) => {
    const rf = http.request({ host: '127.0.0.1', port, path: p, headers }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    rf.on('error', reject);
    rf.end();
  });
}

async function login(port, username, password) {
  const r = await call(port, 'POST', '/api/auth/login', { body: { username, password } });
  assert.strictEqual(r.status, 200, 'login ' + username + ': ' + JSON.stringify(r.json));
  assert.ok(r.setCookie && r.setCookie.includes('HttpOnly'), 'session cookie is HttpOnly');
  assert.ok(r.setCookie.includes('SameSite=Strict'), 'session cookie is SameSite=Strict');
  return r.setCookie.split(';')[0];
}

function auditLines() {
  let rows = [];
  for (const f of fs.readdirSync(AUDIT_DIR).filter((x) => x.endsWith('.jsonl'))) {
    rows = rows.concat(fs.readFileSync(path.join(AUDIT_DIR, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
  }
  return rows;
}

(async () => {
  const port = await waitFor(waitPort, 15000);
  const anon = await call(port, 'GET', '/api/overview');
  assert.strictEqual(anon.status, 401, 'anonymous data read refused');
  assert.strictEqual(anon.json.authRequired, true);

  // the shell and the login page are public (they hold no engagement data)
  assert.strictEqual((await call(port, 'GET', '/')).status, 200, 'console shell is public');
  assert.strictEqual((await call(port, 'GET', '/login')).status, 200, 'login page is public');
  assert.strictEqual((await call(port, 'GET', '/api/health')).status, 200, 'health stays public for the handshake');
  assert.strictEqual(await rawStatus(port, '/api/overview', { Host: 'evil.example' }), 403, 'Host guard still applies');
  assert.strictEqual(await rawStatus(port, '/api/overview', { Host: '127.0.0.1:' + port }), 401, 'loopback Host reaches the auth layer');

  // reports are client data
  assert.strictEqual((await call(port, 'GET', '/reports/sample-report.html')).status, 401, 'report requires a session');

  const viewCookie = await login(port, 'view', PW);
  const opaCookie = await login(port, 'opa', PW);
  const rootCookie = await login(port, 'root', ADMIN_PW);

  // ── viewer: reads everything, writes nothing ─────────────────────────────
  for (const p of ['/api/overview', '/api/findings', '/api/scope', '/api/pipeline', '/api/sessions', '/api/reports']) {
    assert.strictEqual((await call(port, 'GET', p, { cookie: viewCookie })).status, 200, 'viewer GET ' + p);
  }
  assert.strictEqual((await call(port, 'GET', '/reports/sample-report.html', { cookie: viewCookie })).status, 200, 'viewer may read a report');
  const vWrite = await call(port, 'POST', '/api/scope', { cookie: viewCookie, body: { allowed_hosts: ['evil.example'] } });
  assert.strictEqual(vWrite.status, 403, 'viewer cannot write scope');
  assert.strictEqual(vWrite.json.need, 'operator');
  assert.strictEqual((await call(port, 'POST', '/api/term/input', { cookie: viewCookie, body: {} })).status, 403, 'viewer cannot touch the terminal');
  assert.strictEqual((await call(port, 'DELETE', '/api/pipeline/runs/1', { cookie: viewCookie })).status, 403, 'viewer cannot delete runs');
  assert.strictEqual((await call(port, 'GET', '/api/users', { cookie: viewCookie })).status, 403, 'viewer cannot list accounts');
  assert.strictEqual((await call(port, 'GET', '/api/term/stream?name=freebuff', { cookie: viewCookie })).status, 403, 'viewer cannot open a live shell');

  // ── operator: writes, but no account management ─────────────────────────
  const opWrite = await call(port, 'POST', '/api/scope', { cookie: opaCookie, body: { allowed_hosts: ['lab.local'], max_requests_per_second: 3 } });
  assert.strictEqual(opWrite.status, 200, 'operator writes scope: ' + JSON.stringify(opWrite.json));
  assert.strictEqual(opWrite.json.ok, true);
  assert.match(fs.readFileSync(SCOPE, 'utf8'), /lab\.local/, 'scope actually changed on disk');
  assert.match(fs.readFileSync(SCOPE, 'utf8'), /by opa/, 'the authorization file records who changed it');
  assert.strictEqual((await call(port, 'POST', '/api/term/input', { cookie: opaCookie, body: { name: 'freebuff', data: '' } })).status, 200, 'operator may address the terminal');
  assert.strictEqual((await call(port, 'GET', '/api/users', { cookie: opaCookie })).status, 403, 'operator cannot list accounts');
  assert.strictEqual((await call(port, 'POST', '/api/users', { cookie: opaCookie, body: { username: 'x1', role: 'viewer', password: PW } })).status, 403, 'operator cannot create accounts');

  // ── admin: accounts ─────────────────────────────────────────────────────
  const list = await call(port, 'GET', '/api/users', { cookie: rootCookie });
  assert.strictEqual(list.status, 200);
  assert.strictEqual(list.json.users.length, 3);
  assert.ok(list.json.users.every((u) => !('password_hash' in u)), 'hashes never leave the process');

  const created = await call(port, 'POST', '/api/users', { cookie: rootCookie, body: { username: 'alice', role: 'operator', password: PW, display_name: 'Alice' } });
  assert.strictEqual(created.status, 201, JSON.stringify(created.json));
  const aliceCookie = await login(port, 'alice', PW);
  assert.strictEqual((await call(port, 'GET', '/api/auth/me', { cookie: aliceCookie })).json.user.role, 'operator');
  assert.strictEqual((await call(port, 'POST', '/api/users/alice', { cookie: rootCookie, body: { role: 'viewer' } })).status, 200);
  assert.strictEqual((await call(port, 'POST', '/api/scope', { cookie: aliceCookie, body: { allowed_hosts: ['lab.local'] } })).status, 403, 'demotion applies to the live session');
  assert.strictEqual((await call(port, 'DELETE', '/api/users/root', { cookie: rootCookie })).status, 400, 'the last admin cannot delete itself');
  assert.strictEqual((await call(port, 'DELETE', '/api/users/alice', { cookie: rootCookie })).status, 200);
  assert.strictEqual((await call(port, 'GET', '/api/overview', { cookie: aliceCookie })).status, 401, 'a removed user loses the session');

  // ── chat: conversation, not an engagement action — but still gated by role ──
  assert.strictEqual((await call(port, 'GET', '/api/chat/profiles', { cookie: viewCookie })).status, 200, 'viewer may read chat profiles');
  assert.strictEqual((await call(port, 'POST', '/api/chat', { cookie: viewCookie, body: { messages: [{ role: 'user', content: 'hi' }] } })).status, 403, 'viewer cannot start a chat');
  assert.strictEqual((await call(port, 'POST', '/api/chat', { body: { messages: [{ role: 'user', content: 'hi' }] } })).status, 401, 'anonymous cannot start a chat');
  const opChat = await call(port, 'POST', '/api/chat', { cookie: opaCookie, body: { messages: [{ role: 'user', content: 'hi' }] } });
  assert.strictEqual(opChat.status, 500, 'operator passes the role gate and reaches the handler (no provider config in this sandbox, so it fails past auth, not at it)');

  // ── the machine token: operator, never admin ────────────────────────────
  assert.strictEqual((await call(port, 'GET', '/api/overview', { token: SERVICE_TOKEN })).status, 200, 'service token reads');
  assert.strictEqual((await call(port, 'GET', '/api/users', { token: SERVICE_TOKEN })).status, 403, 'service token cannot manage accounts');
  assert.strictEqual((await call(port, 'GET', '/api/overview', { token: 'b'.repeat(48) })).status, 401, 'a wrong token is anonymous');

  // ── logout ends the session ─────────────────────────────────────────────
  assert.strictEqual((await call(port, 'POST', '/api/auth/logout', { cookie: viewCookie })).status, 200);
  assert.strictEqual((await call(port, 'GET', '/api/overview', { cookie: viewCookie })).status, 401, 'cookie is dead after logout');

  // ── lockout through the real endpoint (also feeds the audit assertion) ──
  for (let i = 0; i < 5; i++) await call(port, 'POST', '/api/auth/login', { body: { username: 'opa', password: 'wrong password here' } });
  const locked = await call(port, 'POST', '/api/auth/login', { body: { username: 'opa', password: PW } });
  assert.strictEqual(locked.status, 429, 'repeated failures lock the account briefly');
  assert.ok(locked.json.retryAfter > 0);

  // ── the audit actor is the authenticated identity, not the body ─────────
  const req = await call(port, 'POST', '/api/cc/approvals/request', {
    cookie: opaCookie,
    body: { host: 'lab.local', action_class: 'c2', command: 'nmap lab.local', actor: 'mallory' },
  });
  assert.strictEqual(req.status, 200, JSON.stringify(req.json));
  const granted = await call(port, 'POST', '/api/cc/approvals/grant', { cookie: opaCookie, body: { id: req.json.id, actor: 'mallory' } });
  assert.strictEqual(granted.status, 200, JSON.stringify(granted.json));
  const approvalRows = fs.readFileSync(APPROVALS, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const decision = approvalRows.find((r) => r.type === 'grant');
  assert.ok(decision, 'grant recorded');
  assert.strictEqual(decision.actor, 'opa', 'audit actor is the session, not body.actor=' + JSON.stringify(decision.actor));

  const rows = auditLines();
  assert.ok(rows.some((r) => r.event === 'auth.login' && r.actor === 'root' && r.outcome === 'ok'), 'login audited with actor');
  assert.ok(rows.some((r) => r.event === 'auth.login' && r.outcome === 'deny'), 'failed login audited');
  assert.ok(rows.some((r) => r.event === 'access.denied' && r.actor === 'anonymous'), 'anonymous refusal audited');
  assert.ok(rows.some((r) => r.event === 'access.denied' && r.actor === 'view'), 'role refusal audited with the principal');
  assert.ok(rows.some((r) => r.event === 'console.write' && r.actor === 'opa'), 'writes audited with the principal');
  assert.ok(rows.some((r) => r.event === 'user.create' && r.actor === 'root'), 'account creation audited');
  assert.ok(rows.every((r) => r.chain && r.chain.prev_sha256), 'every audit row is chained');

  // ── the launcher flow: ?token= becomes a session cookie ─────────────────
  const boot = await call(port, 'GET', '/?token=' + SERVICE_TOKEN);
  assert.strictEqual(boot.status, 302, 'token URL redirects');
  assert.ok(boot.setCookie && boot.setCookie.includes('cyboros_sid='), 'token exchanged for a session');

  finish(0, 'test-console-rbac: OK');
})().catch((e) => finish(1, 'FAIL: ' + ((e && e.stack) || e)));
