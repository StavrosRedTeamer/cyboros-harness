#!/usr/bin/env node
// Mobile scope guard — single source of truth for "am I allowed to touch this Android target".
// Separate model from scope-guard.js (IP/host) and wifi-guard.js (BSSID): mobile targets are
// package names (applicationId), adb serials (ReDroid instances) and APK file hashes — NOT IPs.
// Used HARD (in code) by tools/mobile.js; used procedurally by agents via
//   node tools/mobile-guard.js check <package|serial|sha256>
// Exit 0 = in scope, 1 = out of scope/blocked, 2 = usage error.
//
// mobile-scope.json:
//   allowed_packages:  ["com.lab.vulnapp"]  -> Android applicationId (exact, case-sensitive)
//   allowed_serials:   ["127.0.0.1:5555"]   -> adb serials. Two shapes:
//                                              (a) host:port  -> ONLY loopback ReDroid instances;
//                                                  a non-loopback host:port (LAN IP, 0.0.0.0,
//                                                  remote host) is ALWAYS rejected, even if listed.
//                                              (b) USB/hardware serial (e.g. "R5CT30XXXXX") -> a
//                                                  physically-attached authorized device. It has
//                                                  no network host to pin to loopback, so it is
//                                                  gated PURELY on exact allowlist membership
//                                                  (still fail-closed: not listed = rejected).
//                                                  Documented, deliberate loosening of the
//                                                  loopback-only rule for an in-engagement device.
//   allowed_apk_sha256: ["<hex64>", ...]     -> SHA256 allowlist for APK files (lab + bounty
//                                              in-scope). Empty = any APK whose package is allowed
//                                              may be analyzed statically; install still needs
//                                              the package to be allowed.
//   mobile_ops: { auto:[...], confirm:[...] } -> action tiers (enforced by tools/mobile.js)
//
// Fail-closed: empty allowed_packages means NOTHING is authorized. install/shell/frida target
// the package; static targets the APK hash (skipped when the allowlist is empty).
const fs = require('fs');
const path = require('path');
const net = require('net');

function loadMobileScope(scopePath) {
  // MOBILE_SCOPE_JSON env override: lets tests point at another file.
  const p = scopePath || process.env.MOBILE_SCOPE_JSON || path.join(__dirname, '..', 'mobile-scope.json');
  let raw;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch (e) {
    // Fail-closed with an explicit reason so the operator sees WHICH precondition failed.
    const err = new Error(`mobile-scope.json unreadable at ${p}: ${e.message}`);
    err.code = 'MOBILE_SCOPE_UNREADABLE';
    throw err;
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    // Explicit JSON parse error: without this, a syntax typo silently blocks the WHOLE
    // mobile mode as a generic load-failure. Surface the parse message + path.
    const err = new Error(`mobile-scope.json is not valid JSON: ${e.message} (at ${p})`);
    err.code = 'MOBILE_SCOPE_INVALID_JSON';
    throw err;
  }
}

const PKG_RE = /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/;
const SHA_RE = /^[0-9a-fA-F]{64}$/;

function isPackage(s) {
  const t = String(s == null ? '' : s).trim();
  return t.length <= 255 && PKG_RE.test(t);
}

function isSha256(s) {
  return SHA_RE.test(String(s == null ? '' : s).trim());
}

// A serial is in the right shape if it looks like <host>:<port> or a known adb token
// (emulator-XXXX). Loopback check is enforced separately in serialInScope().
function parseSerial(s) {
  const t = String(s == null ? '' : s).trim();
  if (/^(emulator-\d+)$/.test(t)) return { host: null, local: true, token: t };
  const m = t.match(/^(.*?):(\d{1,5})$/);
  if (m) return { host: m[1].replace(/^\[|\]$/g, ''), port: Number(m[2]), token: t };
  // USB/hardware adb serial (no host:port), e.g. "R5CT30XXXXX" or "emulator" transport ids that
  // are bare alphanumerics. Packages always contain a dot (PKG_RE) and sha256 is 64 hex, so a
  // dotless 4-24 char alphanumeric token is unambiguously a serial. Loopback cannot apply
  // (there is no host); serialInScope() gates it on exact allowlist membership.
  if (/^[A-Za-z0-9]{4,24}$/.test(t)) return { host: null, usb: true, token: t };
  return null;
}

function isLoopbackHost(h) {
  if (!h) return false;
  const t = String(h).toLowerCase();
  if (t === 'localhost') return true;
  if (net.isIP(t) === 4) {
    const [a] = t.split('.').map(Number);
    return a === 127;
  }
  return false; // hostnames other than localhost are NOT trusted (DNS could move)
}

function packageInScope(pkg, scope) {
  const t = String(pkg == null ? '' : pkg).trim();
  if (!isPackage(t)) return { ok: false, reason: 'invalid package: ' + pkg };
  const allowed = (scope && scope.allowed_packages) || [];
  return allowed.includes(t)
    ? { ok: true, reason: 'package allowlisted' }
    : { ok: false, reason: `package ${t} not in mobile-scope.json allowed_packages` };
}

function serialInScope(serial, scope) {
  const t = String(serial == null ? '' : serial).trim();
  const parsed = parseSerial(t);
  if (!parsed) return { ok: false, reason: 'invalid adb serial: ' + serial };
  if (parsed.host && !isLoopbackHost(parsed.host)) {
    return { ok: false, reason: `serial ${t} is not loopback: only local ReDroid (127.0.0.1) is allowed` };
  }
  const allowed = (scope && scope.allowed_serials) || [];
  if (!allowed.includes(t)) {
    return { ok: false, reason: `serial ${t} not in mobile-scope.json allowed_serials` };
  }
  return { ok: true, reason: parsed.usb ? 'usb/hardware serial allowlisted (authorized physical device)' : 'serial allowlisted' };
}

function apkInScope(sha256, scope) {
  const t = String(sha256 == null ? '' : sha256).trim().toLowerCase();
  if (!isSha256(t)) return { ok: false, reason: 'invalid apk sha256: ' + sha256 };
  const allowed = ((scope && scope.allowed_apk_sha256) || []).map((x) => String(x).toLowerCase());
  if (allowed.length === 0) return { ok: true, reason: 'no apk allowlist configured: package gate applies' };
  return allowed.includes(t)
    ? { ok: true, reason: 'apk sha256 allowlisted' }
    : { ok: false, reason: 'apk sha256 not in mobile-scope.json allowed_apk_sha256' };
}

// Auto-detect the target type: sha256 -> apk, serial-like -> serial, else package.
function inMobileScope(target, scope) {
  const t = String(target == null ? '' : target).trim();
  if (isSha256(t)) return Object.assign({ type: 'apk' }, apkInScope(t, scope));
  if (parseSerial(t)) return Object.assign({ type: 'serial' }, serialInScope(t, scope));
  return Object.assign({ type: 'package' }, packageInScope(t, scope));
}

function scopeEmpty(scope) {
  return !(scope && Array.isArray(scope.allowed_packages) && scope.allowed_packages.length);
}

module.exports = {
  loadMobileScope, isPackage, isSha256, parseSerial, isLoopbackHost,
  packageInScope, serialInScope, apkInScope, inMobileScope, scopeEmpty,
};

if (require.main === module) {
  const [cmd, target] = process.argv.slice(2);
  if (cmd !== 'check' || !target) {
    console.error('usage: node mobile-guard.js check <package|serial|sha256>');
    process.exit(2);
  }
  let scope;
  try {
    scope = loadMobileScope();
  } catch (e) {
    console.log(JSON.stringify({ ok: false, reason: e && e.message ? e.message : 'mobile-scope.json missing - nothing is authorized yet' }));
    process.exit(1);
  }
  if (scopeEmpty(scope)) {
    console.log(JSON.stringify({ ok: false, reason: 'mobile-scope.json empty - nothing is authorized yet' }));
    process.exit(1);
  }
  const res = inMobileScope(target, scope);
  console.log(JSON.stringify(res));
  process.exit(res.ok ? 0 : 1);
}
