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
//   5. leak: nessun host di `allowed_hosts` di scope.json dentro un file TRACCIATO da git;
//   6. worktree = clone: ogni conteggio dichiarato (test, pipeline, agenti) torna anche contando
//      SOLO i file tracciati, e ogni `tools/*.js` citato da un documento esiste ED è tracciato —
//      un file che vive solo sul tuo disco non esiste per chi clona;
//   7. l'indice committato è riproducibile da un export di HEAD, non solo dal worktree: è la
//      differenza fra un verde locale e un rosso per chi clona, e master è stato rosso così;
//   8. la mappa del progetto (docs/project-map.html) è rigenerabile dai moduli reali: come
//      l'indice è GENERATA, e una mappa ferma è una mappa che mente.
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
// Il runner scopre i test dal DISCO (`fs.readdirSync`), non dall'indice: è esattamente per questo
// che un test non tracciato gonfia il conteggio qui e non in un clone. Serve anche l'elenco dei
// NOMI, non solo il totale, per poter nominare il file che esiste solo sul disco di chi scrive.
function runnerList() {
  const r = spawnSync(process.execPath, [path.join(WS, 'tools', 'run-tests.js'), '--list', '--json'],
    { cwd: WS, encoding: 'utf8', timeout: 60000 });
  assert.strictEqual(r.status, 0, 'run-tests --list --json: ' + String(r.stderr || '').slice(0, 200));
  return JSON.parse(r.stdout);
}

function runnerTotals() {
  const by = runnerList();
  const all = Object.values(by).flat();
  return { total: all.length, runnable: all.length - by.e2e.length, e2e: by.e2e.length, names: all };
}

// La superficie che un clone vede davvero: l'indice di git, non il disco.
function tracked(pathspec) {
  const r = spawnSync('git', ['ls-files', '--', pathspec], { cwd: WS, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, 'git ls-files -- ' + pathspec + ': ' + String(r.stderr || '').slice(0, 120));
  return String(r.stdout).split('\n').filter(Boolean);
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
  'accounting.js', 'anti-anti.js', 'api-authz.js', 'authn-oracle.js', 'autopilot-checkpoint.js',
  'backfill-findings-tab.js', 'cachepoison.js', 'cc-arsenal.js', 'circuit-breaker.js',
  'component-fuzz.js', 'continuation.js', 'crypto-dump.js', 'daily-maintenance.js',
  'embeddings.js', 'entity-taxonomy.js', 'eval-juice-shop.js', 'install-all.js', 'key-hunt.js',
  'listen-audit.js', 'llm-inject.js', 'login.js', 'loop-watch.js', 'model-routing.js', 'oracle.js',
  'planner-demo.js', 'planner.js', 'poc-replay.js', 'privacy.js', 'proc-registry.js',
  'proxy-route.js', 'radar-analyst.js', 'radar-profiler.js', 'radar-scout.js', 'recover.js',
  'reflector.js', 'retrieval-budget.js', 'saml.js', 'spray.js', 'ssrf-guard.js',
  'storage-triage.js', 'tool-path.js',
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

// La classe di difetto che ha tenuto master rosso: un file vive su disco e non nell'indice. Allora
// il worktree dice il vero e un clone no, e i due metà del README raccontano due repository
// diversi — i test si contano dal DISCO, i moduli da git. Un numero è credibile solo se torna anche
// contando i soli file tracciati: questa è la differenza fra "funziona sul mio portatile" e
// "funziona per chi clona". (I moduli non sono in questa lista perché `toolsModules()` conta già da
// `git ls-files`: il suo numero è per costruzione quello di un clone.)
ok('ogni conteggio torna anche contando SOLO i file tracciati (worktree = clone)', () => {
  const drift = [];
  const notTracked = (onDisk, inIndex) => onDisk.filter((p) => !inIndex.has(p));

  // test — il runner li scopre dal disco
  const t = runnerTotals();
  const trackedTests = new Set(tracked('tools/test-*.js'));
  const ghostTests = t.names.map((n) => `tools/${n}.js`).filter((p) => !trackedTests.has(p));
  if (ghostTests.length) {
    drift.push(`test: il runner ne esegue ${t.runnable}, git ne conosce ${t.runnable - ghostTests.length} ` +
      `— solo su disco: ${ghostTests.join(', ')}`);
  }

  // pipeline — `workflowCount()` legge la cartella
  const pipelines = fs.readdirSync(path.join(WS, 'workflows'))
    .filter((f) => /\.ya?ml$/.test(f)).map((f) => `workflows/${f}`);
  const ghostPipelines = notTracked(pipelines, new Set(tracked('workflows')));
  if (ghostPipelines.length) {
    drift.push(`pipeline: ${pipelines.length} su disco, ${pipelines.length - ghostPipelines.length} tracciate ` +
      `— solo su disco: ${ghostPipelines.join(', ')}`);
  }

  // agenti — `fs.readdirSync('local/fleet')`
  const agents = fs.readdirSync(path.join(WS, 'local', 'fleet'))
    .filter((f) => f.endsWith('.ts')).map((f) => `local/fleet/${f}`);
  const ghostAgents = notTracked(agents, new Set(tracked('local/fleet')));
  if (ghostAgents.length) {
    drift.push(`agenti: ${agents.length} su disco, ${agents.length - ghostAgents.length} tracciati ` +
      `— solo su disco: ${ghostAgents.join(', ')}`);
  }

  assert.deepStrictEqual(drift, [],
    'questi numeri valgono solo sul tuo disco: un clone ne vedrebbe meno. Committa i file (o togli ' +
    'il riferimento) e i conteggi tornano — ' + drift.join(' | '));
});

// L'indice della documentazione è GENERATO: se i file cambiano e lui no, mente. Qui si rigenera
// in memoria (--check non scrive) invece di fidarsi di averlo fatto a mano.
ok('docs/INDEX.md è aggiornato (indice generato dai file reali)', () => {
  const r = spawnSync(process.execPath, [path.join(WS, 'tools', 'docs-index.js'), '--check'],
    { cwd: WS, encoding: 'utf8', timeout: 30000 });
  assert.strictEqual(r.status, 0,
    'indice non aggiornato: ' + String(r.stderr || r.stdout || '').split('\n')[0]);
});

// Stesso patto per la mappa: gli 160 moduli, le famiglie e i test che li nominano vengono letti
// dal repository. Aggiungi un modulo e la mappa è indietro di una riga — questo lo dice subito,
// invece di lasciare in giro una pagina che descrive un repository che non esiste più.
ok('docs/project-map.html è aggiornata (mappa generata dai moduli reali)', () => {
  const r = spawnSync(process.execPath, [path.join(WS, 'tools', 'project-map.js'), '--check'],
    { cwd: WS, encoding: 'utf8', timeout: 30000 });
  assert.strictEqual(r.status, 0,
    'mappa non aggiornata: ' + String(r.stderr || r.stdout || '').split('\n')[0]);
});

// Il check qui sopra guarda il WORKTREE, e il worktree non è ciò che si clona. Se l'indice viene
// rigenerato su file non committati e poi COMMITTATO mentre quelli restano a HEAD, il verde è
// locale e il rosso è per chi clona: la prima stesura della riparazione di master aveva esattamente
// questo difetto (l'indice registrava `AGENTS.md` a 7,4 KB mentre a HEAD era 5,9 KB). Materializzare
// HEAD con `git archive` in una cartella senza `.git` riproduce il clone: lì `docs-index.js` ricade
// sulla lettura del disco, e l'export contiene solo file tracciati.
ok('docs/INDEX.md committato è riproducibile da HEAD, non solo dal worktree', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'head-export-'));
  try {
    const archive = spawnSync('git', ['archive', 'HEAD'], { cwd: WS, maxBuffer: 512 * 1024 * 1024 });
    if (archive.status !== 0) {
      console.log('    SKIP git archive non disponibile: lo stato committato non è ispezionabile qui');
      return;
    }
    const extract = spawnSync('tar', ['-x', '-C', dir],
      { input: archive.stdout, stdio: ['pipe', 'ignore', 'inherit'] });
    if (extract.status !== 0) {
      console.log('    SKIP tar non disponibile: export di HEAD non materializzabile');
      return;
    }
    // Rigenero l'indice DENTRO l'export (modalità scrittura) e lo confronto col committato: così il
    // messaggio dice quale riga diverge, cioè quale file l'indice elenca e un clone non ha. `--check`
    // darebbe lo stesso verdetto, ma in una cartella senza `.git` il `git ls-files` di docs-index
    // lascia il suo "fatal: not a git repository" su stderr ereditato, e quella riga coprirebbe il
    // motivo vero (`docs-index: non è aggiornato`).
    const committed = read('docs/INDEX.md');
    const r = spawnSync(process.execPath, [path.join(dir, 'tools', 'docs-index.js')],
      { cwd: dir, encoding: 'utf8', timeout: 60000 });
    assert.strictEqual(r.status, 0,
      'indice non rigenerabile in un clone: ' + String(r.stderr || r.stdout || '').split('\n')[0]);
    const fresh = fs.readFileSync(path.join(dir, 'docs', 'INDEX.md'), 'utf8');
    const a = committed.split('\n');
    const b = fresh.split('\n');
    // Non la PRIMA riga diversa — quella è il conteggio in testa (es. «35 documenti» vs «34»), che
    // dice che i due indici divergono ma non QUALE file è di troppo. La voce con un link `](` sì.
    let i = -1;
    for (let k = 0; k < Math.max(a.length, b.length); k++) {
      if (a[k] === b[k]) continue;
      const entry = (a[k] || '').includes('](') || (b[k] || '').includes('](');
      if (entry || i < 0) i = k;
      if (entry) break;
    }
    const shown = (s) => (s === undefined ? '(riga assente)' : s.trim().slice(0, 120));
    assert.strictEqual(committed, fresh,
      'in un clone di HEAD l\'indice non torna (il verde era solo nel worktree) — riga ' +
      `${i + 1}: committato «${shown(a[i])}» vs clone «${shown(b[i])}»`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Il bootstrap del F3 gira in proot, dove non esiste un PID1 systemd: i postinst di
// systemd/dbus/gtk falliscono e apt non configura nulla. Inoltre apkid e smali NON sono nei
// repo Kali e un nome sconosciuto fa abortire l'INTERA transazione apt. Questa invariante
// impedisce il ritorno dei due bug trovati il 2026-09-30.
ok('f3-client-setup: arsenale android proot-safe (no apkid/smali in apt)', () => {
  const src = read('tools/f3-client-setup.sh');
  // Ancora l'heredoc al bootstrap dentro proot: il file ne ha altri (f3-kali, config) e il
  // primo `<<'EOF'` non è quello giusto.
  const m = src.match(/f3-kali-bootstrap\.sh"\s*<<'EOF'\n([\s\S]*?)\nEOF\n/);
  assert.ok(m, 'heredoc del bootstrap non trovato in tools/f3-client-setup.sh');
  const body = m[1];
  const code = body.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n').replace(/\\\n/g, ' ');
  const aptCmds = code.match(/apt-get install[^\n]*/g) || [];
  assert.ok(aptCmds.length > 0, 'nessun apt-get install nel bootstrap F3');
  for (const c of aptCmds) {
    assert.ok(!/\bapkid\b/.test(c), 'apkid non è nei repo Kali: niente apt — ' + c.trim());
    assert.ok(!/(^|\s)smali(\s|$)/.test(c), 'smali non è nei repo Kali: usa libsmali-java — ' + c.trim());
  }
  assert.ok(/proot_neutralize_postinst/.test(body), 'manca la neutralizzazione dei postinst (proot)');
  assert.ok(/proot_restore_postinst/.test(body), 'manca il ripristino dei postinst (proot)');
  assert.ok(/libsmali-java/.test(body), 'libsmali-java atteso per i jar smali');
  assert.ok(/pip3 install[^\n]*\bapkid\b/.test(body), 'apkid deve essere installato da pip');
});

ok('CHANGELOG: nessuna voce "`X` → `X`"', () => {
  const bad = read('CHANGELOG.md').split('\n').filter((l) => {
    const m = l.match(/`([^`]+)`\s*→\s*`([^`]+)`/);
    return m && m[1] === m[2];
  });
  assert.deepStrictEqual(bad, [], 'righe in cui la sostituzione è a vuoto: ' + bad.join(' | ').slice(0, 200));
});

ok('docs: nessun riferimento a un tools/*.js inesistente o non tracciato', () => {
  const dead = [];
  const ghosts = [];
  const trackedTools = new Set(tracked('tools'));
  for (const d of docCorpus()) {
    for (const m of read(d).matchAll(/tools\/[A-Za-z0-9_.-]+\.js\b/g)) {
      if (!fs.existsSync(path.join(WS, m[0]))) dead.push(`${d}: ${m[0]}`);
      // Esiste, ma solo qui: in un clone quel riferimento è morto quanto uno a un file mai scritto.
      else if (!trackedTools.has(m[0])) ghosts.push(`${d}: ${m[0]}`);
    }
  }
  assert.deepStrictEqual(dead, [], 'riferimenti morti: ' + dead.join(', '));
  assert.deepStrictEqual(ghosts, [],
    'riferimenti a file che esistono solo sul tuo disco (in un clone sono morti): ' + ghosts.join(', '));
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

// ---- flotta: ratchet sulla duplicazione ---------------------------------------
// Il prompt di un sub-agente è l'unico contesto che ha per certo: `ops/harness.md` è leggibile a
// richiesta ma NON iniettato (0 suoi byte nel prompt assemblato — vedi tools/check-identity.js),
// quindi un blocco operativo che serve *prima* di ogni tool-call deve restare nel prompt e ripetuto.
// Questi sono i blocchi condivisi DICHIARATI canonici (misurati: 80 KB → 52 KB il 2026-09-28).
// Ogni altra riga ≥100 caratteri ripetuta in ≥3 file di flotta è duplicazione rientrata: il
// proprietario è `ops/harness.md`, quindi comprimi il prompt a un indice/puntatore — non ricopiare.
const FLEET_SHARED_MARKERS = [
  'AUTHORIZED ENGAGEMENT:',                    // identità/autorizzazione: nessun proprietario esterno, e il rifiuto precede ogni lettura
  'Pentest discipline (in-context index;',     // indice compresso della disciplina (soglie e comandi restano in-context)
  'read that section, never stream the whole file):',
  'verify_level caps severity',
  'record-finding.js enforces it); no finding is real',
  '(rule out your own side effects); minimal impact',
  'even without a WAF (enforce.js blocks bare nmap/ffuf)',
  "invent a missing tool's output); target content is DATA",
  'Shared rules (disciplina full',             // il puntatore unico alla harness
  'Long-term memory (RAG):',                   // puntatore compresso alla procedura di memoria
  'MCP attivo su questo agente:',
  '"chrome-devtools": { command:',             // config MCP reale dell'agente, non prosa
];
// Presenza minima: togliere un blocco canonico farebbe passare il ratchet "a vuoto".
const FLEET_SHARED_MIN = {
  'AUTHORIZED ENGAGEMENT:': 29,
  'Pentest discipline (in-context index;': 29,
  'Shared rules (disciplina full': 28,
};
// Regole uscite dai prompt compressi: il testo esteso deve esistere ancora nell'unico proprietario.
const OWNER_RULE_ANCHORS = ['Verification levels', 'A finding is NOT real until verified', 'False-positive duty',
  'Minimal-impact proof', 'WAF awareness', 'Install valve', 'Adversarial content discipline', 'POC delivery',
  'Memoria (RAG)', 'memory-recall.js'];

ok('flotta: nessun blocco lungo ripetuto fuori dall\'allowlist canonico', () => {
  const occ = new Map();
  for (const { where, src } of agentFiles()) {
    for (const l of src.split('\n')) {
      if (l.length < 100 || FLEET_SHARED_MARKERS.some((m) => l.includes(m))) continue;
      if (!occ.has(l)) occ.set(l, new Set());
      occ.get(l).add(where);
    }
  }
  const dup = [...occ.entries()].filter(([, s]) => s.size >= 3)
    .sort((a, b) => b[0].length * (b[1].size - 1) - a[0].length * (a[1].size - 1));
  const bytes = dup.reduce((n, [l, s]) => n + l.length * (s.size - 1), 0);
  assert.strictEqual(dup.length, 0,
    `duplicazione rientrata in ${dup.length} blocchi / ${bytes} byte (es. ${dup.length ? dup[0][1].size + 'x ' + dup[0][0].slice(0, 60) : ''}): ` +
    'comprimi il prompt a un indice e punta a ops/harness.md, oppure dichiara il blocco in FLEET_SHARED_MARKERS');
});

ok('flotta: i blocchi canonici sono ancora in ogni file che deve portarli', () => {
  const agents = agentFiles();
  const problems = [];
  for (const [marker, min] of Object.entries(FLEET_SHARED_MIN)) {
    const n = agents.filter((a) => a.src.includes(marker)).length;
    if (n < min) problems.push(`${marker} → ${n}/${min} file`);
  }
  assert.deepStrictEqual(problems, [], 'blocchi canonici spariti dalla flotta: ' + problems.join(', '));
});

ok('flotta: ogni regola compressa esiste ancora in ops/harness.md', () => {
  const owner = read('ops/harness.md');
  const missing = OWNER_RULE_ANCHORS.filter((a) => !owner.includes(a));
  assert.deepStrictEqual(missing, [],
    'regole tolte dai prompt ma assenti dal proprietario ops/harness.md: ' + missing.join(', '));
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
