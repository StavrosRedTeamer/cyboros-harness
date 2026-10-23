#!/usr/bin/env node
// tools/test-session-state.js — continuity: what a resumed run actually gets back.
//
// The failure this guards against is the one that makes a long engagement unusable: the
// process dies, and the next one rediscovers the target, the artifacts and the findings
// from zero. So each test asserts three things at once — the state that came back, the
// evidence that it came from the file (not from a default), and that the resumed history
// still passes the same `validate()` the loop applies at the send boundary.
//
// The live half runs a real `createLive` against a local fake provider (no network, no
// key), so "restart" means what it means in production: a NEW instance loading the
// directory the previous one left behind.
//
// test-tags: loopback
'use strict';
const assert = require('assert');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  ok, okAsync, fixture, writeScope, hermetic, summary,
} = require('./testkit');
const sessionState = require('../runtime/session-state');
const { validate } = require('../local/context');

const WS = path.join(__dirname, '..');
const TUI = path.join(WS, 'runtime', 'tui.js');
hermetic('session-state');
const DIR = fixture('session-state');
const SESSIONS = path.join(DIR, 'sessions');
process.env.CYBOROS_AGENT_DIR = SESSIONS;
process.env.CYBOROS_APPROVALS_FILE = path.join(DIR, 'approvals.jsonl');
process.env.SCOPE_JSON = writeScope(DIR, {
  allowed_hosts: ['app.example.com'],
  allowed_ips: ['127.0.0.1'],
  max_requests_per_second: 2,
});
process.env.FINDINGS_JSONL = path.join(DIR, 'findings.jsonl');
process.env.MOCK_KEY = 'test-key-not-a-secret';

// ── message builders ───────────────────────────────────────────────────────
const user = (content) => ({ role: 'user', content });
const assistant = (content) => ({ role: 'assistant', content });
const call = (id, name, args) => ({
  role: 'assistant',
  content: '',
  tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
});
const result = (id, content) => ({ role: 'tool', tool_call_id: id, content });

// One turn that touches all four fact categories the digest knows: target, artifact,
// finding, action.
function conversation(host = 'app.example.com') {
  return [
    user(`Assess ${host} for broken access control.`),
    call('c1', 'scope_check', { target: host }),
    result('c1', 'IN SCOPE'),
    call('c2', 'read_file', { path: 'knowledge.md' }),
    result('c2', '# knowledge'),
    call('c3', 'record_finding', {
      title: 'BOLA on invoice endpoint',
      host,
      endpoint: '/api/invoices/1',
      severity: 'HIGH',
      status: 'inconclusive',
      verify_level: 'suspected',
    }),
    result('c3', '[record-finding exit 0] recorded'),
    assistant('FINAL: recorded the BOLA candidate.'),
  ];
}

const newDir = (tag) => path.join(DIR, tag);

// Async checks (the live restart cases) run after the sync ones; the queue keeps `summary`
// waiting for every result, so the exit code covers them too.
const queue = [];
const queueOk = (name, fn) => { queue.push([name, fn]); };

// ── save / load ────────────────────────────────────────────────────────────
ok('save then load restores the conversation and the facts, all derived from the file', () => {
  const dir = newDir('roundtrip');
  const messages = conversation();
  const saved = sessionState.save(dir, {
    id: 'roundtrip',
    host: 'app.example.com',
    phase: 'web-test',
    klass: 'authz',
    profile: 'mock',
    model: 'mock',
    turns: 1,
    last_user: 'Assess app.example.com for broken access control.',
    usage: { tokens_in: 120, tokens_out: 30, cost: 0.0004 },
    messages,
  });
  assert.ok(fs.existsSync(saved.file), 'state.json is written');

  const loaded = sessionState.load(dir);
  assert.strictEqual(loaded.status, 'ok');
  assert.ok(loaded.usable);
  assert.strictEqual(loaded.host, 'app.example.com', 'target comes back');
  assert.strictEqual(loaded.phase, 'web-test');
  assert.strictEqual(loaded.class, 'authz');
  assert.deepStrictEqual(loaded.messages, messages, 'the exact history comes back');
  assert.deepStrictEqual(validate(loaded.messages), [], 'and it is sendable');
  assert.deepStrictEqual(loaded.facts.hosts, ['app.example.com']);
  assert.deepStrictEqual(loaded.facts.files, ['knowledge.md']);
  assert.ok(loaded.facts.findings.some((f) => /BOLA on invoice endpoint/.test(f)), 'the finding is remembered');
  // `extractFacts` records a finding as a finding (severity/level/title/host), not as a
  // bare action; the action list carries the tool calls that are not evidence themselves.
  assert.ok(loaded.facts.actions.some((a) => /scope_check app\.example\.com/.test(a)), 'the action is remembered');
  assert.strictEqual(loaded.report.turns, 1);
  assert.strictEqual(loaded.usage.tokens_in, 120);
  // The facts are the context owner's output, not a second classifier.
  assert.deepStrictEqual(loaded.facts, sessionState.factsFrom(messages));
});

ok('facts accumulate across saves: a later turn does not forget an earlier finding', () => {
  const dir = newDir('union');
  sessionState.save(dir, { id: 'union', messages: conversation(), turns: 1 });
  // A second turn with ONLY the new exchange: the earlier finding must survive.
  const turn2 = [
    user('Now check the orders endpoint.'),
    call('d1', 'record_finding', {
      title: 'IDOR on orders', host: 'api.example.com', endpoint: '/api/orders/7',
      severity: 'MEDIUM', status: 'inconclusive', verify_level: 'suspected',
    }),
    result('d1', '[record-finding exit 0] recorded'),
    assistant('FINAL: recorded the IDOR.'),
  ];
  sessionState.save(dir, { id: 'union', messages: turn2, turns: 2 });
  const loaded = sessionState.load(dir);
  assert.ok(loaded.facts.findings.some((f) => /BOLA on invoice endpoint/.test(f)), 'earlier finding kept');
  assert.ok(loaded.facts.findings.some((f) => /IDOR on orders/.test(f)), 'new finding added');
  assert.ok(loaded.facts.hosts.includes('app.example.com'));
  assert.ok(loaded.facts.hosts.includes('api.example.com'));
});

ok('a session trimmed by the size cap keeps its facts and says so on resume', () => {
  const dir = newDir('trim');
  const long = [
    user('Assess app.example.com and keep going.'),
    // Early evidence the trim will drop: the target must survive in the digest.
    call('s1', 'scope_check', { target: 'app.example.com' }),
    result('s1', 'IN SCOPE'),
  ];
  for (let i = 0; i < 12; i += 1) {
    long.push(call(`t${i}`, 'read_file', { path: `reports/note-${i}.md` }));
    long.push(result(`t${i}`, 'x'.repeat(4000)));
  }
  long.push(assistant('FINAL: read everything.'));
  const saved = sessionState.save(dir, { id: 'trim', messages: long, turns: 1 }, { maxBytes: 12000 });
  assert.ok(saved.droppedMessages > 0, 'the cap actually dropped messages: ' + saved.droppedMessages);
  assert.ok(saved.droppedBlocks > 0);

  const loaded = sessionState.load(dir);
  assert.ok(loaded.usable);
  assert.strictEqual(loaded.status, 'ok');
  assert.ok(loaded.report.digestAdded, 'a digest carries what the trim removed');
  assert.ok(loaded.messages.some((m) => /state digest/.test(String(m.content))), 'the digest is in the history');
  assert.ok(loaded.messages.some((m) => /app\.example\.com/.test(String(m.content))), 'the target survives in it');
  assert.ok(loaded.facts.files.length >= 4, 'facts from the dropped turns survive: ' + loaded.facts.files.length);
  assert.deepStrictEqual(validate(loaded.messages), [], 'a digested history is still sendable');
});

// ── refusals ───────────────────────────────────────────────────────────────
ok('a truncated file is rejected, never half-used', () => {
  const dir = newDir('truncated');
  sessionState.save(dir, { id: 'truncated', messages: conversation() });
  const file = sessionState.statePath(dir);
  const text = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, text.slice(0, Math.floor(text.length * 0.6)));
  const loaded = sessionState.load(dir);
  assert.strictEqual(loaded.status, 'rejected');
  assert.strictEqual(loaded.usable, false);
  assert.ok(/not valid JSON/.test(loaded.reason), 'the reason names the truncation: ' + loaded.reason);
  assert.ok(!loaded.messages, 'nothing is offered as a history');
});

ok('an edited payload fails the integrity check', () => {
  const dir = newDir('edited');
  sessionState.save(dir, { id: 'edited', messages: conversation() });
  const file = sessionState.statePath(dir);
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  doc.payload.host = 'attacker.example.net';
  fs.writeFileSync(file, JSON.stringify(doc, null, 2) + '\n');
  const loaded = sessionState.load(dir);
  assert.strictEqual(loaded.status, 'rejected');
  assert.ok(/integrity mismatch/.test(loaded.reason), loaded.reason);
});

ok('an unknown state version is refused instead of guessed at', () => {
  const dir = newDir('version');
  sessionState.save(dir, { id: 'version', messages: conversation() });
  const file = sessionState.statePath(dir);
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  doc.payload.version = sessionState.VERSION + 1;
  doc.integrity = sessionState.integrity(doc.payload);
  fs.writeFileSync(file, JSON.stringify(doc, null, 2) + '\n');
  const loaded = sessionState.load(dir);
  assert.strictEqual(loaded.status, 'rejected');
  assert.ok(/unsupported state version/.test(loaded.reason), loaded.reason);
});

ok('a session with no state file is absent, not empty-but-fine', () => {
  const loaded = sessionState.load(newDir('nothing-here'));
  assert.strictEqual(loaded.status, 'absent');
  assert.strictEqual(loaded.usable, false);
  assert.ok(/never saved/.test(loaded.reason));
});

ok('a stale session needs an explicit decision', () => {
  const dir = newDir('stale');
  const old = new Date(Date.now() - 30 * 24 * 3600e3).toISOString();
  sessionState.save(dir, { id: 'stale', messages: conversation(), saved_at: old });
  const refused = sessionState.load(dir);
  assert.strictEqual(refused.status, 'stale');
  assert.strictEqual(refused.usable, false, 'stale is not usable by default');
  assert.ok(/stale session/.test(refused.reason), refused.reason);
  const allowed = sessionState.load(dir, { allowStale: true });
  assert.strictEqual(allowed.usable, true, 'an explicit allowStale continues anyway');
  assert.ok(Array.isArray(allowed.messages) && allowed.messages.length);
});

ok('an orphaned tool result is repaired, reported, and still sendable', () => {
  const dir = newDir('orphan');
  const broken = [
    user('Assess app.example.com.'),
    call('x1', 'scope_check', { target: 'app.example.com' }),
    result('x1', 'IN SCOPE'),
    // No assistant tool_calls precedes this: half an exchange, the 400 case.
    result('x2', 'stray output with no call'),
    assistant('FINAL: done.'),
  ];
  // Saved verbatim (the cap is generous), so the corruption lives in the file itself.
  sessionState.save(dir, { id: 'orphan', messages: broken });
  const loaded = sessionState.load(dir);
  assert.strictEqual(loaded.status, 'repaired');
  assert.ok(loaded.usable);
  assert.ok(loaded.report.repaired.some((r) => /orphan-tool-result|unmatched-tool-result/.test(r.reason)),
    'the repair is named: ' + JSON.stringify(loaded.report.repaired));
  assert.deepStrictEqual(validate(loaded.messages), [], 'the repaired history passes the send boundary');
  assert.ok(!loaded.messages.some((m) => m.role === 'tool' && m.tool_call_id === 'x2'), 'the orphan is gone');
});

// ── live: kill and restart ─────────────────────────────────────────────────
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
        max_tool_iters: 8,
        context_char_budget: 20000,
        ...extra,
      },
    },
  }));
  return file;
}

function chat(message) {
  return { choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 40, completion_tokens: 8 } };
}

function toolCall(name, args) {
  return chat({
    role: 'assistant',
    content: '',
    tool_calls: [{ id: `call_${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
  });
}

// Answers the scripted sequence and records every request body: the second process is
// asserted against what it SENT, not against what it claims to remember.
function startProvider(script) {
  return new Promise((resolve) => {
    let n = 0;
    const seen = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        let parsed = {};
        try { parsed = JSON.parse(body || '{}'); } catch { /* recorded as {} */ }
        seen.push(parsed);
        const payload = typeof script === 'function' ? script(n++, parsed) : script[Math.min(n++, script.length - 1)];
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

const turn1Script = () => [
  toolCall('scope_check', { target: 'app.example.com' }),
  toolCall('read_file', { path: 'knowledge.md' }),
  toolCall('record_finding', {
    title: 'BOLA on invoice endpoint',
    host: 'app.example.com',
    endpoint: '/api/invoices/1',
    severity: 'HIGH',
    status: 'inconclusive',
    verify_level: 'suspected',
  }),
  chat({ role: 'assistant', content: 'FINAL: recorded the BOLA candidate.' }),
];

const finalScript = () => [chat({ role: 'assistant', content: 'FINAL: continuing where we left off.' })];

// The same provider serves both processes: the first turn's four responses, then the
// continuation's. One server, because a restart changes the process, not the endpoint.
const twoTurnScript = (n) => {
  const first = turn1Script();
  return n < first.length ? first[n] : finalScript()[0];
};

queueOk('kill and restart: a new instance continues the session with zero re-scan', async () => {
  const { createLive } = require('../runtime/live');
  const provider = await startProvider(twoTurnScript);
  const config = providerConfig(path.join(DIR, 'providers-live.json'), provider.port);
  try {
    // ── process 1: one real turn, then "the process dies" ─────────────────
    const first = createLive({ configPath: config, target: 'app.example.com', phase: 'web-test', klass: 'authz' });
    const r1 = await first.run('Assess app.example.com for broken access control.');
    assert.ok(/BOLA/.test(r1.text), 'the first turn ran end to end');
    const id = first.session.id;
    first.finish('interrupted');            // as a crash would leave it
    const saved = sessionState.load(path.join(SESSIONS, id));
    assert.strictEqual(saved.usable, true, 'the turn was persisted before finish');
    assert.ok(saved.facts.findings.length >= 1, 'the finding is in the state file: ' + JSON.stringify(saved.facts));
    assert.ok(saved.facts.hosts.includes('app.example.com'), 'the target is in the state file: ' + JSON.stringify(saved.facts.hosts));
    // The session list reads meta.json: a finished run must not look unknown forever.
    const meta = JSON.parse(fs.readFileSync(path.join(SESSIONS, id, 'meta.json'), 'utf8'));
    assert.strictEqual(meta.status, 'interrupted');
    const requestsFirst = provider.seen.length;
    assert.ok(requestsFirst >= 4, 'the scripted turn really called the provider');

    // ── process 2: a NEW instance resuming that directory ─────────────────
    const second = createLive({ configPath: config, resume: id });
    const resumed = second.resumed();
    assert.ok(resumed, 'the continuation reports what it restored');
    assert.strictEqual(second.session.id, id, 'the same session, not a second one');
    assert.ok(second.history() && second.history().length >= 8, 'the history came back: ' + (second.history() || []).length);
    assert.ok(resumed.facts.hosts.includes('app.example.com'), 'resumed hosts: ' + JSON.stringify(resumed.facts.hosts));
    assert.ok(resumed.facts.findings.some((f) => /BOLA/.test(f)), 'resumed findings: ' + JSON.stringify(resumed.facts.findings));
    assert.strictEqual(resumed.host, 'app.example.com', 'the target is the resumed one, not a blank');

    // The continuation turn sends the earlier work, so nothing is rediscovered.
    const r2 = await second.run('Continue with the orders endpoint.');
    assert.ok(/continuing/.test(r2.text), 'the continuation turn produced an answer: ' + JSON.stringify(r2.text).slice(0, 200));
    const sent = provider.seen[provider.seen.length - 1];
    const wire = JSON.stringify(sent.messages || []);
    assert.ok(/record_finding/.test(wire), 'the resumed request carries the earlier tool call');
    assert.ok(/BOLA on invoice endpoint/.test(wire), 'and its evidence');
    assert.ok(/app\.example\.com/.test(wire), 'and the target');
    assert.ok(sent.messages.some((m) => m.role === 'system'), 'the contract is still first');
    second.finish('ok');

    const afterSecond = sessionState.load(path.join(SESSIONS, id));
    assert.strictEqual(afterSecond.report.turns, 2, 'the turn counter continued: ' + afterSecond.report.turns);
    // The resume itself is on the record.
    const events = fs.readFileSync(path.join(SESSIONS, id, 'events.jsonl'), 'utf8')
      .trim().split('\n').map((l) => JSON.parse(l));
    assert.ok(events.some((e) => e.type === 'session_resume'), 'the resume is logged');
    assert.ok(events.some((e) => e.type === 'state_saved'), 'each save is logged');
  } finally {
    await provider.close();
  }
});

queueOk('a compacted conversation resumes with the contract intact', async () => {
  const { createLive } = require('../runtime/live');
  const provider = await startProvider(turn1Script());
  // A budget small enough that the turn must compact: this is the shape that used to
  // leave a resumed history with no contract and no way to tell.
  const config = providerConfig(path.join(DIR, 'providers-tight.json'), provider.port, {
    context_char_budget: 3000,
    max_tokens: 256,
  });
  try {
    const first = createLive({ configPath: config, target: 'app.example.com' });
    const r1 = await first.run('Assess app.example.com for broken access control.');
    assert.ok(r1.messages.length > 0);
    const id = first.session.id;
    first.finish('interrupted');

    const loaded = sessionState.load(path.join(SESSIONS, id));
    assert.ok(loaded.usable, 'tight-budget session loads: ' + loaded.reason);
    assert.ok(loaded.messages.some((m) => m.role === 'system'), 'the contract is in the saved history');
    assert.deepStrictEqual(validate(loaded.messages), [], 'and it is sendable');

    const second = createLive({ configPath: config, resume: id });
    const r2 = await second.run('Continue.');
    const sent = provider.seen[provider.seen.length - 1];
    assert.ok(sent.messages.some((m) => m.role === 'system' && /Cyboros/.test(String(m.content))),
      'the continued request still carries the engagement contract');
    assert.ok(sent.messages.length <= 40, 'compaction is what bounds it, not luck');
    assert.ok(r2.text.length > 0);
    second.finish('ok');
  } finally {
    await provider.close();
  }
});

queueOk('compacting persists the trimmed history, so a restart resumes what was kept', async () => {
  const { createLive } = require('../runtime/live');
  const provider = await startProvider(turn1Script());
  const config = providerConfig(path.join(DIR, 'providers-compact.json'), provider.port, {
    context_char_budget: 3000,
    max_tokens: 256,
  });
  try {
    const live = createLive({ configPath: config, target: 'app.example.com' });
    await live.run('Assess app.example.com.');
    const id = live.session.id;
    const before = sessionState.load(path.join(SESSIONS, id));
    const compacted = live.compact(before.messages.concat([
      user('Next, check the orders endpoint and the invoice export.'),
      assistant('FINAL: noted.'),
    ]));
    const saved = live.saveState(compacted.messages);
    assert.ok(saved && !saved.error, 'the compacted history is written: ' + JSON.stringify(saved));
    const after = sessionState.load(path.join(SESSIONS, id));
    assert.strictEqual(after.messages.length, compacted.messages.length, 'the file holds the trimmed history');
    assert.deepStrictEqual(validate(after.messages), [], 'and it is sendable');
    assert.ok(after.report.turns >= 1, 'the turn count is not reset by a compaction');
    live.finish('ok');
  } finally {
    await provider.close();
  }
});

queueOk('a rejected state file refuses the resume instead of starting fresh', async () => {
  const { createLive } = require('../runtime/live');
  const provider = await startProvider(turn1Script());
  const config = providerConfig(path.join(DIR, 'providers-broken.json'), provider.port);
  try {
    const first = createLive({ configPath: config, target: 'app.example.com' });
    await first.run('Assess app.example.com.');
    const id = first.session.id;
    first.finish('interrupted');
    fs.writeFileSync(sessionState.statePath(path.join(SESSIONS, id)), '{"integrity":"sha256:00","payload":{"version":1');
    assert.throws(() => createLive({ configPath: config, resume: id }), (e) => {
      assert.match(e.message, /cannot resume/);
      assert.match(e.message, /not valid JSON|integrity/);
      return true;
    });
  } finally {
    await provider.close();
  }
});

queueOk('a stale session refuses the resume unless it is explicitly allowed', async () => {
  const { createLive } = require('../runtime/live');
  const provider = await startProvider(turn1Script());
  const config = providerConfig(path.join(DIR, 'providers-stale.json'), provider.port);
  try {
    const first = createLive({ configPath: config, target: 'app.example.com' });
    await first.run('Assess app.example.com.');
    const id = first.session.id;
    first.finish('interrupted');
    const dir = path.join(SESSIONS, id);
    const old = new Date(Date.now() - 40 * 24 * 3600e3).toISOString();
    sessionState.save(dir, { id, messages: sessionState.load(dir).messages, host: 'app.example.com', saved_at: old });

    assert.throws(() => createLive({ configPath: config, resume: id }), (e) => /stale session/.test(e.message));
    const allowed = createLive({ configPath: config, resume: id, allowStale: true });
    assert.ok(allowed.history().length > 0, 'an explicit override resumes the history');
    allowed.finish('ok');
  } finally {
    await provider.close();
  }
});

// ── TUI ────────────────────────────────────────────────────────────────────
const runTui = (args, input) => spawnSync(process.execPath, [TUI, '--script'].concat(args), {
  cwd: WS,
  encoding: 'utf8',
  timeout: 30000,
  input,
  env: {
    ...process.env,
    NO_COLOR: '1',
    TERM: 'dumb',
    CYBOROS_SESSIONS_DIR: SESSIONS,
    SCOPE_JSON: process.env.SCOPE_JSON,
  },
});

ok('/resume loads a saved session and names what it restored', () => {
  const dir = path.join(SESSIONS, 'tui-resume');
  sessionState.save(dir, {
    id: 'tui-resume',
    host: 'app.example.com',
    phase: 'web-test',
    klass: 'authz',
    turns: 3,
    last_user: 'Assess app.example.com for broken access control.',
    messages: conversation(),
  });
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({
    id: 'tui-resume', started_at: '2026-10-20T09:00:00Z', phase: 'web-test', class: 'authz', status: 'interrupted',
  }));

  const r = runTui([], '/sessions\n/resume tui-resume\n/status\n/quit\n');
  const out = r.stdout + r.stderr;
  assert.strictEqual(r.status, 0, out.slice(-400));
  assert.ok(out.includes('tui-resume'), 'the session is listed');
  assert.ok(/resumable|msg ·/.test(out), 'the list says what can be resumed: ' + out.slice(0, 600));
  assert.ok(/8 message\(s\)/.test(out), 'the attach reports the restored message count');
  assert.ok(/1 target\(s\)/.test(out), 'and the targets');
  assert.ok(/1 finding\(s\)/.test(out), 'and the findings');
  assert.ok(out.includes('continues this session'), 'it says what happens next');
  assert.ok(/resume:\s+tui-resume/.test(out.replace(/\x1b\[[0-9;]*m/g, '')), '/status shows the pending resume');
});

ok('/resume refuses a stale session with the reason, and an unknown id', () => {
  const dir = path.join(SESSIONS, 'tui-stale');
  const old = new Date(Date.now() - 40 * 24 * 3600e3).toISOString();
  sessionState.save(dir, { id: 'tui-stale', messages: conversation(), host: 'app.example.com', saved_at: old });
  const r = runTui([], '/resume tui-stale\n/resume nope\n/quit\n');
  const out = r.stdout + r.stderr;
  assert.strictEqual(r.status, 0, out.slice(-400));
  assert.ok(out.includes('cannot resume tui-stale'), 'a stale file is a refusal, not a fresh start');
  assert.ok(/stale session/.test(out), 'with the reason: ' + out.slice(0, 600));
  assert.ok(out.includes('allow-stale'), 'and the flag that would allow it');
  assert.ok(out.includes('is not a session'), 'an unknown id is still refused');
});

(async () => {
  for (const [name, fn] of queue) await okAsync(name, fn);
  summary('test-session-state');
})();
