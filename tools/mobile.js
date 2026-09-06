#!/usr/bin/env node
// Mobile scope-enforcing runner (ReDroid lab). Mobile is a SEPARATE mode from the
// web/network pipeline (tools/stavros.js) and from wifi.js: targets are Android packages,
// adb serials and APK hashes — NOT IPs/BSSIDs — so run.js/scope-guard.js don't apply here.
// This is the mobile analog of wifi.js.
//
//   node tools/mobile.js check <package|serial|sha256>   scope verdict (exit 0 = in scope)
//   node tools/mobile.js status                           scope + adb devices summary
//   node tools/mobile.js static <app.apk>                 apktool + jadx (auto, offline)
//   node tools/mobile.js install <app.apk> --package <pkg>  adb install (auto, needs package+serial scope)
//   node tools/mobile.js shell <serial> <package> -- <adb args...>   read-only adb shell (auto)
//   node tools/mobile.js frida <serial> <package> [-l hook.js] [--confirm "reason"]  (confirm)
//   node tools/mobile.js intercept <serial> [--write <dir>] [--confirm "reason"]     mitmproxy dump (write=confirm)
//   node tools/mobile.js ca-install <serial> [--confirm "reason"]  push mitmproxy CA as system cert (confirm)
//   node tools/mobile.js reset [--confirm "reason"]       redroid reset (confirm, destructive)
//
// Every third-party mobile binary runs through defaultRunMobile (scope-check + tier-check +
// audit + streaming runBinary). Inject a fake runMobile/runBinary in tests. Confirm-tier
// (frida/unpin/repack/intercept_write/reset) is refused without --confirm "<reason>",
// mirroring c2-guard.js and wifi.js. Static analysis (apktool/jadx) and read-only adb
// shell/pm dumps are auto-tier. repack (apktool b + apksigner) is ALWAYS confirm.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mg = require('./mobile-guard');
const { runBinary } = require('./run');

const AUDIT_FILE = () => process.env.MOBILE_AUDIT_JSONL || path.join(__dirname, '..', 'reports', 'tmp', 'mobile-audit.jsonl');
const APPS_FILE = () => process.env.MOBILE_APPS_JSONL || path.join(__dirname, '..', 'reports', 'mobile-apps.jsonl');

// ---- target extraction (packages / serials / apk paths from argv) ----
const PKG_RE = /\b[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+\b/g;
const SERIAL_RE = /\b(?:127\.0\.0\.1|localhost):\d{1,5}\b|\bemulator-\d+\b/g;

function extractTargets(args) {
  const packages = new Set();
  const serials = new Set();
  const apks = new Set();
  for (const raw of args) {
    const a = String(raw);
    if (/\.apk$/i.test(a)) { apks.add(a); continue; } // filename, not a package
    for (const m of a.match(SERIAL_RE) || []) serials.add(m);
    for (const m of a.match(PKG_RE) || []) {
      if (mg.isPackage(m)) packages.add(m);
    }
  }
  return { packages: [...packages], serials: [...serials], apks: [...apks] };
}

// ---- action classification (bin + args + subcommand -> action class) ----
const RULES = [
  [/\bfrida\b|\bobjection\b/i, 'frida'],
  [/apktool\s+b\b|\bapksigner\b|\bzipalign\b/i, 'repack'],
  [/\bmitmdump\b|\bmitmproxy\b/i, 'intercept_write'], // downgraded to intercept_read when read-only flags detected
  [/\badb\b.*\b(shell|exec-out)\b/i, 'shell_read'],
  [/\badb\b.*\binstall\b/i, 'install'],
  [/\bapktool\b|\bjadx\b|\baapt2?\b/i, 'static'],
];

function classifyRaw(bin, args, sub) {
  if (sub === 'frida') return 'frida';
  if (sub === 'ca-install') return 'unpin';
  if (sub === 'reset') return 'reset';
  if (sub === 'static') return 'static';
  if (sub === 'install') return 'install';
  if (sub === 'shell') return /push\b|install\b|reboot\b|remount\b/i.test(args.join(' ')) ? 'shell_write' : 'shell_read';
  if (sub === 'intercept') {
    const t = args.join(' ');
    if (/-w\b|--save|--set\s+save/i.test(t)) return 'intercept_write';
    return 'intercept_read';
  }
  const text = [bin].concat(args).join(' ');
  for (const [re, cls] of RULES) if (re.test(text)) return cls;
  return null;
}

function loadTiers(scope) {
  const mo = (scope && scope.mobile_ops) || {};
  return {
    auto: new Set(mo.auto || ['status', 'static', 'install', 'shell_read', 'intercept_read']),
    confirm: new Set(mo.confirm || ['frida', 'unpin', 'repack', 'intercept_write', 'reset']),
  };
}

function classify(bin, args, scope, sub) {
  const tiers = loadTiers(scope);
  const cls = classifyRaw(bin, args, sub);
  if (cls && tiers.auto.has(cls)) return { actionClass: cls, tier: 'auto' };
  return { actionClass: cls || 'unknown', tier: 'confirm' }; // unknown -> confirm (fail closed)
}

// ---- audit trail (same convention as wifi.js / run.js) ----
function auditMobile(entry) {
  try {
    const p = AUDIT_FILE();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, JSON.stringify(entry) + '\n');
  } catch {}
}

// ---- pure command builders (no exec; tested offline) ----
const DEFAULT_SERIAL = '127.0.0.1:5555';

function staticCommands(apk, opts) {
  opts = opts || {};
  const out = opts.out || path.join('reports', 'mobile', path.basename(String(apk)).replace(/\.apk$/i, ''));
  return [
    { bin: 'apktool', args: ['d', apk, '-o', out + '-apktool', '-f'] },
    { bin: 'jadx', args: ['-d', out + '-jadx', apk] },
  ];
}

function installCommands(apk, opts) {
  opts = opts || {};
  const serial = opts.serial || DEFAULT_SERIAL;
  return [{ bin: 'adb', args: ['-s', serial, 'install', '-r', apk] }];
}

function shellCommands(serial, args) {
  return [{ bin: 'adb', args: ['-s', serial || DEFAULT_SERIAL, 'shell'].concat(args) }];
}

function fridaCommands(pkg, opts) {
  opts = opts || {};
  const serial = opts.serial || DEFAULT_SERIAL;
  const a = ['-U', '-n', pkg];
  if (opts.script) a.push('-l', opts.script);
  else a.push('-l', 'vendor/tools/frida/unpin.js');
  if (opts.extra) a.push(...opts.extra);
  return [{ bin: 'frida', args: a.concat(['--device', serial]) }];
}

function interceptCommands(serial, opts) {
  opts = opts || {};
  const out = opts.write || path.join('reports', 'mobile', 'intercept');
  if (opts.write) return [{ bin: 'mitmdump', args: ['-w', path.join(out, 'flow.mitm')] }];
  return [{ bin: 'mitmdump', args: ['-nr', path.join(out, 'flow.mitm')] }];
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

// ---- defaultRunMobile: injectable, default = scope-check + tier-check + audit + runBinary ----
async function defaultRunMobile(bin, args, opts) {
  opts = opts || {};
  let scope;
  try {
    scope = mg.loadMobileScope();
  } catch {
    const e = new Error('mobile-scope.json missing - nothing is authorized yet');
    e.blocked = true;
    throw e;
  }
  if (mg.scopeEmpty(scope)) {
    const e = new Error('mobile-scope.json empty - nothing is authorized yet');
    e.blocked = true;
    throw e;
  }
  const sub = opts.sub || null;
  const { packages, serials, apks } = extractTargets([bin].concat(args));
  // callers may pass explicit package/serial/apk (CLI does); merge them in.
  if (opts.package) packages.push(opts.package);
  if (opts.serial) serials.push(opts.serial);
  const { tier, actionClass } = classify(bin, args, scope, sub);
  const confirm = opts.confirm && String(opts.confirm).trim();
  const entry = { ts: new Date().toISOString(), bin, args, sub, actionClass, tier, confirm: Boolean(confirm) };

  if (tier === 'confirm' && !confirm) {
    const e = new Error(`action '${actionClass}' is confirm-tier: pass --confirm "<reason>" (requires explicit in-session user approval)`);
    e.blocked = true; e.tier = tier; e.actionClass = actionClass;
    auditMobile(Object.assign(entry, { verdict: 'blocked', reason: 'confirm-tier without --confirm' }));
    throw e;
  }
  // Scope checks: every referenced package/serial must be allowed; APK hash checked
  // only when an allowlist is configured AND the file exists (offline unit tests pass apkSha).
  for (const p of new Set(packages)) {
    const r = mg.packageInScope(p, scope);
    if (!r.ok) {
      const e = new Error(`out-of-scope mobile target: ${r.reason}`);
      e.blocked = true;
      auditMobile(Object.assign(entry, { verdict: 'blocked', reason: r.reason }));
      throw e;
    }
  }
  for (const s of new Set(serials)) {
    const r = mg.serialInScope(s, scope);
    if (!r.ok) {
      const e = new Error(`out-of-scope mobile target: ${r.reason}`);
      e.blocked = true;
      auditMobile(Object.assign(entry, { verdict: 'blocked', reason: r.reason }));
      throw e;
    }
  }
  const apkAllow = (scope.allowed_apk_sha256 || []).length > 0;
  if (apkAllow) {
    for (const a of apks) {
      let sha = opts.apkSha;
      if (!sha) {
        try { sha = sha256File(a); } catch { sha = null; }
      }
      if (!sha) {
        const e = new Error(`cannot hash APK ${a}: file missing, pass opts.apkSha in tests`);
        e.blocked = true;
        auditMobile(Object.assign(entry, { verdict: 'blocked', reason: 'apk unreadable' }));
        throw e;
      }
      const r = mg.apkInScope(sha, scope);
      if (!r.ok) {
        const e = new Error(`out-of-scope mobile target: ${r.reason}`);
        e.blocked = true;
        auditMobile(Object.assign(entry, { verdict: 'blocked', reason: r.reason }));
        throw e;
      }
    }
  }
  // Static/offline tools carry no live target but are still gated on scope file presence
  // (fail-closed above); confirm-tier with --confirm but no target fails closed too.
  if (tier === 'confirm' && packages.length === 0 && serials.length === 0 && apks.length === 0
      && !['reset'].includes(actionClass)) {
    const e = new Error('no in-scope mobile target found in command');
    e.blocked = true;
    auditMobile(Object.assign(entry, { verdict: 'blocked', reason: 'no target' }));
    throw e;
  }
  const runBinaryFn = opts.runBinary || runBinary;
  const r = await runBinaryFn(bin, args, opts);
  auditMobile(Object.assign(entry, { verdict: 'ran', status: r && r.status }));
  return r;
}

// ---- subcommands ----
async function statusCmd(opts) {
  opts = opts || {};
  const runMobile = opts.runMobile || defaultRunMobile;
  let devices = [];
  try {
    const r = await runMobile('adb', ['devices', '-l'], Object.assign({ sub: 'status' }, opts));
    devices = String((r && r.stdout) || '').split('\n').slice(1).map((l) => l.trim()).filter(Boolean);
  } catch (e) {
    if (!e.blocked) throw e;
    return { scope: 'blocked', reason: e.message };
  }
  let scope;
  try { scope = mg.loadMobileScope(); } catch { return { devices, scope: 'missing' }; }
  return { devices, packages: scope.allowed_packages || [], serials: scope.allowed_serials || [] };
}

async function staticApk(apk, opts) {
  opts = opts || {};
  const runMobile = opts.runMobile || defaultRunMobile;
  const results = [];
  for (const c of staticCommands(apk, opts)) {
    const r = await runMobile(c.bin, c.args, Object.assign({ sub: 'static' }, opts));
    results.push({ cmd: c.bin, status: r && r.status });
  }
  return { apk, results };
}

async function installApk(apk, opts) {
  opts = opts || {};
  const runMobile = opts.runMobile || defaultRunMobile;
  const c = installCommands(apk, opts)[0];
  const r = await runMobile(c.bin, c.args, Object.assign({ sub: 'install' }, opts));
  return { apk, status: r && r.status };
}

async function shell(serial, shellArgs, opts) {
  opts = opts || {};
  const runMobile = opts.runMobile || defaultRunMobile;
  const c = shellCommands(serial, shellArgs)[0];
  const r = await runMobile(c.bin, c.args, Object.assign({ sub: 'shell', serial }, opts));
  return { serial, status: r && r.status, stdout: r && r.stdout };
}

// ---- CLI ----
function usage() {
  console.error(
    'usage: node tools/mobile.js check <target> | status | static <apk> | install <apk> --package <pkg> [--serial S] | shell <serial> <pkg> -- <args...> | frida <serial> <pkg> [-l hook.js] [--confirm "r"] | intercept <serial> [--write dir] [--confirm "r"] | ca-install <serial> [--confirm "r"] | reset [--confirm "r"]'
  );
  process.exit(2);
}

function parseArgs(rest) {
  const opts = {};
  const pos = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--serial') opts.serial = rest[++i];
    else if (a === '--package') opts.package = rest[++i];
    else if (a === '--write') opts.write = rest[++i];
    else if (a === '--out') opts.out = rest[++i];
    else if (a === '-l' || a === '--script') opts.script = rest[++i];
    else if (a === '--confirm') opts.confirm = rest[++i];
    else if (a === '--') opts.shellArgs = rest.slice(i + 1), i = rest.length;
    else pos.push(a);
  }
  return { opts, pos };
}

async function main() {
  const argv = process.argv.slice(2);
  const [cmd, ...rest] = argv;
  if (!cmd) usage();
  if (cmd === 'check') {
    let scope;
    try { scope = mg.loadMobileScope(); } catch {
      console.log(JSON.stringify({ ok: false, reason: 'mobile-scope.json missing - nothing is authorized yet' }));
      process.exit(1);
    }
    if (mg.scopeEmpty(scope)) {
      console.log(JSON.stringify({ ok: false, reason: 'mobile-scope.json empty - nothing is authorized yet' }));
      process.exit(1);
    }
    const res = mg.inMobileScope(rest[0], scope);
    console.log(JSON.stringify(res));
    process.exit(res.ok ? 0 : 1);
  }
  if (cmd === 'status') {
    console.log(JSON.stringify(await statusCmd(parseArgs(rest).opts), null, 2));
    process.exit(0);
  }
  const { opts, pos } = parseArgs(rest);
  try {
    let out;
    switch (cmd) {
      case 'static':
        if (!pos[0]) usage();
        out = await staticApk(pos[0], opts);
        break;
      case 'install':
        if (!pos[0]) usage();
        out = await installApk(pos[0], opts);
        break;
      case 'shell':
        if (!pos[0]) usage();
        out = await shell(pos[0], opts.shellArgs || pos.slice(2), Object.assign({ package: pos[1] }, opts));
        break;
      case 'frida': {
        if (!pos[1]) usage();
        const c = fridaCommands(pos[1], { serial: pos[0], script: opts.script })[0];
        const { runBinary: rb, ...o } = opts;
        const r = await defaultRunMobile(c.bin, c.args, Object.assign({ sub: 'frida', package: pos[1], serial: pos[0] }, o));
        out = { package: pos[1], status: r && r.status };
        break;
      }
      case 'intercept': {
        if (!pos[0]) usage();
        const c = interceptCommands(pos[0], opts)[0];
        const sub = opts.write ? 'intercept_write_via_cli' : 'intercept';
        const r = await defaultRunMobile(c.bin, c.args, Object.assign({ sub: opts.write ? 'intercept' : 'intercept', serial: pos[0] }, opts, { _cli: sub }));
        out = { serial: pos[0], status: r && r.status };
        break;
      }
      case 'ca-install': {
        if (!pos[0]) usage();
        const r = await defaultRunMobile('adb', ['-s', pos[0], 'shell', 'su', '0', 'ls', '/system/etc/security/cacerts'], Object.assign({ sub: 'ca-install', serial: pos[0] }, opts));
        out = { serial: pos[0], status: r && r.status, note: 'push mitmproxy CA via adb root, then ca-install completes (confirm-tier)' };
        break;
      }
      case 'reset': {
        const r = await defaultRunMobile('redroid', ['reset'], Object.assign({ sub: 'reset' }, opts));
        out = { status: r && r.status };
        break;
      }
      default:
        usage();
    }
    console.log(JSON.stringify(out, null, 2));
  } catch (e) {
    console.error(JSON.stringify({ error: e.message, blocked: e.blocked || undefined, tier: e.tier, action: e.actionClass }));
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = {
  staticCommands, installCommands, shellCommands, fridaCommands, interceptCommands,
  extractTargets, classify, classifyRaw, loadTiers, statusCmd, staticApk, installApk, shell,
  defaultRunMobile,
};
