#!/usr/bin/env node
// test-workspace-gc.js — il tool che archivia i dati di engagement non deve poterli perdere.
//
// Perché esiste: `tools/workspace-gc.js` sposta materiale di cliente (269 MB su 19.671 file in
// `temp/`) da un workspace a un archivio esterno. È l'unica operazione del repository che tocca
// dati non riproducibili, quindi è quella che ha più bisogno di un test che eserciti le strade
// difficili e non solo quella che funziona: le guardie di sicurezza, il rifiuto di sovrascrivere,
// il rollback della copia con verifica, e la proprietà che conta — dopo OGNI esito, rifiuto o
// errore, la sorgente è ancora intatta.
//
// Cosa copre (offline, fixture in mkdtemp, nessuna rete):
//   1. `report` misura e non scrive; le radici archiviabili sono solo quelle dichiarate;
//   2. `archive` sposta davvero: sorgente sparita, destinazione con lo stesso digest sha256
//      dell'albero di partenza (calcolato qui, non dal tool);
//   3. rifiuti: percorso invece di nome, `..`, assoluto, inesistente, radice non archiviabile,
//      destinazione già esistente, symlink, destinazione dentro il workspace — tutti con exit 2 e
//      sorgente invariata;
//   4. `--dry-run` non scrive;
//   5. il percorso cross-device (`copyVerifyTree`): copia verificata, e su sorgente illeggibile
//      fallisce annullando la destinazione e lasciando la sorgente intatta.
//
// Uso: node tools/test-workspace-gc.js
'use strict';
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { ok, summary, fixture, runCli } = require('./testkit');

const TOOL = path.join(__dirname, 'workspace-gc.js');
const GC = require('./workspace-gc');

// ---- helper indipendenti dal tool (la verifica non può usare il codice che sta verificando) ----
function walk(dir, acc, rel) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(dir, e.name);
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) walk(p, acc, r);
    else acc.push(r);
  }
  return acc;
}
function digestTree(dir) {
  const lines = walk(dir, [], '');
  return {
    files: lines.length,
    digest: crypto.createHash('sha256')
      .update(lines.map((r) => `${crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, r))).digest('hex')}  ${r}`).join('\n'))
      .digest('hex'),
  };
}
// Impronta completa (contenuto + size + mtime): è ciò che dimostra "non ha scritto niente".
function snapshot(dir) {
  const out = {};
  for (const r of walk(dir, [], '')) {
    const st = fs.statSync(path.join(dir, r));
    out[r] = `${st.size}:${st.mtimeMs}:${crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, r))).digest('hex')}`;
  }
  return out;
}
function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}
// Workspace finto: temp/ con due engagement, reports/ e artifacts/ (che NON sono archiviabili).
function makeWorkspace(tag) {
  const ws = fixture(tag);
  write(path.join(ws, 'temp', 'eng-a', 'raw', 'index.html'), 'A'.repeat(500));
  write(path.join(ws, 'temp', 'eng-a', 'notes.md'), 'note di engagement A\n');
  write(path.join(ws, 'temp', 'eng-b', 'dump.bin'), 'B'.repeat(1200));
  write(path.join(ws, 'temp', 'stale.txt'), 'x\n');
  write(path.join(ws, 'reports', 'findings.jsonl'), '{"id":"f-1"}\n');
  write(path.join(ws, 'artifacts', 'audit', 'run.jsonl'), '{}\n');
  return ws;
}
function env(archiveDir) {
  return Object.assign({}, process.env, { STAVROS_ARCHIVE_DIR: archiveDir });
}
function gc(ws, archiveDir, args) {
  return runCli([TOOL, ...args, '--workspace', ws], { env: env(archiveDir) });
}

console.log('workspace-gc — archiviazione senza cancellazione');

// ---- 1. report ---------------------------------------------------------------------------------
ok('report: misura le directory e non scrive una riga', () => {
  const ws = makeWorkspace('gc-report');
  const arch = fixture('gc-arch');
  const before = snapshot(ws);
  const r = gc(ws, arch, ['report', '--json']);
  assert.strictEqual(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);

  const temp = j.dirs.find((d) => d.name === 'temp');
  assert.ok(temp, 'report: manca temp/');
  assert.strictEqual(temp.files, 4, `temp/ ha 4 file, il report ne conta ${temp.files}`);
  assert.ok(temp.disk_bytes > 0, 'report: disk_bytes deve essere misurato');

  assert.strictEqual(JSON.stringify(j.archivable_roots), JSON.stringify(['temp']),
    'solo temp/ è archiviabile: reports/ e artifacts/ sono stato che l\'harness legge');
  const names = j.candidates.map((c) => c.name);
  assert.ok(names.includes('eng-a') && names.includes('eng-b') && names.includes('stale.txt'),
    'report: i candidati sono le voci di primo livello di temp/: ' + names.join(', '));
  // Ordinati per spazio su disco: l'ordine dei pari-merito dipende dal filesystem (blocchi),
  // quindi si verifica l'ordinamento, non chi sta in cima.
  const sizes = j.candidates.map((c) => c.disk_bytes);
  assert.deepStrictEqual(sizes, [...sizes].sort((a, b) => b - a), 'i candidati sono ordinati per spazio occupato');
  assert.strictEqual(j.archive_root, arch, 'archive_root segue STAVROS_ARCHIVE_DIR');

  assert.deepStrictEqual(snapshot(ws), before, 'report non deve scrivere: l\'albero è cambiato');
});

// ---- 2. archive end-to-end ---------------------------------------------------------------------
ok('archive: sposta, e la destinazione ha lo stesso digest della sorgente', () => {
  const ws = makeWorkspace('gc-archive');
  const arch = fixture('gc-arch');
  const srcDigest = digestTree(path.join(ws, 'temp', 'eng-a'));

  const r = gc(ws, arch, ['archive', 'eng-a', '--json']);
  assert.strictEqual(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.strictEqual(j.moved, true, 'archive: moved deve essere true');
  assert.strictEqual(j.files, srcDigest.files, 'archive: numero di file spostati');
  assert.strictEqual(j.mode, 'rename', 'stesso filesystem: rename atomico');

  assert.ok(!fs.existsSync(path.join(ws, 'temp', 'eng-a')), 'la sorgente deve essere sparita (è uno spostamento)');
  assert.ok(fs.existsSync(j.to), `destinazione assente: ${j.to}`);
  assert.strictEqual(j.to, path.join(arch, new Date().getFullYear().toString(), 'eng-a'), 'destinazione <root>/<anno>/<nome>');
  assert.deepStrictEqual(digestTree(path.join(arch, j.year, 'eng-a')), srcDigest,
    'il contenuto archiviato deve essere identico a quello di partenza');

  // il resto del workspace non è stato toccato
  assert.ok(fs.existsSync(path.join(ws, 'temp', 'eng-b')), 'archive non deve toccare le altre voci');
  assert.ok(fs.existsSync(path.join(ws, 'reports', 'findings.jsonl')), 'archive non deve toccare reports/');
});

ok('archive: --dry-run non scrive e non sposta', () => {
  const ws = makeWorkspace('gc-dry');
  const arch = fixture('gc-arch');
  const before = snapshot(ws);
  const r = gc(ws, arch, ['archive', 'eng-a', '--dry-run', '--json']);
  assert.strictEqual(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.strictEqual(j.dry_run, true, 'dry-run: il JSON deve dichiararlo');
  assert.strictEqual(j.moved, false, 'dry-run: moved deve essere false');
  assert.deepStrictEqual(snapshot(ws), before, 'dry-run: l\'albero è cambiato');
  assert.ok(!fs.existsSync(path.join(arch, j.year, 'eng-a')), 'dry-run: niente destinazione');
});

// ---- 3. rifiuti: exit 2, sorgente invariata ----------------------------------------------------
ok('archive: rifiuta percorso, .., assoluto, inesistente, radice non archiviabile', () => {
  const ws = makeWorkspace('gc-refuse');
  const arch = fixture('gc-arch');
  const before = snapshot(ws);
  const cases = [
    ['percorso invece di nome', ['../reports']],
    ['traversal', ['..']],
    ['assoluto', ['/etc']],
    ['inesistente', ['non-esiste']],
    ['radice non archiviabile', ['reports/findings.jsonl']],
    ['caratteri non ammessi', ['eng a']],
  ];
  for (const [label, args] of cases) {
    const r = gc(ws, arch, ['archive', ...args]);
    assert.strictEqual(r.status, 2, `${label}: atteso exit 2, ottenuto ${r.status} (${r.stderr.trim()})`);
  }
});

ok('archive: radici diverse da temp/ sono rifiutate dal modulo', () => {
  const ws = makeWorkspace('gc-root');
  let err = null;
  try { GC.archive(ws, 'reports', 'findings.jsonl', { dryRun: true }); } catch (e) { err = e; }
  assert.ok(err && err.usage, 'una radice non archiviabile deve essere un rifiuto (usage), non un\'eccezione generica');
  assert.ok(fs.existsSync(path.join(ws, 'reports', 'findings.jsonl')), 'la sorgente deve restare');
});

ok('archive: non sovrascrive una destinazione esistente', () => {
  const ws = makeWorkspace('gc-overwrite');
  const arch = fixture('gc-arch');
  const before = snapshot(ws);
  const dst = path.join(arch, new Date().getFullYear().toString(), 'eng-a');
  write(path.join(dst, 'occupato.txt'), 'già qui\n');

  const r = gc(ws, arch, ['archive', 'eng-a']);
  assert.strictEqual(r.status, 2, 'destinazione esistente: atteso exit 2');
  assert.match(r.stderr, /esiste già/, 'il messaggio deve dire perché: ' + r.stderr.trim());
  assert.deepStrictEqual(snapshot(ws), before, 'la sorgente deve essere intatta');
  assert.strictEqual(fs.readFileSync(path.join(dst, 'occupato.txt'), 'utf8'), 'già qui\n', 'il contenuto esistente non va toccato');
});

ok('archive: rifiuta un symlink e una destinazione dentro il workspace', () => {
  const ws = makeWorkspace('gc-symlink');
  const arch = fixture('gc-arch');
  fs.symlinkSync(path.join(ws, 'reports'), path.join(ws, 'temp', 'link-reports'));

  const link = gc(ws, arch, ['archive', 'link-reports']);
  assert.strictEqual(link.status, 2, 'un symlink non va spostato: atteso exit 2');
  assert.match(link.stderr, /symlink/, link.stderr.trim());
  assert.ok(fs.existsSync(path.join(ws, 'temp', 'link-reports')), 'il symlink deve restare dov\'era');

  // destinazione dentro il workspace = dati che finiscono nell'albero (e in un commit)
  const inside = path.join(ws, 'temp', 'archivio');
  const r = runCli([TOOL, 'archive', 'eng-a', '--workspace', ws], { env: env(inside) });
  assert.strictEqual(r.status, 2, 'destinazione interna al workspace: atteso exit 2');
  assert.match(r.stderr, /dentro il workspace/, r.stderr.trim());
  assert.ok(!fs.existsSync(inside), 'niente deve essere creato dentro il workspace');
  assert.ok(fs.existsSync(path.join(ws, 'temp', 'eng-a')), 'la sorgente deve restare');
});

// ---- 4. il percorso cross-device: copia + verifica + rollback ----------------------------------
ok('copyVerifyTree: copia verificata, sorgente intatta (il caso cross-device)', () => {
  const ws = makeWorkspace('gc-copy');
  const arch = fixture('gc-arch');
  const src = path.join(ws, 'temp', 'eng-a');
  const dst = path.join(arch, 'copia');
  const before = digestTree(src);

  const res = GC.copyVerifyTree(src, dst);
  assert.strictEqual(res.files, before.files);
  assert.deepStrictEqual(digestTree(dst), before, 'la copia deve essere identica, per hash');
  assert.ok(fs.existsSync(src), 'copyVerifyTree non rimuove mai la sorgente: lo fa il chiamante dopo la verifica');
});

ok('copyVerifyTree: verifica fallita -> destinazione annullata, sorgente intatta', () => {
  // Il caso pericoloso non è la copia che non parte: è la copia che COMPLETA e non è identica a
  // ciò da cui è partita. Con `expected` sbagliato si esercita esattamente quel ramo, in modo
  // deterministico: il contenuto copiato è diverso dal digest atteso, quindi si annulla.
  const ws = makeWorkspace('gc-verify');
  const arch = fixture('gc-arch');
  const src = path.join(ws, 'temp', 'eng-a');
  const dst = path.join(arch, 'verifica-fallita');
  const before = digestTree(src);

  let err = null;
  try { GC.copyVerifyTree(src, dst, { files: before.files, bytes: 0, digest: 'atteso-diverso' }); } catch (e) { err = e; }

  assert.ok(err, 'un digest diverso deve far fallire la copia, non passare per riuscita');
  assert.strictEqual(err.code, 'VERIFY', `atteso errore VERIFY, ottenuto: ${err && err.code}`);
  assert.ok(!fs.existsSync(dst), 'la destinazione non verificata deve essere rimossa (rollback)');
  assert.deepStrictEqual(digestTree(src), before, 'la sorgente deve essere intatta');
});

ok('copyVerifyTree: sorgente illeggibile -> nessuna destinazione, sorgente intatta', () => {
  if (process.getuid && process.getuid() === 0) {
    console.log('    SKIP in esecuzione come root: i permessi 000 non bloccano la lettura');
    return;
  }
  const ws = makeWorkspace('gc-copyfail');
  const arch = fixture('gc-arch');
  const src = path.join(ws, 'temp', 'eng-a');
  const dst = path.join(arch, 'parziale');
  const locked = path.join(src, 'notes.md');
  const before = digestTree(src);
  fs.chmodSync(locked, 0o000);

  let err = null;
  try { GC.copyVerifyTree(src, dst); } catch (e) { err = e; }
  fs.chmodSync(locked, 0o600); // sblocca prima di asserire, altrimenti il cleanup del fixture fallisce

  assert.ok(err, 'una sorgente illeggibile deve far fallire la copia, non passare a metà');
  assert.ok(!fs.existsSync(dst), 'nessuna destinazione deve restare dopo un errore in lettura');
  assert.deepStrictEqual(digestTree(src), before, 'la sorgente deve essere intatta');
});

summary('workspace-gc');
