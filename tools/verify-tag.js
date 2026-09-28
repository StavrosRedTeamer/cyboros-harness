#!/usr/bin/env node
// tools/verify-tag.js — un ref è verde solo se lo è in un CLONE, non nel tuo albero di lavoro.
//
// Perché esiste: il 2026-09-28 `v0.1.0` è stato dichiarato verde sulla base dell'albero di lavoro,
// dove `docs/INDEX.md` combaciava con i file di QUEL checkout. Un clone pulito dello stesso tag
// falliva l'invariante `docs/INDEX.md è aggiornato`, perché il generatore indicizzava anche due
// documenti gitignorati che esistono solo in locale. Il gate era stato eseguito in un posto dove
// non sarebbe mai girato: da qui la regola — la verifica di un tag si fa dove il tag verrà letto,
// cioè in un clone di quel ref. Questo tool lo fa in una mkdtemp ed è l'unica prova che "verde al
// tag" sia una misura invece di una convinzione.
//
// Cosa esegue nel clone (gli stessi quattro gate della checklist di release, tutti offline):
//   node tools/test-repo-invariants.js   numeri dichiarati vs realtà, indice, flotta, leak
//   node tools/doctor.js --check         dipendenze e binari
//   node tools/check-identity.js         identità/contratto cablati nel prompt
//   npm test                             la suite intera (pretest incluso)
// I check girano TUTTI anche se il primo fallisce: a un rilascio serve il quadro completo.
//
// Uso:
//   node tools/verify-tag.js                          # l'ultimo tag (git describe --tags --abbrev=0)
//   node tools/verify-tag.js v0.1.0                   # un ref esplicito (tag o branch)
//   node tools/verify-tag.js --remote                 # clona da origin invece che dal repo locale
//   node tools/verify-tag.js --repo <path> --ref <r>  # un altro checkout (fixture, un secondo clone)
//   node tools/verify-tag.js --keep                   # non cancellare il clone (utile per ispezionarlo)
//   node tools/verify-tag.js --timeout 600000         # timeout per singolo check (default 600s)
//
// Exit: 0 = tutti i check passano NEL CLONE; 1 = almeno uno fallisce (il clone resta su disco e il
// suo path è stampato: è lì che si diagnostica); 2 = errore d'uso (ref inesistente, git assente,
// clone impossibile). Zero dipendenze, nessuna rete se non con --remote.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';

// ---- CLI ---------------------------------------------------------------------
function parseArgs(argv) {
  const o = { repo: path.resolve(__dirname, '..'), ref: null, remote: false, keep: false, timeout: 600000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--repo') o.repo = path.resolve(argv[++i] || '');
    else if (a === '--ref') o.ref = argv[++i];
    else if (a === '--remote') o.remote = true;
    else if (a === '--keep') o.keep = true;
    else if (a === '--timeout') o.timeout = Math.max(1000, parseInt(argv[++i], 10) || o.timeout);
    else if (a === '-h' || a === '--help') { o.help = true; }
    else if (a.startsWith('-')) { console.error(`verify-tag: opzione sconosciuta "${a}" (usa --help)`); process.exit(2); }
    else if (o.ref === null) o.ref = a;
    else { console.error(`verify-tag: ref in più ("${a}") — se ne accetta uno`); process.exit(2); }
  }
  return o;
}

function git(args, cwd, timeout) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', timeout: timeout || 60000, maxBuffer: 64 * 1024 * 1024 });
}
const short = (sha) => String(sha || '').slice(0, 7).trim();

// ---- i quattro gate della checklist di release --------------------------------
// `summary` estrae la riga che conta dall'output del gate: un exit code dice pass/fail, non quanto.
const CHECKS = [
  {
    name: 'invarianti',
    argv: [process.execPath, 'tools/test-repo-invariants.js'],
    summary: (out) => (/repo-invariants: (\d+) pass, (\d+) fail/.exec(out) || [])[0] || '',
  },
  {
    name: 'doctor --check',
    argv: [process.execPath, 'tools/doctor.js', '--check'],
    summary: (out) => (/Riepilogo: (.+)$/m.exec(out) || [])[1] || '',
  },
  {
    name: 'check-identity',
    argv: [process.execPath, 'tools/check-identity.js'],
    summary: (out) => (/\n(\[identity\] coerente[^\n]*)/.exec(out) || [])[1] || (/\[identity\] OK/.test(out) ? 'contratto cablato' : ''),
  },
  {
    name: 'npm test',
    argv: [NPM, 'test'],
    scrubNpm: true,
    summary: (out) => (/PASS=(\d+)\s+FAIL=(\d+)\s+SKIP\(e2e\)=(\d+)/.exec(out) || [])[0] || '',
  },
];

// `npm_config_*`/`npm_lifecycle_*`/`npm_package_*` ereditati da un npm genitore fanno risolvere a
// `npm test` qui il package SBAGLIATO (prefisso, workspace, cache del chiamante). Il tool deve dare
// lo stesso esito lanciato da una shell o dall'interno della suite (`npm test` → run-tests.js → qui).
function cleanEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^npm_/i.test(k)) env[k] = v;
  return env;
}

function runChecks(dir, timeout) {
  const results = [];
  for (const c of CHECKS) {
    const t0 = Date.now();
    const r = spawnSync(c.argv[0], c.argv.slice(1), {
      cwd: dir, encoding: 'utf8', timeout, maxBuffer: 64 * 1024 * 1024,
      env: c.scrubNpm ? cleanEnv() : process.env,
    });
    const out = String(r.stdout || '') + String(r.stderr || '');
    const status = r.error && r.error.code === 'ETIMEDOUT' ? 'timeout' : r.status;
    results.push({ name: c.name, ok: status === 0, status, ms: Date.now() - t0, out, summary: c.summary(out) || `exit ${status}` });
  }
  return results;
}

// ---- main ---------------------------------------------------------------------
function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) {
    console.log(fs.readFileSync(__filename, 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'));
    return 0;
  }
  if (!fs.existsSync(path.join(o.repo, '.git'))) {
    console.error(`verify-tag: ${o.repo} non è un repository git`); return 2;
  }

  let ref = o.ref;
  if (!ref) {
    const d = git(['describe', '--tags', '--abbrev=0'], o.repo);
    if (d.status !== 0 || !String(d.stdout).trim()) {
      console.error('verify-tag: nessun tag nel repo: passa un ref esplicito (node tools/verify-tag.js <ref>)');
      return 2;
    }
    ref = String(d.stdout).trim();
  }
  const want = git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], o.repo);
  if (want.status !== 0 || !String(want.stdout).trim()) {
    console.error(`verify-tag: "${ref}" non esiste in ${o.repo} (o non è un commit)`); return 2;
  }
  const sha = String(want.stdout).trim();

  let src = o.repo;
  if (o.remote) {
    const url = git(['remote', 'get-url', 'origin'], o.repo);
    if (url.status !== 0 || !String(url.stdout).trim()) {
      console.error(`verify-tag: --remote ma nessun remote "origin" in ${o.repo}`); return 2;
    }
    src = String(url.stdout).trim();
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-tag-'));
  console.log('verify-tag — il tag è verde solo se lo è in un clone pulito\n');
  const clone = git(['-c', 'advice.detachedHead=false', 'clone', '--quiet', '--no-hardlinks', '--branch', ref, src, dir], o.repo, 300000);
  if (clone.status !== 0) {
    console.error(`verify-tag: clone di "${ref}" da ${src} fallito:\n${String(clone.stderr || '').trim()}`);
    fs.rmSync(dir, { recursive: true, force: true });
    return 2;
  }

  // Il clone deve essere ESATTAMENTE il commit richiesto: un clone che atterra altrove verifica
  // un altro albero, ed è il tipo di scarto silenzioso che questo tool esiste per intercettare.
  const head = git(['rev-parse', 'HEAD'], dir);
  const headSha = String(head.stdout).trim();
  const clean = git(['status', '--porcelain'], dir);
  console.log(`  ref    ${ref} → ${short(sha)}`);
  console.log(`  clone  ${dir} (da ${src})`);
  console.log(`  HEAD   ${short(headSha)}${headSha === sha ? '' : ` ≠ ${short(sha)}`}${String(clean.stdout).trim() ? ' · albero NON pulito' : ''}\n`);
  if (headSha !== sha) {
    console.error(`verify-tag: il clone è a ${short(headSha)}, atteso ${short(sha)}: niente da verificare (il clone resta in ${dir})`);
    return 1;
  }

  const results = runChecks(dir, o.timeout);
  for (const r of results) {
    console.log(`  ${(r.ok ? 'PASS' : 'FAIL').padEnd(4)} ${r.name.padEnd(16)} ${r.summary.padEnd(46)} ${String(r.ms).padStart(7)}ms`);
    if (!r.ok) {
      console.log(String(r.out).split('\n').filter(Boolean).slice(-15).map((l) => `        ${l}`).join('\n'));
    }
  }

  const failed = results.filter((r) => !r.ok);
  const keep = o.keep || failed.length > 0;
  if (!keep) fs.rmSync(dir, { recursive: true, force: true });
  console.log('');
  if (failed.length) {
    console.error(`verify-tag: ${ref} NON è verde — ${results.length - failed.length}/${results.length} check passano (clone conservato: ${dir})`);
    return 1;
  }
  console.log(`verify-tag: ${ref} (${short(sha)}) verde in un clone pulito — ${results.length}/${results.length} check passano` +
    `${keep ? ` (clone conservato: ${dir})` : ''}`);
  return 0;
}

process.exit(main());
