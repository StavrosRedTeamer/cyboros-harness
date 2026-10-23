#!/usr/bin/env node
// tools/test-cost.js — what an engagement cost, and what it must never claim.
//
// The property under test is not "the number is right" (that is `costOf`, tested in
// test-adapters) but "the number says what it is": which price source produced it, and
// whether the total includes every call. An operator comparing this harness with an
// in-house one needs a bill they can defend, so:
//
//   · a profile with no price table reports UNKNOWN, never $0 and never a guess;
//   · a session where some calls could not be priced reports a FLOOR, and says how many
//     calls are missing;
//   · the rollup is defined in runtime/usage.js and stored in the session state, so a
//     resume continues the total;
//   · precision follows the magnitude, so a $0.000004 run is not displayed as $0.00.
//
// The display is verified through the real TUI (`--script` against a local provider),
// because a unit test on the formatter would not catch a surface that prints something
// else.
//
// test-tags: loopback
'use strict';
const assert = require('assert');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { ok, okAsync, fixture, writeScope, hermetic, runCliAsync, summary } = require('./testkit');
const sessionState = require('../runtime/session-state');   // the file (continuity)
const ledger = require('../runtime/usage');                  // the bill (what it cost)

const WS = path.join(__dirname, '..');
const TUI = path.join(WS, 'runtime', 'tui.js');
hermetic('cost');
const DIR = fixture('cost');
const SESSIONS = path.join(DIR, 'sessions');
process.env.CYBOROS_AGENT_DIR = SESSIONS;
process.env.CYBOROS_APPROVALS_FILE = path.join(DIR, 'approvals.jsonl');
process.env.SCOPE_JSON = writeScope(DIR, { allowed_hosts: ['app.example.com'], max_requests_per_second: 2 });
process.env.MOCK_KEY = 'test-key-not-a-secret';

// Async checks run after the sync ones; `summary` waits for the queue, so the exit code
// covers the live and TUI cases too.
const queue = [];
const queueOk = (name, fn) => { queue.push([name, fn]); };

const { addUsage, emptyUsage, normalizeUsage, costView, costText, costShort, formatMoney } = ledger;

// ── the rollup (runtime/usage.js) ─────────────────────────────────────────
ok('the rollup accumulates tokens, calls and cost across turns, by source', () => {
  let u = emptyUsage();
  u = addUsage(u, { tokens_in: 100, tokens_out: 10, cost: 0.02, source: 'provider' });
  u = addUsage(u, { tokens_in: 200, tokens_out: 20, cost: 0.005, source: 'declared' });
  u = addUsage(u, { tokens_in: 50, tokens_out: 5, cost: 0.001, source: 'declared' });
  assert.strictEqual(u.requests, 3);
  assert.strictEqual(u.tokens_in, 350);
  assert.strictEqual(u.tokens_out, 35);
  assert.strictEqual(u.cost.provider, 0.02);
  assert.ok(Math.abs(u.cost.declared - 0.006) < 1e-12);
  const v = costView(u);
  assert.strictEqual(v.known, true);
  assert.strictEqual(v.partial, false);
  assert.deepStrictEqual(v.sources, ['provider-reported', 'declared prices']);
  assert.ok(/provider-reported/.test(costText(v)) && /declared prices/.test(costText(v)),
    'both sources are named: ' + costText(v));
});

ok('a profile with no price table reports unknown — never zero, never a guess', () => {
  let u = emptyUsage();
  u = addUsage(u, { tokens_in: 120, tokens_out: 30, cost: null, source: null });
  const v = costView(u);
  assert.strictEqual(v.known, false, 'nothing was priced');
  assert.strictEqual(v.partial, true, 'and the call is counted as unpriced');
  assert.strictEqual(v.unpriced, 1);
  const text = costText(v);
  assert.ok(/unknown/.test(text), 'the sentence says unknown: ' + text);
  assert.ok(!/\$/.test(text), 'no dollar amount is invented: ' + text);
  assert.strictEqual(costShort(v), 'cost unknown');
});

ok('a mixed session reports a floor and how many calls are missing', () => {
  let u = emptyUsage();
  u = addUsage(u, { tokens_in: 100, cost: 0.01, source: 'declared' });
  u = addUsage(u, { tokens_in: 100, cost: null, source: null });
  u = addUsage(u, { tokens_in: 100, cost: null, source: null });
  const v = costView(u);
  assert.strictEqual(v.known, true);
  assert.strictEqual(v.partial, true);
  assert.strictEqual(v.pricedCalls, 1);
  assert.strictEqual(v.unpriced, 2);
  const text = costText(v);
  assert.ok(/floor/.test(text), 'the total is labelled a floor: ' + text);
  assert.ok(/2 call\(s\) unpriced/.test(text), text);
  assert.ok(text.startsWith(formatMoney(0.01)), 'and it still shows the priced part: ' + text);
  assert.strictEqual(costShort(v), formatMoney(0.01) + '+');
});

ok('a genuinely free call is $0, which is not the same as unknown', () => {
  let u = emptyUsage();
  u = addUsage(u, { tokens_in: 10, cost: 0, source: 'declared' });
  const v = costView(u);
  assert.strictEqual(v.known, true, 'a price of zero is a price');
  assert.strictEqual(v.partial, false, 'and nothing is missing');
  assert.strictEqual(formatMoney(v.amount), '$0');
  assert.ok(!/unknown/.test(costText(v)), costText(v));
});

ok('a legacy cost figure is kept but not attributed to a source', () => {
  const v = costView({ tokens_in: 10, tokens_out: 1, cost: 0.42 });
  assert.strictEqual(v.known, true);
  assert.strictEqual(v.requests, 0, 'the old shape counted no requests');
  assert.deepStrictEqual(v.sources, ['source unrecorded']);
  assert.ok(/source unrecorded/.test(costText(v)));
});

ok('precision follows magnitude: a cheap run is not $0.00', () => {
  assert.strictEqual(formatMoney(0), '$0');
  assert.strictEqual(formatMoney(0.000004), '$0.000004', 'six places at the bottom');
  assert.strictEqual(formatMoney(0.00042), '$0.00042', 'five places');
  assert.strictEqual(formatMoney(0.00421), '$0.00421', 'five places, still readable');
  assert.strictEqual(formatMoney(0.056), '$0.056');
  assert.strictEqual(formatMoney(1.2345), '$1.23');
  assert.strictEqual(formatMoney(1.2), '$1.20', 'dollars keep two places');
  assert.strictEqual(formatMoney(0.0042), '$0.0042', 'no padding with zeros the amount lacks');
  assert.strictEqual(formatMoney(0.05), '$0.05');
  // The case the old formatter got wrong: a sub-cent run rendered as $0.00.
  assert.notStrictEqual(formatMoney(0.000004), '$0.00');
  assert.notStrictEqual(formatMoney(0.004), '$0.00');
});

ok('the rollup is persisted with the session and survives a save without usage', () => {
  const dir = path.join(DIR, 'persist');
  const messages = [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }];
  let u = addUsage(emptyUsage(), { tokens_in: 10, tokens_out: 2, cost: 0.03, source: 'declared' });
  sessionState.save(dir, { id: 'persist', messages, usage: u });
  const first = sessionState.load(dir);
  assert.strictEqual(first.usage.requests, 1);
  assert.strictEqual(first.usage.cost.declared, 0.03);

  // A later save that carries no usage (compaction, metadata) must not reset the bill.
  sessionState.save(dir, { id: 'persist', messages, turns: 1 });
  const second = sessionState.load(dir);
  assert.strictEqual(second.usage.requests, 1, 'the accounting was preserved');
  assert.strictEqual(second.usage.cost.declared, 0.03);
});

// ── live: across turns and across a resume ────────────────────────────────
const chat = (message, usage) => ({
  choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }],
  usage,
});

function startProvider(script) {
  return new Promise((resolve) => {
    let n = 0;
    const seen = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        let parsed = {};
        try { parsed = JSON.parse(body || '{}'); } catch { /* counted as {} */ }
        seen.push(parsed);
        const payload = script(n++, seen.filter((s) => s.messages).length);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({
      port: server.address().port,
      seen,
      close: () => new Promise((r) => server.close(r)),
    }));
  });
}

function providerConfig(file, port, extra = {}) {
  fs.writeFileSync(file, JSON.stringify({
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
  }));
  return file;
}

// A profile with a deliberately large price table, so 40 prompt tokens are $0.04 and the
// display has to choose a precision that is still readable at that scale.
const PRICE = { input_per_1m: 1000, output_per_1m: 2000 };

queueOk('the loop labels the price source: provider-reported vs declared', async () => {
  const { createLive } = require('../runtime/live');
  // Turn 1: usage WITH cost (the endpoint bills itself). Turn 2: usage without cost, so
  // the profile's table has to supply it. Escalating providers exist; this is the shape.
  const provider = await startProvider((n) => (n === 0
    ? chat({ role: 'assistant', content: 'FINAL: first.' }, { prompt_tokens: 40, completion_tokens: 8, cost: 0.25 })
    : chat({ role: 'assistant', content: 'FINAL: second.' }, { prompt_tokens: 40, completion_tokens: 8 })));
  const config = providerConfig(path.join(DIR, 'providers-priced.json'), provider.port, {
    capabilities: { pricing: PRICE },
  });
  try {
    const live = createLive({ configPath: config, target: 'app.example.com' });
    await live.run('First turn.');
    await live.run('Second turn.');
    const u = live.usage();
    assert.strictEqual(u.requests, 2);
    assert.strictEqual(u.tokens_in, 80);
    assert.strictEqual(u.cost.provider, 0.25, 'the reported amount is in the provider bucket');
    assert.ok(u.cost.declared > 0, 'the second call was priced from the profile: ' + u.cost.declared);
    const v = ledger.costView(u);
    assert.strictEqual(v.partial, false);
    assert.deepStrictEqual(v.sources, ['provider-reported', 'declared prices']);
    assert.ok(Math.abs(v.amount - (0.25 + u.cost.declared)) < 1e-12);
    live.finish('ok');
  } finally {
    await provider.close();
  }
});

queueOk('an unpriced profile stays unknown in the loop, and a resume keeps the count', async () => {
  const { createLive } = require('../runtime/live');
  const provider = await startProvider(() => chat(
    { role: 'assistant', content: 'FINAL: done.' },
    { prompt_tokens: 40, completion_tokens: 8 },   // usage, but no cost
  ));
  const config = providerConfig(path.join(DIR, 'providers-unpriced.json'), provider.port);
  try {
    const first = createLive({ configPath: config, target: 'app.example.com' });
    await first.run('Assess app.example.com.');
    const id = first.session.id;
    const u1 = first.usage();
    assert.strictEqual(u1.requests, 1);
    assert.strictEqual(u1.unpriced_requests, 1);
    assert.strictEqual(ledger.costView(u1).known, false);
    first.finish('interrupted');

    const onDisk = sessionState.load(path.join(SESSIONS, id));
    assert.strictEqual(onDisk.usage.unpriced_requests, 1, 'the unpriced call is on disk');
    assert.strictEqual(ledger.costView(onDisk.usage).known, false);

    // The continuation keeps the accounting instead of starting a silent new bill.
    const second = createLive({ configPath: config, resume: id });
    const seeded = second.usage();
    assert.strictEqual(seeded.requests, 1, 'the resumed rollup is seeded from the file');
    assert.strictEqual(seeded.unpriced_requests, 1);
    await second.run('Continue.');
    const u2 = second.usage();
    assert.strictEqual(u2.requests, 2, 'and it keeps accumulating: ' + u2.requests);
    assert.strictEqual(u2.unpriced_requests, 2);
    second.finish('ok');
    const after = sessionState.load(path.join(SESSIONS, id));
    assert.strictEqual(after.usage.requests, 2);
    assert.strictEqual(ledger.costView(after.usage).known, false);
  } finally {
    await provider.close();
  }
});

// ── the real TUI path ─────────────────────────────────────────────────────
async function runTuiScript(args, input, env = {}) {
  // The target is a positional argument: `/live <arg>` takes a PROFILE name, so putting a
  // host there would ask for a profile that does not exist.
  return runCliAsync([TUI, '--script', '--config', args.config, 'app.example.com'].concat(args.extra || []), {
    cwd: WS,
    env: {
      ...process.env,
      NO_COLOR: '1',
      TERM: 'dumb',
      CYBOROS_AGENT_DIR: SESSIONS,
      SCOPE_JSON: process.env.SCOPE_JSON,
      ...env,
    },
    input,
  });
}

const finalChat = (usage) => chat({ role: 'assistant', content: 'FINAL: answered.' }, usage);

queueOk('TUI /cost shows the declared total, with its source', async () => {
  const provider = await startProvider(() => finalChat({ prompt_tokens: 40, completion_tokens: 8 }));
  const config = providerConfig(path.join(DIR, 'providers-tui-priced.json'), provider.port, {
    capabilities: { pricing: PRICE },
  });
  try {
    const r = await runTuiScript({ config }, '/live\nCheck the invoice endpoint.\n/cost\n/quit\n');
    const out = (r.stdout || '') + (r.stderr || '');
    assert.strictEqual(r.status, 0, out.slice(-500));
    // 40 in @ $1000/1M = $0.04, 8 out @ $2000/1M = $0.016 → $0.056
    const flat = out.replace(/\s+/g, ' ');
    // The dumb terminal maps the separator glyph to '.', so accept either.
    assert.ok(/cost \$0\.056\s*[.·]\s*declared prices/.test(flat),
      'the /cost line names the amount and the source: ' + flat.slice(-1200));
    assert.ok(/requests 1/.test(flat), 'one call is counted');
    assert.ok(/40 in \/ 8 out/.test(flat), 'tokens in/out are the provider counts');
    // Before the first call the status row legitimately says "cost unknown"; what must not
    // be unknown is this session once it has been priced, so look past the /cost block.
    assert.ok(!/cost unknown/.test(flat.slice(flat.indexOf('requests 1'))),
      'a priced session is not called unknown');
  } finally {
    await provider.close();
  }
});

queueOk('TUI /cost refuses to invent a price when the profile has none', async () => {
  const provider = await startProvider(() => finalChat({ prompt_tokens: 40, completion_tokens: 8 }));
  const config = providerConfig(path.join(DIR, 'providers-tui-unpriced.json'), provider.port);
  try {
    const r = await runTuiScript({ config }, '/live\nCheck the invoice endpoint.\n/cost\n/quit\n');
    const out = (r.stdout || '') + (r.stderr || '');
    assert.strictEqual(r.status, 0, out.slice(-500));
    const flat = out.replace(/\s+/g, ' ');
    assert.ok(/cost unknown \(1 call\(s\), no price reported or declared\)/.test(flat),
      'the cost line says unknown, with the reason: ' + flat.slice(-1200));
    assert.ok(!/cost \$/.test(flat), 'and no dollar figure at all: ' + flat.slice(-1200));
    assert.ok(/1 call\(s\) had no price/.test(flat), 'and the call is flagged as unpriced');
  } finally {
    await provider.close();
  }
});

queueOk('the REPL /resume carries the engagement bill into /cost', async () => {
  // A session resumed in a shell (no provider attached yet) must still answer /cost with
  // the engagement's spend, not with "nothing has been spent". Two calls, one unpriced,
  // so the restored total is also still labelled a floor.
  const id = '20261022000000-c0a5e7';
  const dir = path.join(SESSIONS, id);
  const messages = [
    { role: 'system', content: 'contract' },
    { role: 'user', content: 'check app.example.com' },
    { role: 'assistant', content: 'FINAL: ok' },
  ];
  let usage = addUsage(emptyUsage(), { tokens_in: 1000, tokens_out: 200, cost: 0.0042, source: 'declared' });
  usage = addUsage(usage, { tokens_in: 500, tokens_out: 100, cost: null });
  fs.mkdirSync(dir, { recursive: true });
  sessionState.save(dir, { id, messages, host: 'app.example.com', phase: 'web-test', usage });
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({
    started_at: '2026-10-22T00:00:00Z', phase: 'web-test', class: 'idor', status: 'open',
  }));

  const r = await runTuiScript({ config: path.join(DIR, 'unused-config.json') }, `/resume ${id}\n/cost\n/quit\n`);
  const flat = ((r.stdout || '') + (r.stderr || '')).replace(/\s+/g, ' ');
  assert.strictEqual(r.status, 0, flat.slice(-500));
  assert.ok(/spent so far: 2 call\(s\)/.test(flat), 'the restore report names the spend: ' + flat.slice(-1400));
  assert.ok(/cost \$0\.0042/.test(flat), 'and /cost reports the same amount: ' + flat.slice(-800));
  assert.ok(/declared prices/.test(flat), 'with its source');
  assert.ok(/1 call\(s\) had no price/.test(flat), 'the unpriced call is still flagged after a resume');
});

queueOk('the TUI end-of-turn line shows the running total with its source', async () => {
  const provider = await startProvider(() => finalChat({ prompt_tokens: 40, completion_tokens: 8 }));
  const config = providerConfig(path.join(DIR, 'providers-tui-turn.json'), provider.port, {
    capabilities: { pricing: PRICE },
  });
  try {
    const r = await runTuiScript({ config }, '/live\nFirst turn.\nSecond turn.\n/quit\n');
    const out = (r.stdout || '') + (r.stderr || '');
    assert.strictEqual(r.status, 0, out.slice(-500));
    const worked = out.split('\n').filter((l) => /Worked for/.test(l));
    assert.strictEqual(worked.length, 2, 'one line per turn: ' + worked.join(' | '));
    // Both turns are priced from the profile, so the badge says so and the total doubles.
    assert.ok(/\$0\.112 \(declared\)/.test(worked[1].replace(/\s+/g, ' ')),
      'the second line reports the accumulated total, labelled: ' + worked[1]);
    assert.ok(/\(declared\)/.test(worked[0]), 'the first turn carries the same label');
  } finally {
    await provider.close();
  }
});

queueOk('a new live session starts its own bill instead of inheriting the last one', async () => {
  // The rollup belongs to a session id. Detaching and reconnecting used to leave the
  // previous engagement's numbers in place, so /cost reported them under the NEW id —
  // a bill attributed to the wrong run, which is the one thing this ledger must not do.
  const provider = await startProvider(() => finalChat({ prompt_tokens: 40, completion_tokens: 8 }));
  const config = providerConfig(path.join(DIR, 'providers-tui-reconnect.json'), provider.port, {
    capabilities: { pricing: PRICE },
  });
  try {
    const r = await runTuiScript({ config }, '/live\nFirst turn.\n/live off\n/live\n/cost\n/quit\n');
    const out = (r.stdout || '') + (r.stderr || '');
    assert.strictEqual(r.status, 0, out.slice(-600));
    const flat = out.replace(/\s+/g, ' ');
    // Everything after the reconnect: the new session's own state, not the old one's.
    const at = flat.lastIndexOf('live on');
    assert.ok(at > 0, 'the second /live attached: ' + flat.slice(-800));
    const after = flat.slice(at);
    assert.ok(/requests 0/.test(after), 'the new session has made no call: ' + after.slice(0, 600));
    assert.ok(/unknown \(no usage recorded\)/.test(after),
      'and its bill is unknown, not the previous total: ' + after.slice(0, 600));
    assert.ok(!/\$0\.056/.test(after), 'the old engagement\'s amount is gone: ' + after.slice(0, 600));
  } finally {
    await provider.close();
  }
});

(async () => {
  for (const [name, fn] of queue) await okAsync(name, fn);
  summary('test-cost');
})();
