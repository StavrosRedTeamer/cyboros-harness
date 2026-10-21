// test-tags: loopback
// The console chat as an acting surface, proven end to end through the real HTTP
// route and a fake (but protocol-accurate) OpenAI-compatible provider.
//
// What this test is allowed to be sure about, and why:
//   · the PENTEST preset really executes a guarded tool — the model asks for
//     scope_check, the dispatch runs tools/scope-guard.js as a child process, and the
//     SSE stream reports the result. A model's prose cannot fake that frame;
//   · the ANALYSIS preset really refuses — run_tool is absent from the schema sent to
//     the provider AND blocked at dispatch, so a model that invents the call gets a
//     tool_result {blocked:true, reason:'preset'} and nothing is spawned;
//   · an intrusive tool (sqlmap, risk_tier=intrusive in tools/tool-registry.json)
//     parks on the operator approval and a deny means it never runs;
//   · a turn is persisted and the next turn resumes it (the provider sees the earlier
//     conversation, including the tool result, in the request it receives);
//   · a STOPPED turn keeps the frames the operator already saw — the transcript is
//     written as the turn runs, so reopening it from the rail is not an empty thread;
//   · a model that only ever asks for tools is pushed to answer: the tool budget ends
//     in a closing request with no schema, not in a cap message.
//
// The approve path is exercised by DENYING: the point of the gate is that a refusal
// is honoured, and a test that approves an intrusive tool would have to spawn one.
// Run: node tools/test-console-chat.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const vm = require('vm');
const { spawn } = require('child_process');
const identity = require('./identity');
const { okAsync, summary, fixture } = require('./testkit');

const WS = path.join(__dirname, '..');
const T = fixture('cyboros-chat');
const ROOT = path.join(T, 'data');
const USERS = path.join(ROOT, 'users.json');
const SCOPE = path.join(ROOT, 'scope.json');
const REPORTS = path.join(ROOT, 'reports');
const PROVIDERS = path.join(T, 'providers.json');
const PW = 'a long enough pass';
const REPORT_MARKER = 'FINDING-MARKER: prior engagement report';

fs.mkdirSync(REPORTS, { recursive: true });
fs.writeFileSync(SCOPE, JSON.stringify({
  allowed_hosts: ['127.0.0.1'], allowed_ips: [], allowed_url_prefixes: [], max_requests_per_second: 5,
}, null, 2));
const reportFile = path.join(REPORTS, 'prior-report.txt');
fs.writeFileSync(reportFile, `${REPORT_MARKER}\nstatus: confirmed · verify_level: triggered\n`);

// ── fake provider ──────────────────────────────────────────────────────────
// Scripted by the user's last message, because that is what a test can control:
//   EXECUTE      -> run_tool sqlmap (intrusive: must hit the approval gate)
//   READ_REPORT  -> read_file on the report inside the CONFIGURED data root
//   ABORT_ME     -> one real tool call, then a provider request that never answers
//                   (the operator's Stop is the only way out)
//   LOOP         -> a different tool call on every request, for as long as a schema is
//                   offered: only the closing (tool-less) request gets an answer
//   otherwise    -> scope_check on an authorized loopback host
// Once a tool result is in the history it answers with plain text, which ends the turn.
function startFakeProvider() {
  const seen = [];
  let loopN = 0;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch { /* recorded as-is below */ }
      seen.push(body);
      const messages = body.messages || [];
      const lastUser = [...messages].reverse().find((m) => m.role === 'user');
      const text = String((lastUser && lastUser.content) || '');
      // The closing request appends a budget directive as the last user message, so the
      // script word has to be looked for in the whole conversation, not only in the tail.
      const allText = messages.map((m) => String(m.content || '')).join('\n');
      const sawTool = messages.some((m) => m.role === 'tool');
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
      const frame = (o) => res.write('data: ' + JSON.stringify(o) + '\n\n');
      const callTool = (name, args, id) => {
        frame({
          choices: [{
            index: 0,
            delta: {
              role: 'assistant',
              tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
            },
          }],
        });
        frame({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
      };
      if (!sawTool && /ABORT_ME/.test(text)) {
        callTool('scope_check', { target: '127.0.0.1' }, 'call_abort_1');
      } else if (/ABORT_ME/.test(text)) {
        // Hold the second request open: the console has already emitted the tool card and
        // its result, so the abort lands mid-turn — exactly the case that used to be lost.
        req.on('close', () => { try { res.destroy(); } catch { /* gone */ } });
        return;
      } else if (/LOOP/.test(allText)) {
        if (Array.isArray(body.tools) && body.tools.length) {
          loopN += 1;
          const path = ['alpha', 'bravo', 'charlie', 'delta', 'echo'][loopN % 5];
          callTool('scope_check', { target: `http://127.0.0.1/${path}${loopN}` }, `call_loop_${loopN}`);
        } else {
          frame({ choices: [{ index: 0, delta: { content: 'budget answer' } }] });
          frame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
        }
      } else if (!sawTool && /EXECUTE/.test(text)) {
        callTool('run_tool', { bin: 'sqlmap', args: ['-u', 'http://127.0.0.1/item?id=1', '--batch'] }, 'call_exec_1');
      } else if (!sawTool && /READ_REPORT/.test(text)) {
        callTool('read_file', { path: reportFile }, 'call_read_1');
      } else if (!sawTool) {
        callTool('scope_check', { target: '127.0.0.1' }, 'call_scope_1');
      } else {
        frame({ choices: [{ index: 0, delta: { content: 'turn complete' } }] });
        frame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
        frame({ usage: { prompt_tokens: 11, completion_tokens: 3 } });
      }
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, seen, port: server.address().port }));
  });
}

// ── server + client helpers ────────────────────────────────────────────────
function startConsole() {
  const env = Object.assign({}, process.env, {
    CC_ROOT: ROOT,
    CC_STATE_DIR: path.join(ROOT, 'app'),
    SCOPE_JSON: SCOPE,
    AUDIT_DIR: path.join(T, 'audit'),
    CC_APPROVALS_FILE: path.join(T, 'approvals.jsonl'),
    CYBOROS_PROVIDERS: PROVIDERS,
    // A key file this test owns, so the menu's availability check can be exercised
    // against the same resolver a turn uses.
    XDG_CONFIG_HOME: path.join(T, 'xdg'),
    GUI_PORT: '0',
  });
  const child = spawn(process.execPath, [path.join(WS, 'tools', 'gui-server.js'), '--print-port', '--instance'], { cwd: WS, env });
  let out = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.stderr.on('data', (d) => { out += d.toString(); });
  return { child, output: () => out };
}

function waitPort(output, ms) {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const m = output().match(/SCC_PORT=(\d+)/);
      if (m) return resolve(Number(m[1]));
      if (Date.now() - t0 > ms) return reject(new Error('console did not print a port\n' + output()));
      setTimeout(tick, 50);
    };
    tick();
  });
}

function call(port, method, p, opts) {
  const o = opts || {};
  const headers = {};
  if (o.cookie) headers.cookie = o.cookie;
  if (o.body) headers['content-type'] = 'application/json';
  return fetch(`http://127.0.0.1:${port}${p}`, {
    method, headers, body: o.body ? JSON.stringify(o.body) : undefined, redirect: 'manual',
  }).then(async (res) => {
    let json = null;
    try { json = await res.json(); } catch { /* text */ }
    return { status: res.status, json, setCookie: res.headers.get('set-cookie'), contentType: res.headers.get('content-type') };
  });
}

async function login(port, username, password) {
  const r = await call(port, 'POST', '/api/auth/login', { body: { username, password } });
  assert.strictEqual(r.status, 200, 'login ' + username + ': ' + JSON.stringify(r.json));
  return r.setCookie.split(';')[0];
}

// Streams one turn and exposes the frames while they arrive, so an approval can be
// answered from the test without waiting for the turn to finish.
async function openTurn(port, cookie, body, opts) {
  const res = await fetch(`http://127.0.0.1:${port}/api/chat`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: opts && opts.signal,
  });
  if (res.status !== 200) {
    let detail = '';
    try { detail = await res.text(); } catch { /* ignore */ }
    throw new Error(`turn refused: HTTP ${res.status} ${detail}`);
  }
  const events = [];
  const pump = (async () => {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) !== -1) {
        const frame = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const line = frame.split('\n').find((l) => l.startsWith('data:'));
        if (!line) continue;
        try { events.push(JSON.parse(line.slice(5).trim())); } catch { /* keep only JSON frames */ }
      }
    }
  })();
  const waitFor = async (pred, ms = 20000) => {
    const t0 = Date.now();
    for (;;) {
      const hit = events.find(pred);
      if (hit) return hit;
      if (Date.now() - t0 > ms) throw new Error('timeout; frames: ' + events.map((e) => e.type).join(','));
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  return { events, waitFor, waitDone: () => waitFor((e) => e.type === 'done'), pump };
}

// ── run ────────────────────────────────────────────────────────────────────
(async () => {
  const fake = await startFakeProvider();
  fs.writeFileSync(PROVIDERS, JSON.stringify({
    version: 1,
    default_profile: 'fake',
    allow_cloud: true,
    profiles: {
      fake: {
        type: 'openai-compatible',
        base_url: `http://127.0.0.1:${fake.port}/v1`,
        model: 'fake-model',
        models: ['fake-model', 'fake-alt'],
        egress: 'local',
        temperature: 0,
        max_tokens: 256,
        max_tool_iters: 4,
        max_tool_calls: 3,
        request_timeout_ms: 15000,
        context_char_budget: 8000,
      },
      // Two cloud profiles that differ only in where the key lives: one in the
      // operator's key file, one nowhere. The menu must follow resolveKey — the same
      // resolver the turn uses — or it disables a profile that would have run.
      cloudkey: {
        type: 'openai-compatible',
        base_url: 'https://example.invalid/v1',
        model: 'cloud-model',
        api_key_env: 'CLOUD_TEST_KEY',
        egress: 'cloud',
      },
      nokey: {
        type: 'openai-compatible',
        base_url: 'https://example.invalid/v1',
        model: 'cloud-model-2',
        api_key_env: 'NO_SUCH_KEY_FOR_TEST',
        egress: 'cloud',
      },
    },
  }, null, 2));
  fs.mkdirSync(path.join(T, 'xdg', 'cyboros'), { recursive: true });
  const keyFile = path.join(T, 'xdg', 'cyboros', 'cloudkey.env');
  fs.writeFileSync(keyFile, 'CLOUD_TEST_KEY=sk-from-the-key-file\n');
  fs.chmodSync(keyFile, 0o600);

  const seed = identity.createIdentity({ usersFile: USERS, serviceToken: null, auditSink: () => ({ ok: true }) });
  const added = seed.addUser({ username: 'opa', role: 'operator', password: PW }, { actor: 'test' });
  assert.strictEqual(added.ok, true, 'seed operator: ' + (added.error || ''));

  const consoleApp = startConsole();
  const cleanup = () => {
    try { consoleApp.child.kill('SIGKILL'); } catch { /* gone */ }
    try { fake.server.close(); } catch { /* gone */ }
    // The ABORT_ME fixture holds a provider request open on purpose; without this the
    // test process would linger on that socket after the assertions are done.
    try { if (fake.server.closeAllConnections) fake.server.closeAllConnections(); } catch { /* gone */ }
  };
  process.on('exit', cleanup);

  let port;
  let cookie;
  let sessionId;

  await okAsync('the operator can list models, presets and sessions', async () => {
    port = await waitPort(consoleApp.output, 20000);
    cookie = await login(port, 'opa', PW);

    const models = await call(port, 'GET', '/api/chat/models', { cookie });
    assert.strictEqual(models.status, 200, JSON.stringify(models.json));
    const entry = (models.json.models || []).find((m) => m.id === 'fake');
    assert.ok(entry, 'the fake profile appears in the model menu');
    assert.strictEqual(entry.available, true);
    assert.strictEqual(entry.egress, 'local', 'loopback endpoint is classified local');

    const cloudKey = (models.json.models || []).find((m) => m.id === 'cloudkey');
    assert.ok(cloudKey, 'the cloud profile is listed');
    assert.strictEqual(cloudKey.available, true,
      'a key in the per-profile key file makes the profile selectable, exactly as a turn would resolve it');
    assert.strictEqual(cloudKey.reason, null);
    const noKey = (models.json.models || []).find((m) => m.id === 'nokey');
    assert.strictEqual(noKey.available, false, 'a profile with no key anywhere stays disabled');
    assert.match(String(noKey.reason), /no key/, 'and says what to set: ' + noKey.reason);

    const presets = await call(port, 'GET', '/api/chat/presets', { cookie });
    assert.strictEqual(presets.status, 200);
    const ids = presets.json.presets.map((p) => p.id);
    assert.deepStrictEqual(ids, ['pentest', 'analysis', 'chat'], 'presets are pentest, analysis, conversation');
    assert.strictEqual(presets.json.default, 'pentest');

    const list = await call(port, 'GET', '/api/chat/sessions', { cookie });
    assert.strictEqual(list.status, 200);
    assert.deepStrictEqual(list.json.sessions, [], 'a fresh data root has no conversations');
  });

  await okAsync('pentest preset executes a real guarded tool inside the turn', async () => {
    const turn = await openTurn(port, cookie, {
      preset: 'pentest',
      messages: [{ role: 'user', content: 'check the scope of 127.0.0.1' }],
    });
    const done = await turn.waitDone();
    await turn.pump;

    const meta = turn.events.find((e) => e.type === 'meta');
    assert.ok(meta, 'the turn starts with a meta frame');
    assert.strictEqual(meta.preset, 'pentest');
    assert.strictEqual(meta.readonly, false);
    assert.ok(meta.tools.includes('run_tool'), 'pentest may offer run_tool');
    assert.ok(done.session && /^chat-/.test(done.session), 'the turn is persisted as a session');

    const callFrame = turn.events.find((e) => e.type === 'tool_call');
    const resultFrame = turn.events.find((e) => e.type === 'tool_result');
    assert.ok(callFrame && resultFrame, 'both the call and its result are on the wire');
    assert.strictEqual(callFrame.tool, 'scope_check');
    assert.strictEqual(callFrame.id, resultFrame.id, 'result correlates with the call by id');
    assert.strictEqual(resultFrame.ok, true, 'scope-guard exited 0: ' + resultFrame.output);
    assert.match(resultFrame.output, /IN SCOPE: 127\.0\.0\.1/, 'the tool really ran against the temp scope');
    assert.ok(turn.events.indexOf(callFrame) < turn.events.indexOf(resultFrame), 'call precedes result');
    assert.strictEqual(done.text, 'turn complete');
    assert.strictEqual(done.stopped, false);
    sessionId = done.session;
  });

  await okAsync('the conversation is stored and the next turn resumes it', async () => {
    const stored = await call(port, 'GET', `/api/chat/sessions/${sessionId}`, { cookie });
    assert.strictEqual(stored.status, 200, JSON.stringify(stored.json));
    assert.ok(stored.json.messages.some((m) => m.role === 'user' && /check the scope/.test(m.content)), 'user turn kept');
    assert.ok(stored.json.messages.some((m) => m.role === 'tool'), 'the tool result is kept, so the model keeps its evidence');
    assert.ok(stored.json.transcript.some((e) => e.type === 'tool_call' && e.tool === 'scope_check'), 'transcript can be redrawn');

    // What the chat view does on mount: newest conversation, then its messages.
    const newest = await call(port, 'GET', '/api/chat/sessions?limit=1', { cookie });
    assert.strictEqual(newest.status, 200);
    assert.strictEqual(newest.json.sessions[0].id, sessionId, 'the newest conversation is the one a reload resumes');
    const resumable = stored.json.messages.filter((m) => m.role === 'user' || (m.role === 'assistant' && m.content));
    assert.ok(resumable.some((m) => m.role === 'user'), 'a reload can redraw the question');
    assert.ok(resumable.some((m) => m.role === 'assistant'), 'a reload can redraw the answer');

    const before = fake.seen.length;
    const turn = await openTurn(port, cookie, {
      session: sessionId,
      preset: 'pentest',
      messages: [{ role: 'user', content: 'recap what we did' }],
    });
    const done = await turn.waitDone();
    await turn.pump;
    assert.strictEqual(done.session, sessionId, 'resume keeps the same session id');

    const request = fake.seen[before];
    assert.ok(request, 'the provider was called');
    assert.ok(request.messages.some((m) => m.role === 'tool'), 'the earlier tool result was replayed to the model');
    assert.ok(request.messages.some((m) => m.content === 'check the scope of 127.0.0.1'), 'the earlier user turn was replayed');
    assert.strictEqual(done.text, 'turn complete');
  });

  await okAsync('the model sticks to the conversation, and rewrites go through the store', async () => {
    // Two turns already ran in this session; both the redraw transcript and the model
    // history must have accumulated them (a resumed turn used to replace the transcript).
    const stored = await call(port, 'GET', `/api/chat/sessions/${sessionId}`, { cookie });
    const users = stored.json.messages.filter((m) => m.role === 'user').length;
    assert.strictEqual(users, 2, 'two questions are in the history');
    assert.strictEqual(stored.json.transcript.filter((e) => e.type === 'user').length, 2, 'the redraw transcript accumulated both questions');

    const switched = await call(port, 'POST', `/api/chat/sessions/${sessionId}`, { cookie, body: { model: 'fake:fake-alt' } });
    assert.strictEqual(switched.status, 200, JSON.stringify(switched.json));
    assert.strictEqual(switched.json.session.model.id, 'fake:fake-alt');
    const afterSwitch = await call(port, 'GET', `/api/chat/sessions/${sessionId}`, { cookie });
    assert.strictEqual(afterSwitch.json.model.id, 'fake:fake-alt', 'the choice is on the session, not in the tab');
    const unknown = await call(port, 'POST', `/api/chat/sessions/${sessionId}`, { cookie, body: { model: 'nope' } });
    assert.strictEqual(unknown.status, 400, 'an unknown model is refused');

    // Regenerate re-runs the last question in place: one more answer, no new question.
    const regen = await openTurn(port, cookie, { session: sessionId, regenerate: true, model: 'fake' });
    await regen.waitDone();
    await regen.pump;
    const afterRegen = await call(port, 'GET', `/api/chat/sessions/${sessionId}`, { cookie });
    assert.strictEqual(afterRegen.json.messages.filter((m) => m.role === 'user').length, 2, 'regenerate does not duplicate the question');
    assert.strictEqual(afterRegen.json.transcript.filter((e) => e.type === 'assistant').length, 2, 'the old answer was replaced, not stacked');
    const doneFrame = regen.events.find((e) => e.type === 'done');
    assert.ok(doneFrame.model && doneFrame.durationMs >= 0, 'the answer carries model and duration metadata');

    // Edit-and-resend rewrites the second question and drops the answer that followed it.
    const edit = await openTurn(port, cookie, {
      session: sessionId, model: 'fake',
      edit: { user: 1, content: 'REWRITTEN question' },
    });
    await edit.waitDone();
    await edit.pump;
    const afterEdit = await call(port, 'GET', `/api/chat/sessions/${sessionId}`, { cookie });
    const editedUsers = afterEdit.json.messages.filter((m) => m.role === 'user').map((m) => m.content);
    assert.deepStrictEqual(editedUsers, ['check the scope of 127.0.0.1', 'REWRITTEN question'], 'the rewrite starts at the edited message');
    assert.deepStrictEqual(afterEdit.json.transcript.filter((e) => e.type === 'user').map((e) => e.content), editedUsers, 'the redraw transcript matches the history');
    assert.strictEqual(afterEdit.json.transcript.filter((e) => e.type === 'assistant').length, 2, 'one answer per question remains');
    const bad = await call(port, 'POST', '/api/chat', { cookie, body: { session: sessionId, edit: { user: 9, content: 'nope' } } });
    assert.strictEqual(bad.status, 400, 'an unknown user turn is refused');
    assert.match(String(bad.json.error), /unknown user turn/);
  });

  await okAsync('analysis preset refuses an active tool on the server, not just in the prompt', async () => {
    const before = fake.seen.length;
    const turn = await openTurn(port, cookie, {
      preset: 'analysis',
      messages: [{ role: 'user', content: 'EXECUTE the exploit anyway' }],
    });
    const done = await turn.waitDone();
    await turn.pump;

    const meta = turn.events.find((e) => e.type === 'meta');
    assert.strictEqual(meta.readonly, true, 'meta tells the UI this turn cannot act');
    assert.ok(!meta.tools.includes('run_tool'), 'the allowlist does not contain run_tool');

    const offered = (fake.seen[before].tools || []).map((t) => t.function.name);
    assert.ok(offered.length > 0, 'analysis still offers the read-only tools');
    assert.ok(!offered.includes('run_tool'), 'run_tool is not even offered to the model');
    assert.ok(!offered.includes('pipeline'), 'pipeline is not offered either');
    assert.ok(!offered.includes('write_file'), 'analysis cannot write');
    assert.ok(offered.includes('findings_query') && offered.includes('session_read'), 'it can read prior work');

    const blocked = turn.events.find((e) => e.type === 'tool_result' && e.blocked);
    assert.ok(blocked, 'the invented call was refused');
    assert.strictEqual(blocked.tool, 'run_tool');
    assert.strictEqual(blocked.reason, 'preset');
    assert.strictEqual(blocked.ok, false);
    assert.match(blocked.output, /preset analysis/);
    assert.ok(!turn.events.some((e) => e.type === 'approval'), 'a refused tool never reaches the approval gate');
    assert.strictEqual(done.text, 'turn complete', 'the turn still ends with an answer');
  });

  await okAsync('analysis preset can read a prior report from the configured data root', async () => {
    const turn = await openTurn(port, cookie, {
      preset: 'analysis',
      messages: [{ role: 'user', content: 'READ_REPORT and summarise it' }],
    });
    const done = await turn.waitDone();
    await turn.pump;
    const result = turn.events.find((e) => e.type === 'tool_result');
    assert.ok(result, 'the read produced a result frame');
    assert.strictEqual(result.tool, 'read_file');
    assert.strictEqual(result.ok, true, result.output);
    assert.ok(result.output.includes(REPORT_MARKER), 'the report outside the checkout was readable');
    assert.strictEqual(done.text, 'turn complete');
  });

  await okAsync('an intrusive tool parks on the operator approval and a deny blocks it', async () => {
    const turn = await openTurn(port, cookie, {
      preset: 'pentest',
      messages: [{ role: 'user', content: 'EXECUTE the scan' }],
    });
    const approval = await turn.waitFor((e) => e.type === 'approval');
    assert.strictEqual(approval.tier, 'intrusive', 'sqlmap is intrusive in the tool registry');
    assert.match(approval.command, /tools\/run\.js sqlmap/);
    assert.ok(approval.id && approval.id.startsWith('ap_'));
    assert.ok(approval.expiresAt > Date.now());

    const denied = await call(port, 'POST', '/api/chat/approval', { cookie, body: { id: approval.id, decision: 'deny' } });
    assert.strictEqual(denied.status, 200, JSON.stringify(denied.json));
    assert.strictEqual(denied.json.decision, 'deny');

    const done = await turn.waitDone();
    await turn.pump;
    const answer = turn.events.find((e) => e.type === 'approval_result');
    assert.strictEqual(answer.decision, 'deny', 'the decision is echoed to the UI');
    const result = turn.events.find((e) => e.type === 'tool_result' && e.tool === 'run_tool');
    assert.ok(result, 'the call is closed with a result');
    assert.strictEqual(result.blocked, true);
    assert.strictEqual(result.reason, 'approval');
    assert.match(result.output, /non eseguito/, 'the model is told the action was cancelled');
    assert.strictEqual(done.text, 'turn complete');

    const stale = await call(port, 'POST', '/api/chat/approval', { cookie, body: { id: approval.id, decision: 'approve' } });
    assert.strictEqual(stale.status, 404, 'an answered approval cannot be replayed');
  });

  await okAsync('a stopped turn keeps the frames the operator already saw', async () => {
    const ctrl = new AbortController();
    const turn = await openTurn(port, cookie, {
      preset: 'pentest',
      messages: [{ role: 'user', content: 'ABORT_ME mid turn' }],
    }, { signal: ctrl.signal });
    await turn.waitFor((e) => e.type === 'tool_result');
    const meta = turn.events.find((e) => e.type === 'meta');
    assert.ok(meta && meta.session, 'the turn announced its session before the stop');
    assert.ok(turn.events.some((e) => e.type === 'tool_call' && e.tool === 'scope_check'), 'the card was painted before the stop');

    ctrl.abort();
    try { await turn.pump; } catch (e) { if (e.name !== 'AbortError') throw e; }
    // The server writes the snapshot when the socket closes; give that handler its turn.
    await new Promise((r) => setTimeout(r, 200));

    const stored = await call(port, 'GET', `/api/chat/sessions/${meta.session}`, { cookie });
    assert.strictEqual(stored.status, 200, JSON.stringify(stored.json));
    const t = stored.json.transcript || [];
    assert.ok(t.some((e) => e.type === 'user' && /ABORT_ME/.test(e.content)), 'the question survived the stop');
    assert.ok(t.some((e) => e.type === 'tool_call' && e.tool === 'scope_check'), 'the tool card the operator saw is in the store');
    assert.ok(t.some((e) => e.type === 'tool_result' && e.ok === true), 'so is its result');
    const stopAt = t.findIndex((e) => e.type === 'interrupted');
    assert.ok(stopAt >= 0, 'the turn is marked as stopped, not silently incomplete');
    assert.deepStrictEqual(t.slice(stopAt + 1), [], 'nothing the operator never saw is recorded after the stop');
    assert.ok(!t.some((e) => e.type === 'assistant' && e.content), 'no answer is invented for a turn that never produced one');

    const list = await call(port, 'GET', '/api/chat/sessions?limit=100', { cookie });
    const row = (list.json.sessions || []).find((s) => s.id === meta.session);
    assert.ok(row, 'the stopped conversation is in the rail');
    assert.ok(row.turns >= 1, 'and it knows it contains a question');
    assert.ok(!turn.events.some((e) => e.type === 'done'), 'the stopped stream never claimed to be done');
  });

  await okAsync('a model that only asks for tools is pushed to answer', async () => {
    const before = fake.seen.length;
    const turn = await openTurn(port, cookie, {
      preset: 'pentest',
      messages: [{ role: 'user', content: 'LOOP until the budget runs out' }],
    });
    const done = await turn.waitDone();
    await turn.pump;

    assert.strictEqual(done.text, 'budget answer', 'the turn ends with the model\'s answer, not a cap message');
    assert.strictEqual(done.error, undefined, 'and it is not reported as a failed turn');
    const executed = turn.events.filter((e) => e.type === 'tool_result');
    assert.ok(executed.length >= 1, 'the model really did use tools first');
    assert.ok(executed.length <= 3, 'the tool budget bounds how many run: ' + executed.length);

    const closing = fake.seen[fake.seen.length - 1];
    assert.ok(closing, 'the provider saw the closing request');
    assert.ok(!closing.tools || !closing.tools.length, 'the closing request offers no tool schema');
    assert.ok(closing.messages.some((m) => /TOOL BUDGET EXHAUSTED/.test(String(m.content || ''))),
      'the model is told why it has to answer now');

    const stored = await call(port, 'GET', `/api/chat/sessions/${done.session}`, { cookie });
    assert.strictEqual(stored.json.transcript.filter((e) => e.type === 'assistant').pop().content, 'budget answer',
      'the answer is what the redraw shows');
    assert.ok(!stored.json.messages.some((m) => /TOOL BUDGET EXHAUSTED/.test(String(m.content || ''))),
      'the directive is for the closing request only, never part of the saved conversation');
  });

  await okAsync('settings are server-owned: validated, persisted, and enforced on the next turn', async () => {
    const bad = await call(port, 'POST', '/api/chat/settings', { cookie, body: { max_tokens: 4 } });
    assert.strictEqual(bad.status, 400, 'a max_tokens below the floor is refused');
    assert.match(String(bad.json.error), /max_tokens/);

    const saved = await call(port, 'POST', '/api/chat/settings', {
      cookie, body: { temperature: 0.55, max_tokens: 512, approval_policy: 'deny', streaming: true },
    });
    assert.strictEqual(saved.status, 200, JSON.stringify(saved.json));
    assert.strictEqual(saved.json.settings.temperature, 0.55);

    const read = await call(port, 'GET', '/api/chat/settings', { cookie });
    assert.strictEqual(read.json.settings.max_tokens, 512, 'the file, not the tab, is the source of truth');
    assert.strictEqual(read.json.settings.approval_policy, 'deny');
    const onDisk = JSON.parse(fs.readFileSync(path.join(ROOT, 'app', 'chat', 'settings.json'), 'utf8'));
    assert.strictEqual(onDisk.temperature, 0.55, 'settings live under the data root');
    assert.ok(read.json.context && read.json.context.editable === false, 'the paths are reported read-only');

    // The policy is not a hint: intrusive tools are refused before the gate is offered.
    const turn = await openTurn(port, cookie, {
      preset: 'pentest',
      messages: [{ role: 'user', content: 'EXECUTE the scan' }],
    });
    const done = await turn.waitDone();
    await turn.pump;
    const meta = turn.events.find((e) => e.type === 'meta');
    assert.strictEqual(meta.approvalPolicy, 'deny', 'the turn reports the policy it is running under');
    assert.ok(!turn.events.some((e) => e.type === 'approval'), 'deny never shows an approval dialog');
    const blocked = turn.events.find((e) => e.type === 'tool_result' && e.blocked);
    assert.ok(blocked, 'the call still closes with a result');
    assert.strictEqual(blocked.reason, 'policy');
    assert.match(blocked.output, /approval_policy=deny/);
    assert.strictEqual(done.text, 'turn complete');

    const restored = await call(port, 'POST', '/api/chat/settings', { cookie, body: { approval_policy: 'ask' } });
    assert.strictEqual(restored.json.settings.approval_policy, 'ask');
  });

  await okAsync('the brand art is served by a narrow image route, not by widening the allowlist', async () => {
    const img = await call(port, 'GET', '/img/ouroboros.webp', {});
    assert.strictEqual(img.status, 200, 'the chat mark is reachable');
    assert.strictEqual(img.contentType, 'image/webp');
    // Percent-encoded on purpose: fetch would normalise a literal `..` away client-side,
    // so this is the shape that actually reaches the server.
    const traversal = await call(port, 'GET', '/img/%2e%2e%2fapp.js', {});
    assert.strictEqual(traversal.status, 404, 'the image route cannot escape tools/gui/img');
    const script = await call(port, 'GET', '/img/app.js', {});
    assert.strictEqual(script.status, 404, 'a .js under /img/ is not an image');
  });

  await okAsync('the role gate is unchanged: a viewer cannot start a turn', async () => {
    const seeded = identity.createIdentity({ usersFile: USERS, serviceToken: null, auditSink: () => ({ ok: true }) });
    assert.strictEqual(seeded.addUser({ username: 'view', role: 'viewer', password: PW }, { actor: 'test' }).ok, true);
    const viewCookie = await login(port, 'view', PW);
    assert.strictEqual((await call(port, 'GET', '/api/chat/models', { cookie: viewCookie })).status, 200, 'viewer may read discovery');
    const refused = await call(port, 'POST', '/api/chat', { cookie: viewCookie, body: { messages: [{ role: 'user', content: 'hi' }] } });
    assert.strictEqual(refused.status, 403, 'viewer cannot run tools through chat');
    assert.strictEqual(refused.json.need, 'operator');
  });

  // The transcript renderer runs in the browser, so it is exercised headless: load the
  // file in a VM with the two globals it expects (esc, from app.js) and read the HTML it
  // produces. These are the shapes a model answer actually takes — pentest output is
  // list- and table-shaped — plus the two ways a model could try to become markup.
  await okAsync('the transcript renders lists, headings and tables — and never model markup', async () => {
    const box = { window: {}, console };
    box.esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    box.el = () => ({});
    vm.createContext(box);
    vm.runInContext(fs.readFileSync(path.join(WS, 'tools', 'gui', 'chat-render.js'), 'utf8'), box);
    const md = box.window.ChatRender.markdown;

    const list = md('Hosts reached:\n- 10.0.0.5\n- 10.0.0.6\n  - nested\n1. first\n2. second');
    assert.match(list, /<ul><li>10\.0\.0\.5<\/li><li>10\.0\.0\.6<ul><li>nested<\/li><\/ul><\/li><\/ul>/, 'bullets nest');
    assert.match(list, /<ol><li>first<\/li><li>second<\/li><\/ol>/, 'an ordered list after a bulleted one is its own list');

    assert.match(md('## Findings'), /^<h2>Findings<\/h2>$/, 'headings are headings, not literal hashes');
    assert.match(md('a\n\n---\n\nb'), /<hr>/, 'a rule is a rule');
    assert.match(md('> note'), /<blockquote>note<\/blockquote>/);

    const table = md('| Host | Port |\n|---|---:|\n| 10.0.0.5 | 22 |');
    assert.match(table, /<table><thead><tr><th>Host<\/th>/, 'a pipe table becomes a table');
    assert.match(table, /<td>10\.0\.0\.5<\/td>/, 'cells keep their text');
    assert.match(table, /style="text-align:right"/, 'the separator row sets alignment');
    assert.ok(!md('one | two').includes('<table>'), 'pipes without a separator stay text');

    const hostile = md('<img src=x onerror=alert(1)> **bold** [x](javascript:alert(1)) `<b>`');
    assert.ok(!/<img/i.test(hostile), 'model-written HTML is escaped');
    assert.match(hostile, /&lt;img/, 'and shown as text');
    assert.ok(!/<a /.test(hostile), 'only http(s) links become anchors');
    assert.match(md('```\n<b>\n```'), /<pre class="chat-code">&lt;b&gt;<\/pre>/, 'fenced code is escaped verbatim');
    assert.match(md('run `rm -rf *` now'), /<code>rm -rf \*<\/code>/, 'inline code survives escaping');
  });

  cleanup();
  summary('test-console-chat');
})().catch((e) => {
  console.error('FAIL ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
