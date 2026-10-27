#!/usr/bin/env node
// tools/provider-probe.js — what this endpoint ACTUALLY does, measured.
//
// Why it exists
// -------------
// A profile in `runtime/providers.json` declares what its endpoint accepts. Until something
// asks the endpoint, every one of those declarations is a default: the DeepSeek profile's
// window, its `reasoning_content` echo rule, the llama.cpp profile's grammar acceptance are
// all "documented, not verified". The audit's finding was that a declared limit that nobody
// measured is indistinguishable from a guess — and a wrong guess fails as a 400 mid-run or,
// worse, as a context budget that silently wastes 98% of the model's window.
//
// This tool sends a small, bounded, explicit set of requests and records what came back:
//
//   strict_unknown_fields        does it reject a field it does not know
//   tool_choice                  does it accept `tool_choice: "auto"`
//   grammar                      does it accept a llama.cpp GBNF `grammar`
//   reasoning_field              which field carried the reasoning (`reasoning_content` /
//                                `reasoning`), or none in this response
//   reasoning_echo_with_tools    with a tool exchange present, is the prior reasoning
//                                required to be echoed back
//   stream_options               does a streamed request report `usage`
//   context_window_tokens        the largest prompt it accepts, found by probing
//
// Three rules, in the order they matter:
//
//   1. NO FABRICATION. Every result is `measured` with the evidence that produced it, or
//      `unknown` with the reason (no key, unreachable, cap reached, ambiguous rejection).
//      A profile that cannot be reached produces an `unmeasured` record and NO numbers.
//   2. NO UNBOUNDED SPEND. `plan` prints the exact request count, the token volume and the
//      cost computed from the profile's own price table - before anything is sent. `run`
//      refuses without `--yes`, refuses a cap that is missing, zero or above the hard
//      ceiling, and refuses when the plan needs more requests than the cap allows.
//   3. SAME PATH AS A REAL RUN. The client is built by `runtime/live.js#buildClient`, which
//      is the exact construction `createLive()` uses (endpoint, key resolution, cloud
//      consent, sampling, timeouts). What is measured here is what a turn will send. The
//      probe writes raw bodies only to vary the ONE field under test; the transport is the
//      loop's own.
//
// The record is written to `reports/provider-measurements.json`, keyed by profile AND by a
// hash of `base_url|model`; `runtime/live.js` consumes it so the adapter applies measured
// facts where they exist, and ignores a measurement taken against a different endpoint.
//
// Usage:
//   node tools/provider-probe.js plan [--profile X] [--config F] [--ceiling N]
//   node tools/provider-probe.js run  [--profile X] [--config F] [--ceiling N]
//                                    [--max-requests N] --yes [--allow-cloud]
// exit: 0 ok | 1 refusal or nothing measurable | 2 usage

'use strict';
const fs = require('node:fs');
const path = require('node:path');
const live = require('../runtime/live');
const adapters = require('../local/adapters');
const { estimateTokens } = require('../local/context');

const FLOOR_TOKENS = 2048;      // first window probe: a request this small is never the problem
const LADDER_FACTOR = 4;        // geometric search, so a 1M window costs ~5 requests, not 20
const BISECT_STEPS = 3;         // refinement inside the last bracket
const DEFAULT_CEILING = 131072;
const DEFAULT_MAX_REQUESTS = 24;
const HARD_MAX_REQUESTS = 40;

const PROMPT = 'Reply with the single word OK.';
const TOOL_PROMPT = 'Call the probe_ping tool now.';
const TOOL = [{
  type: 'function',
  function: {
    name: 'probe_ping',
    description: 'Probe tool, does nothing.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
}];

class ProbeError extends Error {
  constructor(code, message) { super(message); this.name = 'ProbeError'; this.code = code; }
}

const clip = (s, n = 200) => {
  const t = String(s == null ? '' : s);
  return t.length > n ? t.slice(0, n) + '…' : t;
};

// ── plan ───────────────────────────────────────────────────────────────────
// The ladder is generated here and reused by the run, so the number the operator is shown
// before consenting is the number of requests the run can actually make.
function windowLadder(ceiling) {
  const out = [];
  for (let n = FLOOR_TOKENS; n <= ceiling; n *= LADDER_FACTOR) out.push(n);
  if (!out.length || out[out.length - 1] < ceiling) out.push(ceiling);
  return out;
}

function planFor({ caps, ceiling = DEFAULT_CEILING, maxRequests = DEFAULT_MAX_REQUESTS }) {
  const ladder = windowLadder(ceiling);
  const windowRequests = ladder.length + BISECT_STEPS;
  // 6 fixed probes + at most 2 more (echo test, and its confirmation when it says "required").
  const requests = 6 + 2 + windowRequests;
  const windowTokens = ladder.reduce((a, b) => a + b, 0)
    + ladder[ladder.length - 1] * 0.5 * BISECT_STEPS;
  const tokensIn = 900 + Math.round(windowTokens * 1.1);
  const tokensOut = 8 * 8 + windowRequests;
  return {
    ceiling,
    ladder,
    requests,
    windowRequests,
    maxRequests,
    withinCap: requests <= maxRequests,
    tokensIn,
    tokensOut,
    cost: adapters.costOf(caps, { prompt_tokens: tokensIn, completion_tokens: tokensOut }),
    priced: Boolean(caps && caps.pricing),
  };
}

function formatPlan(plan, { profile, baseUrl }) {
  const lines = [
    `provider-probe: plan — ZERO richieste inviate`,
    `profilo      : ${profile}`,
    `endpoint     : ${baseUrl}`,
    `finestra max : ${plan.ceiling} token di prompt (--ceiling per abbassarla)`,
    '',
    'prove fisse  : 6 (+2 se il reasoning è osservabile: echo e conferma)',
    `finestra     : ${plan.windowRequests} richieste (ladder ${plan.ladder.join('/')} + ${BISECT_STEPS} bisezioni)`,
    `richieste    : fino a ${plan.requests} · cap ${plan.maxRequests}${plan.withinCap ? '' : '  ✖ il piano supera il cap'}`,
    `token stimati: ~${plan.tokensIn} in · ~${plan.tokensOut} out`,
    `costo stimato: ${plan.cost == null ? 'sconosciuto (nessun pricing dichiarato)' : '$' + plan.cost.toFixed(4)}`,
    '',
  ];
  return lines.join('\n');
}

// ── measurement ────────────────────────────────────────────────────────────
const CONTEXT_REJECT = new Set([400, 413, 422]);

function paddingFor(tokens) {
  const unit = 'context probe padding line for the window measurement. ';
  const perUnit = Math.max(1, estimateTokens(unit));
  const repeats = Math.max(1, Math.round((tokens - 8) / perUnit));
  return unit.repeat(repeats);
}

async function runProbe(opts) {
  const { client, caps, model } = opts;
  const ceiling = opts.ceiling || DEFAULT_CEILING;
  const maxRequests = opts.maxRequests || DEFAULT_MAX_REQUESTS;
  const onStep = opts.onStep || (() => {});
  const ladder = windowLadder(ceiling);

  let requests = 0;
  const results = {};

  const record = (id, status, value, evidence) => {
    results[id] = { status, value: value === undefined ? null : value, evidence: evidence || null };
    onStep(id, results[id]);
    return results[id];
  };
  const attempt = async (fn) => {
    try { return { ok: true, data: await fn() }; } catch (e) {
      const msg = String(e && e.message ? e.message : e);
      const m = msg.match(/HTTP (\d{3})/);
      return { ok: false, status: m ? Number(m[1]) : null, message: msg };
    }
  };
  // One call = one request. The cap is checked BEFORE the request, never after: the point of
  // a cap is the request that does not happen.
  const call = (body) => {
    if (requests >= maxRequests) {
      throw new ProbeError('cap_reached', `request cap ${maxRequests} reached`);
    }
    requests += 1;
    return attempt(() => client._post(body));
  };
  const body = ({ messages, tools, extra, maxTokens = 8, stream = false }) => ({
    model,
    messages,
    max_tokens: maxTokens,
    temperature: 0,
    stream,
    ...(tools ? { tools } : {}),
    ...(extra || {}),
  });

  try {
    // 1) Does it reject a field it does not know? The one measurement that explains every
    //    later 400: a lenient endpoint ignores what it does not understand, a strict one
    //    names it.
    {
      const r = await call(body({ messages: [{ role: 'user', content: PROMPT }], extra: { x_cyboros_unknown_field: 'probe' } }));
      if (r.ok) {
        record('strict_unknown_fields', 'measured', 'lenient',
          { probe: 'unknown top-level field', result: 'accepted (HTTP 200)' });
      } else if (CONTEXT_REJECT.has(r.status)) {
        record('strict_unknown_fields', 'measured', 'strict',
          { probe: 'unknown top-level field', result: `rejected (HTTP ${r.status})`, detail: clip(r.message) });
      } else {
        record('strict_unknown_fields', 'unknown', null, { reason: `unexpected failure: ${clip(r.message)}` });
      }
    }

    // 2) tool_choice
    {
      const r = await call(body({ messages: [{ role: 'user', content: PROMPT }], tools: TOOL, extra: { tool_choice: 'auto' } }));
      if (r.ok) record('tool_choice', 'measured', true, { probe: 'tool_choice: "auto"', result: 'accepted' });
      else if (CONTEXT_REJECT.has(r.status)) {
        record('tool_choice', 'measured', false, { probe: 'tool_choice: "auto"', result: `rejected (HTTP ${r.status})`, detail: clip(r.message) });
      } else record('tool_choice', 'unknown', null, { reason: clip(r.message) });
    }

    // 3) grammar
    {
      const r = await call(body({ messages: [{ role: 'user', content: PROMPT }], extra: { grammar: 'root ::= "OK"' } }));
      if (r.ok) record('grammar', 'measured', true, { probe: 'GBNF `grammar` field', result: 'accepted' });
      else if (CONTEXT_REJECT.has(r.status)) {
        record('grammar', 'measured', false, { probe: 'GBNF `grammar` field', result: `rejected (HTTP ${r.status})`, detail: clip(r.message) });
      } else record('grammar', 'unknown', null, { reason: clip(r.message) });
    }

    // 4) reasoning shape: observe a real tool-call response and see which field carried the
    //    reasoning. No reasoning in the response is not "no reasoning field" - it is unknown,
    //    because the model may simply not have thought on this prompt.
    let observed = null;
    {
      const r = await call(body({ messages: [{ role: 'user', content: TOOL_PROMPT }], tools: TOOL }));
      if (!r.ok) {
        record('reasoning_field', 'unknown', null, { reason: clip(r.message) });
      } else {
        const msg = (r.data && r.data.choices && r.data.choices[0] && r.data.choices[0].message) || {};
        const field = msg.reasoning_content ? 'reasoning_content'
          : msg.reasoning ? 'reasoning' : null;
        if (!field) {
          record('reasoning_field', 'unknown', null,
            { reason: 'no reasoning field in this response', hint: 'the model may not reason on this prompt' });
        } else {
          record('reasoning_field', 'measured', field, { observed: `response carried \`${field}\`` });
        }
        if (field && Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
          observed = { msg, field };
        }
      }
    }

    // 5) echo requirement: the strict/lenient variant of the reasoning rule. Rejected WITHOUT
    //    the echo and accepted WITH it is the only evidence that distinguishes "required"
    //    from "this endpoint rejects tool exchanges for another reason".
    if (!observed) {
      record('reasoning_echo_with_tools', 'unknown', null,
        { reason: 'no tool call with reasoning observed, so the echo rule cannot be exercised' });
    } else {
      const exchange = [
        { role: 'user', content: TOOL_PROMPT },
        { role: 'assistant', content: observed.msg.content || '', tool_calls: observed.msg.tool_calls },
        { role: 'tool', tool_call_id: observed.msg.tool_calls[0].id, content: 'OK' },
      ];
      const without = await call(body({ messages: exchange, tools: TOOL }));
      if (without.ok) {
        record('reasoning_echo_with_tools', 'measured', false,
          { probe: 'tool exchange without echoing reasoning', result: 'accepted' });
      } else if (CONTEXT_REJECT.has(without.status) && /reason/i.test(without.message)) {
        const withEcho = exchange.map((m, i) => (i === 1 ? { ...m, [observed.field]: 'probe reasoning' } : m));
        const echoed = await call(body({ messages: withEcho, tools: TOOL }));
        if (echoed.ok) {
          record('reasoning_echo_with_tools', 'measured', true, {
            probe: 'tool exchange without then with the reasoning echoed',
            result: 'rejected without, accepted with',
            detail: clip(without.message),
          });
        } else {
          record('reasoning_echo_with_tools', 'unknown', null,
            { reason: 'rejected with and without the echo: the rejection is not about reasoning', detail: clip(without.message) });
        }
      } else {
        record('reasoning_echo_with_tools', 'unknown', null,
          { reason: `rejected without naming reasoning: ${clip(without.message)}` });
      }
    }

    // 6) streamed usage. Absent usage is a real answer: the budget then cannot be calibrated
    //    on streamed turns, which is worth knowing before a 1M-token window is assumed.
    {
      if (requests >= maxRequests) throw new ProbeError('cap_reached', `request cap ${maxRequests} reached`);
      requests += 1;
      const r = await attempt(() => client._postStream(body({
        messages: [{ role: 'user', content: PROMPT }],
        extra: { stream_options: { include_usage: true } },
        stream: true,
      }), {}));
      if (r.ok) {
        const usage = r.data && r.data.usage;
        record('stream_options', 'measured', Boolean(usage),
          { probe: 'stream_options.include_usage', result: usage ? 'usage chunk present' : 'no usage in the streamed response' });
      } else {
        record('stream_options', 'unknown', null, { reason: clip(r.message) });
      }
    }

    // 7) usable window, by probing. The ladder finds an accept/reject bracket in ~log4(ceiling)
    //    requests; the bisection refines it. Every step's target is recorded so the number can
    //    be audited, and a non-context failure stops the search instead of being read as a
    //    smaller window.
    {
      const steps = [];
      let lo = 0;
      let hi = null;
      let stopped = null;
      for (const target of ladder) {
        const r = await call(body({
          messages: [{ role: 'user', content: paddingFor(target) + ' Reply OK.' }],
          maxTokens: 1,
        }));
        steps.push({ target, ok: r.ok, status: r.status || null });
        if (r.ok) { lo = target; continue; }
        if (CONTEXT_REJECT.has(r.status)) { hi = target; break; }
        stopped = r.message;
        break;
      }
      if (stopped) {
        record('context_window_tokens', 'unknown', null, { reason: clip(stopped), steps });
      } else if (hi == null) {
        // Everything up to the ceiling was accepted: the real window is at least this large.
        record('context_window_tokens', 'measured', lo,
          { result: `accepted ${lo} tokens; the ceiling (${ceiling}) was not reached`, steps, lower_bound: true });
      } else {
        let a = lo;
        let b = hi;
        for (let i = 0; i < BISECT_STEPS && b - a > 128; i += 1) {
          const mid = Math.floor((a + b) / 2);
          const r = await call(body({
            messages: [{ role: 'user', content: paddingFor(mid) + ' Reply OK.' }],
            maxTokens: 1,
          }));
          steps.push({ target: mid, ok: r.ok, status: r.status || null });
          if (r.ok) a = mid;
          else if (CONTEXT_REJECT.has(r.status)) b = mid;
          else { steps.push({ target: mid, note: 'stopped: non-context failure' }); break; }
        }
        if (!a) {
          // Rejected at the smallest prompt the ladder sent: no window to report, and a 0
          // would be a number the endpoint never confirmed.
          record('context_window_tokens', 'unknown', null, {
            reason: `rejected even at ${FLOOR_TOKENS} tokens (smallest probed prompt)`,
            steps,
          });
        } else {
          record('context_window_tokens', 'measured', a,
            { result: `largest accepted prompt: ${a} tokens`, bracket: [a, b], steps });
        }
      }
    }
  } catch (e) {
    if (e && e.code === 'cap_reached') {
      return {
        status: 'unmeasured',
        reason: `request cap ${maxRequests} reached after ${requests} requests`,
        results,
        requests_made: requests,
        ceiling,
      };
    }
    throw e;
  }

  const measured = Object.values(results).filter((r) => r.status === 'measured').length;
  return {
    // Even one measured fact is a measurement; the unknowns are part of the record, not a
    // total failure. With nothing measured, the record says so instead of inventing values.
    status: measured ? 'measured' : 'unmeasured',
    reason: measured ? null : 'no measurement could be taken (see per-check reasons)',
    results,
    requests_made: requests,
    ceiling,
    usable_window_tokens: (results.context_window_tokens && results.context_window_tokens.status === 'measured')
      ? results.context_window_tokens.value : null,
  };
}

// ── record ─────────────────────────────────────────────────────────────────
function writeMeasurement(file, entry) {
  let doc = { version: 1, profiles: {} };
  try {
    const current = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (current && current.version === 1 && current.profiles) doc = current;
  } catch { /* absent or unreadable: a fresh record is better than failing the write */ }
  doc.profiles[entry.profile] = entry;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n');
  fs.renameSync(tmp, file);   // atomic: a reader never sees half a record
}

function readMeasurements(file) {
  try {
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    return doc && doc.version === 1 && doc.profiles ? doc : { version: 1, profiles: {} };
  } catch { return { version: 1, profiles: {} }; }
}

const label = (id) => `${id}`.padEnd(26);

function formatResult(result) {
  const lines = [];
  const ids = [
    'strict_unknown_fields', 'tool_choice', 'grammar', 'reasoning_field',
    'reasoning_echo_with_tools', 'stream_options', 'context_window_tokens',
  ];
  for (const id of ids) {
    const r = (result.results || {})[id];
    if (!r) { lines.push(`  ${label(id)}unknown  (not attempted)`); continue; }
    const value = r.status === 'measured' ? JSON.stringify(r.value) : '—';
    const why = r.status === 'measured'
      ? (r.evidence && (r.evidence.result || r.evidence.observed) || '')
      : (r.evidence && (r.evidence.reason || ''));
    lines.push(`  ${label(id)}${r.status.padEnd(8)} ${value.padEnd(22)} ${clip(why, 90)}`);
  }
  return lines.join('\n');
}

// ── CLI ────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--yes') out.yes = true;
    else if (a === '--allow-cloud') out.allowCloud = true;
    else if (['--profile', '--config', '--ceiling', '--max-requests'].includes(a)) {
      const v = argv[i + 1];
      if (v == null) throw new TypeError(`${a} richiede un valore`);
      if (a === '--profile') out.profile = v;
      if (a === '--config') out.config = v;
      if (a === '--ceiling') out.ceiling = Number(v);
      if (a === '--max-requests') out.maxRequests = Number(v);
      i += 1;
    } else if (/^--/.test(a)) throw new TypeError(`flag sconosciuta "${a}"`);
    else out._.push(a);
  }
  return out;
}

function usage(to) {
  to('usage: node tools/provider-probe.js plan [--profile X] [--config F] [--ceiling N]');
  to('       node tools/provider-probe.js run  [--profile X] [--config F] [--ceiling N]');
  to('                                        [--max-requests N] --yes [--allow-cloud]');
  to('');
  to(`plan = zero requests, prints the request count and the estimated cost.`);
  to(`run needs --yes and a cap (1..${HARD_MAX_REQUESTS}); it refuses when the plan needs more.`);
  to('Writes reports/provider-measurements.json (CYBOROS_PROVIDER_MEASUREMENTS overrides).');
  to('exit: 0 ok | 1 refusal / nothing measurable | 2 usage');
}

function validateRunGate(opts, plan) {
  // Consent first: the operator sees the numbers, then says yes.
  if (!opts.yes) {
    throw new ProbeError('consent_required',
      'run richiede --yes: stampa prima il piano con `plan`, poi riprova consapevolmente. Zero richieste inviate.');
  }
  const cap = opts.maxRequests;
  if (!Number.isInteger(cap) || cap <= 0) {
    throw new ProbeError('cap_required',
      `serve un cap esplicito e positivo (--max-requests 1..${HARD_MAX_REQUESTS}): la sonda non gira senza limite.`);
  }
  if (cap > HARD_MAX_REQUESTS) {
    throw new ProbeError('cap_too_high',
      `cap ${cap} oltre il massimo consentito (${HARD_MAX_REQUESTS}): abbassalo o riduci --ceiling.`);
  }
  if (plan.requests > cap) {
    throw new ProbeError('cap_too_low',
      `il piano richiede fino a ${plan.requests} richieste, il cap è ${cap}: alza il cap o abbassa --ceiling.`);
  }
}

async function main(argv) {
  let opts;
  try { opts = parseArgs(argv); } catch (e) {
    console.error(`uso errato: ${e.message}`);
    usage(console.error);
    return 2;
  }
  if (opts._.length !== 1 || !['plan', 'run'].includes(opts._[0])) {
    usage(console.error);
    return 2;
  }
  const cmd = opts._[0];
  if (opts.ceiling != null && (!Number.isInteger(opts.ceiling) || opts.ceiling < FLOOR_TOKENS)) {
    console.error(`uso errato: --ceiling deve essere un intero >= ${FLOOR_TOKENS}`);
    return 2;
  }

  // Same resolution as a turn: cloud consent, key, profile. `run` fails on any gate; `plan`
  // is arithmetic over a file and sends nothing, so a gate it cannot pass becomes a NOTE —
  // telling an operator the cost of a probe they are not yet allowed to run is the point.
  const GATE_CODES = new Set(['cloud_disabled', 'cloud_requires_flag', 'provider_key_missing']);
  let auth;
  let gate = null;
  try {
    auth = live.resolveAuth({ configPath: opts.config, profile: opts.profile, allowCloud: opts.allowCloud });
  } catch (e) {
    if (cmd !== 'plan' || !GATE_CODES.has(e && e.code)) {
      console.error(`provider-probe: UNMEASURED — ${e.message}`);
      console.error('  nessun numero inventato: senza credenziale o endpoint raggiungibile non c\'è misura.');
      return 1;
    }
    gate = e;
    try {
      const { cfg } = live.loadConfig(opts.config);
      const { profile, p, egress } = live.resolveProfile(cfg, opts.profile);
      auth = { cfg, profile, p, egress, key: null, keyEnv: p.api_key_env || null };
    } catch (inner) {
      console.error(`provider-probe: UNMEASURED — ${inner.message}`);
      return 1;
    }
  }

  // The plan is computed from the DECLARED profile: what the probe costs is a property of the
  // endpoint, not of a previous measurement.
  const declared = adapters.resolveCapabilities(auth.p);
  const ceiling = opts.ceiling || declared.context_window_tokens || DEFAULT_CEILING;
  const maxRequests = opts.maxRequests || DEFAULT_MAX_REQUESTS;
  const plan = planFor({ caps: declared, ceiling, maxRequests });

  if (cmd === 'plan') {
    console.log(formatPlan(plan, { profile: auth.profile, baseUrl: auth.p.base_url }));
    console.log('  (dry: niente rete. `run --yes --max-requests N` esegue il piano.)');
    if (gate) console.log(`  nota: \`run\` ora fallirebbe — ${gate.message}`);
    return 0;
  }

  try {
    validateRunGate(opts, plan);
  } catch (e) {
    console.error(`provider-probe: RIFIUTATO — ${e.message}`);
    return 1;
  }

  const client = live.buildClient(auth.p, auth.key, live.measurementsFor(auth.profile, auth.p));
  // A measurement is one request; a retry is a second request the operator did not approve.
  client.rt.retries = 0;

  console.log(`provider-probe: ${auth.profile} · ${auth.p.base_url} · cap ${maxRequests} richieste`);
  const result = await runProbe({ client, caps: declared, model: auth.p.model, ceiling, maxRequests });

  const entry = {
    profile: auth.profile,
    endpoint_hash: live.endpointHash(auth.p),
    model: auth.p.model,
    base_url: auth.p.base_url,
    status: result.status,
    reason: result.reason || null,
    measured_at: new Date().toISOString(),
    requests_made: result.requests_made,
    results: result.results,
    usable_window_tokens: result.usable_window_tokens || null,
  };
  const file = live.measurementFile();
  writeMeasurement(file, entry);

  console.log(`\n  profile ${entry.profile} · ${entry.status.toUpperCase()} · ${entry.requests_made} richieste`);
  if (entry.status === 'measured') {
    console.log(formatResult(entry));
    console.log(`\n  scritto: ${path.relative(process.cwd(), file)}`);
    return 0;
  }
  console.log(`  motivo: ${entry.reason}`);
  console.log('  nessuna capacità misurata: il record non contiene numeri, l\'adapter resta sulle dichiarazioni.');
  return 1;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((e) => {
    console.error(`provider-probe: ${e && e.message ? e.message : e}`);
    process.exitCode = 1;
  });
}

module.exports = {
  ProbeError,
  DEFAULT_CEILING,
  DEFAULT_MAX_REQUESTS,
  HARD_MAX_REQUESTS,
  FLOOR_TOKENS,
  windowLadder,
  planFor,
  formatPlan,
  runProbe,
  writeMeasurement,
  readMeasurements,
  parseArgs,
  validateRunGate,
  main,
};
