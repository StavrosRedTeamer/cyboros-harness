#!/usr/bin/env node
// Zero-dependency OFFLINE test for the `onTrace` observation hook in local/llm.js.
//
// Why this exists: `--watch` was added so a benchmark run can be followed in a second
// terminal while it happens. The property that makes it safe to benchmark with is that
// it is PURELY OBSERVATIONAL -- it must not change what the model is asked, which tools
// run, or how the loop terminates. A `--watch` run and a plain run have to be
// comparable, otherwise the numbers you publish measure a different harness.
//
// No network, no model, no real dispatch: the LLM is stubbed at the _post level.
//
// Run: node tools/test-local-watch.js

'use strict';
const assert = require('assert');
const path = require('path');

const { LocalLLM } = require(path.join(__dirname, '..', 'local', 'llm.js'));

let failures = 0;
function ok(name, cond, extra) {
  if (cond) console.log('  PASS ' + name);
  else { failures++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')); }
}

// ── stub: same scripted conversation, with and without onTrace ──────────────
function makeLlm(script, runtime) {
  const llm = new LocalLLM({ endpoint: { base_url: 'http://127.0.0.1:1/v1', api_key: 'x' }, sampling: {}, runtime: runtime || {} });
  let i = 0;
  llm._post = async () => {
    const s = script[i++] || script[script.length - 1];
    return { choices: [{ message: s }] };
  };
  return llm;
}
const callTool = (name, args) => ({ tool_calls: [{ id: 'c' + Math.random().toString(36).slice(2, 8), function: { name, arguments: JSON.stringify(args) } }] });
const textReply = (t) => ({ content: t });

const dispatched = [];
const dispatch = async (tool, args) => { dispatched.push([tool, JSON.stringify(args)]); return 'OUTPUT_OF_' + tool; };
const system = 'sys';
const task = 'do the thing';

async function run(withTrace) {
  const llm = makeLlm([
    // A plain text reply carrying neither tool_calls nor an ACTION: line ends the loop.
    // So a multi-turn script must be tool, tool, ..., FINAL. Three tool turns, then
    // the close: model/tool x3, then model/final.
    callTool('scope_check', { host: 'h' }),
    callTool('run_tool', { bin: 'curl', args: '-s x' }),
    callTool('record_finding', { id: 'f1' }),
    textReply('FINAL: tutto bene'),
  ]);
  const seen = [];
  const res = await llm.runAgent({
    system, task, tools: [{ type: 'function' }], dispatch, grammar: null,
    onTrace: withTrace ? (ev) => seen.push(ev) : undefined,
  });
  return { seen, res, llm };
}

async function main() {
  console.log('test-local-watch: onTrace hook (offline)');

  const plain = await run(false);
  const traced = await run(true);

  // 1) the hook is additive: identical result with and without it
  ok('final text identical with and without onTrace',
    plain.res.text === traced.res.text, JSON.stringify([plain.res.text, traced.res.text]));
  ok('final text is the stripped FINAL body', plain.res.text === 'tutto bene', plain.res.text);

  // 2) one 'model' event per turn, carrying that turn's text
  const modelEvents = traced.seen.filter((e) => e.type === 'model');
  ok('one model event per turn (4)', modelEvents.length === 4, 'got ' + modelEvents.length);
  ok('model events carry the assistant text (tool turns are empty, close carries FINAL)',
    modelEvents[0].text === '' && modelEvents[1].text === '' &&
    modelEvents[2].text === '' && modelEvents[3].text === 'FINAL: tutto bene');

  // 3) one 'tool' event per dispatched tool, with the tool OUTPUT (the whole point:
  //    seeing why a finding was not found means seeing what the tool actually returned)
  const toolEvents = traced.seen.filter((e) => e.type === 'tool');
  ok('one tool event per dispatch (3)', toolEvents.length === 3, 'got ' + toolEvents.length);
  ok('tool event carries name, args and output',
    toolEvents[0].tool === 'scope_check' &&
    toolEvents[0].out === 'OUTPUT_OF_scope_check' &&
    toolEvents[0].args.host === 'h');
  ok('tool events in dispatch order',
    toolEvents.map((e) => e.tool).join(',') === 'scope_check,run_tool,record_finding',
    toolEvents.map((e) => e.tool).join(','));

  // 4) a 'final' event closes the trace
  const finals = traced.seen.filter((e) => e.type === 'final');
  ok('exactly one final event', finals.length === 1, 'got ' + finals.length);
  ok('final event text is already stripped', finals[0].text === 'tutto bene', finals[0].text);

  // 5) ordering: model/tool x3, then model/final
  const order = traced.seen.map((e) => e.type).join(',');
  ok('events are emitted in loop order',
    order === 'model,tool,model,tool,model,tool,model,final', order);

  // 6) no hook => no events, and the loop is untouched (this is what makes --watch
  //    safe: you can enable it on one invocation and compare against a plain one)
  ok('no onTrace => zero events', (await run(false)).seen.length === 0);

  // 7) text-protocol path also traced (models that ignore native tool calls)
  // text_protocol_fallback must be on, otherwise the model has no way to ask for a tool
  // without native tool calling and the loop just ends on its first text reply.
  const llm2 = makeLlm([
    textReply('ACTION: {"tool":"scope_check","args":{"host":"h"}}'),
    textReply('FINAL: via testo'),
  ], { text_protocol_fallback: true });
  const seen2 = [];
  const r2 = await llm2.runAgent({
    system, task, tools: [{ type: 'function' }], dispatch, grammar: null,
    onTrace: (ev) => seen2.push(ev),
  });
  const t2 = seen2.filter((e) => e.type === 'tool');
  ok('text-protocol dispatch is traced with viaText', t2.length === 1 && t2[0].viaText === true);
  ok('text-protocol final is captured', r2.text === 'via testo', r2.text);

  console.log(failures ? '\n' + failures + ' FAILURES' : '\nALL PASS');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error('test crashed: ' + e.stack); process.exit(2); });
