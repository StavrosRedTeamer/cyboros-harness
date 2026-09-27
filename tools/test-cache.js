#!/usr/bin/env node
// Self-check for run.js read-only cache ON-BY-DEFAULT. Hermetic: fixture registry + scope,
// temp CACHE_DIR, `echo` as a harmless read_only stand-in. No network.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const RUN = path.join(ROOT, 'tools', 'run.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cache-test-'));
const scopeFile = path.join(tmp, 'scope.json');
const regFile = path.join(tmp, 'registry.json');
const cacheDir = path.join(tmp, 'cache');
fs.writeFileSync(scopeFile, JSON.stringify({
  allowed_hosts: [], allowed_url_prefixes: [], allowed_ips: ['127.0.0.1'], max_requests_per_second: 100,
}));
fs.writeFileSync(regFile, JSON.stringify({
  echo:   { args_schema: '<x>', risk_tier: 'read',   timeout_ms: 5000, rate_class: 'normal', alternative: null, read_only: true },
  nuclei: { args_schema: '-u <url>', risk_tier: 'active', timeout_ms: 5000, rate_class: 'normal', alternative: null, read_only: false },
}));

function invoke(args) {
  return spawnSync(process.execPath, [RUN, '--registry', regFile, ...args], {
    cwd: ROOT, encoding: 'utf8', timeout: 15000,
    env: Object.assign({}, process.env, { SCOPE_JSON: scopeFile, CACHE_DIR: cacheDir }),
  });
}

// 1) read_only bin: FIRST run is a miss (no cache-hit), SECOND run is a hit — WITHOUT --cache-ttl.
const a1 = invoke(['echo', '127.0.0.1']);
assert.strictEqual(a1.status, 0, 'first echo run ok: ' + a1.stderr);
assert.ok(!/cache-hit/.test(a1.stderr), 'first run is not a hit');
const a2 = invoke(['echo', '127.0.0.1']);
assert.ok(/\[cache-hit\]/.test(a2.stderr), 'second identical read_only run served from cache by default');

// 2) --no-cache disables the default (fresh dir -> no hit even on repeat).
fs.rmSync(cacheDir, { recursive: true, force: true });
invoke(['--no-cache', 'echo', '127.0.0.1']);
const b2 = invoke(['--no-cache', 'echo', '127.0.0.1']);
assert.ok(!/cache-hit/.test(b2.stderr), '--no-cache: never a hit');

// 3) active scanner is NEVER cached by default (nuclei is read_only:false; also on the scanner denylist).
fs.rmSync(cacheDir, { recursive: true, force: true });
invoke(['nuclei', '127.0.0.1']);            // may exit non-zero (nuclei absent) — we only assert no caching
const c2 = invoke(['nuclei', '127.0.0.1']);
assert.ok(!/cache-hit/.test(c2.stderr), 'scanner never cached by default');

fs.rmSync(tmp, { recursive: true, force: true });
console.log('cache: all tests passed');
