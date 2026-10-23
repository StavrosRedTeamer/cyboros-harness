// runtime/terminal/turn.js — one model turn, from the provider request to the last line it
// prints, plus the two paths that start a turn (a typed message and the connect offer).
//
// The loop belongs to runtime/live.js and the accounting to runtime/usage.js; this file
// owns the terminal side: the spinner, the streamed answer, the tool rows, the approval
// request, and Esc taking the turn back. Interrupt is a strict no-op on a non-TTY, so
// --script and the test harness see the same bytes as before.
'use strict';

const { OPTS } = require('./args');
const {
  COLOR, dim, bold, cyan, mag, grn, ylw, red, sleep, ANSWER_W,
} = require('./theme');
const { renderMarkdown, createStream, thinkingLine, THINKING_VERBS } = require('../render');
// The rollup and its formatting, shared with the console so both say the same number.
const bill = require('../usage');
const {
  state, PROVIDER, reloadScope, targetLabel, scopeBadge, budget, costView, costBadge, ev,
} = require('./state');
const { getInput } = require('./input');
const { approval } = require('./approval');

// ── live loop (providers.json → local/llm.js → guarded tools) ──────────────
function clipJson(obj, n = 160) {
  const s = JSON.stringify(obj == null ? {} : obj);
  return s.length > n ? s.slice(0, n) + '…' : s;
}

// Every provider refusal shares one exit status; what differs is the remedy. One table
// here — next to the only catch that prints it — means a cause added to runtime/live.js
// cannot exit 5 silently: an unknown code falls through to the generic remedy.
const REFUSAL_EXIT = 5;
// A Map, not an object literal: a code named `constructor` would otherwise pick up an
// inherited member instead of the generic remedy.
const REFUSAL_CLAUSE = new Map([
  ['config_missing', 'copy the template (runtime/providers.example.json), then retry'],
  ['config_invalid', 'fix the provider config, then retry'],
  ['config_inline_key', 'move the key out of the config into the environment, then retry'],
  ['key_file_permissions', 'the key file must be chmod 600, then retry'],
  ['profile_unknown', 'name a profile the config defines, then retry'],
  ['cloud_requires_flag', 'authorize the provider with --allow-cloud, then retry'],
  ['cloud_disabled', 'this config forbids cloud egress, and --allow-cloud cannot override it'],
  ['provider_key_missing', 'export the key the profile names, or write it to the profile key file (chmod 600), then retry'],
  ['session_unknown', 'attach a session /sessions can list, then retry'],
]);
const UNMAPPED_CLAUSE = 'the provider was not authorized; fix its configuration, then retry';

function refusal(e) {
  const clause = REFUSAL_CLAUSE.get(e && e.code) || UNMAPPED_CLAUSE;
  return { exit: REFUSAL_EXIT, text: `not a failed run: nothing was sent and no provider call was made — ${clause}` };
}

function initLive(profile) {
  try {
    const { createLive } = require('../live');
    const live = createLive({
      profile: profile || OPTS.profile || undefined,
      configPath: OPTS.config || undefined,
      allowCloud: OPTS.allowCloud || !!state.cloudConsent,
      target: state.target,
      phase: state.phase,
      klass: state.klass,
      resume: state.resumeId || undefined,
      allowStale: OPTS.allowStale,
      approve: (spec) => approval(spec),
    });
    state.live = live;
    // The restored conversation is the loop's, not the TUI's: `history()` is what the next
    // turn will actually send, so the surface reports that instead of an assumption.
    state.liveHistory = live.history();
    if (live.resumed()) {
      const r = live.resumed();
      state.resumeReport = r.report;
      state.target = r.host || state.target;
      state.phase = r.phase || state.phase;
      state.klass = r.class || state.klass;
      state.session = live.session.id;
      state.liveUsage = bill.normalizeUsage(r.usage);
    } else {
      // The rollup belongs to the session that produced it. A fresh attach (after
      // `/live off`, or a profile change) starts a new session id, and carrying the
      // previous numbers over reported one engagement's bill under another's name —
      // which is precisely the misattribution this ledger exists to prevent.
      state.liveUsage = bill.emptyUsage();
    }
    state.resumeId = null;
    state.profile = live.info.profile;
    state.model = live.info.model;
    state.egress = live.info.egress;
    // The real budget, so /compact and the status bar report the loop's numbers
    // instead of a hardcoded percentage.
    const cs = live.contextStats();
    state.contextBudget = { tokens: cs.budget, source: cs.source, window: cs.window || null };
    state.contextPct = 0;
    return live;
  } catch (e) {
    const r = state.liveFailure = refusal(e);
    console.log('');
    console.log(`  ${red('✖')} ${e.message}`);
    console.log(dim(`  ${r.text}`));
    console.log('');
    return null;
  }
}

function resetLive(reason) {
  if (!state.live) return;
  state.live.finish(reason || 'reset');
  state.live = null;
  state.liveHistory = null;
}

// ── interrupt: Esc (or ctrl+c) takes the turn back ──────────────────────────
// The spinner advertises "esc to interrupt", so the key has to be real. Between
// turns the input surface owns stdin; during a turn it is free, so this attaches
// a transient raw-mode listener and tears it down when the turn ends. On a
// non-TTY (the test harness, --script, a pipe) it is a strict no-op, so nothing
// about the scripted output changes. It yields the keyboard back with pause()
// whenever an approval prompt needs it, then resume()s.
const aborted = () => !!(state.irq && state.irq.aborted());

function interruptScope() {
  const stdin = process.stdin;
  if (!stdin.isTTY || OPTS.fast || typeof stdin.setRawMode !== 'function') {
    return { aborted: () => false, promise: new Promise(() => {}), stop() {}, pause() {}, resume() {} };
  }
  let isAborted = false;
  let attached = false;
  let stopped = false;
  let resolveAbort = () => {};
  const promise = new Promise((r) => { resolveAbort = r; });
  const onData = (buf) => {
    const s = buf.toString('utf8');
    if (s === '\x1b' || s === '\x03') {            // bare Esc or ctrl+c
      if (!isAborted) { isAborted = true; resolveAbort(); }
    }
  };
  const detach = () => {
    if (!attached) return;
    stdin.removeListener('data', onData);
    try { stdin.setRawMode(false); } catch { /* not a tty under us */ }
    attached = false;
  };
  const attach = () => {
    if (attached || stopped || isAborted) return;
    try { stdin.setRawMode(true); } catch { /* not a tty under us */ }
    stdin.resume();
    stdin.on('data', onData);
    attached = true;
  };
  attach();
  return {
    aborted: () => isAborted,
    promise,
    pause: detach,
    resume: attach,
    stop() {
      if (stopped) return;
      stopped = true;
      detach();
      stdin.pause();
    },
  };
}

// An interruptible pause: resolves after `ms`, or at once when the turn is
// interrupted, so the scripted walkthrough stops the instant Esc is pressed.
function pace(ms) {
  if (OPTS.fast) return Promise.resolve();
  if (!state.irq || !state.irq.promise) return sleep(ms);
  return Promise.race([sleep(ms), state.irq.promise]);
}

function printInterrupted() {
  console.log(`    ${dim('⎿')}  ${red('Interrupted by user')}`);
  console.log('');
}

// Runs one turn (scripted or live) with the interrupt watcher installed, and
// prints the interrupted marker once if Esc was pressed.
async function runTurn(fn) {
  const irq = interruptScope();
  state.irq = irq;
  try {
    await fn(irq);
  } finally {
    irq.stop();
    const was = irq.aborted();
    state.irq = null;
    if (was) printInterrupted();
  }
}

// The Claude Code spinner: one line, rewritten in place, only on a real terminal.
// The verb rotates and the status carries the elapsed time, the live token count
// and the interrupt hint, the way Claude Code's "✻ Simmering… (…)" does.
function spinner(opts = {}) {
  if (!process.stdout.isTTY || OPTS.fast) return { stop() {} };
  const frames = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢'];
  const verbs = THINKING_VERBS;
  const t0 = Date.now();
  const tokensOf = typeof opts.tokens === 'function' ? opts.tokens : () => 0;
  const interruptible = opts.interruptible !== false;
  let verb = verbs[Math.floor(Math.random() * verbs.length)];
  let lastVerbAt = Date.now();
  let i = 0;
  let stopped = false;
  const tick = () => {
    if (stopped) return;
    const now = Date.now();
    if (now - lastVerbAt > 4000) { verb = verbs[Math.floor(Math.random() * verbs.length)]; lastVerbAt = now; }
    const secs = Math.round((now - t0) / 1000);
    const text = thinkingLine({ verb, secs, tokens: tokensOf(), interruptible });
    process.stdout.write(`\r\x1b[2K  ${mag(frames[i++ % frames.length])} ${dim(text)}`);
  };
  const timer = setInterval(tick, 90);
  tick();
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      process.stdout.write('\r\x1b[2K');
    },
  };
}

// "FINAL:" is protocol, not prose: strip it even when the text arrives token by token.
function finalPrefixStripper(feed) {
  let pending = '';
  let done = false;
  return (chunk) => {
    if (done) { feed(chunk); return; }
    pending += chunk;
    const m = pending.match(/^\s*FINAL:\s*/i);
    if (m) { done = true; feed(pending.slice(m[0].length)); pending = ''; return; }
    if (pending.length > 12) { done = true; feed(pending); pending = ''; }
  };
}

async function liveTurn(text) {
  if (!state.live) {
    const live = initLive();
    if (!live) return;
  }
  reloadScope();

  const t0 = Date.now();

  // One block per model turn: a tool call closes the current answer/thinking block.
  let answer = null;
  let thinking = null;
  let answerPrinted = false;
  let thinkingStarted = 0;
  let sawThinking = false;
  let feedAnswer = null;
  const irq = interruptScope();
  state.irq = irq;
  let spin = spinner({ tokens: () => budget().tokens, interruptible: true });

  const stopSpin = () => { if (spin) { spin.stop(); spin = null; } };
  const closeBlocks = () => {
    if (answer) { answer.end(); answer = null; }
    if (thinking) { thinking.end(); thinking = null; }
    stopSpin();
  };
  const startThinking = () => {
    if (thinking) return thinking;
    thinkingStarted = Date.now();
    sawThinking = true;
    thinking = createStream({
      width: ANSWER_W(),
      color: COLOR,
      onLine: (line, meta) => console.log(meta.first ? `  ${dim('✻')} ${dim(line)}` : `    ${dim(line)}`),
    });
    return thinking;
  };
  const startAnswer = () => {
    if (!answer) {
      answer = createStream({
        width: ANSWER_W(),
        color: COLOR,
        onLine: (line, meta) => console.log(meta.first ? `  ${bold('⏺')} ${line}` : `    ${line}`),
      });
      answerPrinted = false;
      const write = answer.push.bind(answer);
      feedAnswer = finalPrefixStripper((chunk) => { answerPrinted = true; write(chunk); });
    }
    return feedAnswer;
  };

  let res;
  const INT = Symbol('interrupted');
  let interrupted = false;
  try {
    const runP = state.live.run(text, {
      mode: state.mode,
      history: state.liveHistory,
      onThinkingDelta: (chunk) => {
        if (aborted() || !state.thinking) return;
        stopSpin();
        startThinking().push(chunk);
      },
      onThinkingDone: (full) => {
        if (aborted()) return;
        if (thinking) { thinking.end(); thinking = null; }
        // Provider senza delta (risposta JSON): mostra il blocco una volta, a fine giro.
        if (!sawThinking && state.thinking && full) {
          startThinking().push(full);
          if (thinking) { thinking.end(); thinking = null; }
          sawThinking = true;
        }
        if (sawThinking) {
          const secs = Math.max(1, Math.round((Date.now() - thinkingStarted) / 1000));
          if (state.thinking) console.log('');
          else console.log(`  ${dim(`✻ Thought for ${secs}s`)}`);
        }
        sawThinking = false;
        stopSpin();
      },
      onToken: (chunk) => {
        if (aborted()) return;
        // Reasoning often has no newline until the end: close it before the answer so the
        // transcript keeps the true order (thinking first, then prose).
        stopSpin();
        if (thinking) { thinking.end(); thinking = null; }
        startAnswer()(chunk);
      },
      onStep: (s) => {
        if (aborted()) return;
        closeBlocks();
        console.log('');
        console.log(`  ${bold('⏺')} ${bold(s.tool)}${s.args && Object.keys(s.args).length ? dim('(' + clipJson(s.args) + ')') : ''}${s.viaText ? dim(' (text protocol)') : ''}`);
      },
      onToolResult: (r) => {
        if (aborted()) return;
        const lines = String(r.out == null ? '' : r.out).replace(/\r/g, '').split('\n').filter((l) => l.trim());
        const tone = r.blocked ? ylw : (s) => s;
        console.log(`    ${dim('⎿')}  ${tone((lines[0] || '(empty)').slice(0, 300))}`);
        // Skip transport headers so a curl probe shows the body that proves the claim.
        const body = lines.slice(1).filter((l) => !/^(HTTP\/|content-|cache-control|x-|date:|connection:|keep-alive:|transfer-encoding:|server:|vary:|set-cookie:|strict-transport|content-security|permissions-policy|referrer-policy|x-frame|alt-svc|location:)/i.test(l));
        const shown = state.details ? body.slice(0, 10) : body.slice(0, 2);
        for (const line of shown) console.log(`       ${dim(line.slice(0, 300))}`);
        if (body.length > shown.length) console.log(`       ${dim(`… +${body.length - shown.length} lines (/details to expand)`)}`);
      },
      onUsage: (u) => {
        // The loop already accumulated this call; take its number rather than adding a
        // second time. The rollup is what /cost, /status and the session file all read.
        if (u.rollup) state.liveUsage = bill.normalizeUsage(u.rollup);
        else state.liveUsage = state.live.usage();
      },
    });
    // The agent loop has no abort hook, so Esc cannot cancel the in-flight
    // provider request; it stops the rendering and hands the prompt back the way
    // Claude Code does. The late result is swallowed so it cannot crash the REPL.
    runP.catch(() => {});
    res = await Promise.race([runP, irq.promise.then(() => INT)]);
    if (res === INT) interrupted = true;
  } catch (e) {
    closeBlocks();
    irq.stop();
    state.irq = null;
    console.log('');
    console.log(`  ${red('✖')} ${e.message}`);
    console.log(dim('  session and events are on disk; fix the provider/config and retry'));
    console.log('');
    process.exitCode = 1;
    return;
  }

  if (interrupted) {
    closeBlocks();
    irq.stop();
    state.irq = null;
    printInterrupted();
    return;
  }

  closeBlocks();
  irq.stop();
  state.irq = null;
  state.liveHistory = res.messages;
  {
    const cs = state.live.contextStats();
    if (cs && cs.last && cs.budget > 0) state.contextPct = Math.min(100, Math.round((cs.last.after / cs.budget) * 100));
  }
  if (!answerPrinted) {
    const md = renderMarkdown(res.text || '(empty)', { width: ANSWER_W(), color: COLOR });
    console.log('');
    md.forEach((line, i) => console.log(i === 0 ? `  ${bold('⏺')} ${line}` : `    ${line}`));
  }
  console.log('');
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  // The rollup, not this turn: an operator reading the transcript wants the running total
  // of the engagement, labelled with where the price came from.
  const v = costView();
  const cost = v.known ? ` · ${costBadge(v)}` : ' · cost unknown';
  const tokens = state.liveUsage.tokens_in + state.liveUsage.tokens_out;
  console.log(dim(`  ✻ Worked for ${secs}s · ${tokens} tokens${cost}`));
  console.log('');
}

// Changing the egress gate at the point of use: a cloud profile used to need a
// flag typed at launch. The consent frame names the provider, the egress and what
// leaves the host, it is per session, and it is recorded in the session events.
// Declining is remembered, so the question is asked once, not on every message.
async function offerLive() {
  const input = getInput();
  if (!input || !PROVIDER || state.liveDeclined) return 'skip';
  const keyEnv = PROVIDER.keyEnv;
  const { resolveKey, keyFileFor } = require('../live');
  let resolved;
  try {
    resolved = resolveKey(PROVIDER.profile, keyEnv);
  } catch (e) {
    console.log('');
    console.log(`  ${red('✖')} ${e.message}`);
    console.log('');
    return 'unavailable';
  }
  if (!resolved.key) {
    console.log('');
    console.log(`  ${red('✖')} ${PROVIDER.profile} is configured, but ${keyEnv} is not set`);
    console.log(dim(`  export ${keyEnv} in this shell, or put it in ${keyFileFor(PROVIDER.profile)} (chmod 600)`));
    console.log('');
    return 'unavailable';
  }

  const choice = await input.select({
    title: 'Connect the model',
    heading: `${PROVIDER.profile} · ${PROVIDER.model}`,
    lines: [
      `egress ${PROVIDER.egress === 'cloud' ? ylw('cloud') : grn('local')} · prompts, tool output and file excerpts leave this host`,
      dim('scope.json stays the only authorization for target traffic'),
      dim(`${keyEnv || 'key'} · consent is for this session only`),
    ],
    question: 'Send this turn to the model?',
    options: ['Yes, for this session', 'No, stay in shell mode'],
  });

  if (choice !== 0) {
    state.liveDeclined = true;
    console.log(dim('  shell mode · /live to connect later'));
    console.log('');
    return 'declined';
  }

  state.cloudConsent = true;
  ev('cloud_consent', `${PROVIDER.profile}/${PROVIDER.model} · ${PROVIDER.egress}`);
  const live = initLive();
  if (!live) return 'unavailable';
  console.log(dim(`  connected · ${live.info.profile}/${live.info.model} · egress ${live.info.egress} · session ${live.session.id}`));
  console.log('');
  return 'connected';
}

async function handleMessage(text) {
  ev('user', text);
  if (state.live) return liveTurn(text);
  // No magic keywords: a sentence about SQL injection is a message, not a command.
  // The scripted demo stays behind /demo, where it cannot be mistaken for a real run.
  const status = await offerLive();
  if (status === 'connected') return liveTurn(text);
  if (status === 'declined') return;
  if (status === 'unavailable') return;

  console.log('');
  console.log(`  ${bold('⏺')} No model is connected, so nothing was sent.`);
  console.log(`    provider ${dim(state.profile + '/' + state.model)} ${dim('·')} target ${cyan(targetLabel())} ${dim('·')} scope ${scopeBadge()}`);
  console.log(`    ${dim('start with')} ${cyan('cyboros --live --allow-cloud')} ${dim('· or /live inside the session')}`);
  console.log(`    ${dim('/demo sqli')} ${dim('·')} ${dim('/scope')} ${dim('·')} ${dim('/findings')} ${dim('·')} ${dim('/help')}`);
  console.log('');
}

module.exports = {
  aborted, initLive, resetLive, liveTurn, offerLive, handleMessage, runTurn, pace,
  // Exported so a test can prove an unmapped code still gets an explanation.
  refusal,
};
