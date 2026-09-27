#!/usr/bin/env node
// test-repo-invariants.js — il repository deve dire la verità su se stesso.
//
// Perché esiste: le parti del repo che NESSUN gate controllava sono esattamente quelle andate
// fuori sincrono (README con un conteggio di test vecchio, un bullet di CHANGELOG che sostituiva
// `com.example.fest` con `com.example.fest`, doctor che cercava la flotta in una cartella
// svuotata). Sono tutte verificabili in modo meccanico e offline, quindi qui diventano un gate:
//
//   1. numeri dichiarati in README.md (test, agenti, workflow, moduli) vs realtà del repo;
//   2. CHANGELOG: nessuna voce "`X` → `X`" (sostituzione che non sostituisce nulla);
//   3. docs: nessun riferimento a un tools/*.js inesistente; nessun modulo nuovo che nasce
//      senza nessuna riga di documentazione (ratchet: la baseline può solo accorciarsi);
//   4. flotta agenti (local/fleet + .agents): id unici, campi essenziali, modelli a forma di
//      slug, spawnableAgents che risolvono a un agente esistente;
//   5. leak: nessun host di `allowed_hosts` di scope.json dentro un file TRACCIATO da git.
//
// Tutto offline, zero dipendenze, nessuna rete: come il resto della suite.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const assert = require('assert');

const WS = path.resolve(__dirname, '..');
let pass = 0; let fail = 0;
function ok(name, fn) {
  try { fn(); pass++; console.log(`  PASS ${name}`); }
  catch (e) { fail++; console.log(`  FAIL ${name}: ${e.message}`); }
}
const read = (p) => fs.readFileSync(path.join(WS, p), 'utf8');

// ---- realtà del repo ---------------------------------------------------------
// Test eseguiti dal gate = offline + loopback (gli e2e richiedono rete e restano fuori).
function runnerTotals() {
  const r = spawnSync(process.execPath, [path.join(WS, 'tools', 'run-tests.js'), '--list', '--json'],
    { cwd: WS, encoding: 'utf8', timeout: 60000 });
  assert.strictEqual(r.status, 0, 'run-tests --list --json: ' + String(r.stderr || '').slice(0, 200));
  const by = JSON.parse(r.stdout);
  const all = Object.values(by).flat();
  return { total: all.length, runnable: all.length - by.e2e.length, e2e: by.e2e.length };
}

function walk(dir, acc) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else acc.push(p);
  }
  return acc;
}
// Moduli del motore: .js sotto tools/, esclusi i test, lo scaffolding dei test (testkit.js) e le
// fixture (payloads/examples/app).
function toolsModules() {
  const skip = /[\\/](payloads|examples|app)[\\/]/;
  // Conta i file TRACCIATI, non quelli presenti su disco: `tools/gui/vendor/*.js` sono copie di
  // terze parti, gitignored, che esistono solo nelle copie-cartella. Contando il working tree il
  // README dichiarava un numero che un clone pulito non poteva verificare (141 invece di 139) —
  // esattamente il drift che questo test esiste per impedire.
  const ls = spawnSync('git', ['ls-files', 'tools/'], { cwd: WS, encoding: 'utf8' });
  const files = ls.status === 0
    ? String(ls.stdout).split('\n').filter(Boolean).map((rel) => path.join(WS, rel))
    : walk(path.join(WS, 'tools'), []);
  return files
    .filter((p) => p.endsWith('.js') && !skip.test(p))
    .filter((p) => !path.basename(p).startsWith('test-') && path.basename(p) !== 'testkit.js')
    .map((p) => path.relative(WS, p).split(path.sep).join('/'));
}
function agentFiles() {
  const out = [];
  for (const dir of ['local/fleet', '.agents']) {
    for (const f of fs.readdirSync(path.join(WS, dir)).filter((n) => n.endsWith('.ts'))) {
      out.push({ where: `${dir}/${f}`, src: read(`${dir}/${f}`) });
    }
  }
  return out;
}
function workflowCount() {
  return fs.readdirSync(path.join(WS, 'workflows')).filter((f) => /\.ya?ml$/.test(f)).length;
}

// Budget del prompt: i knowledge file entrano VERBATIM nel system prompt di ogni sessione
// (`<progetto>/AGENTS.md` + uno fra `~/.AGENTS.md` / `~/.CLAUDE.md`). Sopra ~20 KB il segnale si
// diluisce e vince per peso l'ultimo blocco iniettato dal prodotto, quindi il tetto è un
// invariante del repo, non un consiglio: `node tools/check-identity.js` è il post-flight che lo
// misura sul prompt realmente assemblato, questo è il gate che lo tiene mentre si scrive.
const PROMPT_BUDGET = 20000; // caratteri, prompt assemblato (entrambi i knowledge file)
const AGENTS_MD_BUDGET = 6000; // caratteri, solo <progetto>/AGENTS.md

// Documenti che descrivono la superficie dei tool all'operatore.
function docCorpus() {
  const docs = ['README.md', 'knowledge.md'];
  for (const d of ['docs', 'ops']) {
    for (const f of fs.readdirSync(path.join(WS, d)).filter((n) => n.endsWith('.md'))) docs.push(`${d}/${f}`);
  }
  return docs;
}

// Moduli noti come NON ancora citati in nessun documento: debito dichiarato, non nascosto.
// La lista può solo ACCORCIARSI — documenta il modulo (una riga in docs/toolbox.md o in
// knowledge.md) e rimuovi la voce qui. Un modulo nuovo senza documentazione fa fallire il check.
const UNDOCUMENTED_BASELINE = [
  'accounting.js', 'addon-fit.js', 'anti-anti.js', 'api-authz.js', 'authn-oracle.js',
  'autopilot-checkpoint.js', 'backfill-findings-tab.js', 'cachepoison.js', 'cc-arsenal.js',
  'check-identity.js', 'circuit-breaker.js', 'component-fuzz.js', 'continuation.js',
  'crypto-dump.js', 'daily-maintenance.js', 'embeddings.js', 'entity-taxonomy.js',
  'eval-juice-shop.js', 'gen-bench.js', 'install-all.js', 'key-hunt.js', 'listen-audit.js',
  'llm-inject.js', 'login.js', 'loop-watch.js', 'memory-recall.js', 'memory-store.js',
  'model-routing.js', 'oracle.js', 'planner-demo.js', 'planner.js', 'poc-replay.js',
  'privacy.js', 'proc-registry.js', 'proxy-route.js', 'radar-analyst.js', 'radar-profiler.js',
  'radar-scout.js', 'recover.js', 'reflector.js', 'retrieval-budget.js', 'saml.js', 'spray.js',
  'ssrf-guard.js', 'storage-triage.js', 'tool-path.js', 'vet-agents-vs-freebuff.js',
];

console.log('repo-invariants — documenti vs realtà');

ok('README: ogni "N tests" dichiarato = test eseguiti dal gate', () => {
  const t = runnerTotals();
  const declared = [...read('README.md').matchAll(/(\d+)\s+tests?\b/g)].map((m) => Number(m[1]));
  assert.ok(declared.length >= 2, 'il README non dichiara il numero di test');
  for (const n of declared) {
    assert.strictEqual(n, t.runnable, `README dichiara ${n} test, il gate ne esegue ${t.runnable}`);
  }
});

ok('README: "N agent definitions" = file in local/fleet/', () => {
  const m = read('README.md').match(/(\d+)\s+agent definitions/);
  assert.ok(m, 'il README non dichiara il numero di agenti');
  const n = fs.readdirSync(path.join(WS, 'local', 'fleet')).filter((f) => f.endsWith('.ts')).length;
  assert.strictEqual(Number(m[1]), n, `README dichiara ${m[1]} agenti, local/fleet ne ha ${n}`);
});

ok('README: "N reusable pipelines" = workflow versionati', () => {
  const m = read('README.md').match(/(\d+)\s+reusable/);
  assert.ok(m, 'il README non dichiara il numero di workflow');
  assert.strictEqual(Number(m[1]), workflowCount(), `README dichiara ${m[1]}, workflows/ ne ha ${workflowCount()}`);
});

ok('README: "N modules" = moduli reali del motore', () => {
  const m = read('README.md').match(/(\d+)\s+modules/);
  assert.ok(m, 'il README non dichiara il numero di moduli');
  const n = toolsModules().length;
  assert.strictEqual(Number(m[1]), n, `README dichiara ${m[1]} moduli, tools/ ne ha ${n}`);
});

ok('AGENTS.md: contratto dentro il budget del prompt', () => {
  const n = read('AGENTS.md').length;
  assert.ok(n <= AGENTS_MD_BUDGET,
    `AGENTS.md è ${n} caratteri (tetto ${AGENTS_MD_BUDGET}): sposta il riferimento in docs/ o ops/ — ` +
    'entra verbatim nel system prompt di ogni sessione');
  const home = path.join(process.env.HOME || os.homedir(), '.AGENTS.md');
  if (!fs.existsSync(home)) { console.log('    SKIP ~/.AGENTS.md assente: budget totale non misurabile qui'); return; }
  const total = n + fs.readFileSync(home, 'utf8').length;
  assert.ok(total <= PROMPT_BUDGET,
    `prompt assemblato ${total} caratteri (tetto ${PROMPT_BUDGET}): AGENTS.md ${n} + ~/.AGENTS.md ${total - n}`);
});

ok('CHANGELOG: nessuna voce "`X` → `X`"', () => {
  const bad = read('CHANGELOG.md').split('\n').filter((l) => {
    const m = l.match(/`([^`]+)`\s*→\s*`([^`]+)`/);
    return m && m[1] === m[2];
  });
  assert.deepStrictEqual(bad, [], 'righe in cui la sostituzione è a vuoto: ' + bad.join(' | ').slice(0, 200));
});

ok('docs: nessun riferimento a un tools/*.js inesistente', () => {
  const dead = [];
  for (const d of docCorpus()) {
    for (const m of read(d).matchAll(/tools\/[A-Za-z0-9_.-]+\.js\b/g)) {
      if (!fs.existsSync(path.join(WS, m[0]))) dead.push(`${d}: ${m[0]}`);
    }
  }
  assert.deepStrictEqual(dead, [], 'riferimenti morti: ' + dead.join(', '));
});

ok('tools/: nessun modulo non documentato fuori dalla baseline', () => {
  const corpus = docCorpus().map(read).join('\n');
  const undocumented = toolsModules()
    .filter((p) => !corpus.includes(path.basename(p)))
    .map((p) => path.basename(p))
    .filter((b) => !UNDOCUMENTED_BASELINE.includes(b))
    .sort();
  assert.deepStrictEqual(undocumented, [],
    'nuovi moduli senza una riga di documentazione (aggiungila o mettili in UNDOCUMENTED_BASELINE): ' + undocumented.join(', '));
});

// File che reimplementano ancora il contatore pass/fail e `ok()` invece di usare
// `tools/testkit.js`. La lista può solo ACCORCIARSI: migra un file al kit e togli la voce qui.
// Un file nuovo che nasce con la propria copia dello scaffolding fa fallire questo check.
const OWN_SCAFFOLD_BASELINE = [
  'test-ad.js', 'test-api-authz.js', 'test-autopilot-checkpoint.js', 'test-autopilot.js',
  'test-budget.js', 'test-cachepoison.js', 'test-circuit-breaker.js', 'test-cloud-enum.js',
  'test-coverage.js', 'test-crack.js', 'test-enforce.js', 'test-gate-chain.js', 'test-gate.js',
  'test-gen-poc.js', 'test-graphql.js', 'test-llm-inject.js', 'test-local-plan.js',
  'test-mcp-guard-proxy.js', 'test-next-actions-services.js', 'test-ondata4.js', 'test-ondata6.js',
  'test-oracle.js', 'test-record-finding.js', 'test-repo-invariants.js', 'test-rimandati.js',
  'test-saml.js', 'test-sb2.js', 'test-sb3.js', 'test-sc1.js', 'test-sc2.js', 'test-sc3.js',
  'test-scope-canon.js', 'test-spray.js', 'test-takeover.js', 'test-tier1a.js', 'test-tier1b.js',
  'test-tier1c.js', 'test-tool-plane.js', 'test-workflow.js',
];
ok('tools/: nessuno scaffolding di test duplicato fuori dalla baseline', () => {
  const found = fs.readdirSync(path.join(WS, 'tools'))
    .filter((f) => /^test-.*\.js$/.test(f) && f !== 'testkit.js')
    .filter((f) => /let pass = 0/.test(read(`tools/${f}`)))
    .filter((f) => !OWN_SCAFFOLD_BASELINE.includes(f))
    .sort();
  assert.deepStrictEqual(found, [],
    'questi file copiano lo scaffolding invece di importare tools/testkit.js: ' + found.join(', '));
});

ok('flotta: id unici, campi essenziali, modelli slug, spawnableAgents risolvibili', () => {
  const agents = agentFiles();
  assert.ok(agents.length >= 20, `flotta sospetta: ${agents.length} agenti`);
  const ids = new Map();
  const problems = [];
  const spawnRefs = [];
  for (const { where, src } of agents) {
    const id = (src.match(/\bid:\s*'([^']+)'/) || [])[1];
    if (!id) problems.push(`${where}: manca id`);
    else if (ids.has(id)) problems.push(`${where}: id duplicato '${id}' (già usato da ${ids.get(id)})`);
    else ids.set(id, where);
    // `model` non è nella lista: le definizioni lo dichiarano come `const model = '...'` e poi
    // lo usano per shorthand, quindi non ha una chiave `model:` da cercare (lo valida lo slug).
    for (const key of ['version', 'displayName', 'systemPrompt', 'instructionsPrompt']) {
      if (!new RegExp(`\\b${key}:`).test(src)) problems.push(`${where}: manca ${key}`);
    }
    const model = (src.match(/const model\s*=\s*'([^']+)'/) || [])[1] || (src.match(/model:\s*'([^']+)'/) || [])[1];
    if (model && !/^[a-z0-9][a-z0-9-]*\/[a-z0-9._-]+$/.test(model)) problems.push(`${where}: model '${model}' non è uno slug 'publisher/modello'`);
    const block = src.match(/spawnableAgents:\s*\[([^\]]*)\]/);
    for (const ref of block ? [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]) : []) {
      spawnRefs.push({ where, ref });
    }
  }
  for (const { where, ref } of spawnRefs) {
    if (!ids.has(ref)) problems.push(`${where}: spawnableAgents referenzia '${ref}', che non esiste`);
  }
  assert.deepStrictEqual(problems, [], problems.slice(0, 6).join(' | '));
});

// Nessun host della autorizzazione CORRENTE può stare in un file tracciato: la lista dei
// clienti arriva da scope.json (gitignored), mai da una denylist scritta nel repo.
// Host di infrastruttura citati dalla documentazione di egress, non clienti.
const INFRA_HOSTS_OK = ['check.torproject.org'];
ok('leak: nessun host di scope.json dentro un file tracciato', () => {
  const scopePath = path.join(WS, 'scope.json');
  if (!fs.existsSync(scopePath)) { console.log('    SKIP scope.json assente: niente da confrontare'); return; }
  const scope = JSON.parse(fs.readFileSync(scopePath, 'utf8'));
  const hosts = (Array.isArray(scope.allowed_hosts) ? scope.allowed_hosts : [])
    // Un'autorizzazione che copre solo loopback — quella che tools/ensure-test-scope.js scrive su
    // un clone pulito — non ha niente da perdere: `127.0.0.1` sta in mezza documentazione e non
    // identifica nessuno. È un hostname di cliente che non deve stare in un file tracciato.
    .filter((h) => typeof h === 'string' && h.includes('.') && !INFRA_HOSTS_OK.includes(h) && !/^127\./.test(h));
  if (!hosts.length) { console.log('    SKIP scope.json senza hostname'); return; }
  const ls = spawnSync('git', ['ls-files'], { cwd: WS, encoding: 'utf8' });
  if (ls.status !== 0) { console.log('    SKIP git non disponibile'); return; }
  const hits = [];
  for (const rel of String(ls.stdout).split('\n').filter(Boolean)) {
    const full = path.join(WS, rel);
    let st; try { st = fs.statSync(full); } catch { continue; }
    if (!st.isFile() || st.size > 2 * 1024 * 1024) continue;
    const buf = fs.readFileSync(full);
    if (buf.includes(0)) continue; // binario
    const txt = buf.toString('utf8').toLowerCase();
    for (const h of hosts) if (txt.includes(h.toLowerCase())) hits.push(`${rel}: ${h}`);
  }
  assert.deepStrictEqual(hits, [],
    'host di engagement in file tracciati (togli l\'host o smetti di tracciare il file): ' + hits.slice(0, 5).join(', '));
});

console.log(`\nrepo-invariants: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
