#!/usr/bin/env node
// workspace-gc.js — l'unica cosa che governa il peso del workspace, e non cancella niente.
//
// Perché esiste: `temp/` è 269 MB su 19.671 file di lavoro per-engagement — APK decompilati, HTML
// di target, cache, evidenze, IP e host reali. Nessuno strumento lo governava, `doctor` non diceva
// dove fosse finito lo spazio, e l'unica alternativa rimasta era `rm -rf` a mano su materiale di
// cliente — cioè la cosa che non si deve fare. Qui ci sono due gesti: `report` (nessuna scrittura)
// e `archive` (spostamento verificato fuori dal workspace).
//
// Cosa NON fa: **non cancella**. `archive` sposta; l'originale viene rimosso solo DOPO che il
// contenuto è stato ricopiato e verificato (sha256 per file + digest dell'albero), e se la verifica
// non torna, l'operazione viene annullata e la sorgente resta intatta. Un archivio incompleto non
// deve mai costare i dati.
//
// Dove va: $STAVROS_ARCHIVE_DIR → $XDG_DATA_HOME/stavros/archive → ~/.local/share/stavros/archive
// (stesso criterio di risoluzione di tools/vendor-dir.js). La destinazione deve stare FUORI dal
// workspace: dentro finirebbe nell'albero e quindi in un commit, come `refs/` prima del 2026-09-28.
// Sotto la root, un anno per sottocartella (`<root>/<anno>/<nome>`), l'anno dell'ultima scrittura.
//
// Solo `temp/` è archiviabile. `reports/`, `artifacts/` e `state.db` sono stato che l'harness legge
// (`reports/tmp/` è usato da mcp-guard, oob, privacy, scope-guard, record-finding): spostarli
// romperebbe il codice, non alleggerirebbe il workspace.
//
//   node tools/workspace-gc.js report [--json] [--days 30] [--workspace <dir>]
//   node tools/workspace-gc.js archive <nome-in-temp> [--dry-run] [--json] [--workspace <dir>]
//   node tools/workspace-gc.js roots
//
// Exit: 0 ok; 1 I/O o verifica fallita; 2 uso errato o rifiuto di sicurezza.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const WS = path.resolve(__dirname, '..');
// Radici archiviabili. Una sola, di proposito: è l'unica che nessun modulo legge (verificato: in
// tools/ e local/ non esiste un riferimento a `temp/`, mentre `reports/tmp/` è usato da cinque
// moduli).
const ARCHIVABLE = ['temp'];
// Directory di cui `report` (e quindi `doctor`) misura l'occupazione.
const SPACE_DIRS = ['temp', 'reports', 'artifacts', 'vendor', 'refs', '.git'];
const DAY_MS = 24 * 60 * 60 * 1000;

function archiveRoot() {
  if (process.env.STAVROS_ARCHIVE_DIR) return path.resolve(process.env.STAVROS_ARCHIVE_DIR);
  const base = process.env.XDG_DATA_HOME
    ? process.env.XDG_DATA_HOME
    : path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'stavros', 'archive');
}

function human(bytes) {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = Number(bytes) || 0; let i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}

// ---- misure -------------------------------------------------------------------------------
// Percorrenza unica: byte, numero di file, mtime più recente e più vecchio.
// `bytes` è la dimensione apparente (somma di st_size), `disk` è lo spazio realmente occupato
// (st_blocks × 512, come `du`). Su 19.671 file piccoli la differenza non è un dettaglio: sono i
// blocchi parziali, decine di MB che l'apparente non mostra. Chi archivia vuole sapere il secondo.
function diskBytes(st) {
  return typeof st.blocks === 'number' && st.blocks > 0 ? st.blocks * 512 : st.size;
}
function walkSize(target) {
  const out = { bytes: 0, disk: 0, files: 0, newest: 0, oldest: 0 };
  const visit = (p, st) => {
    if (st.isDirectory()) {
      let entries; try { entries = fs.readdirSync(p, { withFileTypes: true }); } catch { return; }
      for (const e of entries) visit(path.join(p, e.name), lstat(path.join(p, e.name)));
    } else if (st.isFile()) {
      out.bytes += st.size; out.disk += diskBytes(st); out.files++;
      const t = st.mtimeMs;
      if (!out.newest || t > out.newest) out.newest = t;
      if (!out.oldest || t < out.oldest) out.oldest = t;
    }
  };
  let st; try { st = fs.lstatSync(target); } catch { return out; }
  if (!st.isDirectory() && !st.isFile()) return out;
  visit(target, st);
  return out;
}

function lstat(p) { try { return fs.lstatSync(p); } catch { return { isDirectory: () => false, isFile: () => false, size: 0, mtimeMs: 0 }; } }

function ageDays(ms) {
  if (!ms) return null;
  return Math.floor((Date.now() - ms) / DAY_MS);
}

// Digest dell'albero: sha256 di "sha256  path" per file, in ordine deterministico. È il valore che
// `archive` confronta prima e dopo lo spostamento: stesso digest = stessi byte, non "probabilmente".
function hashFile(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

function treeDigest(target) {
  const lines = [];
  let bytes = 0;
  const visit = (p, rel) => {
    const st = fs.lstatSync(p);
    if (st.isDirectory()) {
      for (const name of fs.readdirSync(p).sort()) visit(path.join(p, name), rel ? `${rel}/${name}` : name);
    } else if (st.isFile()) {
      bytes += st.size;
      lines.push(`${hashFile(p)}  ${rel}`);
    }
  };
  visit(target, '');
  return { files: lines.length, bytes, digest: crypto.createHash('sha256').update(lines.join('\n')).digest('hex') };
}

// ---- report --------------------------------------------------------------------------------
function scanWorkspace(ws, opts) {
  const days = (opts && opts.days) || 30;
  const dirs = [];
  for (const name of SPACE_DIRS) {
    const p = path.join(ws, name);
    if (!fs.existsSync(p)) continue;
    const s = walkSize(p);
    dirs.push({ name, bytes: s.bytes, disk_bytes: s.disk, files: s.files, newest: s.newest ? new Date(s.newest).toISOString() : null,
      age_days: ageDays(s.newest) });
  }
  dirs.sort((a, b) => b.disk_bytes - a.disk_bytes);

  // Candidati: le voci di primo livello di ogni radice archiviabile, con la loro età.
  const candidates = [];
  for (const rootName of ARCHIVABLE) {
    const dir = path.join(ws, rootName);
    if (!fs.existsSync(dir)) continue;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      const st = fs.lstatSync(p);
      const s = st.isDirectory() ? walkSize(p) : { bytes: st.size, disk: diskBytes(st), files: 1, newest: st.mtimeMs, oldest: st.mtimeMs };
      candidates.push({
        root: rootName, name: e.name,
        kind: st.isSymbolicLink() ? 'symlink' : (st.isDirectory() ? 'dir' : 'file'),
        bytes: s.bytes, disk_bytes: s.disk, files: s.files,
        age_days: ageDays(s.newest),
        stale: ageDays(s.newest) !== null && ageDays(s.newest) >= days,
      });
    }
  }
  candidates.sort((a, b) => b.disk_bytes - a.disk_bytes);

  const total = dirs.reduce((a, d) => a + d.disk_bytes, 0);
  const apparent = dirs.reduce((a, d) => a + d.bytes, 0);
  return { workspace: ws, archive_root: archiveRoot(), days, dirs, candidates,
    total_bytes: total, total_apparent_bytes: apparent, archivable_roots: ARCHIVABLE.slice() };
}

// ---- copy + verifica (il percorso cross-device, e il rollback) -----------------------------
// Copia ricorsiva, verifica per hash, e SOLO allora il chiamante rimuove la sorgente. Se la
// verifica non torna, la destinazione viene rimossa e la sorgente non viene toccata: l'errore deve
// costare una copia, mai i dati.
function copyVerifyTree(src, dst, expected) {
  const srcDigest = expected || treeDigest(src);
  fs.mkdirSync(dst, { recursive: true });
  const copy = (from, to) => {
    const st = fs.lstatSync(from);
    if (st.isDirectory()) {
      fs.mkdirSync(to, { recursive: true });
      for (const name of fs.readdirSync(from)) copy(path.join(from, name), path.join(to, name));
    } else if (st.isFile()) {
      fs.copyFileSync(from, to);
      fs.chmodSync(to, st.mode & 0o777);
    }
  };
  try {
    copy(src, dst);
    const dstDigest = treeDigest(dst);
    if (dstDigest.digest !== srcDigest.digest || dstDigest.files !== srcDigest.files) {
      // La destinazione è incompleta o diversa: si annulla la copia, la sorgente non si tocca.
      const e = new Error(`verifica fallita: ${dstDigest.files}/${srcDigest.files} file, digest diverso`);
      e.code = 'VERIFY'; throw e;
    }
    return { files: dstDigest.files, bytes: dstDigest.bytes, digest: dstDigest.digest };
  } catch (e) {
    try { fs.rmSync(dst, { recursive: true, force: true }); } catch { /* il chiamante riporta l'errore originale */ }
    throw e;
  }
}

// ---- archive -------------------------------------------------------------------------------
// Il nome deve essere UNA voce di temp/: niente separatori, niente `..`, niente assoluti. Un tool
// che sposta directory arbitrarie con un argomento dell'utente è un tool che sposta la cosa
// sbagliata la prima volta che qualcuno sbaglia a scrivere.
function safeName(name) {
  if (typeof name !== 'string' || !name) return 'nome mancante';
  if (name === '.' || name === '..') return `nome non valido: ${name}`;
  if (name.includes('/') || name.includes('\\') || path.isAbsolute(name)) return `il nome deve essere una voce di temp/, non un percorso: ${name}`;
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return `nome con caratteri non ammessi: ${name}`;
  return null;
}

function archive(ws, rootName, name, opts) {
  const o = opts || {};
  const bad = safeName(name);
  if (bad) { const e = new Error(bad); e.usage = true; throw e; }
  if (!ARCHIVABLE.includes(rootName)) { const e = new Error(`${rootName}/ non è una radice archiviabile (${ARCHIVABLE.join(', ')})`); e.usage = true; throw e; }

  const src = path.join(ws, rootName, name);
  const st = lstat(src);
  if (!st.isDirectory() && !st.isFile()) { const e = new Error(`non esiste (o non è un file/directory): ${src}`); e.usage = true; throw e; }
  if (st.isSymbolicLink()) { const e = new Error(`rifiutato: ${src} è un symlink, e spostarlo sposterebbe un altro path`); e.usage = true; throw e; }

  const root = archiveRoot();
  const rel = path.relative(ws, root);
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
    const e = new Error(`la destinazione è dentro il workspace (${root}): finirebbe nell'albero e in un commit — usa $STAVROS_ARCHIVE_DIR fuori dal repo`); e.usage = true; throw e;
  }

  const size = st.isDirectory() ? walkSize(src) : { bytes: st.size, disk: diskBytes(st), files: 1, newest: st.mtimeMs };
  const year = String(new Date(size.newest || Date.now()).getFullYear());
  const dst = path.join(root, year, name);
  if (fs.existsSync(dst)) { const e = new Error(`la destinazione esiste già, non sovrascrivo: ${dst}`); e.usage = true; throw e; }

  const plan = { from: src, to: dst, root, year, mode: null, files: size.files, bytes: size.bytes, disk_bytes: size.disk };
  if (o.dryRun) return { ...plan, moved: false, dry_run: true };

  // Digest PRIMA dello spostamento: è il termine di confronto, non la firma di un movimento che si
  // assume riuscito. Se non torna, l'operazione si annulla — e la sorgente è l'ultima cosa che
  // viene toccata, in ogni ramo.
  const before = treeDigest(src);
  fs.mkdirSync(path.dirname(dst), { recursive: true });

  try {
    fs.renameSync(src, dst);
    plan.mode = 'rename';
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    plan.mode = 'copy';
    copyVerifyTree(src, dst, before);
  }

  const after = treeDigest(dst);
  if (after.digest !== before.digest || after.files !== before.files) {
    if (plan.mode === 'rename') {
      try { fs.renameSync(dst, src); } catch { /* segnalato sotto: i dati sono a destinazione */ }
    } else {
      try { fs.rmSync(dst, { recursive: true, force: true }); } catch { /* idem */ }
    }
    const e = new Error(`verifica fallita dopo ${plan.mode} (${after.files}/${before.files} file): ` +
      (plan.mode === 'rename' ? `annullato, i dati sono di nuovo in ${src}` : `copia annullata, la sorgente ${src} è intatta`));
    e.code = 'VERIFY';
    throw e;
  }

  if (plan.mode === 'copy') fs.rmSync(src, { recursive: true, force: true });
  return { ...plan, moved: true, files: after.files, bytes: after.bytes, digest: after.digest, verified: `sha256 ${before.digest === after.digest ? 'uguale prima e dopo' : 'diverso'}` };
}

// ---- CLI -----------------------------------------------------------------------------------
function parseArgs(argv) {
  const o = { cmd: null, name: null, json: false, dryRun: false, days: 30, workspace: WS, help: false };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') o.json = true;
    else if (a === '--dry-run' || a === '-n') o.dryRun = true;
    else if (a === '--days') o.days = Math.max(0, parseInt(argv[++i], 10) || 30);
    else if (a === '--workspace') o.workspace = path.resolve(argv[++i] || '.');
    else if (a === '-h' || a === '--help') o.help = true;
    else rest.push(a);
  }
  o.cmd = rest[0] || 'report';
  o.name = rest[1] || null;
  return o;
}

function usage() {
  return fs.readFileSync(__filename, 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n');
}

const dim = (s) => `\x1b[2m${s}\x1b[0m`;

function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) { console.log(usage()); return 0; }

  if (o.cmd === 'roots') {
    console.log(archiveRoot());
    return 0;
  }

  if (o.cmd === 'report') {
    const r = scanWorkspace(o.workspace, { days: o.days });
    if (o.json) { console.log(JSON.stringify(r, null, 2)); return 0; }
    console.log(`\nworkspace: ${o.workspace}   (archivio: ${r.archive_root})`);
    console.log(`\n  occupazione (${human(r.total_bytes)} totali nelle directory misurate)`);
    for (const d of r.dirs) console.log(`    ${d.name.padEnd(10)} ${human(d.disk_bytes).padStart(9)}  ${String(d.files).padStart(6)} file  ultima scrittura ${d.age_days === null ? '—' : d.age_days + 'g fa'}`);
    if (r.total_bytes > r.total_apparent_bytes * 1.01) {
      console.log(dim(`    (${human(r.total_apparent_bytes)} apparenti: la differenza è lo spazio dei blocchi parziali su ${r.dirs.reduce((a, d) => a + d.files, 0)} file)`));
    }
    console.log(`\n  archiviabili (voci di primo livello in ${r.archivable_roots.map((x) => x + '/').join(', ')})`);
    if (!r.candidates.length) console.log('    (nessuna voce)');
    for (const c of r.candidates) {
      console.log(`    ${(c.root + '/' + c.name).padEnd(34)} ${human(c.disk_bytes).padStart(9)}  ${String(c.files).padStart(6)} file  ${c.age_days === null ? '—' : c.age_days + 'g'}${c.stale ? '  ← inattivo' : ''}${c.kind === 'symlink' ? '  (symlink: rifiutato)' : ''}`);
    }
    console.log(`\n  node tools/workspace-gc.js archive <nome> [--dry-run]   # sposta, non cancella; verifica con sha256\n`);
    return 0;
  }

  if (o.cmd === 'archive') {
    if (!o.name) { console.error('workspace-gc: serve il nome di una voce di temp/ (usa --help)'); return 2; }
    try {
      const r = archive(o.workspace, 'temp', o.name, { dryRun: o.dryRun });
      if (o.json) { console.log(JSON.stringify(r, null, 2)); return 0; }
      if (r.dry_run) {
        console.log(`dry-run: ${r.from} → ${r.to}  (${r.files} file, ${human(r.bytes)}) — nessuna scrittura`);
        return 0;
      }
      console.log(`archiviato: ${r.from} → ${r.to}`);
      console.log(`  ${r.mode}, ${r.files} file, ${human(r.disk_bytes)} su disco — verificato sha256 ${r.digest.slice(0, 16)}…`);
      console.log('  (la sorgente non esiste più: è uno spostamento, non una copia)');
      return 0;
    } catch (e) {
      console.error(`workspace-gc: ${e.message}`);
      return e.usage ? 2 : 1;
    }
  }

  console.error(`workspace-gc: comando sconosciuto "${o.cmd}" (report | archive <nome> | roots)`);
  return 2;
}

module.exports = { archiveRoot, scanWorkspace, archive, copyVerifyTree, treeDigest, hashFile, walkSize, human, ARCHIVABLE, SPACE_DIRS };

if (require.main === module) process.exit(main());
