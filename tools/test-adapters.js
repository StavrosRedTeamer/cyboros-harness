#!/usr/bin/env node
// test-adapters.js — what a provider DECLARES is what the request contains.
//
// Perché esiste: il vecchio builder aveva una sola forma per ogni endpoint
// (`type: "openai-compatible"`) e poi le eccezioni scritte a mano — `native_tools: true`
// per tutti, e `chat_template_kwargs: {enable_thinking:false}` (campo di llama.cpp)
// spedito a qualunque endpoint quando il thinking era spento. Quei difetti non si vedono
// in un test che guarda le proprie strutture: si vedono solo mettendo il builder contro
// un endpoint che RIFIUTA ciò che non conosce, con HTTP 400.
//
// Quindi qui c'è un endpoint finto con una allowlist vera: ogni test che "il campo X non
// parte" è verificato sia sul body costruito sia contro il server. E i tre comportamenti
// che un profilo dichiara ma nessuno verifica a mano — reasoning in un campo separato,
// reasoning assente, scambio di tool_calls — sono provati end-to-end sul loop.
//
// L'ultimo blocco prende il profilo DeepSeek SPEDITO in runtime/providers.example.json
// (non una sua copia riscritta qui) e lo fa girare per intero attraverso runtime/live.js
// contro un endpoint finto che pretende l'echo del reasoning quando ci sono i tool: se il
// profilo dichiara una cosa e ne spedisce un'altra, il test cade qui.

'use strict';
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { ok, okAsync, summary, fixture } = require('./testkit');
const adapters = require('../local/adapters');
const { LocalLLM } = require('../local/llm');
const live = require('../runtime/live');

const EXAMPLE = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'runtime', 'providers.example.json'), 'utf8'));

// The tests that need an HTTP endpoint are queued and run in order after the pure ones:
// sequential on purpose, so a failure names the block that broke without three servers
// interleaving their requests in the log.
const queue = [];
const later = (name, fn) => queue.push([name, fn]);

// ── fixtures: server HTTP + frame SSE ────────────────────────────────────────
function startServer(onBody) {
  const bodies = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch { /* recorded as-is */ }
      bodies.push(body);
      try { onBody(body, res, bodies.length); } catch (e) {
        try { res.writeHead(500, { 'content-type': 'text/plain' }); res.end(String(e && e.message ? e.message : e)); } catch { /* gone */ }
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      bodies,
      url: `http://127.0.0.1:${server.address().port}`,
      close: () => new Promise((r) => server.close(() => r())),
    }));
  });
}

// Un endpoint che rifiuta ogni campo non in allowlist, come i provider strict veri.
function strictServer(allow) {
  const allowed = new Set(allow);
  return startServer((body, res) => {
    const unknown = Object.keys(body).filter((k) => !allowed.has(k));
    if (unknown.length) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `unknown field: ${unknown.join(', ')}`, type: 'invalid_request_error' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }], usage: { prompt_tokens: 10, completion_tokens: 2 } }));
  });
}

const jsonReply = (res, message, usage) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ choices: [{ message }], usage: usage || { prompt_tokens: 50, completion_tokens: 5 } }));
};
const sseReply = (res, frames) => {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
  for (const f of frames) res.write('data: ' + JSON.stringify(f) + '\n\n');
  res.write('data: [DONE]\n\n');
  res.end();
};
const delta = (d) => ({ choices: [{ index: 0, delta: d }] });
const finish = (r) => ({ choices: [{ index: 0, delta: {}, finish_reason: r }] });
const usageFrame = (p, c) => ({ choices: [], usage: { prompt_tokens: p, completion_tokens: c } });
const toolFrame = (name, args, id) => delta({
  role: 'assistant',
  tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
});
const toolMsg = (name, args, id, extra) => Object.assign(
  { role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] },
  extra || {},
);

function llmFor(profile, runtime = {}, sampling = {}) {
  return new LocalLLM({
    type: profile.type,
    capabilities: profile.capabilities,
    endpoint: { base_url: profile.base_url, model: profile.model || 'test-model', api_key: 'sk-test' },
    sampling: Object.assign({ temperature: 0.1, top_p: 0.9, max_tokens: 64 }, sampling),
    runtime: Object.assign({ retries: 0, request_timeout_ms: 5000, max_tool_iters: 4, max_tool_calls: 4 }, runtime),
  });
}
const capsOf = (p) => adapters.resolveAdapter(p).caps;
const tools = [{ type: 'function', function: { name: 'probe', description: 'probe', parameters: { type: 'object', properties: {} } } }];

// ── 1. la dichiarazione è vincolante PRIMA della richiesta ──────────────────
ok('un refuso in una capability è un errore, non un no-op', () => {
  const errs = adapters.validateCapabilities({ tool_call: 'native' });
  assert.strictEqual(errs.length, 1);
  assert.ok(/tool_call: unknown capability/.test(errs[0]), errs[0]);
});

ok('un tipo sconosciuto è rifiutato con l\'elenco dei tipi noti', () => {
  assert.throws(() => adapters.resolveCapabilities({ type: 'anthropic' }),
    (e) => e.code === 'type_unknown' && /deepseek/.test(e.message));
});

ok('ogni tipo dichiara solo ciò che il suo nome promette', () => {
  const bare = adapters.resolveCapabilities({ type: 'openai-compatible' });
  // `stream_options` è un campo dello standard OpenAI (il chunk di usage in streaming):
  // resta. Le estensioni di llama.cpp no.
  for (const k of ['grammar', 'timings', 'sampling_extras']) {
    assert.strictEqual(bare[k], false, `openai-compatible non deve accendere "${k}"`);
  }
  assert.strictEqual(bare.stream_options, true, 'lo usage chunk è parte del protocollo, non del vendor');
  const llama = adapters.resolveCapabilities({ type: 'llama-cpp' });
  for (const k of ['grammar', 'timings', 'stream_options', 'sampling_extras']) {
    assert.strictEqual(llama[k], true, `llama-cpp dichiara "${k}"`);
  }
  assert.strictEqual(llama.reasoning.param, 'none', 'nemmeno llama-cpp manda un thinking switch senza dichiararlo');
});

ok('live.loadConfig mappa i due rifiuti sui codici giusti, con il nome del profilo', () => {
  const dir = fixture('adapters-type');
  const file = path.join(dir, 'providers.json');
  const write = (profiles) => fs.writeFileSync(file, JSON.stringify({ version: 1, profiles }));
  write({ odd: { type: 'anthropic', base_url: 'http://127.0.0.1:1', model: 'm' } });
  assert.throws(() => live.loadConfig(file), (e) => e.code === 'config_invalid'
    && /profile "odd"/.test(e.message) && /llama-cpp/.test(e.message));
  write({ typo: { type: 'deepseek', base_url: 'http://127.0.0.1:1', model: 'm', capabilities: { strict_schema: true } } });
  assert.throws(() => live.loadConfig(file), (e) => e.code === 'capabilities_invalid'
    && /profile "typo"/.test(e.message) && /strict_schema/.test(e.message));
});

ok('reasoning.on/off senza param è un errore (una forma senza parametro non fa nulla)', () => {
  const errs = adapters.validateCapabilities({ reasoning: { off: { enable_thinking: false } } });
  assert.ok(errs.some((e) => /without a param/.test(e)), errs.join(' | '));
});

ok('live.loadConfig rifiuta un profilo con capability invalide, non lo ignora', () => {
  const dir = fixture('adapters-cfg');
  const file = path.join(dir, 'providers.json');
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    profiles: {
      broken: {
        type: 'deepseek',
        base_url: 'http://127.0.0.1:1',
        model: 'm',
        capabilities: { reasoning_echo_with_tool: true },
      },
    },
  }));
  assert.throws(() => live.loadConfig(file), (e) => e.code === 'capabilities_invalid'
    && /reasoning_echo_with_tool/.test(e.message));
});

// ── 2. il builder spedisce solo ciò che il profilo dichiara ─────────────────
ok('i campi extra partono solo se dichiarati (llama: sì, deepseek: no)', () => {
  const req = {
    model: 'm',
    messages: [{ role: 'user', content: 'hi' }],
    tools,
    grammar: 'root ::= "x"',
    sampling: { temperature: 0.2, top_p: 0.9, max_tokens: 32, top_k: 40 },
    runtime: { allow_thinking: false, timings_per_token: true, stream_usage: true },
    stream: true,
  };
  const llama = adapters.resolveAdapter(EXAMPLE.profiles.llama).buildRequest(req).body;
  // Con la grammatica attiva lo schema non viaggia (GBNF vincola il protocollo testuale):
  // gli altri campi dichiarati da llama-cpp invece sì.
  for (const k of ['grammar', 'top_k', 'timings_per_token', 'stream_options', 'chat_template_kwargs']) {
    assert.ok(k in llama, `profilo llama: "${k}" è dichiarato e deve partire`);
  }
  assert.ok(!('tools' in llama) && !('tool_choice' in llama), 'grammar e schema non convivono');
  const llamaTools = adapters.resolveAdapter(EXAMPLE.profiles.llama)
    .buildRequest({ ...req, grammar: null }).body;
  assert.ok('tools' in llamaTools && 'tool_choice' in llamaTools, 'senza grammatica lo schema parte');
  const ds = adapters.resolveAdapter(EXAMPLE.profiles.deepseek).buildRequest({ ...req, grammar: null }).body;
  for (const k of ['grammar', 'top_k', 'timings_per_token', 'stream_options', 'tool_choice',
    'parallel_tool_calls', 'chat_template_kwargs', 'reasoning_effort']) {
    assert.ok(!(k in ds), `profilo deepseek: "${k}" NON è dichiarato e non deve partire`);
  }
  assert.throws(() => adapters.resolveAdapter(EXAMPLE.profiles.deepseek).buildRequest(req),
    (e) => e.code === 'grammar_unsupported', 'deepseek non dichiara grammar: la richiesta è impossibile');
  assert.deepStrictEqual(ds.thinking, { type: 'disabled' }, 'thinking:false deve usare la forma dichiarata');
});

ok('reasoning: nessuna forma spedita quando il profilo non ne dichiara una', () => {
  const caps = adapters.resolveCapabilities({ type: 'openai-compatible' });
  const body = adapters.buildRequest({
    caps, model: 'm', messages: [], runtime: { allow_thinking: true },
  }).body;
  for (const k of adapters.REASONING_PARAMS.filter((p) => p !== 'none')) assert.ok(!(k in body), k);
});

ok('thinking undefined non tocca il default del server; on/off usano il payload dichiarato', () => {
  const caps = capsOf(EXAMPLE.profiles.deepseek);
  const base = { caps, model: 'm', messages: [] };
  assert.ok(!('thinking' in adapters.buildRequest(base).body), 'undefined = lascia il default');
  assert.deepStrictEqual(adapters.buildRequest({ ...base, runtime: { allow_thinking: true } }).body.thinking, { type: 'enabled' });
  assert.deepStrictEqual(adapters.buildRequest({ ...base, runtime: { allow_thinking: false } }).body.thinking, { type: 'disabled' });
});

ok('una grammatica su un profilo che non la dichiara è un ERRORE, non un downgrade', () => {
  // Il difetto: `tools: grammar ? null : tools` nel chiamante faceva sì che un profilo
  // senza GBNF ricevesse né grammatica né schema — il run perdeva il tool-calling in
  // silenzio. Ora l'adapter decide e rifiuta la combinazione impossibile.
  const caps = capsOf({ type: 'openai-compatible' });
  assert.throws(() => adapters.buildRequest({ caps, model: 'm', messages: [], tools, grammar: 'root ::= "x"' }),
    (e) => e.code === 'grammar_unsupported' && /does not declare "grammar"/.test(e.message));
  // E il chiamante non può più aggirarlo togliendo i tool: passa entrambi, decide l'adapter.
  const llm = new LocalLLM({
    type: 'openai-compatible',
    endpoint: { base_url: 'http://127.0.0.1:1', model: 'm', api_key: 'k' },
    sampling: {}, runtime: {},
  });
  assert.throws(() => llm._completionBody([{ role: 'user', content: 'go' }], tools, 'root ::= "x"'),
    (e) => e.code === 'grammar_unsupported');
  assert.doesNotThrow(() => llm._completionBody([{ role: 'user', content: 'go' }], tools, null),
    'senza grammatica lo schema nativo resta disponibile');
});

ok('grammatica dichiarata: parte la grammatica e lo schema resta fuori', () => {
  const caps = capsOf({ type: 'llama-cpp' });
  const body = adapters.buildRequest({ caps, model: 'm', messages: [], tools, grammar: 'root ::= "x"' }).body;
  assert.strictEqual(body.grammar, 'root ::= "x"');
  assert.ok(!('tools' in body), 'la GBNF vincola il protocollo testuale: nessuno schema insieme');
  const noGrammar = adapters.buildRequest({ caps, model: 'm', messages: [], tools }).body;
  assert.ok(Array.isArray(noGrammar.tools) && !('grammar' in noGrammar));
  // La stessa regola alimenta la contabilità dei token: una sola copia, non due.
  const llama = adapters.resolveAdapter({ type: 'llama-cpp' });
  assert.strictEqual(llama.offersSchema({ tools, grammar: 'root ::= "x"' }), false);
  assert.strictEqual(llama.offersSchema({ tools, grammar: null }), true);
  assert.strictEqual(adapters.resolveAdapter({ type: 'deepseek', capabilities: { tool_calls: 'text' } })
    .offersSchema({ tools, grammar: null }), false);
});

ok('tool_calls: "native" offre la schema, "text" no (e non manda tool_choice)', () => {
  const native = adapters.buildRequest({
    caps: capsOf({ type: 'deepseek', capabilities: { tool_choice: true } }),
    model: 'm', messages: [], tools,
  }).body;
  assert.ok(Array.isArray(native.tools) && native.tools.length === 1);
  assert.strictEqual(native.tool_choice, 'auto');

  const text = adapters.buildRequest({
    caps: capsOf({ type: 'openai-compatible', capabilities: { tool_calls: 'text' } }),
    model: 'm', messages: [], tools,
  }).body;
  assert.ok(!('tools' in text), 'profilo testuale: nessuna schema');
  assert.ok(!('tool_choice' in text));
});

ok('parallel_tool_calls parte solo se dichiarato (null = non spedire)', () => {
  const on = adapters.buildRequest({ caps: capsOf({ capabilities: { parallel_tool_calls: true } }), model: 'm', messages: [], tools }).body;
  const off = adapters.buildRequest({ caps: capsOf({ capabilities: { parallel_tool_calls: null } }), model: 'm', messages: [], tools }).body;
  assert.strictEqual(on.parallel_tool_calls, true);
  assert.ok(!('parallel_tool_calls' in off));
});

ok('strictCheck: un campo senza capability fa fallire, un body coperto passa', () => {
  const caps = capsOf(EXAMPLE.profiles.deepseek);
  assert.throws(() => adapters.strictCheck(caps, { model: 'm', messages: [], chat_template_kwargs: { enable_thinking: false } }),
    (e) => e.code === 'undeclared_field' && /chat_template_kwargs/.test(e.message));
  assert.doesNotThrow(() => adapters.strictCheck(caps, { model: 'm', messages: [], stream: false, temperature: 0.2 }));
  assert.doesNotThrow(() => adapters.strictCheck(capsOf({ type: 'openai-compatible' }), { chat_template_kwargs: {}, grammar: 'x' }),
    'un profilo non strict non fa asserzioni');
});

ok('strictCheck gata i tool: tool_choice e tools non sono campi "core"', () => {
  const noChoice = capsOf({ type: 'deepseek', capabilities: { tool_choice: false } });
  assert.throws(() => adapters.strictCheck(noChoice, { model: 'm', messages: [], tool_choice: 'required' }),
    (e) => e.code === 'undeclared_field' && /tool_choice/.test(e.message),
    'un profilo che non dichiara tool_choice non può riceverlo nemmeno dal controllo strict');
  const textOnly = capsOf({ type: 'deepseek', capabilities: { tool_calls: 'text' } });
  assert.throws(() => adapters.strictCheck(textOnly, { model: 'm', messages: [], tools: [] }),
    (e) => e.code === 'undeclared_field' && /\btools\b/.test(e.message));
  const both = capsOf({ type: 'deepseek', capabilities: { tool_choice: true } });
  assert.doesNotThrow(() => adapters.strictCheck(both, { model: 'm', messages: [], tools: [], tool_choice: 'auto' }),
    'dichiarati, passano');
});

ok('costo: dalla tabella dichiarata, mai inventato', () => {
  const caps = capsOf(EXAMPLE.profiles.deepseek);
  const cost = adapters.costOf(caps, { prompt_tokens: 1000, completion_tokens: 100 });
  assert.ok(Math.abs(cost - (1000 * 0.3 + 100 * 1.2) / 1e6) < 1e-12, String(cost));
  assert.strictEqual(adapters.costOf(capsOf({ type: 'openai-compatible' }), { prompt_tokens: 1000 }), null);
});

// ── 3. contro un endpoint strict vero (HTTP 400) ────────────────────────────
later('runAgent: una grammatica non dichiarata fallisce prima di ogni richiesta (e non si "recupera")', async () => {
  // Il difetto da evitare è doppio: il chiamante non deve poter togliere i tool, e il
  // fallback "il server ha rifiutato la grammatica" non deve inghiottire l'errore del
  // contratto (il messaggio contiene la parola "grammar").
  const real = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return { ok: true, json: async () => ({ choices: [{ message: { content: 'x' } }] }) }; };
  try {
    const llm = new LocalLLM({
      type: 'openai-compatible',
      endpoint: { base_url: 'http://127.0.0.1:9/v1', model: 'm', api_key: 'k' },
      sampling: { max_tokens: 32 },
      runtime: { use_grammar: true, retries: 0 },
    });
    await assert.rejects(
      () => llm.runAgent({ system: 's', task: 't', tools, dispatch: async () => 'x', grammar: 'root ::= "x"' }),
      (e) => e.code === 'grammar_unsupported',
      'la combinazione impossibile deve arrivare al chiamante',
    );
    assert.strictEqual(calls, 0, 'nessuna richiesta deve partire (né con grammatica né senza)');
  } finally { globalThis.fetch = real; }
});

later('endpoint strict: il profilo llama viene rifiutato, il profilo deepseek passa', async () => {
  const srv = await strictServer(['model', 'messages', 'stream', 'temperature', 'top_p', 'max_tokens', 'tools', 'thinking']);
  try {
    const llama = llmFor({ type: 'llama-cpp', capabilities: EXAMPLE.profiles.llama.capabilities, base_url: srv.url, model: 'm' },
      { timings_per_token: true, stream_usage: true, allow_thinking: false }, { top_k: 40 });
    await assert.rejects(
      () => llama.runAgent({ system: 's', task: 't', tools, dispatch: async () => 'x' }),
      (e) => /HTTP 400/.test(e.message) && /unknown field/.test(e.message),
      'un campo non dichiarato dal server deve produrre un 400 visibile, non un fallimento muto',
    );
    const rejected = srv.bodies[srv.bodies.length - 1];
    for (const k of ['chat_template_kwargs', 'top_k']) {
      assert.ok(k in rejected, `il profilo llama dichiara "${k}": deve partire (ed essere rifiutato)`);
    }

    const ds = llmFor({ type: 'deepseek', capabilities: EXAMPLE.profiles.deepseek.capabilities, base_url: srv.url, model: 'm' },
      { timings_per_token: true, stream_usage: true }, { top_k: 40 });
    const res = await ds.runAgent({ system: 's', task: 't', tools, dispatch: async () => 'x', grammar: 'root ::= "x"' });
    assert.strictEqual(res.text, 'ok');
    const accepted = srv.bodies[srv.bodies.length - 1];
    for (const k of ['chat_template_kwargs', 'grammar', 'timings_per_token', 'top_k', 'stream_options', 'tool_choice']) {
      assert.ok(!(k in accepted), `deepseek non deve spedire "${k}"`);
    }
    assert.ok(Array.isArray(accepted.tools), 'i tool nativi sono dichiarati e devono partire');
  } finally { await srv.close(); }
});

// ── 4. reasoning: round-trip, campo sbagliato, assenza ──────────────────────
async function reasoningTurn(profile, reply) {
  const srv = await startServer((body, res, n) => {
    if (n === 1) jsonReply(res, reply);
    else jsonReply(res, { role: 'assistant', content: 'FINAL: done' });
  });
  try {
    const llm = llmFor(Object.assign({}, profile, { base_url: srv.url }));
    const seen = [];
    const res = await llm.runAgent({ system: 's', task: 't', tools, dispatch: async (n, a) => { seen.push([n, a]); return 'OUT'; } });
    const assistant = (srv.bodies[1] || { messages: [] }).messages.find((m) => m.role === 'assistant' && m.tool_calls);
    return { res, seen, assistant, bodies: srv.bodies };
  } finally { await srv.close(); }
}

later('reasoning: echoed nel campo dichiarato quando il profilo lo richiede', async () => {
  const { res, seen, assistant } = await reasoningTurn(EXAMPLE.profiles.deepseek, toolMsg('probe', { a: 1 }, 'c1', { reasoning_content: 'THINK-1' }));
  assert.strictEqual(res.text, 'done');
  assert.deepStrictEqual(seen, [['probe', { a: 1 }]]);
  assert.strictEqual(assistant.reasoning_content, 'THINK-1');
  assert.ok(!('reasoning' in assistant), 'solo il campo dichiarato viene scritto');
});

later('reasoning: NON echoed quando il profilo non lo richiede', async () => {
  const { assistant } = await reasoningTurn({ type: 'openai-compatible' }, toolMsg('probe', { a: 1 }, 'c1', { reasoning_content: 'THINK-1' }));
  assert.ok(!('reasoning_content' in assistant));
  assert.ok(!('reasoning' in assistant));
});

later('reasoning: arriva sotto l\'altro nome -> viene letto e riscritto nel campo dichiarato', async () => {
  const { assistant } = await reasoningTurn(EXAMPLE.profiles.deepseek, toolMsg('probe', { a: 1 }, 'c1', { reasoning: 'ALT-NAME' }));
  assert.strictEqual(assistant.reasoning_content, 'ALT-NAME', 'lettura tollerante, scrittura no');
  assert.ok(!('reasoning' in assistant));
});

later('reasoning: assente -> nessun campo vuoto aggiunto, il turno prosegue', async () => {
  const { res, assistant } = await reasoningTurn(EXAMPLE.profiles.deepseek, toolMsg('probe', { a: 1 }, 'c1'));
  assert.strictEqual(res.text, 'done');
  assert.ok(!('reasoning_content' in assistant), 'non si scrive un campo vuoto');
});

later('reasoning: streaming in un campo separato non rompe il contenuto', async () => {
  const srv = await startServer((body, res, n) => {
    if (n === 1) {
      sseReply(res, [
        delta({ role: 'assistant', reasoning_content: 'stream-think ' }),
        toolFrame('probe', { a: 1 }, 'c1'),
        finish('tool_calls'),
        usageFrame(80, 10),
      ]);
    } else {
      sseReply(res, [delta({ content: 'FINAL: streamed' }), finish('stop'), usageFrame(90, 12)]);
    }
  });
  try {
    const llm = llmFor(Object.assign({}, EXAMPLE.profiles.deepseek, { base_url: srv.url }));
    const think = [];
    const res = await llm.runAgent({
      system: 's', task: 't', tools, dispatch: async () => 'OUT', stream: true,
      onThinkingDelta: (t) => think.push(t),
    });
    assert.strictEqual(res.text, 'streamed');
    assert.strictEqual(think.join(''), 'stream-think ');
    const assistant = srv.bodies[1].messages.find((m) => m.role === 'assistant' && m.tool_calls);
    assert.strictEqual(assistant.reasoning_content, 'stream-think ');
  } finally { await srv.close(); }
});

// ── 5. tool_calls: nativi dichiarati, testo quando il profilo è testuale ────
later('tool_calls testuali: nessuna schema nel body e ACTION: parsato', async () => {
  const srv = await startServer((body, res, n) => {
    if (n === 1) jsonReply(res, { role: 'assistant', content: 'ACTION: {"tool":"probe","args":{"a":1}}' });
    else jsonReply(res, { role: 'assistant', content: 'FINAL: text-path done' });
  });
  try {
    const llm = llmFor({ type: 'openai-compatible', capabilities: { tool_calls: 'text' }, base_url: srv.url });
    const seen = [];
    const res = await llm.runAgent({ system: 's', task: 't', tools, dispatch: async (n, a) => { seen.push([n, a]); return 'OUT'; } });
    assert.strictEqual(res.text, 'text-path done');
    assert.deepStrictEqual(seen, [['probe', { a: 1 }]], 'il protocollo testuale deve essere attivo per un profilo text');
    for (const b of srv.bodies) assert.ok(!('tools' in b), 'un profilo testuale non deve ricevere la schema');
  } finally { await srv.close(); }
});

// ── 6. il profilo DeepSeek SPEDITO, end-to-end attraverso runtime/live.js ───
later('live + profilo deepseek spedito: schema reale, reasoning echoed, costo dai prezzi dichiarati', async () => {
  const dir = fixture('adapters-live');
  const sessions = path.join(dir, 'sessions');
  const prev = { sessions: process.env.CYBOROS_AGENT_DIR, approvals: process.env.CYBOROS_APPROVALS_FILE };
  process.env.CYBOROS_AGENT_DIR = sessions;
  process.env.CYBOROS_APPROVALS_FILE = path.join(dir, 'approvals.jsonl');

  // L'endpoint finto impone la regola che il profilo dichiara: con i tool in gioco, il
  // reasoning dei turni precedenti deve tornare indietro. Se il builder smettesse di
  // farlo, questo server risponde 400 e il run fallisce — come farebbe DeepSeek.
  const srv = await startServer((body, res, n) => {
    const priorToolCall = (body.messages || []).find((m) => m.role === 'assistant' && Array.isArray(m.tool_calls));
    if (priorToolCall && !priorToolCall.reasoning_content) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'reasoning_content is required on assistant tool-call messages' } }));
      return;
    }
    if (n === 1) {
      sseReply(res, [
        delta({ role: 'assistant', reasoning_content: 'The operator named a host; check it in scope. ' }),
        toolFrame('scope_check', { target: '127.0.0.1' }, 'call_1'),
        finish('tool_calls'),
        usageFrame(1200, 40),
      ]);
    } else {
      sseReply(res, [delta({ content: 'FINAL: 127.0.0.1 is in scope.' }), finish('stop'), usageFrame(1400, 30)]);
    }
  });

  try {
    const profile = JSON.parse(JSON.stringify(EXAMPLE.profiles.deepseek));
    profile.base_url = srv.url;
    profile.egress = 'local';
    delete profile.api_key_env;
    const configFile = path.join(dir, 'providers.json');
    fs.writeFileSync(configFile, JSON.stringify({ version: 1, default_profile: 'deepseek', allow_cloud: false, profiles: { deepseek: profile } }));

    const dispatched = [];
    const api = live.createLive({
      configPath: configFile,
      target: '127.0.0.1',
      allowCloud: false,
      baseDispatch: async (name, args) => { dispatched.push([name, args]); return 'OK'; },
    });
    const res = await api.run('check the host I named');

    assert.ok(/in scope/.test(res.text), res.text);
    assert.deepStrictEqual(dispatched, [['scope_check', { target: '127.0.0.1' }]]);

    // Il body che è realmente partito.
    const first = srv.bodies[0];
    for (const k of ['chat_template_kwargs', 'grammar', 'timings_per_token', 'top_k',
      'tool_choice', 'stream_options', 'parallel_tool_calls']) {
      assert.ok(!(k in first), `"${k}" non è dichiarato dal profilo e non deve partire`);
    }
    assert.ok(!('thinking' in first), 'nessun on/off dichiarato dal runtime: il default del server resta intatto');
    assert.ok(Array.isArray(first.tools) && first.tools.length > 1, 'native tools dichiarati, schema offerta');
    assert.strictEqual(first.model, EXAMPLE.profiles.deepseek.model);

    // L'echo del reasoning viaggia nel secondo request, nel campo dichiarato.
    const echoed = srv.bodies[1].messages.find((m) => m.role === 'assistant' && Array.isArray(m.tool_calls));
    assert.strictEqual(echoed.reasoning_content, 'The operator named a host; check it in scope. ');

    // La finestra del profilo dimensiona il budget, non il default.
    const cs = api.contextStats();
    assert.strictEqual(cs.source, 'window');
    assert.strictEqual(cs.window, EXAMPLE.profiles.deepseek.capabilities.context_window_tokens);
    assert.strictEqual(cs.reserved, EXAMPLE.profiles.deepseek.capabilities.reserved_output_tokens);
    assert.strictEqual(cs.budget, cs.window - cs.reserved - EXAMPLE.profiles.deepseek.capabilities.context_safety_tokens);

    // Cosa il profilo dichiara, risolto dalla stessa funzione che usa la UI.
    const caps = live.capabilitiesFor(EXAMPLE.profiles.deepseek);
    assert.strictEqual(caps.type, 'deepseek');
    assert.strictEqual(caps.tool_calls, 'native');
    assert.strictEqual(caps.reasoning_field, 'reasoning_content');
    assert.strictEqual(caps.strict_unknown_fields, true);
    assert.ok(/^deepseek · native tools · thinking via thinking/.test(caps.summary), caps.summary);

    // Il costo viene dalla tabella dichiarata, non da un numero inventato.
    const usage = api.usage();
    assert.strictEqual(usage.tokens_in, 2600);
    assert.strictEqual(usage.tokens_out, 70);
    const expected = (1200 * 0.3 + 40 * 1.2 + 1400 * 0.3 + 30 * 1.2) / 1e6;
    // The rollup keeps the amount bucketed by where the price came from (runtime/usage.js),
    // so the total is read through the one calculator rather than a flat field.
    const view = require('../runtime/usage').costView(usage);
    assert.ok(Math.abs(view.amount - expected) < 1e-12, `${view.amount} vs ${expected}`);
    assert.deepStrictEqual(view.sources, ['declared prices'], 'the profile table is what priced it');

    // Il log di sessione dice la stessa cosa del processo.
    const session = api.session;
    const events = fs.readFileSync(path.join(session.dir, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const calls = events.filter((e) => e.type === 'provider_call');
    assert.strictEqual(calls.length, 2);
    assert.ok(Math.abs(calls[1].usage.cost - (1400 * 0.3 + 30 * 1.2) / 1e6) < 1e-12);
    api.finish();
  } finally {
    await srv.close();
    if (prev.sessions === undefined) delete process.env.CYBOROS_AGENT_DIR; else process.env.CYBOROS_AGENT_DIR = prev.sessions;
    if (prev.approvals === undefined) delete process.env.CYBOROS_APPROVALS_FILE; else process.env.CYBOROS_APPROVALS_FILE = prev.approvals;
  }
});

(async () => {
  for (const [name, fn] of queue) await okAsync(name, fn);
  summary('test-adapters');
})();
