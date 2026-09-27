#!/usr/bin/env node
// WP7+ — Arsenal inventory + install plan for the Command Center (read-only).
//
// The GUI cannot know two things on its own:
//   1. WHAT is still missing on this device, per group (runtime / registry / extras / vendor,
//      plus the manual-only tools). It is taken verbatim from `doctor --json`, the single
//      source of truth — this module never re-detects binaries itself.
//   2. A SAFE way to request the install: a FIXED argv (never assembled from request input)
//      plus a typed confirmation phrase that the router enforces server-side.
//
// CLI: node tools/cc-arsenal.js [--json]      (default --json)
'use strict';
const fs = require('fs');
const path = require('path');
const u = require('./cc-util');

const CONFIRM_PHRASE = 'INSTALL';
const ENTRY = path.join('tools', 'install-all.js');
const EXTENDED_SH = path.join('install-tools.sh');
const EXTENDED_PS1 = path.join('install-tools.ps1');
const IS_WIN = process.platform === 'win32';

// opts.doctor — an already-fetched `doctor --json` document (the router shares one
// call between /api/cc/arsenal and this inventory). Omitted → it is fetched here.
function build(opts) {
  const pre = opts && opts.doctor;
  const run = pre ? { json: pre, raw: '' } : u.runToolJson([path.join('tools', 'doctor.js'), '--json'], { timeoutMs: 120000 });
  const d = run.json;
  const install = {
    entry: ENTRY,
    confirm_phrase: CONFIRM_PHRASE,
    available: fs.existsSync(path.join(u.ROOT, ENTRY)),
    extended: fs.existsSync(path.join(u.ROOT, IS_WIN ? EXTENDED_PS1 : EXTENDED_SH)),
    windows: IS_WIN,
    note: IS_WIN
      ? 'on Windows run install-tools.ps1 once in PowerShell; this button drives the POSIX installers'
      : 'runs doctor --yes then ./install-tools.sh — apt phases need root (sudo)',
  };
  if (!d) {
    return {
      ok: false, ts: u.nowIso(), error: 'doctor --json failed: ' + (String(run.raw || '').slice(0, 200) || 'no output'),
      counts: {}, groups: { runtime: [], registry: [], extras: [], vendor: [], manual: [] },
      install,
    };
  }
  const s = d.summary || {};
  const runtime = (d.runtime || []).slice(1).map((r) => ({ bin: r.bin, installed: !!r.installed, how: r.how || null, note: r.note || null }));
  const registry = (d.registry || []).map((r) => ({
    bin: r.bin, cat: r.cat, installed: !!r.installed,
    how: r.pkg ? 'apt' : r.go ? 'go' : r.pipx ? 'pipx' : 'manual',
    pkg: r.pkg || null, go: r.go || null, pipx: r.pipx || null, note: r.note || null,
  }));
  const extras = (d.extras || []).map((r) => ({
    bin: r.bin, installed: !!r.installed,
    how: r.pkg ? 'apt' : r.manual ? 'manual' : 'unknown',
    pkg: r.pkg || null, manual: r.manual || null, note: r.note || null,
  }));
  const vendor = (d.vendor || []).map((v) => ({ what: v.what, path: v.path, installed: !!v.ok, fix: v.fix || null }));
  const manual = extras.filter((r) => !r.installed && r.manual).map((r) => ({ bin: r.bin, manual: r.manual, note: r.note }));

  const miss = (arr) => arr.filter((r) => !r.installed).length;
  return {
    ok: true,
    ts: d.ts || u.nowIso(),
    platform: process.platform,
    core_broken: !!s.core_broken,
    counts: {
      registry_total: s.registry_total != null ? s.registry_total : registry.length,
      registry_present: s.registry_present != null ? s.registry_present : registry.length - miss(registry),
      extras_present: s.extras_present != null ? s.extras_present : extras.length - miss(extras),
      runtime_missing: miss(runtime),
      registry_missing: miss(registry),
      extras_missing: miss(extras),
      vendor_missing: miss(vendor),
      manual_missing: manual.length,
      missing_total: miss(runtime) + miss(registry) + miss(extras) + miss(vendor),
    },
    groups: { runtime, registry, extras, vendor, manual },
    missing: {
      runtime: runtime.filter((r) => !r.installed),
      registry: registry.filter((r) => !r.installed),
      extras: extras.filter((r) => !r.installed),
      vendor: vendor.filter((v) => !v.installed),
    },
    install,
  };
}

// installSpec(mode) -> the ONLY argv this server will ever launch for an install.
// mode 'plan' = read-only report, mode 'run' = actually installs. No other arg is accepted.
function installSpec(mode) {
  if (mode !== 'plan' && mode !== 'run') return { ok: false, error: "mode must be 'plan' or 'run'" };
  const argv = [ENTRY];
  if (mode === 'plan') argv.push('--plan');
  return { ok: true, argv };
}

// Typed confirmation, enforced by the router (not just by the UI).
function confirmOk(confirm) {
  if (String(confirm == null ? '' : confirm).trim() !== CONFIRM_PHRASE) {
    return { ok: false, error: 'typed confirmation required', expected: CONFIRM_PHRASE };
  }
  return { ok: true };
}

module.exports = { build, installSpec, confirmOk, CONFIRM_PHRASE, ENTRY };

if (require.main === module) {
  console.log(JSON.stringify(build(), null, 2));
}
