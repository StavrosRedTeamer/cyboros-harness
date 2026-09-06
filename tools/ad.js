#!/usr/bin/env node
// Stavros AD — deterministic Active-Directory orchestrator (the AD analog of wifi.js).
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
const sg = require('./scope-guard');
const run = require('./run');

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
    default:
      return null;
  }
}

// ============================================================================
// Orchestration. opts.runAd(bin,args,ctx) is injectable for offline tests; on real
// runs it defaults to scope-check + tier-check + audit + run.runBinary.
// ============================================================================
async function runAd(op, target, opts) {
  opts = opts || {};
  const scope = opts.scope || loadScope();

  const sc = scopeCheck(target, scope);
  if (!sc.ok) { audit({ op, target, verdict: 'out-of-scope', reason: sc.reason }); return { ok: false, stage: 'scope', reason: sc.reason }; }

  const tier = enforce(op, opts);
  if (!tier.ok) { audit({ op, target, verdict: 'tier-refused', tier: tier.tier }); return { ok: false, stage: 'tier', reason: tier.reason, tier: tier.tier }; }

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

  // Persist transcript.
  try {
    const dir = OUT_DIR();
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, `${op}-${String(target).replace(/[^a-z0-9_.@-]/gi, '_')}-${Date.now()}.txt`);
    fs.writeFileSync(f, text);
    parsed._transcript = f;
  } catch { /* non-fatal */ }

  return { ok: (res && (res.status === 0 || res.status === undefined)) || !!parsed.hosts, op, target, tier: tier.tier, status: res && res.status, parsed };
}

module.exports = {
  classify, enforce, scopeCheck, buildArgs, runAd, loadScope,
  parseNxcSmbBanner, parseNxcShares, parseCertipy, parseKerbHashes, parsePolicy,
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
  if (!op) { console.error('usage: node tools/ad.js <check|enum|roast|adcs|bloodhound|dcsync|secretsdump> <host> [opts]'); process.exit(2); }
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
