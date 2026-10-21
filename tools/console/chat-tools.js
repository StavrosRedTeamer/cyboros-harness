// Console — chat tool execution: the guarded dispatch a browser turn runs on.
//
// Why it is not in chat.js: three concerns meet here and each has a failure mode the
// others must not inherit — process execution (must not block the HTTP loop), preset
// enforcement (must not be a UI-only check) and human approval (must not be a prompt
// the model can satisfy itself). Keeping them together makes the refusal paths
// auditable in one read; keeping them out of the transport keeps SSE dumb.
//
// Execution goes through local/tools-bridge.js#makeDispatch, i.e. exactly the same
// switch the CLI uses: scope-guard, rate limiting, tool registry and record-finding
// validation all still apply. The only difference is the injected `runner`, which
// spawns asynchronously instead of spawnSync.
'use strict';
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const path = require('node:path');
const { makeDispatch } = require('../../local/tools-bridge');
const live = require('../../runtime/live');
const presets = require('./chat-presets');

const MAX_BUFFER = 32 * 1024 * 1024;
const SSE_OUTPUT_CHARS = 20000;

function clip(s, n) {
  const t = String(s == null ? '' : s);
  return t.length > n ? t.slice(0, n) + `… (+${t.length - n} chars)` : t;
}

// Async spawn with the same { code, out } contract as tools-bridge#sh, so the dispatch
// switch does not know (or care) which one it got. Timeout kills the child and reports
// 124, like coreutils.
function createAsyncRunner(opts = {}) {
  const cwd = opts.cwd || path.join(__dirname, '..', '..');
  const baseEnv = opts.env || {};
  return function run(cmd, args, runOpts = {}) {
    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(cmd, args, {
          cwd,
          env: Object.assign({}, process.env, baseEnv, runOpts.env || {}),
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (e) {
        resolve({ code: 1, out: String((e && e.message) || e) });
        return;
      }
      let out = '';
      let size = 0;
      let timedOut = false;
      const push = (chunk) => {
        if (size >= MAX_BUFFER) return;
        const text = chunk.toString();
        out += text;
        size += text.length;
      };
      child.stdout.on('data', push);
      child.stderr.on('data', push);
      const timer = runOpts.timeout
        ? setTimeout(() => { timedOut = true; try { child.kill('SIGKILL'); } catch { /* gone */ } }, runOpts.timeout)
        : null;
      const done = (code, err) => {
        if (timer) clearTimeout(timer);
        const trimmed = out.trim();
        const text = [trimmed, err ? String(err.message || err) : ''].filter(Boolean).join('\n');
        resolve({ code: timedOut ? 124 : (code == null ? 1 : code), out: text });
      };
      child.on('error', (e) => done(1, e));
      child.on('close', (code) => done(code));
    });
  };
}

// ── approvals ──────────────────────────────────────────────────────────────
// A tool that changes a target cannot be approved by the model that proposed it. The
// turn emits `approval` and parks on a promise; POST /api/chat/approval resolves it.
// Failure is deny: a closed tab or an unanswered prompt must not become a "yes".
function createApprovalBroker(opts = {}) {
  const ttlMs = Math.max(1000, Number(opts.ttlMs) || 300000);
  const pending = new Map();

  function request(spec, emit) {
    const id = 'ap_' + crypto.randomBytes(6).toString('hex');
    const expiresAt = Date.now() + ttlMs;
    emit(Object.assign({ type: 'approval', id, expiresAt }, spec));
    return new Promise((resolve) => {
      const settle = (decision) => {
        if (!pending.has(id)) return;
        pending.delete(id);
        clearTimeout(timer);
        emit({ type: 'approval_result', id, decision });
        resolve(decision);
      };
      const timer = setTimeout(() => settle('timeout'), ttlMs);
      if (timer.unref) timer.unref();
      pending.set(id, { settle, spec });
    });
  }

  function answer(body = {}) {
    const id = String(body.id || '');
    const p = pending.get(id);
    if (!p) return { ok: false, status: 404, error: 'unknown or expired approval' };
    const decision = String(body.decision || '');
    if (!['approve', 'deny', 'stop'].includes(decision)) {
      return { ok: false, status: 400, error: 'decision must be approve|deny|stop' };
    }
    p.settle(decision);
    return { ok: true, id, decision };
  }

  return { request, answer, pending };
}

// ── the preset-enforced dispatch ───────────────────────────────────────────
// `emit` is the SSE writer for this turn; every call and result crosses it, including
// the refusals, so the UI never has to infer what happened from the model's prose.
function createChatDispatch(opts = {}) {
  const preset = opts.preset;
  if (!preset) throw new Error('createChatDispatch needs a preset');
  const emit = opts.emit || (() => {});
  const approve = opts.approve || (async () => 'deny');
  const runner = opts.runner || createAsyncRunner({ env: opts.env });
  // 'deny' is a real policy, not a UI hint: intrusive tools are refused before an
  // approval is even offered, so a distracted operator cannot be social-engineered
  // into the dialog. 'ask' is the human gate.
  const approvalPolicy = opts.approvalPolicy === 'deny' ? 'deny' : 'ask';
  const base = makeDispatch({
    allowRunTool: presets.allows(preset, 'run_tool'),
    noCache: opts.noCache !== false,
    runner,
    // The console's engagement data can live outside the code tree: read the reports
    // it shows, and write evidence into the reports dir it is configured with.
    readRoots: opts.readRoots || [],
    reportRoots: opts.reportRoots || [],
  });
  let seq = 0;

  return async function dispatch(name, rawArgs = {}) {
    const id = `tc_${++seq}`;
    const tool = String(name || '');

    // Layer 1: the preset. The schema already hid this tool from the model; a stale
    // tab, a text-protocol ACTION or a model inventing a call arrives here instead.
    if (!presets.allows(preset, tool)) {
      const out = `BLOCCATO (preset ${preset.id}): il tool "${tool}" non è disponibile in questa modalità. `
        + `Tool ammessi: ${preset.tools.join(', ') || '(nessuno)'}. `
        + (preset.mode === 'read-only'
          ? 'Questa è la modalità analisi: se serve un\'azione, l\'operatore deve passare al preset pentest.'
          : 'Scegli un tool ammesso o rispondi senza tool.');
      emit({ type: 'tool_call', id, tool, args: rawArgs });
      emit({ type: 'tool_result', id, tool, ok: false, exit: null, durationMs: 0, output: out, blocked: true, reason: 'preset' });
      return out;
    }

    const args = tool === 'run_tool' ? live.normalizeRunTool(rawArgs) : rawArgs;
    emit({ type: 'tool_call', id, tool, args });

    // Layer 2: the human, for tools that change a target. Tier comes from the same
    // registry run.js consults, so "intrusive" means one thing in the whole harness.
    if (tool === 'run_tool') {
      const tier = live.toolTier(args.bin);
      if (tier === 'intrusive') {
        const command = `node tools/run.js ${args.bin} ${args.args.join(' ')}`.trim();
        if (approvalPolicy === 'deny') {
          const out = `BLOCCATO (policy approval_policy=deny): ${args.bin} è intrusive e le approvazioni sono disabilitate. `
            + 'Se serve davvero, l\'operatore deve cambiare la policy nelle impostazioni della chat.';
          emit({ type: 'tool_result', id, tool, ok: false, exit: null, durationMs: 0, output: out, blocked: true, reason: 'policy' });
          return out;
        }
        const decision = await approve({
          tool, args, tier,
          command,
          reason: `risk_tier intrusive · ${args.bin}`,
        }, emit);
        if (decision !== 'approve') {
          const why = decision === 'timeout' ? 'nessuna risposta dell\'operatore (timeout)' : `decisione: ${decision}`;
          const out = `ANNULLATO: ${args.bin} non eseguito (${why}). Proponi un'alternativa o chiedi indicazioni.`;
          emit({ type: 'tool_result', id, tool, ok: false, exit: null, durationMs: 0, output: out, blocked: true, reason: 'approval' });
          return out;
        }
      } else if (!args.bin) {
        // normalizeRunTool already turns the common malformed shapes into {bin, args};
        // an empty bin is a model error worth correcting in-context instead of spawning.
        const out = 'ERRORE: bin mancante. Forma attesa: {"bin":"<tool>","args":["<arg1>"]}. Niente stringhe di shell.';
        emit({ type: 'tool_result', id, tool, ok: false, exit: null, durationMs: 0, output: out, blocked: true, reason: 'invalid-args' });
        return out;
      }
    }

    const startedAt = Date.now();
    let out;
    try {
      out = await base(tool, args);
    } catch (e) {
      out = `ERRORE tool: ${String((e && e.message) || e)}`;
    }
    const durationMs = Date.now() - startedAt;
    const m = /exit (-?\d+)/.exec(String(out));
    const exit = m ? Number(m[1]) : null;
    const ok = exit == null ? !/^\s*(ERRORE|error:)/i.test(String(out)) : exit === 0;
    emit({
      type: 'tool_result', id, tool, ok, exit, durationMs,
      output: clip(out, SSE_OUTPUT_CHARS), blocked: false,
    });
    return out;
  };
}

module.exports = { createAsyncRunner, createApprovalBroker, createChatDispatch };
