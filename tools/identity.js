#!/usr/bin/env node
// tools/identity.js — who is acting, decided in one place.
//
// Why this file exists: the Command Center used to authenticate *nothing*. One
// shared token gated writes, every read was loopback-trusted, and every action
// was attributed to a string the caller could choose. That is fine for one
// operator on their own laptop and disqualifying for a company, where the
// questions are "who approved this?" and "may this person see the client's
// findings?". This module answers both, and it is the only place that does.
//
// Design, in one paragraph: a user is a row in users.json (versioned, validated,
// mode 0600, path overridable with CYBOROS_USERS_FILE); a role is one of
// viewer < operator < admin; a browser gets an opaque session cookie after a
// scrypt password check; a machine sends the startup service token and acts as
// `service` with its own role. Route handlers never see any of that — the server
// hands them `principal`, and asks this module `authorize(principal, url,
// method)` exactly once per request. Every authentication and authorization
// decision is appended to the tamper-evident audit trail with the *authenticated*
// actor, never with a value from the request body.
//
// The seam for another identity backend (OIDC, mTLS, a corporate SSO proxy) is
// `registerProvider()` / `loadProvider(file)`: a provider is an object
//   { name, authenticate(req, ctx) -> principal|null (or a Promise of it) }
// and it is consulted before the service token. No route handler changes when a
// provider is added — that is the whole point of keeping identity out of them.
// See docs/IDENTITY.md for the contract and an OIDC sketch.
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ── roles ───────────────────────────────────────────────────────────────────
// Numeric ranks so "at least viewer" stays readable and comparable. Every role
// list is derived from this object, never re-typed.
const ROLES = Object.freeze({ viewer: 1, operator: 2, admin: 3 });
const ROLE_NAMES = Object.freeze(Object.keys(ROLES));

const SESSION = Object.freeze({
  cookie: 'cyboros_sid',
  ttlMs: 12 * 60 * 60 * 1000, // absolute: a session never outlives 12 h
  idleMs: 2 * 60 * 60 * 1000, // idle: 2 h without a request and it is gone
});
const LOGIN = Object.freeze({
  maxFails: 5,
  windowMs: 5 * 60 * 1000,
  lockMs: 60 * 1000,
});
const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{1,31}$/;
const PASSWORD_MIN = 12;
const SCRYPT = Object.freeze({ N: 16384, r: 8, p: 1, keylen: 64, maxmem: 96 * 1024 * 1024 });
const DOC_VERSION = 1;

function rank(role) {
  return ROLES[String(role || '')] || 0;
}
function atLeast(role, needed) {
  return rank(role) >= rank(needed);
}
function roleName(role) {
  const r = String(role || '');
  return ROLES[r] ? r : null;
}

// ── passwords ───────────────────────────────────────────────────────────────
// scrypt with a per-user salt, stored as one self-describing string:
//   scrypt$N$r$p$<salt base64url>$<key base64url>
// base64url keeps '$' out of the payload, so splitting the record is total.
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(String(password), salt, SCRYPT.keylen, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64url'), key.toString('base64url')].join('$');
}

function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  // Refuse absurd work factors instead of hanging a login thread on them.
  if (N < 1024 || N > 1 << 20 || r < 1 || r > 32 || p < 1 || p > 16) return false;
  let salt;
  let want;
  try {
    salt = Buffer.from(parts[4], 'base64url');
    want = Buffer.from(parts[5], 'base64url');
  } catch { return false; }
  if (!salt.length || want.length < 16) return false;
  let got;
  try {
    got = crypto.scryptSync(String(password), salt, want.length, { N, r, p, maxmem: SCRYPT.maxmem });
  } catch { return false; }
  return crypto.timingSafeEqual(got, want);
}

function passwordProblem(username, password) {
  const pw = String(password == null ? '' : password);
  if (pw.length < PASSWORD_MIN) return `password must be at least ${PASSWORD_MIN} characters`;
  if (pw.length > 1024) return 'password is too long (max 1024)';
  if (username && pw.toLowerCase() === String(username).toLowerCase()) return 'password must not equal the username';
  return null;
}

// ── users file: schema + strict validation ──────────────────────────────────
function emptyDoc() {
  return { version: DOC_VERSION, users: [] };
}

function validateUserRow(u, i) {
  const where = `users[${i}]`;
  if (!u || typeof u !== 'object' || Array.isArray(u)) return `${where} must be an object`;
  const username = String(u.username || '').trim().toLowerCase();
  if (!USERNAME_RE.test(username)) return `${where}.username must match ${USERNAME_RE}`;
  const role = roleName(u.role);
  if (!role) return `${where}.role must be one of ${ROLE_NAMES.join('|')}`;
  if (typeof u.password_hash !== 'string' || !u.password_hash.startsWith('scrypt$')) return `${where}.password_hash must be a scrypt hash`;
  if (u.disabled != null && typeof u.disabled !== 'boolean') return `${where}.disabled must be a boolean`;
  if (u.display_name != null && (typeof u.display_name !== 'string' || u.display_name.length > 80)) return `${where}.display_name must be a string <= 80 chars`;
  return null;
}

// Strict on the fields that decide access, tolerant of extra fields so a future
// version can add metadata without a migration breaking this one.
function parseUsersDoc(raw) {
  let doc;
  try { doc = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (e) { return { ok: false, error: 'users file is not valid JSON: ' + e.message }; }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { ok: false, error: 'users file must be a JSON object' };
  if (Number(doc.version) !== DOC_VERSION) return { ok: false, error: `users file version must be ${DOC_VERSION} (found ${JSON.stringify(doc.version)})` };
  if (!Array.isArray(doc.users)) return { ok: false, error: 'users file must have a "users" array' };
  const seen = new Set();
  const users = [];
  for (let i = 0; i < doc.users.length; i++) {
    const problem = validateUserRow(doc.users[i], i);
    if (problem) return { ok: false, error: problem };
    const u = doc.users[i];
    const username = String(u.username).trim().toLowerCase();
    if (seen.has(username)) return { ok: false, error: `duplicate username: ${username}` };
    seen.add(username);
    users.push({
      username,
      role: roleName(u.role),
      password_hash: u.password_hash,
      disabled: u.disabled === true,
      display_name: typeof u.display_name === 'string' ? u.display_name : '',
      created_at: typeof u.created_at === 'string' ? u.created_at : null,
      last_login: typeof u.last_login === 'string' ? u.last_login : null,
    });
  }
  return { ok: true, doc: { version: DOC_VERSION, users } };
}

function publicUser(u) {
  return {
    username: u.username,
    role: u.role,
    display_name: u.display_name || '',
    disabled: !!u.disabled,
    created_at: u.created_at || null,
    last_login: u.last_login || null,
  };
}

// The file is the authorization surface for the console: 0600 or it is refused.
// Tightening succeeds silently (doctor.js does the same for scope.json); a file
// that stays world-readable is an error, not a warning, because the alternative
// is running an authentication system the operator does not control.
function tightenFile(file) {
  if (process.platform === 'win32') return { ok: true };
  try {
    const st = fs.statSync(file);
    if ((st.mode & 0o077) === 0) return { ok: true };
    fs.chmodSync(file, 0o600);
    return { ok: true, tightened: true };
  } catch (e) {
    return { ok: false, error: `users file is group/other readable and cannot be tightened: ${e.message}` };
  }
}

class UserStore {
  constructor(file) {
    this.file = file;
    this.doc = emptyDoc();
    this.error = null;
    this.mtimeMs = -1;
    this.exists = false;
  }

  // mtime-cached: a request costs one stat(), and an admin editing users.json
  // (or the CLI adding a user) is visible on the next request with no restart.
  refresh() {
    let st;
    try { st = fs.statSync(this.file); } catch {
      this.exists = false;
      this.doc = emptyDoc();
      this.error = null;
      this.mtimeMs = -1;
      return this;
    }
    this.exists = true;
    if (st.mtimeMs === this.mtimeMs) return this;
    const perms = tightenFile(this.file);
    if (!perms.ok) {
      this.error = perms.error;
      this.doc = emptyDoc();
      this.mtimeMs = st.mtimeMs;
      return this;
    }
    let raw;
    try { raw = fs.readFileSync(this.file, 'utf8'); } catch (e) {
      this.error = 'cannot read users file: ' + e.message;
      this.doc = emptyDoc();
      this.mtimeMs = st.mtimeMs;
      return this;
    }
    const parsed = parseUsersDoc(raw);
    if (!parsed.ok) {
      this.error = parsed.error;
      this.doc = emptyDoc();
    } else {
      this.error = null;
      this.doc = parsed.doc;
    }
    this.mtimeMs = st.mtimeMs;
    return this;
  }

  list() { return this.doc.users.map(publicUser); }
  find(username) { return this.doc.users.find((u) => u.username === String(username || '').toLowerCase()) || null; }
  admins() { return this.doc.users.filter((u) => u.role === 'admin' && !u.disabled); }
  get count() { return this.doc.users.length; }
}

function writeUsersDoc(file, doc) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = file + '.' + process.pid + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', { mode: 0o600 });
    try { fs.chmodSync(tmp, 0o600); } catch { /* windows */ }
    fs.renameSync(tmp, file);
    try { fs.chmodSync(file, 0o600); } catch { /* windows */ }
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    return { ok: false, error: 'cannot write users file: ' + e.message };
  }
  return { ok: true, file };
}

// ── cookies + sessions ──────────────────────────────────────────────────────
function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    out[k] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function cookieHeader(sid, opts) {
  const o = opts || {};
  const bits = [`${SESSION.cookie}=${encodeURIComponent(sid)}`, 'Path=/', 'HttpOnly', 'SameSite=Strict'];
  bits.push('Max-Age=' + Math.floor(o.maxAge != null ? o.maxAge : SESSION.ttlMs / 1000));
  if (o.secure) bits.push('Secure');
  return bits.join('; ');
}

function clearCookieHeader(opts) {
  const bits = [`${SESSION.cookie}=`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0'];
  if (opts && opts.secure) bits.push('Secure');
  return bits.join('; ');
}

// ── provider seam ───────────────────────────────────────────────────────────
function isProvider(p) {
  return !!p && typeof p === 'object' && typeof p.name === 'string' && p.name.length > 0 && typeof p.authenticate === 'function';
}

// ── identity ────────────────────────────────────────────────────────────────
function createIdentity(opts) {
  const o = opts || {};
  const root = o.root || path.join(__dirname, '..');
  const usersFile = o.usersFile || process.env.CYBOROS_USERS_FILE || path.join(root, 'users.json');
  const serviceToken = o.serviceToken || null;
  const tokenRole = roleName(o.tokenRole) || 'operator';
  // Overridable so the expiry rules can be exercised without waiting 12 hours.
  const sessionTtlMs = Number(o.sessionTtlMs) > 0 ? Number(o.sessionTtlMs) : SESSION.ttlMs;
  const sessionIdleMs = Number(o.sessionIdleMs) > 0 ? Number(o.sessionIdleMs) : SESSION.idleMs;
  // Cookie lifetime follows the instance's TTL, not the module default.
  const mintCookie = (sid, opts) => cookieHeader(sid, Object.assign({ maxAge: sessionTtlMs / 1000 }, opts));
  const store = new UserStore(usersFile).refresh();
  const sessions = new Map(); // sid -> { username, role, provider, createdAt, lastSeen }
  const lockouts = new Map(); // username -> { fails: [ts], lockedUntil }
  const providers = [];
  // The trail follows the installation, not the process cwd: CC_ROOT isolates the
  // console's data, so its audit must stay inside that root (a demo/isolated run
  // must not append identity events to a real engagement's trail).
  const auditDir = o.auditDir || process.env.AUDIT_DIR || path.join(root, 'artifacts', 'audit');
  const auditSink = typeof o.auditSink === 'function' ? o.auditSink : (entry) => {
    try { return require('./audit-trail').append(entry, { dir: auditDir }); } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  };
  // One scrypt run for a username that does not exist, so "user unknown" and
  // "wrong password" cost the same time. Computed lazily, once.
  let dummyHash = null;
  const dummy = () => {
    if (!dummyHash) dummyHash = hashPassword(crypto.randomBytes(18).toString('base64url'));
    return dummyHash;
  };

  function audit(event) {
    const entry = Object.assign({ ts: new Date().toISOString() }, event);
    let r;
    try { r = auditSink(entry); } catch (e) { r = { ok: false, error: String((e && e.message) || e) }; }
    if (r && r.ok === false) {
      // A broken audit chain is its own incident (audit-trail.js fails closed on
      // append). The console keeps working — locking everyone out because the
      // trail is unreadable would be a denial of service — but it is never silent.
      console.error('identity: audit append refused: ' + (r.error || 'unknown'));
    }
    return r;
  }

  function registerProvider(p) {
    if (!isProvider(p)) throw new Error('identity provider must be { name, authenticate(req, ctx) }');
    providers.push(p);
    return p;
  }

  function loadProvider(file) {
    const mod = require(path.resolve(file));
    return registerProvider(mod && mod.default ? mod.default : mod);
  }

  function principalFor(user, provider) {
    return { username: user.username, role: user.role, provider: provider || 'local', display_name: user.display_name || '' };
  }

  function sessionPrincipal(sid) {
    const s = sessions.get(sid);
    if (!s) return null;
    const now = Date.now();
    if (now - s.createdAt > sessionTtlMs || now - s.lastSeen > sessionIdleMs) {
      sessions.delete(sid);
      return null;
    }
    // Re-read the store: a disabled user or a changed role takes effect on the
    // next request, not on the next login.
    store.refresh();
    if (store.error) return null;
    const user = store.find(s.username);
    if (!user || user.disabled) {
      sessions.delete(sid);
      return null;
    }
    s.role = user.role;
    s.lastSeen = now;
    return principalFor(user, s.provider);
  }

  function issueSession(principal) {
    const sid = crypto.randomBytes(32).toString('base64url');
    sessions.set(sid, {
      username: principal.username,
      role: principal.role,
      provider: principal.provider || 'local',
      createdAt: Date.now(),
      lastSeen: Date.now(),
    });
    return sid;
  }

  // Header first, then ?token= (an EventSource cannot set headers). Parsed from
  // req.url here so the caller has nothing to remember to attach.
  function tokenFrom(req) {
    const h = req.headers || {};
    const header = h['x-cyboros-token'] || h['x-stavros-token'];
    if (header) return String(header);
    try {
      const q = new URL(req.url || '/', 'http://localhost').searchParams.get('token');
      return q ? String(q) : '';
    } catch { return ''; }
  }

  function tokenMatches(given) {
    if (!serviceToken || !given) return false;
    const a = Buffer.from(String(given));
    const b = Buffer.from(String(serviceToken));
    if (a.length !== b.length) return false;
    try { return crypto.timingSafeEqual(a, b); } catch { return false; }
  }

  function servicePrincipal() {
    return { username: 'service', role: tokenRole, provider: 'token', display_name: 'service token' };
  }

  // Sessions first (a human), then providers (an SSO backend), then the machine
  // token. A provider that throws does not open the door.
  async function authenticate(req) {
    const sid = parseCookies(req.headers && req.headers.cookie)[SESSION.cookie];
    if (sid) {
      const p = sessionPrincipal(sid);
      if (p) return p;
    }
    for (const prov of providers) {
      let got = null;
      try { got = await prov.authenticate(req, { store, usersFile, serviceToken }); } catch { got = null; }
      if (!got) continue;
      const role = roleName(got.role);
      const username = String(got.username || '').trim().toLowerCase();
      if (!role || !username) continue;
      return { username, role, provider: prov.name, display_name: String(got.display_name || '') };
    }
    if (tokenMatches(tokenFrom(req))) return servicePrincipal();
    return null;
  }

  // ── login ────────────────────────────────────────────────────────────────
  function lockedFor(username, now) {
    const l = lockouts.get(username);
    if (!l) return 0;
    if (l.lockedUntil > now) return Math.ceil((l.lockedUntil - now) / 1000);
    return 0;
  }

  function recordFailure(username, now) {
    const l = lockouts.get(username) || { fails: [], lockedUntil: 0 };
    l.fails = l.fails.filter((t) => now - t <= LOGIN.windowMs);
    l.fails.push(now);
    if (l.fails.length >= LOGIN.maxFails) {
      l.lockedUntil = now + LOGIN.lockMs;
      l.fails = [];
    }
    lockouts.set(username, l);
  }

  function login(username, password, meta) {
    const now = Date.now();
    const u = String(username || '').trim().toLowerCase();
    const ip = (meta && meta.ip) || '-';
    if (!u || !password) return { ok: false, status: 401, error: 'invalid credentials' };
    const wait = lockedFor(u, now);
    if (wait > 0) {
      audit({ event: 'auth.login', actor: u, role: null, provider: 'local', outcome: 'locked', ip, detail: 'retry after ' + wait + 's' });
      return { ok: false, status: 429, error: 'too many failed attempts', retryAfter: wait };
    }
    store.refresh();
    if (store.error) return { ok: false, status: 503, error: 'identity store unavailable: ' + store.error };
    const user = store.find(u);
    const stored = user && !user.disabled ? user.password_hash : dummy();
    const good = verifyPassword(String(password), stored) && !!user && !user.disabled;
    if (!good) {
      recordFailure(u, now);
      audit({ event: 'auth.login', actor: u, role: user ? user.role : null, provider: 'local', outcome: 'deny', ip, detail: 'invalid credentials' });
      // Same answer for "no such user" and "wrong password" (no enumeration).
      return { ok: false, status: 401, error: 'invalid credentials' };
    }
    lockouts.delete(u);
    const principal = principalFor(user, 'local');
    const sid = issueSession(principal);
    user.last_login = new Date(now).toISOString();
    // Best-effort: last_login is convenience metadata, never an access decision.
    try {
      const doc = JSON.parse(JSON.stringify(store.doc));
      const row = doc.users.find((x) => x.username === user.username);
      if (row) row.last_login = user.last_login;
      writeUsersDoc(usersFile, doc);
    } catch { /* ignore */ }
    audit({ event: 'auth.login', actor: user.username, role: user.role, provider: 'local', outcome: 'ok', ip });
    return { ok: true, sid, user: publicUser(user), cookie: mintCookie(sid, { secure: !!(meta && meta.secure) }) };
  }

  function logout(req, meta) {
    const sid = parseCookies(req.headers && req.headers.cookie)[SESSION.cookie];
    let actor = null;
    if (sid) {
      const s = sessions.get(sid);
      if (s) actor = s.username;
      sessions.delete(sid);
    }
    if (actor) audit({ event: 'auth.logout', actor, role: null, provider: 'local', outcome: 'ok', ip: (meta && meta.ip) || '-' });
    return { ok: true, cookie: clearCookieHeader({ secure: !!(meta && meta.secure) }) };
  }

  // Used by the launcher/desktop shell: opening the tokenized URL exchanges the
  // machine token for a real session, so the token stops living in the page's JS.
  function sessionForServiceToken(token) {
    if (!tokenMatches(token)) return null;
    const principal = servicePrincipal();
    const sid = issueSession(principal);
    audit({ event: 'auth.login', actor: principal.username, role: principal.role, provider: 'token', outcome: 'ok', ip: '-' });
    return { sid, user: principal, cookie: mintCookie(sid) };
  }

  // ── authorization ────────────────────────────────────────────────────────
  // One table, one call site. A new route either falls into a method-based
  // class or is named here explicitly; there is no route that skips this.
  function requiredRole(url, method) {
    if (url === '/api/users' || url.startsWith('/api/users/')) return 'admin';
    if (url === '/api/term/stream') return 'operator'; // a live shell is not a read-only view
    if (/^\/api\/jobs\/[^/]+\/events$/.test(url)) return 'operator'; // job output is tool output
    if (method === 'GET' || method === 'HEAD') return 'viewer';
    return 'operator';
  }

  function authorize(principal, url, method) {
    const need = requiredRole(url, method);
    if (!principal) return { ok: false, status: 401, need, error: 'authentication required', authRequired: true };
    if (!atLeast(principal.role, need)) {
      return { ok: false, status: 403, need, error: `role '${principal.role}' may not ${method} ${url} (requires '${need}')` };
    }
    return { ok: true, need };
  }

  // ── user administration (shared by the CLI and the admin API) ────────────
  function currentDoc() {
    store.refresh();
    if (store.error) return { ok: false, error: store.error };
    return { ok: true, doc: JSON.parse(JSON.stringify({ version: DOC_VERSION, users: store.doc.users })) };
  }

  function listUsers() {
    store.refresh();
    return { ok: true, users: store.list(), error: store.error };
  }

  function addUser(spec, meta) {
    const s = spec || {};
    const username = String(s.username || '').trim().toLowerCase();
    if (!USERNAME_RE.test(username)) return { ok: false, error: `username must match ${USERNAME_RE}` };
    const role = roleName(s.role);
    if (!role) return { ok: false, error: `role must be one of ${ROLE_NAMES.join('|')}` };
    const pwProblem = passwordProblem(username, s.password);
    if (pwProblem) return { ok: false, error: pwProblem };
    const cur = currentDoc();
    if (!cur.ok) return cur;
    if (cur.doc.users.some((u) => u.username === username)) return { ok: false, error: `user already exists: ${username}` };
    const row = {
      username,
      role,
      password_hash: hashPassword(String(s.password)),
      disabled: false,
      display_name: String(s.display_name || '').slice(0, 80),
      created_at: new Date().toISOString(),
      last_login: null,
    };
    cur.doc.users.push(row);
    const w = writeUsersDoc(usersFile, cur.doc);
    if (!w.ok) return w;
    store.refresh();
    audit({ event: 'user.create', actor: (meta && meta.actor) || 'system', role: (meta && meta.role) || null, provider: 'local', outcome: 'ok', detail: `${username} as ${role}` });
    return { ok: true, user: publicUser(row) };
  }

  function lastAdminGuard(doc, username, nextRole, nextDisabled) {
    const admins = doc.users.filter((u) => u.role === 'admin' && !u.disabled);
    const target = doc.users.find((u) => u.username === username);
    if (!target) return 'user not found';
    const stillAdmin = nextRole != null ? nextRole : target.role;
    const stillEnabled = nextDisabled != null ? !nextDisabled : !target.disabled;
    const losesAdmin = target.role === 'admin' && !target.disabled && (stillAdmin !== 'admin' || !stillEnabled);
    if (losesAdmin && admins.length <= 1) return 'refusing to remove the last enabled admin';
    return null;
  }

  function updateUser(username, patch, meta) {
    const u = String(username || '').trim().toLowerCase();
    const p = patch || {};
    const cur = currentDoc();
    if (!cur.ok) return cur;
    const row = cur.doc.users.find((x) => x.username === u);
    if (!row) return { ok: false, error: 'user not found' };
    let nextRole = null;
    let nextDisabled = null;
    if (p.role != null) {
      nextRole = roleName(p.role);
      if (!nextRole) return { ok: false, error: `role must be one of ${ROLE_NAMES.join('|')}` };
    }
    if (p.disabled != null) {
      if (typeof p.disabled !== 'boolean') return { ok: false, error: 'disabled must be a boolean' };
      nextDisabled = p.disabled;
    }
    if (nextRole != null || nextDisabled != null) {
      const guard = lastAdminGuard(cur.doc, u, nextRole, nextDisabled);
      if (guard) return { ok: false, error: guard };
    }
    if (p.password != null) {
      const pwProblem = passwordProblem(u, p.password);
      if (pwProblem) return { ok: false, error: pwProblem };
      row.password_hash = hashPassword(String(p.password));
    }
    if (nextRole != null) row.role = nextRole;
    if (nextDisabled != null) row.disabled = nextDisabled;
    if (p.display_name != null) {
      if (typeof p.display_name !== 'string' || p.display_name.length > 80) return { ok: false, error: 'display_name must be a string <= 80 chars' };
      row.display_name = p.display_name;
    }
    const w = writeUsersDoc(usersFile, cur.doc);
    if (!w.ok) return w;
    store.refresh();
    // Changing a password or disabling an account ends its sessions now.
    if (p.password != null || nextDisabled === true) revokeUserSessions(u);
    audit({ event: 'user.update', actor: (meta && meta.actor) || 'system', role: (meta && meta.role) || null, provider: 'local', outcome: 'ok', detail: u });
    return { ok: true, user: publicUser(row) };
  }

  function removeUser(username, meta) {
    const u = String(username || '').trim().toLowerCase();
    const cur = currentDoc();
    if (!cur.ok) return cur;
    const row = cur.doc.users.find((x) => x.username === u);
    if (!row) return { ok: false, error: 'user not found' };
    const guard = lastAdminGuard(cur.doc, u, null, true);
    if (guard) return { ok: false, error: guard };
    cur.doc.users = cur.doc.users.filter((x) => x.username !== u);
    const w = writeUsersDoc(usersFile, cur.doc);
    if (!w.ok) return w;
    store.refresh();
    revokeUserSessions(u);
    audit({ event: 'user.remove', actor: (meta && meta.actor) || 'system', role: (meta && meta.role) || null, provider: 'local', outcome: 'ok', detail: u });
    return { ok: true, removed: u };
  }

  function revokeUserSessions(username) {
    let n = 0;
    for (const [sid, s] of sessions) {
      if (s.username === username) { sessions.delete(sid); n++; }
    }
    return n;
  }

  function setPassword(username, password, meta) {
    return updateUser(username, { password }, meta);
  }

  return {
    usersFile,
    auditDir,
    store,
    ROLES,
    ROLE_NAMES,
    tokenRole,
    hasServiceToken: !!serviceToken,
    rank,
    atLeast,
    authenticate,
    authorize,
    requiredRole,
    login,
    logout,
    sessionForServiceToken,
    listUsers,
    addUser,
    updateUser,
    removeUser,
    setPassword,
    revokeUserSessions,
    registerProvider,
    loadProvider,
    audit,
    cookieHeader,
    clearCookieHeader,
    publicUser,
    // exported for tests and for the CLI, not for route handlers
    _internal: { sessions, lockouts, store, hashPassword, verifyPassword, writeUsersDoc, parseUsersDoc },
  };
}

// CLI: the smallest useful surface — list users, and show the file in force.
// Creating/altering users lives in tools/users.js so this module stays a library.
if (require.main === module) {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const id = createIdentity({});
  if (cmd === 'list' || !cmd) {
    const r = id.listUsers();
    if (r.error) { console.error('identity: ' + r.error); process.exit(2); }
    if (!r.users.length) console.log('no users configured — create one: node tools/users.js add <name> --role admin --generate');
    for (const u of r.users) console.log(`${u.username}\t${u.role}${u.disabled ? '\tDISABLED' : ''}\t${u.display_name || ''}`);
    process.exit(0);
  }
  if (cmd === 'path') { console.log(id.usersFile); process.exit(0); }
  console.error('usage: node tools/identity.js [list|path]');
  process.exit(2);
}

module.exports = {
  ROLES,
  ROLE_NAMES,
  SESSION,
  rank,
  atLeast,
  roleName,
  hashPassword,
  verifyPassword,
  passwordProblem,
  parseUsersDoc,
  publicUser,
  writeUsersDoc,
  UserStore,
  cookieHeader,
  clearCookieHeader,
  parseCookies,
  createIdentity,
  isProvider,
};
