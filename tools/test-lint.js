#!/usr/bin/env node
// test-lint.js — il legame fra un `require` e il file che git conosce (zero dipendenze, offline).
//
// Perché esiste: `tools/chain-log.js` è stato richiesto da 11 file del motore ed è rimasto NON
// TRACCIATO — il worktree funzionava, un clone no. Tre suite del forum sono uscite in
// MODULE_NOT_FOUND e `master` è stato rosso per chiunque clonasse, mentre in locale tutto
// sembrava verde: nessun gate guardava il legame fra un `require` e l'indice di git, quindi il
// difetto era invisibile a chi poteva correggerlo. Qui quel legame diventa un test.
//
// Le due regole, e nient'altro:
//   1. un `require` relativo deve RISOLVERE (`spec`, `spec.js`, `spec.json`, `spec/index.js`);
//   2. il file risolto deve essere TRACCIATO — è la regola che avrebbe intercettato l'incidente,
//      perché il file esisteva su disco ma non nell'indice.
//
// Cosa questo file NON è: un linter di stile. Misurato il 2026-10-13, 96 file su 265 non portano
// `'use strict'` e molti CLI stampano su stdout per mestiere: una regola dura su quelli
// fallirebbe per preferenze, non per difetti, e un linter che rompe la build per lo stile non è
// il problema di questo repo. Resta la classe che ha già prodotto un rosso reale.
//
// Commenti, template literal e i `//`-a-fine-riga sono neutralizzati prima della scansione: al
// primo giro senza neutralizzazione i sei "require che non risolvono" erano tutti falsi positivi
// — documentazione (`testkit.js` cita `./test-kit` in un commento) e fixture iniettate in un repo
// temporaneo (`test-verify-tag.js` scrive `require('../gate.json')` in uno stub). Un gate che
// grida su un commento viene disattivato al secondo giorno, quindi si scansiona il codice.
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { execFileSync } = require('child_process');
const { ok, summary } = require('./testkit');

const WS = path.resolve(__dirname, '..');

// Le copie di terze parti (`tools/gui/vendor/*.js`) sono gitignored per scelta e possono
// richiedersi fra loro: lì il legame col tracciato non è un contratto. Nessun require del repo
// oggi punta lì (misurato), ma il caso legittimo non deve diventare un falso positivo.
const SKIP_DIRS = new Set(['vendor', 'node_modules']);

function walkJs(dir, acc) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walkJs(p, acc); continue; }
    if (e.name.endsWith('.js')) acc.push(path.relative(WS, p).split(path.sep).join('/'));
  }
  return acc;
}

// `spec` → i candidati che Node proverebbe, nell'ordine in cui li proverebbe.
const candidates = (base) => [base, `${base}.js`, `${base}.json`, path.join(base, 'index.js')];

function stripNoise(src) {
  let s = src.replace(/`(?:\\.|[^`\\])*`/g, '``');        // template literal (fixture, comandi, esempi)
  s = s.replace(/\/\*[\s\S]*?\*\//g, '');                 // blocchi /* ... */
  s = s.replace(/(^|[^:])\/\/[^\n]*/gm, '$1');            // // fino a fine riga, senza toccare `://`
  return s;
}

const files = walkJs(path.join(WS, 'tools'), []);

function relativeRequires() {
  const out = [];
  for (const f of files) {
    const code = stripNoise(fs.readFileSync(path.join(WS, f), 'utf8'));
    for (const m of code.matchAll(/require\(\s*(['"])([^'"]+)\1\s*\)/g)) {
      const spec = m[2];
      if (!spec.startsWith('.')) continue;               // builtin e pacchetti non hanno un file da provare
      out.push({ from: f, spec, base: path.resolve(path.dirname(path.join(WS, f)), spec) });
    }
  }
  return out;
}

const requires = relativeRequires();

function trackedSet() {
  try {
    return new Set(execFileSync('git', ['ls-files'], { cwd: WS, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
      .split('\n').filter(Boolean));
  } catch { return null; }
}
const TRACKED = trackedSet();

console.log('lint — require del motore vs realtà del repo');

// Il gate non deve poter passare a vuoto: se la scansione non trova nulla, il verde è una bugia.
ok('la scansione non è a vuoto (un gate che non guarda non è un gate)', () => {
  assert.ok(files.length >= 200, `scansionati ${files.length} file in tools/: attesi >= 200`);
  assert.ok(requires.length >= 100, `trovati ${requires.length} require relativi: attesi >= 100`);
});

ok('ogni require relativo risolve a un file esistente', () => {
  const dead = requires
    .filter((r) => !candidates(r.base).some((p) => fs.existsSync(p)))
    .map((r) => `${r.from} -> ${r.spec}`);
  assert.deepStrictEqual(dead, [],
    'require verso file inesistenti (il modulo non c\'è, o il path è sbagliato): ' +
    dead.slice(0, 8).join(', '));
});

ok('ogni require relativo risolto punta a un file TRACCIATO', () => {
  if (!TRACKED) { console.log('    SKIP git non disponibile: legame con l\'indice non verificabile qui'); return; }
  const untracked = [];
  for (const r of requires) {
    const hit = candidates(r.base).find((p) => fs.existsSync(p));
    if (!hit) continue;                                   // già coperto dalla regola precedente
    const rel = path.relative(WS, hit).split(path.sep).join('/');
    if (SKIP_DIRS.has(rel.split('/').slice(-2, -1)[0])) continue;
    if (!TRACKED.has(rel)) untracked.push(`${r.from} -> ${r.spec} (${rel})`);
  }
  assert.deepStrictEqual(untracked, [],
    'questi require funzionano in locale e falliscono in un clone: committa il file o togli il require — ' +
    untracked.slice(0, 8).join(', '));
});

summary('lint');
