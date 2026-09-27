#!/usr/bin/env node
// Zero-dependency OFFLINE test for tools/attack-coverage.js (P0 ATT&CK matrix).
// Stile tools/test-coverage.js: PASS/FAIL per caso, exit 1 se almeno un FAIL.
// Nessuna rete, solo stdlib; registry/findings iniettati, mai lo store reale.
//
// Run: node tools/test-attack-coverage.js
'use strict';
const assert = require('assert');
const ac = require('./attack-coverage');

const { ok, summary } = require('./testkit');

// Fixture registry: two classes share T1190; xss adds a sub-technique; authn a credential one;
// container arrives via extra_surfaces; `other` is deliberately unmapped.
const REG = {
  classes: {
    sqli: { wstg: [], attack: ['T1190'] },
    xss: { wstg: [], attack: ['T1059.007', 'T1190'] },
    authn: { wstg: [], attack: ['T1110'] },
    other: { wstg: [] },
  },
  extra_surfaces: { container: { attack: ['T1613'] } },
};
const FINDINGS = [
  { host: 'a.example', class: 'sqli', title: 'sql' },
  { host: 'a.example', technique: 'T1110', title: 'brute' },
  { host: 'b.example', class: 'xss', title: 'x' },
  { host: 'a.example', class: 'other', title: 'misc' },
];

ok('T_RE accepts parent and sub-technique, rejects tactics/junk', () => {
  assert.ok(ac.T_RE.test('T1190'));
  assert.ok(ac.T_RE.test('T1059.007'));
  assert.ok(!ac.T_RE.test('TA0001'));
  assert.ok(!ac.T_RE.test('1190'));
});

ok('plannedMap maps techniques to classes incl. extra_surfaces', () => {
  const p = ac.plannedMap(REG);
  assert.deepStrictEqual([...p.get('T1190')].sort(), ['sqli', 'xss']);
  assert.deepStrictEqual([...p.get('T1613')], ['container']);
});

ok('findingTechniques: explicit technique wins', () => {
  assert.deepStrictEqual(ac.findingTechniques({ technique: 'T1110' }, REG), ['T1110']);
  assert.deepStrictEqual(ac.findingTechniques({ technique: ' nope ' }, REG), []);
});

ok('findingTechniques: falls back to the class mapping', () => {
  assert.deepStrictEqual(ac.findingTechniques({ class: 'xss' }, REG), ['T1059.007', 'T1190']);
  assert.deepStrictEqual(ac.findingTechniques({ class: 'other' }, REG), []);
  assert.deepStrictEqual(ac.findingTechniques({ class: '__unknown__' }, REG), []);
});

ok('buildAttackMatrix computes planned/executed counts and rows', () => {
  const m = ac.buildAttackMatrix({ registry: REG, findings: FINDINGS });
  assert.strictEqual(m.plannedTechniques, 4);   // T1190, T1059.007, T1110, T1613
  assert.strictEqual(m.executedTechniques, 3);  // T1190, T1059.007, T1110
  const r = m.rows.find((x) => x.technique === 'T1190');
  assert.strictEqual(r.executed, 2);            // a.example/sqli + b.example/xss
  assert.deepStrictEqual(r.classes, ['sqli', 'xss']);
});

ok('buildAttackMatrix honors the --host filter', () => {
  const m = ac.buildAttackMatrix({ registry: REG, findings: FINDINGS, host: 'a.example' });
  assert.strictEqual(m.rows.find((x) => x.technique === 'T1190').executed, 1);
  assert.strictEqual(m.rows.find((x) => x.technique === 'T1059.007').executed, 0);
});

ok('rows are ordered by ATT&CK tactic', () => {
  const m = ac.buildAttackMatrix({ registry: REG, findings: FINDINGS });
  const idx = m.rows.map((r) => ac.TACTIC_ORDER.indexOf(r.tactic));
  assert.deepStrictEqual(idx, [...idx].sort((a, b) => a - b));
  assert.ok(idx.every((i) => i >= 0), 'every fixture tactic is known');
});

ok('matrixTable renders header, technique name and unmapped classes', () => {
  const t = ac.matrixTable(ac.buildAttackMatrix({ registry: REG, findings: FINDINGS }));
  assert.match(t, /\| Tactic \| Technique \| Planned by class \| Executed \|/);
  assert.match(t, /T1190 Exploit Public-Facing Application/);
  assert.match(t, /Classes without an ATT&CK mapping: other/);
  assert.match(t, /Extra surfaces \(non-registry classes\): container/);
});

ok('a null/unavailable registry degrades to executed-only, never throws', () => {
  const m = ac.buildAttackMatrix({ registry: null, findings: FINDINGS });
  assert.strictEqual(m.plannedTechniques, 0);
  // No registry → no class mapping, but explicit techniques still count.
  assert.strictEqual(m.executedTechniques, 1);
  assert.strictEqual(m.rows[0].technique, 'T1110');
});

ok('real registry: every non-other class carries an attack mapping', () => {
  const reg = ac.loadRegistry();
  assert.ok(reg && reg.classes, 'real test-registry.json loads');
  // NO_ATTACK = classi il cui finding non ha una tecnica ATT&CK onesta: misconfiguration
  // lato vittima senza tecnica vittima corrispondente (takeover/delega pendente, superficie
  // spoofing mail-auth). Mapparle a una tecnica "di stiro" inquinerebbe la coverage —
  // vuoto è il valore onesto (stessa disciplina di 'other').
  const NO_ATTACK = ['other', 'takeover', 'email-auth'];
  const unmapped = Object.entries(reg.classes)
    .filter(([k, v]) => !k.startsWith('_') && !NO_ATTACK.includes(k) && !(v && Array.isArray(v.attack) && v.attack.length))
    .map(([k]) => k);
  assert.deepStrictEqual(unmapped, []);
  assert.ok(ac.plannedMap(reg).size >= 15, 'registry maps a meaningful set of techniques');
});

summary('test-attack-coverage');
