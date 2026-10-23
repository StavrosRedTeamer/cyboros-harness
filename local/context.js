// local/context.js — token-accurate, structure-preserving context management.
//
// Why this file exists
// --------------------
// The previous trimmer (`trimContext` in llm.js) dropped WHOLE messages against a
// CHARACTER budget and counted only `m.content`. Two defects were measured on
// 2026-10-22, both reproducible:
//
//   1. It could keep a `tool` message while dropping the assistant message that
//      declared its `tool_calls`. That sequence is invalid on any strict
//      OpenAI-compatible API ("messages with role 'tool' must be a response to a
//      preceding message with 'tool_calls'") -> HTTP 400, the turn dies, and `_post`
//      then retried the 400 twice because it treats every failure as transient.
//   2. It never looked at `tool_calls[].function.arguments`, so a 200 KB argument
//      blob contributed 24 characters to the budget. The context could overflow
//      while the accounting said it fit.
//
// The fix is not a better heuristic, it is a different unit of work: a tool exchange
// (assistant `tool_calls` plus the `tool` results that answer them) is ATOMIC. It is
// counted as one block, kept as one block and dropped as one block, so compaction
// cannot produce an invalid list by construction. On top of that, `prepare()`
// re-validates the output at the send boundary: even a caller that hands this module
// an already-broken history cannot ship one to a provider.
//
// What survives compaction
// ------------------------
// Losing the target map mid-engagement is the real-world failure; the overflow is
// only what reveals it. So the system message — which carries the engagement
// contract and the target — is never dropped, and everything that IS dropped is
// replaced by a *state digest* extracted verbatim from the transcript: hosts touched,
// artifacts written, findings recorded, actions taken. Never a model paraphrase, so
// the digest cannot invent evidence and cannot overrule the operator.

'use strict';

// ---- accounting ------------------------------------------------------------

const MIN_BUDGET_TOKENS = 256;
const DEFAULT_BUDGET_TOKENS = 8192;
const DEFAULT_RESERVED_OUTPUT = 2048;
const DEFAULT_SAFETY_TOKENS = 1024;
const ROLE_OVERHEAD = 4;      // per-message framing (`<|role|>`, separators)
const TOOL_CALL_OVERHEAD = 8; // per-call framing (id, type, name, json delimiters)

// Heuristic token estimate, deliberately CONSERVATIVE (over-counts). There is no
// tokenizer here because the harness has no dependencies and the provider does not
// expose one; the estimator is calibrated against the provider's own `prompt_tokens`
// (see ContextManager#calibrate), which is what turns an estimate into a measurement.
//
// Two corrections over `chars / 4`, both measured against how this harness actually
// talks to a model:
//   · punctuation-dense text (JSON, URLs, HTTP headers, hex, payloads) tokenizes
//     worse than prose: 4.0 chars/token becomes as low as 2.5 as the ratio rises;
//   · CJK is roughly one token per character, never four.
function estimateTokens(text) {
  if (Array.isArray(text)) return estimateTokens(JSON.stringify(text));
  const s = text == null ? '' : String(text);
  if (!s) return 0;
  let cjk = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    // CJK ideographs, kana, hangul, fullwidth forms.
    if ((cp >= 0x2e80 && cp <= 0x9fff) || (cp >= 0xac00 && cp <= 0xd7af) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xff00 && cp <= 0xffef)) cjk++;
  }
  const total = s.length;
  const latin = total - cjk;
  const punct = (s.match(/[^\w\s]/g) || []).length;
  const punctRatio = total ? punct / total : 0;
  const charsPerToken = 4.0 - Math.min(1.5, punctRatio * 3.0);
  return Math.ceil((latin / charsPerToken + cjk) * 1.1);
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Everything that is actually sent for one message, including the payloads the old
// accounting ignored. This is the function that makes defect #2 impossible.
function messageTokens(m) {
  if (!m || typeof m !== 'object') return 0;
  let t = ROLE_OVERHEAD + estimateTokens(m.content);
  // Reasoning is echoed back on tool-using turns for the providers that require it
  // (`reasoning_echo_with_tools`), so it ships on every later request. Uncounted, a
  // thinking model's echoed reasoning would silently push the real prompt past the budget.
  if (m.reasoning_content) t += estimateTokens(m.reasoning_content);
  if (m.reasoning) t += estimateTokens(m.reasoning);
  if (m.name) t += estimateTokens(m.name);
  if (m.tool_call_id) t += ROLE_OVERHEAD + estimateTokens(m.tool_call_id);
  if (Array.isArray(m.tool_calls)) {
    for (const tc of m.tool_calls) {
      if (!tc || typeof tc !== 'object') continue;
      t += TOOL_CALL_OVERHEAD;
      t += estimateTokens(tc.id);
      t += estimateTokens(tc.type);
      const fn = tc.function || {};
      t += estimateTokens(fn.name);
      t += estimateTokens(fn.arguments);
    }
  }
  return t;
}

function conversationTokens(messages, scale) {
  const k = num(scale) || 1;
  let total = 0;
  for (const m of Array.isArray(messages) ? messages : []) total += messageTokens(m);
  return Math.ceil(total * k);
}

// ---- structural validity ---------------------------------------------------

// Returns the list of reasons a message list would be rejected by a strict
// OpenAI-compatible provider. Empty array = sendable.
function validate(messages) {
  const problems = [];
  const list = Array.isArray(messages) ? messages : [];
  const pending = new Set();   // tool_call ids awaiting a result
  for (let i = 0; i < list.length; i++) {
    const m = list[i];
    if (!m || typeof m !== 'object') { problems.push(`#${i}: not an object`); continue; }
    if (m.role === 'tool') {
      if (!m.tool_call_id) problems.push(`#${i}: tool message without tool_call_id`);
      else if (!pending.has(m.tool_call_id)) {
        problems.push(`#${i}: tool message ${m.tool_call_id} does not answer a preceding assistant tool_calls`);
      } else pending.delete(m.tool_call_id);
      continue;
    }
    if (pending.size) {
      problems.push(`#${i}: ${pending.size} tool_call(s) answered by nothing: ${[...pending].join(',')}`);
      pending.clear();
    }
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const ids = new Set();
      for (const tc of m.tool_calls) {
        const id = tc && tc.id;
        if (!id) { problems.push(`#${i}: tool_call without id`); continue; }
        if (ids.has(id)) problems.push(`#${i}: duplicate tool_call id ${id}`);
        ids.add(id);
        pending.add(id);
      }
    }
  }
  if (pending.size) problems.push(`end: ${pending.size} tool_call(s) answered by nothing: ${[...pending].join(',')}`);
  return problems;
}

function isSendable(messages) {
  return validate(messages).length === 0;
}

// ---- blocking --------------------------------------------------------------
// A block is the unit that compaction may keep or drop. Only an exchange is
// multi-message; every other block is exactly one message.

function splitBlocks(messages) {
  const system = [];
  const blocks = [];
  const repairs = [];
  const list = Array.isArray(messages) ? messages : [];
  let i = 0;
  while (i < list.length) {
    const m = list[i];
    if (!m || typeof m !== 'object') { repairs.push({ reason: 'not-an-object', at: i }); i++; continue; }
    // System messages are hoisted and never dropped: they carry the engagement
    // contract and the target. A system message mid-history is legal but useless
    // where it sits, so moving it to the front changes nothing semantically.
    if (m.role === 'system') { system.push(m); i++; continue; }
    if (m.role === 'tool') {
      // An orphan result is unanswerable evidence: keep nothing from it.
      repairs.push({ reason: 'orphan-tool-result', at: i, tool_call_id: m.tool_call_id || null });
      i++; continue;
    }
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const ids = m.tool_calls.map((tc) => tc && tc.id).filter(Boolean);
      if (ids.length !== m.tool_calls.length) {
        repairs.push({ reason: 'tool-call-without-id', at: i });
        i++; continue;
      }
      const wanted = new Set(ids);
      const answered = new Set();
      const group = [m];
      let j = i + 1;
      while (j < list.length && list[j] && list[j].role === 'tool') {
        const id = list[j].tool_call_id;
        if (wanted.has(id) && !answered.has(id)) { group.push(list[j]); answered.add(id); }
        else repairs.push({ reason: 'unmatched-tool-result', at: j, tool_call_id: id || null });
        j++;
      }
      if (answered.size !== wanted.size) {
        // A call with no recorded result is not a turn that happened: dropping the
        // half-exchange is the only way to keep both the transcript valid and the
        // evidence honest.
        repairs.push({ reason: 'unanswered-tool-call', at: i, missing: [...wanted].filter((id) => !answered.has(id)) });
      } else {
        blocks.push({ kind: 'exchange', messages: group });
      }
      i = j;
      continue;
    }
    if (m.role === 'assistant' && !String(m.content == null ? '' : m.content).trim()) {
      repairs.push({ reason: 'empty-assistant', at: i });
      i++; continue;
    }
    blocks.push({ kind: m.role === 'user' ? 'user' : 'assistant', messages: [m] });
    i++;
  }
  return { system, blocks, repairs };
}

function blockTokens(block, scale) {
  const k = num(scale) || 1;
  let t = 0;
  for (const m of block.messages) t += messageTokens(m);
  return Math.ceil(t * k);
}

// ---- shrinking a single oversized message ----------------------------------
// Only used when the block that must survive does not fit at all. A tool exchange is
// never shrunk (clipping tool_calls arguments would hand the provider invalid JSON
// inside the history), it is dropped and digested instead.

const CLIP_MARK = (n) => `\n…[compacted: ${n} chars dropped to fit the context budget]`;

function clipMessageToTokens(m, maxTokens, scale) {
  const k = num(scale) || 1;
  if (maxTokens <= 0) return null;
  // Work in scaled units so that a calibrated estimator clips to the real budget, not
  // to the pre-calibration guess it started from.
  const fixed = (messageTokens(m) - estimateTokens(m.content)) * k;
  const markerRoom = estimateTokens(CLIP_MARK(String(m.content ? String(m.content).length : 0))) * k;
  const room = (maxTokens - fixed - markerRoom) / k;
  if (room <= 0) return null;
  const text = String(m.content == null ? '' : m.content);
  if (estimateTokens(text) <= room) return m;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (estimateTokens(text.slice(0, mid)) <= room) lo = mid; else hi = mid - 1;
  }
  return { ...m, content: text.slice(0, lo) + CLIP_MARK(String(text.length - lo)) };
}

// ---- state digest ----------------------------------------------------------
// Deterministic extraction from the transcript. No model call, no paraphrase: every
// line is a fact that was already in a message header or argument.

const HOST_LIKE = /^(?:[a-z][a-z0-9+.-]*:\/\/)?[a-z0-9][a-z0-9.-]*\.[a-z]{2,}(?::\d+)?/i;

function pushUnique(arr, value, limit) {
  const v = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  if (!v) return;
  if (arr.includes(v)) return;
  if (arr.length >= limit) return;
  arr.push(v.slice(0, 160));
}

// The caps live here, next to the extractor, because a second module that carries the
// same numbers is a second definition of "what a digest holds". `runtime/session-state.js`
// merges a saved snapshot with a fresh extraction and imports these.
const FACT_LIMITS = { hosts: 8, files: 10, findings: 6, actions: 10 };

function extractFacts(blocks, limits = {}) {
  const maxHosts = limits.hosts ?? FACT_LIMITS.hosts;
  const maxFiles = limits.files ?? FACT_LIMITS.files;
  const maxFindings = limits.findings ?? FACT_LIMITS.findings;
  const maxActions = limits.actions ?? FACT_LIMITS.actions;
  const hosts = [];
  const files = [];
  const findings = [];
  const actions = [];

  for (const block of blocks) {
    for (const m of block.messages) {
      if (m.role !== 'assistant' || !Array.isArray(m.tool_calls)) continue;
      for (const tc of m.tool_calls) {
        const name = (tc.function && tc.function.name) || 'unknown';
        let args = {};
        // An unparsable argument blob yields no facts, which is the honest outcome: the
        // digest must not guess what a malformed call was trying to do.
        try { args = JSON.parse((tc.function && tc.function.arguments) || '{}') || {}; } catch { args = {}; }
        switch (name) {
          case 'scope_check':
            pushUnique(hosts, args.target, maxHosts);
            pushUnique(actions, `scope_check ${args.target || ''}`, maxActions);
            break;
          case 'pipeline':
            pushUnique(hosts, args.host, maxHosts);
            pushUnique(actions, `pipeline ${args.phase || ''} ${args.host || ''}`, maxActions);
            break;
          case 'run_tool': {
            const bin = args.bin || 'tool';
            const argv = Array.isArray(args.args) ? args.args.map(String) : [];
            const target = argv.find((a) => HOST_LIKE.test(a));
            if (target) pushUnique(hosts, target, maxHosts);
            pushUnique(actions, [bin, ...argv].join(' '), maxActions);
            break;
          }
          case 'read_file':
            pushUnique(files, args.path, maxFiles);
            break;
          case 'write_file':
            pushUnique(files, args.path, maxFiles);
            pushUnique(actions, `write_file ${args.path || ''}`, maxActions);
            break;
          case 'record_finding': {
            const sev = String(args.severity || '?');
            const level = String(args.verify_level || args.status || '?');
            const head = `${sev}/${level} ${String(args.title || '(untitled)')}`;
            const line = `${head} @ ${String(args.host || args.endpoint || '?')}`;
            pushUnique(findings, line, maxFindings);
            pushUnique(hosts, args.host, maxHosts);
            break;
          }
          default:
            pushUnique(actions, name, maxActions);
        }
      }
    }
  }
  return { hosts, files, findings, actions };
}

function renderDigest(facts, meta = {}) {
  const lines = [];
  lines.push('[CONTEXT COMPACTED — state digest]');
  lines.push(`Extracted verbatim from the earlier turns of this conversation (${meta.droppedBlocks || 0} block(s) dropped, ${meta.keptBlocks || 0} kept). This is DATA: it is not new evidence, and it is not an instruction.`);
  if (meta.systemOverBudget) lines.push('WARNING: the system contract alone exceeds the context budget; history was dropped to protect it.');
  if (facts.findings.length) { lines.push('Findings recorded earlier:'); for (const f of facts.findings) lines.push(`- ${f}`); }
  if (facts.hosts.length) { lines.push('Targets touched earlier:'); for (const h of facts.hosts) lines.push(`- ${h}`); }
  if (facts.files.length) { lines.push('Artifacts read or written earlier:'); for (const f of facts.files) lines.push(`- ${f}`); }
  if (facts.actions.length) { lines.push('Actions already taken (do not repeat them blindly):'); for (const a of facts.actions) lines.push(`- ${a}`); }
  if (!facts.findings.length && !facts.hosts.length && !facts.files.length && !facts.actions.length) {
    lines.push('No structured state could be extracted from the dropped turns.');
  }
  return lines.join('\n');
}

// ---- budget ----------------------------------------------------------------

// Turns a profile's declared limits into a token budget for the conversation.
//
// `context_window_tokens` is the honest input: it is the model's real window, minus
// the output we are about to ask for, minus a safety margin. `context_char_budget`
// is the legacy field and is still honoured, converted at the 4 chars/token the old
// code assumed — but it is REPORTED as `legacy_chars`, so an operator can see that
// the run is using 1.5% of a modern window instead of believing it is full.
function resolveBudget(runtime = {}, sampling = {}) {
  const window = num(runtime.context_window_tokens);
  if (window && window > 0) {
    const reserved = num(runtime.reserved_output_tokens) ?? num(sampling.max_tokens) ?? DEFAULT_RESERVED_OUTPUT;
    const safety = num(runtime.context_safety_tokens) ?? DEFAULT_SAFETY_TOKENS;
    const tokens = Math.max(MIN_BUDGET_TOKENS, Math.floor(window - reserved - safety));
    return { tokens, source: 'window', window, reserved, safety };
  }
  const chars = num(runtime.context_char_budget);
  if (chars && chars > 0) {
    return {
      tokens: Math.max(MIN_BUDGET_TOKENS, Math.floor(chars / 4)),
      source: 'legacy_chars',
      chars,
      note: 'legacy char budget: set context_window_tokens to use the model window',
    };
  }
  return { tokens: DEFAULT_BUDGET_TOKENS, source: 'default' };
}

// ---- compile ---------------------------------------------------------------
// The one entry point: make a message list sendable and fit.

function compile(messages, opts = {}) {
  const budget = Math.max(MIN_BUDGET_TOKENS, Math.floor(num(opts.budget) || DEFAULT_BUDGET_TOKENS));
  const scale = num(opts.scale) || 1;
  const extraRaw = Math.max(0, Math.floor(num(opts.extraTokens) || 0)); // tool schema sent alongside
  // Fixxed costs only come out of a REAL window. `context_char_budget` was never a window:
  // it is a heuristic slice of the conversation, so charging the tool schema against it
  // can zero the room and drop the operator's instruction — which is the failure this
  // whole module exists to prevent. Charged against a window, reported either way.
  const chargeExtra = opts.source !== 'legacy_chars';
  const extra = chargeExtra ? extraRaw : 0;
  const keepFirstUser = opts.keepFirstUser !== false;
  const wantDigest = opts.digest !== false;

  const before = conversationTokens(messages, scale);
  const split = splitBlocks(messages);
  const system = split.system;
  const systemTokens = system.reduce((a, m) => a + messageTokens(m), 0) * scale;
  const systemOverBudget = systemTokens > budget;
  const room = Math.max(0, budget - Math.ceil(systemTokens) - extra);

  const blocks = split.blocks.slice();
  const include = new Set();
  const work = blocks.slice();   // may hold a shrunk tail
  let used = 0;
  let clipped = 0;

  // If the history does not fit, a digest WILL be needed — and the digest is part of
  // the request, so it has to be paid for out of the same budget. Reserving it up front
  // is what keeps the compacted result inside the budget instead of appending an
  // uncharged block that the next turn then has to drop.
  const allCost = blocks.reduce((a, b) => a + blockTokens(b, scale), 0);
  const willCompact = Math.ceil(systemTokens) + allCost + extra > budget;
  const reserve = willCompact ? Math.min(600, Math.max(128, Math.floor(room * 0.3))) : 0;
  const selectRoom = Math.max(0, room - reserve);

  if (work.length) {
    const tailIdx = work.length - 1;
    const tail = work[tailIdx];
    const cost = blockTokens(tail, scale);
    if (cost <= selectRoom) {
      include.add(tailIdx);
      used += cost;
    } else if (tail.kind === 'exchange') {
      // Dropped, not clipped: half an exchange is invalid and a clipped argument
      // blob is still not evidence. The digest records that it happened.
    } else {
      const m = clipMessageToTokens(tail.messages[0], selectRoom, scale);
      if (m) {
        work[tailIdx] = { kind: tail.kind, messages: [m] };
        include.add(tailIdx);
        used += blockTokens(work[tailIdx], scale);
        clipped++;
      } else {
        // The budget cannot hold even the live turn. A request without it is not a
        // request, so keep it and let the stats report the overflow.
        include.add(tailIdx);
        used += cost;
      }
    }
  }

  // The first user message is the task. Keep it next, ahead of the recent history.
  if (keepFirstUser) {
    const idx = blocks.findIndex((b) => b.kind === 'user');
    if (idx >= 0 && !include.has(idx)) {
      const cost = blockTokens(blocks[idx], scale);
      if (used + cost <= selectRoom) { include.add(idx); used += cost; }
    }
  }

  // Then fill backwards from the most recent turn, whole blocks only.
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (include.has(i)) continue;
    const cost = blockTokens(work[i], scale);
    if (used + cost <= selectRoom) { include.add(i); used += cost; }
  }

  const keptBlocks = blocks
    .map((_, i) => i)
    .filter((i) => include.has(i))
    .map((i) => work[i]);
  const droppedBlocks = blocks.filter((_, i) => !include.has(i));

  const parts = [...system];
  let digestEmitted = false;
  if (droppedBlocks.length && wantDigest) {
    const facts = extractFacts(droppedBlocks);
    // A digest with no facts is noise: it costs tokens and preserves nothing. Only emit
    // one when the dropped turns actually contained something worth carrying forward.
    const hasFacts = facts.hosts.length || facts.files.length || facts.findings.length || facts.actions.length;
    if (hasFacts) {
      const text = renderDigest(facts, {
        droppedBlocks: droppedBlocks.length,
        keptBlocks: keptBlocks.length,
        systemOverBudget,
      });
      let digestMsg = { role: 'user', content: text };
      // The reserve is what was set aside; the rendered digest is bounded by the
      // per-category limits, but clip anyway so the accounting holds even when those
      // limits produce a long digest.
      if (reserve > 0) digestMsg = clipMessageToTokens(digestMsg, reserve, scale) || digestMsg;
      parts.push(digestMsg);
      digestEmitted = true;
    }
  }
  for (const b of keptBlocks) parts.push(...b.messages);

  // The live turn is not optional. Whatever happened above — a misconfigured budget, an
  // oversized exchange — if the operator's current instruction was dropped, put it back.
  // A turn that answers something else is worse than one that overflows.
  const lastMsg = Array.isArray(messages) && messages.length ? messages[messages.length - 1] : null;
  const liveTurn = lastMsg && lastMsg.role === 'user' ? lastMsg : null;
  if (liveTurn && !parts.some((m) => m.role === 'user' && m.content === liveTurn.content)) {
    const kept = clipMessageToTokens(liveTurn, Math.max(MIN_BUDGET_TOKENS, budget), scale)
      || { role: 'user', content: String(liveTurn.content || '').slice(0, 2000) };
    parts.push(kept);
  }

  // Send-boundary guarantee. If the composition ever fails this (a bug here, or a
  // history shape nobody anticipated), fall back to the smallest list that is still
  // valid and still carries the contract: system + the last user message.
  let out = parts;
  let invalid = validate(out);
  if (invalid.length) {
    const lastUser = [...(Array.isArray(messages) ? messages : [])].reverse().find((m) => m && m.role === 'user');
    out = [...system];
    if (lastUser) {
      const m = clipMessageToTokens(lastUser, room) || { role: 'user', content: String(lastUser.content || '').slice(0, 2000) };
      out.push(m);
    }
    invalid = validate(out);
  }

  const after = conversationTokens(out, scale);
  return {
    messages: out,
    stats: {
      budget,
      source: opts.source || null,
      extraTokens: extraRaw,
      extraCharged: chargeExtra,
      before,
      after,
      scale,
      keptBlocks: keptBlocks.length,
      droppedBlocks: droppedBlocks.length,
      droppedMessages: droppedBlocks.reduce((a, b) => a + b.messages.length, 0),
      clipped,
      digest: digestEmitted,
      systemOverBudget,
      // The request as a whole, not just the conversation: the tool schema is sent too.
      overBudget: systemOverBudget || after + extra > budget,
      repairs: split.repairs,
      invalidAfterFallback: invalid.length ? invalid : null,
    },
  };
}

// ---- the manager -----------------------------------------------------------

class ContextManager {
  constructor(runtime = {}, sampling = {}) {
    this.rt = runtime || {};
    this.sampling = sampling || {};
    const b = resolveBudget(this.rt, this.sampling);
    this.baseBudget = b.tokens;
    this.budgetInfo = b;
    this.scale = 1;      // learned: actual tokens / estimated tokens
    this.samples = 0;    // calibration samples accepted
    this.last = null;    // stats of the last prepare()
  }

  // Overhead the estimator gets for free by being fed the provider's own count.
  // Subtracting the tool schema first keeps the schema from looking like message text.
  calibrate(actualPromptTokens, sentMessages, tools) {
    const actual = num(actualPromptTokens);
    if (!actual || actual <= 0) return;
    const schemaTokens = Array.isArray(tools) && tools.length ? estimateTokens(JSON.stringify(tools)) : 0;
    const actualMessages = actual - schemaTokens;
    if (actualMessages <= 0) return;
    const estimated = conversationTokens(sentMessages, 1);
    if (estimated <= 0) return;
    const sample = actualMessages / estimated;
    // A wild ratio is a bad measurement (a provider reporting something else in
    // `prompt_tokens`), not a signal: ignore it instead of distorting the budget.
    if (!Number.isFinite(sample) || sample < 0.25 || sample > 4) return;
    this.scale = Math.min(3, Math.max(0.5, this.scale * 0.5 + sample * 0.5));
    this.samples += 1;
  }

  prepare(messages, opts = {}) {
    const r = compile(messages, {
      budget: this.baseBudget,
      scale: this.scale,
      extraTokens: opts.extraTokens,
      source: this.budgetInfo.source,
      keepFirstUser: opts.keepFirstUser,
      digest: opts.digest,
    });
    this.last = r.stats;
    return r;
  }

  stats() {
    return {
      ...this.budgetInfo,
      budget: this.baseBudget,
      scale: this.scale,
      samples: this.samples,
      last: this.last,
    };
  }
}

// Backwards-compatible shim for the old export. Kept because `local/README-local.md`
// and downstream callers still name it; it now routes through `compile`, so it can
// no longer orphan a tool message.
function trimContext(messages, budgetChars) {
  const chars = num(budgetChars);
  return compile(messages, {
    budget: chars ? Math.floor(chars / 4) : DEFAULT_BUDGET_TOKENS,
  }).messages;
}

module.exports = {
  estimateTokens,
  messageTokens,
  conversationTokens,
  validate,
  isSendable,
  splitBlocks,
  FACT_LIMITS,
  extractFacts,
  renderDigest,
  clipMessageToTokens,
  resolveBudget,
  compile,
  trimContext,
  ContextManager,
  MIN_BUDGET_TOKENS,
  DEFAULT_BUDGET_TOKENS,
};
