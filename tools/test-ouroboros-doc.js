#!/usr/bin/env node
// test-tags: offline
// docs/OUROBOROS.md sostiene che il claim "autoevolvente" è vero perché ogni sua affermazione
// punta a un artefatto del repo. Un test che non lo verifica lascerebbe il documento libero di
// raccontare capacità che nessuno ha: lo stesso peccato che record-finding.js rifiuta nei finding,
// applicato alla comunicazione.
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { ok, summary } = require('./testkit');

const ROOT = path.join(__dirname, '..');
const DOC = path.join(ROOT, 'docs', 'OUROBOROS.md');

ok('ogni artefatto citato dalla pagina esiste davvero', () => {
  const doc = fs.readFileSync(DOC, 'utf8');
  const missing = [];
  let claimed = 0;
  for (const line of doc.split('\n')) {
    if (!line.trim().startsWith('|')) continue;
    for (const m of line.matchAll(/`([^`]+)`/g)) {
      const p = m[1].trim().replace(/\/$/, '');
      // Solo percorsi: niente prosa fra backtick, niente nomi di flag o moduli senza cartella.
      if (!/^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.*-]+)+$/.test(p)) continue;
      claimed++;
      if (!fs.existsSync(path.join(ROOT, p))) missing.push(p);
    }
  }
  assert.ok(claimed >= 6,
    `la pagina nomina ${claimed} artefatti: la tabella dei claim si è svuotata`);
  assert.deepStrictEqual(missing, [],
    'claim senza artefatto (o percorso sbagliato): ' + missing.join(', '));
});

ok('il ciclo è dichiarato nei suoi passi', () => {
  const doc = fs.readFileSync(DOC, 'utf8');
  for (const step of ['lezione', 'ipotesi', 'run', 'misura']) {
    assert.ok(new RegExp(step, 'i').test(doc), `il ciclo non nomina il passo "${step}"`);
  }
});

summary('test-ouroboros-doc');
