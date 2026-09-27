// test-tags: loopback
// Loopback self-check for portal.js serve(): starts the HTTP server on an ephemeral loopback
// port, exercises the GET (portal page) and POST (submission recorded to a temp file) paths, then
// closes it. No target/network contact — everything stays on 127.0.0.1.
// Run: node tools/test-portal-serve.js
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const portal = require('./portal');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-serve-'));
process.on('exit', () => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} });

function req(port, method, body) {
  return new Promise((resolve, reject) => {
    const headers = body
      ? { 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(body) }
      : {};
    const r = http.request({ host: '127.0.0.1', port, path: '/', method, headers }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

(async () => {
  const capturesFile = path.join(tmpDir, 'captures.jsonl');
  const s = await portal.serve(null, { port: 0, host: '127.0.0.1', capturesFile, collect: false });
  try {
    assert.ok(Number.isInteger(s.port) && s.port > 0, 'serve reports the OS-assigned ephemeral port');

    const page = await req(s.port, 'GET');
    assert.strictEqual(page.status, 200, 'GET returns 200');
    assert.ok(/name="password"/.test(page.body), 'GET serves the built-in portal form');

    const post = await req(s.port, 'POST', 'username=bob&password=s3cret&room=12');
    assert.strictEqual(post.status, 200, 'POST returns the connected page');

    const lines = fs.readFileSync(capturesFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.strictEqual(lines.length, 1, 'one submission recorded');
    assert.strictEqual(lines[0].captured, false, 'collect defaults to OFF');
    assert.strictEqual(lines[0].fields.password, '<redacted>', 'secret field redacted without --collect');
    assert.strictEqual(lines[0].fields.username, 'bob', 'non-secret field recorded');
    assert.strictEqual(lines[0].path, '/', 'request path recorded');
    assert.ok(lines[0].ts && lines[0].remote, 'timestamp + remote address recorded');
  } finally {
    await new Promise((r) => s.server.close(r));
  }

  // collect ON keeps the value (second explicit opt-in).
  const collectFile = path.join(tmpDir, 'collect.jsonl');
  const s2 = await portal.serve(null, { port: 0, host: '127.0.0.1', capturesFile: collectFile, collect: true });
  try {
    await req(s2.port, 'POST', 'username=bob&password=s3cret');
    const rec = JSON.parse(fs.readFileSync(collectFile, 'utf8').trim());
    assert.strictEqual(rec.captured, true, '--collect marks the capture');
    assert.strictEqual(rec.fields.password, 's3cret', 'value kept only with collect ON');
  } finally {
    await new Promise((r) => s2.server.close(r));
  }

  console.log('portal-serve: all tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
