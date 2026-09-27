#!/usr/bin/env node
// Command Center — single-instance arbitration + handshake (zero-dep).
//
// Why: the backend OWNS the PTY sessions (one `freebuff` TUI per terminal tab) and
// the job runner. Two backends on the same workspace would fight over the same
// files, so a second launch must ATTACH to the live one instead of spawning.
//
// Lock file: reports/app/server.lock (override CC_STATE_DIR for tests/other trees)
//   { version, pid, host, port, token, startedAt, url }   — mode 0600, atomic write
// A lock whose pid is gone is STALE: it is ignored for the attach decision and can
// be cleared without --force. `probe()` is the real handshake: it asks the live
// process /api/instance and only trusts an answer that identifies itself.
//
// CLI:
//   node tools/cc-instance.js status [--json]   # live / stale / none (exit 0/3/1)
//   node tools/cc-instance.js url               # print the live instance URL (exit 0) or exit 1
//   node tools/cc-instance.js probe             # HTTP handshake against the lock's instance
//   node tools/cc-instance.js release [--force] # remove a stale lock (--force also a live one)
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const VERSION = 1;

function stateDir() {
  return process.env.CC_STATE_DIR || path.join(ROOT, 'reports', 'app');
}
function lockFile() {
  return path.join(stateDir(), 'server.lock');
}
function newToken() {
  return crypto.randomBytes(24).toString('hex');
}

/** Read the lock. Returns null when absent, unreadable or malformed (never throws). */
function read() {
  try {
    const raw = JSON.parse(fs.readFileSync(lockFile(), 'utf8'));
    if (!raw || typeof raw !== 'object') return null;
    if (!Number.isInteger(raw.pid) || !Number.isInteger(raw.port)) return null;
    return {
      version: Number.isInteger(raw.version) ? raw.version : 0,
      pid: raw.pid,
      host: typeof raw.host === 'string' && raw.host ? raw.host : '127.0.0.1',
      port: raw.port,
      token: typeof raw.token === 'string' && raw.token ? raw.token : null,
      startedAt: typeof raw.startedAt === 'string' ? raw.startedAt : null,
      url: typeof raw.url === 'string' ? raw.url : null,
    };
  } catch {
    return null;
  }
}

/** Is the recorded process still there? (signal 0 probe; EPERM means it exists). */
function isAlive(rec) {
  if (!rec || !Number.isInteger(rec.pid) || rec.pid <= 0) return false;
  if (rec.pid === process.pid) return true;
  try {
    process.kill(rec.pid, 0);
    return true;
  } catch (e) {
    return !!(e && e.code === 'EPERM');
  }
}

/** Atomic write of the lock (tmp + rename, 0600, private dir). */
function write(rec) {
  const dir = stateDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = lockFile();
  const tmp = file + '.' + process.pid + '.tmp';
  const payload = {
    version: VERSION,
    pid: rec.pid,
    host: rec.host || '127.0.0.1',
    port: rec.port,
    token: rec.token || null,
    startedAt: rec.startedAt || new Date().toISOString(),
    url: rec.url || null,
  };
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
  return file;
}

/**
 * Remove the lock.
 *   clear({ pid })   → only your own lock
 *   clear()          → only a stale lock (dead pid)
 *   clear({force:true}) → whatever is there
 * A live instance owned by someone else is never removed implicitly.
 */
function clear(opts) {
  const o = opts || {};
  const cur = read();
  if (!cur) {
    try { fs.unlinkSync(lockFile()); } catch { /* nothing to do */ }
    return { ok: true, removed: false };
  }
  const isOwner = Number.isInteger(o.pid) && o.pid === cur.pid;
  if (!isOwner && !o.force && isAlive(cur)) {
    return { ok: false, removed: false, error: 'lock owned by a live instance', pid: cur.pid };
  }
  try {
    fs.unlinkSync(lockFile());
    return { ok: true, removed: true, pid: cur.pid };
  } catch (e) {
    return { ok: false, removed: false, error: String((e && e.message) || e) };
  }
}

function url(rec) {
  if (!rec) return null;
  const host = rec.host || '127.0.0.1';
  return 'http://' + host + ':' + rec.port + '/' + (rec.token ? '?token=' + rec.token : '');
}

/** GET helper with the lock's token attached. */
function get(rec, pathname, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: rec.host || '127.0.0.1',
      port: rec.port,
      path: pathname,
      method: 'GET',
      headers: rec.token ? { 'X-Stavros-Token': rec.token } : {},
      timeout: timeoutMs,
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch { /* non-JSON body */ }
        resolve({ status: res.statusCode || 0, json, body: data });
      });
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
    req.end();
  });
}

/** Handshake: the lock is trusted only if the process answers as our instance. */
async function probe(rec, opts) {
  const o = opts || {};
  if (!isAlive(rec)) {
    return { ok: false, alive: false, error: 'process not running (pid ' + (rec && rec.pid) + ')' };
  }
  try {
    const r = await get(rec, '/api/instance', o.timeoutMs || 1500);
    if (r.status !== 200 || !r.json || r.json.instance !== true) {
      return { ok: false, alive: true, error: 'handshake failed (HTTP ' + r.status + ')' };
    }
    return {
      ok: true,
      alive: true,
      pid: r.json.pid,
      port: r.json.port || rec.port,
      tokenRequired: !!r.json.tokenRequired,
      startedAt: r.json.startedAt || rec.startedAt,
    };
  } catch (e) {
    return { ok: false, alive: true, error: String((e && e.message) || e) };
  }
}

/** Take the lock if nobody live holds it. Returns { ok } or { ok:false, existing }. */
function claim(rec) {
  const cur = read();
  if (cur && isAlive(cur)) return { ok: false, existing: cur, reason: 'live instance' };
  if (cur) clear({ force: true });
  write(rec);
  return { ok: true };
}

async function main(argv) {
  const cmd = argv[2] || 'status';
  const asJson = argv.includes('--json');
  const force = argv.includes('--force');
  const rec = read();

  if (cmd === 'status') {
    const alive = !!(rec && isAlive(rec));
    const out = {
      instance: alive,
      stale: !!(rec && !alive),
      lock: rec ? {
        pid: rec.pid, host: rec.host, port: rec.port,
        startedAt: rec.startedAt, url: rec.url, tokenRequired: !!rec.token,
      } : null,
      stateDir: stateDir(),
    };
    if (asJson) console.log(JSON.stringify(out, null, 2));
    else if (!rec) console.log('no instance (no lock at ' + lockFile() + ')');
    else if (alive) console.log('instance alive: pid ' + rec.pid + ' → ' + (rec.url || url(rec)));
    else console.log('stale lock: pid ' + rec.pid + ' not running (node tools/cc-instance.js release)');
    return alive ? 0 : (rec ? 3 : 1);
  }

  if (cmd === 'url') {
    if (!rec || !isAlive(rec)) { console.error('no live instance'); return 1; }
    const st = await probe(rec);
    if (!st.ok) { console.error('instance not answering: ' + st.error); return 1; }
    console.log(rec.url || url(rec));
    return 0;
  }

  if (cmd === 'probe') {
    if (!rec) { console.error('no lock file'); return 1; }
    const st = await probe(rec);
    if (asJson) console.log(JSON.stringify(st, null, 2));
    else console.log(st.ok ? 'ok (pid ' + st.pid + ', tokenRequired=' + st.tokenRequired + ')' : 'failed: ' + st.error);
    return st.ok ? 0 : 1;
  }

  if (cmd === 'release') {
    const r = clear({ force });
    if (asJson) console.log(JSON.stringify(r, null, 2));
    else console.log(r.ok ? (r.removed ? 'lock removed (pid ' + r.pid + ')' : 'no lock') : 'refused: ' + r.error);
    return r.ok ? 0 : 1;
  }

  console.error('usage: node tools/cc-instance.js status|url|probe|release [--json] [--force]');
  return 2;
}

module.exports = { stateDir, lockFile, newToken, read, isAlive, write, clear, claim, url, probe, get, VERSION };

if (require.main === module) {
  main(process.argv)
    .then((code) => process.exit(code))
    .catch((e) => { console.error('cc-instance: ' + String((e && e.message) || e)); process.exit(1); });
}
