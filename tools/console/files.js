// Console — file primitives shared by the console modules (zero-dep).
//
// Why it exists: every read model needs the same tolerant JSON/JSONL reads, and
// the one atomic write carries a policy the rest of the harness depends on — an
// engagement file rewritten by the server must not become more permissive than the
// one an operator created by hand (0600). Owning both here keeps that policy in a
// single place instead of repeating it in each writer.
'use strict';
const fs = require('fs');
const path = require('path');

// L'autorizzazione e i segreti restano leggibili solo dall'operatore (0600), come i file di
// engagement creati a mano: un file riscritto dal servizio non deve diventare più permissivo.
const PRIVATE_FILES = ['scope.json', 'wifi-scope.json', 'mobile-scope.json', 'auth.json', 'c2.json'];

function readJsonFile(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function readJsonl(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n')
      .map((l) => l.trim()).filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

function fileMtime(file) {
  try { return fs.statSync(file).mtime.toISOString(); } catch { return null; }
}

// tmp + rename: a reader never sees half a file, even if the process dies mid-write.
function atomicWrite(file, data) {
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
  const lf = file.split(path.sep).pop();
  if (PRIVATE_FILES.includes(lf)) {
    try { fs.chmodSync(file, 0o600); } catch { /* piattaforme senza permessi POSIX */ }
  }
}

module.exports = { readJsonFile, readJsonl, fileMtime, atomicWrite };
