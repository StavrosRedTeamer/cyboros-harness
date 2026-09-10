#!/usr/bin/env node
// Single helper for the external vendor root (heavy binaries live OUTSIDE the repo).
// Zero dependencies. Resolution order: $STAVROS_VENDOR_DIR → ~/.local/share/stavros/vendor
// (XDG) → workspace vendor/ (legacy fallback). The external root mirrors the workspace layout:
// <root>/tools/<name>/, <root>/mirror/, <root>/poc-archive/.
//
//   node tools/vendor-dir.js            # prints the resolved vendor root
//   require('./vendor-dir')             # { vendorRoot, resolveVendor }
const fs = require('fs');
const os = require('os');
const path = require('path');

function vendorRoot() {
  if (process.env.STAVROS_VENDOR_DIR) return path.resolve(process.env.STAVROS_VENDOR_DIR);
  const base = process.env.XDG_DATA_HOME
    ? process.env.XDG_DATA_HOME
    : path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'stavros', 'vendor');
}

// Resolve <rel> (relative to the vendor root, e.g. 'tools/obscura/obscura') against the
// external root first, then the legacy workspace vendor/. Returns the absolute path or null.
// opts.noLegacy skips the workspace fallback (callers that want env > external only).
function resolveVendor(rel, opts) {
  const relPath = String(rel || '').replace(/^[/\\]+/, '');
  if (!relPath) return null;
  const ext = path.join(vendorRoot(), relPath);
  try { if (fs.existsSync(ext)) return ext; } catch {}
  if (!(opts && opts.noLegacy)) {
    const legacy = path.join(__dirname, '..', 'vendor', relPath);
    try { if (fs.existsSync(legacy)) return legacy; } catch {}
  }
  return null;
}

module.exports = { vendorRoot, resolveVendor };

if (require.main === module) {
  console.log(vendorRoot());
}