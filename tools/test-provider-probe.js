#!/usr/bin/env node
// tools/test-provider-probe.js — the harness's measurement logic, proven against fake
// endpoints through the SAME live client a real run uses (no network, no key, no cloud).
//
// What these tests are for: a probe that reports a number must have gotten it from a
// response. So each case asserts the VALUE and the EVIDENCE, and the request count is
// cross-checked against what the fake endpoint actually received — a probe that claims
// 14 requests while the server saw 6 is measuring its own imagination.
//
// The variants that matter are the ones a real endpoint picks from: lenient vs strict,
// tool_choice accepted vs refused, grammar accepted vs refused, reasoning echo not
// required vs required, streamed usage present vs absent. The unmeasured paths (no
// endpoint, a 500, a cap) assert the ABSENCE of numbers, which is the property that keeps
// a default from being presented as a measurement.
//
// test-tags: loopback
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { ok, okAsync, summary, fixture, runCliAsync } = require('./testkit');
const probe = require('./provider-probe');
const live = require('../runtime/live');
const adapters = require('../local/adapters');
const { estimateTokens } = require('../local/context');

const WS = path.join(__dirname, '..');
const CLI = path.join(__dirname, 'provider-probe.js');

// Async checks run after the file loads (the sync ones print immediately); the queue keeps
// the exit code honest, because `summary` must see every result.
const queue = [];
const queueOk = (name, fn) => { queue.push([name, fn]); };

// What an OpenAI-compatible endpoint documents. `grammar` is deliberately absent: it is
// llama.cpp's extension, which is exactly why a probe has to ask instead of assume.
const KNOWN = new Set([
  'model', 'messages', 'stream', 'temperature', 'top_p', 'max_tokens',
  'tools', 'tool_choice', 'stream_options', 'timings_per_token',
  'top_k', 'presence_penalty', 'frequency_penalty', 'repeat_penalty', 'thinking',
]);

function promptTokens(body) {
  return (body.messages || []).reduce((n, m) => n + estimateTokens(m.content || ''), 0);
}

// A fake provider whose behaviour is a set of switches. It is a real HTTP server on
// loopback, so the probe goes through fetch, JSON encoding, SSE parsing and the client's
// own error mapping — everything except the network being remote.
function fake(opts = {}) {
  const o = {
    strict: false,
    toolChoice: true,
    grammar: false,
    reasoningField: 'reasoning_content',
    echo: 'avoid',          // 'avoid' | 'required'
    streamUsage: true,
    window: 4096,
    failAll: null,
    seen: [],
  };
  Object.assign(o, opts);

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch { /* recorded as {} */ }
      o.seen.push(body);
      const send = (status, obj) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (o.failAll) return send(o.failAll, { error: { message: 'upstream exploded' } });
      if (promptTokens(body) > o.window) {
        return send(400, { error: { message: 'maximum context length is exceeded' } });
      }
      if (o.strict) {
        const bad = Object.keys(body).find((k) => !KNOWN.has(k));
        if (bad) return send(400, { error: { message: `unknown field "${bad}"` } });
      }
      if (!o.toolChoice && body.tool_choice != null) {
        return send(400, { error: { message: 'tool_choice is not supported' } });
      }
      if (!o.grammar && body.grammar != null) {
        return send(400, { error: { message: 'unknown field "grammar"' } });
      }
      // The echo rule, as the vendor documents it: with a tool exchange present, the prior
      // reasoning must come back or the request is refused.
      const toolIdx = (body.messages || []).findIndex((m) => m.role === 'tool');
      if (toolIdx > 0 && o.echo === 'required') {
        const prev = body.messages[toolIdx - 1];
        if (!prev[o.reasoningField]) {
          return send(400, { error: { message: 'reasoning from the previous turn must be echoed back when tools are present' } });
        }
      }
      const last = (body.messages || [])[body.messages.length - 1] || {};
      const wantsTool = Array.isArray(body.tools) && body.tools.length > 0
        && /probe_ping/.test(String(last.content || ''));
      const message = { role: 'assistant', content: wantsTool ? '' : 'OK' };
      if (o.reasoningField) message[o.reasoningField] = 'probe thinking';
      if (wantsTool) {
        message.tool_calls = [{
          id: 'call_probe_1', type: 'function',
          function: { name: 'probe_ping', arguments: '{}' },
        }];
      }
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'OK' } }] })}\n\n`);
        const chunk = { choices: [{ delta: {}, finish_reason: 'stop' }] };
        if (o.streamUsage) chunk.usage = { prompt_tokens: 20, completion_tokens: 1 };
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        res.write('data: [DONE]\n\n');
        return res.end();
      }
      return send(200, {
        choices: [{ message, finish_reason: wantsTool ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 20, completion_tokens: 1 },
      });
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        o,
        port: server.address().port,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

function clientFor(port, extra = {}) {
  const p = {
    base_url: `http://127.0.0.1:${port}`,
    model: 'probe-model',
    retries: 0,                 // one measurement = one request
    request_timeout_ms: 3000,
    ...extra,
  };
  return { p, client: live.buildClient(p, 'sk-test', null) };
}

// Sync spawn is only for runs that never reach the fake server in this process (the event
// loop is blocked while it waits, so a same-process server could not answer). Those runs
// assert refusals and plans: they must send nothing, and nothing is exactly what they get.
function runCli(args, env = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: WS, encoding: 'utf8', timeout: 60000,
    env: { ...process.env, ...env },
  });
}
function runCliWait(args, env = {}) {
  return runCliAsync([CLI, ...args], { cwd: WS, env: { ...process.env, ...env } });
}

function configFor(dir, profiles, extra = {}) {
  const file = path.join(dir, 'providers.json');
  const doc = {
    version: 1,
    default_profile: Object.keys(profiles)[0],
    allow_cloud: false,
    ...extra,
    profiles,
  };
  fs.writeFileSync(file, JSON.stringify(doc, null, 2));
  return file;
}

function measurementFileIn(dir) {
  return path.join(dir, 'provider-measurements.json');
}

// ── lenient local endpoint: grammar accepted, no echo requirement ───────────
queueOk('lenient + grammar endpoint: every fact is measured with its evidence', async () => {
  const f = await fake({ grammar: true, echo: 'avoid', window: 3000 });
  try {
    const { client, p } = clientFor(f.port);
    const r = await probe.runProbe({
      client, caps: adapters.resolveCapabilities(p), model: p.model,
      ceiling: 8192, maxRequests: 20,
    });
    const v = (id) => r.results[id];
    if (r.status !== 'measured') throw new Error(`status ${r.status}: ${r.reason}`);
    if (v('strict_unknown_fields').value !== 'lenient') throw new Error('strict: ' + JSON.stringify(v('strict_unknown_fields')));
    if (v('tool_choice').value !== true) throw new Error('tool_choice not measured true');
    if (v('grammar').value !== true) throw new Error('grammar not measured true');
    if (v('reasoning_field').value !== 'reasoning_content') throw new Error('reasoning_field ' + v('reasoning_field').value);
    if (v('reasoning_echo_with_tools').value !== false) throw new Error('echo should be measured false');
    if (v('stream_options').value !== true) throw new Error('stream usage not observed');
    // Window 3000, ladder 2048/8192: the bisection lands on 2816 accepted / 3584 refused.
    if (v('context_window_tokens').value !== 2816) throw new Error('window ' + JSON.stringify(v('context_window_tokens')));
    if (r.usable_window_tokens !== 2816) throw new Error('usable_window_tokens not set');
    // The counted requests are the requests the server received.
    if (r.requests_made !== f.o.seen.length) throw new Error(`counted ${r.requests_made}, server saw ${f.o.seen.length}`);
    // The window probes ask for one token, not a completion: cheap by construction.
    const windowProbes = f.o.seen.filter((b) => b.max_tokens === 1);
    if (windowProbes.length < 2) throw new Error('no window probes recorded');
    // Evidence for the window is the ladder it walked, not a claim.
    const steps = v('context_window_tokens').evidence.steps;
    if (!steps.some((s) => s.ok) || !steps.some((s) => s.ok === false)) throw new Error('no accept/reject bracket');
  } finally { await f.close(); }
});

// ── strict cloud endpoint: refuses unknown fields, requires the echo ─────────
queueOk('strict + echo-required endpoint: refusals become measured facts', async () => {
  const f = await fake({ strict: true, toolChoice: false, grammar: false, echo: 'required', streamUsage: false, window: 1000000 });
  try {
    const { client, p } = clientFor(f.port);
    const r = await probe.runProbe({
      client, caps: adapters.resolveCapabilities({ ...p, type: 'deepseek' }), model: p.model,
      ceiling: 2048, maxRequests: 20,
    });
    const v = (id) => r.results[id];
    if (v('strict_unknown_fields').value !== 'strict') throw new Error('strict not measured: ' + JSON.stringify(v('strict_unknown_fields')));
    if (v('tool_choice').value !== false) throw new Error('tool_choice should be measured false');
    if (v('grammar').value !== false) throw new Error('grammar should be measured false');
    if (v('reasoning_echo_with_tools').value !== true) throw new Error('echo requirement not proven: ' + JSON.stringify(v('reasoning_echo_with_tools')));
    if (!/rejected without, accepted with/.test(v('reasoning_echo_with_tools').evidence.result)) throw new Error('echo evidence missing');
    if (v('stream_options').value !== false) throw new Error('stream usage should be measured absent');
    if (v('context_window_tokens').value !== 2048) throw new Error('window ' + v('context_window_tokens').value);
    if (v('context_window_tokens').evidence.lower_bound !== true) throw new Error('should be reported as a lower bound');
    if (r.requests_made !== f.o.seen.length) throw new Error(`counted ${r.requests_made}, server saw ${f.o.seen.length}`);
  } finally { await f.close(); }
});

// ── no reasoning observed: unknown, not "no reasoning field" ─────────────────
queueOk('no reasoning in the response: reported unknown, never invented', async () => {
  const f = await fake({ reasoningField: null, grammar: false, window: 4096 });
  try {
    const { client, p } = clientFor(f.port);
    const r = await probe.runProbe({
      client, caps: adapters.resolveCapabilities(p), model: p.model,
      ceiling: 2048, maxRequests: 20,
    });
    if (r.results.reasoning_field.status !== 'unknown') throw new Error('reasoning_field should be unknown');
    if (r.results.reasoning_field.value !== null) throw new Error('unknown must carry no value');
    if (r.results.reasoning_echo_with_tools.status !== 'unknown') throw new Error('echo should be unknown without an observation');
    if (!/cannot be exercised/.test(r.results.reasoning_echo_with_tools.evidence.reason)) throw new Error('reason not stated');
    if (r.results.tool_choice.status !== 'measured') throw new Error('the other facts should still be measured');
  } finally { await f.close(); }
});

// ── unreachable endpoint: unmeasured, zero numbers ──────────────────────────
queueOk('unreachable endpoint: status unmeasured and no number anywhere', async () => {
  const f = await fake();
  const port = f.port;
  await f.close();   // nothing is listening on that port now
  const { client, p } = clientFor(port);
  const r = await probe.runProbe({
    client, caps: adapters.resolveCapabilities(p), model: p.model,
    ceiling: 2048, maxRequests: 20,
  });
  if (r.status !== 'unmeasured') throw new Error('status should be unmeasured, got ' + r.status);
  if (r.usable_window_tokens !== null) throw new Error('usable_window_tokens must be null, got ' + r.usable_window_tokens);
  for (const [id, res] of Object.entries(r.results)) {
    if (res.status !== 'unknown') throw new Error(`${id} should be unknown, got ${res.status}`);
    if (res.value !== null) throw new Error(`${id} carries a value without a measurement`);
  }
});

// ── a 500 is not a measurement either ───────────────────────────────────────
queueOk('500 from the endpoint: unknown, with the failure as the reason', async () => {
  const f = await fake({ failAll: 500 });
  try {
    const { client, p } = clientFor(f.port);
    const r = await probe.runProbe({
      client, caps: adapters.resolveCapabilities(p), model: p.model,
      ceiling: 2048, maxRequests: 20,
    });
    if (r.status !== 'unmeasured') throw new Error('status ' + r.status);
    if (!/HTTP 500/.test(r.results.strict_unknown_fields.evidence.reason)) throw new Error('reason should name the failure');
  } finally { await f.close(); }
});

// ── the cap is the request that does not happen ─────────────────────────────
queueOk('request cap stops the probe and says so', async () => {
  const f = await fake({ grammar: true });
  try {
    const { client, p } = clientFor(f.port);
    const r = await probe.runProbe({
      client, caps: adapters.resolveCapabilities(p), model: p.model,
      ceiling: 8192, maxRequests: 3,
    });
    if (r.status !== 'unmeasured') throw new Error('status ' + r.status);
    if (!/cap 3 reached/.test(r.reason)) throw new Error('reason ' + r.reason);
    if (r.requests_made !== 3) throw new Error('made ' + r.requests_made);
    if (f.o.seen.length !== 3) throw new Error(`server saw ${f.o.seen.length} requests, cap was 3`);
  } finally { await f.close(); }
});

// ── plan and gates ──────────────────────────────────────────────────────────
ok('plan: request count, ladder and cost stated before anything runs', () => {
  const caps = adapters.resolveCapabilities({
    type: 'deepseek',
    capabilities: { pricing: { input_per_1m: 0.28, output_per_1m: 0.42 } },
  });
  const plan = probe.planFor({ caps, ceiling: 4096, maxRequests: 20 });
  if (plan.requests !== 6 + 2 + (2 + 3)) throw new Error('requests ' + plan.requests);
  if (JSON.stringify(plan.ladder) !== JSON.stringify([2048, 4096])) throw new Error('ladder ' + plan.ladder);
  if (!(plan.cost > 0)) throw new Error('cost ' + plan.cost);
  if (!plan.withinCap) throw new Error('should fit the cap');
  const line = probe.formatPlan(plan, { profile: 'p', baseUrl: 'http://x' });
  if (!/ZERO richieste inviate/.test(line)) throw new Error('plan must say it sends nothing');
  if (!/fino a 13/.test(line)) throw new Error('plan must state the count: ' + line);
  // No pricing declared -> no cost invented.
  const unpriced = probe.planFor({ caps: adapters.resolveCapabilities({}), ceiling: 2048 });
  if (unpriced.cost !== null) throw new Error('cost should be unknown without pricing');
  if (!/sconosciuto/.test(probe.formatPlan(unpriced, { profile: 'p', baseUrl: 'http://x' }))) throw new Error('cost must read as unknown');
});

ok('run gates: consent, an explicit cap, and a cap that fits the plan', () => {
  const plan = probe.planFor({ caps: adapters.resolveCapabilities({}), ceiling: 4096, maxRequests: 20 });
  const code = (opts) => {
    try { probe.validateRunGate(opts, plan); return 'ok'; } catch (e) { return e.code; }
  };
  if (code({}) !== 'consent_required') throw new Error('consent gate missing');
  if (code({ yes: true }) !== 'cap_required') throw new Error('cap gate missing');
  if (code({ yes: true, maxRequests: 0 }) !== 'cap_required') throw new Error('zero cap must be refused');
  if (code({ yes: true, maxRequests: probe.HARD_MAX_REQUESTS + 1 }) !== 'cap_too_high') throw new Error('hard ceiling missing');
  if (code({ yes: true, maxRequests: 2 }) !== 'cap_too_low') throw new Error('cap below the plan must be refused');
  if (code({ yes: true, maxRequests: plan.requests }) !== 'ok') throw new Error('a sufficient cap must pass');
});

// ── CLI: plan sends nothing, run refuses without consent ────────────────────
queueOk('CLI plan: zero requests reach the endpoint', async () => {
  const f = await fake({ grammar: true });
  const dir = fixture('probe-plan');
  try {
    const config = configFor(dir, {
      local: { base_url: `http://127.0.0.1:${f.port}`, model: 'probe-model', type: 'llama-cpp' },
    });
    const r = runCli(['plan', '--config', config, '--ceiling', '4096']);
    if (r.status !== 0) throw new Error(`exit ${r.status}: ${r.stderr}`);
    if (!/ZERO richieste inviate/.test(r.stdout)) throw new Error('stdout: ' + r.stdout);
    if (f.o.seen.length !== 0) throw new Error(`plan sent ${f.o.seen.length} requests`);
  } finally { await f.close(); }
});

queueOk('CLI run without --yes, and run with a cap below the plan, both send nothing', async () => {
  const f = await fake({ grammar: true });
  const dir = fixture('probe-gate');
  try {
    const config = configFor(dir, {
      local: { base_url: `http://127.0.0.1:${f.port}`, model: 'probe-model', type: 'llama-cpp' },
    });
    const unsaid = runCli(['run', '--config', config, '--max-requests', '20']);
    if (unsaid.status !== 1) throw new Error(`no --yes exit ${unsaid.status}`);
    if (!/consent_required|--yes/.test(unsaid.stderr)) throw new Error('stderr: ' + unsaid.stderr);
    if (f.o.seen.length !== 0) throw new Error('refused run still sent requests');

    const low = runCli(['run', '--config', config, '--max-requests', '2', '--yes']);
    if (low.status !== 1) throw new Error(`low cap exit ${low.status}`);
    if (!/cap_too_low|alza il cap/.test(low.stderr)) throw new Error('stderr: ' + low.stderr);
    if (f.o.seen.length !== 0) throw new Error('cap-refused run still sent requests');
  } finally { await f.close(); }
});

// ── CLI: a real run records a fact the adapter consumes ─────────────────────
queueOk('CLI run records measured facts, and the adapter consumes them', async () => {
  const f = await fake({ grammar: true, window: 2048 });
  const dir = fixture('probe-run');
  const file = measurementFileIn(dir);
  const prev = process.env.CYBOROS_PROVIDER_MEASUREMENTS;
  process.env.CYBOROS_PROVIDER_MEASUREMENTS = file;
  try {
    const profile = {
      base_url: `http://127.0.0.1:${f.port}`, model: 'probe-model', type: 'llama-cpp',
      capabilities: { context_window_tokens: 8192 },
    };
    const config = configFor(dir, { local: { ...profile, request_timeout_ms: 5000 } });
    const r = await runCliWait(['run', '--config', config, '--max-requests', '16', '--yes'],
      { CYBOROS_PROVIDER_MEASUREMENTS: file });
    if (r.status !== 0) throw new Error(`exit ${r.status}\n${r.stdout}\n${r.stderr}`);

    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    const entry = doc.profiles.local;
    if (!entry) throw new Error('no record written');
    if (entry.status !== 'measured') throw new Error('status ' + entry.status);
    if (entry.endpoint_hash !== live.endpointHash(profile)) throw new Error('endpoint hash mismatch');
    if (entry.usable_window_tokens !== 2048) throw new Error('window ' + entry.usable_window_tokens);
    if (entry.requests_made !== f.o.seen.length) throw new Error('counted a different number than the server saw');

    // The record is consumed where it applies...
    if (!live.measurementsFor('local', profile)) throw new Error('measurement not found for this endpoint');
    const caps = adapters.resolveAdapter({ ...profile, measured: live.measurementsFor('local', profile) }).caps;
    if (caps.context_window_tokens !== 2048) throw new Error('measured window not applied: ' + caps.context_window_tokens);
    if (caps.grammar !== true) throw new Error('measured grammar acceptance lost');
    // ...and ignored where it does not: a different endpoint is a different provider.
    const other = { ...profile, base_url: 'http://127.0.0.1:1' };
    if (live.measurementsFor('local', other) !== null) throw new Error('a foreign-endpoint measurement was applied');
    const otherCaps = adapters.resolveAdapter({ ...other, measured: null }).caps;
    if (otherCaps.context_window_tokens !== 8192) throw new Error('declared window should stand without a measurement');
  } finally {
    if (prev === undefined) delete process.env.CYBOROS_PROVIDER_MEASUREMENTS;
    else process.env.CYBOROS_PROVIDER_MEASUREMENTS = prev;
    await f.close();
  }
});

// ── CLI: unmeasured record carries no numbers and is not applied ────────────
queueOk('CLI run against nothing: unmeasured record, no fabricated numbers, not applied', async () => {
  const f = await fake();
  const port = f.port;
  await f.close();
  const dir = fixture('probe-unmeasured');
  const file = measurementFileIn(dir);
  const profile = { base_url: `http://127.0.0.1:${port}`, model: 'probe-model', type: 'openai-compatible' };
  const config = configFor(dir, { local: { ...profile, request_timeout_ms: 5000, retries: 0 } });
  const r = await runCliWait(['run', '--config', config, '--max-requests', '16', '--yes'],
    { CYBOROS_PROVIDER_MEASUREMENTS: file });
  if (r.status !== 1) throw new Error(`exit ${r.status} (expected 1 for unmeasured)\n${r.stdout}${r.stderr}`);
  if (!/UNMEASURED|nessuna capacit/.test(r.stdout + r.stderr)) throw new Error('no unmeasured notice: ' + r.stdout + r.stderr);

  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  const entry = doc.profiles.local;
  if (entry.status !== 'unmeasured') throw new Error('status ' + entry.status);
  if (entry.usable_window_tokens !== null) throw new Error('window invented: ' + entry.usable_window_tokens);
  for (const [id, res] of Object.entries(entry.results || {})) {
    if (res.status === 'measured') throw new Error(`${id} claims a measurement against a dead endpoint`);
    if (res.value !== null) throw new Error(`${id} carries a value`);
  }
  // An unmeasured record must not change what the adapter believes.
  const prev = process.env.CYBOROS_PROVIDER_MEASUREMENTS;
  process.env.CYBOROS_PROVIDER_MEASUREMENTS = file;
  try {
    if (live.measurementsFor('local', profile) !== null) throw new Error('unmeasured record was consumed');
  } finally {
    if (prev === undefined) delete process.env.CYBOROS_PROVIDER_MEASUREMENTS;
    else process.env.CYBOROS_PROVIDER_MEASUREMENTS = prev;
  }
});

// ── CLI: no credential / no config is stated, not papered over ──────────────
ok('CLI without a usable credential or config: UNMEASURED, exit 1, no request', () => {
  const dir = fixture('probe-nokey');
  const cloud = configFor(dir, {
    cloud: {
      base_url: 'https://api.example.invalid', model: 'probe-model',
      type: 'openai-compatible', egress: 'cloud', api_key_env: 'PROBE_TEST_KEY_THAT_DOES_NOT_EXIST',
    },
  }, { allow_cloud: true });
  const noKey = runCli(['run', '--config', cloud, '--max-requests', '16', '--yes', '--allow-cloud'],
    { PROBE_TEST_KEY_THAT_DOES_NOT_EXIST: '' });
  if (noKey.status !== 1) throw new Error(`exit ${noKey.status}: ${noKey.stderr}`);
  if (!/UNMEASURED/.test(noKey.stderr)) throw new Error('stderr: ' + noKey.stderr);
  if (!/provider_key_missing|key missing|provider key/.test(noKey.stderr)) throw new Error('reason not stated: ' + noKey.stderr);

  // Cloud egress without the consent flag: `run` is refused by the live gate, while `plan`
  // still prints the arithmetic and says why run would fail — a dry run costs nothing and
  // is what the operator needs in order to decide.
  const runGate = runCli(['run', '--config', cloud, '--max-requests', '16', '--yes'], { PROBE_TEST_KEY_THAT_DOES_NOT_EXIST: 'x' });
  if (runGate.status !== 1) throw new Error(`run without --allow-cloud exit ${runGate.status}`);
  if (!/cloud_requires_flag|allow-cloud/.test(runGate.stderr)) throw new Error('stderr: ' + runGate.stderr);
  const planGate = runCli(['plan', '--config', cloud], { PROBE_TEST_KEY_THAT_DOES_NOT_EXIST: 'x' });
  if (planGate.status !== 0) throw new Error(`plan should still work, exit ${planGate.status}: ${planGate.stderr}`);
  if (!/ZERO richieste inviate/.test(planGate.stdout)) throw new Error('stdout: ' + planGate.stdout);
  if (!/nota: `run` ora fallirebbe/.test(planGate.stdout)) throw new Error('plan must say run is blocked: ' + planGate.stdout);

  const missing = runCli(['plan', '--config', path.join(dir, 'nope.json')]);
  if (missing.status !== 1) throw new Error('missing config should exit 1');
  if (!/UNMEASURED/.test(missing.stderr)) throw new Error('stderr: ' + missing.stderr);
});

(async () => {
  for (const [name, fn] of queue) await okAsync(name, fn);
  summary('test-provider-probe');
})();
