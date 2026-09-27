#!/usr/bin/env node
// Stavros Console — local dashboard GUI (zero-dependencies).
//
//   node tools/gui-server.js [--port N] [--host 127.0.0.1]
//
// Serves a single-page dashboard (tools/gui/) bound to 127.0.0.1 by default and
// exposes a small JSON API over the harness data. It NEVER bypasses the guards:
// write actions shell out to the existing tools (stavros.js resume,
// report-html.js) and the scope editor validates through the same rules the
// scope-guard applies at runtime.
//
// Data read (read-only):
//   scope.json · operation-state.json · reports/findings.jsonl
//   reports/state.db (node:sqlite, read-only) · reports/sessions.json
//   reports/loot.jsonl (count only — rows contain secrets, never echoed)
//   reports/*.html (served under /reports/<name> for viewing)
//
// Hardening: bound to loopback, Host must be 127.0.0.1/localhost/[::1],
// Origin checked when present (DNS-rebinding + CSRF), JSON body size capped.
// Session token: required on every write (POST/DELETE) and on the interactive
// streams (terminal, job events) — it is printed inside the startup URL. Data
// reads stay loopback-trusted exactly as before; `--token off` disables the gate.
// Single instance: `--instance` uses reports/app/server.lock (cc-instance.js); if a
// live instance already answers the handshake this process prints SCC_ATTACH=<url>
// and exits 3 instead of becoming a second backend over the same PTYs.
// `--print-port` prints SCC_PORT=/SCC_URL= once listening (port 0 = ephemeral).
const http = require('http');
const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn, execFile } = require('child_process');
const crypto = require('crypto');
const ccInstance = require('./cc-instance');
const ccRouter = require('./cc-router'); // WP3..WP7 additive /api/cc/* router
const { augmentPath } = require('./tool-path');

// The harness resolves binaries through PATH (doctor.js, tool-plane.js, run.js) and every
// child of this server inherits ours. A dashboard started from a tray/autostart gets the
// SYSTEM path, which hides ~/go/bin and ~/.local/bin: installed tools would be reported as
// missing and dispatched jobs would die with "not found". Fix it once, here, for every child.
augmentPath(process.env);

const TOOLS_DIR = __dirname;
const ROOT = path.join(TOOLS_DIR, '..');
const GUI_DIR = path.join(TOOLS_DIR, 'gui');
const REPORTS = path.join(ROOT, 'reports');
// SCOPE_JSON is the same override scope-guard.js honors (tests, multi-project setups).
const SCOPE_FILE = process.env.SCOPE_JSON || path.join(ROOT, 'scope.json');
const OPSTATE_FILE = path.join(ROOT, 'operation-state.json');
const SESSIONS_FILE = path.join(REPORTS, 'sessions.json');
const LOOT_FILE = path.join(REPORTS, 'loot.jsonl');
const STATE_DB = path.join(REPORTS, 'state.db');

// ── CLI/env ────────────────────────────────────────────────────────────────
function argVal(flag, def) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
// port 0 = ephemeral: the real port is known after listen (and written to the lock)
const PORT = (() => {
  const n = parseInt(process.env.GUI_PORT || argVal('--port', '8787'), 10);
  return Number.isFinite(n) && n >= 0 ? n : 8787;
})();
const HOST = process.env.GUI_HOST || argVal('--host', '127.0.0.1');

const INSTANCE = process.argv.includes('--instance') || process.env.SCC_INSTANCE === '1';
const READ_ONLY = process.argv.includes('--read-only') || process.env.SCC_READ_ONLY === '1';
const PRINT_HANDSHAKE = process.argv.includes('--print-port') || process.env.SCC_PRINT_PORT === '1';

// Session token: `auto` (default) mints one per run, `off` is the deliberate
// no-auth mode, anything else is used verbatim (scripts/tests).
const TOKEN_OPT = (() => {
  const v = process.env.SCC_TOKEN || argVal('--token', 'auto');
  return String(v || 'auto').startsWith('--') ? 'auto' : String(v || 'auto');
})();
const TOKEN = TOKEN_OPT === 'off' ? null : (TOKEN_OPT === 'auto' ? crypto.randomBytes(24).toString('hex') : TOKEN_OPT);
const STARTED_AT = new Date().toISOString();
let boundPort = PORT;

// ── tiny helpers ───────────────────────────────────────────────────────────
const CT = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
function sendText(res, code, text) {
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(text);
}
function readJsonFile(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function readJsonl(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n')
      .map((l) => l.trim()).filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}
function fileMtime(file) {
  try { return fs.statSync(file).mtime.toISOString(); } catch { return null; }
}
function atomicWrite(file, data) {
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

// ── Host/Origin guard (rebinding + CSRF) ───────────────────────────────────
function hostIsLoopback(hostHeader) {
  const h = String(hostHeader || '');
  if (!h) return false;
  let name = h;
  if (h.startsWith('[')) { const end = h.indexOf(']'); if (end < 0) return false; name = h.slice(1, end); }
  else name = h.split(':')[0];
  return name === '127.0.0.1' || name === 'localhost' || name === '::1';
}
function guardOk(req) {
  if (!hostIsLoopback(req.headers.host)) return false;
  const origin = req.headers.origin;
  if (origin) {
    try {
      const u = new URL(origin);
      if (!(u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '::1')) return false;
    } catch { return false; }
  }
  return true;
}

// ── session token (writes + interactive streams) ────────────────────────────
function tokenOk(req, query) {
  if (!TOKEN) return true;
  const given = String((req.headers && req.headers['x-stavros-token']) || (query && query.token) || '');
  if (given.length !== TOKEN.length) return false;   // timingSafeEqual needs equal lengths
  try { return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(TOKEN)); } catch { return false; }
}
function denyToken(res) {
  return sendJson(res, 403, {
    error: 'session token required — open the tokenized URL printed at startup',
    tokenRequired: true,
  });
}

// ── background jobs (resume / report generation) ──────────────────────────
const jobs = new Map();
let jobSeq = 1;
function runJob(name, cmdArgs, extra) {
  const id = 'job' + jobSeq++;
  const job = {
    id, name, lines: [], state: 'running', exitCode: null,
    out: extra && extra.out || null,
    startedAt: new Date().toISOString(), finishedAt: null,
    listeners: new Set(),
  };
  jobs.set(id, job);
  const push = (chunk) => {
    const text = chunk.toString();
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      job.lines.push(line);
      if (job.lines.length > 4000) job.lines.splice(0, job.lines.length - 4000);
      for (const cb of job.listeners) cb({ type: 'line', line });
    }
  };
  const child = spawn(process.execPath, cmdArgs, {
    cwd: ROOT,
    env: Object.assign({}, process.env, { GUI_NO_LOG: '1' }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', push);
  child.stderr.on('data', push);
  child.on('error', (e) => {
    job.state = 'error';
    job.exitCode = -1;
    job.finishedAt = new Date().toISOString();
    for (const cb of job.listeners) cb({ type: 'done', exitCode: -1, error: String(e.message || e), out: job.out });
    job.listeners.clear();
  });
  child.on('close', (code) => {
    job.state = code === 0 ? 'done' : 'error';
    job.exitCode = code;
    job.finishedAt = new Date().toISOString();
    for (const cb of job.listeners) cb({ type: 'done', exitCode: code, out: job.out });
    job.listeners.clear();
  });
  return id;
}

// ── embedded TUI terminals — direct PTY bridges, one per named session ──────
// Each tab (freebuff) owns ONE fbpty.py process living in the
// SERVER: a real PTY sized like the browser terminal, surviving reloads.
// SSE clients are VIEWERS: on connect they get a byte-exact replay of the
// session output (capped), then live frames. Input from any client goes to
// that session's PTY; resize resizes it and the TUI re-flows. If the TUI
// dies on its own the server auto-restarts it with a circuit breaker.
// (v3 — generalized from the single-session direct-PTY v2.)
const TERM_COLS = 120;
const TERM_ROWS = 32;
const FBPTY = path.join(TOOLS_DIR, 'fbpty.py');
const FB_REPLAY_MAX = 2 * 1024 * 1024; // screen-history bytes kept for replay

const TERM_DEFS = {
  freebuff: { label: 'Freebuff', cwd: ROOT, cmd: 'freebuff --cwd ' + ROOT },
};

function mkSession(def) {
  return {
    def,
    proc: null,            // the fbpty.py child (null = not running)
    cmdLine: null,         // command it is running
    cols: TERM_COLS,
    rows: TERM_ROWS,
    replay: [],            // output chunks since start (Buffer[])
    replayBytes: 0,
    stopping: false,       // set by stop → suppress auto-restart
    restarts: [],          // auto-restart circuit breaker timestamps
    seq: 0,
    clients: new Map(),    // sse id -> res
  };
}
const termSessions = new Map();
for (const k of Object.keys(TERM_DEFS)) termSessions.set(k, mkSession(TERM_DEFS[k]));
const termDefault = 'freebuff';
let fbSeq = 0;               // global SSE viewer id counter

function fbClamp(v, lo, hi, dflt) {
  const n = parseInt(v, 10);
  return Math.max(lo, Math.min(hi, Number.isFinite(n) && n > 0 ? n : dflt));
}

function fbKeepReplay(S, buf) {
  S.replay.push(buf);
  S.replayBytes += buf.length;
  while (S.replayBytes > FB_REPLAY_MAX && S.replay.length > 1) {
    S.replayBytes -= S.replay[0].length;
    S.replay.shift();
  }
}

function fbBroadcast(S, buf) {
  fbKeepReplay(S, buf);
  const frame = 'data: ' + buf.toString('base64') + '\n\n';
  for (const [id, res] of S.clients) {
    try { res.write(frame); } catch { S.clients.delete(id); }
  }
}

function fbEndAll(S) {
  for (const [, res] of S.clients) {
    try { res.write('event: end\ndata: 1\n\n'); res.end(); } catch { /* ignore */ }
  }
  S.clients.clear();
}

function fbNote(S, text) {
  fbBroadcast(S, Buffer.from('\r\n\x1b[33m[stavros-console] ' + text + '\x1b[0m\r\n'));
}

function fbStartProc(S, cmd, cols, rows) {
  S.cols = fbClamp(cols, 20, 400, TERM_COLS);
  S.rows = fbClamp(rows, 6, 200, TERM_ROWS);
  const proc = spawn('python3', [FBPTY, String(S.cols), String(S.rows), '--', 'bash', '-lc', cmd], {
    cwd: S.def.cwd,
    env: Object.assign({}, process.env, { TERM: 'xterm-256color', COLORTERM: 'truecolor' }),
    stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
  });
  S.proc = proc;
  S.cmdLine = cmd;
  S.replay = [];
  S.replayBytes = 0;
  proc.stdout.on('data', (buf) => fbBroadcast(S, buf));
  proc.stderr.on('data', (buf) => fbBroadcast(S, buf)); // render stderr inline too
  proc.on('exit', (code) => {
    S.proc = null;
    fbEndAll(S);
    if (S.stopping) { S.stopping = false; return; }
    // The TUI exited on its own (crash or `exit` typed). Auto-restart with a
    // circuit breaker so a crash loop cannot spin forever.
    const now = Date.now();
    while (S.restarts.length && now - S.restarts[0] > 60000) S.restarts.shift();
    if (S.restarts.length >= 5) {
      fbNote(S, 'processo terminato (exit ' + code + ') — auto-restart sospeso (troppi restart in 60s)');
      return;
    }
    S.restarts.push(now);
    fbNote(S, 'processo terminato (exit ' + code + ') — riavvio automatico…');
    setTimeout(() => {
      if (!S.proc && !S.stopping && S.cmdLine) fbStartProc(S, S.cmdLine, S.cols, S.rows);
    }, 800);
  });
}

async function termStatus(name) {
  const S = termSessions.get(name || termDefault);
  if (!S) return { available: false, reason: 'sessione sconosciuta: ' + name };
  const okFs = fs.existsSync(FBPTY);
  return {
    available: okFs,
    reason: okFs ? null : 'fbpty.py non trovato',
    name: name || termDefault,
    label: S.def.label,
    running: !!S.proc,
    session: 'direct-pty',
    cmd: S.cmdLine,
    cwd: S.def.cwd,
    cols: S.cols,
    rows: S.rows,
    viewers: S.clients.size,
  };
}

async function termStart(name, body) {
  const S = termSessions.get(name || termDefault);
  if (!S) return { ok: false, error: 'sessione sconosciuta: ' + name };
  if (S.proc) return { ok: false, error: 'terminal already running' };
  const cols = fbClamp(body && body.cols, 20, 400, TERM_COLS);
  const rows = fbClamp(body && body.rows, 6, 200, TERM_ROWS);
  // Default command: the session's harness TUI, launched from its own root so
  // it picks up scope.json / agent definitions from the right directory.
  let cmd = String((body && body.cmd) || '').trim() || S.def.cmd;
  cmd = cmd.replace(/\s+$/, '');
  S.stopping = false;
  fbStartProc(S, cmd, cols, rows);
  return { ok: true, session: 'direct-pty', name: name || termDefault, cols: S.cols, rows: S.rows, cmd };
}

async function termStop(name) {
  const S = termSessions.get(name || termDefault);
  if (!S) return { ok: false, error: 'sessione sconosciuta: ' + name };
  if (!S.proc) return { ok: true, message: 'not running' };
  S.stopping = true;
  try { S.proc.kill('SIGTERM'); } catch { /* ignore */ }
  return { ok: true, message: 'stopped' };
}

// ── SSE viewers ──────────────────────────────────────────────────────────────
// Connect is ALWAYS allowed: if the TUI is not running the client sees an idle
// notice on screen; otherwise it first receives the full replay, then live
// frames. Input/resize act on the session PTY (the stream id is informational).
function fbStreamOpen(res, name) {
  const S = termSessions.get(name || termDefault);
  const id = 'fb' + (++fbSeq);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 2000\n\n');
  res.write('event: id\ndata: ' + id + '\n\n');
  if (!S) {
    res.write('event: end\ndata: 1\n\n');
    res.end();
    return id;
  }
  S.clients.set(id, res);
  if (S.proc) {
    for (const buf of S.replay) {
      try { res.write('data: ' + buf.toString('base64') + '\n\n'); } catch { break; }
    }
  } else {
    try { res.write('data: ' + Buffer.from(
      '\x1b[2J\x1b[H\x1b[33m[stavros-console] sessione ' + S.def.label + ' non attiva — premi ▶ Start\x1b[0m\r\n'
    ).toString('base64') + '\n\n'); } catch { /* ignore */ }
  }
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* ignore */ } }, 25000);
  res.on('close', () => { clearInterval(ping); S.clients.delete(id); });
  return id;
}

function fbInput(name, dataB64) {
  const S = termSessions.get(name || termDefault);
  if (!S) return { ok: false, error: 'sessione sconosciuta: ' + name };
  if (!S.proc) return { ok: false, error: 'not running' };
  try { S.proc.stdin.write(Buffer.from(String(dataB64 || ''), 'base64')); return { ok: true }; }
  catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
}

function fbResize(name, cols, rows) {
  const S = termSessions.get(name || termDefault);
  if (!S) return { ok: false, error: 'sessione sconosciuta: ' + name };
  const c = fbClamp(cols, 20, 400, TERM_COLS);
  const r = fbClamp(rows, 6, 200, TERM_ROWS);
  S.cols = c; S.rows = r;
  if (!S.proc) return { ok: false, error: 'not running', cols: c, rows: r };
  try { S.proc.stdio[3].write('R ' + c + ' ' + r + '\n'); return { ok: true, cols: c, rows: r }; }
  catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
}

// ── data readers ───────────────────────────────────────────────────────────
function loadScope() {
  const raw = readJsonFile(SCOPE_FILE, {});
  const hosts = Array.isArray(raw.allowed_hosts) ? raw.allowed_hosts : [];
  const prefixes = Array.isArray(raw.allowed_url_prefixes) ? raw.allowed_url_prefixes : [];
  const ips = Array.isArray(raw.allowed_ips) ? raw.allowed_ips : [];
  const rps = raw.max_requests_per_second;
  return {
    allowed_hosts: hosts, allowed_url_prefixes: prefixes, allowed_ips: ips,
    max_requests_per_second: typeof rps === 'number' ? rps : 2,
    host_ops: raw.host_ops || null, notes: raw.notes || '', _comment: raw._comment || '',
    failClosed: hosts.length === 0 && prefixes.length === 0 && ips.length === 0,
    mtime: fileMtime(SCOPE_FILE),
  };
}

function scopeCheck(url) {
  try {
    const sg = require('./scope-guard');
    return sg.inScope(url, sg.loadScope());
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
}

// ── scope validation (GUI-side rules; scope-guard stays the runtime truth) ─
function validateScopeInput(body) {
  const problems = [];
  const hosts = [];
  for (const raw of Array.isArray(body.allowed_hosts) ? body.allowed_hosts : []) {
    const h = String(raw).trim().toLowerCase();
    if (!h) continue;
    if (/\s|\/|:/.test(h) || h.includes('://')) { problems.push('invalid host: ' + h); continue; }
    hosts.push(h);
  }
  const prefixes = [];
  for (const raw of Array.isArray(body.allowed_url_prefixes) ? body.allowed_url_prefixes : []) {
    const p = String(raw).trim();
    if (!p) continue;
    if (!/^https?:\/\//.test(p) || /\s/.test(p)) { problems.push('invalid url prefix: ' + p); continue; }
    prefixes.push(p);
  }
  const ips = [];
  for (const raw of Array.isArray(body.allowed_ips) ? body.allowed_ips : []) {
    const ip = String(raw).trim();
    if (!ip) continue;
    if (ip.includes('/')) {
      const m = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(ip);
      if (!m) { problems.push('invalid CIDR: ' + ip); continue; }
      if (m[1].split('.').some((o) => parseInt(o, 10) > 255) || parseInt(m[2], 10) > 32) {
        problems.push('invalid CIDR: ' + ip); continue;
      }
    } else if (net.isIP(ip) === 0) { problems.push('invalid IP: ' + ip); continue; }
    ips.push(ip);
  }
  let rps = 2;
  if (body.max_requests_per_second != null) {
    rps = parseInt(body.max_requests_per_second, 10);
    if (!Number.isFinite(rps) || rps < 1 || rps > 600) { problems.push('max_requests_per_second must be 1..600'); rps = 2; }
  }
  return { hosts, prefixes, ips, rps, problems };
}

function saveScope(body) {
  const v = validateScopeInput(body);
  if (v.problems.length) return { ok: false, problems: v.problems };
  const cur = readJsonFile(SCOPE_FILE, {});
  const prevHosts = new Set(Array.isArray(cur.allowed_hosts) ? cur.allowed_hosts.map((h) => h.toLowerCase()) : []);
  const added = v.hosts.filter((h) => !prevHosts.has(h));
  const removed = [...prevHosts].filter((h) => !v.hosts.includes(h));
  const stamp = new Date().toISOString();
  const noteBits = [];
  if (added.length) noteBits.push('added ' + added.length + ' host(s): ' + added.join(', '));
  if (removed.length) noteBits.push('removed ' + removed.length + ' host(s): ' + removed.join(', '));
  if (noteBits.length || cur.max_requests_per_second !== v.rps) {
    if (cur.max_requests_per_second !== v.rps) noteBits.push('rps ' + (cur.max_requests_per_second || 2) + ' -> ' + v.rps);
  }
  const next = Object.assign({}, cur, {
    allowed_hosts: v.hosts,
    allowed_url_prefixes: v.prefixes,
    allowed_ips: v.ips,
    max_requests_per_second: v.rps,
  });
  if (noteBits.length) {
    const line = stamp.slice(0, 10) + ': Stavros Console update — ' + noteBits.join('; ');
    next.notes = (cur.notes ? cur.notes.trimEnd() + '\n' : '') + line;
  }
  atomicWrite(SCOPE_FILE, JSON.stringify(next, null, 2) + '\n');
  const after = loadScope();
  return { ok: true, failClosed: after.failClosed, added: added.length, removed: removed.length, mtime: after.mtime };
}

function loadOpstate() {
  const raw = readJsonFile(OPSTATE_FILE, null);
  if (!raw) return null;
  const criteria = Array.isArray(raw.criteria) ? raw.criteria : [];
  return {
    mode: raw.mode || 'pentest',
    goal: raw.goal || '',
    criteria,
    criteriaMet: criteria.filter((c) => c.status === 'met').length,
    criteriaTotal: criteria.length,
    gates: raw.gates || {},
    pending: Array.isArray(raw.pending) ? raw.pending : [],
    created_at: raw.created_at, updated_at: raw.updated_at, note: raw.note || '',
  };
}

function findingsAll() {
  return readJsonl(path.join(REPORTS, 'findings.jsonl'));
}

const SEV_ORDER = { Critical: 5, High: 4, Medium: 3, Low: 2, Info: 1 };

function enrichFindings(rows) {
  let confidenceOf;
  try { confidenceOf = require('./report-html').confidenceOf; } catch { /* fallback below */ }
  return rows.map((f) => {
    const out = Object.assign({}, f);
    try {
      if (confidenceOf) out.confidence = confidenceOf(f);
    } catch { /* ignore */ }
    out.sevRank = SEV_ORDER[f.severity] || 0;
    return out;
  });
}

function findingsPayload(q) {
  let rows = enrichFindings(findingsAll());
  const hosts = [...new Set(rows.map((f) => f.host).filter(Boolean))].sort();
  const query = (q && q.q || '').toString().toLowerCase();
  if (q) {
    if (q.host) rows = rows.filter((f) => String(f.host || '').includes(q.host));
    if (q.severity) rows = rows.filter((f) => f.severity === q.severity);
    if (q.status) rows = rows.filter((f) => (f.status || '') === q.status);
    if (query) rows = rows.filter((f) => [f.title, f.endpoint, f.host, f.cwe].join(' ').toLowerCase().includes(query));
  }
  rows.sort((a, b) => (b.sevRank - a.sevRank) || String(b.ts || '').localeCompare(String(a.ts || '')));
  const bySeverity = {};
  const byStatus = {};
  for (const f of rows) {
    bySeverity[f.severity] = (bySeverity[f.severity] || 0) + 1;
    byStatus[f.status] = (byStatus[f.status] || 0) + 1;
  }
  return { rows, hosts, bySeverity, byStatus, total: rows.length };
}

// findings-per-day for the overview sparkline. Read-only aggregation of the
// findings.jsonl timestamps into a continuous daily series (UTC) ending today,
// gaps filled with 0 so the sparkline has an even x-axis. No guard touched.
function findingsTrend(rows, days) {
  const n = days || 14;
  const byDay = {};
  for (const f of rows) {
    if (!f || !f.ts) continue;
    const d = new Date(f.ts);
    if (Number.isNaN(d.getTime())) continue;
    const key = d.toISOString().slice(0, 10);
    byDay[key] = (byDay[key] || 0) + 1;
  }
  const out = [];
  const base = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(base);
    d.setUTCDate(d.getUTCDate() - i);
    const key = d.toISOString().slice(0, 10);
    out.push({ day: key, count: byDay[key] || 0 });
  }
  return out;
}

function pipelinePayload() {
  if (!fs.existsSync(STATE_DB)) return { db: false };
  let DatabaseSync;
  try { ({ DatabaseSync } = require('node:sqlite')); } catch { return { db: false, error: 'node:sqlite unavailable (node >= 22.5 required)' }; }
  const db = new DatabaseSync(STATE_DB, { readOnly: true });
  try {
    const lastRun = db.prepare('SELECT * FROM runs ORDER BY id DESC LIMIT 1').get() || null;
    const phases = lastRun ? db.prepare('SELECT * FROM phases WHERE run_id = ? ORDER BY id').all(lastRun.id) : [];
    const runs = db.prepare('SELECT * FROM runs ORDER BY id DESC LIMIT 8').all();
    const targets = db.prepare('SELECT * FROM targets ORDER BY last_seen DESC LIMIT 60').all().map((t) => {
      const hostRows = db.prepare('SELECT id FROM hosts WHERE target_id = ?').all(t.id);
      let ports = 0;
      for (const h of hostRows) ports += db.prepare('SELECT COUNT(*) c FROM ports WHERE host_id = ?').get(h.id).c;
      const endpoints = db.prepare('SELECT COUNT(*) c FROM endpoints WHERE target_id = ?').get(t.id).c;
      return {
        host: t.host, first_seen: t.first_seen, last_seen: t.last_seen,
        hosts: hostRows.length, ports, endpoints,
      };
    });
    // A run is genuinely resumable only when there is unfinished work:
    // - a phase is still running/failed/pending, or
    // - the recorded done phases form a prefix of the pipeline order
    //   (recon → scan → enumerate). A single-phase `scan` run whose scan is
    //   done is NOT incomplete — it was a deliberate standalone command.
    //   `fuzz` is deliberate (never auto-resumed), so it never counts.
    const AUTO_PHASES = ['recon', 'scan', 'enumerate'];
    const doneNames = new Set(phases.filter((p) => p.status === 'done').map((p) => p.name));
    const hasOpenWork = phases.some((p) => p.status === 'running' || p.status === 'failed' || p.status === 'pending');
    let gap = false;
    let prefixOk = true;
    for (const name of AUTO_PHASES) {
      if (doneNames.has(name)) { if (gap) { prefixOk = false; break; } }
      else gap = true;
    }
    const resumePossible = !!(lastRun && lastRun.status !== 'done' && (hasOpenWork || prefixOk));
    // run finished its recorded phases but the process never closed it (status stuck at 'running')
    const unclosed = !!(lastRun && lastRun.status === 'running' && phases.length > 0 && !resumePossible
      && phases.every((p) => p.status === 'done' || p.status === 'failed'));
    return { db: true, lastRun, phases, runs, targets, resumePossible, unclosed };
  } finally { db.close(); }
}

// ── run management (write side: close stale runs / remove junk runs) ──────
function deleteRun(id) {
  if (!fs.existsSync(STATE_DB)) return { ok: false, error: 'no state.db yet' };
  let DatabaseSync;
  try { ({ DatabaseSync } = require('node:sqlite')); } catch { return { ok: false, error: 'node:sqlite unavailable' }; }
  const db = new DatabaseSync(STATE_DB);
  try {
    const run = db.prepare('SELECT id FROM runs WHERE id = ?').get(id);
    if (!run) return { ok: false, error: 'run not found' };
    db.prepare('DELETE FROM phases WHERE run_id = ?').run(id);
    db.prepare('DELETE FROM runs WHERE id = ?').run(id);
    return { ok: true, removed: id };
  } finally { db.close(); }
}

function closeRun(id) {
  if (!fs.existsSync(STATE_DB)) return { ok: false, error: 'no state.db yet' };
  let DatabaseSync;
  try { ({ DatabaseSync } = require('node:sqlite')); } catch { return { ok: false, error: 'node:sqlite unavailable' }; }
  const db = new DatabaseSync(STATE_DB);
  try {
    const run = db.prepare('SELECT id FROM runs WHERE id = ?').get(id);
    if (!run) return { ok: false, error: 'run not found' };
    db.prepare('UPDATE runs SET finished_at = ?, status = ? WHERE id = ?').run(new Date().toISOString(), 'done', id);
    return { ok: true, closed: id };
  } finally { db.close(); }
}

function sessionsPayload() {
  const raw = readJsonFile(SESSIONS_FILE, null);
  const map = raw && raw.sessions ? raw.sessions : {};
  const rows = Object.values(map).map((s) => ({
    id: s.id, status: s.status, host: s.host, obtained_via: s.obtained_via,
    artifacts: Array.isArray(s.artifacts) ? s.artifacts : [],
    meta: s.meta || {},
  }));
  return {
    rows,
    active: rows.filter((r) => r.status === 'active').length,
    artifactsTotal: rows.reduce((n, r) => n + r.artifacts.length, 0),
    mtime: fileMtime(SESSIONS_FILE),
  };
}

function listReports() {
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(REPORTS); } catch { return out; }
  for (const name of entries) {
    if (!/\.(html|md)$/.test(name)) continue;
    const p = path.join(REPORTS, name);
    let st;
    try { st = fs.statSync(p); } catch { continue; }
    if (!st.isFile()) continue;
    let kind = 'doc';
    if (/-report\.html$/.test(name)) kind = 'report';
    else if (/^report-.*\.html$/.test(name)) kind = 'report';
    else if (/^\d{2}-.*\.md$/.test(name)) kind = 'finding';
    else if (/^00-/.test(name)) kind = 'overview';
    out.push({ name, kind, size: st.size, mtime: st.mtime.toISOString() });
  }
  out.sort((a, b) => String(b.mtime).localeCompare(String(a.mtime)));
  return out.slice(0, 80);
}

function overviewPayload() {
  const op = loadOpstate();
  const sc = loadScope();
  const f = findingsPayload({});
  const pipe = pipelinePayload();
  const sess = sessionsPayload();
  const lootCount = (() => { try { return fs.readFileSync(LOOT_FILE, 'utf8').split('\n').filter((l) => l.trim()).length; } catch { return 0; } })();
  return {
    opstate: op,
    scope: {
      hosts: sc.allowed_hosts.length, prefixes: sc.allowed_url_prefixes.length,
      ips: sc.allowed_ips.length, rps: sc.max_requests_per_second, failClosed: sc.failClosed, mtime: sc.mtime,
    },
    findings: { total: f.total, bySeverity: f.bySeverity, byStatus: f.byStatus, trend: findingsTrend(f.rows) },
    pipeline: {
      db: pipe.db, hasRun: !!(pipe.lastRun), lastRunStatus: pipe.lastRun ? pipe.lastRun.status : null,
      runTarget: pipe.lastRun ? pipe.lastRun.target : null,
      phases: pipe.phases || [], resumePossible: pipe.resumePossible || false,
      unclosed: pipe.unclosed || false,
    },
    sessions: { active: sess.active, artifactsTotal: sess.artifactsTotal },
    lootCount,
    reportsRecent: listReports().filter((r) => r.kind === 'report').slice(0, 5),
    updatedAt: new Date().toISOString(),
  };
}

// ── router ─────────────────────────────────────────────────────────────────
function bodyJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 2 * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch (e) { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  const query = Object.fromEntries(new URL(req.url, 'http://x').searchParams);
  try {
    // static
    if (url === '/' || url === '/index.html') {
      if (!guardOk(req)) return sendText(res, 403, 'forbidden');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(fs.readFileSync(path.join(GUI_DIR, 'index.html')));
    }
    if (url === '/app.css' || url === '/app.js') {
      if (!guardOk(req)) return sendText(res, 403, 'forbidden');
      const ext = path.extname(url);
      res.writeHead(200, { 'Content-Type': CT[ext] || 'text/plain', 'Cache-Control': 'no-store' });
      return res.end(fs.readFileSync(path.join(GUI_DIR, path.basename(url))));
    }
    // WP8: progressive view split — extra zero-build assets under tools/gui served by
    // basename with an extension allowlist (no path traversal: the pattern forbids '/').
    const assetMatch = url.match(/^\/([\w.-]+)$/);
    if (assetMatch && ['.js', '.css', '.svg', '.json'].includes(path.extname(assetMatch[1]))) {
      if (!guardOk(req)) return sendText(res, 403, 'forbidden');
      const p = path.join(GUI_DIR, assetMatch[1]);
      if (assetMatch[1].includes('..') || !fs.existsSync(p)) return sendText(res, 404, 'not found');
      res.writeHead(200, { 'Content-Type': CT[path.extname(p)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      return res.end(fs.readFileSync(p));
    }
    // vendored static assets (xterm.js terminal): /vendor/<file>.{js,css}
    const vendMatch = url.match(/^\/vendor\/([\w.-]+)$/);
    if (vendMatch) {
      if (!guardOk(req)) return sendText(res, 403, 'forbidden');
      const name = vendMatch[1];
      const p = path.join(GUI_DIR, 'vendor', name);
      if (name.includes('..') || !fs.existsSync(p)) return sendText(res, 404, 'not found');
      const ext = path.extname(name);
      res.writeHead(200, { 'Content-Type': CT[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      return res.end(fs.readFileSync(p));
    }
    if (url === '/favicon.ico') { res.writeHead(204); return res.end(); }

    // serving generated report HTML for in-browser viewing (basename only)
    const repMatch = url.match(/^\/reports\/([^/]+)$/);
    if (repMatch) {
      if (!guardOk(req)) return sendText(res, 403, 'forbidden');
      const name = repMatch[1];
      if (!/\.html$/.test(name) || name.includes('..')) return sendText(res, 404, 'not found');
      const p = path.join(REPORTS, name);
      if (!fs.existsSync(p)) return sendText(res, 404, 'not found');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return fs.createReadStream(p).pipe(res);
    }

    if (!url.startsWith('/api/')) return sendText(res, 404, 'not found');
    if (!guardOk(req)) return sendText(res, 403, 'forbidden');

    // Mutations and interactive streams need the session token; data reads do not.
    const isMutation = req.method === 'POST' || req.method === 'DELETE';
    const isStream = url === '/api/term/stream' || /^\/api\/jobs\/job\d+\/events$/.test(url);
    if ((isMutation || isStream) && !tokenOk(req, query)) return denyToken(res);

    // Additive Command Center modules (WP3..WP7): same guards already applied above
    // (loopback Host/Origin + token on writes). Never bypasses a guard — writes are
    // wrappers over the existing tools.
    if (url.startsWith('/api/cc/')) {
      const handled = await ccRouter.handle(req, res, {
        url, query, sendJson, sendText, bodyJson, runJob,
        root: ROOT, reports: REPORTS, scopeFile: SCOPE_FILE, opstateFile: OPSTATE_FILE,
        token: TOKEN, readOnly: READ_ONLY,
      });
      if (handled !== false) return;
    }

    // ── GET api ─────────────────────────────────────────────────────────
    if (req.method === 'GET') {
      if (url === '/api/health') return sendJson(res, 200, { ok: true, version: 1, port: boundPort });
      if (url === '/api/instance') {
        return sendJson(res, 200, {
          instance: true, version: 1, pid: process.pid, host: HOST, port: boundPort,
          startedAt: STARTED_AT, tokenRequired: !!TOKEN,
        });
      }
      if (url === '/api/overview') return sendJson(res, 200, overviewPayload());
      if (url === '/api/findings') return sendJson(res, 200, findingsPayload(query));
      if (url === '/api/scope') return sendJson(res, 200, loadScope());
      if (url === '/api/scope/check') {
        const u = query.url || '';
        if (!u) return sendJson(res, 400, { error: 'missing ?url=' });
        return sendJson(res, 200, scopeCheck(u));
      }
      if (url === '/api/pipeline') return sendJson(res, 200, pipelinePayload());
      if (url === '/api/sessions') return sendJson(res, 200, sessionsPayload());
      if (url === '/api/loot/count') {
        return sendJson(res, 200, { count: overviewPayload().lootCount, note: 'loot.jsonl rows are never shown (secrets)' });
      }
      if (url === '/api/reports') return sendJson(res, 200, listReports());
      if (url === '/api/jobs') {
        return sendJson(res, 200, [...jobs.values()].map((j) => ({
          id: j.id, name: j.name, state: j.state, exitCode: j.exitCode,
          startedAt: j.startedAt, finishedAt: j.finishedAt, out: j.out, lines: j.lines.length,
        })).sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt))));
      }
      if (url === '/api/term/status') return sendJson(res, 200, await termStatus(query.name));
      if (url === '/api/term/stream') {
        const st = await termStatus(query.name);
        if (!st.available) return sendJson(res, 409, { error: st.reason || 'terminal unavailable' });
        fbStreamOpen(res, query.name);
        return;
      }
      const jobMatch = url.match(/^\/api\/jobs\/(job\d+)\/events$/);
      if (jobMatch) {
        const job = jobs.get(jobMatch[1]);
        if (!job) return sendJson(res, 404, { error: 'unknown job' });
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-store',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        res.write('retry: 2000\n\n');
        for (const line of job.lines) res.write('data: ' + JSON.stringify({ type: 'line', line }) + '\n\n');
        if (job.state !== 'running') {
          res.write('data: ' + JSON.stringify({ type: 'done', exitCode: job.exitCode, out: job.out }) + '\n\n');
          return res.end();
        }
        const cb = (ev) => {
          res.write('data: ' + JSON.stringify(ev) + '\n\n');
          if (ev.type === 'done') { job.listeners.delete(cb); res.end(); }
        };
        job.listeners.add(cb);
        req.on('close', () => job.listeners.delete(cb));
        return;
      }
      return sendJson(res, 404, { error: 'unknown endpoint' });
    }

    // ── POST api ────────────────────────────────────────────────────────
    if (req.method === 'POST') {
      if (url === '/api/scope') {
        const body = await bodyJson(req);
        const r = saveScope(body);
        if (!r.ok) return sendJson(res, 400, r);
        return sendJson(res, 200, r);
      }
      if (url === '/api/pipeline/resume') {
        const id = runJob('resume', [path.join('tools', 'stavros.js'), 'resume']);
        return sendJson(res, 202, { jobId: id });
      }
      const closeRunMatch = url.match(/^\/api\/pipeline\/runs\/(\d+)\/close$/);
      if (closeRunMatch) {
        const r = closeRun(Number(closeRunMatch[1]));
        return sendJson(res, r.ok ? 200 : 404, r);
      }
      if (url === '/api/reports/generate') {
        const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 14);
        const outName = 'report-' + stamp + '.html';
        const id = runJob('report-html', [path.join('tools', 'report-html.js'), '--out', path.join('reports', outName)], { out: '/reports/' + outName });
        return sendJson(res, 202, { jobId: id });
      }
      if (url === '/api/term/start') {
        const body = await bodyJson(req);
        const r = await termStart(body.name, body);
        return sendJson(res, r.ok ? 200 : 409, r);
      }
      if (url === '/api/term/stop') {
        const body = await bodyJson(req);
        const r = await termStop(body.name);
        return sendJson(res, r.ok ? 200 : 409, r);
      }
      if (url === '/api/term/input') {
        const body = await bodyJson(req);
        return sendJson(res, 200, fbInput(body.name, body.data));
      }
      if (url === '/api/term/resize') {
        const body = await bodyJson(req);
        return sendJson(res, 200, fbResize(body.name, body.cols, body.rows));
      }
      return sendJson(res, 404, { error: 'unknown endpoint' });
    }

    // ── DELETE api ──────────────────────────────────────────────────────
    if (req.method === 'DELETE') {
      const delRunMatch = url.match(/^\/api\/pipeline\/runs\/(\d+)$/);
      if (delRunMatch) {
        const r = deleteRun(Number(delRunMatch[1]));
        return sendJson(res, r.ok ? 200 : 404, r);
      }
      return sendJson(res, 404, { error: 'unknown endpoint' });
    }
    return sendText(res, 405, 'method not allowed');
  } catch (e) {
    sendJson(res, 500, { error: String((e && e.message) || e) });
  }
});

// ── lifecycle: handshake output, lock ownership, graceful release ───────────
function releaseLock() {
  if (!INSTANCE) return;
  try { ccInstance.clear({ pid: process.pid }); } catch { /* ignore */ }
}
function shutdown(code) {
  releaseLock();
  process.exit(code);
}
process.on('exit', releaseLock);
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

function onListening() {
  const addr = server.address();
  boundPort = addr && typeof addr === 'object' && addr.port ? addr.port : PORT;
  const tokenized = 'http://' + HOST + ':' + boundPort + (TOKEN ? '/?token=' + TOKEN : '/');
  if (INSTANCE) {
    ccInstance.write({
      pid: process.pid, host: HOST, port: boundPort, token: TOKEN,
      url: tokenized, startedAt: STARTED_AT,
    });
  }
  console.log('Stavros Console  →  ' + tokenized + '   (ctrl-c to stop)');
  if (PRINT_HANDSHAKE) {
    console.log('SCC_PORT=' + boundPort);
    console.log('SCC_URL=' + tokenized);
  }
}

server.on('error', (e) => {
  if (e && e.code === 'EADDRINUSE') {
    console.error('gui-server: porta ' + PORT + ' già in uso (avvia con --instance per l\'attach).');
    process.exit(3);
  }
  console.error('gui-server: ' + String((e && e.message) || e));
  process.exit(1);
});

async function start() {
  if (INSTANCE) {
    const cur = ccInstance.read();
    if (cur && ccInstance.isAlive(cur)) {
      const st = await ccInstance.probe(cur);
      if (st.ok) {
        console.log('SCC_ATTACH=' + (cur.url || ccInstance.url(cur)));
        process.exit(3);
      }
    }
    if (cur) ccInstance.clear({ force: true });   // stale or unresponsive: take over
  }
  server.listen(PORT, HOST, onListening);
}

start().catch((e) => {
  console.error('gui-server: ' + String((e && e.message) || e));
  process.exit(1);
});
