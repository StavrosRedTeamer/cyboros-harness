// test-tags: offline
// cc-arsenal.js — inventory + install plan. Pure and offline: doctor is injected as a
// fixture, so nothing is detected and nothing is installed. The point of the test is that
// the module NEVER lets request input reach a command line, and that the typed confirmation
// is enforced here (the router relies on it).
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const u = require('./cc-util');
const A = require('./cc-arsenal');

let failed = 0;
function ok(label, fn) {
  try { fn(); console.log('  ok   ' + label); }
  catch (e) { failed++; console.error('  FAIL ' + label + ': ' + ((e && e.message) || e)); }
}

// A doctor document as doctor.js --json emits it (only the fields the module reads).
const DOCTOR = {
  ts: '2026-01-01T00:00:00.000Z',
  runtime: [
    { bin: 'node', installed: true, ok: true, note: 'v22.0.0' },
    { bin: 'go', installed: false, ok: false, how: 'apt:golang-go', note: 'projectdiscovery tools' },
    { bin: 'pipx', installed: true, ok: true, how: 'apt:pipx' },
  ],
  project: [{ file: 'package.json', ok: true }],
  registry: [
    { bin: 'nmap', cat: 'scan', installed: true, pkg: 'nmap' },
    { bin: 'ffuf', cat: 'scan', installed: false, pkg: 'ffuf', go: 'github.com/ffuf/ffuf/v2@latest' },
    { bin: 'coercer', cat: 'ad', installed: false, pipx: 'coercer' },
  ],
  extras: [
    { bin: 'sliver', installed: false, manual: 'curl https://sliver.sh/install | sudo bash' },
    { bin: 'tcpdump', installed: true },
  ],
  vendor: [{ path: '/opt/vendor/tools/obscura/obscura', ok: false, what: 'obscura', fix: './install-tools.sh' }],
  scope: {},
  summary: { registry_total: 3, registry_present: 1, extras_present: 1, core_broken: false },
};

const inv = A.build({ doctor: DOCTOR });

ok('build: ok + counts derived from the doctor document', () => {
  assert.strictEqual(inv.ok, true);
  assert.strictEqual(inv.counts.runtime_missing, 1, 'go is missing');
  assert.strictEqual(inv.counts.registry_missing, 2);
  assert.strictEqual(inv.counts.extras_missing, 1);
  assert.strictEqual(inv.counts.vendor_missing, 1);
  assert.strictEqual(inv.counts.missing_total, 5, '1+2+1+1');
  assert.strictEqual(inv.counts.registry_total, 3);
  assert.strictEqual(inv.counts.registry_present, 1);
});

ok('build: install method is derived per registry row (apt beats go, pipx kept)', () => {
  const by = Object.fromEntries(inv.groups.registry.map((r) => [r.bin, r]));
  assert.strictEqual(by.nmap.how, 'apt');
  assert.strictEqual(by.ffuf.how, 'apt', 'pkg wins over go when both exist');
  assert.strictEqual(by.ffuf.go, 'github.com/ffuf/ffuf/v2@latest');
  assert.strictEqual(by.coercer.how, 'pipx');
  assert.strictEqual(by.coercer.pipx, 'coercer');
});

ok('build: missing lists only contain what is absent', () => {
  assert.deepStrictEqual(inv.missing.registry.map((r) => r.bin), ['ffuf', 'coercer']);
  assert.deepStrictEqual(inv.missing.runtime.map((r) => r.bin), ['go']);
  assert.deepStrictEqual(inv.missing.extras.map((r) => r.bin), ['sliver']);
  assert.deepStrictEqual(inv.missing.vendor.map((v) => v.what), ['obscura']);
});

ok('build: manual-only tools are surfaced separately (not "installable from here")', () => {
  assert.deepStrictEqual(inv.groups.manual.map((m) => m.bin), ['sliver']);
  assert.match(inv.groups.manual[0].manual, /sliver\.sh/);
  assert.strictEqual(inv.counts.manual_missing, 1);
});

ok('build: exposes the install entry + confirm phrase the UI must use', () => {
  assert.strictEqual(inv.install.entry, A.ENTRY);
  assert.strictEqual(inv.install.confirm_phrase, A.CONFIRM_PHRASE);
  assert.strictEqual(inv.install.available, true, 'tools/install-all.js exists');
  assert.ok(fs.existsSync(path.join(u.ROOT, A.ENTRY)), 'entry resolves inside the workspace');
});

ok('build: doctor failure is reported, never thrown', () => {
  const orig = u.runToolJson;
  u.runToolJson = () => ({ ok: false, code: 1, json: null, raw: 'boom: not json' });
  let r;
  try { r = A.build(); } finally { u.runToolJson = orig; }
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /doctor --json failed/);
  assert.deepStrictEqual(r.groups.registry, []);
  assert.deepStrictEqual(r.groups.manual, []);
  assert.ok(r.install && r.install.confirm_phrase, 'install block still present');
});

ok('installSpec: fixed argv per mode, nothing else accepted', () => {
  assert.deepStrictEqual(A.installSpec('run').argv, [A.ENTRY]);
  assert.deepStrictEqual(A.installSpec('plan').argv, [A.ENTRY, '--plan']);
  assert.strictEqual(A.installSpec('run').ok, true);
  assert.strictEqual(A.installSpec('plan').ok, true);
});

ok('installSpec: request input can never become an argument', () => {
  for (const bad of [undefined, null, '', 'RUN', 'run --evil', 'run; rm -rf /', 'node -e 1', 'plan && curl x']) {
    const r = A.installSpec(bad);
    assert.strictEqual(r.ok, false, 'refused: ' + bad);
    assert.strictEqual(r.argv, undefined, 'no argv built');
  }
  const argv = A.installSpec('run').argv;
  assert.ok(argv.every((a) => a === A.ENTRY || a === '--plan'), 'argv is drawn from a closed set');
});

ok('confirmOk: exact typed phrase, trimmed; anything else refused', () => {
  assert.strictEqual(A.confirmOk('INSTALL').ok, true);
  assert.strictEqual(A.confirmOk('  INSTALL  ').ok, true, 'surrounding spaces tolerated');
  for (const bad of [undefined, null, '', 'install', 'Install', 'INSTAL', 'INSTALL NOW', 'yes']) {
    const r = A.confirmOk(bad);
    assert.strictEqual(r.ok, false, 'refused: ' + JSON.stringify(bad));
    assert.strictEqual(r.expected, A.CONFIRM_PHRASE, 'tells the client what to type');
  }
});

if (failed) { console.error('test-cc-arsenal: ' + failed + ' FAILED'); process.exit(1); }
console.log('test-cc-arsenal: ALL PASS');
