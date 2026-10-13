#!/usr/bin/env node
// test-benchgen.js — self-tests for tools/gen-bench.js (contamination-proof benchmark).
// Verifies: generation, determinism, anti-cheat (seed variance), boot, route leak,
// every vulnerability class actually triggers, and eval scoring both ways.
'use strict';

const { execFileSync, spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const TOOLS = __dirname;
const { findingBlob, matchesBenchPort } = require(path.join(TOOLS, 'gen-bench.js'));
const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'benchgen-'));
let failures = 0;

function check(name, cond, detail) {
  if (cond) console.log('PASS  ' + name);
  else { failures++; console.log('FAIL  ' + name + (detail ? ' — ' + detail : '')); }
}

function freePort() {
  return new Promise((resolve) => {
    const srv = http.createServer();
    srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)); });
  });
}

function httpReq(port, method, pathname, opts = {}) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname, headers: opts.headers }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: d }));
    });
    req.on('error', e => resolve({ error: e.message }));
    if (opts.body != null) req.write(opts.body);
    req.end();
  });
}

const b64url = s => Buffer.from(s).toString('base64').replace(/=+$/g, '');

async function waitUp(port, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try { const r = await httpReq(port, 'GET', '/'); if (r.status) return true; } catch (e) {}
    await new Promise(r => setTimeout(r, 100));
  }
  return false;
}

function genBench(seed, port, out) {
  return JSON.parse(execFileSync(process.execPath,
    [path.join(TOOLS, 'gen-bench.js'), 'new', '--seed', String(seed), '--port', String(port), '--out', out, '--json'],
    { encoding: 'utf8' }));
}

async function main() {
  const port = await freePort();
  const outDir = path.join(tmpBase, 'bench-main-' + port);

  // ── generation ──
  console.log('generating bench (seed 424242, port ' + port + ')...');
  const meta = genBench(424242, port, outDir);
  check('generator emits app.js + manifest.full.json',
    fs.existsSync(path.join(outDir, 'app.js')) && fs.existsSync(path.join(outDir, 'manifest.full.json')));
  const manifest = JSON.parse(fs.readFileSync(path.join(outDir, 'manifest.full.json'), 'utf8'));
  check('manifest has all 16 classes', manifest.classes.length === 16, 'got ' + manifest.classes.length);
  check('routes unique', new Set(manifest.classes.map(c => c.route)).size === manifest.classes.length);
  // Difesa strutturale sulla classe race: lo stato deve stare fuori dall'handler. Dentro, il `let`
  // viene rieseguito a ogni richiesta e il lost update è impossibile — bug silenzioso, perché il
  // test di trigger passava comunque (saldo fermo a 1000 < 1500).
  const appSrc = fs.readFileSync(path.join(outDir, 'app.js'), 'utf8');
  const balDecl = appSrc.match(/let BALANCE_\w+ = 1000;/);
  check('race state declared at module scope (before createServer), not inside the handler',
    !!balDecl && balDecl.index < appSrc.indexOf('http.createServer'),
    balDecl ? 'declaration at ' + balDecl.index + ', createServer at ' + appSrc.indexOf('http.createServer') : 'nessuna dichiarazione BALANCE trovata');
  check('black-box: manifest not inside workspace', outDir.startsWith(tmpBase));

  // ── determinism + anti-cheat ──
  const outDir2 = path.join(tmpBase, 'bench-same-' + port);
  const m2 = JSON.parse(fs.readFileSync(path.join(genBench(424242, port + 1, outDir2).dir, 'manifest.full.json'), 'utf8'));
  check('same seed → identical routes (deterministic)',
    JSON.stringify(manifest.classes.map(c => c.route)) === JSON.stringify(m2.classes.map(c => c.route)));
  const outDir3 = path.join(tmpBase, 'bench-diff-' + port);
  const m3 = JSON.parse(fs.readFileSync(path.join(genBench(999999, port + 2, outDir3).dir, 'manifest.full.json'), 'utf8'));
  check('different seed → different routes (anti-cheat)',
    JSON.stringify(manifest.classes.map(c => c.route)) !== JSON.stringify(m3.classes.map(c => c.route)));

  // ── boot + smoke ──
  const child = spawn(process.execPath, ['app.js'], { cwd: outDir, stdio: ['ignore', 'pipe', 'pipe'] });
  check('app boots and listens', await waitUp(port), 'port ' + port);
  const mainjs = await httpReq(port, 'GET', '/static/main.js');
  check('main.js leaks route registry (JS route-analysis surface)',
    mainjs.status === 200 && mainjs.body.includes('window.__API__'));

  // ── per-class trigger tests ──
  for (const c of manifest.classes) {
    const t = c.test;
    if (!t) {
      if (c.id === 'jwt') {
        const hdr = b64url(JSON.stringify({ alg: 'none', typ: 'JWT' }));
        const pl = b64url(JSON.stringify({ username: 'admin', role: 'admin' }));
        const r = await httpReq(port, 'GET', c.route + '/me', { headers: { Authorization: 'Bearer ' + hdr + '.' + pl + '.' } });
        check('trigger jwt (alg:none → admin)', r.status === 200 && r.body.includes('"role":"admin"'),
          'status=' + r.status + ' body=' + r.body.slice(0, 120));
      } else if (c.id === 'pp') {
        const p = await httpReq(port, 'POST', c.route, { headers: { 'Content-Type': 'application/json' }, body: '{"__proto__":{"polluted":true}}' });
        const g = await httpReq(port, 'GET', c.route + '/check');
        check('trigger pp (pollution confirmed)', p.status === 200 && g.status === 200 && g.body.includes('"polluted":true'),
          'post=' + p.status + ' check=' + g.body.slice(0, 120));
      } else {
        check('class ' + c.id + ' has a test', false, 'missing test definition');
      }
      continue;
    }
    if (t.parallel) {
      const before = await httpReq(port, 'GET', c.route);
      const b = JSON.parse(before.body).balance;
      const posts = [];
      for (let i = 0; i < t.parallel; i++) posts.push(httpReq(port, 'POST', t.path, { headers: { 'Content-Type': 'text/plain' }, body: t.body }));
      const res = await Promise.all(posts);
      const after = await httpReq(port, 'GET', c.route);
      const a = JSON.parse(after.body).balance;
      const target = b + t.parallel * Number(t.body);
      // Le due metà del TOCTOU: `a < target` da solo passava anche quando NON succedeva niente
      // (stato per-request → balance fermo a 1000, che è comunque < 1500). Il lost update si
      // distingue dal "non è successo nulla" solo se il saldo è salito: serve `a > b`.
      check('trigger race (final ' + a + ' < ' + target + ', and deposits landed: ' + (a > b) + ')',
        res.every(r => r.status === t.expectStatus) && a < target && a > b,
        'before=' + b + ' after=' + a + ' — se after===before i depositi non sono mai arrivati, '
        + 'non è un lost update: è stato assente');
      continue;
    }
    const r = await httpReq(port, t.method, t.path, { headers: t.headers, body: t.body });
    const okStatus = r.status === t.expectStatus;
    const okBody = t.expectInBody ? r.body.includes(t.expectInBody) : true;
    const okHeader = t.expectHeader ? Object.entries(t.expectHeader).every(([k, v]) => (r.headers[k.toLowerCase()] || '') === v) : true;
    check('trigger ' + c.id + ' (status ' + r.status + ')', okStatus && okBody && okHeader,
      'status=' + r.status + (t.expectInBody && !okBody ? ' body-missing=' + t.expectInBody : '')
      + (t.expectHeader && !okHeader ? ' header-mismatch' : '') + ' body=' + r.body.slice(0, 100).replace(/\n/g, ' '));
  }

  // ── eval: empty findings → 0 ──
  const emptyFindings = path.join(tmpBase, 'empty.jsonl');
  fs.writeFileSync(emptyFindings, '');
  const ev0 = JSON.parse(execFileSync(process.execPath, [path.join(TOOLS, 'gen-bench.js'), 'eval', outDir, '--findings', emptyFindings, '--json', '--no-history'], { encoding: 'utf8' }));
  check('eval with no findings → 0 detected', ev0.detected === 0, 'detected=' + ev0.detected);

  // ── matcher: unit (port attribution) ──
  check('unit: explicit bench port matches', matchesBenchPort('get http://127.0.0.1:' + port + '/x', { host: '127.0.0.1' }, port));
  check('unit: explicit OTHER port does not match', !matchesBenchPort('get http://127.0.0.1:3000/x', { host: '127.0.0.1' }, port));
  check('unit: no port cited + loopback host matches', matchesBenchPort('get /api/x?q=1', { host: '127.0.0.1' }, port));
  check('unit: no port cited + localhost matches', matchesBenchPort('get /api/x?q=1', { host: 'localhost' }, port));
  check('unit: no port cited + remote host does not match', !matchesBenchPort('get /api/x?q=1', { host: 'example.com' }, port));
  check('unit: blob lowercases and includes cwe/poc fields',
    findingBlob({ title: 'SQL Injection', cwe: 'CWE-89', poc: 'GET /a?q=UNION' }).includes('cwe-89') && findingBlob({ poc: '/A?q=' }).includes('/a?q='));

  // ── eval: findings nel formato REALE di record-finding.js (host senza porta) ──
  // Il vecchio matcher richiedeva `:<port>` nel blob e segnava MISSED finding reali:
  // regressione dedicata (bug trovato sul bench seed 3412: score 2/15 invece di 12/15).
  const hostShapeFindings = path.join(tmpBase, 'host-shape.jsonl');
  const hostLines = manifest.classes.map(c => JSON.stringify({
    title: c.title, type: c.title, host: '127.0.0.1', endpoint: 'GET ' + c.route,
    poc: 'GET ' + c.route + ' -> 200', severity: c.severity,
    status: 'verified', verify_level: 'proven_impact', cwe: c.cwe,
  }));
  fs.writeFileSync(hostShapeFindings, hostLines.join('\n') + '\n');
  const ev2 = JSON.parse(execFileSync(process.execPath, [path.join(TOOLS, 'gen-bench.js'), 'eval', outDir, '--findings', hostShapeFindings, '--json', '--no-history'], { encoding: 'utf8' }));
  check('eval with record-finding shape (host, no port) → all detected (' + ev2.detected + '/' + manifest.classes.length + ')',
    ev2.detected === manifest.classes.length);

  // ── eval: stessi keyword ma host fuori dal bench → 0 ──
  const wrongHost = path.join(tmpBase, 'wrong-host.jsonl');
  fs.writeFileSync(wrongHost, manifest.classes.map(c => JSON.stringify({
    title: c.title, type: c.title, host: 'example.com', endpoint: 'GET ' + c.route, status: 'verified',
  })).join('\n') + '\n');
  const ev3 = JSON.parse(execFileSync(process.execPath, [path.join(TOOLS, 'gen-bench.js'), 'eval', outDir, '--findings', wrongHost, '--json', '--no-history'], { encoding: 'utf8' }));
  check('eval with matching keywords but foreign host → 0 detected', ev3.detected === 0, 'detected=' + ev3.detected);
  check('findings su un altro host sono CONTATI fra gli esclusi, non spariti',
    ev3.unattributed === manifest.classes.length, 'unattributed=' + ev3.unattributed);

  // ── un finding che cita un'altra porta non puo' uscire dal report in silenzio ──
  // Era il buco piu' subdolo della misura: "precision 100% su 3 finding" e "precision 100%
  // su 30 finding di cui 27 esclusi" erano la stessa riga di report.
  const otherPort = path.join(tmpBase, 'other-port.jsonl');
  fs.writeFileSync(otherPort, [
    JSON.stringify({ id: 'keep', title: manifest.classes[0].title, host: '127.0.0.1', endpoint: 'http://127.0.0.1:' + port + manifest.classes[0].route, status: 'verified' }),
    JSON.stringify({ id: 'drop', title: manifest.classes[0].title + ' (OOB)', host: '127.0.0.1', endpoint: manifest.classes[0].route, poc: 'listener 127.0.0.1:9090, GET ' + manifest.classes[0].route + ' -> 200' }),
  ].join('\n') + '\n');
  const evDrop = JSON.parse(execFileSync(process.execPath, [path.join(TOOLS, 'gen-bench.js'), 'eval', outDir, '--findings', otherPort, '--json', '--no-history'], { encoding: 'utf8' }));
  check('un finding che cita un`altra porta è escluso MA conteggiato',
    evDrop.unattributed === 1 && evDrop.unattributedList[0] === 'drop' && evDrop.reported === 1,
    'unattributed=' + evDrop.unattributed + ' reported=' + evDrop.reported);

  // ── contaminazione: un finding che ricopia il manifest verbatim viene segnalato ──
  const leaky = path.join(tmpBase, 'leaky.jsonl');
  const ssrf = manifest.classes.find(c => c.id === 'ssrf');
  fs.writeFileSync(leaky, JSON.stringify({
    id: 'leaky', title: 'SSRF on the search endpoint', host: '127.0.0.1',
    endpoint: 'http://127.0.0.1:' + port + ssrf.route, poc: ssrf.trigger, status: 'inconclusive',
  }) + '\n');
  const evLeak = JSON.parse(execFileSync(process.execPath, [path.join(TOOLS, 'gen-bench.js'), 'eval', outDir, '--findings', leaky, '--json', '--no-history'], { encoding: 'utf8' }));
  check('un finding che cita il trigger del manifest verbatim è segnalato come contaminazione',
    evLeak.contamination.suspect.length === 1 && evLeak.contamination.suspect[0].class === 'ssrf',
    JSON.stringify(evLeak.contamination));
  const evLeakGate = spawnSync(process.execPath, [path.join(TOOLS, 'gen-bench.js'), 'eval', outDir, '--findings', leaky, '--json', '--no-history', '--fail-on-contamination'], { encoding: 'utf8' });
  check('--fail-on-contamination → exit 1 (la contaminazione può essere bloccante)',
    evLeakGate.status === 1 && /contamination/.test(JSON.parse(evLeakGate.stdout).gate.failures.join(' ')),
    'status=' + evLeakGate.status);
  // Regressione: `test.expectInBody` NON e' ground truth, e' il payload che il bersaglio
  // accetta. Con quel campo fra i segnali, ogni finding XSS corretto veniva flaggato come
  // contaminato — un gate che punisce la risposta giusta e lascia passare quella falsa.
  const xss = manifest.classes.find(c => c.id === 'xss');
  const canonicalXss = path.join(tmpBase, 'xss-canonical.jsonl');
  fs.writeFileSync(canonicalXss, JSON.stringify({
    id: 'xss-ok', title: 'Cross-site scripting in name parameter', host: '127.0.0.1',
    endpoint: 'http://127.0.0.1:' + port + xss.route, status: 'inconclusive', verify_level: 'triggered',
    poc: 'GET ' + xss.route + '?name=' + encodeURIComponent('<script>alert(1)</script>') + ' -> 200 body echoes <h1>Hello <script>alert(1)</script></h1>, reflected unencoded',
  }) + '\n');
  const evXss = JSON.parse(execFileSync(process.execPath, [path.join(TOOLS, 'gen-bench.js'), 'eval', outDir, '--findings', canonicalXss, '--json', '--no-history', '--fail-on-contamination'], { encoding: 'utf8' }));
  check('un finding XSS canonico NON è contaminazione (il payload è il bersaglio, non la risposta)',
    evXss.contamination.suspect.length === 0 && evXss.gate.passed === true,
    JSON.stringify(evXss.contamination.suspect));
  check('e il finding XSS canonico viene comunque conteggiato come rilevato',
    evXss.detected === 1 && evXss.precisionPct === 100, 'detected=' + evXss.detected);

  // ── eval: correct findings → all detected ──
  const goodFindings = path.join(tmpBase, 'good.jsonl');
  const lines = manifest.classes.map(c => JSON.stringify({
    id: 'bench-' + c.id, title: c.title, type: c.title,
    target: 'http://127.0.0.1:' + port, endpoint: c.route, severity: c.severity,
    status: 'verified', verify_level: 'proven_impact',
  }));
  fs.writeFileSync(goodFindings, lines.join('\n') + '\n');
  const ev1 = JSON.parse(execFileSync(process.execPath, [path.join(TOOLS, 'gen-bench.js'), 'eval', outDir, '--findings', goodFindings, '--json', '--no-history'], { encoding: 'utf8' }));
  check('eval with correct findings → all detected (' + ev1.detected + '/' + manifest.classes.length + ')',
    ev1.detected === manifest.classes.length);
  check('route-confirmed ≥ all classes', ev1.routeConfirmed >= manifest.classes.length, 'routeConfirmed=' + ev1.routeConfirmed);
  check('verified ≥ all classes', ev1.verified >= manifest.classes.length, 'verified=' + ev1.verified);

  // ── precision: findings on the bench that map to no seeded class are FPs ──
  // The failure mode the whole project exists to prevent is a harness that
  // reports everything. A recall-only benchmark cannot see it, so pin it here:
  // perfect recall plus junk findings must score <100% precision.
  check('correct findings → 100% precision (0 FP)',
    ev1.falsePositives === 0 && ev1.precisionPct === 100,
    'fp=' + ev1.falsePositives + ' precision=' + ev1.precisionPct + '%');
  check('finding puliti: zero contaminazione sospetta e zero esclusi',
    ev1.contamination.suspect.length === 0 && ev1.unattributed === 0,
    JSON.stringify({ c: ev1.contamination.suspect.length, u: ev1.unattributed }));
  const noisyFindings = path.join(tmpBase, 'noisy.jsonl');
  fs.writeFileSync(noisyFindings,
    lines.join('\n') + '\n' + [
      { id: 'fp-1', title: 'Reflected XSS in nonexistent banner param', host: '127.0.0.1', endpoint: '/totally/unknown/route', target: 'http://127.0.0.1:' + port, severity: 'High', status: 'verified', verify_level: 'proven_impact' },
      { id: 'fp-2', title: 'SQL injection in admin report export', host: '127.0.0.1', endpoint: '/another/fake/route', target: 'http://127.0.0.1:' + port, severity: 'Critical', status: 'verified', verify_level: 'proven_impact' },
    ].map(o => JSON.stringify(o)).join('\n') + '\n');
  const evNoisy = JSON.parse(execFileSync(process.execPath, [path.join(TOOLS, 'gen-bench.js'), 'eval', outDir, '--findings', noisyFindings, '--json', '--no-history'], { encoding: 'utf8' }));
  check('junk findings on-target are counted as false positives',
    evNoisy.falsePositives === 2, 'fp=' + evNoisy.falsePositives);
  check('recall still 100% while precision drops below 100%',
    evNoisy.detected === manifest.classes.length && evNoisy.precisionPct < 100,
    'detected=' + evNoisy.detected + ' precision=' + evNoisy.precisionPct + '%');
  check('false-positive list is reported for triage',
    Array.isArray(evNoisy.falsePositiveList) && evNoisy.falsePositiveList.length === 2);
  check('no findings reported → 100% precision (nothing to be false about)',
    ev3.precisionPct === 100 && ev3.reported === 0, 'reported=' + ev3.reported);

  // ── gate: una soglia rende eval utilizzabile in una pipeline ──
  // La tesi è che la precisione sia un numero verificabile che qualcuno può mettere nel
  // proprio gate. Qui si pinna l'exit code, non solo che il numero venga stampato.
  const runEval = (args) => spawnSync(process.execPath, [path.join(TOOLS, 'gen-bench.js'), 'eval', ...args], { encoding: 'utf8' });
  const gateOk = runEval([outDir, '--findings', goodFindings, '--json', '--no-history', '--fail-under-precision', '90', '--fail-under-recall', '90']);
  check('gate: clean findings above the thresholds → exit 0', gateOk.status === 0, 'status=' + gateOk.status);
  const gateOkJson = JSON.parse(gateOk.stdout);
  check('gate: JSON output carries a schema and a passed gate',
    gateOkJson.schema === 'bench-eval/1' && gateOkJson.gate.gated === true && gateOkJson.gate.passed === true);
  const gateBad = runEval([outDir, '--findings', noisyFindings, '--json', '--no-history', '--fail-under-precision', '99']);
  check('gate: findings below the precision threshold → exit 1', gateBad.status === 1, 'status=' + gateBad.status);
  check('gate: the failure names the metric and both numbers',
    JSON.parse(gateBad.stdout).gate.failures.some(f => /precision .* < 99%/.test(f)),
    JSON.stringify(JSON.parse(gateBad.stdout).gate.failures));
  check('gate: without a threshold eval still exits 0 (a report, not a gate)',
    runEval([outDir, '--findings', noisyFindings, '--json', '--no-history']).status === 0);
  check('gate: a bad threshold value exits 2',
    runEval([outDir, '--findings', goodFindings, '--fail-under-precision', 'high']).status === 2);

  // ── findings as a JSON array: what most harnesses emit, not JSONL ──
  const findingsArray = path.join(tmpBase, 'findings.json');
  fs.writeFileSync(findingsArray, JSON.stringify(manifest.classes.map(c => ({
    id: 'bench-' + c.id, title: c.title, host: '127.0.0.1', endpoint: c.route,
    target: 'http://127.0.0.1:' + port, status: 'verified', verify_level: 'proven_impact',
  })), null, 2));
  const evArr = JSON.parse(execFileSync(process.execPath, [path.join(TOOLS, 'gen-bench.js'), 'eval', outDir, '--findings', findingsArray, '--json', '--no-history'], { encoding: 'utf8' }));
  check('eval accepts findings as a JSON array', evArr.detected === manifest.classes.length, 'detected=' + evArr.detected);

  // ── un file mancante è un errore, non uno zero silenzioso: un gate che legge il file
  // sbagliato e passa (precision 100% su nulla) è peggio di nessun gate ──
  check('eval with a missing --findings file exits 2',
    runEval([outDir, '--findings', path.join(tmpBase, 'nope.jsonl'), '--json', '--no-history']).status === 2);

  // ── history tracking: una riga jsonl per eval (cwd isolato in tmpBase) ──
  const ev4 = JSON.parse(execFileSync(process.execPath, [path.join(TOOLS, 'gen-bench.js'), 'eval', outDir, '--findings', goodFindings, '--json', '--agent', 'test-harness', '--model', 'test-model'], { encoding: 'utf8', cwd: tmpBase }));
  const histPath = path.join(tmpBase, 'reports', 'bench-history.jsonl');
  check('eval appends bench-history.jsonl', fs.existsSync(histPath));
  if (fs.existsSync(histPath)) {
    const hist = fs.readFileSync(histPath, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
    const last = hist[hist.length - 1];
    check('history entry has trend fields (seed/detectedPct/missed)',
      hist.length === 1 && last.seed === 424242 && typeof last.detectedPct === 'number' && Array.isArray(last.missed),
      'entries=' + hist.length);
    check('--json summary reports history note', typeof ev4.history === 'string' && ev4.history.includes('#1'));
    // La provenienza viaggia con la riga. Un punteggio che dice solo "73% precision" non
    // riproduce niente: senza agente, modello e seed la cifra non è citabile.
    check('history entry carries the agent and model under test',
      last.agent === 'test-harness' && last.model === 'test-model' && last.seed === 424242,
      'agent=' + last.agent + ' model=' + last.model);
  check('--json summary carries the same provenance',
    ev4.agent === 'test-harness' && ev4.model === 'test-model');
  const ev5 = JSON.parse(execFileSync(process.execPath, [path.join(TOOLS, 'gen-bench.js'), 'eval', outDir, '--findings', goodFindings, '--json', '--note', 'budget: 12/16 classi tentate'], { encoding: 'utf8', cwd: tmpBase }));
  check('--note viaggia con la riga di history e con il JSON',
    ev5.note === 'budget: 12/16 classi tentate' &&
    JSON.parse(fs.readFileSync(histPath, 'utf8').split('\n').filter(Boolean).pop()).note === 'budget: 12/16 classi tentate',
    'note=' + ev5.note);
  }

  // ── cleanup ──
  try { child.kill('SIGTERM'); } catch (e) {}
  for (const d of [outDir, outDir2, outDir3]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} }
  try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch (e) {}

  console.log(failures ? '\n' + failures + ' FAILURES' : '\nALL PASS');
  process.exit(failures ? 1 : 0);
}

main().catch(e => { console.error('test crashed: ' + e.stack); process.exit(2); });
