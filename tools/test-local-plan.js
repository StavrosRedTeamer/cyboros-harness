#!/usr/bin/env node
// Zero-dependency OFFLINE test for local/plan.js (modalità "--plan": recon -> opzioni -> STOP).
// Stile tools/test-loop-watch.js: PASS/FAIL per caso, exit 1 se almeno un FAIL.
//
// Proprietà verificate (tutte offline, nessuna rete, nessuna azione eseguita):
//   1. decide() è fail-closed: bloccate e comandi con segreto NON sono eseguibili; il tier
//      intrusive richiede SEMPRE conferma esplicita;
//   2. menu() ordina per tier (read < active < intrusive), numera nell'ordine di
//      visualizzazione ed esclude le bloccate dalla selezione;
//   3. pick() mappa i tasti ([numero]/r/w/h/R/q) e rifiuta il resto;
//   4. related() filtra il piano sull'host richiesto (+ sottodomini): nessuna azione di altri
//      engagement può finire nel menu;
//   5. autoRecon() in dry-run NON esegue nulla e tocca solo azioni ammesse/non intrusive/scoperte;
//   6. buildPlan() legge il grafo da uno STATE_DB TEMPORANEO (il db reale non viene mai toccato)
//      e non esplode su un grafo vuoto.
//
// Run: node tools/test-local-plan.js

'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Il db di stato deve puntare a una fixture temporanea: nessun test tocca reports/state.db.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'stavros-local-plan-'));
process.env.STATE_DB = path.join(TMP, 'state.db');

const plan = require('../local/plan');
const WS = path.join(__dirname, '..');

let pass = 0, fail = 0;
function ok(name, fn) {
  try { fn(); pass++; console.log(`  PASS ${name}`); }
  catch (e) { fail++; console.log(`  FAIL ${name} :: ${String(e.message).split('\n')[0]}`); }
}

// Azione sintetica con la stessa forma di tools/next-actions.js.
const A = (o) => Object.assign({
  host: 'target.example.com', surface: 'http', port: 80, reason: 'motivo', cmd: 'node tools/run.js curl -s http://x/',
  tier: 'read', requires_optin: false, priority: 20, covered: false, blocked: false, scope_reason: 'ok',
}, o);

function fixturePlan(actions) {
  return { host: 'target.example.com', generated_at: null, actions, summary: { total: actions.length } };
}

console.log('local/plan.js — policy + menu (offline)');

// ---------------------------------------------------------------- 1. decide()
ok('decide: azione bloccata -> non eseguibile (fail-closed)', () => {
  const d = plan.decide(A({ blocked: true, scope_reason: 'host fuori scope' }));
  assert.strictEqual(d.ok, false);
  assert.match(d.reason, /fuori scope/);
});
ok('decide: comando con <secret> -> mai eseguito', () => {
  const d = plan.decide(A({ cmd: "node tools/run.js netexec smb h -u 'a' -p '<secret>' --shares", tier: 'intrusive', requires_optin: true }));
  assert.strictEqual(d.ok, false);
  assert.match(d.reason, /segreto/);
});
ok('decide: tier intrusive -> ok ma SEMPRE con conferma', () => {
  const d = plan.decide(A({ tier: 'intrusive', requires_optin: true }));
  assert.strictEqual(d.ok, true);
  assert.strictEqual(d.needsConfirm, true);
});
ok('decide: tier read -> ok senza conferma', () => {
  const d = plan.decide(A({ tier: 'read' }));
  assert.strictEqual(d.ok, true);
  assert.strictEqual(d.needsConfirm, false);
});
ok('decide: coperta -> avviso, ma l\'operatore può rieseguirla', () => {
  const d = plan.decide(A({ covered: true }));
  assert.strictEqual(d.ok, true);
  assert.match(String(d.warn), /già coperto/);
});

// ---------------------------------------------------------------- 2. menu()
ok('menu: ordina per tier e numera nell\'ordine di visualizzazione', () => {
  const m = plan.menu(fixturePlan([
    A({ tier: 'intrusive', priority: 40, reason: 'sqlmap' }),
    A({ tier: 'active', priority: 25, reason: 'nuclei' }),
    A({ tier: 'read', priority: 15, reason: 'snmp' }),
    A({ tier: 'read', priority: 12, reason: 'redis' }),
    A({ tier: 'active', priority: 20, reason: 'httpx' }),
  ]));
  assert.deepStrictEqual(m.items.map((a) => a.n), [1, 2, 3, 4, 5]);
  assert.deepStrictEqual(m.items.map((a) => a.reason), ['redis', 'snmp', 'httpx', 'nuclei', 'sqlmap']);
  assert.deepStrictEqual(m.items.map((a) => a.tier), ['read', 'read', 'active', 'active', 'intrusive']);
});
ok('menu: le bloccate non sono selezionabili (fuori dai items)', () => {
  const m = plan.menu(fixturePlan([A({}), A({ blocked: true, tier: 'intrusive' })]));
  assert.strictEqual(m.items.length, 1);
  assert.strictEqual(m.blocked.length, 1);
  assert.ok(m.items.every((a) => !a.blocked));
});

// ---------------------------------------------------------------- 3. pick()
const M = plan.menu(fixturePlan([A({ reason: 'redis', tier: 'read' }), A({ reason: 'sqlmap', tier: 'intrusive' })]));
ok('pick: numero -> exec sull\'azione giusta', () => {
  const it = plan.pick(M, '2');
  assert.strictEqual(it.type, 'exec');
  assert.strictEqual(it.action.reason, 'sqlmap');
});
ok('pick: numero inesistente -> invalid', () => {
  assert.strictEqual(plan.pick(M, '9').type, 'invalid');
});
ok('pick: r/w/h/R/q', () => {
  assert.strictEqual(plan.pick(M, 'r').type, 'reload');
  assert.strictEqual(plan.pick(M, 'w').phase, 'web-test');
  assert.strictEqual(plan.pick(M, 'h').phase, 'host');
  assert.strictEqual(plan.pick(M, 'R').phase, 'report');
  assert.strictEqual(plan.pick(M, 'q').type, 'quit');
});
ok('pick: input vuoto o ignoto -> invalid (nessuna azione implicita)', () => {
  assert.strictEqual(plan.pick(M, '').type, 'invalid');
  assert.strictEqual(plan.pick(M, 'rm -rf /').type, 'invalid');
});

// ---------------------------------------------------------------- 4. related() + renderMenu
ok('related: host, sottodominio e padre correlati; altri host no', () => {
  assert.ok(plan.related('target.example.com', 'target.example.com'));
  assert.ok(plan.related('api.target.example.com', 'target.example.com'));
  assert.ok(plan.related('target.example.com', 'api.target.example.com'));
  assert.strictEqual(plan.related('altro.com', 'target.example.com'), false);
  assert.strictEqual(plan.related('finto-target.example.com', 'target.example.com'), false); // suffisso non-dominio
});
ok('hostOf: URL, URL con porta/path e host nudo -> hostname', () => {
  assert.strictEqual(plan.hostOf('https://portal.example.com/'), 'portal.example.com');
  assert.strictEqual(plan.hostOf('http://portal.example.com:8443/a/b?c=1'), 'portal.example.com');
  assert.strictEqual(plan.hostOf('portal.example.com'), 'portal.example.com');
  assert.strictEqual(plan.hostOf('Portal.Example.com.'), 'portal.example.com');
  assert.strictEqual(plan.hostOf(''), '');
});
ok('related: un URL in ingresso non deve scartare le azioni del suo host (bug menu vuoto)', () => {
  assert.ok(plan.related('portal.example.com', 'https://portal.example.com/'));
  assert.ok(plan.related('portal.example.com', 'https://portal.example.com/qualcosa?x=1'));
  assert.strictEqual(plan.related('altro.example.com', 'https://portal.example.com/'), false);
});
ok('renderMenu: mostra motivo, comando, tier e marcatura di conferma', () => {
  const txt = plan.renderMenu(M, { host: 'target.example.com' });
  assert.match(txt, /target\.example\.com/);
  assert.match(txt, /node tools\/run\.js curl/);
  assert.match(txt, /RICOGNIZIONE/);
  assert.match(txt, /OFFENSIVO/);
  assert.match(txt, /richiede conferma/);
  assert.match(txt, /\[numero\] esegui/);
});

// ---------------------------------------------------------------- 5. autoRecon (dry)
ok('autoRecon dry: non esegue nulla e salta opt-in, coperte e bloccate', () => {
  const p = fixturePlan([
    A({ reason: 'ok', tier: 'read' }),
    A({ reason: 'optin', tier: 'intrusive', requires_optin: true }),
    A({ reason: 'coperta', tier: 'read', covered: true }),
    A({ reason: 'bloccata', blocked: true }),
  ]);
  const ran = [];
  const res = plan.autoRecon(p, { dry: true, onRun: (a) => ran.push(a.reason) });
  assert.deepStrictEqual(ran, ['ok']);
  assert.deepStrictEqual(res, [{ cmd: p.actions[0].cmd, skipped: 'dry-run' }]);
});

// ---------------------------------------------------------------- 6. buildPlan su db temporaneo
ok('buildPlan: grafo vuoto -> nessuna azione, nessun crash, db reale intatto', () => {
  const realDb = path.join(WS, 'reports', 'state.db');
  const before = fs.existsSync(realDb) ? fs.statSync(realDb).mtimeMs : null;
  const p = plan.buildPlan('target.example.com', { db: process.env.STATE_DB });
  assert.strictEqual(p.host, 'target.example.com');
  assert.deepStrictEqual(p.actions, []);
  assert.strictEqual(p.summary.total, 0);
  assert.ok(fs.existsSync(path.join(TMP, 'state.db')), 'il db temporaneo deve essere creato');
  if (before != null) assert.strictEqual(fs.statSync(realDb).mtimeMs, before, 'il db reale non deve essere toccato');
});
ok('writeReport: scrive json+md sotto reports/ e ripulisce', () => {
  const host = 'test-local-plan.invalid';
  const p = fixturePlan([A({ host, reason: 'prova' })]);
  const out = plan.writeReport(host, p, { choices: [{ type: 'quit' }], stopped: true });
  try {
    assert.ok(fs.existsSync(out.json) && fs.existsSync(out.md));
    assert.ok(path.resolve(out.json).startsWith(path.join(WS, 'reports') + path.sep));
    const j = JSON.parse(fs.readFileSync(out.json, 'utf8'));
    assert.strictEqual(j.host, host);
    assert.strictEqual(j.actions.length, 1);
    assert.match(fs.readFileSync(out.md, 'utf8'), /Prossime azioni/);
  } finally {
    fs.rmSync(out.json, { force: true });
    fs.rmSync(out.md, { force: true });
  }
});

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\nlocal/plan: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
