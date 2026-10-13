#!/usr/bin/env node
// Mobile scope-enforcing runner (ReDroid lab). Mobile is a SEPARATE mode from the
// web/network pipeline (tools/stavros.js) and from wifi.js: targets are Android packages,
// adb serials and APK hashes — NOT IPs/BSSIDs — so run.js/scope-guard.js don't apply here.
// This is the mobile analog of wifi.js.
//
//   node tools/mobile.js check <package|serial|sha256>   scope verdict (exit 0 = in scope)
//   node tools/mobile.js status                           scope + adb devices summary
//   node tools/mobile.js static <app.apk>                 apktool + jadx (auto, offline)
//   node tools/mobile.js fetch-apk <pkg> [--out f] | fetch-apk <pkg> --verify-only <file>
//                                                         M.2: download from an apk_sources URL
//                                                         (mobile-scope.json) + sha256 pinned; --verify-only
//                                                         hashes a provided file instead (auto, fail-closed)
//   node tools/mobile.js surface <pkg> [--reports-dir d]     M.4: exported/deeplinks from the static
//                                                         manifest -> reports/<pkg>-map.json + mobile
//                                                         coverage row (auto, offline)
//   node tools/mobile.js firebase-audit <pkg> [--record] [--reports-dir d]
//                                                         M.3: extract config from the static pass,
//                                                         ONE read-only existence probe per asset (auto)
//   node tools/mobile.js install <app.apk> --package <pkg>  adb install (auto, needs package+serial scope)
//   node tools/mobile.js shell <serial> <package> -- <adb args...>   read-only adb shell (auto)
//   node tools/mobile.js frida <serial> <package> [-l hook.js] [--framework flutter|pairip] [--confirm "reason"]  (confirm)
//     M.1: without -l, the hook is chosen from the static pass (flutter → disable-flutter-tls.js,
//     PairIP → hint to repack, else unpin.js). STAVROS_FRIDA_SCRIPT still overrides.
//   node tools/mobile.js frida-server up|down|status [serial] [--port N] [--confirm "reason"]  (confirm)
//     P1: gestisce frida-server SUL DEVICE (root, /data/local/tmp), versione allineata a `frida --version`
//     locale. up scarica il binario dal device (via Tor: GlobalProxyApplication già instrada le app;
//     il binario va scaricato UNA volta, es. con il downloader del telefono) e lo avvia su
//     127.0.0.1:STAVROS_FRIDA_PORT (default 4747, porta NON standard), poi adb forward tcp:4747.
//     down = pkill (la superficie resta chiusa quando non serve). status = pid + forward.
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
  if (sub === 'frida-server') return 'frida'; // P1: stessa classe confirm di un attach frida
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
// Default adb target. ReDroid loopback historically; override with STAVROS_ADB_SERIAL to
// point at a physically-attached authorized device (e.g. Poco F3 USB serial "R5CT30XXXXX").
// The serial is still scope-checked by mobile-guard.js regardless of this default.
const DEFAULT_SERIAL = process.env.STAVROS_ADB_SERIAL || '127.0.0.1:5555';

function staticCommands(apk, opts) {
  opts = opts || {};
  // Nome dir per <pkg> quando il package e' noto: i post-pass (frameworkResult/firebaseAudit/
  // mobileSurface) cercano `reports/mobile/<pkg>-apktool|-jadx`, quindi derivarlo dal basename
  // dell'APK li lasciava a vuoto (es. "NOA Trade Ideas (1).apk"). Fallback: basename.
  // ASSOLUTO per forza: con `-d <dir relativa>` jadx carica e processa l'APK ma poi muore in
  // save (`Can't create directory <dir>/sources`), perdendo in silenzio la meta' jadx del pass
  // (osservato 2026-10-06 su "Wheel of Faith - Arena.apk", riprodotto su NOA Trade Ideas).
  const out = path.resolve(opts.out || path.join(__dirname, '..', 'reports', 'mobile',
    opts.package ? String(opts.package) : path.basename(String(apk)).replace(/\.apk$/i, '')));
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

// ---- M.1: framework-aware Frida script selection -------------------------------------
// The static pass (apktool/jadx into reports/mobile/<pkg>-apktool|-jadx) leaves the evidence
// needed to pick the RIGHT hook instead of always defaulting to the objection-style unpin:
//   - libflutter.so / libapp.so present  -> Flutter app: disable-flutter-tls.js (BoringSSL hook)
//   - pairipcore / com.pairip present    -> PairIP-protected: repack first (always confirm)
//   - otherwise                          -> unpin.js (objection-style)
// Detection is OFFLINE + fail-soft: a missing directory just means "no signal", never an error.
function dirHasMatch(dir, re, depth) {
  depth = depth == null ? 4 : depth;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return false; }
  for (const e of entries) {
    if (re.test(e.name)) return true;
    if (e.isDirectory() && depth > 0 && dirHasMatch(path.join(dir, e.name), re, depth - 1)) return true;
  }
  return false;
}

// detectFramework(pkg, opts) -> { framework, flutter, pairip, reactNative, unity, xamarin,
// webapp, rootguard }. `opts.staticDirs` overrides the default output dirs (tests/fixtures);
// `opts.framework` short-circuits detection entirely. P3: oltre a flutter/pairip, riconosce
// react-native (index.android.bundle), unity (libunity.so), xamarin (libmonodroid.so),
// app web/hybrid (assets/www, cordova.js) e hint di root-guard (rootbeer) per scegliere
// (o suggerire) l'hook giusto invece del default unpin.
function frameworkResult(fw) {
  return {
    framework: fw, flutter: fw === 'flutter', pairip: fw === 'pairip',
    reactNative: fw === 'react-native', unity: fw === 'unity', xamarin: fw === 'xamarin',
    webapp: fw === 'webapp', rootguard: fw === 'rootguard', unknown: fw === 'unknown',
  };
}

function detectFramework(pkg, opts) {
  opts = opts || {};
  if (opts.framework) return frameworkResult(opts.framework);
  const base = path.join(__dirname, '..', 'reports', 'mobile');
  const dirs = opts.staticDirs || [path.join(base, `${pkg}-jadx`), path.join(base, `${pkg}-apktool`)];
  const sig = { flutter: false, pairip: false, reactNative: false, unity: false, xamarin: false, webapp: false, rootguard: false };
  for (const d of dirs) {
    if (!sig.flutter && dirHasMatch(d, /^libflutter\.so$|^libapp\.so$/)) sig.flutter = true;
    if (!sig.pairip && (dirHasMatch(d, /^pairipcore|^libpairipcore\.so$/) || dirHasMatch(path.join(d, 'com'), /^pairip$/))) sig.pairip = true;
    if (!sig.reactNative && dirHasMatch(d, /^index\.android\.bundle$/)) sig.reactNative = true;
    if (!sig.unity && (dirHasMatch(d, /^libunity\.so$/) || dirHasMatch(path.join(d, 'assets'), /^bin$/))) sig.unity = true;
    if (!sig.xamarin && (dirHasMatch(d, /^libmonodroid\.so$/) || dirHasMatch(d, /^assemblies$/))) sig.xamarin = true;
    if (!sig.webapp && (dirHasMatch(path.join(d, 'assets'), /^www$/) || dirHasMatch(d, /^cordova\.js$/))) sig.webapp = true;
    if (!sig.rootguard && (dirHasMatch(path.join(d, 'com', 'scottyab'), /^rootbeer$/) || dirHasMatch(d, /^librootchecker\.so$/))) sig.rootguard = true;
    if (Object.keys(sig).every((k) => sig[k])) break;
  }
  const framework = sig.pairip ? 'pairip'
    : sig.flutter ? 'flutter'
    : sig.reactNative ? 'react-native'
    : sig.xamarin ? 'xamarin'
    : sig.webapp ? 'webapp'
    : sig.unity ? 'unity'
    : 'unknown';
  return Object.assign({ framework }, sig);
}

// P3: scelta dello script in base al framework rilevato. flutter -> BoringSSL hook;
// tutto cio' che parla Java/okhttp (react-native, xamarin, webapp, unity-IL2CPP parziale)
// parte dal trust-all di unpin.js; pairip resta sul route repack (fridaHint).
function hookScriptFor(det) {
  if (det && det.flutter) return path.join(__dirname, 'frida', 'disable-flutter-tls.js');
  return path.join(__dirname, 'frida', 'unpin.js');
}

// fridaCommands is the default FRAMEWORK-AWARE hook (M.1). Precedence: explicit -l/--script
// (opts.script) > STAVROS_FRIDA_SCRIPT env (back-compat override) > framework default > unpin.js.
function fridaCommands(pkg, opts) {
  opts = opts || {};
  const serial = opts.serial || DEFAULT_SERIAL;
  const a = ['-U', '-n', pkg];
  let script = opts.script || process.env.STAVROS_FRIDA_SCRIPT;
  if (!script) script = hookScriptFor(detectFramework(pkg, opts));
  a.push('-l', script);
  if (opts.extra) a.push(...opts.extra);
  return [{ bin: 'frida', args: a.concat(['--device', serial]) }];
}

// fridaHint(pkg, opts) -> null | { repack_suggested, hint }. PairIP needs the repack path
// (tools/mobile-pairip-repack.sh, ALWAYS confirm) — surfacing it here keeps the operator on
// the supported route instead of fighting the packer with the generic unpin hook.
function fridaHint(pkg, opts) {
  const det = detectFramework(pkg, opts);
  if (det.pairip) {
    return {
      repack_suggested: true,
      hint: 'PairIP detected: repack with tools/mobile-pairip-repack.sh (always confirm) and re-run frida on the unpacked build',
    };
  }
  if (det.rootguard) {
    return {
      anti_anti_suggested: true,
      hint: 'root-check library detected (rootbeer): prepend tools/frida/anti-anti.js to neutralize root/emulator/anti-frida checks',
    };
  }
  return null;
}

// ---- P1: frida-server lifecycle ON THE DEVICE ---------------------------------------
// Senza frida-server sul telefono, `frida` non puo' attaccare nessuna app terza: e' il
// collo di bottiglia #1 (roadmap P1). Il server gira come root in /data/local/tmp (su
// MIUI-rooted: `su 0`), su UNA porta non standard e solo su loopback; il PC lo raggiunge
// con adb forward. down lo uccide: quando non serve, la superficie e' chiusa (P7).
// La versione e' quella del frida LOCALE (frida --version): client e server devono coincidere.
const FRIDA_DEVICE_PATH = '/data/local/tmp/frida-server';
const FRIDA_PORT_DEFAULT = process.env.STAVROS_FRIDA_PORT || '4747';

function fridaPort(opts) {
  const p = (opts && opts.port) || FRIDA_PORT_DEFAULT;
  if (!/^\d{1,5}$/.test(String(p)) || Number(p) < 1024 || Number(p) > 65535) {
    throw blockedError(`frida-server port invalid: ${p} (use a TCP port >= 1024)`);
  }
  return String(p);
}

// Pure builder. 'up' assumes the binary is already in /data/local/tmp (downloaded once
// via the phone's Tor, see f3bot/frida-server-fetch.sh): every `up` is idempotent —
// chmod, kill di un eventuale vecchio processo, avvio nohup detached, forward adb.
function fridaServerCommands(action, opts) {
  opts = opts || {};
  const serial = opts.serial || DEFAULT_SERIAL;
  const port = fridaPort(opts);
  const adb = ['-s', serial, 'shell'];
  if (action === 'up') {
    return [{ bin: 'adb', args: adb.concat([
      'su', '0', 'sh', '-c',
      `chmod 755 ${FRIDA_DEVICE_PATH} 2>/dev/null; killall frida-server 2>/dev/null; ` +
      `nohup ${FRIDA_DEVICE_PATH} -l 127.0.0.1:${port} >/dev/null 2>&1 & ` +
      // nohup forks: pidof can answer "" for a moment after the sleep, and that empty answer
      // used to be reported as "binario mancante". Poll instead of trusting a single read.
      `for i in 1 2 3 4 5; do p=$(pidof frida-server) && { echo $p; break; }; sleep 1; done`,
    ]) }];
  }
  if (action === 'down') {
    // kill di frida-server E della catena che lo ha lanciato (su/sh nohup): senza,
    // restano figli orfani che riassorbono la porta al prossimo up
    return [{ bin: 'adb', args: adb.concat([
      'su', '0', 'sh', '-c',
      `pkill -TERM frida-server; sleep 1; pkill -KILL frida-server 2>/dev/null; ` +
      // `pkill -f 'sh -c.*frida-server'` matched the very shell running this command (its own
      // argv contains the pattern) and SIGKILLed it: exit 137 and no STOPPED line. Skip $$.
      `for q in $(pgrep -f 'sh -c.*frida-server' 2>/dev/null); do ` +
      `[ "$q" = "$$" ] || kill -KILL "$q" 2>/dev/null; done; ` +
      `pidof frida-server || echo STOPPED`,
    ]) }];
  }
  if (action === 'status') {
    return [{ bin: 'adb', args: adb.concat([
      'su', '0', 'sh', '-c',
      `pidof frida-server || echo NOT-RUNNING; ls -l ${FRIDA_DEVICE_PATH} 2>/dev/null || echo NO-BINARY`,
    ]) }];
  }
  if (action === 'forward') {
    return [{ bin: 'adb', args: ['-s', serial, 'forward', `tcp:${port}`, `tcp:${port}`] }];
  }
  throw blockedError(`frida-server action unknown: ${action} (use up|down|status|forward)`);
}

// Executor: confirm-tier (classe 'frida') + forward dopo un up riuscito.
async function fridaServer(action, opts) {
  opts = opts || {};
  const runMobile = opts.runMobile || defaultRunMobile;
  const cmds = fridaServerCommands(action, opts);
  const results = [];
  for (const c of cmds) {
    const r = await runMobile(c.bin, c.args, Object.assign({ sub: 'frida-server', serial: opts.serial }, opts));
    results.push({ cmd: c.bin, status: r && r.status, stdout: String((r && r.stdout) || '').trim() });
  }
  const out = { action, serial: opts.serial || DEFAULT_SERIAL, port: fridaPort(opts), results };
  if (action === 'up') {
    const running = results.some((r) => /^\d+/.test(r.stdout));
    out.running = running;
    if (running) {
      const f = fridaServerCommands('forward', opts)[0];
      const rf = await runMobile(f.bin, f.args, Object.assign({ sub: 'frida-server', serial: opts.serial }, opts));
      out.forward = `tcp:${out.port} -> device 127.0.0.1:${out.port} (status ${rf && rf.status})`;
      out.connect = `frida -H 127.0.0.1:${out.port} ...  (o STAVROS_ADB_SERIAL per -U)`;
    } else {
      out.hint = `binario mancante o non avviato: scaricalo UNA volta sul device ` +
        `(es. f3bot/frida-server-fetch.sh via Tor) con la versione $(frida --version) = ` +
        `${localFridaVersion()}, poi riprova`;
    }
  }
  if (action === 'down') out.stopped = results.some((r) => /STOPPED|^\s*$/.test(r.stdout) || !/^\d+/.test(r.stdout));
  return out;
}

function localFridaVersion() {
  try {
    const { spawnSync } = require('child_process');
    const r = spawnSync('frida', ['--version'], { encoding: 'utf8', timeout: 5000 });
    return (r.stdout || '').trim() || 'unknown';
  } catch { return 'unknown'; }
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

function sha256Buffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// ---- M.2: authorized APK renewal (fetch-apk) ----------------------------------------
// Re-aligns static/dynamic when the app publishes a new build, WITHOUT trusting the network:
//   - the source URL must be declared in mobile-scope.json `apk_sources` (URL allowlist),
//   - its host must pass scope-guard against scope.json (the app backend is already in scope),
//   - the downloaded bytes must match a known sha256 (apk_sources[].sha256 or allowed_apk_sha256).
// Any mismatch/absence is a REFUSE (fail-closed, anti-tampering), never a warning. Downloads
// and refusals are appended to reports/mobile-apk-log.jsonl for the audit trail. The fetch is
// injectable so tests run fully offline.
const APK_LOG = () => process.env.MOBILE_APK_LOG || path.join(__dirname, '..', 'reports', 'mobile-apk-log.jsonl');

function apkLog(entry) {
  try {
    const p = APK_LOG();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, JSON.stringify(entry) + '\n');
  } catch {}
}

function loadApkSources(scope) {
  const list = scope && scope.apk_sources;
  return Array.isArray(list) ? list.filter((s) => s && typeof s.url === 'string' && s.url.trim()) : [];
}

// First source that applies to the package (a source with no `pkg` applies to any allowed pkg).
function apkSourceFor(pkg, scope) {
  const srcs = loadApkSources(scope).filter((s) => !s.pkg || s.pkg === pkg);
  return srcs.length ? srcs[0] : null;
}

// Minimal zero-dependency GET -> Buffer with bounded redirects. Injectable via opts.fetchImpl.
function httpGetBuffer(url, opts) {
  opts = opts || {};
  const https = require('https');
  const http = require('http');
  const maxRedirects = opts.maxRedirects == null ? 5 : opts.maxRedirects;
  return new Promise((resolve, reject) => {
    const go = (u, n) => {
      let parsed;
      try { parsed = new URL(u); } catch { return reject(new Error('invalid url: ' + u)); }
      const mod = parsed.protocol === 'https:' ? https : (parsed.protocol === 'http:' ? http : null);
      if (!mod) return reject(new Error('unsupported protocol: ' + parsed.protocol));
      const req = mod.get(u, { timeout: opts.timeout || 30000, headers: opts.headers || {} }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          if (n <= 0) return reject(new Error('too many redirects'));
          return go(new URL(res.headers.location, u).toString(), n - 1);
        }
        if (res.statusCode !== 200) { res.resume(); return reject(new Error('http ' + res.statusCode)); }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', reject);
    };
    go(url, maxRedirects);
  });
}

function blockedError(message) {
  const e = new Error(message);
  e.blocked = true;
  return e;
}

// fetchApk(pkg, opts) -> { ok, pkg, sha256, expected, source, path, bytes }
// opts: { out?, verifyOnly?, fetchImpl?, checkSourceInScope?, scopePath? }
async function fetchApk(pkg, opts) {
  opts = opts || {};
  let scope;
  try {
    scope = mg.loadMobileScope(opts.scopePath);
  } catch (e) {
    throw blockedError(e && e.code === 'MOBILE_SCOPE_INVALID_JSON' ? e.message : 'mobile-scope.json missing - nothing is authorized yet');
  }
  if (mg.scopeEmpty(scope)) throw blockedError('mobile-scope.json empty - nothing is authorized yet');
  const pk = mg.packageInScope(pkg, scope);
  if (!pk.ok) throw blockedError(pk.reason);

  const src = apkSourceFor(pkg, scope);
  const allowedHashes = ((scope && scope.allowed_apk_sha256) || []).map((x) => String(x).toLowerCase());
  const expected = (src && src.sha256 ? String(src.sha256).toLowerCase() : null) || allowedHashes[0] || null;
  if (!expected) {
    apkLog({ ts: new Date().toISOString(), pkg, verdict: 'refused', reason: 'no sha256 to verify against' });
    throw blockedError('no sha256 to verify against: set allowed_apk_sha256 or apk_sources[].sha256 (fail-closed)');
  }

  // --verify-only <file>: no network at all; just hash the operator-supplied file.
  if (opts.verifyOnly) {
    const file = opts.verifyOnly;
    const sha = sha256File(file); // throws ENOENT if missing -> surfaces as an error
    if (sha !== expected) {
      apkLog({ ts: new Date().toISOString(), pkg, file, sha256: sha, expected, verdict: 'refused', reason: 'sha256 mismatch' });
      throw blockedError(`sha256 mismatch for ${file}: got ${sha}, expected ${expected}`);
    }
    apkLog({ ts: new Date().toISOString(), pkg, file, sha256: sha, verdict: 'verify-only-ok' });
    return { ok: true, pkg, sha256: sha, expected, source: 'operator-file', path: file, bytes: fs.statSync(file).size };
  }

  if (!src) {
    apkLog({ ts: new Date().toISOString(), pkg, verdict: 'refused', reason: 'no apk_sources declared' });
    throw blockedError('no apk_sources declared for this package in mobile-scope.json (fail-closed)');
  }
  // The source host must be authorized by scope.json (same guard as every other target).
  const check = opts.checkSourceInScope || ((url) => require('./scope-guard').inScope(url, require('./scope-guard').loadScope()));
  const sc = check(src.url);
  if (!sc || !sc.ok) {
    apkLog({ ts: new Date().toISOString(), pkg, url: src.url, verdict: 'refused', reason: (sc && sc.reason) || 'source not in scope' });
    throw blockedError('apk source not in scope.json: ' + ((sc && sc.reason) || 'denied'));
  }

  const fetchFn = opts.fetchImpl || httpGetBuffer;
  let buf;
  try {
    buf = await fetchFn(src.url, opts);
  } catch (e) {
    apkLog({ ts: new Date().toISOString(), pkg, url: src.url, verdict: 'refused', reason: 'download failed: ' + (e.message || e) });
    throw blockedError('apk download failed: ' + (e.message || e));
  }
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  const sha = sha256Buffer(buf);
  if (sha !== expected) {
    apkLog({ ts: new Date().toISOString(), pkg, url: src.url, sha256: sha, expected, verdict: 'refused', reason: 'sha256 mismatch' });
    throw blockedError(`sha256 mismatch: got ${sha}, expected ${expected} (possible tampering - refusing to write)`);
  }
  const out = opts.out || path.join(__dirname, '..', 'reports', 'mobile', `${pkg}-${sha.slice(0, 8)}.apk`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, buf);
  apkLog({ ts: new Date().toISOString(), pkg, url: src.url, sha256: sha, path: out, bytes: buf.length, verdict: 'fetched' });
  return { ok: true, pkg, sha256: sha, expected, source: src.url, path: out, bytes: buf.length };
}

// ---- M.3: Firebase surface audit (detection-only, read-only EXISTENCE checks) -------
// The static pass leaves the Firebase config (google-services.json / res/values/strings.xml).
// We extract it, then issue ONE existence probe per asset and treat only a 200 as a finding:
//   401/403 = locked (expected, no finding) · 404 = absent · 200 = exposed-firebase (Medium max).
// Probes reuse cloud-enum.probeUrl (scope-guard + resolveAndGuard + fail-closed) — no duplicate
// network path. The claim is single-request so verify_level = 'triggered'.
const FIREBASE_KEYS = {
  api_key: 'google_api_key',
  database_url: 'firebase_database_url',
  storage_bucket: 'google_storage_bucket',
  project_id: 'project_id',
  app_id: 'google_app_id',
};

// Pure: parse res/values/strings.xml for the google-services values.
function parseFirebaseStrings(xml) {
  const out = {};
  const s = String(xml || '');
  for (const [key, name] of Object.entries(FIREBASE_KEYS)) {
    const m = s.match(new RegExp(`<string[^>]*name="${name}"[^>]*>([^<]*)</string>`, 'i'));
    if (m && m[1] && m[1].trim()) out[key] = m[1].trim();
  }
  return out;
}

// Pure: parse assets/google-services.json (authoritative when present).
function parseGoogleServicesJson(text) {
  let o;
  try { o = JSON.parse(String(text || '')); } catch { return {}; }
  if (!o || typeof o !== 'object') return {};
  const p = o.project_info && typeof o.project_info === 'object' ? o.project_info : {};
  const client = (Array.isArray(o.client) ? o.client : []).find((c) => c && c.client_info) || null;
  const ci = client ? client.client_info : {};
  const out = {};
  if (p.project_id) out.project_id = String(p.project_id);
  if (p.storage_bucket) out.storage_bucket = String(p.storage_bucket);
  if (p.firebase_url) out.database_url = String(p.firebase_url);
  if (ci.mobilesdk_app_id) out.app_id = String(ci.mobilesdk_app_id);
  const key = Array.isArray(ci.api_key) && ci.api_key[0] && ci.api_key[0].current_key;
  if (key) out.api_key = String(key);
  return out;
}

// Recursive file finder (bounded depth), fail-soft on unreadable dirs.
function findFiles(dir, re, depth) {
  depth = depth == null ? 6 : depth;
  const out = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isFile() && re.test(e.name)) out.push(full);
    else if (e.isDirectory() && depth > 0) out.push(...findFiles(full, re, depth - 1));
  }
  return out;
}

// extractFirebaseConfig(pkg, opts) -> partial config ({} when nothing found). Offline, fail-soft.
function extractFirebaseConfig(pkg, opts) {
  opts = opts || {};
  const base = path.join(__dirname, '..', 'reports', 'mobile');
  const dirs = opts.staticDirs || [path.join(base, `${pkg}-jadx`), path.join(base, `${pkg}-apktool`)];
  const cfg = {};
  for (const d of dirs) {
    for (const f of findFiles(d, /^google-services\.json$/)) {
      try { Object.assign(cfg, parseGoogleServicesJson(fs.readFileSync(f, 'utf8'))); } catch {}
    }
    for (const f of findFiles(d, /^strings\.xml$/)) {
      try {
        const v = parseFirebaseStrings(fs.readFileSync(f, 'utf8'));
        for (const k of Object.keys(v)) if (!cfg[k]) cfg[k] = v[k];
      } catch {}
    }
  }
  return cfg;
}

// The project id can come from project_id or from the database_url host prefix.
function firebaseProject(cfg) {
  if (cfg.project_id) return String(cfg.project_id);
  const m = String(cfg.database_url || '').match(/^https?:\/\/([^.]+)\.firebaseio\.com/i);
  return m ? m[1] : null;
}

// Pure: probe list from a config.
function firebaseProbes(cfg) {
  const probes = [];
  const project = firebaseProject(cfg || {});
  if (project) probes.push({ id: 'rtdb', url: `https://${project}.firebaseio.com/.json?shallow=true` });
  if (cfg && cfg.storage_bucket) probes.push({ id: 'storage', url: `https://firebasestorage.googleapis.com/v0/b/${cfg.storage_bucket}/o?maxResults=1` });
  return probes;
}

// Pure: status -> verdict. ONLY a 200 is an exposure; 401/403 is the locked (good) state.
function classifyFirebaseProbe(id, res) {
  if (!res || res.blocked) return { state: 'skipped', reason: (res && res.blocked) || 'no response' };
  const s = res.status;
  if (s === 200) return { state: 'exposed', severity: 'Medium' };
  if (s === 401 || s === 403) return { state: 'protected' };
  if (s === 404) return { state: 'absent' };
  return { state: 'unknown', status: s };
}

// Mask the API key before persisting the config in a report (the key is a credential).
function redactConfig(cfg) {
  const c = Object.assign({}, cfg || {});
  if (c.api_key) c.api_key = String(c.api_key).slice(0, 6) + '…(redacted)';
  return c;
}

function recordFirebaseFindings(findings) {
  let rf;
  try { rf = require('./record-finding'); } catch { return 0; }
  let n = 0;
  for (const f of findings) {
    try {
      const res = rf.record(JSON.stringify({
        title: `Exposed Firebase ${f.endpoint_id}: ${f.endpoint}`.slice(0, 160),
        host: f.host, endpoint: f.endpoint, class: 'cloud', cwe: 'CWE-284',
        severity: 'Medium', verify_level: 'triggered', status: 'confirmed',
        poc: `GET ${f.endpoint} → HTTP 200 (read-only existence probe)`, technique: 'T1530',
        remediation: 'Applicare le Firebase Security Rules / restringere l\'accesso anonimo al DB e al bucket.',
        notes: 'tools/mobile.js firebase-audit (detection-only, single-request verify).',
      }));
      if (res && res.ok) n++;
    } catch {}
  }
  return n;
}

// firebaseAudit(pkg, opts) -> { pkg, config, probes, findings, recorded, _file? }
// opts: { config?, staticDirs?, probe?, reportsDir?, record? , timeoutMs? }
async function firebaseAudit(pkg, opts) {
  opts = opts || {};
  const cfg = opts.config || extractFirebaseConfig(pkg, opts);
  const probes = firebaseProbes(cfg);
  const probe = opts.probe || ((url) => require('./cloud-enum').probeUrl(url, opts.timeoutMs));
  const results = [];
  const findings = [];
  for (const p of probes) {
    const res = await probe(p.url);
    const verdict = classifyFirebaseProbe(p.id, res);
    results.push(Object.assign({ id: p.id, url: p.url, status: res && res.status }, verdict));
    if (verdict.state === 'exposed') {
      findings.push({
        host: pkg, endpoint: p.url, endpoint_id: p.id, class: 'cloud', verify_level: 'triggered', severity: 'Medium',
        reason: `Firebase ${p.id} reachable without authentication (HTTP 200)`, endpoint_state: verdict.state,
        evidence: { status: res.status, sample: String((res && res.body) || '').slice(0, 120) },
      });
    }
  }
  const report = { pkg, generated_at: new Date().toISOString(), config: redactConfig(cfg), probes: results, findings };
  const outDir = opts.reportsDir || process.env.STAVROS_REPORTS_DIR || path.join(__dirname, '..', 'reports');
  try {
    fs.mkdirSync(outDir, { recursive: true });
    const f = path.join(outDir, `mobile-firebase-${pkg}.json`);
    fs.writeFileSync(f, JSON.stringify(report, null, 2));
    report._file = f;
  } catch { /* non-fatal */ }
  const recorded = (opts.record === false || findings.length === 0) ? 0 : recordFirebaseFindings(findings);
  return Object.assign(report, { recorded });
}

// ---- M.4: exported components / deeplinks -> map + mobile coverage class -------------
// The static pass leaves AndroidManifest.xml (apktool/jadx). We extract the EXPORTED surface
// (activities/services/receivers/providers with android:exported="true" + their deeplinks),
// record it as candidate rows in reports/<pkg>-map.json (method ANDROID/DEEPLINK, class mobile),
// and register the 'mobile' class in the coverage matrix so an UNTESTED mobile surface shows as
// a gap instead of silently counting as covered.
function parseAndroidManifest(xml) {
  const s = String(xml || '');
  if (!s || !/<manifest\b/.test(s)) return null;
  const pkg = (s.match(/<manifest[^>]*\bpackage="([^"]+)"/) || [])[1] || null;
  const exported = [];
  const deeplinks = [];
  // Match the OPENING tag, then (when not self-closing) take the content up to the matching
  // close tag. A naive non-greedy block regex would stop at the first self-closing child
  // (<action .../>) and lose the <data> deeplinks that follow inside the same intent-filter.
  const openRe = /<(activity|activity-alias|service|receiver|provider)\b([^>]*?)(\/?)>/g;
  let m;
  while ((m = openRe.exec(s))) {
    const type = m[1];
    const attrs = m[2] || '';
    let inner = '';
    if (!m[3]) {
      const closeRe = new RegExp(`</${type}\\s*>`, 'g');
      closeRe.lastIndex = openRe.lastIndex;
      const cm = closeRe.exec(s);
      if (cm) { inner = s.slice(openRe.lastIndex, cm.index); openRe.lastIndex = cm.index + cm[0].length; }
    }
    const name = (attrs.match(/\bandroid:name="([^"]+)"/) || [])[1] || null;
    if (!name) continue;
    if (!/\bandroid:exported="true"/i.test(attrs)) continue; // only explicitly exported = surface
    const hasFilter = /<intent-filter\b/i.test(inner);
    const block = inner;
    const compDeeplinks = [];
    const dataRe = /<data\b([^>]*)\/>/g;
    let dm;
    while ((dm = dataRe.exec(block))) {
      const attrs = dm[1];
      const scheme = (attrs.match(/\bandroid:scheme="([^"]+)"/) || [])[1];
      if (!scheme) continue;
      const host = (attrs.match(/\bandroid:host="([^"]+)"/) || [])[1] || '';
      const p = (attrs.match(/\bandroid:path(?:Prefix|Pattern|AdvancedPattern)?="([^"]+)"/) || [])[1] || '';
      const dl = `${scheme}://${host}${p}`;
      compDeeplinks.push(dl);
      if (!deeplinks.includes(dl)) deeplinks.push(dl);
    }
    exported.push({ type, name, filter: hasFilter, deeplinks: compDeeplinks });
  }
  return { package: pkg, exported, deeplinks };
}

// Locate + parse the manifest in the static output dirs (fail-soft -> null).
function extractManifest(pkg, opts) {
  opts = opts || {};
  const base = path.join(__dirname, '..', 'reports', 'mobile');
  const dirs = opts.staticDirs || [path.join(base, `${pkg}-jadx`), path.join(base, `${pkg}-apktool`)];
  for (const d of dirs) {
    for (const f of findFiles(d, /^AndroidManifest\.xml$/)) {
      try {
        const parsed = parseAndroidManifest(fs.readFileSync(f, 'utf8'));
        if (parsed) return { manifest: parsed, file: f };
      } catch {}
    }
  }
  return null;
}

// Pure: manifest -> map.js candidate entries (class 'mobile').
function manifestMapEntries(pkg, manifest) {
  const entries = [];
  if (!manifest) return entries;
  for (const c of manifest.exported) {
    entries.push({
      host: pkg, path: `/manifest/${c.type}/${String(c.name).split('.').pop()}`, method: 'ANDROID',
      params: [], auth_required: false,
      notes: `${c.type} exported${c.filter ? ' with intent-filter' : ''}${c.deeplinks.length ? ' — deeplinks: ' + c.deeplinks.join(', ') : ''}`,
      candidates: { mobile: [c.type] },
    });
  }
  for (const dl of manifest.deeplinks) {
    entries.push({
      host: pkg, path: dl, method: 'DEEPLINK', params: [], auth_required: false,
      notes: 'deeplink intent-filter (exported component)', candidates: { mobile: ['deeplink'] },
    });
  }
  // Zero exported surface is itself a result: record an explicit empty candidate so the matrix
  // shows 'n-a' (audited, nothing to test) instead of a silent absence.
  if (!entries.length) {
    entries.push({ host: pkg, path: '/manifest', method: 'ANDROID', params: [], auth_required: false,
      notes: 'no exported components/deeplinks found', candidates: { mobile: [] } });
  }
  return entries;
}

// Write the manifest surface into reports/<pkg>-map.json (via map.js; STAVROS_MAP_DIR override).
function writeMobileMap(pkg, manifest) {
  const mapLib = require('./map');
  let added = 0; const errors = [];
  for (const e of manifestMapEntries(pkg, manifest)) {
    const r = mapLib.add(JSON.stringify(e));
    if (r.ok) added++;
    else errors.push(r.error);
  }
  const file = path.join(process.env.STAVROS_MAP_DIR || path.join(__dirname, '..', 'reports'), `${pkg}-map.json`);
  return { added: added, file: file, errors: errors };
}

// mobileSurface(pkg, opts) -> manifest surface + map rows + the 'mobile' coverage row.
// opts: { manifest?, staticDirs?, reportsDir?, findingsFile? }
function mobileSurface(pkg, opts) {
  opts = opts || {};
  const found = opts.manifest ? { manifest: opts.manifest, file: null } : extractManifest(pkg, opts);
  const manifest = found ? found.manifest : null;
  const mapInfo = writeMobileMap(pkg, manifest);
  let coverage = null;
  try {
    const cov = require('./coverage');
    const m = cov.buildMatrix(pkg, { reportsDir: opts.reportsDir, findingsFile: opts.findingsFile, mobile: true });
    const row = m.rows.find((r) => r.class === 'mobile');
    coverage = { host: pkg, row: row || null };
  } catch { /* coverage is advisory */ }
  return {
    pkg,
    manifest_file: found ? found.file : null,
    exported: manifest ? manifest.exported.length : 0,
    deeplinks: manifest ? manifest.deeplinks.length : 0,
    details: manifest ? { exported: manifest.exported, deeplinks: manifest.deeplinks } : null,
    map: mapInfo,
    coverage,
  };
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
  // capture=true is MANDATORY here: runBinary buffers stdout/stderr only when asked to, and
  // every verdict below reads r.stdout (device list, pidof frida-server, STDOUT dei tool).
  // Without it stdout is dropped and the tool reports "running: false" on a server that is
  // up. Same contract as tools/ad.js, tools/cloud-enum.js, tools/crack.js.
  const r = await runBinaryFn(bin, args, Object.assign({ capture: true }, opts));
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
  // M.3 post-pass: only when explicitly asked (network) AND the package is known.
  let firebase = null;
  if (opts.firebase && opts.package) {
    firebase = await firebaseAudit(opts.package, {
      staticDirs: opts.staticDirs, reportsDir: opts.reportsDir, record: opts.record,
      config: opts.config, probe: opts.probe,
    });
  }
  // M.4 post-pass: offline (manifest -> map + mobile coverage row).
  let surface = null;
  if (opts.surface && opts.package) {
    surface = mobileSurface(opts.package, { staticDirs: opts.staticDirs, reportsDir: opts.reportsDir });
  }
  const out = { apk, results };
  if (firebase) out.firebase = firebase;
  if (surface) out.surface = surface;
  return out;
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
    'usage: node tools/mobile.js check <target> | status | static <apk> [--package <pkg> --firebase --surface] | surface <pkg> | fetch-apk <pkg> [--out f | --verify-only file] | firebase-audit <pkg> [--record] | install <apk> --package <pkg> [--serial S] | shell <serial> <pkg> -- <args...> | frida-server up|down|status [serial] [--port N] [--confirm "r"] | frida <serial> <pkg> [-l hook.js] [--confirm "r"] | intercept <serial> [--write dir] [--confirm "r"] | ca-install <serial> [--confirm "r"] | reset [--confirm "r"]'
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
    else if (a === '--framework') opts.framework = rest[++i];
    else if (a === '--port') opts.port = rest[++i];
    else if (a === '--verify-only') opts.verifyOnly = rest[++i];
    else if (a === '--firebase') opts.firebase = true;
    else if (a === '--surface') opts.surface = true;
    else if (a === '--record') opts.record = true;
    else if (a === '--reports-dir') opts.reportsDir = rest[++i];
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
        const det = detectFramework(pos[1], opts);
        const c = fridaCommands(pos[1], { serial: pos[0], script: opts.script, framework: opts.framework, staticDirs: opts.staticDirs })[0];
        const { runBinary: rb, ...o } = opts;
        const r = await defaultRunMobile(c.bin, c.args, Object.assign({ sub: 'frida', package: pos[1], serial: pos[0] }, o));
        out = Object.assign({ package: pos[1], framework: det.framework, script: path.basename(c.args[c.args.indexOf('-l') + 1] || ''), status: r && r.status }, fridaHint(pos[1], opts) || {});
        break;
      }
      case 'frida-server': {
        const action = pos[0];
        if (!action || !['up', 'down', 'status', 'forward'].includes(action)) usage();
        out = await fridaServer(action, Object.assign({}, opts, { serial: pos[1] || opts.serial }));
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
      case 'fetch-apk': {
        if (!pos[0]) usage();
        out = await fetchApk(pos[0], { out: opts.out, verifyOnly: opts.verifyOnly, scopePath: opts.scopePath });
        break;
      }
      case 'firebase-audit': {
        if (!pos[0]) usage();
        out = await firebaseAudit(pos[0], { record: opts.record, reportsDir: opts.reportsDir, staticDirs: opts.staticDirs });
        break;
      }
      case 'surface': {
        if (!pos[0]) usage();
        out = mobileSurface(pos[0], { staticDirs: opts.staticDirs, reportsDir: opts.reportsDir });
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
  staticCommands, installCommands, shellCommands, fridaCommands, fridaHint, detectFramework,
  fridaServerCommands, fridaServer, fridaPort, FRIDA_DEVICE_PATH, hookScriptFor, frameworkResult,
  interceptCommands, dirHasMatch,
  loadApkSources, apkSourceFor, sha256Buffer, httpGetBuffer, fetchApk,
  parseFirebaseStrings, parseGoogleServicesJson, findFiles, extractFirebaseConfig, firebaseProject,
  firebaseProbes, classifyFirebaseProbe, redactConfig, firebaseAudit,
  parseAndroidManifest, extractManifest, manifestMapEntries, writeMobileMap, mobileSurface,
  extractTargets, classify, classifyRaw, loadTiers, statusCmd, staticApk, installApk, shell,
  defaultRunMobile,
};
