// test-tags: loopback
// Loopback self-check for the Command Center backend: session-token gate on writes
// and interactive streams, /api/instance handshake, single-instance attach and lock
// lifecycle. Everything runs against a throwaway state dir + scope file, never the
// real workspace ones.
// Run: node tools/test-cc-server.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SERVER = path.join(__dirname, 'gui-server.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cyboros-cc-server-'));
const SCOPE = path.join(tmp, 'scope.json');
fs.writeFileSync(SCOPE, JSON.stringify({ allowed_hosts: [], allowed_ips: [], max_requests_per_second: 2 }, null, 2));

const env = Object.assign({}, process.env, {
  CC_STATE_DIR: path.join(tmp, 'app'),
  SCOPE_JSON: SCOPE,                 // never touch the real scope.json
});
delete env.GUI_HOST;                 // the child gets everything from --port/--host
process.env.CC_STATE_DIR = env.CC_STATE_DIR;

const cc = require('./cc-instance');

function start(args) {
  const child = spawn(process.execPath, [SERVER, ...args], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const s = { child, out: '', err: '' };
  child.stdout.on('data', (b) => { s.out += b.toString(); });
  child.stderr.on('data', (b) => { s.err += b.toString(); });
  s.exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  return s;
}

function waitFor(s, re, ms) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      const m = s.out.match(re);
      if (m) return resolve(m);
      if (Date.now() - t0 > ms) {
        return reject(new Error('timeout waiting for ' + re + '\nstdout:\n' + s.out + '\nstderr:\n' + s.err));
      }
      setTimeout(tick, 40);
    };
    tick();
  });
}

async function req(port, pathname, opts) {
  const o = opts || {};
  const headers = {};
  if (o.token) headers['X-Cyboros-Token'] = o.token;
  if (o.body) headers['Content-Type'] = 'application/json';
  const res = await fetch('http://127.0.0.1:' + port + pathname, {
    method: o.method || 'GET',
    headers,
    body: o.body ? JSON.stringify(o.body) : undefined,
  });
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, body };
}

(async () => {
  const s1 = start(['--instance', '--print-port', '--port', '0']);
  const m = await waitFor(s1, /^SCC_PORT=(\d+)$/m, 10000);
  const port = Number(m[1]);
  assert.ok(port > 0, 'ephemeral port bound');

  const urlLine = s1.out.match(/^SCC_URL=(\S+)$/m);
  assert.ok(urlLine, 'SCC_URL printed for the launcher/shell');
  const token = new URL(urlLine[1]).searchParams.get('token');
  assert.ok(token && token.length === 48, 'ephemeral session token inside the handshake URL');

  // ── lock: written after listen, records the REAL bound port ───────────────
  const rec = cc.read();
  assert.ok(rec, 'lock written in --instance mode');
  assert.strictEqual(rec.pid, s1.child.pid);
  assert.strictEqual(rec.port, port);
  assert.strictEqual(rec.token, token);
  assert.strictEqual(cc.isAlive(rec), true);

  // ── handshake endpoints need no token ────────────────────────────────────
  const health = await req(port, '/api/health');
  assert.strictEqual(health.status, 200);
  assert.strictEqual(health.body.port, port);
  const inst = await req(port, '/api/instance');
  assert.strictEqual(inst.status, 200);
  assert.strictEqual(inst.body.instance, true);
  assert.strictEqual(inst.body.tokenRequired, true);
  assert.strictEqual(inst.body.pid, s1.child.pid);

  // ── data reads stay loopback-trusted (unchanged exposure) ────────────────
  assert.strictEqual((await req(port, '/api/overview')).status, 200);
  assert.strictEqual((await req(port, '/api/scope')).status, 200);

  // ── writes: refused without / with a wrong token ─────────────────────────
  const noTok = await req(port, '/api/term/input', { method: 'POST', body: { name: 'freebuff', data: '' } });
  assert.strictEqual(noTok.status, 403, 'POST without token refused');
  assert.strictEqual(noTok.body.tokenRequired, true);
  const badTok = await req(port, '/api/term/input', { method: 'POST', token: 'f'.repeat(48), body: { name: 'freebuff', data: '' } });
  assert.strictEqual(badTok.status, 403, 'POST with a wrong token refused');
  const del = await req(port, '/api/pipeline/runs/1', { method: 'DELETE' });
  assert.strictEqual(del.status, 403, 'DELETE is gated too');
  const stream = await req(port, '/api/term/stream?name=freebuff');
  assert.strictEqual(stream.status, 403, 'interactive stream gated (header-less)');

  // ── with the token: accepted (this endpoint is a harmless no-op) ─────────
  const okTok = await req(port, '/api/term/input', { method: 'POST', token, body: { name: 'freebuff', data: '' } });
  assert.strictEqual(okTok.status, 200);
  assert.strictEqual(okTok.body.ok, false, 'terminal not running → no-op');
  const okQuery = await req(port, '/api/term/input?token=' + token, { method: 'POST', body: {} });
  assert.strictEqual(okQuery.status, 200, 'token via query string works (EventSource cannot set headers)');

  // ── second launch ATTACHES (exit 3) instead of spawning a second backend ──
  const s2 = start(['--instance', '--print-port', '--port', '0']);
  const code2 = await s2.exited;
  assert.strictEqual(code2, 3, 'second instance exits 3');
  const attach = s2.out.match(/^SCC_ATTACH=(\S+)$/m);
  assert.ok(attach, 'SCC_ATTACH printed');
  assert.strictEqual(attach[1], urlLine[1], 'attach points at the live instance URL');
  assert.strictEqual(cc.read().pid, rec.pid, 'refused second launch left the lock alone');

  // ── shutdown releases the lock ───────────────────────────────────────────
  s1.child.kill('SIGTERM');
  const code1 = await s1.exited;
  assert.strictEqual(code1, 0);
  await new Promise((r) => setTimeout(r, 200));
  assert.strictEqual(cc.read(), null, 'lock released on SIGTERM');
  assert.strictEqual((await cc.probe(rec, { timeoutMs: 500 })).ok, false, 'dead instance no longer answers');

  console.log('test-cc-server: OK');
})().catch((e) => {
  console.error('FAIL: ' + ((e && e.stack) || e));
  process.exit(1);
});
