#!/usr/bin/env node
'use strict';
// tools/run-tests.js — runner aggregato e zero-dipendenze per l'intera suite tools/test-*.js.
//
// Perché esiste: prima i test erano una catena `&&` nel README che ne copriva ~27 su 60; il resto
// andava in drift silenzioso (es. 10 file con un path assoluto hardcoded rotti dopo lo spostamento
// della cartella, non intercettati perché fuori dalla catena). Questo runner scopre TUTTI i file
// test-*.js, li classifica e li esegue con timeout, così `node tools/run-tests.js` è l'unico gate.
//
// Classificazione (marker auto-documentante nell'header del test — riga `// test-tags: <t1,t2>`):
//   offline   (default, nessun marker)  eseguito sempre, con ALLOW_METADATA_TARGET RIMOSSO dall'env
//                                        (così un test "offline" non può dipendere di nascosto dall'opt-in).
//   loopback  (`// test-tags: loopback`) eseguito con ALLOW_METADATA_TARGET=1 (opt-in B9 esplicito e
//                                        documentato in ssrf-guard.js) — per gli E2E su server 127.0.0.1.
//   e2e       (`// test-tags: e2e`)      richiede rete/servizi live (es. test-mcp lancia chrome-devtools
//                                        via npx): SALTATO di default, incluso solo con --e2e.
//
// Uso:
//   node tools/run-tests.js                 # offline + loopback (il gate: verde a repo pulito)
//   node tools/run-tests.js --e2e           # include anche i test e2e-live
//   node tools/run-tests.js --list          # mostra la classificazione senza eseguire
//   node tools/run-tests.js --only scope    # esegue solo i test il cui nome contiene "scope"
//   node tools/run-tests.js --jobs 4        # parallelo (default 1 = sequenziale/deterministico)
//   node tools/run-tests.js --timeout 120000
//   node tools/run-tests.js --json          # output machine-readable su stdout (per CI)
//
// Exit code: 0 se nessun test ESEGUITO fallisce (gli skip non contano); 1 se almeno uno fallisce;
// 2 su errore d'uso. Fail-closed: un test che va in timeout o crasha conta come FAIL.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const TOOLS_DIR = __dirname;
const SELF = path.basename(__filename);

// ---- CLI ---------------------------------------------------------------------
function parseArgs(argv) {
  const o = { e2e: false, list: false, json: false, jobs: 1, timeout: 90000, only: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--e2e') o.e2e = true;
    else if (a === '--list') o.list = true;
    else if (a === '--json') o.json = true;
    else if (a === '--jobs' || a === '-j') o.jobs = Math.max(1, parseInt(argv[++i], 10) || 1);
    else if (a === '--timeout') o.timeout = Math.max(1000, parseInt(argv[++i], 10) || 90000);
    else if (a === '--only') o.only.push(...String(argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean));
    else if (a === '-h' || a === '--help') { o.help = true; }
    else { console.error(`run-tests: opzione sconosciuta "${a}" (usa --help)`); process.exit(2); }
  }
  return o;
}

// ---- discovery + classification ---------------------------------------------
function discover() {
  return fs.readdirSync(TOOLS_DIR)
    .filter((f) => /^test-[\w.-]+\.js$/.test(f) && f !== SELF)
    .sort()
    .map((f) => {
      const full = path.join(TOOLS_DIR, f);
      let head = '';
      try { head = fs.readFileSync(full, 'utf8').slice(0, 4096); } catch {}
      const m = head.match(/^\s*\/\/\s*test-tags:\s*([^\n#]+)/m);
      const tags = m ? m[1].split(/[,\s]+/).map((s) => s.trim()).filter(Boolean) : [];
      let group = 'offline';
      if (tags.includes('e2e')) group = 'e2e';
      else if (tags.includes('loopback')) group = 'loopback';
      return { name: f.replace(/\.js$/, ''), file: f, full, group };
    });
}

// ---- single-test execution (async, with hard timeout) ------------------------
function runOne(t, timeoutMs) {
  return new Promise((resolve) => {
    const env = Object.assign({}, process.env);
    if (t.group === 'loopback') env.ALLOW_METADATA_TARGET = '1';
    else delete env.ALLOW_METADATA_TARGET; // offline tests must not silently rely on the opt-in
    const started = Date.now();
    const child = spawn(process.execPath, [t.full], { cwd: path.join(TOOLS_DIR, '..'), env });
    let out = '';
    let timedOut = false;
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ...t, ok: false, ms: Date.now() - started, output: String(e && e.message || e), timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ...t, ok: !timedOut && code === 0, code, ms: Date.now() - started, output: out, timedOut });
    });
  });
}

// concurrency-limited runner (zero-dep). n=1 => strictly sequential/deterministic.
async function runAll(tests, jobs, timeoutMs, onDone) {
  const results = new Array(tests.length);
  let next = 0;
  async function worker() {
    while (next < tests.length) {
      const i = next++;
      const r = await runOne(tests[i], timeoutMs);
      results[i] = r;
      if (onDone) onDone(r);
    }
  }
  await Promise.all(Array.from({ length: Math.min(jobs, tests.length || 1) }, worker));
  return results;
}

function lastLines(s, n) {
  return String(s || '').split('\n').filter(Boolean).slice(-n).join('\n');
}

// ---- main --------------------------------------------------------------------
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(fs.readFileSync(__filename, 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'));
    return 0;
  }

  let tests = discover();
  if (opts.only.length) tests = tests.filter((t) => opts.only.some((q) => t.name.includes(q)));

  const runnable = tests.filter((t) => t.group !== 'e2e' || opts.e2e);
  const skipped = tests.filter((t) => t.group === 'e2e' && !opts.e2e);

  if (opts.list) {
    const by = { offline: [], loopback: [], e2e: [] };
    for (const t of tests) by[t.group].push(t.name);
    if (opts.json) { console.log(JSON.stringify(by, null, 2)); return 0; }
    for (const g of ['offline', 'loopback', 'e2e']) {
      console.log(`\n[${g}] (${by[g].length})`);
      for (const n of by[g]) console.log('  ' + n);
    }
    console.log(`\ntotale: ${tests.length} test (${runnable.length} eseguibili, ${skipped.length} e2e saltati senza --e2e)`);
    return 0;
  }

  if (!runnable.length) { console.error('run-tests: nessun test corrisponde'); return 2; }

  const t0 = Date.now();
  const human = !opts.json;
  if (human) console.error(`run-tests: ${runnable.length} test (jobs=${opts.jobs}, timeout=${opts.timeout}ms)${skipped.length ? `, ${skipped.length} e2e saltati` : ''}\n`);

  const results = await runAll(runnable, opts.jobs, opts.timeout, (r) => {
    if (!human) return;
    const tag = r.ok ? 'PASS' : (r.timedOut ? 'TIMEOUT' : 'FAIL');
    process.stderr.write(`${tag.padEnd(7)} ${String(r.ms).padStart(6)}ms  [${r.group}]  ${r.name}\n`);
  });

  const failed = results.filter((r) => !r.ok);
  const totalMs = Date.now() - t0;

  if (human && failed.length) {
    console.error('\n' + '='.repeat(60) + '\nFALLITI:\n');
    for (const r of failed) {
      console.error(`--- ${r.name} (${r.timedOut ? 'TIMEOUT' : 'exit ' + r.code}) ---`);
      console.error(lastLines(r.output, 15) + '\n');
    }
  }

  if (opts.json) {
    console.log(JSON.stringify({
      total: tests.length, run: runnable.length, passed: results.length - failed.length,
      failed: failed.length, skipped: skipped.length, durationMs: totalMs,
      results: results.map((r) => ({ name: r.name, group: r.group, ok: r.ok, ms: r.ms, code: r.code, timedOut: !!r.timedOut })),
      skippedTests: skipped.map((t) => t.name),
    }));
  } else {
    console.error('='.repeat(60));
    console.error(`PASS=${results.length - failed.length}  FAIL=${failed.length}  SKIP(e2e)=${skipped.length}  wall=${totalMs}ms`);
    if (failed.length) console.error('FALLITI: ' + failed.map((r) => r.name).join(', '));
  }
  return failed.length ? 1 : 0;
}

main().then((code) => process.exit(code)).catch((e) => { console.error(e); process.exit(2); });
