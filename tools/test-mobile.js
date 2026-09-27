// Offline self-check for the mobile runner (mobile.js + mobile-guard.js). No device,
// no adb, no real binaries: a fake runBinary returns canned output, and we assert scope +
// tier logic and command assembly. Run: node tools/test-mobile.js
// test-tags: offline
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const mg = require('./mobile-guard');
const mobile = require('./mobile');

const PKG = 'com.lab.vulnapp';
const SERIAL = '127.0.0.1:5555';
const SHA = 'a'.repeat(64);

// ---- guard primitives ----
assert.strictEqual(mg.isPackage(PKG), true, 'valid package');
assert.strictEqual(mg.isPackage('not-a-package!'), false, 'invalid package rejected');
assert.strictEqual(mg.isSha256(SHA), true, 'valid sha256');
assert.strictEqual(mg.isLoopbackHost('127.0.0.1'), true, 'loopback accepted');
assert.strictEqual(mg.isLoopbackHost('192.168.1.10'), false, 'LAN host rejected');
assert.strictEqual(mg.isLoopbackHost('localhost'), true, 'localhost accepted');

const scope = {
  allowed_packages: [PKG],
  allowed_serials: [SERIAL],
  allowed_apk_sha256: [],
  mobile_ops: { auto: ['status', 'static', 'install', 'shell_read', 'intercept_read'], confirm: ['frida', 'unpin', 'repack', 'intercept_write', 'reset'] },
};
assert.strictEqual(mg.packageInScope(PKG, scope).ok, true, 'package in scope');
assert.strictEqual(mg.packageInScope('com.evil.other', scope).ok, false, 'package out of scope');
assert.strictEqual(mg.serialInScope(SERIAL, scope).ok, true, 'serial in scope');
assert.strictEqual(mg.serialInScope('192.168.1.10:5555', scope).ok, false, 'non-loopback serial rejected even if well-formed');
assert.strictEqual(mg.inMobileScope(PKG, scope).type, 'package', 'auto-detect package');
assert.strictEqual(mg.inMobileScope(SERIAL, scope).type, 'serial', 'auto-detect serial');
assert.strictEqual(mg.inMobileScope(SHA, scope).type, 'apk', 'auto-detect apk');
assert.strictEqual(mg.scopeEmpty({ allowed_packages: [] }), true, 'empty scope detected');
assert.strictEqual(mg.scopeEmpty(scope), false, 'non-empty scope');

// ---- target extraction ----
assert.deepStrictEqual(
  mobile.extractTargets(['-s', SERIAL, 'shell', 'pm', 'list', 'packages', PKG]),
  { packages: [PKG], serials: [SERIAL], apks: [] },
  'package + serial extracted'
);
assert.deepStrictEqual(
  mobile.extractTargets(['app.apk']),
  { packages: [], serials: [], apks: ['app.apk'] },
  'apk extracted'
);

// ---- classification ----
assert.deepStrictEqual(mobile.classify('apktool', ['d', 'a.apk'], scope, 'static'), { actionClass: 'static', tier: 'auto' }, 'static = auto');
assert.deepStrictEqual(mobile.classify('adb', ['-s', SERIAL, 'install'], scope, 'install'), { actionClass: 'install', tier: 'auto' }, 'install = auto');
assert.deepStrictEqual(mobile.classify('frida', ['-U', '-n', PKG], scope, 'frida'), { actionClass: 'frida', tier: 'confirm' }, 'frida = confirm');
assert.deepStrictEqual(mobile.classify('unknown-bin', [], scope, null), { actionClass: 'unknown', tier: 'confirm' }, 'unknown = confirm (fail closed)');

// ---- command builders (pure) ----
assert.strictEqual(mobile.staticCommands('a.apk')[0].bin, 'apktool', 'static uses apktool first');
assert.strictEqual(mobile.staticCommands('a.apk')[1].bin, 'jadx', 'static uses jadx second');
assert.strictEqual(mobile.installCommands('a.apk', { serial: SERIAL })[0].bin, 'adb', 'install uses adb');
assert.strictEqual(mobile.fridaCommands(PKG, { serial: SERIAL })[0].bin, 'frida', 'frida builder');

// ---- M.1: framework-aware Frida script selection (offline, from static output) ----
const fwDir = path.join(os.tmpdir(), 'mobile-fw-' + process.pid);
const flutterDir = path.join(fwDir, 'app-jadx');
fs.mkdirSync(path.join(flutterDir, 'lib', 'arm64-v8a'), { recursive: true });
fs.writeFileSync(path.join(flutterDir, 'lib', 'arm64-v8a', 'libflutter.so'), 'x');
const pairipDir = path.join(fwDir, 'pairip-apktool');
fs.mkdirSync(path.join(pairipDir, 'com', 'pairip'), { recursive: true });
delete process.env.STAVROS_FRIDA_SCRIPT;
assert.strictEqual(mobile.detectFramework(PKG, { framework: 'flutter' }).framework, 'flutter', 'explicit framework short-circuits');
assert.strictEqual(mobile.detectFramework(PKG, { staticDirs: [flutterDir] }).framework, 'flutter', 'libflutter.so → flutter');
assert.strictEqual(mobile.detectFramework(PKG, { staticDirs: [pairipDir] }).framework, 'pairip', 'com/pairip → pairip');
assert.strictEqual(mobile.detectFramework(PKG, { staticDirs: [path.join(fwDir, 'absent')] }).framework, 'unknown', 'no signal → unknown');
const flutterArgs = mobile.fridaCommands(PKG, { serial: SERIAL, staticDirs: [flutterDir] })[0].args.join(' ');
assert.ok(flutterArgs.includes('disable-flutter-tls.js'), 'flutter default → disable-flutter-tls.js');
const fallbackArgs = mobile.fridaCommands(PKG, { serial: SERIAL, staticDirs: [path.join(fwDir, 'absent')] })[0].args.join(' ');
assert.ok(fallbackArgs.includes('unpin.js'), 'no framework → unpin.js');
assert.ok(mobile.fridaHint(PKG, { staticDirs: [pairipDir] }).repack_suggested, 'pairip → repack hint');
assert.strictEqual(mobile.fridaHint(PKG, { staticDirs: [flutterDir] }), null, 'flutter → no repack hint');
process.env.STAVROS_FRIDA_SCRIPT = '/tmp/custom-hook.js';
assert.ok(mobile.fridaCommands(PKG, { serial: SERIAL, staticDirs: [flutterDir] })[0].args.join(' ').includes('/tmp/custom-hook.js'), 'STAVROS_FRIDA_SCRIPT wins over framework default');
delete process.env.STAVROS_FRIDA_SCRIPT;

// ---- P3: extended framework detection + hookScriptFor ----
const rnDir = path.join(fwDir, 'rn-jadx');
fs.mkdirSync(path.join(rnDir, 'assets'), { recursive: true });
fs.writeFileSync(path.join(rnDir, 'assets', 'index.android.bundle'), 'x');
assert.strictEqual(mobile.detectFramework(PKG, { staticDirs: [rnDir] }).framework, 'react-native', 'index.android.bundle → react-native');
const webDir = path.join(fwDir, 'web-apktool');
fs.mkdirSync(path.join(webDir, 'assets', 'www'), { recursive: true });
assert.strictEqual(mobile.detectFramework(PKG, { staticDirs: [webDir] }).framework, 'webapp', 'assets/www → webapp');
const rgDir = path.join(fwDir, 'rootguard-jadx');
fs.mkdirSync(path.join(rgDir, 'com', 'scottyab'), { recursive: true });
fs.writeFileSync(path.join(rgDir, 'com', 'scottyab', 'rootbeer'), 'x');
const rgDet = mobile.detectFramework(PKG, { staticDirs: [rgDir] });
assert.strictEqual(rgDet.framework, 'unknown', 'rootbeer alone is not a framework');
assert.strictEqual(rgDet.rootguard, true, 'rootbeer flag surfaced');
assert.ok(mobile.fridaHint(PKG, { staticDirs: [rgDir] }).anti_anti_suggested, 'rootguard → anti-anti hint');
assert.ok(mobile.hookScriptFor({ flutter: true }).includes('disable-flutter-tls.js'), 'hookScriptFor flutter → BoringSSL hook');
assert.ok(mobile.hookScriptFor({ flutter: false }).includes('unpin.js'), 'hookScriptFor default → unpin.js');

// ---- P1: frida-server lifecycle (pure builders + tier) ----
assert.deepStrictEqual(
  mobile.classify('adb', ['-s', SERIAL, 'shell', 'su', '0', 'sh', '-c', 'nohup /data/local/tmp/frida-server -l 127.0.0.1:"4747"'], scope, 'frida-server'),
  { actionClass: 'frida', tier: 'confirm' },
  'frida-server = confirm-tier'
);
const fsUp = mobile.fridaServerCommands('up', { serial: SERIAL, port: '4747' })[0];
assert.strictEqual(fsUp.bin, 'adb', 'frida-server up uses adb');
const fsUpText = fsUp.args.join(' ');
assert.ok(fsUpText.includes('/data/local/tmp/frida-server'), 'device path pinned');
assert.ok(fsUpText.includes('-l 127.0.0.1:4747'), 'loopback NON-default port');
assert.ok(fsUpText.includes('su'), 'root required');
const fsDown = mobile.fridaServerCommands('down', { serial: SERIAL })[0];
assert.ok(fsDown.args.join(' ').includes('pkill -TERM frida-server'), 'down kills frida-server');
const fsFwd = mobile.fridaServerCommands('forward', { serial: SERIAL, port: '4747' })[0];
assert.deepStrictEqual(fsFwd.args, ['-s', SERIAL, 'forward', 'tcp:4747', 'tcp:4747'], 'forward mapping');
assert.throws(() => mobile.fridaServerCommands('up', { serial: SERIAL, port: '80' }), /port invalid/, 'privileged port refused');
assert.throws(() => mobile.fridaServerCommands('explode'), /unknown/, 'unknown action refused');

// ---- defaultRunMobile: fail-closed, injectable exec ----
const tmpDir = path.join(os.tmpdir(), 'mobile-test-' + process.pid);
fs.mkdirSync(tmpDir, { recursive: true });
const scopeFile = path.join(tmpDir, 'mobile-scope.json');
fs.writeFileSync(scopeFile, JSON.stringify(scope));
process.env.MOBILE_SCOPE_JSON = scopeFile;
process.env.MOBILE_AUDIT_JSONL = path.join(tmpDir, 'mobile-audit.jsonl');
const fakeExec = () => ({ status: 0, stdout: '', stderr: '' });

(async () => {
  // confirm-tier without --confirm -> rejected
  await assert.rejects(
    mobile.defaultRunMobile('frida', ['-U', '-n', PKG], { sub: 'frida', package: PKG, serial: SERIAL, runBinary: fakeExec }),
    /confirm-tier/
  );
  // out-of-scope package -> rejected
  await assert.rejects(
    mobile.defaultRunMobile('adb', ['-s', SERIAL, 'shell', 'pm', 'list'], { sub: 'shell', package: 'com.evil.other', serial: SERIAL, runBinary: fakeExec }),
    /out-of-scope/
  );
  // non-loopback serial -> rejected
  await assert.rejects(
    mobile.defaultRunMobile('adb', ['-s', '192.168.1.10:5555', 'shell', 'getprop'], { sub: 'shell', package: PKG, serial: '192.168.1.10:5555', runBinary: fakeExec }),
    /out-of-scope|loopback/
  );
  // static (auto, offline) runs
  const st = await mobile.defaultRunMobile('apktool', ['d', 'a.apk'], { sub: 'static', runBinary: fakeExec, apkSha: SHA });
  assert.strictEqual(st.status, 0, 'static runs');
  // frida WITH --confirm + in-scope targets runs
  const fr = await mobile.defaultRunMobile('frida', ['-U', '-n', PKG], { sub: 'frida', package: PKG, serial: SERIAL, confirm: 'lab unpin', runBinary: fakeExec });
  assert.strictEqual(fr.status, 0, 'confirmed frida runs');
  // reset without confirm -> rejected
  await assert.rejects(
    mobile.defaultRunMobile('redroid', ['reset'], { sub: 'reset', runBinary: fakeExec }),
    /confirm-tier/
  );
  // subcommands with fake runMobile
  const fakeRunMobile = async () => ({ status: 0, stdout: '', stderr: '' });
  const s = await mobile.staticApk('a.apk', { runMobile: fakeRunMobile });
  assert.strictEqual(s.results.length, 2, 'static runs apktool + jadx');
  const ins = await mobile.installApk('a.apk', { runMobile: fakeRunMobile, package: PKG, serial: SERIAL });
  assert.strictEqual(ins.status, 0, 'install runs');

  // ---- P1: frida-server through the guard ----
  const fsr = await mobile.fridaServer('status', { serial: SERIAL, confirm: 'P1 status', runMobile: fakeRunMobile });
  assert.strictEqual(fsr.action, 'status', 'frida-server status runs with --confirm');
  assert.strictEqual(fsr.port, '4747', 'frida-server default port 4747');
  // strada reale (non iniettata): frida-server e' confirm-tier -> senza --confirm si rifiuta
  await assert.rejects(
    mobile.defaultRunMobile('adb', ['-s', SERIAL, 'shell', 'su', '0', 'sh', '-c', 'nohup /data/local/tmp/frida-server -l 127.0.0.1:4747'], { sub: 'frida-server', serial: SERIAL, runBinary: fakeExec }),
    /confirm-tier/,
    'frida-server up is confirm-tier'
  );
  const fsOk = await mobile.defaultRunMobile('adb', ['-s', SERIAL, 'shell', 'su', '0', 'sh', '-c', 'pidof frida-server'], { sub: 'frida-server', serial: SERIAL, confirm: 'P1 status', runBinary: fakeExec });
  assert.strictEqual(fsOk.status, 0, 'confirmed frida-server runs');

  // ---- M.2: fetch-apk — allowlisted source + sha256 pinning, zero network ----
  process.env.MOBILE_APK_LOG = path.join(tmpDir, 'mobile-apk-log.jsonl');
  const apkBytes = Buffer.from('AUTHORIZED-APK-BYTES');
  const goodSha = crypto.createHash('sha256').update(apkBytes).digest('hex');
  const apkScopeFile = path.join(tmpDir, 'mobile-scope-apk.json');
  fs.writeFileSync(apkScopeFile, JSON.stringify(Object.assign({}, scope, {
    allowed_apk_sha256: [goodSha],
    apk_sources: [{ url: 'https://shop.example/authorized/app.apk', pkg: PKG }],
  })));
  process.env.MOBILE_SCOPE_JSON = apkScopeFile;
  const allowSource = () => ({ ok: true, reason: 'host allowlisted' });
  const outApk = path.join(tmpDir, 'got.apk');
  const got = await mobile.fetchApk(PKG, { fetchImpl: async () => apkBytes, checkSourceInScope: allowSource, out: outApk });
  assert.strictEqual(got.sha256, goodSha, 'fetch-apk keeps the verified sha256');
  assert.ok(fs.existsSync(outApk), 'verified apk written');
  // tampered bytes -> refuse (fail-closed) and NOT written
  const otherOut = path.join(tmpDir, 'evil.apk');
  await assert.rejects(
    mobile.fetchApk(PKG, { fetchImpl: async () => Buffer.from('TAMPERED'), checkSourceInScope: allowSource, out: otherOut }),
    /sha256 mismatch/
  );
  assert.ok(!fs.existsSync(otherOut), 'tampered payload never written');
  // source host out of scope.json -> refuse before any fetch
  await assert.rejects(
    mobile.fetchApk(PKG, { fetchImpl: async () => { throw new Error('must not fetch'); }, checkSourceInScope: () => ({ ok: false, reason: 'host not allowlisted' }) }),
    /not in scope/
  );
  // no sha256 pin at all -> refuse before touching the network
  process.env.MOBILE_SCOPE_JSON = scopeFile;
  await assert.rejects(mobile.fetchApk(PKG, { fetchImpl: async () => apkBytes }), /no sha256 to verify against/);
  // hash pinned but no apk_sources declared -> refuse
  const noSrcFile = path.join(tmpDir, 'mobile-scope-nosrc.json');
  fs.writeFileSync(noSrcFile, JSON.stringify(Object.assign({}, scope, { allowed_apk_sha256: [goodSha] })));
  process.env.MOBILE_SCOPE_JSON = noSrcFile;
  await assert.rejects(mobile.fetchApk(PKG, { fetchImpl: async () => apkBytes }), /no apk_sources/);
  // --verify-only: hash the operator file, no download
  process.env.MOBILE_SCOPE_JSON = apkScopeFile;
  const provided = path.join(tmpDir, 'provided.apk');
  fs.writeFileSync(provided, apkBytes);
  const v = await mobile.fetchApk(PKG, { verifyOnly: provided });
  assert.strictEqual(v.sha256, goodSha, 'verify-only confirms the pinned hash');
  fs.writeFileSync(provided, 'NOT-THE-APK');
  await assert.rejects(mobile.fetchApk(PKG, { verifyOnly: provided }), /sha256 mismatch/);
  await assert.rejects(mobile.fetchApk('com.evil.other', { verifyOnly: provided }), /not in mobile-scope/);
  delete process.env.MOBILE_APK_LOG;

  // ---- M.3: Firebase config extraction + single-request existence audit (offline) ----
  process.env.MOBILE_SCOPE_JSON = scopeFile;
  const fbDir = path.join(fwDir, 'app-apktool');
  fs.mkdirSync(path.join(fbDir, 'res', 'values'), { recursive: true });
  fs.writeFileSync(path.join(fbDir, 'res', 'values', 'strings.xml'),
    '<resources><string name="google_api_key">AIzaSyTESTKEY</string>'
    + '<string name="firebase_database_url">https://demo-ccf.firebaseio.com</string>'
    + '<string name="project_id">demo-ccf</string>'
    + '<string name="google_storage_bucket">demo-ccf.appspot.com</string></resources>');
  const cfg = mobile.extractFirebaseConfig(PKG, { staticDirs: [fbDir] });
  assert.strictEqual(cfg.project_id, 'demo-ccf', 'project_id extracted from strings.xml');
  assert.strictEqual(cfg.storage_bucket, 'demo-ccf.appspot.com', 'storage bucket extracted');
  assert.strictEqual(cfg.database_url, 'https://demo-ccf.firebaseio.com', 'database url extracted');
  assert.deepStrictEqual(
    mobile.parseGoogleServicesJson('{"project_info":{"project_id":"p1","storage_bucket":"p1.appspot.com"},"client":[{"client_info":{"mobilesdk_app_id":"1:2:android:3","api_key":[{"current_key":"K"}]}}]}'),
    { project_id: 'p1', storage_bucket: 'p1.appspot.com', app_id: '1:2:android:3', api_key: 'K' },
    'google-services.json parsed'
  );
  assert.deepStrictEqual(mobile.firebaseProbes(cfg).map((p) => p.id), ['rtdb', 'storage'], 'one probe per asset');
  assert.strictEqual(mobile.classifyFirebaseProbe('rtdb', { status: 200 }).state, 'exposed');
  assert.strictEqual(mobile.classifyFirebaseProbe('rtdb', { status: 401 }).state, 'protected');
  assert.strictEqual(mobile.classifyFirebaseProbe('rtdb', { status: 403 }).state, 'protected');
  assert.strictEqual(mobile.classifyFirebaseProbe('rtdb', { status: 404 }).state, 'absent');
  assert.strictEqual(mobile.classifyFirebaseProbe('rtdb', { blocked: 'host not in scope.json' }).state, 'skipped');
  const audit = await mobile.firebaseAudit(PKG, {
    config: cfg, record: false, reportsDir: tmpDir,
    probe: async (url) => (url.includes('firebaseio') ? { status: 200, body: '{"a":1}' } : { status: 403 }),
  });
  assert.strictEqual(audit.findings.length, 1, 'only the exposed asset becomes a finding');
  assert.strictEqual(audit.findings[0].class, 'cloud');
  assert.strictEqual(audit.findings[0].verify_level, 'triggered');
  assert.ok(!/AIzaSyTESTKEY/.test(JSON.stringify(audit.config)), 'api key redacted in the report');
  assert.ok(fs.existsSync(path.join(tmpDir, `mobile-firebase-${PKG}.json`)), 'firebase report written');

  // ---- M.4: exported components / deeplinks -> map rows + mobile coverage class ----
  const manifestXml = '<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="' + PKG + '">'
    + '<application>'
    + '<activity android:name=".MainActivity" android:exported="true">'
    + '<intent-filter><action android:name="android.intent.action.VIEW"/>'
    + '<category android:name="android.intent.category.DEFAULT"/>'
    + '<data android:scheme="https" android:host="fest.example" android:pathPrefix="/open"/></intent-filter>'
    + '</activity>'
    + '<activity android:name=".InternalActivity" android:exported="false"/>'
    + '<receiver android:name=".BootReceiver" android:exported="true"/>'
    + '</application></manifest>';
  const man = mobile.parseAndroidManifest(manifestXml);
  assert.strictEqual(man.package, PKG);
  assert.strictEqual(man.exported.length, 2, 'only explicitly exported components');
  assert.deepStrictEqual(man.deeplinks, ['https://fest.example/open'], 'deeplink extracted');
  assert.strictEqual(mobile.parseAndroidManifest('<not-a-manifest/>'), null);
  const mapDir = path.join(tmpDir, 'map');
  fs.mkdirSync(mapDir, { recursive: true });
  const prevMapDir = process.env.STAVROS_MAP_DIR;
  process.env.STAVROS_MAP_DIR = mapDir;
  const surf = mobile.mobileSurface(PKG, { manifest: man, reportsDir: tmpDir });
  assert.strictEqual(surf.exported, 2);
  assert.strictEqual(surf.deeplinks, 1);
  assert.ok(surf.map.added >= 3, 'map rows written');
  const mapWritten = JSON.parse(fs.readFileSync(path.join(mapDir, PKG + '-map.json'), 'utf8'));
  assert.ok(mapWritten.endpoints.some((e) => e.method === 'DEEPLINK' && e.path === 'https://fest.example/open'), 'deeplink row in map');
  assert.ok(mapWritten.endpoints.some((e) => e.candidates && Array.isArray(e.candidates.mobile) && e.candidates.mobile.length), 'mobile candidate rows');
  assert.ok(surf.coverage && surf.coverage.row && surf.coverage.row.class === 'mobile', 'mobile coverage row present');
  assert.strictEqual(surf.coverage.row.status, 'missed', 'untested mobile surface is a gap (never silently covered)');
  if (prevMapDir === undefined) delete process.env.STAVROS_MAP_DIR;
  else process.env.STAVROS_MAP_DIR = prevMapDir;

  delete process.env.MOBILE_SCOPE_JSON;
  delete process.env.MOBILE_AUDIT_JSONL;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.rmSync(fwDir, { recursive: true, force: true });
  console.log('mobile: all tests passed');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
