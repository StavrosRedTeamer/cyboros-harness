#!/usr/bin/env node
// Single helper for the PATH the harness sees. Zero dependencies.
//
// Why it exists: the harness resolves binaries THROUGH PATH (doctor.js, tool-plane.js,
// run.js). A Command Center launched from a desktop tray / autostart inherits the SYSTEM
// PATH, which hides anything the operator installed in their own directories — the
// ProjectDiscovery go tools live in ~/go/bin, pipx tools (h8mail, coercer, frida) in
// ~/.local/bin, and the wireless/network tools in /usr/sbin. The visible effect is a false
// report: doctor lists installed tools as "missing", and a job dispatched from the dashboard
// dies with "not found" even though the tool runs fine in a terminal.
//
// augmentPath(env) prepends the standard dirs that actually exist, deduplicated, and keeps
// whatever it inherited (so a multi-project setup can still point at its own bin dirs).
//
//   node tools/tool-path.js            # prints the augmented PATH
//   require('./tool-path').augmentPath(process.env)   # patch an env object in place
const fs = require('fs');
const os = require('os');
const path = require('path');

// Ordered: user installs first (they shadow distro packages), then the sbin dirs.
function toolingDirs() {
  return [
    path.join(os.homedir(), '.local', 'bin'),   // pipx
    path.join(os.homedir(), 'go', 'bin'),       // go install (ProjectDiscovery, dalfox, ...)
    path.join(os.homedir(), 'bin'),
    '/usr/local/sbin',
    '/usr/sbin',                                // wireless / network tooling
    '/sbin',
  ];
}

// augmentPath(env, extraDirs) — mutates and returns env (defaults to process.env).
function augmentPath(env, extraDirs) {
  const target = env || process.env;
  const parts = String(target.PATH || '').split(path.delimiter).filter(Boolean);
  const have = new Set(parts);
  const added = [];
  for (const d of toolingDirs().concat(extraDirs || [])) {
    if (have.has(d)) continue;
    let isDir = false;
    try { isDir = fs.statSync(d).isDirectory(); } catch { /* absent: skip */ }
    if (!isDir) continue;
    have.add(d);
    added.push(d);
  }
  if (added.length) target.PATH = parts.concat(added).join(path.delimiter);
  return target;
}

// missingFrom(dir) — is this dir currently reachable? (diagnostics / tests)
function pathHas(dir) {
  return String(process.env.PATH || '').split(path.delimiter).includes(dir);
}

module.exports = { augmentPath, toolingDirs, pathHas };

if (require.main === module) {
  augmentPath(process.env);
  console.log(process.env.PATH);
}
