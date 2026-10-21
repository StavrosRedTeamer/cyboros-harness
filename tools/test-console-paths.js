// test-tags: loopback
// The console and the tools it runs must agree on ONE engagement tree. Two real defects
// proved they did not: /api/scope/check asked scope-guard about its default scope.json
// (the checkout) while /api/scope showed the configured one, and report-html read
// gate-log.md from __dirname/../reports (the checkout) instead of the configured data
// root. This test starts the server the way a buyer does — `--config <data>/cyboros.config.json`,
// with no CYBOROS_CONFIG/CC_ROOT/SCOPE_JSON in the environment — and proves, through the
// HTTP surface only, that:
//   · a scope entry written through the console makes /api/scope and /api/scope/check agree;
//   · a generated report read the data root's gate log and findings (generation succeeds,
//     embeds the seeded finding, lands in the data root);
//   · nothing was written into the repository's reports/ or scope.json.
// Run: node tools/test-console-paths.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { ok, summary, fixture, hermetic } = require('./testkit');

const WS = path.join(__dirname, '..');
const T = fixture('cyboros-console-paths');
hermetic('cyboros-console-paths-hermetic');   // state files of the fixtures stay out of the repo
const DATA = path.join(T, 'data');
const CONFIG = path.join(DATA, 'cyboros.config.json');
const REPORT_DIR = path.join(DATA, 'reports');
const MARKER = 'PATHS-PROOF-' + crypto.randomBytes(4).toString('hex');
const HOST = 'paths-proof.example';

// The environment a buyer has: the config file on the command line, NOT exported.
const SCRUBBED = [
  'CYBOROS_CONFIG', 'CC_ROOT', 'SCOPE_JSON', 'FINDINGS_JSONL', 'STATE_DB', 'GATE_LOG_FILE',
  'GATE_WS', 'LOOT_JSONL', 'SESSIONS_JSON', 'OPSTATE_FILE', 'BUDGET_STATE_FILE',
  'COVERAGE_REPORTS_DIR', 'EVIDENCE_INDEX_FILE', 'CC_OPSTATE_FILE', 'CC_APPROVALS_FILE',
  'GUI_PORT', 'GUI_HOST',
];
function cleanEnv() {
  const e = Object.assign({}, process.env);
  for (const k of SCRUBBED) delete e[k];
  return e;
}

const sha = (file) => { try { return crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex'); } catch { return null; } };
const repoReports = path.join(WS, 'reports');
const reportFiles = () => (() => { try { return fs.readdirSync(repoReports).filter((f) => /^report-.*\.html$/.test(f)).sort(); } catch { return []; } })();
const repoReportsBefore = reportFiles();
const repoGateLog = path.join(repoReports, 'gate-log.md');
const repoGateBefore = sha(repoGateLog);
const repoScopeBefore = sha(path.join(WS, 'scope.json'));

let child = null;
let port = null;
let cookie = null;
let log = '';

function request(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : JSON.stringify(body);
    const headers = { Host: '127.0.0.1:' + port };
    if (payload) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(payload); }
    if (cookie) headers.Cookie = cookie;
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c.toString(); });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: text }));
    });
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('request timeout: ' + urlPath)));
    if (payload) req.write(payload);
    req.end();
  });
}

async function main() {
  // ── a fresh configured installation, created the documented way ────────────
  const init = spawnSync(process.execPath, [path.join(WS, 'tools', 'init.js'), '--dir', DATA, '--admin', 'alice'],
    { cwd: WS, env: cleanEnv(), encoding: 'utf8', timeout: 30000 });
  assert.strictEqual(init.status, 0, 'init.js: ' + (init.stderr || init.stdout));
  const password = (String(init.stdout).match(/^\s{2}([A-Za-z0-9_-]{24,})\s*$/m) || [])[1];
  assert.ok(password, 'init printed the first admin password');
  assert.ok(fs.existsSync(CONFIG), 'init wrote the config into the data directory');

  child = spawn(process.execPath, [path.join(WS, 'tools', 'gui-server.js'), '--config', CONFIG, '--port', '0', '--print-port'],
    { cwd: WS, env: cleanEnv() });
  child.stdout.on('data', (d) => { log += d.toString(); });
  child.stderr.on('data', (d) => { log += d.toString(); });
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const m = log.match(/SCC_PORT=(\d+)/);
    if (m) { port = Number(m[1]); break; }
    if (/gui-server: configuration is not usable/.test(log)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(port, 'server listened (log: ' + log.slice(0, 400) + ')');

  const login = await request('POST', '/api/auth/login', { username: 'alice', password });
  assert.strictEqual(login.status, 200, 'login: ' + login.body);
  cookie = String(login.headers['set-cookie'][0]).split(';')[0];

  // ── the overview names the instance the browser is actually talking to ─────
  // Two consoles look identical while serving different trees. The rail shows the
  // instance line, so /api/overview has to carry it — and it must describe THIS root,
  // not the checkout the code happens to live in.
  const overview = JSON.parse((await request('GET', '/api/overview')).body);
  const inst = overview.instance || {};
  ok('the overview describes the served instance: port, data root, packaged install', () => {
    assert.strictEqual(inst.port, port, 'the port the browser is on');
    assert.ok(inst.host, 'the bound host is reported');
    assert.strictEqual(fs.realpathSync(inst.dataRoot), fs.realpathSync(DATA), 'the configured data root');
    assert.strictEqual(fs.realpathSync(inst.configFile), fs.realpathSync(CONFIG), 'the config file in use');
    assert.strictEqual(inst.packaged, true, 'data outside the code tree reads as a packaged install');
  });

  // The rail is the only place the instance line lives; it must read it from the
  // overview and must not fall back to naming engagement files at the operator.
  const appJs = (await request('GET', '/app.js')).body;
  ok('the status rail renders the instance and names no engagement files', () => {
    assert.ok(appJs.includes('o.instance'), 'the rail reads the instance from /api/overview');
    assert.ok(appJs.includes("k: 'instance'"), 'the rail has an instance cell');
    for (const leak of ['no operation-state.json', 'reports/state.db', 'reports/sessions.json']) {
      assert.ok(!appJs.includes(leak), 'status text still names an internal file: ' + leak);
    }
  });

  // ── defect 1: the scope the console writes is the scope the guard reads ────
  const written = await request('POST', '/api/scope', { allowed_hosts: [HOST], max_requests_per_second: 2 });
  assert.strictEqual(written.status, 200, 'scope write: ' + written.body);
  assert.strictEqual(JSON.parse(written.body).ok, true);

  const scopeNow = JSON.parse((await request('GET', '/api/scope')).body);
  assert.deepStrictEqual(scopeNow.allowed_hosts, [HOST], '/api/scope shows the entry just written');
  assert.strictEqual(scopeNow.failClosed, false);

  const check = await request('GET', '/api/scope/check?url=' + encodeURIComponent('http://' + HOST + '/login'));
  assert.strictEqual(check.status, 200);
  const verdict = JSON.parse(check.body);
  const outside = JSON.parse((await request('GET', '/api/scope/check?url=' +
    encodeURIComponent('http://not-authorized.example/'))).body);
  ok('/api/scope/check agrees with /api/scope about the configured authorization file', () => {
    assert.strictEqual(verdict.ok, true, 'scope check said: ' + check.body);
    assert.strictEqual(outside.ok, false, 'a host not in the configured file must be refused: ' + JSON.stringify(outside));
  });

  // ── defect 2: report generation reads the DATA ROOT's gate log + findings ──
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  fs.writeFileSync(path.join(REPORT_DIR, 'findings.jsonl'), JSON.stringify({
    id: 'paths-proof-1', title: MARKER, host: HOST, severity: 'Low', status: 'confirmed',
    ts: new Date().toISOString(), endpoint: '/login', cwe: 'CWE-79',
  }) + '\n');
  fs.writeFileSync(path.join(REPORT_DIR, 'gate-log.md'),
    `| 2026-10-20T00:00:00.000Z | cyboros/report | pass | host=${HOST}; ${MARKER}: seeded in the data root |\n`);

  ok('control: the repository gate log carries no report pass (so a wrong read would block)', () => {
    const repoLog = (() => { try { return fs.readFileSync(repoGateLog, 'utf8'); } catch { return ''; } })();
    assert.ok(!repoLog.includes('cyboros/report'), 'reports/gate-log.md now has a report pass; the negative control needs another root');
  });

  const gen = await request('POST', '/api/reports/generate');
  assert.strictEqual(gen.status, 202, 'generate: ' + gen.body);
  const jobId = JSON.parse(gen.body).jobId;

  let job = null;
  const jobDeadline = Date.now() + 30000;
  while (Date.now() < jobDeadline) {
    const jobs = JSON.parse((await request('GET', '/api/jobs')).body);
    job = jobs.find((j) => j.id === jobId) || null;
    if (job && job.state !== 'running') break;
    await new Promise((r) => setTimeout(r, 150));
  }
  assert.ok(job, 'job listed in /api/jobs');
  assert.strictEqual(job.state, 'done', 'report-html exited clean (read the data root gate log): ' +
    JSON.stringify({ state: job.state, exitCode: job.exitCode }));

  ok('the generated report landed in the configured reports directory, carrying the seeded finding', () => {
    const files = fs.readdirSync(REPORT_DIR).filter((f) => /^report-\d{8}T\d{5}\.html$/.test(f));
    assert.strictEqual(files.length, 1, 'one report in the data root: ' + files.join(', ') +
      ' (files: ' + fs.readdirSync(REPORT_DIR).join(',') + ')');
    const html = fs.readFileSync(path.join(REPORT_DIR, files[0]), 'utf8');
    assert.ok(html.includes(MARKER), 'the report embedded the finding read from the data root');
  });

  ok('nothing leaked into the repository: reports/ and scope.json are untouched', () => {
    assert.deepStrictEqual(reportFiles(), repoReportsBefore, 'the repository gained a generated report');
    assert.strictEqual(sha(repoGateLog), repoGateBefore, 'the repository gate log changed');
    assert.strictEqual(sha(path.join(WS, 'scope.json')), repoScopeBefore, 'the repository scope.json changed');
  });

  // ── the CLI reads the same tree the console wrote (no server involved) ─────
  const cli = spawnSync(process.execPath, [path.join(WS, 'tools', 'scope-guard.js'), 'check', 'http://' + HOST + '/'],
    { cwd: WS, env: Object.assign(cleanEnv(), { CYBOROS_CONFIG: CONFIG }), encoding: 'utf8', timeout: 20000 });
  ok('scope-guard CLI (only CYBOROS_CONFIG exported) answers about the same file', () => {
    assert.strictEqual(cli.status, 0, 'exit ' + cli.status + ': ' + (cli.stdout || cli.stderr));
  });

  ok('the gate CLI reads the data root gate log (host-scoped pass, absent from the repo)', () => {
    const r = spawnSync(process.execPath, [path.join(WS, 'tools', 'gate.js'), 'check', 'report', HOST],
      { cwd: WS, env: Object.assign(cleanEnv(), { CYBOROS_CONFIG: CONFIG }), encoding: 'utf8', timeout: 20000 });
    assert.strictEqual(r.status, 0, 'gate check exit ' + r.status + ': ' + (r.stdout || r.stderr));
    assert.match(r.stdout, /report PASS/);
  });
}

main()
  .then(() => {
    try { if (child) child.kill('SIGKILL'); } catch { /* ignore */ }
    fs.rmSync(T, { recursive: true, force: true });
    summary('console-paths');
  })
  .catch((e) => {
    try { if (child) child.kill('SIGKILL'); } catch { /* ignore */ }
    fs.rmSync(T, { recursive: true, force: true });
    console.error('  FAIL harness :: ' + (e && e.message ? e.message : e));
    console.error(String(log).slice(0, 1200));
    process.exit(1);
  });
