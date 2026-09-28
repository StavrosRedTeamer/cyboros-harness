#!/usr/bin/env node
// test-verify-tag.js — la verifica di un tag deve provare il COMMIT, non l'albero di lavoro.
//
// Perché esiste: `tools/verify-tag.js` esiste per un errore realmente accaduto — `v0.1.0` è stato
// dichiarato verde misurandolo nell'albero di lavoro, mentre un clone pulito dello stesso tag era
// rosso (`docs/INDEX.md` indicizzava due file gitignorati presenti solo in locale). Il valore del
// tool è tutto in quella distinzione, quindi il test non verifica "esce 0": verifica che i gate
// girino DENTRO un clone del commit, che l'albero di lavoro sporco non conti, e che un tag
// realmente rotto esca 1 lasciando il clone da ispezionare.
//
// Come: un repository git di fixture (mkdtemp) con quattro stub al posto dei gate — `gate.json`
// decide gli exit code — così il test è offline, veloce e deterministico. Il controllo negativo è
// un commit SUCCESSIVO al tag che rompe uno stub: se il tool passasse anche lì, non starebbe
// verificando niente.
//
// Uso: node tools/test-verify-tag.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { ok, summary, fixture, runCli } = require('./testkit');

const TOOL = path.join(__dirname, 'verify-tag.js');
const GIT_ENV = ['-c', 'user.name=verify-tag-test', '-c', 'user.email=verify-tag-test@example.invalid', '-c', 'commit.gpgsign=false'];

function git(args, cwd) {
  const r = spawnSync('git', [...GIT_ENV, ...args], { cwd, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `git ${args.join(' ')}: ${String(r.stderr).trim()}`);
  return String(r.stdout);
}
function write(repo, rel, content) {
  const p = path.join(repo, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}
const GREEN = JSON.stringify({ invariants: 0, doctor: 0, identity: 0, test: 0 }, null, 2);
const RED = JSON.stringify({ invariants: 1, doctor: 0, identity: 0, test: 0 }, null, 2);

// Stub al posto dei quattro gate. Ognuno legge `gate.json` dal CLONE (path relativo al file) e
// stampa la propria `cwd`: è l'evidenza che l'esecuzione è avvenuta nel clone e non nel repo.
const STUBS = {
  'tools/test-repo-invariants.js': `const c = require('../gate.json');
console.log('cwd ' + process.cwd());
if (c.invariants) console.log('fixture: invarianti rotti');
console.log('repo-invariants: ' + (c.invariants ? '0 pass, 1 fail' : '1 pass, 0 fail'));
process.exit(c.invariants ? 1 : 0);
`,
  'tools/doctor.js': `const c = require('../gate.json');
console.log('cwd ' + process.cwd());
console.log('Riepilogo: fixture, mancanti=' + c.doctor);
process.exit(c.doctor ? 1 : 0);
`,
  'tools/check-identity.js': `const c = require('../gate.json');
console.log('cwd ' + process.cwd());
console.log('[identity] coerente (fixture)');
process.exit(c.identity ? 1 : 0);
`,
  'tools/run-tests.js': `const c = require('../gate.json');
console.log('cwd ' + process.cwd());
console.log('PASS=' + (c.test ? 0 : 1) + '  FAIL=' + c.test + '  SKIP(e2e)=0');
process.exit(c.test ? 1 : 0);
`,
};

// Repo di fixture: package.json (perché il gate `npm test` è reale, non uno stub) + gate.json + stub.
function makeRepo(tag, { gate = GREEN } = {}) {
  const repo = fixture('vt-repo');
  write(repo, 'package.json', JSON.stringify({
    name: 'verify-tag-fixture', version: '0.0.0', private: true,
    scripts: { test: 'node tools/run-tests.js' },
  }, null, 2) + '\n');
  write(repo, 'gate.json', gate + '\n');
  for (const [rel, src] of Object.entries(STUBS)) write(repo, rel, src);
  git(['init', '-q'], repo);
  git(['add', '-A'], repo);
  git(['commit', '-qm', 'fixture'], repo);
  if (tag) git(['tag', tag], repo);
  return repo;
}
// Le due righe sono ancorate e senza `)` finale: il titolo del tool contiene la parola "clone".
const cloneDirOf = (out) => (String(out).match(/^ {2}clone {2}(\S+)/m) || [])[1];
const keptDirOf = (out) => (String(out).match(/clone conservato: ([^\s)]+)/) || [])[1];

console.log('verify-tag — un ref è verde solo se lo è in un clone');

ok('un tag con i quattro gate verdi è verde, e il clone temporaneo non resta', () => {
  const repo = makeRepo('v-fixture-1');
  const r = runCli([TOOL, '--repo', repo, 'v-fixture-1'], { cwd: repo, timeout: 120000 });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /ref\s+v-fixture-1 → [0-9a-f]{7}/, 'deve stampare il commit risolto, non solo il nome del ref');
  assert.match(r.stdout, /4\/4 check passano/, r.stdout);
  for (const name of ['invarianti', 'doctor --check', 'check-identity', 'npm test']) {
    assert.match(r.stdout, new RegExp(`PASS ${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`), `manca il check "${name}": ${r.stdout}`);
  }
  const dir = cloneDirOf(r.stdout);
  assert.ok(dir && dir.startsWith(os.tmpdir()), `il clone non è in una cartella temporanea: ${dir}`);
  assert.ok(!fs.existsSync(dir), `il clone doveva essere rimosso dopo un esito verde: ${dir}`);
});

ok('--keep conserva il clone anche quando è verde', () => {
  const repo = makeRepo('v-fixture-1');
  const r = runCli([TOOL, '--repo', repo, 'v-fixture-1', '--keep'], { cwd: repo, timeout: 120000 });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  const dir = keptDirOf(r.stdout);
  assert.ok(dir && fs.existsSync(path.join(dir, '.git')), `clone conservato assente: ${dir}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

ok('prova il commit del tag: un albero di lavoro sporco non lo fa fallire', () => {
  const repo = makeRepo('v-fixture-1');
  // Sporca il working tree: se il tool misurasse l'albero invece del commit, questo lo farebbe
  // fallire. È esattamente l'errore per cui esiste (v0.1.0 verde in locale, rosso nel clone).
  write(repo, 'gate.json', RED + '\n');
  write(repo, 'tools/test-repo-invariants.js', 'console.log("cwd " + process.cwd()); console.log("fixture: invarianti rotti"); process.exit(1);\n');
  const dirty = spawnSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' });
  assert.ok(String(dirty.stdout).trim().length > 0, 'la fixture deve avere modifiche non committate');

  const r = runCli([TOOL, '--repo', repo, 'v-fixture-1'], { cwd: repo, timeout: 120000 });
  assert.strictEqual(r.status, 0, 'il tag committato è verde: l\'albero sporco non deve contare\n' + r.stdout + r.stderr);

  // Controllo negativo: la STESSA rottura, committata e taggata, deve uscire 1 — altrimenti il
  // test sopra passerebbe anche con un tool che non esegue niente.
  git(['add', '-A'], repo);
  git(['commit', '-qm', 'rompe gli invarianti'], repo);
  git(['tag', 'v-fixture-2'], repo);
  const bad = runCli([TOOL, '--repo', repo, '--ref', 'v-fixture-2'], { cwd: repo, timeout: 120000 });
  assert.strictEqual(bad.status, 1, `un tag rosso deve uscire 1\n${bad.stdout}${bad.stderr}`);
  assert.match(bad.stderr, /v-fixture-2 NON è verde/, bad.stderr);
  assert.match(bad.stdout, /FAIL invarianti/, bad.stdout);
  // Il valore diagnostico: l'output del gate che fallisce E la prova che girasse nel clone.
  assert.match(bad.stdout, /fixture: invarianti rotti/, 'deve stampare l\'output del gate fallito');
  const cwd = (bad.stdout.match(/cwd (\S+)/) || [])[1];
  assert.ok(cwd && cwd.startsWith(os.tmpdir()) && cwd !== repo, `il gate deve girare nel clone, non in ${repo}: ${cwd}`);
  const dir = keptDirOf(bad.stderr);
  assert.ok(dir && fs.existsSync(dir), `su FAIL il clone deve restare per la diagnosi: ${dir}`);
  assert.ok(fs.existsSync(path.join(dir, 'gate.json')), 'il clone conservato deve contenere l\'albero del tag');
  fs.rmSync(dir, { recursive: true, force: true });
});

ok('senza tag e senza ref lo dice invece di indovinare; --ref funziona come il posizionale', () => {
  const untagged = makeRepo(null);
  const r = runCli([TOOL, '--repo', untagged], { cwd: untagged });
  assert.strictEqual(r.status, 2, `nessun tag: atteso exit 2, ottenuto ${r.status}\n${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /nessun tag/, r.stderr);

  const repo = makeRepo('v-fixture-1');
  const viaFlag = runCli([TOOL, '--repo', repo, '--ref', 'v-fixture-1'], { cwd: repo, timeout: 120000 });
  assert.strictEqual(viaFlag.status, 0, viaFlag.stdout + viaFlag.stderr);
});

ok('ref inesistente, ref doppio, opzione ignota, repo non git: exit 2', () => {
  const repo = makeRepo('v-fixture-1');
  const missing = runCli([TOOL, '--repo', repo, 'non-esiste'], { cwd: repo });
  assert.strictEqual(missing.status, 2, `ref inesistente: atteso exit 2\n${missing.stdout}${missing.stderr}`);
  assert.match(missing.stderr, /non esiste/, missing.stderr);

  const two = runCli([TOOL, '--repo', repo, 'v-fixture-1', 'v-fixture-1'], { cwd: repo });
  assert.strictEqual(two.status, 2, 'due ref: atteso exit 2');
  assert.match(two.stderr, /ref in più/, two.stderr);

  const bogus = runCli([TOOL, '--repo', repo, '--boh'], { cwd: repo });
  assert.strictEqual(bogus.status, 2, 'opzione ignota: atteso exit 2');
  assert.match(bogus.stderr, /opzione sconosciuta/, bogus.stderr);

  const notGit = fixture('vt-nogit');
  const noRepo = runCli([TOOL, '--repo', notGit], { cwd: notGit });
  assert.strictEqual(noRepo.status, 2, 'cartella non git: atteso exit 2');
  assert.match(noRepo.stderr, /non è un repository git/, noRepo.stderr);
});

summary('verify-tag');
