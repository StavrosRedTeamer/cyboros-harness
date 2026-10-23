// local/adapters.js — what a provider actually accepts, declared once.
//
// Why this file exists
// --------------------
// The request builder used to assume one shape for every endpoint (`type:
// "openai-compatible"`) and then hardcode the exceptions: `native_tools: true` for
// everyone, and `chat_template_kwargs: {enable_thinking:false}` — a llama.cpp-only field
// — sent to any endpoint whenever thinking was disabled. That is not a provider layer,
// it is one provider and a list of accidents.
//
// Here a profile DECLARES what it supports and the builder consumes only that:
//
//   capabilities: {
//     tool_calls: "native" | "text",     // send `tools`, or rely on ACTION: parsing
//     tool_choice: bool,                 // may send tool_choice
//     parallel_tool_calls: bool | null,  // null = do not send the field
//     reasoning: { param, on, off },     // parameter SHAPE for enabling/disabling thinking
//     reasoning_field: "reasoning_content" | "reasoning" | null,
//     reasoning_echo_with_tools: bool,   // must prior reasoning be sent back?
//     strict_unknown_fields: bool,       // rejects fields it does not document
//     grammar: bool,                     // accepts llama.cpp's GBNF `grammar`
//     timings: bool,                     // accepts `timings_per_token`
//     stream_options: bool,              // accepts `stream_options.include_usage`
//     sampling_extras: bool,             // accepts top_k / *_penalty
//     context_window_tokens: number,
//     reserved_output_tokens: number,
//     context_safety_tokens: number,
//     max_output_tokens: number,
//     pricing: { input_per_1m, output_per_1m, cached_input_per_1m }
//   }
//
// Three rules keep this honest:
//
//   1. An unknown capability key is an ERROR, not a no-op. A typo
//      (`reasoning_echo_with_tool`) that silently does nothing is exactly the class of
//      bug this file replaces. The same goes for a capability nobody reads: a declared
//      but unimplemented key is a lie in the matrix, so it gets deleted, not documented.
//   2. A strict profile gets a final assertion: every field in the built body must be
//      accounted for by a capability. `tools` and `tool_choice` are gated too — they are
//      the fields the capability exists for.
//   3. THIS file decides what goes on the wire. An unsatisfiable combination — a GBNF
//      grammar requested on a profile that never declared one — throws here instead of
//      being downgraded: silently dropping the grammar and the tool schema together
//      leaves the model no way to call a tool at all, which is worse than failing.
//
// On DeepSeek: nothing here is invented as fact. The type defaults encode what the
// vendor documents (thinking on by default via `thinking: {type}`, `reasoning_content`
// as the reasoning field, the echo requirement when tools are present) and mark the rest
// as overridable. Every one of those can be overridden per profile, and the conformance
// test in tools/test-adapters.js proves the builder only uses what was declared.

'use strict';

// Fields that exist in the OpenAI chat-completions shape itself and are sent on every
// request, so no capability pays for them. `tools` and `tool_choice` are NOT here: they
// are exactly what `tool_calls`/`tool_choice` gate, and treating them as core made the
// strict assertion blind to the drift it exists to catch.
const CORE_FIELDS = new Set([
  'model', 'messages', 'stream', 'temperature', 'top_p', 'max_tokens',
]);

const SAMPLING_EXTRAS = ['top_k', 'presence_penalty', 'frequency_penalty', 'repeat_penalty'];

const REASONING_PARAMS = ['none', 'chat_template_kwargs', 'thinking', 'reasoning_effort'];

const PACKAGE_DEFAULTS = {
  tool_calls: 'native',
  tool_choice: true,
  parallel_tool_calls: null,
  reasoning: { param: 'none' },
  reasoning_field: 'reasoning_content',
  reasoning_echo_with_tools: false,
  strict_unknown_fields: false,
  grammar: false,
  timings: false,
  stream_options: false,
  sampling_extras: false,
  context_window_tokens: null,
  reserved_output_tokens: null,
  context_safety_tokens: null,
  max_output_tokens: null,
  pricing: null,
};

// Types differ only in defaults, and the defaults must match what the name claims.
//
//   openai-compatible — the plain chat-completions shape: the standard usage chunk on a
//                       streamed request (`stream_options` is OpenAI's own field), and every
//                       VENDOR extension OFF unless the profile declares it. A cloud gateway
//                       is not llama.cpp, and a type named after the standard must not
//                       smuggle one vendor's fields into it.
//   llama-cpp        — the same shape plus the llama.cpp extensions this project uses
//                       (GBNF grammar, timings_per_token, top_k/*_penalty).
//   deepseek         — a strict cloud endpoint: minimal fields, thinking shape declared,
//                       reasoning echo required with tools.
const TYPE_DEFAULTS = {
  'openai-compatible': {
    ...PACKAGE_DEFAULTS,
    stream_options: true,
  },
  'llama-cpp': {
    ...PACKAGE_DEFAULTS,
    stream_options: true,
    grammar: true,
    timings: true,
    sampling_extras: true,
  },
  deepseek: {
    ...PACKAGE_DEFAULTS,
    // Documented by the vendor: thinking is on by default and toggled with a `thinking`
    // object. `on` is sent only when the operator asks for it explicitly, so the server
    // default is never overridden by accident.
    reasoning: { param: 'thinking', on: { type: 'enabled' }, off: { type: 'disabled' } },
    reasoning_field: 'reasoning_content',
    // Documented: with `tools` present, the full reasoning of prior turns must be sent
    // back or the request is rejected. Overridable if that stops being true.
    reasoning_echo_with_tools: true,
    // Conservative, not a claim: send only fields the vendor documents.
    strict_unknown_fields: true,
  },
};

class AdapterError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AdapterError';
    this.code = code;
  }
}

const isPlainObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const clone = (v) => JSON.parse(JSON.stringify(v));

function knownTypes() {
  return Object.keys(TYPE_DEFAULTS);
}
function isValidType(type) {
  return Object.prototype.hasOwnProperty.call(TYPE_DEFAULTS, type);
}
function defaultsFor(type) {
  return clone(TYPE_DEFAULTS[type || 'openai-compatible']);
}

// Keys starting with `_` are documentation, which this repo writes inline in JSON
// (`_comment`, `_note`, `_budget_note`). They are tolerated everywhere else, so they are
// tolerated here too — but they never affect behaviour.
function validateCapabilities(declared, where = 'capabilities') {
  const errors = [];
  if (declared == null) return errors;
  if (!isPlainObject(declared)) return [`${where}: must be an object`];
  const allowed = new Set(Object.keys(PACKAGE_DEFAULTS));
  for (const key of Object.keys(declared)) {
    if (key.startsWith('_')) continue;
    if (!allowed.has(key)) {
      errors.push(`${where}.${key}: unknown capability (known: ${[...allowed].sort().join(', ')})`);
    }
  }
  const boolKeys = ['tool_choice', 'reasoning_echo_with_tools', 'strict_unknown_fields', 'grammar', 'timings', 'stream_options', 'sampling_extras'];
  for (const k of boolKeys) {
    if (declared[k] != null && typeof declared[k] !== 'boolean') errors.push(`${where}.${k}: must be a boolean`);
  }
  if (declared.tool_calls != null && !['native', 'text'].includes(declared.tool_calls)) {
    errors.push(`${where}.tool_calls: must be "native" or "text"`);
  }
  if (declared.parallel_tool_calls != null && typeof declared.parallel_tool_calls !== 'boolean') {
    errors.push(`${where}.parallel_tool_calls: must be a boolean or null`);
  }
  if (declared.reasoning_field != null && declared.reasoning_field !== null
    && !['reasoning_content', 'reasoning'].includes(declared.reasoning_field)) {
    errors.push(`${where}.reasoning_field: must be "reasoning_content", "reasoning" or null`);
  }
  if (declared.reasoning != null) {
    if (!isPlainObject(declared.reasoning)) errors.push(`${where}.reasoning: must be an object`);
    else {
      for (const k of Object.keys(declared.reasoning)) {
        if (k.startsWith('_')) continue;
        if (!['param', 'on', 'off'].includes(k)) errors.push(`${where}.reasoning.${k}: unknown key (known: param, on, off)`);
      }
      const param = declared.reasoning.param;
      if (param != null && !REASONING_PARAMS.includes(param)) {
        errors.push(`${where}.reasoning.param: must be one of ${REASONING_PARAMS.join(' | ')}`);
      }
      // A shape without a parameter is a no-op; say so instead of ignoring it.
      if ((declared.reasoning.on !== undefined || declared.reasoning.off !== undefined)
        && (param == null || param === 'none')) {
        errors.push(`${where}.reasoning: on/off given without a param`);
      }
    }
  }
  for (const k of ['context_window_tokens', 'reserved_output_tokens', 'context_safety_tokens', 'max_output_tokens']) {
    if (declared[k] == null) continue;
    const n = num(declared[k]);
    if (n == null || n <= 0) errors.push(`${where}.${k}: must be a positive number`);
  }
  if (declared.pricing != null) {
    if (!isPlainObject(declared.pricing)) errors.push(`${where}.pricing: must be an object`);
    else {
      for (const k of Object.keys(declared.pricing)) {
        if (k.startsWith('_')) continue;
        if (!['input_per_1m', 'output_per_1m', 'cached_input_per_1m'].includes(k)) {
          errors.push(`${where}.pricing.${k}: unknown key (known: input_per_1m, output_per_1m, cached_input_per_1m)`);
        } else if (num(declared.pricing[k]) == null || num(declared.pricing[k]) < 0) {
          errors.push(`${where}.pricing.${k}: must be a non-negative number`);
        }
      }
    }
  }
  return errors;
}

// Type defaults, then the legacy top-level fields this repo already ships, then whatever
// the profile declares. Declared wins; legacy only fills a hole.
function resolveCapabilities(profile = {}) {
  const type = profile.type || 'openai-compatible';
  if (!isValidType(type)) {
    throw new AdapterError('type_unknown',
      `unknown provider type "${type}" · known: ${knownTypes().join(', ')}`);
  }
  const declared = profile.capabilities || {};
  const errors = validateCapabilities(declared, 'capabilities');
  if (errors.length) {
    throw new AdapterError('capabilities_invalid', errors.join('\n  '));
  }
  const caps = { ...defaultsFor(type) };
  if (declared.reasoning != null) caps.reasoning = { ...caps.reasoning, ...declared.reasoning };
  for (const [k, v] of Object.entries(declared)) {
    if (k.startsWith('_') || k === 'reasoning') continue;
    caps[k] = v;
  }
  for (const k of ['context_window_tokens', 'reserved_output_tokens', 'context_safety_tokens']) {
    if (caps[k] == null && profile[k] != null) {
      const n = num(profile[k]);
      if (n != null && n > 0) caps[k] = n;
    }
  }
  caps.type = type;
  if (caps.reasoning.param == null) caps.reasoning.param = 'none';
  return caps;
}

function buildRequest({ caps, model, messages, tools, grammar, sampling = {}, runtime = {}, stream = false }) {
  const body = { model, messages, stream: !!stream };

  body.temperature = sampling.temperature ?? 0.4;
  body.top_p = sampling.top_p ?? 0.9;
  let maxTokens = num(sampling.max_tokens) ?? 1024;
  if (caps.max_output_tokens != null) maxTokens = Math.min(maxTokens, caps.max_output_tokens);
  body.max_tokens = maxTokens;

  // Thinking: the parameter SHAPE is per provider, and no shape is sent to a provider
  // that did not declare one. `undefined` means "leave the server default alone".
  const param = (caps.reasoning && caps.reasoning.param) || 'none';
  if (param !== 'none') {
    const want = runtime.allow_thinking;
    if (want === false) {
      if (caps.reasoning.off !== undefined) body[param] = caps.reasoning.off;
    } else if (want === true) {
      if (caps.reasoning.on !== undefined) body[param] = caps.reasoning.on;
    }
  }

  // GBNF is a llama.cpp extension, and it constrains the TEXT protocol, so it and a native
  // tool schema cannot both be offered. The two cases are distinct and must not be merged:
  //
  //   · declared   -> send the grammar, withhold the schema (the grammar IS the contract);
  //   · not declared -> an unsatisfiable request. Until this threw, the caller's "a grammar
  //     was requested" was taken to mean "no schema either", so a profile without GBNF got
  //     neither and the run lost tool-calling with no error anywhere.
  if (grammar) {
    if (!caps.grammar) {
      throw new AdapterError('grammar_unsupported',
        `adapter "${caps.type}" does not declare "grammar", but this run requested a GBNF grammar. `
        + 'Declare it for this profile, or run it without the grammar: dropping both the grammar '
        + 'and the tool schema would leave the model no way to call a tool.');
    }
    body.grammar = grammar;
  }

  const wantsTools = offersSchema(caps, tools, grammar);
  if (wantsTools) {
    body.tools = tools;
    if (caps.tool_choice) body.tool_choice = 'auto';
    if (caps.parallel_tool_calls != null) body.parallel_tool_calls = !!caps.parallel_tool_calls;
  }

  if (caps.sampling_extras) {
    for (const k of SAMPLING_EXTRAS) if (sampling[k] != null) body[k] = sampling[k];
  }

  if (stream) {
    // `runtime.stream_usage: false` stays a working knob: the capability says the field is
    // legal here, the runtime flag says whether this run wants it.
    if (caps.stream_options && runtime.stream_usage !== false) body.stream_options = { include_usage: true };
    if (runtime.timings_per_token && caps.timings) body.timings_per_token = true;
  }

  // The strict-profile guarantee: no field may appear in the body unless a capability
  // accounts for it. This is what makes "strict_unknown_fields" load-bearing rather than
  // descriptive — a future edit that adds a field without a capability fails here.
  strictCheck(caps, body);

  return { body };
}

// One rule, two consumers: the builder decides what ships, the token accounting decides
// what to bill. They were two copies of "`!grammar && native`" before, which is the kind of
// duplication where the budget quietly stops matching the request.
function offersSchema(caps, tools, grammar) {
  return !grammar && caps.tool_calls === 'native' && Array.isArray(tools) && tools.length > 0;
}

// Extracted so the invariant can be tested directly: a body with one extra field is
// refused, a body the capabilities cover passes. `buildRequest` calls it, so the test and
// the production path assert the same function.
function strictCheck(caps, body) {
  if (!caps || !caps.strict_unknown_fields) return body;
  const param = (caps.reasoning && caps.reasoning.param) || 'none';
  const allowed = new Set(CORE_FIELDS);
  if (caps.grammar) allowed.add('grammar');
  if (caps.tool_calls === 'native') allowed.add('tools');
  if (caps.tool_choice) allowed.add('tool_choice');
  if (param !== 'none') allowed.add(param);
  if (caps.parallel_tool_calls != null) allowed.add('parallel_tool_calls');
  if (caps.stream_options) allowed.add('stream_options');
  if (caps.timings) allowed.add('timings_per_token');
  if (caps.sampling_extras) for (const k of SAMPLING_EXTRAS) allowed.add(k);
  for (const k of Object.keys(body || {})) {
    if (!allowed.has(k)) {
      throw new AdapterError('undeclared_field',
        `adapter "${caps.type}" is strict but the request carries "${k}", which no capability declares`);
    }
  }
  return body;
}

// The reasoning field moved between provider versions before (`reasoning_content` vs
// `reasoning`). Reading is tolerant; WRITING is not — the declared field is the only one
// we ever add to a message.
function readReasoning(caps, message) {
  if (!message || !caps.reasoning_field) return '';
  const primary = message[caps.reasoning_field];
  if (primary) return String(primary);
  const alt = caps.reasoning_field === 'reasoning' ? 'reasoning_content' : 'reasoning';
  return message[alt] ? String(message[alt]) : '';
}

function attachReasoning(caps, message, text) {
  if (!text || !caps.reasoning_field) return message;
  return { ...message, [caps.reasoning_field]: text };
}

function echoReasoning(caps, message, text) {
  if (!text || !caps.reasoning_field || !caps.reasoning_echo_with_tools) return message;
  return { ...message, [caps.reasoning_field]: text };
}

// Cost is reported by the provider when it can be; when it cannot, a declared price table
// gives an estimate rather than a null the operator cannot act on. Overstating is the
// safe direction, so a profile should declare the peak rate.
function costOf(caps, usage) {
  const p = caps.pricing;
  if (!p || !usage) return null;
  const input = num(usage.prompt_tokens ?? usage.tokens_in) ?? 0;
  const output = num(usage.completion_tokens ?? usage.tokens_out) ?? 0;
  if (!input && !output) return null;
  const cached = Math.min(input, num(usage.prompt_cache_hit_tokens ?? usage.cached_tokens) ?? 0);
  const rate = (v) => (v == null ? null : Number(v));
  const inRate = rate(p.input_per_1m);
  const outRate = rate(p.output_per_1m);
  const cachedRate = rate(p.cached_input_per_1m) ?? inRate;
  if (inRate == null && outRate == null) return null;
  const cost = ((input - cached) * (inRate ?? 0) + cached * (cachedRate ?? 0) + output * (outRate ?? 0)) / 1e6;
  return Number.isFinite(cost) ? cost : null;
}

// The human line for /model and the session card. It lives here because it lists capability
// names; a surface that formatted them itself would need editing whenever the matrix grows.
function summarize(caps, toolMode) {
  const tok = (n) => (Number(n) / 1000).toFixed(1) + 'k';
  const param = (caps.reasoning && caps.reasoning.param) || 'none';
  const parts = [caps.type, toolMode === 'native' ? 'native tools' : 'text tools'];
  parts.push(param === 'none' ? 'no thinking switch' : `thinking via ${param}`);
  if (caps.reasoning_echo_with_tools) parts.push('reasoning echoed with tools');
  if (caps.context_window_tokens) parts.push(`window ${tok(caps.context_window_tokens)}`);
  if (caps.max_output_tokens) parts.push(`max out ${tok(caps.max_output_tokens)}`);
  if (caps.strict_unknown_fields) parts.push('strict fields');
  if (caps.measured) parts.push('measured');
  return parts.join(' · ');
}

// What a probe OBSERVED replaces what a profile DECLARED, but only where the observation
// exists and only in the safe direction: a measurement may reduce what we send (stop
// sending a field the endpoint 400s on, require an echo it enforces, assume a smaller
// window) — never enlarge the request surface because "it accepted an unknown field
// today". A bigger measured window is used only when the profile declared none at all.
function applyMeasurements(caps, measured) {
  if (!measured || measured.status !== 'measured') return caps;
  const value = (id) => {
    const r = (measured.results || {})[id];
    return r && r.status === 'measured' ? r.value : undefined;
  };
  const out = { ...caps };
  if (value('strict_unknown_fields') === 'strict') out.strict_unknown_fields = true;
  if (value('tool_choice') === false) out.tool_choice = false;
  if (value('grammar') === false) out.grammar = false;
  const field = value('reasoning_field');
  if (field === 'reasoning_content' || field === 'reasoning') out.reasoning_field = field;
  if (value('reasoning_echo_with_tools') === true) out.reasoning_echo_with_tools = true;
  if (value('stream_options') === false) out.stream_options = false;
  const window = num(measured.usable_window_tokens);
  if (window && window > 0) {
    out.context_window_tokens = out.context_window_tokens == null
      ? window
      : Math.min(out.context_window_tokens, window);
  }
  out.measured = true;
  return out;
}

function resolveAdapter(cfg = {}) {
  const caps = applyMeasurements(resolveCapabilities(cfg), cfg.measured);
  // The capability wins; the legacy runtime flag only applies when the profile did not
  // declare a tool-calling style at all.
  const declaredToolCalls = (cfg.capabilities || {}).tool_calls;
  const toolMode = declaredToolCalls
    ? declaredToolCalls
    : (cfg.runtime && cfg.runtime.native_tools === false ? 'text' : caps.tool_calls);

  return {
    type: caps.type,
    caps,
    toolMode,
    buildRequest: (req) => buildRequest({ ...req, caps }),
    offersSchema: ({ tools, grammar }) => offersSchema(caps, tools, grammar),
    readReasoning: (m) => readReasoning(caps, m),
    attachReasoning: (m, t) => attachReasoning(caps, m, t),
    echoReasoning: (m, t) => echoReasoning(caps, m, t),
    costOf: (u) => costOf(caps, u),
    // One description, consumed by every surface: the TUI prints `summary`, tests assert
    // the fields. Nothing outside this file knows a capability's name.
    describe() {
      return {
        type: caps.type,
        tool_calls: toolMode,
        reasoning_param: caps.reasoning.param,
        reasoning_field: caps.reasoning_field,
        reasoning_echo_with_tools: caps.reasoning_echo_with_tools,
        strict_unknown_fields: caps.strict_unknown_fields,
        measured: Boolean(caps.measured),
        context_window_tokens: caps.context_window_tokens,
        max_output_tokens: caps.max_output_tokens,
        pricing: Boolean(caps.pricing),
        summary: summarize(caps, toolMode),
      };
    },
  };
}

module.exports = {
  AdapterError,
  CORE_FIELDS,
  PACKAGE_DEFAULTS,
  TYPE_DEFAULTS,
  REASONING_PARAMS,
  validateCapabilities,
  resolveCapabilities,
  applyMeasurements,
  resolveAdapter,
  buildRequest,
  offersSchema,
  strictCheck,
  readReasoning,
  echoReasoning,
  attachReasoning,
  costOf,
};
