// Rotazione di `temp/`: report di default, archiviazione solo su richiesta — e mai una
// cancellazione (`workspace-gc.archive` copia e verifica sha256 prima di toccare la sorgente).
// Il test prova anche che importare il modulo NON avvia una manutenzione.
// Run: node tools/test-daily-maintenance.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { ok, summary, fixture } = require('./testkit');

const WS = fixture('daily-maint-ws');
const ARCH = fixture('daily-maint-archive');
process.env.STAVROS_ARCHIVE_DIR = ARCH;
process.env.STAVROS_TEMP_ROTATE_DAYS = '7';

// Il require avveniva DOPO il guard `require.main === module`: prima di quel guard questa riga
// avrebbe avviato una manutenzione completa (KEV + mirror + reindex) come effetto dell'import.
const dm = require('./daily-maintenance');

function makeTemp(name, ageDays) {
  const d = path.join(WS, 'temp', name);
  fs.mkdirSync(d, { recursive: true });
  const f = path.join(d, 'notes.txt');
  fs.writeFileSync(f, `payload of ${name}`);
  const t = (Date.now() - ageDays * 86400000) / 1000;
  fs.utimesSync(f, t, t);
  fs.utimesSync(d, t, t);
  return { dir: d, file: f };
}

const OLD = makeTemp('old-engagement', 30);
const FRESH = makeTemp('fresh', 0);

function archivedFiles() {
  if (!fs.existsSync(ARCH)) return [];
  return fs.readdirSync(ARCH, { recursive: true }).filter((f) => fs.statSync(path.join(ARCH, f)).isFile());
}

ok('l\'import espone main/rotateTemp: nessuna manutenzione come effetto collaterale', () => {
  assert.strictEqual(typeof dm.main, 'function');
  assert.strictEqual(typeof dm.rotateTemp, 'function');
  assert.strictEqual(dm.ROTATE_DAYS(), 7, 'la soglia viene dall\'ambiente');
  assert.deepStrictEqual(archivedFiles(), [], 'niente è stato archiviato dall\'import');
});

ok('report di default: elenca le voci stantie e non sposta nulla', () => {
  const r = dm.rotateTemp({ ws: WS });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.applied, false);
  assert.match(r.note, /report only/);
  assert.deepStrictEqual(r.candidates.map((c) => c.name), ['old-engagement'], JSON.stringify(r.candidates));
  assert.ok(fs.existsSync(OLD.file), 'sorgente intatta');
  assert.deepStrictEqual(archivedFiles(), [], 'archive vuoto');
});

ok('soglia: con 60 giorni nulla è stantio', () => {
  const r = dm.rotateTemp({ ws: WS, days: 60 });
  assert.deepStrictEqual(r.candidates, []);
});

ok('--rotate-temp: archivia la voce stantia e lascia il resto', () => {
  const r = dm.rotateTemp({ ws: WS, apply: true });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(r.archived, 1, JSON.stringify(r));
  assert.deepStrictEqual(r.failed, []);
  const moved = r.moved[0];
  assert.strictEqual(moved.name, 'old-engagement');
  assert.ok(moved.digest && /^[0-9a-f]{64}$/.test(moved.digest), 'digest sha256 dell\'albero archiviato');
  assert.strictEqual(fs.existsSync(OLD.dir), false, 'la sorgente è stata spostata, non copiata due volte');
  assert.ok(fs.existsSync(path.join(moved.to, 'notes.txt')), 'il contenuto è nell\'archivio');
  assert.strictEqual(fs.readFileSync(path.join(moved.to, 'notes.txt'), 'utf8'), 'payload of old-engagement', 'i dati sono gli stessi, non un guscio vuoto');
  assert.ok(fs.existsSync(FRESH.file), 'la voce fresca non si tocca');
});

ok('idempotente: una seconda passata non ha nulla da fare e non fallisce', () => {
  const r = dm.rotateTemp({ ws: WS, apply: true });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.archived, 0);
  assert.deepStrictEqual(r.candidates, []);
  assert.ok(fs.existsSync(FRESH.file));
});

ok('un symlink dentro temp/ non è mai candidato (spostarlo sposterebbe un altro path)', () => {
  const link = path.join(WS, 'temp', 'link-to-work');
  try { fs.symlinkSync(FRESH.dir, link, 'dir'); } catch { return; } // piattaforma senza symlink: skip
  const r = dm.rotateTemp({ ws: WS, apply: true });
  assert.ok(!r.candidates.some((c) => c.name === 'link-to-work'), JSON.stringify(r.candidates));
  assert.ok(!(r.moved || []).some((m) => m.name === 'link-to-work'));
  assert.ok(fs.existsSync(link), 'il symlink è ancora lì');
});

summary('daily-maintenance');
