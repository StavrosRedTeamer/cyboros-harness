#!/usr/bin/env node
// WP4 — Inbox approvazioni: il consenso dell'operatore diventa un TOKEN verificabile.
//
// Perché: oggi un'azione confirm-tier si sblocca con una battuta in chat. Qui la richiesta
// dell'agente diventa un record append-only, la decisione dell'operatore un'altra riga, e un
// token consumabile una volta sola — così "chi ha autorizzato cosa" è verificabile e non
// dipende dalla memoria della sessione.
//
// Guardrail rispettati:
//   - L'app NON esegue mai l'azione: minta/nega il token. L'agente la esegue con `--approval`.
//   - Fail-closed: se scope-guard non carica, il verdetto è `blocked` — mai `allowed`.
//   - Append-only: ogni richiesta/decisione/consumo è una riga; nulla viene riscritto.
//
// Store: CC_APPROVALS_FILE (default reports/approvals.jsonl)          [gitignored]
// Coda:  operation-state.json via CAS di opstate.js (st.cc_pending_approvals)
//
// Token (vista derivata, mai un segreto):
//   { id, host, action_class, command_hash, scope_verdict, ttl_sec, granted_by, note,
//     requested_by, reason, created_at, expires_at, status }
//
// CLI:
//   node tools/cc-approvals.js list [--json] [--all]
//   node tools/cc-approvals.js request --host <h> --action <class> --command <cmd> [--reason s] [--by a] [--ttl sec]
//   node tools/cc-approvals.js grant <id> [--by a] [--note s]
//   node tools/cc-approvals.js deny  <id> [--by a] [--note s]
//   node tools/cc-approvals.js revoke <id> [--by a]
//   node tools/cc-approvals.js consume <id> --host <h> --action <class> --command <cmd> [--by a]
//   node tools/cc-approvals.js verify <id> --host <h> --action <class> --command <cmd>
//   node tools/cc-approvals.js expire
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const u = require('./cc-util');

const DEFAULT_TTL_SEC = 900;          // 15 min: enough to act, short enough to matter
const MAX_TTL_SEC = 24 * 3600;

const root = () => process.env.CC_ROOT || u.ROOT;
const storeFile = () => process.env.CC_APPROVALS_FILE || path.join(root(), 'reports', 'approvals.jsonl');
const opstateFile = () => process.env.CC_OPSTATE_FILE || process.env.OPSTATE_FILE || path.join(root(), 'operation-state.json');

function nowIso() { return u.nowIso(); }
function newId() { return 'ap-' + crypto.randomBytes(6).toString('hex'); }
function commandHash(cmd) { return u.sha256(String(cmd || '').trim().replace(/\s+/g, ' ')); }

// Scope verdict computed with the SAME runtime truth the guards use. Fail-closed:
// an unloadable/empty scope yields `blocked`.
function scopeVerdict(host) {
  try {
    const sg = require('./scope-guard');
    const scope = sg.loadScope();
    const res = sg.inScope(String(host), scope);
    if (res && res.ok) return { verdict: 'allowed', detail: res.reason || res.detail || 'in scope' };
    return { verdict: 'blocked', detail: (res && (res.reason || res.detail)) || 'out of scope' };
  } catch (e) {
    return { verdict: 'blocked', detail: 'scope-guard unavailable: ' + String((e && e.message) || e) };
  }
}

function readRecords() { return u.readJsonl(storeFile()); }

// Fold the append-only log into token views. Deterministic order = file order.
function fold() {
  const tokens = new Map();
  for (const r of readRecords()) {
    if (r.type === 'request') {
      tokens.set(r.id, {
        id: r.id, host: r.host, action_class: r.action_class, command_hash: r.command_hash,
        scope_verdict: r.scope_verdict, ttl_sec: r.ttl_sec, requested_by: r.requested_by,
        reason: r.reason || '', created_at: r.ts,
        expires_at: new Date(Date.parse(r.ts) + (r.ttl_sec || DEFAULT_TTL_SEC) * 1000).toISOString(),
        status: 'pending', granted_by: null, note: r.note || '', consumed_at: null,
        decision_ts: null, scope_detail: r.scope_detail || '',
      });
    } else if (r.type === 'grant' && tokens.has(r.id)) {
      const t = tokens.get(r.id); t.status = 'granted'; t.granted_by = r.actor || 'operator';
      t.note = r.note != null ? r.note : t.note; t.decision_ts = r.ts;
    } else if (r.type === 'deny' && tokens.has(r.id)) {
      const t = tokens.get(r.id); t.status = 'denied'; t.granted_by = r.actor || 'operator';
      t.note = r.note != null ? r.note : t.note; t.decision_ts = r.ts;
    } else if (r.type === 'revoke' && tokens.has(r.id)) {
      const t = tokens.get(r.id); t.status = 'revoked'; t.revoked_by = r.actor || 'operator';
      t.note = r.note != null ? r.note : t.note; t.decision_ts = r.ts;
    } else if (r.type === 'consume' && tokens.has(r.id)) {
      const t = tokens.get(r.id); t.status = 'consumed'; t.consumed_at = r.ts; t.consumed_by = r.actor || 'agent';
    }
  }
  return tokens;
}

function isExpired(t, at) {
  const now = at ? Date.parse(at) : Date.now();
  return Date.parse(t.expires_at) <= now;
}

// Effective status folds in expiry lazily (no scheduled writer needed).
function effective(t, at) {
  if (t.status === 'granted' && isExpired(t, at)) return Object.assign({}, t, { status: 'expired' });
  return t;
}

// Validate a token against a concrete action. This is the function run.js/c2-guard.js
// call on the `--approval <id>` path. Every mismatch is fail-closed.
function verify(id, req) {
  const r = req || {};
  const tokens = fold();
  const t = tokens.get(id);
  if (!t) return { ok: false, verdict: 'blocked', reason: 'unknown approval id' };
  const eff = effective(t);
  if (eff.status !== 'granted') return { ok: false, verdict: 'blocked', reason: 'token not granted (status: ' + eff.status + ')', token: eff };
  if (eff.scope_verdict !== 'allowed') return { ok: false, verdict: 'blocked', reason: 'scope verdict was ' + eff.scope_verdict, token: eff };
  if (r.host && String(r.host) !== String(eff.host)) return { ok: false, verdict: 'blocked', reason: 'host mismatch (token for ' + eff.host + ')', token: eff };
  if (r.actionClass && String(r.actionClass) !== String(eff.action_class)) return { ok: false, verdict: 'blocked', reason: 'action_class mismatch (token for ' + eff.action_class + ')', token: eff };
  if (r.commandHash && String(r.commandHash) !== String(eff.command_hash)) return { ok: false, verdict: 'blocked', reason: 'command hash mismatch', token: eff };
  if (r.command && commandHash(r.command) !== eff.command_hash) return { ok: false, verdict: 'blocked', reason: 'command hash mismatch', token: eff };
  return { ok: true, verdict: 'allowed', token: eff };
}

// ── policy gate (additive, DEFAULT OFF) ─────────────────────────────────────
// `scope.json.host_ops.require_approval` may be `true` (every confirm-tier action)
// or `{ bins:[...], classes:[...] }` to scope the requirement. Absent/false → the
// gate is inert and behaviour is byte-identical to before this module existed.
function policy(scope) {
  const ho = (scope && scope.host_ops) || {};
  const r = ho.require_approval;
  if (r === true) return { enabled: true, bins: [], classes: [] };
  if (r && typeof r === 'object' && !Array.isArray(r)) return { enabled: true, bins: r.bins || [], classes: r.classes || [] };
  if (Array.isArray(r)) return { enabled: true, bins: r, classes: [] };
  return { enabled: false, bins: [], classes: [] };
}

// Returns { required, ok, reason, token }. When the policy is off it is always
// { required:false, ok:true } — the call site then does nothing different.
function requireToken(scope, req) {
  const p = policy(scope);
  if (!p.enabled) return { required: false, ok: true, policy: 'off' };
  const r = req || {};
  if (r.actionClass && p.classes.length && !p.classes.includes(r.actionClass)) return { required: false, ok: true, policy: 'class-not-covered' };
  if (!r.id) {
    return { required: true, ok: false, reason: 'approval required (scope.host_ops.require_approval): request a token with tools/request-approval.js, then pass --approval <id>' };
  }
  const v = verify(r.id, { host: r.host, actionClass: r.actionClass, command: r.command });
  return { required: true, ok: v.ok, reason: v.ok ? null : v.reason, token: v.token };
}

// ── opstate queue (best-effort; the JSONL store is the source of truth) ──────
const QUEUE_KEY = 'cc_pending_approvals';
function queueAdd(entry) {
  try {
    const opstate = require('./opstate');
    const file = opstateFile();
    const res = opstate.casUpdate(file, undefined, (st) => {
      if (!Array.isArray(st[QUEUE_KEY])) st[QUEUE_KEY] = [];
      st[QUEUE_KEY] = st[QUEUE_KEY].filter((x) => x.id !== entry.id).concat([entry]);
    }, { owner: 'cc-approvals', action: 'approval-request', detail: { id: entry.id } });
    return res.ok;
  } catch { return false; }
}
function queueRemove(id, action) {
  try {
    const opstate = require('./opstate');
    const file = opstateFile();
    const res = opstate.casUpdate(file, undefined, (st) => {
      if (!Array.isArray(st[QUEUE_KEY])) st[QUEUE_KEY] = [];
      st[QUEUE_KEY] = st[QUEUE_KEY].filter((x) => x.id !== id);
    }, { owner: 'cc-approvals', action, detail: { id } });
    return res.ok;
  } catch { return false; }
}

// ── writer API ──────────────────────────────────────────────────────────────
function append(rec) { u.appendJsonl(storeFile(), rec); return rec; }

function request(req, opts) {
  const o = opts || {};
  const actionClass = String(o.actionClass || req.actionClass || 'confirm').slice(0, 40);
  const host = String(o.host || req.host || '').slice(0, 200);
  const command = o.command || req.command || '';
  const ttl = Math.min(MAX_TTL_SEC, Math.max(30, parseInt(o.ttl || req.ttl || DEFAULT_TTL_SEC, 10) || DEFAULT_TTL_SEC));
  const sv = scopeVerdict(host);
  const rec = {
    type: 'request', id: newId(), ts: nowIso(),
    host, action_class: actionClass, command_hash: commandHash(command),
    scope_verdict: sv.verdict, scope_detail: sv.detail, ttl_sec: ttl,
    requested_by: String(o.by || req.by || 'agent').slice(0, 80),
    reason: String(o.reason || req.reason || '').slice(0, 500),
  };
  append(rec);
  queueAdd({ id: rec.id, host, action_class: actionClass, created_at: rec.ts, scope_verdict: sv.verdict });
  return { ok: true, id: rec.id, status: 'pending', scope_verdict: sv.verdict, scope_detail: sv.detail, expires_at: new Date(Date.parse(rec.ts) + ttl * 1000).toISOString() };
}

function decide(id, type, actor, note) {
  const t = fold().get(id);
  if (!t) return { ok: false, error: 'unknown approval id' };
  if (t.status === 'consumed') return { ok: false, error: 'already consumed' };
  append({ type, id, ts: nowIso(), actor: actor || 'operator', note: note || '' });
  queueRemove(id, 'approval-' + type);
  return { ok: true, id, status: type === 'grant' ? 'granted' : type === 'deny' ? 'denied' : 'revoked' };
}

function grant(id, opts) { return decide(id, 'grant', (opts || {}).actor, (opts || {}).note); }
function deny(id, opts) { return decide(id, 'deny', (opts || {}).actor, (opts || {}).note); }
function revoke(id, opts) { return decide(id, 'revoke', (opts || {}).actor, (opts || {}).note); }

// ── single-use cross-process (Ondata 7) ─────────────────────────────────────
// `consume` è read-then-write: due processi che consumano lo STESSO token nello stesso istante
// vedevano entrambi `granted` e appendevano entrambi la riga `consume` — cioè un token
// dichiarato "single-use" non era atomico, e il THREAT-MODEL §5 lo nomina come la superficie da
// attaccare ("the race between grant and use"). La sezione critica è ora protetta da un lock
// file: `wx` (create esclusivo) è atomico sul filesystem, quindi un solo processo entra. Un lock
// stantio (processo morto a metà) viene rotto dopo LOCK_STALE_MS; se il lock non si acquisisce
// entro LOCK_TIMEOUT_MS la risposta è `blocked` — fail-closed: un lock non acquisibile NON
// autorizza.
const LOCK_TIMEOUT_MS = 3000;
const LOCK_STALE_MS = 30000;
function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
  catch { const end = Date.now() + ms; while (Date.now() < end) { /* spin di riserva */ } }
}
function withStoreLock(file, fn) {
  const lock = file + '.lock';
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      const fd = fs.openSync(lock, 'wx');
      try { fs.writeSync(fd, process.pid + ' ' + nowIso() + '\n'); } finally { fs.closeSync(fd); }
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) { fs.unlinkSync(lock); continue; }
      } catch { continue; }
      if (Date.now() > deadline) throw new Error('approval store busy (lock held > ' + LOCK_TIMEOUT_MS + 'ms)');
      sleepSync(15);
    }
  }
  try { return fn(); } finally { try { fs.unlinkSync(lock); } catch { /* già rilasciato */ } }
}

// Consume = verify + mark used, ATOMICALLY. A token is single-use by design, so the verify must
// happen inside the lock: the second process re-reads the store and sees `consumed`.
function consume(id, req) {
  const file = storeFile();
  let out;
  try {
    out = withStoreLock(file, () => {
      const v = verify(id, req);
      if (!v.ok) return v;
      append({ type: 'consume', id, ts: nowIso(), actor: (req && req.actor) || 'agent',
        host: (req && req.host) || v.token.host, action_class: (req && req.actionClass) || v.token.action_class });
      queueRemove(id, 'approval-consume');
      return { ok: true, verdict: 'allowed', token: v.token };
    });
  } catch (e) {
    return { ok: false, verdict: 'blocked', reason: 'approval store lock unavailable: ' + (e && e.message ? e.message : String(e)) };
  }
  return out;
}

function list(opts) {
  const o = opts || {};
  const all = [...fold().values()].map((t) => effective(t));
  const rows = o.all ? all : all.filter((t) => t.status === 'pending' || t.status === 'granted');
  return rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}

// Lazily claim expired grants into explicit rows so the UI reflects reality.
function expire(at) {
  const out = [];
  for (const t of fold().values()) {
    if (t.status === 'granted' && isExpired(t, at)) {
      append({ type: 'expire', id: t.id, ts: nowIso(), actor: 'system' });
      out.push(t.id);
    }
  }
  return { ok: true, expired: out };
}

// ── CLI ─────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') o.json = true;
    else if (a === '--all') o.all = true;
    else if (a === '--host') o.host = argv[++i];
    else if (a === '--action') o.actionClass = argv[++i];
    else if (a === '--command') o.command = argv[++i];
    else if (a === '--reason') o.reason = argv[++i];
    else if (a === '--by') o.by = argv[++i];
    else if (a === '--note') o.note = argv[++i];
    else if (a === '--ttl') o.ttl = argv[++i];
    else o._.push(a);
  }
  return o;
}

function main(argv) {
  const cli = parseArgs(argv);
  const cmd = cli._[0] || 'list';
  const j = (o) => { console.log(JSON.stringify(o, null, 2)); };
  if (cmd === 'list') { j({ rows: list({ all: cli.all }) }); return 0; }
  if (cmd === 'request') {
    const r = request({ host: cli.host, actionClass: cli.actionClass, command: cli.command, reason: cli.reason, by: cli.by, ttl: cli.ttl });
    j(r); return 0;
  }
  if (cmd === 'grant' || cmd === 'deny' || cmd === 'revoke') {
    const r = { grant, deny, revoke }[cmd](cli._[1], { actor: cli.by, note: cli.note });
    j(r); return r.ok ? 0 : 1;
  }
  if (cmd === 'consume') {
    const r = consume(cli._[1], { host: cli.host, actionClass: cli.actionClass, command: cli.command, actor: cli.by });
    j(r); return r.ok ? 0 : 1;
  }
  if (cmd === 'verify') {
    const r = verify(cli._[1], { host: cli.host, actionClass: cli.actionClass, command: cli.command });
    j(r); return r.ok ? 0 : 1;
  }
  if (cmd === 'expire') { j(expire()); return 0; }
  console.error('usage: node tools/cc-approvals.js list|request|grant|deny|revoke|consume|verify|expire [...]');
  return 2;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = {
  storeFile, opstateFile, commandHash, scopeVerdict, fold, effective, verify, policy, requireToken,
  request, grant, deny, revoke, consume, list, expire, DEFAULT_TTL_SEC, MAX_TTL_SEC,
};
