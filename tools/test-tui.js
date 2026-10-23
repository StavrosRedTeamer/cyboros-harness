#!/usr/bin/env node
// Offline tests for runtime/tui.js — the interactive terminal surface.
//
// What is being protected:
//   · the REPL takes its authorization from scope.json through tools/scope-guard,
//     fail-closed: no scope file or an empty one refuses every target;
//   · an out-of-scope target, explicit or positional, changes nothing and exits 1;
//   · a confirm-tier approval without a TTY does not auto-accept: it stops the run;
//   · the scripted demo still shows the approval, the tool call and the finding;
//   · --no-color / TERM=dumb renders ASCII only and never exceeds 100 columns.
//
// Run: node tools/test-tui.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { ok, fixture, writeScope, summary } = require('./testkit');

const TUI = path.join(__dirname, '..', 'runtime', 'tui.js');
const DIR = fixture('tui');
const SCOPE = writeScope(DIR, {
  allowed_hosts: ['app.example.com', 'api.example.com'],
  allowed_ips: ['127.0.0.1'],
  max_requests_per_second: 2,
});
const FINDINGS = path.join(DIR, 'findings.jsonl');
const MISSING_FINDINGS = path.join(DIR, 'missing-findings.jsonl');
const SESSIONS = path.join(DIR, 'sessions');
const NO_SCOPE = path.join(DIR, 'absent-scope.json');

function run(args, opts) {
  const o = opts || {};
  const env = Object.assign({}, process.env, {
    NO_COLOR: '1',
    TERM: 'dumb',
    SCOPE_JSON: SCOPE,
    FINDINGS_JSONL: MISSING_FINDINGS,
    CYBOROS_SESSIONS_DIR: SESSIONS,
  });
  for (const [k, v] of Object.entries(o.env || {})) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  const r = spawnSync(process.execPath, [TUI].concat(args), {
    input: o.input == null ? '' : o.input,
    encoding: 'utf8',
    timeout: 20000,
    env,
  });
  const out = (r.stdout || '') + (r.stderr || '');
  return { status: r.status, out, lines: out.replace(/\r/g, '').split('\n') };
}

const strip = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');
const UNICODE_DRAWING = /[\u2500-\u259F\u25A0-\u25FF\u2700-\u27BF\u23B0-\u23FF\u276F\u2026\u2014\u2019\u2018\u00B7\u2192\u2190]/;

ok('--help documents the flags and the exit codes', () => {
  const r = run(['--help']);
  assert.strictEqual(r.status, 0);
  assert.ok(r.out.includes('--scope <file>'), 'documents --scope');
  assert.ok(r.out.includes('--no-color'), 'documents --no-color');
  assert.ok(r.out.includes('Exit'), 'documents exit codes');
  assert.ok(!r.out.includes('--api-key'), 'no secret-bearing flag');
});

ok('--version prints the version', () => {
  const r = run(['--version']);
  assert.strictEqual(r.status, 0);
  assert.match(r.out.trim(), /^\d+\.\d+\.\d+/);
});

ok('interactive mode without a TTY and without --script exits 2', () => {
  const r = run([]);
  assert.strictEqual(r.status, 2);
  assert.ok(r.out.includes('needs a TTY'), 'says a TTY is required');
});

ok('the REPL lists the real scope.json through scope-guard', () => {
  const r = run(['--script'], { input: '/scope\n/quit\n' });
  assert.strictEqual(r.status, 0);
  assert.ok(r.out.includes('app.example.com'), 'shows an allowed host');
  assert.ok(r.out.includes('api.example.com'), 'shows the second allowed host');
  assert.ok(r.out.includes('fail-closed'), 'states fail-closed');
  assert.ok(strip(r.out).includes('REAL'), 'marks the scope as real');
});

ok('a host check reports IN SCOPE for an allowed host', () => {
  const r = run(['--script'], { input: '/scope app.example.com\n/quit\n' });
  assert.strictEqual(r.status, 0);
  assert.ok(r.out.includes('IN SCOPE'), 'allow verdict is visible');
  assert.ok(r.out.includes('host allowlisted'), 'shows the guard reason');
});

ok('an out-of-scope /target is refused and leaves the target unchanged', () => {
  const r = run(['--script'], { input: '/target evil.example\n/status\n/quit\n' });
  assert.strictEqual(r.status, 0, 'a REPL refusal is not a process failure');
  assert.ok(r.out.includes('evil.example is out of scope'), 'refusal is explicit');
  assert.ok(r.out.includes('not in allowed_hosts'), 'shows the guard reason');
  assert.ok(r.out.includes('target unchanged'), 'says nothing changed');
  assert.ok(r.out.includes('target: -'), 'target stays empty');
});

ok('an in-scope /target is accepted and shown in the status card', () => {
  const r = run(['--script'], { input: '/target app.example.com\n/status\n/quit\n' });
  assert.strictEqual(r.status, 0);
  assert.ok(r.out.includes('target app.example.com IN SCOPE'), 'accepts the target');
  assert.ok(r.out.includes('target: app.example.com'), 'status card carries it');
});

ok('a positional out-of-scope target fails closed with exit 1', () => {
  const r = run(['evil.example', '--script'], { input: '/quit\n' });
  assert.strictEqual(r.status, 1);
  assert.ok(r.out.includes('evil.example is out of scope'), 'refuses at startup');
  assert.ok(r.out.includes('nothing was run'), 'no side effect');
});

ok('a positional in-scope target is adopted', () => {
  const r = run(['app.example.com', '--script'], { input: '/quit\n' });
  assert.strictEqual(r.status, 0);
  assert.ok(r.out.includes('app.example.com . recon-map'), 'status line carries the host');
});

ok('--scope <file> is honored over SCOPE_JSON', () => {
  const r = run(['--scope', SCOPE, '--script'], {
    input: '/scope\n/quit\n',
    env: { SCOPE_JSON: NO_SCOPE },
  });
  assert.strictEqual(r.status, 0);
  assert.ok(r.out.includes('app.example.com'), 'reads the explicit file');
  assert.ok(r.out.includes('REAL'), 'still a real authorization');
});

ok('a missing scope.json authorizes nothing (fail-closed)', () => {
  const r = run(['--script'], {
    input: '/scope\n/target app.example.com\n/quit\n',
    env: { SCOPE_JSON: NO_SCOPE },
  });
  assert.strictEqual(r.status, 0);
  assert.ok(r.out.includes('MISSING'), 'badge says the file is missing');
  assert.ok(r.out.includes('scope.json missing'), 'explains the consequence');
  assert.ok(/verdict\s+scope\.json missing/.test(r.out),
    'the refusal names the missing file instead of calling it empty');
  assert.ok(r.out.includes('app.example.com is out of scope'), 'refuses the target');
});

ok('the demo asks for confirm-tier approval and completes only with --demo-approve', () => {
  const r = run(['--demo', '--fast', '--demo-approve'], { input: '' });
  assert.strictEqual(r.status, 0);
  assert.ok(r.out.includes('Permission required'), 'approval prompt is shown');
  assert.ok(r.out.includes('confirm-tier'), 'the tier is named');
  assert.ok(r.out.includes('run_tool(sqlmap'), 'approved tool call runs');
  assert.ok(r.out.includes('verify_level triggered'), 'finding carries the proof level');
  assert.ok(r.out.includes('7/240 req'), 'budget advanced');
});

ok('without a TTY the confirm-tier approval stops the run and exits 1', () => {
  const r = run(['--demo', '--fast'], { input: '' });
  assert.strictEqual(r.status, 1);
  assert.ok(r.out.includes('stdin is not a TTY'), 'refusal names the cause');
  assert.ok(!r.out.includes('run_tool(sqlmap'), 'the intrusive call did not run');
  assert.ok(r.out.includes('hypothesis stays suspected'), 'finding is not promoted');
});

ok('--allow-cloud connects at launch instead of opening a shell', () => {
  const r = run(['--allow-cloud', '--script'], {
    input: '',
    env: {
      EXPERIENTIAL_API_KEY: undefined,
      OPENROUTER_API_KEY: undefined,
      XDG_CONFIG_HOME: path.join(DIR, 'no-keys'),
    },
  });
  assert.strictEqual(r.status, 5, 'a live launch without a usable provider exits 5');
  assert.ok(/provider key missing|provider config not found/.test(r.out), 'it tried to connect');
});

ok('a blocked approval inside the REPL does not poison the process exit code', () => {
  const r = run(['--script'], { input: '/demo sqli\n/quit\n' });
  assert.strictEqual(r.status, 0);
  assert.ok(r.out.includes('stdin is not a TTY'), 'approval still fails closed');
  assert.ok(r.out.includes('session closed'), 'the REPL keeps going');
});

ok('/scope real returns from the demo to scope.json', () => {
  const r = run(['--script'], { input: '/demo sqli\n/scope real\n/quit\n' });
  assert.strictEqual(r.status, 0);
  assert.ok(r.out.includes('scope REAL'), 'switches back to the real file');
  assert.ok(r.out.includes('app.example.com'), 'lists the real authorization');
});

ok('unknown commands and invalid phases are rejected without exiting', () => {
  // --config points at a fixture path so the check does not depend on whether the
  // operator has a real (gitignored) runtime/providers.json in this checkout.
  const missing = path.join(SESSIONS, 'no-such-providers.json');
  const r = run(['--script', '--config', missing], { input: '/nope\n/phase bogus\n/class bogus\n/model bogus\n/quit\n' });
  assert.strictEqual(r.status, 0);
  assert.ok(r.out.includes('unknown command /nope'), 'unknown command');
  assert.ok(r.out.includes('unknown phase bogus'), 'unknown phase');
  assert.ok(r.out.includes('unknown class bogus'), 'unknown class');
  assert.ok(r.out.includes('no-such-providers.json not found'), 'provider config is reported honestly');
});

ok('--phase and --class are validated at launch like the commands that set them', () => {
  const phase = run(['--script', '--phase', 'web-testt'], { input: '/quit\n' });
  assert.strictEqual(phase.status, 2, 'a typo is a usage error');
  assert.ok(phase.out.includes('unknown phase "web-testt"'), 'names the typo');
  const klass = run(['--script', '--class', 'sqlii'], { input: '/quit\n' });
  assert.strictEqual(klass.status, 2, 'a typo is a usage error');
  assert.ok(klass.out.includes('unknown class "sqlii"'), 'names the typo');
});

ok('/demo rejects an unknown mode, and /clear does not claim a clear it did not do', () => {
  const r = run(['--script'], { input: '/demo xss\n/clear\n/quit\n' });
  assert.strictEqual(r.status, 0);
  assert.ok(r.out.includes('/demo [sqli|idor]'), 'an unknown mode prints usage');
  assert.ok(!r.out.includes('Test SQL injection'), 'no walkthrough was run instead');
  assert.ok(r.out.includes('nothing to clear'), 'a non-TTY clear says it cleared nothing');
});

ok('/thinking toggles the reasoning renderer and rejects a bad argument', () => {
  const r = run(['--script'], { input: '/thinking off\n/thinking\n/thinking bogus\n/quit\n' });
  assert.strictEqual(r.status, 0);
  assert.ok(r.out.includes('thinking off'), 'the toggle is reported');
  assert.ok(r.out.includes('/thinking [on|off]'), 'a bad argument prints usage');
});

ok('/findings reads the ledger read-only and wraps long rows', () => {
  fs.writeFileSync(FINDINGS, [
    JSON.stringify({ severity: 'Medium', title: 'IDOR candidate on an order object', endpoint: '/api/orders/42', verify_level: 'triggered', status: 'inconclusive' }),
    JSON.stringify({ severity: 'Low', title: 'SQL injection — error-based', host: 'app.example.com', verify_level: 'suspected', status: 'inconclusive' }),
  ].join('\n') + '\n');
  const r = run(['--script'], { input: '/findings\n/gate\n/quit\n', env: { FINDINGS_JSONL: FINDINGS } });
  assert.strictEqual(r.status, 0);
  assert.ok(r.out.includes('2 finding(s)'), 'counts the ledger');
  assert.ok(r.out.includes('IDOR candidate'), 'shows the title');
  assert.ok(r.out.includes('verify_level suspected'), 'shows the proof level');
  assert.ok(r.out.includes('1 finding(s) at verify_level suspected'), 'gate counts pending');
  assert.ok(r.out.includes('read-only'), 'states the surface is read-only');
});

ok('/findings says so when the ledger is absent', () => {
  const r = run(['--script'], { input: '/findings\n/quit\n', env: { FINDINGS_JSONL: MISSING_FINDINGS } });
  assert.strictEqual(r.status, 0);
  assert.ok(r.out.includes('no findings ledger yet'), 'does not invent findings');
  assert.ok(!r.out.includes('corrupt'), 'absence is not corruption');
});

ok('/findings distinguishes a corrupt ledger from an absent one', () => {
  const bad = path.join(DIR, 'corrupt-findings.jsonl');
  fs.writeFileSync(bad, JSON.stringify({ severity: 'Low', title: 'one good row', verify_level: 'suspected' }) + '\n{not json\n');
  const r = run(['--script'], { input: '/findings\n/gate\n/quit\n', env: { FINDINGS_JSONL: bad } });
  assert.strictEqual(r.status, 0);
  assert.ok(r.out.includes('the findings ledger is corrupt'), 'names corruption');
  assert.ok(r.out.includes('line 2 is not JSON'), 'names the line');
  assert.ok(r.out.includes('shown as a warning, not a pass'), 'does not present the readable rows as the ledger');
  assert.ok(r.out.includes('one good row'), 'still shows the rows it could read');
  assert.ok(!r.out.includes('no findings ledger yet'), 'does not call corruption absence');
  assert.ok(r.out.includes('the findings ledger cannot be read'), '/gate refuses to count pending');
});

ok('a ledger line that parses but is not a finding object is a verdict, not a crash', () => {
  // JSON.parse accepts `null`: rendering it threw on the first property read and took the
  // REPL with it (exit 1). The other scalar shapes hit the same guard, asserted below.
  const file = path.join(DIR, 'not-a-finding.jsonl');
  fs.writeFileSync(file, 'null\n');
  const r = run(['--script'], { input: '/findings\n/gate\n/quit\n', env: { FINDINGS_JSONL: file } });
  assert.strictEqual(r.status, 0, 'the REPL survives');
  assert.ok(!r.out.includes('fatal:'), 'no exception escaped the read');
  assert.ok(r.out.includes('line 1 is not a finding object'), 'names the shape');
  assert.ok(r.out.includes('the findings ledger cannot be read'), '/gate refuses to count');
});

ok('readFindings returns one verdict shape whatever the outcome', () => {
  // Three shapes meant each caller had to know which fields a verdict carried; a caller
  // asking for a field another outcome omits is a crash waiting for a corrupt file.
  // The probe loads the module by resolved path: it is a new file not yet committed, so a
  // literal require here would (rightly) fail tools/test-lint.js.
  const ledgerMod = path.join(__dirname, '..', 'runtime', 'findings.js');
  if (!fs.existsSync(ledgerMod)) { console.log('    SKIP runtime/findings.js non presente in questo checkout'); return; }
  const good = path.join(DIR, 'shape-good.jsonl');
  fs.writeFileSync(good, JSON.stringify({ severity: 'Low', title: 'x' }) + '\n');
  const scalars = ['null\n', '124\n', '"str"\n', '[]\n'].map((body, i) => {
    const p = path.join(DIR, `shape-scalar-${i}.jsonl`);
    fs.writeFileSync(p, body);
    return p;
  });
  const probe = spawnSync(process.execPath, ['-e', `
    const { readFindings } = require(process.argv[1]);
    const files = process.argv.slice(2);
    process.stdout.write(JSON.stringify(files.map((p) => readFindings(p))));
  `, ledgerMod, good, MISSING_FINDINGS, ...scalars, DIR], {
    cwd: path.join(__dirname, '..'), encoding: 'utf8',
    env: Object.assign({}, process.env, { NO_COLOR: '1', TERM: 'dumb' }),
  });
  const expected = 'detail,error,kind,line,ok,rows';
  const kinds = ['ok', 'absent', ...scalars.map(() => 'corrupt'), 'unreadable'];
  const verdicts = JSON.parse(probe.stdout);
  verdicts.forEach((v, i) => {
    assert.strictEqual(Object.keys(v).sort().join(','), expected, `${kinds[i]}: same keys`);
    assert.strictEqual(v.kind, kinds[i], `${kinds[i]}: names the verdict`);
    if (kinds[i] === 'corrupt') {
      assert.strictEqual(v.detail, 'is not a finding object', `scalar ${i}: names the shape`);
      assert.strictEqual(v.line, 1);
    }
  });
  assert.strictEqual(verdicts[0].rows.length, 1);
});

ok('a session id is one directory name, not a path', () => {
  // `path.join(root, id)` would resolve `..`, so a traversal id used to load a
  // state.json from outside the sessions root while claiming to read inside it.
  const r = run(['--script'], { input: '/resume ../../../../../../../tmp/escape\n/quit\n' });
  assert.strictEqual(r.status, 0);
  assert.ok(r.out.includes('is not a session id'), 'refuses a path as an id');
  assert.ok(r.out.includes('one directory name'), 'says what an id is');
  assert.ok(!r.out.includes('OK ../../'), 'nothing was attached');
});

ok('/sessions lists meta.json and refuses an unknown id', () => {
  fs.mkdirSync(path.join(SESSIONS, 's1'), { recursive: true });
  fs.writeFileSync(path.join(SESSIONS, 's1', 'meta.json'), JSON.stringify({
    started_at: '2026-10-19T10:02:00Z', phase: 'web-test', class: 'sqli', status: 'ok',
  }));
  const r = run(['--script'], { input: '/sessions\n/resume nope\n/quit\n' });
  assert.strictEqual(r.status, 0);
  assert.ok(r.out.includes('s1'), 'lists the session id');
  assert.ok(r.out.includes('web-test/sqli'), 'shows phase/class');
  // A session with a log but no state file cannot be continued, and says so instead of
  // attaching to nothing.
  assert.ok(r.out.includes('no state'), 'marks a session without saved state as not resumable');
  assert.ok(r.out.includes('is not a session'), 'refuses an unknown id');
});

ok('--no-color is ASCII only, has no ANSI and stays within 100 columns', () => {
  const r = run(['--demo', '--fast', '--demo-approve'], { input: '' });
  assert.strictEqual(r.status, 0);
  assert.ok(!/\x1b\[/.test(r.out), 'no ANSI escapes');
  const unicode = r.lines.filter((l) => UNICODE_DRAWING.test(l));
  assert.deepStrictEqual(unicode, [], 'no box-drawing or status glyphs left');
  const wide = r.lines.filter((l) => [...l].length > 100);
  assert.deepStrictEqual(wide, [], 'no line exceeds 100 columns');
});

ok('the transcript never prints a key-shaped secret', () => {
  const r = run(['--demo', '--fast', '--demo-approve'], { input: '' });
  assert.ok(!/\bsk-[A-Za-z0-9_-]{6,}/.test(r.out), 'no provider key in the transcript');
  assert.ok(!/api[_-]?key\s*[:=]\s*\S+/i.test(r.out), 'no api_key assignment');
});

ok('the demo renders the coverage plan as a todo checklist and updates it', () => {
  const r = run(['--demo', '--fast', '--demo-approve'], { input: '' });
  assert.strictEqual(r.status, 0);
  const updates = (r.out.match(/Update Todos/g) || []).length;
  assert.ok(updates >= 2, 'the plan is shown and then updated as the run progresses');
  assert.ok(r.out.includes('[x] Map the target surface'), 'a done item is a filled box in ascii');
  assert.ok(r.out.includes('[~] Probe /api/orders'), 'the active item is marked');
  assert.ok(r.out.includes('[ ] Close the report gate'), 'a pending item is an empty box');
});

ok('/todos shows the phase ladder when no run has seeded a plan', () => {
  const r = run(['--script'], { input: '/todos\n/quit\n' });
  assert.strictEqual(r.status, 0);
  assert.ok(r.out.includes('Todos'), 'the panel is titled');
  assert.ok(r.out.includes('[~] recon-map'), 'the current phase is in progress');
  assert.ok(r.out.includes('[ ] report'), 'later phases are pending');
});

ok('a refused cloud profile says it is an authorization, not a failed run', () => {
  const write = (name, allowCloud) => {
    const file = path.join(DIR, name);
    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      default_profile: 'cloud',
      ...(allowCloud === undefined ? {} : { allow_cloud: allowCloud }),
      profiles: {
        cloud: {
          type: 'openai-compatible', base_url: 'https://example.invalid/v1',
          model: 'm', api_key_env: 'NO_SUCH_KEY', egress: 'cloud',
        },
      },
    }));
    return file;
  };
  // The shipped shape: the config allows cloud, this run has not authorized it.
  const flag = run(['--task', 'hello', '--config', write('cloud-allow.json', true)]);
  assert.strictEqual(flag.status, 5, 'the provider-config exit code is unchanged');
  assert.ok(flag.out.includes('uses cloud egress'), 'names the reason');
  assert.ok(flag.out.includes('not a failed run'), 'does not read as a run failure');
  assert.ok(flag.out.includes('nothing was sent'), 'says nothing left the host');
  // The config itself forbids it: --allow-cloud is not the remedy, and the message says so.
  const disabled = run(['--task', 'hello', '--config', write('cloud-disabled.json', false)]);
  assert.strictEqual(disabled.status, 5);
  assert.ok(disabled.out.includes('not a failed run'), 'still not a run failure');
  assert.ok(disabled.out.includes('cannot override'), 'does not offer a flag that cannot work');
  // These two exited 5 with no explanation at all: the reassurance belonged to two causes
  // instead of to the refusal. The mapping now carries the text with the status.
  const missing = run(['--task', 'hello', '--config', path.join(DIR, 'no-providers.json')]);
  assert.strictEqual(missing.status, 5);
  assert.ok(missing.out.includes('provider config not found'), 'names the missing file');
  assert.ok(missing.out.includes('not a failed run'), 'a missing config is not a failed run');
  assert.ok(missing.out.includes('copy the template'), 'names the remedy');
  const noKey = run(['--task', 'hello', '--allow-cloud', '--config', write('cloud-key.json', true)]);
  assert.strictEqual(noKey.status, 5);
  assert.ok(noKey.out.includes('provider key missing'), 'names the missing key');
  assert.ok(noKey.out.includes('not a failed run'), 'a missing key is not a failed run');
  assert.ok(noKey.out.includes('export the key'), 'says where the key comes from');
  // The table has a generic entry, so a cause added to live.js later cannot go silent.
  const fallback = spawnSync(process.execPath, ['-e', `
    const { refusal } = require(process.argv[1]);
    process.stdout.write(JSON.stringify(refusal({ code: 'a_new_cause' })));
  `, path.join(__dirname, '..', 'runtime', 'terminal', 'turn.js')], {
    cwd: path.join(__dirname, '..'), encoding: 'utf8',
    env: Object.assign({}, process.env, { NO_COLOR: '1', TERM: 'dumb' }),
  });
  const mapped = JSON.parse(fallback.stdout);
  assert.strictEqual(mapped.exit, 5, 'an unmapped cause keeps the provider status');
  assert.ok(mapped.text.includes('not a failed run'), 'and still says it was not the run');
  assert.ok(mapped.text.includes('was not authorized'), 'and names authorization as the cause');
});

ok('the demo refuses a path as a resume id and says it reads no session file', () => {
  const r = run(['--script'], { input: '/demo idor\n/resume ../escape\n/resume 01J8Z…\n/quit\n' });
  assert.strictEqual(r.status, 0);
  assert.ok(r.out.includes('is not a session id'), 'a path is refused in the demo too');
  assert.ok(!r.out.includes('attached ../escape'), 'nothing was attached');
  assert.ok(/prototype\s*[.·]\s*no session file is read/.test(r.out), 'the synthetic attach is explained');
});

ok('/help lists the /todos command', () => {
  const r = run(['--script'], { input: '/help\n/quit\n' });
  assert.strictEqual(r.status, 0);
  assert.ok(r.out.includes('/todos'), 'the command is discoverable');
});

summary('test-tui');
