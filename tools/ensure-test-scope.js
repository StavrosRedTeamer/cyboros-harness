#!/usr/bin/env node
// ensure-test-scope.js — make `npm test` work on a fresh clone.
//
// Why this exists: scope.json is gitignored, correctly, because it is the written
// authorization and holds the engagement's target list. But that means a fresh
// clone has no scope at all, and the scope-guard is fail-closed, so it blocks
// everything — including the loopback targets the offline tests legitimately
// need. Before this, `npm test` on a clean checkout failed on test-authn-depth
// and `doctor --check` exited 2 ("workspace incomplete"), which is correct for
// an engagement and wrong for a test run.
//
// What it does: if scope.json does not exist, write one that authorizes
// loopback and nothing else. If it does exist, do nothing at all — never touch,
// never widen, never "fix" a real authorization. Idempotent, offline, no deps.
//
// The safety property that matters: loopback-only is still fail-closed for
// everything remote. A test run cannot reach a real target even by accident, and
// an operator who forgets to replace this file has a scope that is useless
// rather than one that is dangerous.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SCOPE = process.env.SCOPE_JSON || path.join(ROOT, 'scope.json');
const EXAMPLE = path.join(ROOT, 'scope.example.json');

function main() {
  if (fs.existsSync(SCOPE)) {
    // Someone's real authorization, or one this script already wrote. Either
    // way it is not ours to touch.
    return 0;
  }
  const template = fs.existsSync(EXAMPLE) ? EXAMPLE : null;
  if (!template) {
    process.stderr.write('ensure-test-scope: scope.example.json missing — cannot provision\n');
    return 2;
  }
  fs.copyFileSync(template, SCOPE);
  // Ingagement files are 0600 by convention (doctor's section 7 checks it): a provisioned scope
  // must look like a hand-written one, or a clean clone exits `doctor --check` with "secrets
  // readable by other users" for a file this script wrote. Best-effort on non-POSIX.
  try { fs.chmodSync(SCOPE, 0o600); } catch { /* platforms without POSIX modes */ }
  process.stderr.write(
    'ensure-test-scope: wrote a loopback-only scope.json for this test run.\n' +
    '  It authorizes 127.0.0.1 and nothing else. Replace it before an engagement:\n' +
    '  scope.json IS the written authorization.\n'
  );
  return 0;
}

if (require.main === module) process.exit(main());
module.exports = { main };
