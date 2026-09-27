// local/test-loop-guard.js — test OFFLINE della loop-guard in local/llm.js (zero dipendenze).
// Simula un server llama.cpp finto che risponde secondo uno script predefinito: verifica la
// guardia senza modello né GPU. Copre i 3 scenari che DRY non può fermare:
//   1) ripetizione IDENTICA di tool+args tra turni separati -> avviso, poi correzione forzata
//   2) varianti quasi-identiche (typo-hunting) -> riconosciute dal fuzzy match
//   3) tool DIVERSI su target simili -> NON bloccati (fuzzy solo a parità di tool)
// Uso: node local/test-loop-guard.js   (exit 0 = tutti passati)

'use strict';
const assert = require('node:assert');
const { LocalLLM } = require('./llm.js');

// ---- finto server: risponde da uno script predefinito --------------------------------------
function makeFakeServer(script) {
  const calls = []; // log delle (tool, args) effettivamente DISPATCHATE (eseguite davvero)
  let step = 0;
  const fetchMock = async (url, opts) => {
    const respond = (content, extra = {}) => ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { role: 'assistant', content, ...extra }, finish_reason: 'stop' }],
      }),
      text: async () => '',
    });
    const move = script[Math.min(step, script.length - 1)];
    step++;
    if (move.kind === 'tool') {
      const tc = { id: `call_${step}`, type: 'function', function: { name: move.tool, arguments: JSON.stringify(move.args) } };
      return respond('', { tool_calls: [tc] });
    }
    return respond(move.text ?? 'FINAL: fatto');
  };
  return {
    fetchMock,
    calls,
    countDispatched: (tool) => calls.filter((c) => c.tool === tool).length,
  };
}

const baseCfg = () => ({
  endpoint: { base_url: 'http://127.0.0.1:8080/v1', api_key: 'x', model: 'fake' },
  sampling: { temperature: 0.4, top_p: 0.9, max_tokens: 64 },
  runtime: {
    max_tool_iters: 12,
    use_grammar: false,
    native_tools: true,
    tool_output_clip_chars: 4000,
    loop_guard: { max_repeats: 1, fuzzy: true, fuzzy_threshold: 0.82 },
  },
});

const makeDispatch = (server) => async (tool, args) => {
  server.calls.push({ tool, args });
  return `output di ${tool} ${JSON.stringify(args)}`;
};

(async () => {
  let passed = 0;

  // ---- TEST 1: ripetizione identica -> 1ª exec, poi avviso, poi correzione forzata, FINAL ----
  {
    const server = makeFakeServer([
      { kind: 'tool', tool: 'http_get', args: { url: 'http://10.0.0.5/admin' } },
      { kind: 'tool', tool: 'http_get', args: { url: 'http://10.0.0.5/admin' } }, // ripetizione
      { kind: 'tool', tool: 'http_get', args: { url: 'http://10.0.0.5/admin' } }, // loop confermato
      { kind: 'final', text: 'FINAL: la pagina admin risponde 200' },
    ]);
    globalThis.fetch = server.fetchMock;
    const llm = new LocalLLM(baseCfg());
    const res = await llm.runAgent({ task: 'test', dispatch: makeDispatch(server) });
    assert.strictEqual(server.countDispatched('http_get'), 1, 'il tool non deve essere eseguito più di una volta');
    assert.ok(res.text.includes('la pagina admin'), 'deve concludere con FINAL dopo la correzione');
    passed++;
    console.log('PASS 1: ripetizione identica bloccata (1 exec sola, avviso, correzione, FINAL)');
  }

  // ---- TEST 2: typo-hunting (varianti quasi-identiche) -> bloccate dal fuzzy match ----
  {
    const server = makeFakeServer([
      { kind: 'tool', tool: 'file_read', args: { path: '/etc/passwd' } },
      { kind: 'tool', tool: 'file_read', args: { path: '/etc/passwdd' } },  // typo variante
      { kind: 'tool', tool: 'file_read', args: { path: '/etc/paswwd' } },   // altra variante
      { kind: 'final', text: 'FINAL: done' },
    ]);
    globalThis.fetch = server.fetchMock;
    const llm = new LocalLLM(baseCfg());
    const res = await llm.runAgent({ task: 'test', dispatch: makeDispatch(server) });
    assert.strictEqual(server.countDispatched('file_read'), 1, 'le varianti typo devono essere bloccate: file_read eseguito una sola volta');
    assert.ok(res.text.includes('done'), 'deve comunque concludere');
    passed++;
    console.log('PASS 2: typo-hunting bloccato dal fuzzy match');
  }

  // ---- TEST 3: tool DIVERSI su target simili -> NON bloccati ----
  {
    const server = makeFakeServer([
      { kind: 'tool', tool: 'http_get', args: { url: 'http://10.0.0.5/admin' } },
      { kind: 'tool', tool: 'dir_bust', args: { url: 'http://10.0.0.5/admin', wordlist: 'common.txt' } },
      { kind: 'final', text: 'FINAL: trovata /backup' },
    ]);
    globalThis.fetch = server.fetchMock;
    const llm = new LocalLLM(baseCfg());
    await llm.runAgent({ task: 'test', dispatch: makeDispatch(server) });
    assert.strictEqual(server.countDispatched('http_get'), 1);
    assert.strictEqual(server.countDispatched('dir_bust'), 1, 'un tool diverso non va bloccato anche se target simile');
    passed++;
    console.log('PASS 3: tool diversi su target simili lasciati passare');
  }

  console.log(`\n${passed}/3 test passati.`);
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
