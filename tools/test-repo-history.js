#!/usr/bin/env node
// test-repo-history.js — il repository deve essere pulito anche DIETRO l'ultimo commit.
//
// Perché esiste: l'igiene del repo era verificata solo sull'albero e sull'indice — `git ls-files`
// nel job `hygiene` di CI, il check dei leak in test-repo-invariants. Nessuno guardava la STORIA,
// e la storia è la cosa che viene pubblicata insieme al repository. Cosa ci stava dentro, misurato
// prima di questo gate:
//
//   - il corpus `refs/` (il gap di licenza raccontato in docs/REFS-PROVENANCE.md): tolto
//     dall'indice e gitignorato, ma ancora in 131 blob / 2,3 MB nella lineage di master;
//   - un branch senza antenato comune con master (`perf/pacing-and-cache`, già su origin) con
//     ~70 MB di materiale di engagement: `esp32c5-poc/tools/bin/arduino-cli` (37 MB),
//     `evidence/noa4-synaptic/joinnoa-main.map` (22 MB), `evidence/raw/kela_succ.html` (10 MB).
//
// Nessuno dei due è visibile da `git ls-files`; entrambi sono visibili da `git log -p` su un clone
// pubblico. Questo file è il gate che impedisce di reintrodurli in silenzio: una lineage scollegata
// non arriva in master con un merge, quindi nessuna review la vede.
//
// Cosa controlla (offline, zero dipendenze, nessuna rete):
//   1. path: nessun blob di engagement, stato runtime o corpus nella storia di QUALSIASI ref;
//   2. lineage: ogni coppia di ref deve avere un antenato comune — una storia scollegata che
//      finisce in un ref è materiale che nessun merge porta in master e nessuno legge;
//   3. dimensione: nessun blob sopra HISTORY_BLOB_LIMIT. In storia un binario grosso è quasi
//      sempre materiale di engagement; la più grande blob legittima è la screenshot del README.
//
// Uso:
//   node tools/test-repo-history.js
// Exit: 0 tutto a posto; 1 almeno un problema. SKIP esplicito (exit 0) senza git o su clone
// shallow: un clone shallow non può rispondere a queste domande, e un falso OK è peggio di un
// silenzio — il job CI `history` fa il checkout completo proprio per questo.
'use strict';
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');
const { ok, summary } = require('./testkit');

const WS = path.resolve(__dirname, '..');
// 1 MiB. La più grande blob legittima nella storia è docs/assets/command-center-overview.png
// (255 KB): la soglia è tarata su un margine di 4x, non su un caso limite.
const HISTORY_BLOB_LIMIT = 1024 * 1024;

function git(args, opts) {
  const o = opts || {};
  return spawnSync('git', args, { cwd: WS, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, input: o.input });
}

// Path che non devono esistere in NESSUN commit. Allineata a due superfici già coperte altrove,
// per non duplicare le regole a mano: `.gitignore` (l'albero) e il job `hygiene` (l'indice). Qui
// si copre la terza: la storia. `scope.example.json` e gli altri `*.example.json` non matchano.
const FORBIDDEN = [
  { re: /^refs\//, why: 'corpus con gap di licenza (docs/REFS-PROVENANCE.md)' },
  { re: /^temp\//, why: 'dump di lavoro per-engagement (dati cliente)' },
  { re: /^reports\//, why: 'findings, report ed evidenze' },
  { re: /^artifacts\//, why: 'inventario di engagement' },
  { re: /^evidence\//, why: 'evidenze di engagement' },
  { re: /^esp32c5-poc\//, why: 'progetto laterale con binari e catture' },
  { re: /^vendor\//, why: 'binari vendored (vivono fuori dalla workspace)' },
  { re: /^noauth_results\//, why: 'output di engagement' },
  { re: /^local-only\//, why: 'script one-off di engagement' },
  { re: /^campaigns?\//, why: 'stato campagne (nomi clienti, contatti RoE)' },
  { re: /^(auth|scope|c2|wifi-scope|mobile-scope|mcp|campaign)\.json$/, why: 'segreto o autorizzazione' },
  { re: /\.bak\.json$/, why: 'backup di autorizzazione con target reali' },
  { re: /^freebuff-blocchi-/, why: 'dump di sessione' },
  { re: /^session-prompt-egress-/, why: 'runbook interno di una postazione' },
];

console.log('repo-history — la storia non deve contenere ciò che l\'albero non contiene');

// ---- guardia: senza git, o su un clone shallow, la domanda non ha risposta ----------------
const probe = git(['rev-parse', '--is-shallow-repository']);
if (probe.status !== 0) {
  console.log('    SKIP git non disponibile: storia non verificabile qui');
  summary('repo-history');
}
if (String(probe.stdout || '').trim() === 'true') {
  console.log('    SKIP clone shallow: un clone shallow non può rispondere su path e lineage nella');
  console.log('         storia. Il job CI `history` fa il checkout completo (fetch-depth: 0) proprio');
  console.log('         per eseguire questo gate; localmente, `git fetch --unshallow`.');
  summary('repo-history');
}

const refs = git(['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/tags', 'refs/remotes']);
if (refs.status !== 0 || !String(refs.stdout || '').trim()) {
  console.log('    SKIP nessuna ref (o for-each-ref non disponibile): niente da verificare');
  summary('repo-history');
}
const refList = String(refs.stdout).split('\n').map((s) => s.trim()).filter(Boolean);

// ---- lettura della storia (una sola passata, su tutte le ref) ------------------------------
// `git rev-list --objects --all` elenca ogni oggetto raggiungibile da ogni ref, con il path per
// i non-commit. Da qui escono sia i path sia la lista degli sha da pesare.
const objects = git(['rev-list', '--objects', '--all']);
if (objects.status !== 0) {
  console.log('    SKIP rev-list non disponibile: ' + String(objects.stderr || '').slice(0, 200));
  summary('repo-history');
}
const rows = String(objects.stdout).split('\n').filter(Boolean).map((line) => ({
  sha: line.slice(0, 40),
  path: line.length > 41 ? line.slice(41) : null,
}));

const byPath = rows.filter((r) => r.path);

// I messaggi di fallimento stanno su UNA riga: tools/testkit.js stampa solo la prima riga del
// messaggio (`report()`), quindi il dettaglio che serve per agire va messo lì.
ok('storia: nessun path di engagement, stato o corpus in nessuna ref', () => {
  const hits = [];
  for (const r of byPath) {
    for (const { re, why } of FORBIDDEN) {
      if (re.test(r.path)) { hits.push({ path: r.path, why }); break; }
    }
  }
  const seen = new Set();
  const uniq = hits.filter((h) => (seen.has(h.path) ? false : seen.add(h.path)));
  const cats = [...new Set(uniq.map((h) => h.why))];
  assert.deepStrictEqual(uniq.map((h) => h.path), [],
    `${uniq.length} path vietati nella storia [${cats.slice(0, 2).join('; ')}]: ` +
    `${uniq.slice(0, 4).map((h) => h.path).join(' | ')} — togliere un file dal working tree non lo ` +
    'toglie dalla storia, che è pubblica con il repository: serve una riscrittura (git filter-repo, ' +
    'vedi docs/LAUNCH-PLAN.md).');
});

ok('storia: ogni ref condivide una lineage (nessuna storia scollegata)', () => {
  const problems = [];
  for (let i = 0; i < refList.length; i++) {
    for (let j = i + 1; j < refList.length; j++) {
      const r = git(['merge-base', refList[i], refList[j]]);
      if (r.status === 0) continue;
      if (r.status === 1) problems.push(`${refList[i]} e ${refList[j]} non hanno antenato comune`);
      else problems.push(`${refList[i]} e ${refList[j]}: merge-base non eseguibile (${String(r.stderr || '').trim().slice(0, 80)})`);
    }
  }
  assert.deepStrictEqual(problems, [],
    `lineage scollegate: ${problems.slice(0, 4).join(' | ')} — una storia senza antenato comune con ` +
    'master non ci arriva con un merge, quindi nessuna review la vede mentre è pubblicata: se non serve, ' +
    'eliminala (`git push origin --delete <branch>`); se porta contenuto utile, riportalo come contenuto.');
});

ok(`storia: nessun blob sopra ${Math.round(HISTORY_BLOB_LIMIT / 1024 / 1024)} MiB`, () => {
  const shas = rows.map((r) => r.sha);
  if (!shas.length) return;
  const batch = git(['cat-file', '--batch-check=%(objecttype) %(objectsize) %(objectname)'], { input: shas.join('\n') + '\n' });
  assert.strictEqual(batch.status, 0, 'cat-file --batch-check: ' + String(batch.stderr || '').slice(0, 200));
  const size = new Map();
  for (const line of String(batch.stdout).split('\n')) {
    const [type, bytes, sha] = line.split(' ');
    if (type === 'blob') size.set(sha, Number(bytes));
  }
  const heavy = rows
    .filter((r) => r.path && size.has(r.sha) && size.get(r.sha) > HISTORY_BLOB_LIMIT)
    .map((r) => `${(size.get(r.sha) / 1024 / 1024).toFixed(1)} MiB ${r.path}`);
  assert.deepStrictEqual(heavy, [],
    `${heavy.length} blob sopra la soglia nella storia (un binario di engagement è quasi sempre così): ` +
    heavy.slice(0, 6).join(' | '));
});

summary('repo-history');
