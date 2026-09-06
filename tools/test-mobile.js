// Offline self-check for the mobile runner (mobile.js + mobile-guard.js). No device,
// no adb, no real binaries: a fake runBinary returns canned output, and we assert scope +
// tier logic and command assembly. Run: node tools/test-mobile.js
// test-tags: offline
const assert = require('assert');
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

  delete process.env.MOBILE_SCOPE_JSON;
  delete process.env.MOBILE_AUDIT_JSONL;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log('mobile: all tests passed');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
