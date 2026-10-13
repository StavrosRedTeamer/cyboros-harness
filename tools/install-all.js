#!/usr/bin/env node
// One-shot bootstrap: install everything Cyboros needs that is still missing on this device.
//
//   node tools/install-all.js          # plan -> doctor --yes (runtime+registry+extras) -> ./install-tools.sh
//   node tools/install-all.js --plan    # read-only: print what would be installed, change nothing
//   node tools/install-all.js --core    # only the core arsenal (doctor --yes), skip install-tools.sh
//
// Why a wrapper: doctor.js owns the inventory (single source of truth for WHAT is missing and
// HOW to install it) and install-tools.sh owns the extended arsenal (seclists, vendor binaries,
// frida-server, GitHub releases). The Command Center needs ONE entry point that runs both in
// order and streams the output into the job modal. The argv is fixed here — no user input is
// ever interpolated into a command, and no shell is involved.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const IS_WIN = process.platform === 'win32';
const DOCTOR = path.join(__dirname, 'doctor.js');
const EXTENDED_SH = path.join(ROOT, 'install-tools.sh');
const EXTENDED_PS1 = path.join(ROOT, 'install-tools.ps1');

const argv = process.argv.slice(2);
const PLAN_ONLY = argv.includes('--plan');
const CORE_ONLY = argv.includes('--core');

const line = (t) => process.stdout.write(t + '\n');
const head = (n, t) => { line(''); line('── ' + n + ' ' + '─'.repeat(Math.max(2, 62 - n.length - t.length)) + ' ' + t); };

function doctorJson() {
  const r = spawnSync(process.execPath, [DOCTOR, '--json'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  try { return JSON.parse(r.stdout || ''); } catch { return null; }
}

function plan() {
  const d = doctorJson();
  if (!d) { line('!! doctor --json did not return JSON — plan unavailable'); return null; }
  const s = d.summary || {};
  const rt = s.runtime_missing || [], reg = s.registry_missing || [], extra = s.extras_missing || [], ven = s.vendor_missing || [];
  head('PLAN', 'what is missing on this device');
  line('  runtime  : ' + (rt.length ? rt.map((r) => r.bin).join(', ') : '—'));
  line('  registry : ' + (reg.length ? reg.map((r) => r.bin + ' [' + r.how + ']').join(', ') : '—'));
  line('  extra    : ' + (extra.length ? extra.map((r) => r.bin + (r.pkg ? ' [' + r.pkg + ']' : ' [manual]')).join(', ') : '—'));
  line('  vendor   : ' + (ven.length ? ven.map((v) => v.what).join(', ') : '—'));
  for (const v of ven) line('             → ' + v.fix);
  const manual = extra.filter((r) => r.manual);
  if (manual.length) for (const m of manual) line('  manual   : ' + m.bin + ' → ' + m.manual);
  const total = rt.length + reg.length + extra.length + ven.length;
  line('');
  line('  missing total: ' + total);
  if (!total) line('  nothing to install — everything Cyboros needs is already present.');
  return { total, core_broken: !!s.core_broken };
}

function runStep(label, cmd, cmdArgs) {
  head(label, [cmd === process.execPath ? 'node' : path.basename(cmd)].concat(cmdArgs).join(' '));
  const r = spawnSync(cmd, cmdArgs, { cwd: ROOT, stdio: 'inherit' });
  if (r.error) { line('!! ' + label + ': ' + r.error.message); return 127; }
  const code = r.status == null ? 1 : r.status;
  line('   → ' + label + ': exit ' + code);
  return code;
}

function finalCheck() {
  const d = doctorJson();
  head('VERIFY', 'post-install doctor');
  if (!d) { line('  doctor --json unavailable'); return 1; }
  const s = d.summary || {};
  line('  registry   : ' + s.registry_present + '/' + s.registry_total + ' present');
  line('  extras     : ' + s.extras_present + ' present');
  line('  still missing: runtime=' + (s.runtime_missing || []).length + ' registry=' + (s.registry_missing || []).length +
    ' extras=' + (s.extras_missing || []).length + ' vendor=' + (s.vendor_missing || []).length);
  if ((s.registry_missing || []).length) line('  missing bins: ' + s.registry_missing.map((r) => r.bin).join(', '));
  return (s.registry_missing || []).length ? 1 : 0;
}

function main() {
  line('Cyboros — install everything missing · ' + new Date().toISOString());
  line('root: ' + ROOT);
  const p = plan();
  if (PLAN_ONLY) { line(''); line('--plan: nothing was changed.'); return 0; }
  if (p && p.core_broken) {
    line('');
    line('!! the workspace is incomplete (core files missing): fix that before installing tools.');
    return 2;
  }
  if (p && p.total === 0 && !CORE_ONLY) {
    line(''); line('nothing to do — the arsenal is complete.');
    return finalCheck();
  }

  if (IS_WIN) {
    line('');
    line('Windows: this wrapper only drives the POSIX installers. Run in PowerShell:');
    line('  cd ' + ROOT);
    line('  pwsh -File ' + path.basename(EXTENDED_PS1));
    line('  node tools/doctor.js --yes');
    return 1;
  }

  const root = (process.getuid && process.getuid() === 0);
  const su = root || spawnSync('/usr/bin/which', ['sudo'], { stdio: 'ignore' }).status === 0;
  if (!su) line('!! no sudo and not root: the apt phases will fail (go/pipx steps may still work).');

  let code = 0;
  code = runStep('CORE', process.execPath, [DOCTOR, '--yes']);

  if (!CORE_ONLY) {
    if (fs.existsSync(EXTENDED_SH)) {
      const ext = runStep('EXTENDED', 'bash', [EXTENDED_SH]);
      if (ext !== 0) code = code || ext;
    } else {
      line(''); line('install-tools.sh not found — extended arsenal skipped.');
    }
  }

  const verify = finalCheck();
  line('');
  line(code === 0 ? 'done: core installation completed without errors.' : 'done with errors: see the log above (exit ' + code + ').');
  return verify;
}

process.exit(main());
