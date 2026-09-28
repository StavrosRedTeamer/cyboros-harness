#!/usr/bin/env node
// tools/docs-index.js — indice della documentazione GENERATO dal contenuto reale.
//
// Perché esiste: la superficie viva (root, `docs/`, `ops/`) e i piani si sono mescolati —
// un piano d'implementazione finiva accanto a un documento di riferimento senza che nulla
// dicesse quale dei due fosse ancora vivo — e nessun indice teneva il conto. Un indice
// scritto a mano deriva al primo file aggiunto o spostato; questo lo rigenera dai file veri,
// e `--check` (invariante in `tools/test-repo-invariants.js`) fallisce se è rimasto indietro.
//
// Cosa legge, non cosa gli si dice: titolo dalla prima intestazione, descrizione dal primo
// paragrafo, dimensione reale, e per i piani l'avanzamento delle checkbox (`- [x]` / `- [ ]`)
// calcolato dal file. L'esito di un piano NON si deduce dalle checkbox: misurato il
// 2026-09-28, il piano di radar ha 26 checkbox aperte su 26 e i tre tool `radar-*.js` sono
// già atterrati. Per questo l'archivio si fa su prove di atterraggio (una voce di CHANGELOG,
// l'artefatto che esiste), non su una spunta.
//
// Uso:
//   node tools/docs-index.js            # (ri)scrive docs/INDEX.md
//   node tools/docs-index.js --check    # non scrive: exit 1 se l'indice non è aggiornato
'use strict';
const fs = require('fs');
const path = require('path');

const WS = path.resolve(__dirname, '..');
const OUT = path.join(WS, 'docs', 'INDEX.md');
const ARCHIVE_DIR = path.join(WS, 'docs', 'archive');

const kb = (n) => (n / 1024).toFixed(1).replace('.', ',') + ' KB';
const read = (p) => fs.readFileSync(p, 'utf8');
const rel = (p) => path.relative(WS, p).split(path.sep).join('/');

function listing(dir, filter) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => filter(f))
    .sort()
    .map((f) => path.join(dir, f));
}

function titleOf(text, fallback) {
  const m = text.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : fallback;
}

// Prima riga di prosa dopo il titolo: salta intestazioni, citazioni, tabelle, codice e liste.
// Molti documenti aprono con un paragrafo in grassetto che prosegue su una riga che comincia
// in minuscolo: prendere quella riga da sola dà un estratto che parte a metà frase, quindi se
// il candidato è una continuazione si usa la riga di grassetto che lo precede.
function blurbOf(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^#\s+/.test(l));
  let candidate = '';
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i].trim();
    if (!l) continue;
    if (/^[#>|`\-\d]/.test(l)) continue;
    const plain = l.replace(/\*\*/g, '');
    if (/^[a-z\u00e0-\u00ff]/.test(plain) && candidate) return (candidate + ' ' + plain).replace(/\s+/g, ' ').slice(0, 150);
    if (/^[a-z\u00e0-\u00ff]/.test(plain)) continue;      // continuazione senza apertura: scarta
    candidate = plain;
    return plain.replace(/\s+/g, ' ').slice(0, 150);
  }
  return '';
}

// L'avanzamento delle checkbox ha senso solo per i piani: su un documento di riferimento è rumore.
const isPlan = (p) => /superpowers\/(plans|specs)\//.test(rel(p)) || p.startsWith(ARCHIVE_DIR);

function progressOf(text) {
  const done = (text.match(/^[ \t]*-[ \t]*\[x\]/gim) || []).length;
  const open = (text.match(/^[ \t]*-[ \t]*\[[ \t]*\]/gim) || []).length;
  return done + open ? `${done}/${done + open} check` : '';
}

function entry(file) {
  const text = read(file);
  const size = fs.statSync(file).size;
  const bits = [blurbOf(text), kb(size), isPlan(file) ? progressOf(text) : ''].filter(Boolean);
  return `- [**${titleOf(text, path.basename(file))}**](${rel(file)}) — ${bits.join(' · ')}`;
}

// Il "perché" di un file archiviato sta nell'archivio, non nell'indice: l'indice lo cita.
function archiveReasons() {
  const f = path.join(ARCHIVE_DIR, 'README.md');
  const map = new Map();
  if (!fs.existsSync(f)) return map;
  for (const line of read(f).split('\n')) {
    const m = line.match(/^\|\s*`([^`]+)`\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|/);
    if (m) map.set(m[1], `${m[2]} — ${m[3]}`);
  }
  return map;
}

function render() {
  const root = listing(WS, (f) => f.endsWith('.md')).filter((p) => !/\/docs\/|\/ops\//.test(p) && !p.includes(path.sep + 'docs' + path.sep));
  const docs = listing(path.join(WS, 'docs'), (f) => f.endsWith('.md') && f !== 'INDEX.md').filter((p) => !p.startsWith(ARCHIVE_DIR));
  const ops = listing(path.join(WS, 'ops'), (f) => f.endsWith('.md'));
  const plans = listing(path.join(WS, 'docs', 'superpowers', 'plans'), (f) => f.endsWith('.md'));
  const specs = listing(path.join(WS, 'docs', 'superpowers', 'specs'), (f) => f.endsWith('.md'));
  const archived = [];
  if (fs.existsSync(ARCHIVE_DIR)) {
    for (const f of listing(ARCHIVE_DIR, () => true)) {
      if (fs.statSync(f).isDirectory()) {
        for (const g of listing(f, (x) => x.endsWith('.md'))) archived.push(g);
      } else if (f.endsWith('.md') && path.basename(f) !== 'README.md') archived.push(f);
      else if (path.basename(f) !== 'README.md') archived.push(f);
    }
  }
  const reasons = archiveReasons();
  const L = [];
  L.push('# Indice della documentazione');
  L.push('');
  L.push('> **Generato** da `node tools/docs-index.js` leggendo i file reali (titolo, primo paragrafo,');
  L.push('> dimensione, avanzamento delle checkbox dei piani). Non si modifica a mano: rigeneralo.');
  L.push('> `tools/test-repo-invariants.js` fallisce se è rimasto indietro rispetto ai file.');
  L.push('');
  L.push(`**Superficie viva:** ${root.length + docs.length + ops.length} documenti · ` +
    `**piani:** ${plans.length + specs.length} · **archivio:** ${archived.length} file superati.`);
  L.push('');
  L.push('## Root del repo');
  L.push('');
  L.push(root.map(entry).join('\n') || '_(nessuno)_');
  L.push('');
  L.push('## `docs/` — riferimento');
  L.push('');
  L.push(docs.map(entry).join('\n') || '_(nessuno)_');
  L.push('');
  L.push('## `ops/` — regole della harness');
  L.push('');
  L.push(ops.map(entry).join('\n') || '_(nessuno)_');
  L.push('');
  L.push('## Piani');
  L.push('');
  L.push([...plans, ...specs].map(entry).join('\n') || '_(nessuno)_');
  L.push('');
  L.push('## Archivio — piani superati');
  L.push('');
  L.push('Stanno in `docs/archive/`, fuori dalla superficie viva, con il motivo in');
  L.push('[`docs/archive/README.md`](archive/README.md). Il criterio non è una checkbox spuntata');
  L.push('(nessuno le spunta) ma una prova di atterraggio: la voce di CHANGELOG o l\'artefatto che esiste.');
  L.push('');
  for (const f of archived) L.push(entry(f) + (reasons.get(path.basename(f)) ? ` — ${reasons.get(path.basename(f))}` : ''));
  if (!archived.length) L.push('_(vuoto)_');
  L.push('');
  return L.join('\n');
}

const generated = render();
if (process.argv.includes('--check')) {
  const current = fs.existsSync(OUT) ? read(OUT) : null;
  if (current === generated) { console.log('docs-index: docs/INDEX.md è aggiornato'); process.exit(0); }
  console.error('docs-index: docs/INDEX.md non è aggiornato — rigeneralo con `node tools/docs-index.js`');
  process.exit(1);
}
fs.writeFileSync(OUT, generated);
console.log(`docs-index: scritto ${rel(OUT)} (${generated.split('\n').length} righe, ${kb(Buffer.byteLength(generated))})`);
