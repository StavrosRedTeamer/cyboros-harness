// Offline coverage for tools/identity.js — the piece every console request now
// depends on. No server, no network: hashing, the users file contract, the role
// matrix, sessions, lockout, the provider seam, the audit actor and the CLI.
// Run: node tools/test-identity.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { ok, summary } = require('./testkit');
const identity = require('./identity');

const WS = path.join(__dirname, '..');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'cyboros-identity-'));

function tmpUsers(name) {
  return path.join(T, name + '.json');
}

function seed(file, users) {
  const doc = { version: 1, users: users.map((u) => ({
    username: u.username,
    role: u.role || 'operator',
    password_hash: identity.hashPassword(u.password),
    disabled: !!u.disabled,
    display_name: u.display_name || '',
    created_at: new Date().toISOString(),
  })) };
  fs.writeFileSync(file, JSON.stringify(doc, null, 2), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
}

function req(headers) {
  return { headers: headers || {}, url: '/' };
}

console.log('identity — passwords, roles, sessions, provider seam');

ok('scrypt round-trips and rejects a wrong password', () => {
  const h = identity.hashPassword('correct horse battery staple');
  assert.ok(h.startsWith('scrypt$'), 'self-describing format');
  assert.strictEqual(identity.verifyPassword('correct horse battery staple', h), true);
  assert.strictEqual(identity.verifyPassword('correct horse battery stapl', h), false);
  assert.strictEqual(identity.verifyPassword('', h), false);
});

ok('a malformed hash is a refusal, not a crash', () => {
  for (const bad of ['', 'plaintext', 'scrypt$1$2$3', 'scrypt$abc$8$1$x$y', 'bcrypt$16384$8$1$a$b']) {
    assert.strictEqual(identity.verifyPassword('anything', bad), false, 'must refuse: ' + bad);
  }
});

ok('password policy rejects short strings and the username itself', () => {
  assert.ok(identity.passwordProblem('alice', 'short'));
  assert.ok(identity.passwordProblem('alice.the.operator', 'alice.the.operator'), 'password equal to the username');
  assert.strictEqual(identity.passwordProblem('alice', 'a long enough passphrase'), null);
});

ok('users file schema is strict about what decides access', () => {
  const good = identity.parseUsersDoc({ version: 1, users: [
    { username: 'alice', role: 'admin', password_hash: identity.hashPassword('a long enough pass') },
  ] });
  assert.strictEqual(good.ok, true);
  const cases = [
    [{ version: 2, users: [] }, /version/],
    [{ version: 1, users: [{ username: 'alice', role: 'root', password_hash: 'scrypt$a$b$c$d$e' }] }, /role/],
    [{ version: 1, users: [{ username: 'AL ICE', role: 'admin', password_hash: 'scrypt$a$b$c$d$e' }] }, /username/],
    [{ version: 1, users: [{ username: 'alice', role: 'admin', password_hash: 'plain' }] }, /password_hash/],
    [{ version: 1, users: [
      { username: 'alice', role: 'admin', password_hash: 'scrypt$a$b$c$d$e' },
      { username: 'alice', role: 'viewer', password_hash: 'scrypt$a$b$c$d$e' },
    ] }, /duplicate/],
  ];
  for (const [doc, re] of cases) {
    const r = identity.parseUsersDoc(doc);
    assert.strictEqual(r.ok, false, 'must reject ' + JSON.stringify(doc));
    assert.match(r.error, re);
  }
});

ok('a group/other-readable users file is tightened to 0600', () => {
  const file = tmpUsers('perms');
  seed(file, [{ username: 'alice', role: 'admin', password: 'a long enough pass' }]);
  fs.chmodSync(file, 0o644);
  const store = new identity.UserStore(file).refresh();
  assert.strictEqual(store.error, null);
  assert.strictEqual(fs.statSync(file).mode & 0o077, 0, 'mode tightened');
});

ok('an invalid users file fails closed (store.error, no users)', () => {
  const file = tmpUsers('broken');
  fs.writeFileSync(file, '{ not json', { mode: 0o600 });
  const store = new identity.UserStore(file).refresh();
  assert.ok(store.error, 'error recorded');
  assert.strictEqual(store.count, 0, 'no user is trusted from a broken file');
});

ok('the role matrix is ordered and total', () => {
  const { viewer, operator, admin } = identity.ROLES;
  assert.ok(viewer < operator && operator < admin);
  assert.strictEqual(identity.atLeast('admin', 'operator'), true);
  assert.strictEqual(identity.atLeast('operator', 'admin'), false);
  assert.strictEqual(identity.atLeast('viewer', 'operator'), false);
  assert.strictEqual(identity.rank('root'), 0, 'unknown role ranks below viewer');
});

ok('login issues a session, rejects a wrong password, and locks out', () => {
  const file = seed(tmpUsers('login'), [
    { username: 'alice', role: 'operator', password: 'a long enough pass' },
    { username: 'dave', role: 'viewer', password: 'a long enough pass', disabled: true },
  ]);
  const id = identity.createIdentity({ usersFile: file, auditSink: () => ({ ok: true }) });
  const good = id.login('Alice', 'a long enough pass', {});
  assert.strictEqual(good.ok, true);
  assert.ok(good.sid && good.cookie.includes('HttpOnly') && good.cookie.includes('SameSite=Strict'));
  assert.strictEqual(good.user.role, 'operator');

  const bad = id.login('alice', 'wrong password here', {});
  assert.strictEqual(bad.ok, false);
  assert.strictEqual(bad.status, 401);

  const disabled = id.login('dave', 'a long enough pass', {});
  assert.strictEqual(disabled.ok, false, 'a disabled account cannot log in even with the right password');

  for (let i = 0; i < 5; i++) id.login('alice', 'nope-nope-nope', {});
  const locked = id.login('alice', 'a long enough pass', {});
  assert.strictEqual(locked.status, 429, 'lockout after repeated failures');
  assert.ok(locked.retryAfter > 0);
});

ok('a session re-checks the store: disable ends it on the next request', async () => {
  const file = seed(tmpUsers('session'), [{ username: 'alice', role: 'operator', password: 'a long enough pass' }]);
  const id = identity.createIdentity({ usersFile: file, auditSink: () => ({ ok: true }) });
  const { cookie } = id.login('alice', 'a long enough pass', {});
  const sid = cookie.split(';')[0];
  const p1 = await id.authenticate(req({ cookie: sid }));
  assert.strictEqual(p1 && p1.username, 'alice');

  id.updateUser('alice', { disabled: true }, { actor: 'test' });
  const p2 = await id.authenticate(req({ cookie: sid }));
  assert.strictEqual(p2, null, 'disabled user is not resurrected by a live cookie');
});

ok('sessions expire on their own: absolute TTL and idle timeout', async () => {
  const file = seed(tmpUsers('expiry'), [{ username: 'alice', role: 'operator', password: 'a long enough pass' }]);
  const ttl = identity.createIdentity({ root: T, usersFile: file, sessionTtlMs: 40, sessionIdleMs: 40 });
  const a = ttl.login('alice', 'a long enough pass', {});
  const sid = a.cookie.split(';')[0];
  assert.ok(await ttl.authenticate(req({ cookie: sid })), 'live before the TTL');
  await new Promise((r) => setTimeout(r, 60));
  assert.strictEqual(await ttl.authenticate(req({ cookie: sid })), null, 'gone after the TTL');

  // Idle is independent of absolute age: two requests keep it alive past the
  // idle window only while they are closer together than it.
  const idle = identity.createIdentity({ root: T, usersFile: file, sessionTtlMs: 60000, sessionIdleMs: 40 });
  const b = idle.login('alice', 'a long enough pass', {});
  const sid2 = b.cookie.split(';')[0];
  assert.ok(await idle.authenticate(req({ cookie: sid2 })));
  await new Promise((r) => setTimeout(r, 25));
  assert.ok(await idle.authenticate(req({ cookie: sid2 })), 'a request inside the idle window keeps it');
  await new Promise((r) => setTimeout(r, 25));
  assert.ok(await idle.authenticate(req({ cookie: sid2 })), 'sliding idle, not absolute');
  await new Promise((r) => setTimeout(r, 60));
  assert.strictEqual(await idle.authenticate(req({ cookie: sid2 })), null, 'idle expiry without activity');
});

ok('authorize() is the matrix: 401 anonymous, 403 by role, admin for accounts', () => {
  const id = identity.createIdentity({ root: T, usersFile: tmpUsers('matrix-missing'), serviceToken: null });
  const anon = id.authorize(null, '/api/overview', 'GET');
  assert.strictEqual(anon.status, 401);
  assert.strictEqual(anon.authRequired, true);

  const viewer = { username: 'v', role: 'viewer', provider: 'local' };
  assert.strictEqual(id.authorize(viewer, '/api/overview', 'GET').ok, true);
  assert.strictEqual(id.authorize(viewer, '/api/scope', 'POST').status, 403);
  assert.strictEqual(id.authorize(viewer, '/api/term/stream', 'GET').status, 403, 'a live shell is not a read');
  assert.strictEqual(id.authorize(viewer, '/api/users', 'GET').status, 403);

  const operator = { username: 'o', role: 'operator', provider: 'local' };
  assert.strictEqual(id.authorize(operator, '/api/scope', 'POST').ok, true);
  assert.strictEqual(id.authorize(operator, '/api/term/stream', 'GET').ok, true);
  assert.strictEqual(id.authorize(operator, '/api/users', 'GET').status, 403);
  assert.strictEqual(id.authorize(operator, '/api/users', 'POST').status, 403);

  const admin = { username: 'a', role: 'admin', provider: 'local' };
  assert.strictEqual(id.authorize(admin, '/api/users', 'GET').ok, true);
  assert.strictEqual(id.authorize(admin, '/api/users', 'POST').ok, true);
  assert.strictEqual(id.authorize(admin, '/api/users/alice', 'DELETE').ok, true);
});

ok('the service token authenticates as service, at operator level', async () => {
  const file = seed(tmpUsers('token'), [{ username: 'alice', role: 'admin', password: 'a long enough pass' }]);
  const id = identity.createIdentity({ root: T, usersFile: file, serviceToken: 'a'.repeat(48), tokenRole: 'operator' });
  const p = await id.authenticate(req({ 'x-cyboros-token': 'a'.repeat(48) }));
  assert.strictEqual(p.username, 'service');
  assert.strictEqual(p.role, 'operator');
  assert.strictEqual(p.provider, 'token');
  assert.strictEqual(id.authorize(p, '/api/users', 'GET').status, 403, 'the shared secret cannot manage accounts');
  assert.strictEqual(await id.authenticate(req({ 'x-cyboros-token': 'b'.repeat(48) })), null);
  assert.strictEqual(await id.authenticate(req({})), null);
});

ok('the provider seam accepts another identity backend without touching routes', async () => {
  const file = tmpUsers('provider-missing');
  const id = identity.createIdentity({ root: T, usersFile: file, serviceToken: null });
  id.registerProvider({
    name: 'oidc-stub',
    authenticate: (r) => {
      const bearer = (r.headers && r.headers.authorization) || '';
      if (bearer !== 'Bearer good-token') return null;
      return { username: 'sso.user', role: 'viewer', display_name: 'SSO User' };
    },
  });
  const p = await id.authenticate(req({ authorization: 'Bearer good-token' }));
  assert.strictEqual(p.username, 'sso.user');
  assert.strictEqual(p.provider, 'oidc-stub');
  assert.strictEqual(p.role, 'viewer');
  assert.strictEqual(await id.authenticate(req({ authorization: 'Bearer nope' })), null);

  // A provider that throws must not authenticate anybody.
  id.registerProvider({ name: 'broken', authenticate: () => { throw new Error('idp down'); } });
  assert.strictEqual(await id.authenticate(req({ authorization: 'Bearer nope' })), null);
});

ok('the audit sink receives the authenticated actor, never a caller-supplied one', () => {
  const file = seed(tmpUsers('audit'), [{ username: 'alice', role: 'operator', password: 'a long enough pass' }]);
  const events = [];
  const id = identity.createIdentity({ usersFile: file, auditSink: (e) => { events.push(e); return { ok: true }; } });
  id.login('alice', 'a long enough pass', { ip: '127.0.0.1' });
  id.login('alice', 'wrong password here', {});
  assert.strictEqual(events.find((e) => e.event === 'auth.login' && e.outcome === 'ok').actor, 'alice');
  assert.strictEqual(events.find((e) => e.event === 'auth.login' && e.outcome === 'deny').actor, 'alice');
  assert.ok(events.every((e) => e.chain === undefined), 'the sink, not identity, owns the chain');
});

ok('user administration refuses to remove the last enabled admin', () => {
  const file = seed(tmpUsers('lastadmin'), [{ username: 'root', role: 'admin', password: 'a long enough pass' }]);
  const id = identity.createIdentity({ usersFile: file, auditSink: () => ({ ok: true }) });
  const demote = id.updateUser('root', { role: 'operator' }, { actor: 'test' });
  assert.strictEqual(demote.ok, false);
  assert.match(demote.error, /last enabled admin/);
  const del = id.removeUser('root', { actor: 'test' });
  assert.strictEqual(del.ok, false);

  const second = id.addUser({ username: 'second', role: 'admin', password: 'another long pass' }, { actor: 'root' });
  assert.strictEqual(second.ok, true, 'a second admin can be created');
  assert.strictEqual(id.updateUser('root', { role: 'operator' }, { actor: 'root' }).ok, true, 'then the first may step down');
});

ok('the CLI creates an admin whose password works (no password argument)', () => {
  const root = path.join(T, 'cli-root');
  fs.mkdirSync(root, { recursive: true });
  const out = execFileSync(process.execPath, [path.join(WS, 'tools', 'users.js'), 'add', 'cliadmin', '--role', 'admin', '--generate'], {
    env: Object.assign({}, process.env, { CC_ROOT: root, CYBOROS_USERS_FILE: '' }),
    encoding: 'utf8',
  });
  const pw = (out.match(/^\s{2}([A-Za-z0-9_-]{24,})\s*$/m) || [])[1];
  assert.ok(pw, 'generated password printed exactly once');
  const file = path.join(root, 'users.json');
  assert.strictEqual(fs.statSync(file).mode & 0o077, 0, 'users.json is 0600');
  const id = identity.createIdentity({ usersFile: file, auditSink: () => ({ ok: true }) });
  assert.strictEqual(id.login('cliadmin', pw, {}).ok, true);
  assert.strictEqual(id.login('cliadmin', 'wrong password here', {}).ok, false);

  // A password argument is refused on purpose (shell history / procfs).
  let failed = false;
  try {
    execFileSync(process.execPath, [path.join(WS, 'tools', 'users.js'), 'add', 'x', '--role', 'viewer', '--password', 'secret'], {
      env: Object.assign({}, process.env, { CC_ROOT: root }), stdio: 'pipe',
    });
  } catch { failed = true; }
  assert.strictEqual(failed, true, 'unknown flag --password must fail');
});

summary('identity');
