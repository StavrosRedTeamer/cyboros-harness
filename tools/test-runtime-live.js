#!/usr/bin/env node
// test-tags: loopback
// Offline tests for runtime/live.js, demo/target.js and the TUI live wiring.
//
// What is protected:
//   · providers.json is fail-closed: no inline key, cloud needs allow_cloud + --allow-cloud,
//     a cloud key comes from the environment, never argv or the file;
//   · the loop really calls the tool and feeds the observation back to the model;
//   · an intrusive tool never runs without an explicit approval;
//   · the demo target has the three deliberate flaws (IDOR, BOLA, reflected XSS);
//   · `--live --task` goes TUI → provider → scope_check → final, without a TTY.
//
// The HTTP provider is a local mock; the only real execution is node tools/scope-guard.js.
'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('node:http');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { ok, okAsync, fixture, writeScope, runCliAsync, summary } = require('./testkit');

const TUI = path.join(__dirname, '..', 'runtime', 'tui.js');
const LIVE = path.join(__dirname, '..', 'runtime', 'live.js');
const DEMO = path.join(__dirname, '..', 'demo', 'target.js');
const DIR = fixture('runtime-live');
const SESSIONS = path.join(DIR, 'sessions');
const APPROVALS = path.join(DIR, 'approvals.jsonl');
process.env.CYBOROS_AGENT_DIR = SESSIONS;
process.env.CYBOROS_APPROVALS_FILE = APPROVALS;
process.env.MOCK_KEY = 'test-key-not-a-secret';

// ── helpers ────────────────────────────────────────────────────────────────
function providerConfig(file, port, extra = {}) {
  const cfg = {
    version: 1,
    default_profile: 'mock',
    allow_cloud: false,
    profiles: {
      mock: {
        type: 'openai-compatible',
        base_url: `http://127.0.0.1:${port}/v1`,
        model: 'mock',
        api_key_env: 'MOCK_KEY',
        egress: 'local',
        max_tool_iters: 4,
        context_char_budget: 20000,
        ...extra,
      },
    },
  };
  fs.writeFileSync(file, JSON.stringify(cfg));
  return file;
}

function chat(message, usage = { prompt_tokens: 10, completion_tokens: 5 }) {
  return { choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }], usage };
}

function toolCall(name, args) {
  return chat({
    role: 'assistant',
    content: '',
    tool_calls: [{ id: 'call_1', type: 'function', function: { name, arguments: JSON.stringify(args) } }],
  });
}

function startSseProvider(deltas) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      req.resume();
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      for (const d of deltas) res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: d }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function startProvider(script) {
  return new Promise((resolve) => {
    let n = 0;
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        let parsed = {};
        try { parsed = JSON.parse(body || '{}'); } catch { /* the mock only needs the count */ }
        const payload = script(n++, parsed);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

// A provider that answers with a status the test chooses, and remembers every request:
// what a failure COSTS is part of the contract (a 4xx retried twice is two extra
// requests and two extra seconds before the same rejection).
function startStatusProvider(script) {
  return new Promise((resolve) => {
    let n = 0;
    const requests = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        let parsed = {};
        try { parsed = JSON.parse(body || '{}'); } catch { /* the count is what matters */ }
        requests.push(parsed);
        const move = script(n++, parsed) || {};
        res.writeHead(move.status || 200, { 'content-type': 'application/json' });
        res.end(typeof move.body === 'string' ? move.body : JSON.stringify(move.body || {}));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, requests }));
  });
}

// The loop without live.js: recovery is a property of local/llm.js, and a test that went
// through the TUI would be measuring the surface instead.
function loopFor(port, runtime = {}, capabilities) {
  const { LocalLLM } = require('../local/llm');
  return new LocalLLM({
    endpoint: { base_url: `http://127.0.0.1:${port}/v1`, api_key: 'x', model: 'mock' },
    sampling: { temperature: 0, top_p: 1, max_tokens: 64 },
    capabilities,
    runtime: { max_tool_iters: 4, use_grammar: false, retries: 2, retry_backoff_ms: 1, ...runtime },
  });
}

// ── config gate ────────────────────────────────────────────────────────────
async function main() {
  ok('loadConfig refuses a missing file with the copy hint', () => {
    const { loadConfig, LiveError } = require(LIVE);
    assert.throws(() => loadConfig(path.join(DIR, 'absent.json')), (e) => {
      assert.ok(e instanceof LiveError);
      assert.strictEqual(e.code, 'config_missing');
      assert.match(e.message, /providers\.example\.json/);
      return true;
    });
  });

  ok('loadConfig refuses an inline api_key', () => {
    const { loadConfig, LiveError } = require(LIVE);
    const file = path.join(DIR, 'inline.json');
    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      profiles: { p: { type: 'openai-compatible', base_url: 'https://example.invalid/v1', model: 'm', api_key: 'sk-leak' } },
    }));
    assert.throws(() => loadConfig(file), (e) => e instanceof LiveError && e.code === 'config_inline_key');
  });

  await okAsync('createLive gates cloud egress and key resolution', async () => {
    const { createLive, LiveError } = require(LIVE);
    const file = path.join(DIR, 'cloud.json');
    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      default_profile: 'cloud',
      allow_cloud: true,
      profiles: { cloud: { type: 'openai-compatible', base_url: 'https://example.invalid/v1', model: 'm', api_key_env: 'NO_SUCH_KEY_FOR_TEST', egress: 'cloud' } },
    }));
    assert.throws(() => createLive({ configPath: file }), (e) => e instanceof LiveError && e.code === 'cloud_requires_flag');
    assert.throws(() => createLive({ configPath: file, allowCloud: true }), (e) => e instanceof LiveError && e.code === 'provider_key_missing');
  });

  // ── real loop with a mock provider ───────────────────────────────────────
  await okAsync('the live loop executes a tool and feeds the observation back', async () => {
    const { createLive } = require(LIVE);
    const { server, port } = await startProvider((n) => (
      n === 0 ? toolCall('scope_check', { target: '127.0.0.1' }) : chat({ role: 'assistant', content: 'FINAL: scope checked.' })
    ));
    const file = providerConfig(path.join(DIR, 'loop.json'), port);
    const seen = [];
    try {
      const live = createLive({
        configPath: file,
        target: '127.0.0.1',
        phase: 'web-test',
        baseDispatch: async (name, args) => { seen.push({ name, args }); return 'IN SCOPE: 127.0.0.1'; },
      });
      const res = await live.run('check scope');
      live.finish();
      assert.deepStrictEqual(seen, [{ name: 'scope_check', args: { target: '127.0.0.1' } }]);
      assert.strictEqual(res.text, 'scope checked.');
      const events = fs.readFileSync(path.join(live.session.dir, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
      assert.ok(events.some((e) => e.type === 'run_start'), 'run_start logged');
      assert.ok(events.some((e) => e.type === 'tool_call' && e.tool === 'scope_check'), 'tool_call logged');
      assert.ok(events.some((e) => e.type === 'tool_result'), 'tool_result logged');
      assert.ok(events.some((e) => e.type === 'run_end' && e.status === 'ok'), 'run_end logged');
      assert.ok(events.some((e) => e.type === 'provider_call' && e.usage.tokens_in === 10), 'usage captured');
    } finally { await close(server); }
  });

  await okAsync('an intrusive tool stops for approval and never reaches dispatch when skipped', async () => {
    const { createLive } = require(LIVE);
    const { server, port } = await startProvider((n) => (
      n === 0 ? toolCall('run_tool', { bin: 'sqlmap', args: ['-u', 'http://127.0.0.1/'] })
        : chat({ role: 'assistant', content: 'FINAL: stopped.' })
    ));
    const file = providerConfig(path.join(DIR, 'approval.json'), port);
    let called = false;
    let asked = 0;
    try {
      const live = createLive({
        configPath: file,
        target: '127.0.0.1',
        baseDispatch: async () => { called = true; return 'SHOULD NOT RUN'; },
        approve: async () => { asked += 1; return 'skip'; },
      });
      const res = await live.run('try sqlmap');
      live.finish();
      assert.strictEqual(asked, 1, 'the operator was asked once');
      assert.strictEqual(called, false, 'the intrusive binary was not dispatched');
      assert.ok(res.messages.some((m) => String(m.content || '').includes('ANNULLATO dall\'operatore')), 'the refusal is in the observation');
      const approval = fs.readFileSync(APPROVALS, 'utf8').trim().split('\n').map(JSON.parse).pop();
      assert.strictEqual(approval.decision, 'denied');
    } finally { await close(server); }
  });

  await okAsync('--live --task without a TTY stops at the approval and exits 1', async () => {
    const { server, port } = await startProvider((n) => (
      n === 0 ? toolCall('run_tool', { bin: 'sqlmap', args: ['-u', 'http://127.0.0.1/'] })
        : chat({ role: 'assistant', content: 'FINAL: stopped before the intrusive step.' })
    ));
    const cfg = providerConfig(path.join(DIR, 'notty.json'), port);
    fs.mkdirSync(path.join(DIR, 'scope-notty'), { recursive: true });
    const scope = writeScope(path.join(DIR, 'scope-notty'), {
      allowed_hosts: ['127.0.0.1'], allowed_ips: ['127.0.0.1/32'], max_requests_per_second: 5,
    });
    try {
      const r = await runCliAsync([TUI, '--live', '--config', cfg, '127.0.0.1', '--task', 'try sqlmap', '--no-color'], {
        env: {
          ...process.env,
          MOCK_KEY: 'test-key-not-a-secret',
          SCOPE_JSON: scope,
          FINDINGS_JSONL: path.join(DIR, 'findings-notty.jsonl'),
          CYBOROS_AGENT_DIR: SESSIONS,
          CYBOROS_APPROVALS_FILE: APPROVALS,
          NO_COLOR: '1',
          TERM: 'dumb',
        },
      });
      assert.strictEqual(r.status, 1, 'a one-shot run needing a TTY fails closed');
      assert.ok(r.stdout.includes('stdin is not a TTY'), 'the refusal names the cause');
      assert.ok(r.stdout.includes('sqlmap non eseguito'), 'the observation says it was not run');
    } finally { await close(server); }
  });

  await okAsync('run_tool probes that differ in URL or identity are not a variant-loop', async () => {
    const { createLive } = require(LIVE);
    const alice = ['-s', '-H', 'X-User: alice', 'http://127.0.0.1:8787/api/orders/42'];
    const bob = ['-s', '-H', 'X-User: bob', 'http://127.0.0.1:8787/api/orders/42'];
    const other = ['-s', 'http://127.0.0.1:8787/api/users/1'];
    const { server, port } = await startProvider((n) => (n === 0 ? toolCall('run_tool', { bin: 'curl', args: alice })
      : n === 1 ? toolCall('run_tool', { bin: 'curl', args: bob })
        : n === 2 ? toolCall('run_tool', { bin: 'curl', args: other })
          : chat({ role: 'assistant', content: 'FINAL: three probes.' })));
    const file = providerConfig(path.join(DIR, 'probes.json'), port);
    const seen = [];
    try {
      const live = createLive({
        configPath: file,
        target: '127.0.0.1',
        baseDispatch: async (name, args) => { seen.push(args.args); return `[run ${args.bin}] ok`; },
      });
      const res = await live.run('probe the order as two identities');
      live.finish();
      assert.strictEqual(seen.length, 3, 'all three distinct probes reached dispatch');
      assert.deepStrictEqual(seen[1], bob);
      // The turn ran target traffic and its FINAL cites nothing: one correction, then the
      // answer is labelled. That is the end-of-turn contract, not a loop-guard failure.
      assert.strictEqual(res.unproven, true, 'an uncited summary after probes is labelled');
      assert.ok(res.text.includes('three probes.'), 'the answer is still delivered');
    } finally { await close(server); }
  });

  await okAsync('a finding that gains an oracle field is new evidence, not a variant-loop', async () => {
    const { createLive } = require(LIVE);
    const draft = { severity: 'Medium', title: 'BOLA on /api/orders/42', host: '127.0.0.1', endpoint: '/api/orders/42', poc: 'alice 200, bob 200', status: 'inconclusive' };
    const withOracle = { ...draft, status: 'confirmed', verify_level: 'triggered', oracle: { type: 'http-diff', ref: 'reports/tmp/oracle-log.jsonl#1', token: 'bola-42' } };
    const { server, port } = await startProvider((n) => (n === 0 ? toolCall('record_finding', draft)
      : n === 1 ? toolCall('record_finding', withOracle)
        : chat({ role: 'assistant', content: 'FINAL: recorded.' })));
    const file = providerConfig(path.join(DIR, 'finding-retry.json'), port);
    const seen = [];
    try {
      const live = createLive({
        configPath: file,
        target: '127.0.0.1',
        baseDispatch: async (name, args) => { seen.push(args); return 'ok'; },
      });
      const res = await live.run('record the BOLA');
      live.finish();
      assert.strictEqual(seen.length, 2, 'the corrected registration reached dispatch');
      assert.deepStrictEqual(seen[1].oracle, withOracle.oracle);
      assert.strictEqual(res.text, 'recorded.');
    } finally { await close(server); }
  });

  await okAsync('a retry after a validation error is not blocked as a loop', async () => {
    const { createLive } = require(LIVE);
    const bad = { severity: 'Medium', title: 'BOLA', host: '127.0.0.1', endpoint: '/o/42', poc: 'x', status: 'confirmed', cvss_vector: 'CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:N/A:N' };
    const fixed = { ...bad, cvss_vector: 'AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:N/A:N' };
    const { server, port } = await startProvider((n) => (n === 0 ? toolCall('record_finding', bad)
      : n === 1 ? toolCall('record_finding', fixed)
        : chat({ role: 'assistant', content: 'FINAL: recorded.' })));
    const file = providerConfig(path.join(DIR, 'retry.json'), port);
    const seen = [];
    try {
      const live = createLive({
        configPath: file,
        target: '127.0.0.1',
        baseDispatch: async (name, args) => {
          seen.push(args);
          return seen.length === 1
            ? '[record-finding exit 1] {"ok":false,"error":"cvss_vector must look like ..."}'
            : '[record-finding exit 0] {"ok":true}';
        },
      });
      const res = await live.run('record the finding');
      live.finish();
      assert.strictEqual(seen.length, 2, 'the corrected retry reached dispatch');
      assert.strictEqual(res.text, 'recorded.');
    } finally { await close(server); }
  });

  // ── engagement state, read-only ─────────────────────────────────────────
  await okAsync('findings_query, sessions_list and session_read answer from disk', async () => {
    const { makeDispatch } = require('../local/tools-bridge');
    const ledger = path.join(DIR, 'findings-qa.jsonl');
    fs.writeFileSync(ledger, [
      JSON.stringify({ severity: 'Medium', title: 'BOLA on order 42', host: '127.0.0.1:8787', endpoint: 'GET /api/orders/42', status: 'confirmed', verify_level: 'triggered', oracle: { type: 'http-diff', ref: 'reports/tmp/oracle-log.jsonl#51', token: 'bola-order-42' } }),
      JSON.stringify({ severity: 'Low', title: 'Reflected XSS in q', host: '127.0.0.1:8787', endpoint: 'GET /search?q=', status: 'inconclusive', verify_level: 'suspected' }),
    ].join('\n') + '\n');
    const root = path.join(DIR, 'sessions-qa');
    const sdir = path.join(root, 's1');
    fs.mkdirSync(sdir, { recursive: true });
    fs.writeFileSync(path.join(sdir, 'meta.json'), JSON.stringify({ id: 's1', started_at: '2026-10-19T10:00:00Z', host: '127.0.0.1:8787', phase: 'web-test', profile: 'experiential', model: 'mock' }));
    fs.writeFileSync(path.join(sdir, 'events.jsonl'), [
      JSON.stringify({ ts: '2026-10-19T10:00:01Z', type: 'tool_call', tool: 'scope_check', args: { target: '127.0.0.1:8787' } }),
      JSON.stringify({ ts: '2026-10-19T10:00:02Z', type: 'assistant', content: 'FINAL: done' }),
    ].join('\n') + '\n');
    const prev = { f: process.env.FINDINGS_JSONL, s: process.env.CYBOROS_AGENT_DIR };
    process.env.FINDINGS_JSONL = ledger;
    process.env.CYBOROS_AGENT_DIR = root;
    try {
      const d = makeDispatch({ allowRunTool: false });
      const findings = await d('findings_query', { host: '127.0.0.1' });
      assert.ok(findings.includes('BOLA on order 42'), 'lists the finding');
      assert.ok(findings.includes('oracle reports/tmp/oracle-log.jsonl#51'), 'cites the oracle');
      const sessions = await d('sessions_list', {});
      assert.ok(sessions.includes('s1') && sessions.includes('web-test'), 'lists sessions');
      const one = await d('session_read', { id: 's1', limit: 5 });
      assert.ok(one.includes('scope_check'), 'reads the events');
      assert.ok(one.includes('FINAL: done'), 'reads the assistant turn');
      assert.ok((await d('session_read', { id: '../etc' })).includes('non valido'), 'refuses traversal');
    } finally {
      if (prev.f === undefined) delete process.env.FINDINGS_JSONL; else process.env.FINDINGS_JSONL = prev.f;
      if (prev.s === undefined) delete process.env.CYBOROS_AGENT_DIR; else process.env.CYBOROS_AGENT_DIR = prev.s;
    }
  });

  await okAsync('a question runs without a target and the model reads the ledger', async () => {
    const ledger = path.join(DIR, 'findings-question.jsonl');
    fs.writeFileSync(ledger, JSON.stringify({ severity: 'Medium', title: 'BOLA on order 42', host: '127.0.0.1:8787', endpoint: 'GET /api/orders/42', status: 'confirmed', verify_level: 'triggered', oracle: { type: 'http-diff', ref: 'reports/tmp/oracle-log.jsonl#51', token: 'bola-order-42' } }) + '\n');
    const { server, port } = await startProvider((n) => (n === 0 ? toolCall('findings_query', { host: '127.0.0.1' })
      : chat({ role: 'assistant', content: 'FINAL: The latest finding is BOLA on order 42.' })));
    const cfg = providerConfig(path.join(DIR, 'question.json'), port);
    try {
      const r = await runCliAsync([TUI, '--live', '--config', cfg, '--task', 'what did we find on 127.0.0.1?', '--no-color'], {
        env: { ...process.env, MOCK_KEY: 'test-key-not-a-secret', FINDINGS_JSONL: ledger, NO_COLOR: '1', TERM: 'dumb' },
      });
      assert.strictEqual(r.status, 0, r.stderr);
      assert.ok(!r.stdout.includes('no target'), 'a question does not require a target');
      assert.ok(r.stdout.includes('BOLA on order 42'), 'the ledger reached the model');
      assert.ok(r.stdout.includes('The latest finding is BOLA on order 42.'), 'the answer is shown');
    } finally { await close(server); }
  });

  await okAsync('the reasoning is shown before the answer, and not twice', async () => {
    const reasoning = 'The operator asks about prior work; I should query the ledger instead of scanning.';
    const answer = 'You have one confirmed BOLA on order 42.';
    const { server, port } = await startSseProvider([
      { reasoning_content: reasoning },
      { content: answer },
    ]);
    const cfg = providerConfig(path.join(DIR, 'thinking.json'), port);
    try {
      const r = await runCliAsync([TUI, '--live', '--config', cfg, '--task', 'what did we find?', '--no-color'], {
        env: { ...process.env, MOCK_KEY: 'test-key-not-a-secret', NO_COLOR: '1', TERM: 'dumb' },
      });
      assert.strictEqual(r.status, 0, r.stderr);
      assert.ok(r.stdout.includes(reasoning), 'the reasoning is rendered');
      assert.ok(r.stdout.indexOf(reasoning) < r.stdout.indexOf(answer), 'reasoning comes before the answer');
      assert.strictEqual(r.stdout.split(answer).length - 1, 1, 'the streamed answer is not printed twice');
    } finally { await close(server); }
  });

  // ── demo target ─────────────────────────────────────────────────────────
  await okAsync('the demo target exposes IDOR, BOLA and reflected XSS', async () => {
    const { createServer } = require(DEMO);
    const server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const user = await fetch(`${base}/api/users/1`);
      assert.strictEqual(user.status, 200);
      const u = await user.json();
      assert.strictEqual(u.username, 'alice');
      assert.strictEqual(u.email, 'alice@demo.example');

      assert.strictEqual((await fetch(`${base}/api/orders/42`)).status, 401, 'identity is required');

      const asBob = await fetch(`${base}/api/orders/42`, { headers: { 'X-User': 'bob' } });
      assert.strictEqual(asBob.status, 200);
      const order = await asBob.json();
      assert.strictEqual(order.owner, 'alice');
      assert.strictEqual(order.card_last4, '4242');
      assert.strictEqual(order.requested_by, 'bob');

      const reflected = await (await fetch(`${base}/search?q=%3Cscript%3Ealert(1)%3C/script%3E`)).text();
      assert.ok(reflected.includes('<script>alert(1)</script>'), 'the query is reflected raw');
    } finally { await close(server); }
  });

  // ── TUI wiring ──────────────────────────────────────────────────────────
  ok('the TUI refuses to mix --demo and --live', () => {
    const r = spawnSync(process.execPath, [TUI, '--demo', '--live', '--no-color'], { encoding: 'utf8', timeout: 15000 });
    assert.strictEqual(r.status, 2);
    assert.ok(String(r.stderr).includes('not both'));
  });

  await okAsync('--live --task goes TUI → provider → real scope_check → final', async () => {
    const { server, port } = await startProvider((n) => (
      n === 0 ? toolCall('scope_check', { target: '127.0.0.1' }) : chat({ role: 'assistant', content: 'FINAL: scope checked from the TUI.' })
    ));
    const cfg = providerConfig(path.join(DIR, 'tui.json'), port);
    fs.mkdirSync(path.join(DIR, 'scope'), { recursive: true });
    const scope = writeScope(path.join(DIR, 'scope'), {
      allowed_hosts: ['127.0.0.1'], allowed_ips: ['127.0.0.1/32'], max_requests_per_second: 5,
    });
    try {
      const r = await runCliAsync([TUI, '--live', '--config', cfg, '127.0.0.1', '--task', 'check scope', '--no-color'], {
        env: {
          ...process.env,
          MOCK_KEY: 'test-key-not-a-secret',
          SCOPE_JSON: scope,
          FINDINGS_JSONL: path.join(DIR, 'findings.jsonl'),
          CYBOROS_AGENT_DIR: SESSIONS,
          CYBOROS_APPROVALS_FILE: APPROVALS,
          NO_COLOR: '1',
          TERM: 'dumb',
        },
      });
      assert.strictEqual(r.status, 0, r.stderr);
      assert.ok(r.stdout.includes('thinking shown'), 'welcome says live');
      assert.ok(r.stdout.includes('IN SCOPE: 127.0.0.1'), 'the real guard ran');
      assert.ok(r.stdout.includes('scope checked from the TUI.'), 'the final text is shown');
      assert.ok(!/\x1b\[/.test(r.stdout), 'no ANSI in --no-color');
    } finally { await close(server); }
  });

  // The key can live beside the config instead of the environment, provided the file
  // is not readable by anyone else.
  const { resolveKey } = require('../runtime/live');

  ok('the provider key falls back to a 600 per-profile file, env first', () => {
    const home = path.join(fixture('keys'), 'xdg');
    const dir = path.join(home, 'cyboros');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'experiential.env');
    fs.writeFileSync(file, 'export EXPERIENTIAL_API_KEY=file-key\n', { mode: 0o600 });
    fs.chmodSync(file, 0o600);
    const prevXdg = process.env.XDG_CONFIG_HOME;
    const prevKey = process.env.EXPERIENTIAL_API_KEY;
    delete process.env.EXPERIENTIAL_API_KEY;
    process.env.XDG_CONFIG_HOME = home;
    try {
      const r = resolveKey('experiential', 'EXPERIENTIAL_API_KEY');
      assert.strictEqual(r.key, 'file-key');
      assert.strictEqual(r.source, file);
      process.env.EXPERIENTIAL_API_KEY = 'env-key';
      assert.strictEqual(resolveKey('experiential', 'EXPERIENTIAL_API_KEY').key, 'env-key', 'env wins');
    } finally {
      if (prevXdg == null) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = prevXdg;
      if (prevKey == null) delete process.env.EXPERIENTIAL_API_KEY;
      else process.env.EXPERIENTIAL_API_KEY = prevKey;
    }
  });

  ok('a key file other users can read is refused', () => {
    const home = path.join(fixture('keys-open'), 'xdg');
    const dir = path.join(home, 'cyboros');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'experiential.env');
    fs.writeFileSync(file, 'EXPERIENTIAL_API_KEY=leaky\n', { mode: 0o644 });
    fs.chmodSync(file, 0o644);
    const prevXdg = process.env.XDG_CONFIG_HOME;
    const prevKey = process.env.EXPERIENTIAL_API_KEY;
    delete process.env.EXPERIENTIAL_API_KEY;
    process.env.XDG_CONFIG_HOME = home;
    try {
      assert.throws(() => resolveKey('experiential', 'EXPERIENTIAL_API_KEY'), /readable by other users/);
    } finally {
      if (prevXdg == null) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = prevXdg;
      if (prevKey == null) delete process.env.EXPERIENTIAL_API_KEY;
      else process.env.EXPERIENTIAL_API_KEY = prevKey;
    }
  });

  // ── provider failures: retry what a retry can fix, never disguise the rest ────
  await okAsync('a 4xx is the provider\'s answer: one request, no retries', async () => {
    const { server, port, requests } = await startStatusProvider(() => ({ status: 401, body: { error: { message: 'bad key' } } }));
    try {
      const llm = loopFor(port);
      await assert.rejects(
        () => llm.runAgent({ task: 'x', dispatch: async () => 'never' }),
        (e) => e.status === 401 && /HTTP 401/.test(e.message),
        'the rejection surfaces as the provider sent it',
      );
      assert.strictEqual(requests.length, 1, 'a rejected request is not sent again');
    } finally { await close(server); }
  });

  await okAsync('a 5xx is retried, and the retry is the one that answers', async () => {
    const { server, port, requests } = await startStatusProvider((n) => (
      n === 0 ? { status: 503, body: 'busy' } : { body: chat({ role: 'assistant', content: 'FINAL: recovered' }) }
    ));
    try {
      const llm = loopFor(port);
      const res = await llm.runAgent({ task: 'x', dispatch: async () => 'never' });
      assert.strictEqual(requests.length, 2, 'one retry');
      assert.strictEqual(res.text, 'recovered');
    } finally { await close(server); }
  });

  await okAsync('a generic 400 does not silently disable the grammar', async () => {
    const { server, port, requests } = await startStatusProvider(() => (
      { status: 400, body: { error: { message: 'unsupported parameter: top_k' } } }
    ));
    try {
      const llm = loopFor(port, { use_grammar: true }, { grammar: true });
      await assert.rejects(
        () => llm.runAgent({ task: 'x', grammar: 'root ::= "x"', dispatch: async () => 'never' }),
        /HTTP 400/,
      );
      assert.strictEqual(requests.length, 1, 'no retry and no second, grammar-less request');
      assert.ok(JSON.stringify(requests[0]).includes('grammar'), 'the request did carry the grammar');
    } finally { await close(server); }
  });

  await okAsync('a 400 that names the grammar still falls back to native tools', async () => {
    const { server, port, requests } = await startStatusProvider((n) => (
      n === 0 ? { status: 400, body: { error: { message: 'this server does not support grammar' } } }
        : { body: chat({ role: 'assistant', content: 'FINAL: no grammar' }) }
    ));
    try {
      const llm = loopFor(port, { use_grammar: true }, { grammar: true });
      const res = await llm.runAgent({ task: 'x', grammar: 'root ::= "x"', dispatch: async () => 'never' });
      assert.strictEqual(requests.length, 2, 'the fallback is one extra request');
      assert.ok(!('grammar' in requests[1]), 'the retry does not carry the grammar');
      assert.strictEqual(res.text, 'no grammar');
    } finally { await close(server); }
  });

  await okAsync('truncated tool arguments are repaired, not guessed', async () => {
    const cut = '{"bin":"curl","args":["-s","http://127.0.0.1/very/long/path';
    const { server, port } = await startStatusProvider((n) => (
      n === 0
        ? { body: chat({ role: 'assistant', content: '', tool_calls: [{ id: 'call_cut', type: 'function', function: { name: 'run_tool', arguments: cut } }] }) }
        : { body: chat({ role: 'assistant', content: 'FINAL: done' }) }
    ));
    const seen = [];
    try {
      const llm = loopFor(port);
      await llm.runAgent({ task: 'x', dispatch: async (name, args) => { seen.push({ name, args }); return 'ok'; } });
      assert.strictEqual(seen.length, 1, 'the repaired call ran once');
      assert.strictEqual(seen[0].args.bin, 'curl');
      assert.strictEqual(seen[0].args.args[1], 'http://127.0.0.1/very/long/path', 'the cut string is closed, not truncated');
    } finally { await close(server); }
  });

  await okAsync('unrepairable arguments are refused and fed back, never dispatched', async () => {
    const { server, port } = await startStatusProvider((n) => (
      n === 0
        ? { body: chat({ role: 'assistant', content: '', tool_calls: [{ id: 'call_bad', type: 'function', function: { name: 'run_tool', arguments: 'curl -s http://127.0.0.1/' } }] }) }
        : { body: chat({ role: 'assistant', content: 'FINAL: re-emitted' }) }
    ));
    const seen = [];
    try {
      const llm = loopFor(port);
      const res = await llm.runAgent({ task: 'x', dispatch: async (name, args) => { seen.push({ name, args }); return 'SHOULD NOT RUN'; } });
      assert.strictEqual(seen.length, 0, 'nothing was dispatched from unparsable arguments');
      assert.ok(res.messages.some((m) => m.role === 'tool' && /ARGOMENTI NON VALIDI/.test(String(m.content))), 'the refusal is an observation');
      assert.strictEqual(res.text, 're-emitted');
    } finally { await close(server); }
  });

  // ── end of turn: truncation and the evidence gate ─────────────────────────
  await okAsync('finish_reason=length is continued and concatenated, not returned cut', async () => {
    const { server, port, requests } = await startStatusProvider((n) => ({
      body: {
        choices: [{
          message: { role: 'assistant', content: n === 0 ? 'La risposta è' : ' stata troncata' },
          finish_reason: n === 0 ? 'length' : 'stop',
        }],
      },
    }));
    try {
      const res = await loopFor(port).runAgent({ task: 'x', dispatch: async () => 'never' });
      assert.strictEqual(requests.length, 2, 'one continuation request');
      assert.strictEqual(res.text, 'La risposta è stata troncata', 'the two halves are one answer');
      assert.strictEqual(res.finish_reason, 'stop', 'the final reason is the one that ended it');
    } finally { await close(server); }
  });

  await okAsync('after target traffic, FINAL without a citation is corrected and then accepted', async () => {
    const { server, port, requests } = await startStatusProvider((n) => ({ body: n === 0
      ? chat({ role: 'assistant', content: '', tool_calls: [{ id: 'w1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'reports/bola.txt', content: 'HTTP/1.1 200 OK alice/bob' }) } }] })
      : n === 1
        ? chat({ role: 'assistant', content: '', tool_calls: [{ id: 'r1', type: 'function', function: { name: 'run_tool', arguments: JSON.stringify({ bin: 'curl', args: ['-s', 'http://127.0.0.1/api/orders/42'] }) } }] })
        : n === 2
          ? chat({ role: 'assistant', content: 'Ho trovato BOLA su /api/orders/42.' })
          : chat({ role: 'assistant', content: 'BOLA confermata; risposta grezza in reports/bola.txt.' }) }));
    try {
      const llm = loopFor(port, { evidence_gate: true });
      const res = await llm.runAgent({
        task: 'x',
        dispatch: async (name, args) => (name === 'write_file' ? `scritto: ${args.path}` : 'HTTP/1.1 200 OK'),
      });
      assert.strictEqual(requests.length, 4, 'the uncited FINAL cost exactly one correction');
      assert.ok(res.text.includes('reports/bola.txt'), 'the accepted answer cites the artefact');
      assert.strictEqual(res.unproven, false);
      assert.ok(!res.messages.some((m) => /FINAL rifiutato/.test(String(m.content))), 'the correction is not left in the history');
    } finally { await close(server); }
  });

  await okAsync('a finding title is a citation too', async () => {
    const { server, port } = await startStatusProvider((n) => ({ body: n === 0
      ? chat({ role: 'assistant', content: '', tool_calls: [{ id: 'r1', type: 'function', function: { name: 'run_tool', arguments: JSON.stringify({ bin: 'curl', args: ['-s', 'http://127.0.0.1/api/orders/42'] }) } }] })
      : n === 1
        ? chat({ role: 'assistant', content: '', tool_calls: [{ id: 'f1', type: 'function', function: { name: 'record_finding', arguments: JSON.stringify({ severity: 'Medium', title: 'BOLA on order 42', host: '127.0.0.1', poc: 'alice 200, bob 200', status: 'inconclusive' }) } }] })
        : chat({ role: 'assistant', content: 'Registrato: BOLA on order 42.' }) }));
    try {
      const llm = loopFor(port, { evidence_gate: true });
      const res = await llm.runAgent({
        task: 'x',
        dispatch: async () => '[record-finding exit 0]\nscritto reports/findings.jsonl',
      });
      assert.strictEqual(res.unproven, false);
      assert.ok(res.text.includes('order 42'));
    } finally { await close(server); }
  });

  await okAsync('an explicitly unproven result passes the gate, and is not retried', async () => {
    const { server, port, requests } = await startStatusProvider((n) => ({ body: n === 0
      ? chat({ role: 'assistant', content: '', tool_calls: [{ id: 'r1', type: 'function', function: { name: 'run_tool', arguments: JSON.stringify({ bin: 'curl', args: ['-s', 'http://127.0.0.1/missing'] }) } }] })
      : chat({ role: 'assistant', content: 'Nessuna prova: tutti i probe hanno risposto 404.' }) }));
    try {
      const llm = loopFor(port, { evidence_gate: true });
      const res = await llm.runAgent({ task: 'x', dispatch: async () => 'HTTP/1.1 404 Not Found' });
      assert.strictEqual(requests.length, 2, 'a negative result is an answer, not a failure');
      assert.strictEqual(res.unproven, false);
    } finally { await close(server); }
  });

  await okAsync('without the gate (raw loop), an uncited claim is returned as before', async () => {
    const { server, port, requests } = await startStatusProvider((n) => ({ body: n === 0
      ? chat({ role: 'assistant', content: '', tool_calls: [{ id: 'r1', type: 'function', function: { name: 'run_tool', arguments: JSON.stringify({ bin: 'curl', args: ['-s', 'http://127.0.0.1/x'] }) } }] })
      : chat({ role: 'assistant', content: 'Ho trovato qualcosa.' }) }));
    try {
      const res = await loopFor(port).runAgent({ task: 'x', dispatch: async () => 'HTTP/1.1 200 OK' });
      assert.strictEqual(requests.length, 2);
      assert.strictEqual(res.unproven, false);
      assert.ok(!res.text.startsWith('[NON PROVATO'), 'no label when the gate is off');
    } finally { await close(server); }
  });

  await okAsync('a claim that stays uncited is labelled NON PROVATO', async () => {
    const { server, port, requests } = await startStatusProvider((n) => ({ body: n === 0
      ? chat({ role: 'assistant', content: '', tool_calls: [{ id: 'r1', type: 'function', function: { name: 'run_tool', arguments: JSON.stringify({ bin: 'curl', args: ['-s', 'http://127.0.0.1/x'] }) } }] })
      : chat({ role: 'assistant', content: 'Ho trovato BOLA.' }) }));
    try {
      const llm = loopFor(port, { evidence_gate: true });
      const res = await llm.runAgent({ task: 'x', dispatch: async () => 'HTTP/1.1 200 OK' });
      assert.strictEqual(requests.length, 3, 'one action, one correction, one answer');
      assert.strictEqual(res.unproven, true);
      assert.ok(res.text.startsWith('[NON PROVATO'), 'the label is part of the answer');
    } finally { await close(server); }
  });

  ok('citationIn: paths, basenames and finding titles, but not arbitrary prose', () => {
    const { citationIn, looksUnproven } = require('../local/llm');
    const ev = { paths: new Set(['reports/demo/bola-evidence.txt']), titles: ['BOLA on order 42'] };
    assert.strictEqual(citationIn('prova in reports/demo/bola-evidence.txt', ev), 'reports/demo/bola-evidence.txt');
    assert.strictEqual(citationIn('vedi bola-evidence.txt', ev), 'reports/demo/bola-evidence.txt');
    assert.strictEqual(citationIn('registrato BOLA on order 42', ev), 'bola on order 42');
    assert.strictEqual(citationIn('ho trovato una BOLA', ev), null);
    assert.strictEqual(looksUnproven('il risultato è inconclusive'), true);
    assert.strictEqual(looksUnproven('non provato: tutti 404'), true);
    assert.strictEqual(looksUnproven('BOLA confermata'), false);
  });

  ok('repairToolArguments: fences, trailing commas and truncation, but never a guess', () => {
    const { repairToolArguments, readToolArguments } = require('../local/llm');
    assert.deepStrictEqual(repairToolArguments('```json\n{"a":1}\n```').value, { a: 1 }, 'fenced JSON');
    assert.deepStrictEqual(repairToolArguments('{"a":[1,2,],}').value, { a: [1, 2] }, 'trailing commas');
    assert.deepStrictEqual(repairToolArguments('{"a":{"b":"x').value, { a: { b: 'x' } }, 'unterminated string and object');
    assert.strictEqual(repairToolArguments('curl -s http://x').ok, false, 'prose is not an object');
    assert.strictEqual(readToolArguments('[]').ok, false, 'an array is not a tool-argument object');
    assert.deepStrictEqual(readToolArguments('').value, {}, 'empty is an empty object, not a failure');
  });

  summary('test-runtime-live');
}

main();
