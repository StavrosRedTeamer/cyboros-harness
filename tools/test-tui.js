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
  assert.ok(r.out.includes('no readable findings ledger'), 'does not invent findings');
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
  assert.ok(r.out.includes('resume lands in M1'), 'is explicit about the boundary');
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

ok('/help lists the /todos command', () => {
  const r = run(['--script'], { input: '/help\n/quit\n' });
  assert.strictEqual(r.status, 0);
  assert.ok(r.out.includes('/todos'), 'the command is discoverable');
});

summary('test-tui');
